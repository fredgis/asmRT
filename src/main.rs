//! CLI entry point for durable demos, chat, status, and JSON lifecycle events.

#![forbid(unsafe_code)]

mod chat;

use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
    time::Duration,
};

use asmrt::{Config, Runtime, StateHandle, Task, TaskState};
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader, Stdin},
    task::JoinSet,
};

type CliResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Parser)]
#[command(
    version,
    about = "Local durable coordination over the unchanged asmDB MCP bridge"
)]
struct Cli {
    #[arg(
        long,
        env = "ASMRT_ASMDB_REPO",
        help = "Existing asmDB checkout, including its built engine and MCP dependencies"
    )]
    asmdb_dir: PathBuf,
    #[arg(long, default_value_os_t = default_directory(), help = "Dedicated asmRT directory; never an existing asmDB data directory")]
    data_dir: PathBuf,
    #[command(subcommand)]
    command: Action,
}

#[derive(Subcommand)]
enum Action {
    #[command(about = "Run or resume deterministic tasks with external file artifacts")]
    Demo(Demo),
    #[command(about = "Run or resume four agents conversing through a small local Ollama model")]
    Chat(chat::Options),
    #[command(about = "Open exclusively, reconcile interrupted tasks, then print persisted counts")]
    Status,
}

#[derive(Args)]
struct Demo {
    #[arg(long, default_value_t = 100, value_parser = clap::value_parser!(u32).range(1..=10000))]
    tasks: u32,
    #[arg(long, default_value_t = 4, value_parser = clap::value_parser!(u16).range(1..=32))]
    workers: u16,
    #[arg(long, default_value_t = 10, value_parser = clap::value_parser!(u64).range(0..=30000))]
    work_ms: u64,
    #[arg(
        long,
        help = "Emit an initial task snapshot and acknowledged lifecycle events for observers"
    )]
    events: bool,
    #[arg(
        long,
        requires = "events",
        conflicts_with = "pause",
        help = "Wait for numbered stdin commands at acknowledged batch boundaries"
    )]
    guided: bool,
    #[arg(
        long,
        value_enum,
        help = "Pause once at a durable boundary; press Enter to resume (requires --workers 1)"
    )]
    pause: Option<Pause>,
}

#[derive(Clone, Copy, PartialEq, Eq, ValueEnum)]
enum Pause {
    Claim,
    Artifact,
}

fn default_directory() -> PathBuf {
    PathBuf::from(".asmrt").join("demo")
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("asmRT: {error}");
            ExitCode::FAILURE
        }
    }
}

// One coordinator owns the invocation; shutdown precedes the final success summary.
async fn run(cli: Cli) -> CliResult<()> {
    if matches!(&cli.command, Action::Demo(options) if options.pause.is_some() && options.workers != 1)
    {
        return Err(io::Error::other("--pause requires --workers 1").into());
    }
    let directory = std::path::absolute(cli.data_dir)?;
    if matches!(cli.command, Action::Status) && !directory.join(".asmrt-owner").is_file() {
        return Err(io::Error::other("no asmRT state here; run the demo first").into());
    }
    let runtime = Runtime::open(Config::new(cli.asmdb_dir, &directory)).await?;
    let state = runtime.state();
    let result = match cli.command {
        Action::Status => state
            .list()
            .await
            .map(|tasks| summarize(&tasks, "status"))
            .map_err(Into::into),
        // Tokio's blocking console read is not cancellable. At diagnostic pauses,
        // leave Ctrl+C to the OS; child EOF cleanup is exercised by the fault tests.
        Action::Demo(options) if options.pause.is_some() || options.guided => {
            demo(state, directory, options).await
        }
        Action::Chat(options) if options.guided => chat::run(state, directory, options).await,
        Action::Chat(options) => tokio::select! {
            result = chat::run(state, directory, options) => result,
            signal = tokio::signal::ctrl_c() => match signal {
                Ok(()) => Err(io::Error::new(io::ErrorKind::Interrupted, "interrupted; rerun chat to recover the conversation").into()),
                Err(error) => Err(error.into()),
            },
        },
        Action::Demo(options) => tokio::select! {
            result = demo(state, directory, options) => result,
            signal = tokio::signal::ctrl_c() => match signal {
                Ok(()) => Err(io::Error::new(io::ErrorKind::Interrupted, "interrupted; rerun to recover unfinished tasks").into()),
                Err(error) => Err(error.into()),
            },
        },
    };
    let shutdown = runtime.shutdown().await;
    let summary = result?;
    shutdown?;
    emit(&summary)?;
    Ok(())
}

