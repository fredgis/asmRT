//! +--------------------------------------------------------------------+
//! | asmRT :: tests/runtime.rs -- real single-writer integration checks   |
//! +--------------------------------------------------------------------+
//! Uses a built asmDB checkout and isolated task directories to exercise
//! actor serialization, persistence, stale claims and recovery. External
//! engine tests are opt-in; they do not operate on the user's demo state.

use std::path::PathBuf;

use asmrt::{Config, Runtime, TaskState};

// Ignored by default: tests supply isolated state to an external, already-built asmDB checkout.
fn config(directory: &std::path::Path) -> Config {
    let repo = std::env::var_os("ASMRT_ASMDB_REPO")
        .map(PathBuf::from)
        .expect("set ASMRT_ASMDB_REPO to the existing asmDB checkout");
    Config::new(repo, directory)
}

#[tokio::test]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
async fn enqueued_tasks_survive_reopening_the_real_database() {
    let directory = tempfile::tempdir().unwrap();
    let settings = config(directory.path());
    let runtime = Runtime::open(settings.clone()).await.unwrap();
    let state = runtime.state();
    let created = state.enqueue(u64::MAX).await.unwrap();
    assert_eq!(created.state(), TaskState::Pending);
    assert_eq!(state.get(u64::MAX).await.unwrap(), Some(created.clone()));
    runtime.shutdown().await.unwrap();

    let reopened = Runtime::open(settings).await.unwrap();
    assert_eq!(reopened.state().get(u64::MAX).await.unwrap(), Some(created));
    reopened.shutdown().await.unwrap();
}

#[tokio::test]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
async fn typed_definitions_survive_recovery_and_cannot_be_rebound_or_forged() {
    let directory = tempfile::tempdir().unwrap();
    let settings = config(directory.path());
    let reference = asmrt::DefinitionRef::new("job:1", "a".repeat(64)).unwrap();
    let different = asmrt::DefinitionRef::new("job:1", "b".repeat(64)).unwrap();
    let runtime = Runtime::open(settings.clone()).await.unwrap();
    let state = runtime.state();
    state.enqueue_defined(1, reference.clone()).await.unwrap();
    let claim = state.claim_next("planner").await.unwrap().unwrap();
    assert!(state.enqueue_defined(1, different).await.is_err());
    assert!(state.enqueue(1).await.is_err());
    let mut forged = claim.encode().unwrap();
    forged.content = forged.content.replace(&"a".repeat(64), &"b".repeat(64));
    assert!(
        state
            .complete(&asmrt::Task::decode(&forged).unwrap(), "reply")
            .await
            .is_err()
    );
    runtime.shutdown().await.unwrap();

    let runtime = Runtime::open(settings).await.unwrap();
    let state = runtime.state();
    let recovered = state.enqueue_defined(1, reference.clone()).await.unwrap();
    assert_eq!(recovered.definition(), Some(&reference));
    assert_eq!(recovered.state(), TaskState::Pending);
    assert_eq!(recovered.attempt(), 1);
    let retry = state.claim_next("planner").await.unwrap().unwrap();
    assert!(state.complete(&claim, "old").await.is_err());
    let completed = state.complete(&retry, &"c".repeat(64)).await.unwrap();
    assert_eq!(completed.definition(), Some(&reference));
    assert_eq!(completed.attempt(), 2);
    assert!(completed.encode().unwrap().content.len() <= 175);
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
async fn concurrent_workers_cannot_claim_the_same_task_twice() {
    let directory = tempfile::tempdir().unwrap();
    let runtime = Runtime::open(config(directory.path())).await.unwrap();
    let state = runtime.state();
    state.enqueue(42).await.unwrap();
    // Workers race through cloned handles; only the actor may choose a pending task.
    let mut workers = tokio::task::JoinSet::new();
    for index in 0..16 {
        let state = state.clone();
        workers.spawn(async move { state.claim_next(&format!("worker-{index}")).await });
    }
    let mut results = Vec::new();
    while let Some(result) = workers.join_next().await {
        results.push(result.unwrap());
    }
    let stored = state.get(42).await.unwrap();
    runtime.shutdown().await.unwrap();

    let claimed: Vec<_> = results.into_iter().filter_map(Result::unwrap).collect();
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].state(), TaskState::Running);
    assert_eq!(claimed[0].attempt(), 1);
    assert_eq!(stored, Some(claimed[0].clone()));
}

#[tokio::test]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
async fn completion_is_persistent_idempotent_and_cannot_change_its_artifact() {
    let directory = tempfile::tempdir().unwrap();
    let settings = config(directory.path());
    let runtime = Runtime::open(settings.clone()).await.unwrap();
    let state = runtime.state();
    state.enqueue(7).await.unwrap();
    let claim = state.claim_next("builder").await.unwrap().unwrap();
    let first = state.complete(&claim, "artifact:7").await;
    let repeated = state.complete(&claim, "artifact:7").await;
    let conflict = state.complete(&claim, "artifact:other").await;
    runtime.shutdown().await.unwrap();

    let reopened = Runtime::open(settings).await.unwrap();
    let persisted = reopened.state().enqueue(7).await.unwrap();
    let eligible = reopened.state().claim_next("other").await.unwrap();
    reopened.shutdown().await.unwrap();

    let completed = first.unwrap();
    assert_eq!(completed.state(), TaskState::Completed);
    assert_eq!(completed.artifact(), Some("artifact:7"));
    assert_eq!(repeated.unwrap(), completed);
    assert!(conflict.is_err());
    assert_eq!(persisted, completed);
    assert!(eligible.is_none());
}

