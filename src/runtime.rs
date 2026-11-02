use std::{collections::BTreeMap, fs, io::Write, path::PathBuf, time::Duration};

use tokio::{
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

use crate::{DefinitionRef, Error, Result, Task, TaskState, mcp::Mcp, model::validate_owner};

const MARKER: &str = "asmrt-state-v1\n";

#[derive(Clone, Debug)]
pub struct Config {
    pub asmdb_dir: PathBuf,
    pub data_dir: PathBuf,
    pub request_timeout: Duration,
    pub max_tasks: usize,
}

impl Config {
    pub fn new(asmdb_dir: impl Into<PathBuf>, data_dir: impl Into<PathBuf>) -> Self {
        Self {
            asmdb_dir: asmdb_dir.into(),
            data_dir: data_dir.into(),
            request_timeout: Duration::from_secs(30),
            max_tasks: 10_000,
        }
    }

    fn prepare(mut self) -> Result<Self> {
        if self.max_tasks == 0
            || self.max_tasks > 10_000
            || self.request_timeout.is_zero()
            || self.request_timeout > Duration::from_secs(120)
        {
            return Err(Error::Invalid(
                "max_tasks must be 1..=10000 and timeout must be in (0, 120s]".into(),
            ));
        }
        self.asmdb_dir = std::path::absolute(&self.asmdb_dir).map_err(config_error)?;
        self.data_dir = std::path::absolute(&self.data_dir).map_err(config_error)?;
        let engine =
            self.asmdb_dir
                .join("build")
                .join(if cfg!(windows) { "asmdb.exe" } else { "asmdb" });
        let server = self.asmdb_dir.join("mcp").join("src").join("server.js");
        if !engine.is_file() || !server.is_file() {
            return Err(Error::Invalid(
                "asmDB checkout must contain its built engine and mcp/src/server.js".into(),
            ));
        }
        fs::create_dir_all(&self.data_dir).map_err(config_error)?;
        let marker = self.data_dir.join(".asmrt-owner");
        if !marker.exists() {
            if fs::read_dir(&self.data_dir)
                .map_err(config_error)?
                .next()
                .is_some()
            {
                return Err(Error::Invalid(
                    "refusing an unmarked, nonempty data directory; choose a new asmRT directory"
                        .into(),
                ));
            }
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&marker)
                .map_err(config_error)?;
            file.write_all(MARKER.as_bytes()).map_err(config_error)?;
            file.sync_all().map_err(config_error)?;
        }
        if fs::metadata(&marker).map_err(config_error)?.len() != MARKER.len() as u64
            || fs::read(&marker).map_err(config_error)? != MARKER.as_bytes()
        {
            return Err(Error::Invalid(
                "unsupported or incomplete asmRT directory marker".into(),
            ));
        }
        Ok(self)
    }
}

pub struct Runtime {
    state: StateHandle,
    stop: Option<oneshot::Sender<()>>,
    join: JoinHandle<Result<()>>,
}

#[derive(Clone)]
pub struct StateHandle {
    sender: mpsc::Sender<Request>,
}

enum Request {
    Task {
        operation: Operation,
        reply: oneshot::Sender<Result<Option<Task>>>,
    },
    List(oneshot::Sender<Vec<Task>>),
    InspectRecords(oneshot::Sender<Result<serde_json::Value>>),
}

enum Operation {
    Enqueue(Task),
    Get(u64),
    Claim(String),
    Complete(Task),
}

impl Runtime {
    pub async fn open(config: Config) -> Result<Self> {
        let config = config.prepare()?;
        let mut mcp = Mcp::open(&config).await?;
        let mut tasks = match mcp.load(config.max_tasks).await {
            Ok(tasks) => tasks,
            Err(error) => {
                let _ = mcp.close().await;
                return Err(error);
            }
        };
        // Validate the complete scan before mutating any recovered task.
        for task in tasks
            .values_mut()
            .filter(|task| task.state() == TaskState::Running)
        {
            let pending = task.requeued();
            if let Err(error) = persist(&mut mcp, "db_update", &pending).await {
                let _ = mcp.close().await;
                return Err(error);
            }
            *task = pending;
        }
        let (sender, receiver) = mpsc::channel(64);
        let (stop, stopped) = oneshot::channel();
        let join = tokio::spawn(run_actor(mcp, tasks, config.max_tasks, receiver, stopped));
        Ok(Self {
            state: StateHandle { sender },
            stop: Some(stop),
            join,
        })
    }

    pub fn state(&self) -> StateHandle {
        self.state.clone()
    }

    pub async fn shutdown(mut self) -> Result<()> {
        drop(self.stop.take());
        self.join
            .await
            .map_err(|error| Error::Transport(format!("actor stopped unexpectedly: {error}")))?
    }
}

