//! CLI regressions at real process, local HTTP, and isolated durable-storage boundaries.

use std::{
    fs,
    path::Path,
    process::{Command, Output},
};

use serde_json::Value;

fn invoke(directory: &Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_asmrt"))
        .arg("--asmdb-dir")
        .arg(std::env::var_os("ASMRT_ASMDB_REPO").expect("set ASMRT_ASMDB_REPO"))
        .arg("--data-dir")
        .arg(directory)
        .args(args)
        .output()
        .unwrap()
}

fn summary(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_str(
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .last()
            .unwrap(),
    )
    .unwrap()
}

#[test]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
fn a_hundred_task_demo_persists_external_artifacts_and_replaying_does_not_repeat_completed_work() {
    let directory = tempfile::tempdir().unwrap();
    let args = ["demo", "--tasks", "100", "--workers", "4", "--work-ms", "0"];
    let first = summary(&invoke(directory.path(), &args));
    assert_eq!(first["completed"], 100);
    assert_eq!(first["completed_now"], 100);
    assert_eq!(first["max_attempt"], 1);
    assert_eq!(first["pending"], 0);
    assert_eq!(first["running"], 0);

    let artifact = directory.path().join("artifacts").join("1.json");
    let bytes = fs::read(&artifact).unwrap();
    let data: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(data["task_id"], "1");
    assert_eq!(
        fs::read_dir(directory.path().join("artifacts"))
            .unwrap()
            .count(),
        100
    );
    let old_time =
        std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000);
    fs::File::options()
        .write(true)
        .open(&artifact)
        .unwrap()
        .set_modified(old_time)
        .unwrap();
    let modified = fs::metadata(&artifact).unwrap().modified().unwrap();

    let repeated = summary(&invoke(directory.path(), &args));
    assert_eq!(repeated["completed"], 100);
    assert_eq!(repeated["completed_now"], 0);
    assert_eq!(repeated["max_attempt"], 1);
    assert_eq!(fs::read(&artifact).unwrap(), bytes);
    assert_eq!(
        fs::metadata(&artifact).unwrap().modified().unwrap(),
        modified
    );

    let status = summary(&invoke(directory.path(), &["status"]));
    assert_eq!(status["total"], 100);
    assert_eq!(status["completed"], 100);
    assert_eq!(status["retried"], 0);
}