// Resume only this deterministic task set, verifying completed files before adding work.
async fn demo(state: StateHandle, directory: PathBuf, options: Demo) -> CliResult<Value> {
    let existing = state.list().await?;
    if existing.iter().any(|task| {
        task.definition().is_some()
            || task.id() > u64::from(options.tasks)
            || (task.state() == TaskState::Completed
                && task.artifact() != Some(&artifact_reference(task.id())))
    }) {
        return Err(io::Error::other(
            "this directory contains a different task set; choose a new demo directory",
        )
        .into());
    }
    let check_directory = directory.clone();
    tokio::task::spawn_blocking(move || -> io::Result<()> {
        for task in existing
            .iter()
            .filter(|task| task.state() == TaskState::Completed)
        {
            verify_artifact(&check_directory, task.id())?;
        }
        Ok(())
    })
    .await??;
    for id in 1..=u64::from(options.tasks) {
        state.enqueue(id).await?;
    }
    let mut ready = json!({"event": "ready", "tasks": options.tasks, "workers": options.workers, "data_dir": directory.to_string_lossy()});
    if options.events {
        ready["task_snapshot"] = Value::Array(
            state
                .list()
                .await?
                .iter()
                .map(task_view)
                .collect::<asmrt::Result<Vec<_>>>()?,
        );
    }
    emit(&ready)?;
    let task_count = options.tasks as usize;
    let completed_now = if options.guided {
        guided_workers(state.clone(), directory, options).await?
    } else {
        run_workers(state.clone(), directory, options).await?
    };
    let tasks = state.list().await?;
    if tasks.len() != task_count
        || tasks
            .iter()
            .any(|task| task.state() != TaskState::Completed)
    {
        return Err(io::Error::other("not all demo tasks completed; restart to reconcile").into());
    }
    let mut summary = summarize(&tasks, "finished");
    summary["completed_now"] = json!(completed_now);
    Ok(summary)
}

// Each worker publishes its artifact before asking the actor to persist completion.
async fn run_workers(state: StateHandle, directory: PathBuf, options: Demo) -> CliResult<u32> {
    let mut workers = JoinSet::new();
    for index in 1..=options.workers {
        let state = state.clone();
        let directory = directory.clone();
        workers.spawn(async move {
            let owner = format!("worker-{index}");
            let mut completed = 0;
            let mut pause = options.pause;
            while let Some(claim) = state.claim_next(&owner).await? {
                if options.events {
                    emit_task("task_claimed", &claim)?;
                }
                if pause == Some(Pause::Claim) {
                    wait_for_resume(&claim, Pause::Claim).await?;
                    pause = None;
                }
                tokio::time::sleep(Duration::from_millis(options.work_ms)).await;
                let artifact_directory = directory.clone();
                let id = claim.id();
                tokio::task::spawn_blocking(move || persist_artifact(&artifact_directory, id))
                    .await??;
                if options.events {
                    emit(&json!({"event": "artifact_published", "task_id": id.to_string(), "owner": owner, "attempt": claim.attempt().to_string(), "artifact": artifact_reference(id)}))?;
                }
                if pause == Some(Pause::Artifact) {
                    wait_for_resume(&claim, Pause::Artifact).await?;
                    pause = None;
                }
                let done = state.complete(&claim, &artifact_reference(id)).await?;
                if options.events {
                    emit_task("task_completed", &done)?;
                }
                completed += 1;
            }
            Ok::<u32, Box<dyn std::error::Error + Send + Sync>>(completed)
        });
    }
    let mut completed_now = 0;
    while let Some(result) = workers.join_next().await {
        completed_now += result??;
    }
    Ok(completed_now)
}