impl StateHandle {
    async fn request(&self, operation: Operation) -> Result<Option<Task>> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(Request::Task { operation, reply })
            .await
            .map_err(|_| Error::Closed)?;
        response.await.map_err(|_| Error::Closed)?
    }

    pub async fn enqueue(&self, id: u64) -> Result<Task> {
        self.request(Operation::Enqueue(Task::pending(id)?))
            .await?
            .ok_or_else(|| Error::Transport("enqueue returned no task".into()))
    }

    pub async fn enqueue_defined(&self, id: u64, definition: DefinitionRef) -> Result<Task> {
        self.request(Operation::Enqueue(Task::defined(id, definition)?))
            .await?
            .ok_or_else(|| Error::Transport("enqueue returned no task".into()))
    }

    pub async fn get(&self, id: u64) -> Result<Option<Task>> {
        if id == 0 {
            return Err(Error::Invalid("task ID must be nonzero".into()));
        }
        self.request(Operation::Get(id)).await
    }

    pub async fn claim_next(&self, owner: &str) -> Result<Option<Task>> {
        validate_owner(owner)?;
        self.request(Operation::Claim(owner.into())).await
    }

    pub async fn complete(&self, claim: &Task, artifact: &str) -> Result<Task> {
        self.request(Operation::Complete(claim.completed(artifact)?))
            .await?
            .ok_or_else(|| Error::Transport("completion returned no task".into()))
    }

    /// Read the first 1,000 records through the existing writer's MCP connection, not the task cache.
    pub async fn inspect_records(&self) -> Result<serde_json::Value> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(Request::InspectRecords(reply))
            .await
            .map_err(|_| Error::Closed)?;
        response.await.map_err(|_| Error::Closed)?
    }

    pub async fn list(&self) -> Result<Vec<Task>> {
        let (reply, response) = oneshot::channel();
        self.sender
            .send(Request::List(reply))
            .await
            .map_err(|_| Error::Closed)?;
        response.await.map_err(|_| Error::Closed)
    }
}

async fn run_actor(
    mut mcp: Mcp,
    mut tasks: BTreeMap<u64, Task>,
    max_tasks: usize,
    mut receiver: mpsc::Receiver<Request>,
    mut stopped: oneshot::Receiver<()>,
) -> Result<()> {
    let outcome = loop {
        let request = tokio::select! {
            biased;
            _ = &mut stopped => break Ok(()),
            request = receiver.recv() => match request {
                Some(request) => request,
                None => break Ok(()),
            },
        };
        let (operation, reply) = match request {
            Request::Task { operation, reply } => (operation, reply),
            Request::List(reply) => {
                let _ = reply.send(tasks.values().cloned().collect());
                continue;
            }
            Request::InspectRecords(reply) => {
                let result = mcp
                    .tool("db_list", serde_json::json!({"limit": 1000, "offset": 0}))
                    .await;
                let fatal = result
                    .as_ref()
                    .err()
                    .filter(|error| error.is_fatal())
                    .cloned();
                let _ = reply.send(result);
                if let Some(error) = fatal {
                    break Err(error);
                }
                continue;
            }
        };
        let result = execute(&mut mcp, &mut tasks, max_tasks, operation).await;
        let fatal = result
            .as_ref()
            .err()
            .filter(|error| error.is_fatal())
            .cloned();
        let _ = reply.send(result);
        if let Some(error) = fatal {
            break Err(error);
        }
    };
    // Queued callers must learn that the actor stopped, not wait behind shutdown.
    drop(receiver);
    let closed = mcp.close().await;
    outcome.and(closed)
}

async fn execute(
    mcp: &mut Mcp,
    tasks: &mut BTreeMap<u64, Task>,
    max_tasks: usize,
    operation: Operation,
) -> Result<Option<Task>> {
    match operation {
        Operation::Get(id) => Ok(tasks.get(&id).cloned()),
        Operation::Claim(owner) => {
            let Some(task) = tasks
                .values()
                .find(|task| task.state() == TaskState::Pending)
            else {
                return Ok(None);
            };
            let claimed = task.claimed(&owner)?;
            persist(mcp, "db_update", &claimed).await?;
            tasks.insert(claimed.id(), claimed.clone());
            Ok(Some(claimed))
        }
        Operation::Complete(proposed) => {
            let current = tasks
                .get(&proposed.id())
                .ok_or_else(|| Error::Conflict("task does not exist".into()))?;
            if current.owner() != proposed.owner()
                || current.attempt() != proposed.attempt()
                || current.definition() != proposed.definition()
            {
                return Err(Error::Conflict(
                    "stale owner, attempt or task definition".into(),
                ));
            }
            if current == &proposed {
                return Ok(Some(current.clone()));
            }
            if current.state() != TaskState::Running {
                return Err(Error::Conflict(
                    "task is no longer running, or its result already differs".into(),
                ));
            }
            persist(mcp, "db_update", &proposed).await?;
            tasks.insert(proposed.id(), proposed.clone());
            Ok(Some(proposed))
        }
        Operation::Enqueue(task) => {
            if let Some(existing) = tasks.get(&task.id()) {
                if existing.definition() != task.definition() {
                    return Err(Error::Conflict(
                        "a task ID cannot change its definition".into(),
                    ));
                }
                return Ok(Some(existing.clone()));
            }
            if tasks.len() >= max_tasks {
                return Err(Error::Invalid("POC task limit reached".into()));
            }
            persist(mcp, "db_insert", &task).await?;
            tasks.insert(task.id(), task.clone());
            Ok(Some(task))
        }
    }
}

async fn persist(mcp: &mut Mcp, method: &str, task: &Task) -> Result<()> {
    let record = task.encode()?;
    let result = mcp
        .tool(method, serde_json::to_value(&record).map_err(config_error)?)
        .await?;
    if result["id"] != record.id || result["value"] != record.value || result["tag"] != record.tag {
        return Err(Error::Transport(
            "write acknowledgement does not match the task".into(),
        ));
    }
    Ok(())
}

fn config_error(error: impl std::fmt::Display) -> Error {
    Error::Invalid(error.to_string())
}
