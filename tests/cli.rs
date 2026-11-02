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