// Join each batch stage before exposing a database read and numbered stdin checkpoint.
async fn guided_workers(state: StateHandle, directory: PathBuf, options: Demo) -> CliResult<u32> {
    if state
        .list()
        .await?
        .iter()
        .all(|task| task.state() == TaskState::Completed)
    {
        emit_database_read(&state).await?;
        return Ok(0);
    }
    let mut input = BufReader::new(tokio::io::stdin());
    let mut sequence = 0;
    let mut completed = 0;
    wait_for_step(&state, &mut input, &mut sequence, "ready", &[]).await?;
    loop {
        let mut workers = JoinSet::new();
        for index in 1..=options.workers {
            let state = state.clone();
            workers.spawn(async move {
                let claim = state.claim_next(&format!("worker-{index}")).await?;
                if let Some(task) = &claim {
                    emit_task("task_claimed", task)?;
                }
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(claim)
            });
        }
        let mut claims = Vec::new();
        while let Some(result) = workers.join_next().await {
            if let Some(claim) = result?? {
                claims.push(claim);
            }
        }
        if claims.is_empty() {
            break;
        }
        claims.sort_unstable_by_key(Task::id);
        wait_for_step(&state, &mut input, &mut sequence, "claimed", &claims).await?;

        let mut workers = JoinSet::new();
        for claim in &claims {
            let claim = claim.clone();
            let directory = directory.clone();
            workers.spawn(async move {
                tokio::time::sleep(Duration::from_millis(options.work_ms)).await;
                let id = claim.id();
                tokio::task::spawn_blocking(move || persist_artifact(&directory, id)).await??;
                emit(&json!({"event": "artifact_published", "task_id": id.to_string(), "owner": claim.owner(), "attempt": claim.attempt().to_string(), "artifact": artifact_reference(id)}))?;
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
            });
        }
        while let Some(result) = workers.join_next().await {
            result??;
        }
        wait_for_step(&state, &mut input, &mut sequence, "published", &claims).await?;

        let mut workers = JoinSet::new();
        for claim in &claims {
            let claim = claim.clone();
            let state = state.clone();
            workers.spawn(async move {
                let done = state
                    .complete(&claim, &artifact_reference(claim.id()))
                    .await?;
                emit_task("task_completed", &done)?;
                Ok::<_, Box<dyn std::error::Error + Send + Sync>>(())
            });
        }
        while let Some(result) = workers.join_next().await {
            result??;
            completed += 1;
        }
        if state
            .list()
            .await?
            .iter()
            .all(|task| task.state() == TaskState::Completed)
        {
            emit_database_read(&state).await?;
            break;
        }
        wait_for_step(&state, &mut input, &mut sequence, "completed", &claims).await?;
    }
    Ok(completed)
}

async fn emit_database_read(state: &StateHandle) -> CliResult<()> {
    let response = state.inspect_records().await?;
    emit(&json!({
        "event": "database_read",
        "tool": "db_list",
        "arguments": {"limit": response["limit"], "offset": response["offset"]},
        "commands": [format!("PAGE {} {}", response["limit"], response["offset"]), "SELECT *"],
        "response": response,
    }))?;
    Ok(())
}

async fn wait_for_step(
    state: &StateHandle,
    input: &mut BufReader<Stdin>,
    sequence: &mut u64,
    stage: &str,
    tasks: &[Task],
) -> CliResult<()> {
    emit_database_read(state).await?;
    *sequence += 1;
    emit(
        &json!({"event": "checkpoint", "sequence": *sequence, "stage": stage, "task_ids": tasks.iter().map(|task| task.id().to_string()).collect::<Vec<_>>()}),
    )?;
    let mut command = String::new();
    if input.read_line(&mut command).await? == 0 {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            "guided input closed; rerun to recover unfinished tasks",
        )
        .into());
    }
    if command.trim_end() != format!("next {sequence}") {
        return Err(
            io::Error::other("expected next followed by the current checkpoint number").into(),
        );
    }
    Ok(())
}