#[test]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
fn lifecycle_events_report_acknowledged_transitions_and_a_reopened_snapshot() {
    let directory = tempfile::tempdir().unwrap();
    let args = [
        "demo",
        "--tasks",
        "4",
        "--workers",
        "4",
        "--work-ms",
        "0",
        "--events",
    ];
    let first = invoke(directory.path(), &args);
    assert_eq!(summary(&first)["completed_now"], 4);
    let events: Vec<Value> = String::from_utf8_lossy(&first.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(events[0]["event"], "ready");
    let initial = events[0]["task_snapshot"].as_array().unwrap();
    assert_eq!(initial.len(), 4);
    assert!(
        initial
            .iter()
            .all(|task| task["state"] == "pending" && task["attempt"] == "0")
    );
    for id in 1..=4 {
        let id = id.to_string();
        let transitions: Vec<_> = events
            .iter()
            .filter(|event| event["task_id"] == id)
            .collect();
        assert_eq!(transitions.len(), 3);
        assert_eq!(transitions[0]["event"], "task_claimed");
        assert_eq!(transitions[1]["event"], "artifact_published");
        assert_eq!(transitions[2]["event"], "task_completed");
        assert_eq!(transitions[0]["task"]["state"], "running");
        assert_eq!(transitions[0]["task"]["attempt"], "1");
        assert_eq!(transitions[0]["task"]["record"]["tag"], "asmrt.v1.running");
        assert_eq!(transitions[1]["artifact"], format!("artifact:{id}"));
        assert_eq!(transitions[2]["task"]["state"], "completed");
        assert_eq!(
            transitions[2]["task"]["owner"],
            transitions[0]["task"]["owner"]
        );
        assert_eq!(
            transitions[2]["task"]["record"]["tag"],
            "asmrt.v1.completed"
        );
    }
    let repeated = invoke(directory.path(), &args);
    assert_eq!(summary(&repeated)["completed_now"], 0);
    let events: Vec<Value> = String::from_utf8_lossy(&repeated.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        events.len(),
        2,
        "replay must not emit work that did not happen"
    );
    assert!(
        events[0]["task_snapshot"]
            .as_array()
            .unwrap()
            .iter()
            .all(|task| {
                task["state"] == "completed"
                    && task["attempt"] == "1"
                    && task["artifact"].is_string()
            })
    );
}

#[test]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
fn guided_demo_waits_for_each_command_and_handles_a_partial_final_batch_and_replay() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, Stdio};
    use std::sync::mpsc::{self, RecvTimeoutError};
    use std::time::Duration;

    struct RunningDemo(Child);
    impl Drop for RunningDemo {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    let directory = tempfile::tempdir().unwrap();
    let args = [
        "demo",
        "--tasks",
        "5",
        "--workers",
        "4",
        "--work-ms",
        "0",
        "--events",
        "--guided",
    ];
    let mut child = RunningDemo(
        Command::new(env!("CARGO_BIN_EXE_asmrt"))
            .arg("--asmdb-dir")
            .arg(std::env::var_os("ASMRT_ASMDB_REPO").expect("set ASMRT_ASMDB_REPO"))
            .arg("--data-dir")
            .arg(directory.path())
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    let mut input = child.0.stdin.take().unwrap();
    let output = child.0.stdout.take().unwrap();
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            if sender
                .send(serde_json::from_str::<Value>(&line.unwrap()).unwrap())
                .is_err()
            {
                break;
            }
        }
    });
    let receive_checkpoint = |stage: &str| {
        let mut events = Vec::new();
        loop {
            let event = receiver
                .recv_timeout(Duration::from_secs(15))
                .expect("guided checkpoint did not arrive");
            let is_checkpoint = event["event"] == "checkpoint";
            assert_ne!(
                event["event"], "finished",
                "work must not run ahead of the reader"
            );
            events.push(event);
            if is_checkpoint {
                assert_eq!(events.last().unwrap()["stage"], stage);
                let reads: Vec<_> = events
                    .iter()
                    .filter(|event| event["event"] == "database_read")
                    .collect();
                assert_eq!(
                    reads.len(),
                    1,
                    "each checkpoint must include a fresh asmDB read"
                );
                let rows = reads[0]["response"]["rows"].as_array().unwrap();
                assert_eq!(rows.len(), 5);
                if stage == "ready" {
                    assert!(rows.iter().all(|row| row["tag"] == "asmrt.v1.pending"
                        && row["value"] == "0"
                        && row["content"] == "{}"));
                } else if stage == "claimed" || stage == "published" {
                    for id in events.last().unwrap()["task_ids"].as_array().unwrap() {
                        let row = rows.iter().find(|row| row["id"] == *id).unwrap();
                        assert_eq!(
                            row["tag"], "asmrt.v1.running",
                            "a file is not a completed record yet"
                        );
                        assert_eq!(row["value"], "1");
                        let content: Value =
                            serde_json::from_str(row["content"].as_str().unwrap()).unwrap();
                        assert!(content["o"].as_str().unwrap().starts_with("worker-"));
                        assert!(content.get("r").is_none());
                    }
                } else if stage == "completed" {
                    assert_eq!(
                        rows.iter()
                            .filter(|row| row["tag"] == "asmrt.v1.completed")
                            .count(),
                        4
                    );
                }
                assert_eq!(
                    receiver.recv_timeout(Duration::from_millis(250)),
                    Err(RecvTimeoutError::Timeout),
                    "a paused runtime must emit no further work, even with zero delay"
                );
                return events;
            }
        }
    };
    let advance = |input: &mut std::process::ChildStdin, events: &[Value]| {
        writeln!(input, "next {}", events.last().unwrap()["sequence"]).unwrap();
        input.flush().unwrap();
    };

    let ready = receive_checkpoint("ready");
    assert!(
        ready[0]["task_snapshot"]
            .as_array()
            .unwrap()
            .iter()
            .all(|task| task["state"] == "pending")
    );
    advance(&mut input, &ready);
    for (stage, count, event_name) in [
        ("claimed", 4, "task_claimed"),
        ("published", 4, "artifact_published"),
        ("completed", 4, "task_completed"),
        ("claimed", 1, "task_claimed"),
        ("published", 1, "artifact_published"),
    ] {
        let events = receive_checkpoint(stage);
        assert_eq!(
            events
                .iter()
                .filter(|event| event["event"] == event_name)
                .count(),
            count
        );
        assert_eq!(
            events.last().unwrap()["task_ids"].as_array().unwrap().len(),
            count
        );
        advance(&mut input, &events);
    }
    drop(input);
    loop {
        let event = receiver.recv_timeout(Duration::from_secs(15)).unwrap();
        if event["event"] == "finished" {
            assert_eq!(event["completed_now"], 5);
            assert_eq!(event["completed"], 5);
            break;
        }
        if event["event"] == "database_read" {
            assert!(
                event["response"]["rows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|row| row["tag"] == "asmrt.v1.completed")
            );
        } else {
            assert_eq!(event["event"], "task_completed");
        }
    }
    assert!(child.0.wait().unwrap().success());
    reader.join().unwrap();
    let replay = invoke(directory.path(), &args);
    assert_eq!(summary(&replay)["completed_now"], 0);
    let events: Vec<Value> = String::from_utf8_lossy(&replay.stdout)
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        events
            .iter()
            .map(|event| event["event"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["ready", "database_read", "finished"],
        "replay must reread the database without requiring a checkpoint or doing new work"
    );
    assert!(
        events[1]["response"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| { row["tag"] == "asmrt.v1.completed" && row["value"] == "1" })
    );
}

#[test]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
fn a_conflicting_artifact_is_not_overwritten_or_recorded_as_completed() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::Stdio;

    let directory = tempfile::tempdir().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_asmrt"))
        .arg("--asmdb-dir")
        .arg(std::env::var_os("ASMRT_ASMDB_REPO").expect("set ASMRT_ASMDB_REPO"))
        .arg("--data-dir")
        .arg(directory.path())
        .args([
            "demo",
            "--tasks",
            "1",
            "--workers",
            "1",
            "--work-ms",
            "0",
            "--pause",
            "claim",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut reader = BufReader::new(stdout);
    let mut paused = false;
    for _ in 0..4 {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap() == 0 {
            break;
        }
        let event: Value = serde_json::from_str(&line).unwrap();
        if event["event"] == "paused" {
            paused = true;
            break;
        }
    }
    if !paused {
        let _ = child.kill();
        let output = child.wait_with_output().unwrap();
        panic!(
            "CLI never reached its claim boundary: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    fs::create_dir(directory.path().join("artifacts")).unwrap();
    let artifact = directory.path().join("artifacts").join("1.json");
    fs::write(&artifact, b"unrelated content").unwrap();
    child.stdin.take().unwrap().write_all(b"\n").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("left untouched"));
    assert_eq!(fs::read(&artifact).unwrap(), b"unrelated content");
    let status = summary(&invoke(directory.path(), &["status"]));
    assert_eq!(status["pending"], 1);
    assert_eq!(status["completed"], 0);
}

// The model boundary is a loopback fixture; all coordination still uses the real MCP/asmDB path.
mod discussion {
    use super::*;
    use serde_json::json;
    use std::{
        io::{BufRead, BufReader, Read, Write},
        net::{TcpListener, TcpStream},
        process::Stdio,
        sync::{
            Arc, Condvar, Mutex,
            atomic::{AtomicBool, Ordering},
        },
        thread,
        time::Duration,
    };

    #[derive(Default)]
    struct Requests {
        bodies: Vec<Value>,
        active: usize,
        peak: usize,
        fail_turn: Option<u64>,
    }

    struct Ollama {
        url: String,
        requests: Arc<(Mutex<Requests>, Condvar)>,
        stopped: Arc<AtomicBool>,
        server: Option<thread::JoinHandle<()>>,
    }

    impl Ollama {
        fn start(fail_turn: Option<u64>) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            listener.set_nonblocking(true).unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let requests = Arc::new((
                Mutex::new(Requests {
                    fail_turn,
                    ..Requests::default()
                }),
                Condvar::new(),
            ));
            let stopped = Arc::new(AtomicBool::new(false));
            let state = requests.clone();
            let stop = stopped.clone();
            let server = thread::spawn(move || {
                let mut workers = Vec::new();
                while !stop.load(Ordering::SeqCst) {
                    match listener.accept() {
                        Ok((stream, _)) => {
                            let state = state.clone();
                            workers.push(thread::spawn(move || Self::respond(stream, state)));
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            thread::sleep(Duration::from_millis(5));
                        }
                        Err(error) => panic!("fixture accept failed: {error}"),
                    }
                }
                for worker in workers {
                    worker.join().unwrap();
                }
            });
            Self {
                url,
                requests,
                stopped,
                server: Some(server),
            }
        }

        fn respond(mut stream: TcpStream, state: Arc<(Mutex<Requests>, Condvar)>) {
            stream
                .set_read_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(10)))
                .unwrap();
            let mut reader = BufReader::new(&mut stream);
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            let tags = line.starts_with("GET /api/tags ");
            assert!(tags || line.starts_with("POST /api/chat "));
            let mut length = 0;
            loop {
                line.clear();
                assert!(reader.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    length = value.trim().parse::<usize>().unwrap();
                }
            }
            let (status, body) = if tags {
                (
                    "200 OK",
                    json!({"models":[{"name":"fixture","digest":"a".repeat(64)}]}),
                )
            } else {
                let mut bytes = vec![0; length];
                reader.read_exact(&mut bytes).unwrap();
                let body: Value = serde_json::from_slice(&bytes).unwrap();
                let id = body["options"]["seed"].as_u64().unwrap() - 42;
                let (lock, wake) = &*state;
                let mut requests = lock.lock().unwrap();
                requests.bodies.push(body);
                requests.active += 1;
                requests.peak = requests.peak.max(requests.active);
                wake.notify_all();
                // No wave response is released until all three HTTP requests have arrived.
                let mut overlapped = true;
                if (2..=7).contains(&id) {
                    let start = 2 + (id - 2) / 3 * 3;
                    let (next, timeout) = wake
                        .wait_timeout_while(requests, Duration::from_secs(8), |requests| {
                            requests
                                .bodies
                                .iter()
                                .filter(|body| {
                                    let id = body["options"]["seed"].as_u64().unwrap() - 42;
                                    (start..start + 3).contains(&id)
                                })
                                .count()
                                < 3
                        })
                        .unwrap();
                    requests = next;
                    overlapped = !timeout.timed_out();
                }
                let fail = requests.fail_turn == Some(id);
                if fail {
                    requests.fail_turn = None;
                }
                requests.active -= 1;
                if fail || !overlapped {
                    (
                        "503 Service Unavailable",
                        json!({"error":"fixture failure or non-overlapping wave"}),
                    )
                } else {
                    (
                        "200 OK",
                        json!({
                            "done":true,"done_reason":"stop",
                            "message":{"role":"assistant","content":format!("Fixture reply for turn {id}.")},
                            "prompt_eval_count":32,"eval_count":8
                        }),
                    )
                }
            };
            let body = body.to_string();
            write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        }
    }

    impl Drop for Ollama {
        fn drop(&mut self) {
            self.stopped.store(true, Ordering::SeqCst);
            self.server.take().unwrap().join().unwrap();
        }
    }

    fn directory() -> tempfile::TempDir {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join(".asmrt")
            .join("workflow2-build");
        fs::create_dir_all(&root).unwrap();
        tempfile::Builder::new()
            .prefix("chat-cli-")
            .tempdir_in(root)
            .unwrap()
    }

    fn events(output: &Output) -> Vec<Value> {
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    #[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
    fn guided_discussion_overlaps_calls_and_checkpoints_whole_committed_waves() {
        let directory = directory();
        let ollama = Ollama::start(None);
        let mut child = Command::new(env!("CARGO_BIN_EXE_asmrt"))
            .arg("--asmdb-dir")
            .arg(std::env::var_os("ASMRT_ASMDB_REPO").expect("set ASMRT_ASMDB_REPO"))
            .arg("--data-dir")
            .arg(directory.path())
            .args([
                "chat",
                "--workflow",
                "discussion",
                "--model",
                "fixture",
                "--ollama-url",
                &ollama.url,
                "--events",
                "--guided",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = child.stdin.take().unwrap();
        for sequence in 1..=12 {
            writeln!(input, "next {sequence}").unwrap();
        }
        drop(input);
        let output = child.wait_with_output().unwrap();
        let result = summary(&output);
        assert_eq!(result["completed_now"], 8);
        assert_eq!(result["model_calls_now"], 8);
        let events = events(&output);
        assert_eq!(
            events[0]["conversation"]["workflow"],
            json!({"kind":"conversation.discussion","version":1})
        );
        let turns = &events[0]["conversation"]["turns"];
        let checkpoints: Vec<_> = events
            .iter()
            .filter(|event| event["event"] == "checkpoint")
            .collect();
        assert_eq!(
            checkpoints
                .iter()
                .map(|event| json!([event["stage"], event["task_ids"]]))
                .collect::<Vec<_>>(),
            vec![
                json!(["ready", ["1"]]),
                json!(["claimed", ["1"]]),
                json!(["published", ["1"]]),
                json!(["completed", ["1"]]),
                json!(["claimed", ["2", "3", "4"]]),
                json!(["published", ["2", "3", "4"]]),
                json!(["completed", ["2", "3", "4"]]),
                json!(["claimed", ["5", "6", "7"]]),
                json!(["published", ["5", "6", "7"]]),
                json!(["completed", ["5", "6", "7"]]),
                json!(["claimed", ["8"]]),
                json!(["published", ["8"]]),
            ]
        );
        for (index, checkpoint) in checkpoints.iter().enumerate() {
            assert_eq!(checkpoint["sequence"], index + 1);
        }
        let requests = ollama.requests.0.lock().unwrap();
        assert_eq!(requests.bodies.len(), 8);
        assert_eq!(
            requests.peak, 3,
            "three model calls must overlap, not just three tasks"
        );
        for (index, role) in [
            "planner", "builder", "critic", "editor", "builder", "critic", "editor", "editor",
        ]
        .into_iter()
        .enumerate()
        {
            let id = (index + 1).to_string();
            let prior: Vec<_> = match index {
                0 => vec![],
                1..=3 => vec!["1"],
                4..=6 => vec!["1", "2", "3", "4"],
                _ => vec!["1", "2", "3", "4", "5", "6", "7"],
            };
            assert_eq!(
                turns[index],
                json!({"task_id":id,"agent_id":role,"input_ids":prior})
            );
            let body = requests
                .bodies
                .iter()
                .find(|body| body["options"]["seed"] == index + 43)
                .unwrap();
            let messages = body["messages"].as_array().unwrap();
            assert_eq!(messages.len(), prior.len() + 3);
            for (message, prior) in messages[2..messages.len() - 1].iter().zip(prior) {
                assert!(
                    message["content"]
                        .as_str()
                        .unwrap()
                        .ends_with(&format!("Fixture reply for turn {prior}."))
                );
            }
            let claimed = events
                .iter()
                .position(|event| event["event"] == "task_claimed" && event["task_id"] == id)
                .unwrap();
            let inferred = events
                .iter()
                .position(|event| event["event"] == "inference_started" && event["task_id"] == id)
                .unwrap();
            let published = events
                .iter()
                .position(|event| event["event"] == "artifact_published" && event["task_id"] == id)
                .unwrap();
            let completed = events
                .iter()
                .position(|event| event["event"] == "task_completed" && event["task_id"] == id)
                .unwrap();
            assert!(claimed < inferred && inferred < published && published < completed);
        }
        for wave in [["2", "3", "4"], ["5", "6", "7"]] {
            let claimed = events
                .iter()
                .rposition(|event| {
                    event["event"] == "task_claimed"
                        && wave.iter().any(|id| event["task_id"] == *id)
                })
                .unwrap();
            let started = events
                .iter()
                .position(|event| {
                    event["event"] == "inference_started"
                        && wave.iter().any(|id| event["task_id"] == *id)
                })
                .unwrap();
            assert!(
                claimed < started,
                "claim each wave in order before launching any calls"
            );
        }
    }

    #[test]
    #[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
    fn discussion_recovers_non_prefix_siblings_and_replays_offline_without_rewriting_work() {
        let directory = directory();
        let ollama = Ollama::start(Some(2));
        let first = invoke(
            directory.path(),
            &[
                "chat",
                "--workflow",
                "discussion",
                "--model",
                "fixture",
                "--ollama-url",
                &ollama.url,
                "--events",
            ],
        );
        assert!(!first.status.success());
        assert!(String::from_utf8_lossy(&first.stderr).contains("503"));
        let first_events = events(&first);
        let mut committed: Vec<_> = first_events
            .iter()
            .filter(|event| event["event"] == "task_completed")
            .map(|event| event["task_id"].as_str().unwrap())
            .collect();
        committed.sort_unstable();
        assert_eq!(committed, ["1", "3", "4"]);
        assert!(!directory.path().join("artifacts").join("2.json").exists());
        assert_eq!(
            ollama.requests.0.lock().unwrap().bodies.len(),
            4,
            "a failed wave must block its dependents"
        );
        let paths = [
            directory.path().join("conversation.json"),
            directory.path().join("artifacts").join("3.json"),
            directory.path().join("artifacts").join("4.json"),
        ];
        let snapshot = || {
            paths
                .iter()
                .map(|path| {
                    (
                        fs::read(path).unwrap(),
                        fs::metadata(path).unwrap().modified().unwrap(),
                    )
                })
                .collect::<Vec<_>>()
        };
        let before = snapshot();

        // Omission retains the saved discussion descriptor rather than choosing sequential.
        let resumed = invoke(directory.path(), &["chat", "--events"]);
        let result = summary(&resumed);
        assert_eq!(result["completed_now"], 5);
        assert_eq!(result["model_calls_now"], 5);
        let resumed_events = events(&resumed);
        assert_eq!(
            resumed_events[0]["conversation"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["task_id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["1", "3", "4"]
        );
        let retry = resumed_events
            .iter()
            .find(|event| event["event"] == "task_claimed")
            .unwrap();
        assert_eq!(retry["task_id"], "2");
        assert_eq!(retry["attempt"], "2");
        assert_eq!(snapshot(), before);
        let requests = ollama.requests.0.lock().unwrap();
        assert_eq!(requests.bodies.len(), 9);
        for (id, expected) in [(2, 2), (3, 1), (4, 1)] {
            assert_eq!(
                requests
                    .bodies
                    .iter()
                    .filter(|body| body["options"]["seed"] == id + 42)
                    .count(),
                expected
            );
        }
        drop(requests);
        drop(ollama);

        let replay = invoke(directory.path(), &["chat", "--events", "--guided"]);
        let result = summary(&replay);
        assert_eq!(result["completed_now"], 0);
        assert_eq!(result["model_calls_now"], 0);
        assert_eq!(result["completed"], 8);
        let replay_events = events(&replay);
        assert_eq!(
            replay_events
                .iter()
                .map(|event| event["event"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["ready", "database_read", "finished"]
        );
        assert_eq!(
            replay_events[0]["conversation"]["messages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|message| message["task_id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["1", "2", "3", "4", "5", "6", "7", "8"]
        );
        let conflict = invoke(directory.path(), &["chat", "--workflow", "sequential"]);
        assert!(!conflict.status.success());
        assert!(String::from_utf8_lossy(&conflict.stderr).contains("immutable saved settings"));
        assert_eq!(snapshot(), before);
    }
}
