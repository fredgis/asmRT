//! +--------------------------------------------------------------------+
//! | asmRT :: tests/codec.rs -- storage-format contract checks            |
//! +--------------------------------------------------------------------+
//! Tests round trips, exact integer precision, UTF-8/escaping byte limits
//! and malformed-state rejection without a running database. Hand-built
//! records exercise decoder boundaries independently of constructors.

use asmrt::{Record, Task, TaskState};

// Decode hand-built rows so constructor validation cannot hide wire-format defects.
#[test]
fn compact_records_preserve_full_integer_precision_and_utf8_references() {
    let record = Record {
        id: "18446744073709551615".into(),
        value: "9007199254740993".into(),
        tag: "asmrt.v1.completed".into(),
        content: r#"{"o":"builder-é","r":"artifact:1001"}"#.into(),
    };

    let task = Task::decode(&record).unwrap();
    assert_eq!(task.id(), u64::MAX);
    assert_eq!(task.state(), TaskState::Completed);
    assert_eq!(task.attempt(), 9_007_199_254_740_993);
    assert_eq!(task.owner(), Some("builder-é"));
    assert_eq!(task.artifact(), Some("artifact:1001"));
    assert_eq!(task.encode().unwrap(), record);
}

#[test]
fn content_budget_counts_utf8_bytes_and_json_escape_overhead() {
    let record = |artifact: &str| Record {
        id: "1".into(),
        value: "1".into(),
        tag: "asmrt.v1.completed".into(),
        content: serde_json::json!({"o": "w", "r": artifact}).to_string(),
    };
    let boundary = record(&format!("{}x", "é".repeat(79)));
    assert_eq!(boundary.content.len(), 175);
    assert_eq!(Task::decode(&boundary).unwrap().encode().unwrap(), boundary);

    for artifact in ["é".repeat(80), "\"".repeat(80)] {
        assert!(Task::decode(&record(&artifact)).is_err());
    }
}

// Definition-bearing v2 records and definition-free v1 records must stay distinct.
#[test]
fn typed_records_bind_a_complete_definition_without_changing_legacy_records() {
    let reference = asmrt::DefinitionRef::new("job:1", "a".repeat(64)).unwrap();
    let typed = Task::defined(1, reference.clone()).unwrap();
    let record = typed.encode().unwrap();
    assert_eq!(Task::decode(&record).unwrap(), typed);
    assert_eq!(typed.definition(), Some(&reference));
    for (tag, content) in [
        ("asmrt.v1.pending", record.content.clone()),
        ("asmrt.v2.pending", r#"{"d":"job:1"}"#.into()),
        (
            "asmrt.v2.pending",
            serde_json::json!({"d":"job:1","h":"not-a-digest"}).to_string(),
        ),
    ] {
        let invalid = Record {
            tag: tag.into(),
            content,
            ..record.clone()
        };
        assert!(Task::decode(&invalid).is_err());
    }
    assert_eq!(Task::pending(2).unwrap().encode().unwrap().content, "{}");
}

#[test]
fn malformed_records_cannot_become_schedulable_tasks() {
    for (id, value, tag, content) in [
        ("0", "0", "asmrt.v1.pending", "{}"),
        ("1", "9223372036854775808", "asmrt.v1.pending", "{}"),
        ("1", "0", "asmrt.v1.running", r#"{"o":"w"}"#),
        ("1", "1", "asmrt.v1.running", "{}"),
        ("1", "1", "asmrt.v1.pending", r#"{"o":"w"}"#),
        ("1", "1", "asmrt.v1.completed", r#"{"o":"w"}"#),
        ("1", "1", "asmrt.v1.running", r#"{"o":"bad\nworker"}"#),
        ("1", "1", "asmrt.v1.completed", r#"{"o":"w","r":""}"#),
        ("1", "0", "asmrt.v1.pending", "{\n}"),
        ("1", "0", "asmrt.v2.pending", "{}"),
    ] {
        let record = Record {
            id: id.into(),
            value: value.into(),
            tag: tag.into(),
            content: content.into(),
        };
        assert!(Task::decode(&record).is_err(), "accepted {record:?}");
    }
}