#[tokio::test]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
async fn reopening_recovers_interrupted_work_and_fences_old_attempts_even_for_the_same_owner() {
    let directory = tempfile::tempdir().unwrap();
    let settings = config(directory.path());
    let runtime = Runtime::open(settings.clone()).await.unwrap();
    let old_state = runtime.state();
    old_state.enqueue(11).await.unwrap();
    old_state.enqueue(12).await.unwrap();
    let finished = old_state.claim_next("builder").await.unwrap().unwrap();
    let finished = old_state.complete(&finished, "artifact:11").await.unwrap();
    let interrupted = old_state.claim_next("builder").await.unwrap().unwrap();
    runtime.shutdown().await.unwrap();

    // Reuse the same worker name after reopening: the attempt counter must fence its old claim.
    let runtime = Runtime::open(settings).await.unwrap();
    let state = runtime.state();
    let recovered = state.get(12).await.unwrap().unwrap();
    let retried = state.claim_next("builder").await.unwrap();
    let stale = state.complete(&interrupted, "artifact:stale").await;
    let completion = match &retried {
        Some(claim) => state.complete(claim, "artifact:12").await,
        None => Err(asmrt::Error::Invalid(
            "interrupted task was not requeued".into(),
        )),
    };
    let preserved = state.get(11).await.unwrap().unwrap();
    let stored = state.get(12).await.unwrap().unwrap();
    runtime.shutdown().await.unwrap();

    assert_eq!(recovered.state(), TaskState::Pending);
    assert_eq!(recovered.attempt(), 1);
    assert_eq!(recovered.owner(), None);
    assert_eq!(retried.unwrap().attempt(), 2);
    assert!(matches!(stale, Err(asmrt::Error::Conflict(_))));
    assert_eq!(preserved, finished);
    assert_eq!(stored, completion.unwrap());
    assert_eq!(stored.artifact(), Some("artifact:12"));
    assert!(matches!(old_state.get(12).await, Err(asmrt::Error::Closed)));
}

#[tokio::test]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
async fn reopening_loads_tasks_beyond_the_first_mcp_page() {
    let directory = tempfile::tempdir().unwrap();
    let settings = config(directory.path());
    let runtime = Runtime::open(settings.clone()).await.unwrap();
    for id in 1..=1001 {
        runtime.state().enqueue(id).await.unwrap();
    }
    runtime.shutdown().await.unwrap();

    let reopened = Runtime::open(settings).await.unwrap();
    let tasks = reopened.state().list().await;
    reopened.shutdown().await.unwrap();
    let tasks = tasks.unwrap();
    assert_eq!(tasks.len(), 1001);
    assert_eq!(tasks.first().unwrap().id(), 1);
    assert_eq!(tasks.last().unwrap().id(), 1001);
}

// Isolation failures must preserve unrelated files and leave the existing writer usable.
#[tokio::test]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
async fn data_directory_guards_reject_unrelated_files_and_second_writers() {
    let directory = tempfile::tempdir().unwrap();
    let protected = directory.path().join("unrelated");
    std::fs::create_dir(&protected).unwrap();
    let sentinel = protected.join("existing.dat");
    std::fs::write(&sentinel, b"user data must not be adopted").unwrap();
    let refused = Runtime::open(config(&protected)).await;
    let refused_unrelated = matches!(refused, Err(asmrt::Error::Invalid(_)));
    if let Ok(runtime) = refused {
        runtime.shutdown().await.unwrap();
    }
    assert!(refused_unrelated);
    assert_eq!(
        std::fs::read(&sentinel).unwrap(),
        b"user data must not be adopted"
    );
    assert_eq!(std::fs::read_dir(&protected).unwrap().count(), 1);

    let settings = config(&directory.path().join("owned"));
    let first = Runtime::open(settings.clone()).await.unwrap();
    first.state().enqueue(1).await.unwrap();
    let second = Runtime::open(settings).await;
    let rejected = matches!(
        second,
        Err(asmrt::Error::Transport(_)) | Err(asmrt::Error::Backend(_))
    );
    if let Ok(runtime) = second {
        runtime.shutdown().await.unwrap();
    }
    let task = first.state().enqueue(2).await;
    first.shutdown().await.unwrap();
    assert!(
        rejected,
        "a second coordinator must not acquire the live database"
    );
    assert_eq!(task.unwrap().id(), 2);
}

#[tokio::test]
#[ignore = "requires the existing asmDB binary and Node MCP dependencies"]
async fn rejected_inputs_do_not_mutate_tasks_or_poison_the_actor() {
    let directory = tempfile::tempdir().unwrap();
    let mut settings = config(directory.path());
    settings.max_tasks = 1;
    let runtime = Runtime::open(settings).await.unwrap();
    let state = runtime.state();
    let zero = state.enqueue(0).await;
    state.enqueue(9).await.unwrap();
    let owner = state.claim_next(&"é".repeat(17)).await;
    let claim = state.claim_next("w").await.unwrap().unwrap();
    let oversized = state.complete(&claim, &"\"".repeat(80)).await;
    let unchanged = state.get(9).await.unwrap();
    let capacity = state.enqueue(10).await;
    let completed = state.complete(&claim, "artifact:9").await;
    let tasks = state.list().await;
    runtime.shutdown().await.unwrap();

    assert!(matches!(zero, Err(asmrt::Error::Invalid(_))));
    assert!(matches!(owner, Err(asmrt::Error::Invalid(_))));
    assert!(matches!(oversized, Err(asmrt::Error::Invalid(_))));
    assert!(matches!(capacity, Err(asmrt::Error::Invalid(_))));
    assert_eq!(unchanged, Some(claim));
    assert_eq!(completed.unwrap().state(), TaskState::Completed);
    assert_eq!(tasks.unwrap().len(), 1);
}