async fn wait_for_resume(claim: &Task, stage: Pause) -> CliResult<()> {
    let stage = match stage {
        Pause::Claim => "claim",
        Pause::Artifact => "artifact",
    };
    emit(
        &json!({"event": "paused", "stage": stage, "task_id": claim.id().to_string(), "attempt": claim.attempt().to_string()}),
    )?;
    eprintln!(
        "Paused after {stage}; press Enter to continue, or terminate this process to test recovery."
    );
    tokio::io::stdin().read_exact(&mut [0_u8; 1]).await?;
    Ok(())
}

// Task events preserve decimal-string identifiers alongside the encoded asmDB record.
fn task_view(task: &Task) -> asmrt::Result<Value> {
    let state = match task.state() {
        TaskState::Pending => "pending",
        TaskState::Running => "running",
        TaskState::Completed => "completed",
    };
    Ok(json!({
        "id": task.id().to_string(),
        "state": state,
        "attempt": task.attempt().to_string(),
        "owner": task.owner(),
        "artifact": task.artifact(),
        "definition": task.definition(),
        "record": task.encode()?,
    }))
}

fn emit_task(event: &str, task: &Task) -> CliResult<()> {
    emit(&json!({
        "event": event,
        "task_id": task.id().to_string(),
        "owner": task.owner(),
        "attempt": task.attempt().to_string(),
        "artifact": task.artifact(),
        "task": task_view(task)?,
    }))?;
    Ok(())
}

fn summarize(tasks: &[Task], event: &str) -> Value {
    json!({
        "event": event,
        "total": tasks.len(),
        "pending": tasks.iter().filter(|task| task.state() == TaskState::Pending).count(),
        "running": tasks.iter().filter(|task| task.state() == TaskState::Running).count(),
        "completed": tasks.iter().filter(|task| task.state() == TaskState::Completed).count(),
        "retried": tasks.iter().filter(|task| task.attempt() > 1).count(),
        "max_attempt": tasks.iter().map(Task::attempt).max().unwrap_or(0),
    })
}

// Deterministic files live outside asmDB; retries verify and reuse existing bytes.
fn artifact_reference(id: u64) -> String {
    format!("artifact:{id}")
}

fn artifact_bytes(id: u64) -> Vec<u8> {
    format!("{{\"schema\":\"asmrt.demo.v1\",\"task_id\":\"{id}\",\"result\":\"deterministic completion\"}}\n").into_bytes()
}

fn artifact_path(directory: &Path, id: u64) -> PathBuf {
    directory.join("artifacts").join(format!("{id}.json"))
}

fn verify_artifact(directory: &Path, id: u64) -> io::Result<()> {
    let path = artifact_path(directory, id);
    let expected = artifact_bytes(id);
    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.is_file() || metadata.len() != expected.len() as u64 {
        return Err(io::Error::other(format!(
            "artifact {id} is not the expected regular file; left untouched"
        )));
    }
    let mut actual = Vec::new();
    fs::File::open(path)?
        .take(expected.len() as u64 + 1)
        .read_to_end(&mut actual)?;
    if actual != expected {
        return Err(io::Error::other(format!(
            "artifact {id} differs from the deterministic result; left untouched"
        )));
    }
    Ok(())
}

fn persist_artifact(directory: &Path, id: u64) -> io::Result<()> {
    let path = artifact_path(directory, id);
    let parent = path.parent().expect("artifact has a parent directory");
    fs::create_dir_all(parent)?;
    if path.try_exists()? {
        return verify_artifact(directory, id);
    }
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(&artifact_bytes(id))?;
    temporary.as_file().sync_all()?;
    // Publish without replacing another attempt's or the user's existing file.
    match temporary.persist_noclobber(&path) {
        Ok(file) => {
            file.sync_all()?;
        }
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
            return verify_artifact(directory, id);
        }
        Err(error) => return Err(error.error),
    }
    #[cfg(unix)]
    fs::File::open(parent)?.sync_all()?;
    Ok(())
}

fn emit(value: &Value) -> io::Result<()> {
    let mut stdout = io::stdout().lock();
    serde_json::to_writer(&mut stdout, value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}
