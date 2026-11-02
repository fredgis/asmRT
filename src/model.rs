//! Task states, definition references, and the compact versioned asmDB record codec.

use serde::{Deserialize, Serialize};

use crate::Result;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Record {
    pub id: String,
    pub value: String,
    pub tag: String,
    pub content: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TaskState {
    Pending,
    Running,
    Completed,
}

// Definitions stay external; rows retain only a short reference and a SHA-256 digest.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DefinitionRef {
    reference: String,
    sha256: String,
}

impl DefinitionRef {
    pub fn new(reference: impl Into<String>, sha256: impl Into<String>) -> Result<Self> {
        let definition = Self {
            reference: reference.into(),
            sha256: sha256.into(),
        };
        if definition.reference.is_empty()
            || definition.reference.len() > 40
            || definition.reference.chars().any(char::is_control)
            || definition.sha256.len() != 64
            || !definition
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid(
                "a definition needs a short reference and a lowercase SHA-256 digest",
            ));
        }
        Ok(definition)
    }

    pub fn reference(&self) -> &str {
        &self.reference
    }
    pub fn sha256(&self) -> &str {
        &self.sha256
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    id: u64,
    state: TaskState,
    attempt: u64,
    owner: Option<String>,
    artifact: Option<String>,
    definition: Option<DefinitionRef>,
}

impl Task {
    pub fn pending(id: u64) -> Result<Self> {
        let task = Self {
            id,
            state: TaskState::Pending,
            attempt: 0,
            owner: None,
            artifact: None,
            definition: None,
        };
        task.validate()?;
        Ok(task)
    }

    pub fn defined(id: u64, definition: DefinitionRef) -> Result<Self> {
        let mut task = Self::pending(id)?;
        task.definition = Some(definition);
        task.encode()?;
        Ok(task)
    }

    pub fn definition(&self) -> Option<&DefinitionRef> {
        self.definition.as_ref()
    }

    // Transitions build candidate values only; the actor owns persistence and stale-claim checks.
    pub(crate) fn claimed(&self, owner: &str) -> Result<Self> {
        validate_owner(owner)?;
        let mut task = self.clone();
        task.state = TaskState::Running;
        task.attempt = task
            .attempt
            .checked_add(1)
            .ok_or_else(|| invalid("attempt counter exhausted"))?;
        task.owner = Some(owner.into());
        task.artifact = None;
        task.encode()?;
        Ok(task)
    }

    pub(crate) fn completed(&self, artifact: &str) -> Result<Self> {
        let mut task = self.clone();
        task.state = TaskState::Completed;
        task.artifact = Some(artifact.into());
        task.encode()?;
        Ok(task)
    }

    pub(crate) fn requeued(&self) -> Self {
        let mut task = self.clone();
        task.state = TaskState::Pending;
        task.owner = None;
        task.artifact = None;
        task
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn state(&self) -> TaskState {
        self.state
    }

    pub fn attempt(&self) -> u64 {
        self.attempt
    }

    pub fn owner(&self) -> Option<&str> {
        self.owner.as_deref()
    }

    pub fn artifact(&self) -> Option<&str> {
        self.artifact.as_deref()
    }

    // Decimal strings preserve integer precision; only definition-bearing tasks use v2.
    pub fn encode(&self) -> Result<Record> {
        self.validate()?;
        let version = if self.definition.is_some() { 2 } else { 1 };
        let state = match self.state {
            TaskState::Pending => "pending",
            TaskState::Running => "running",
            TaskState::Completed => "completed",
        };
        let tag = format!("asmrt.v{version}.{state}");
        let payload = Payload {
            owner: self.owner.clone(),
            artifact: self.artifact.clone(),
            definition: self
                .definition
                .as_ref()
                .map(|value| value.reference.clone()),
            definition_sha256: self.definition.as_ref().map(|value| value.sha256.clone()),
        };
        let content = serde_json::to_string(&payload).map_err(invalid)?;
        check_content(&content)?;
        Ok(Record {
            id: self.id.to_string(),
            value: self.attempt.to_string(),
            tag,
            content,
        })
    }

    pub fn decode(record: &Record) -> Result<Self> {
        check_content(&record.content)?;
        let state = match record.tag.as_str() {
            "asmrt.v1.pending" | "asmrt.v2.pending" => TaskState::Pending,
            "asmrt.v1.running" | "asmrt.v2.running" => TaskState::Running,
            "asmrt.v1.completed" | "asmrt.v2.completed" => TaskState::Completed,
            _ => return Err(invalid("unsupported task tag or schema version")),
        };
        let payload: Payload = serde_json::from_str(&record.content).map_err(invalid)?;
        let definition = match (payload.definition, payload.definition_sha256) {
            (Some(reference), Some(digest)) => Some(DefinitionRef::new(reference, digest)?),
            (None, None) => None,
            _ => return Err(invalid("incomplete task definition reference")),
        };
        if record.tag.starts_with("asmrt.v2.") != definition.is_some() {
            return Err(invalid("task schema and definition reference disagree"));
        }
        let task = Self {
            id: record.id.parse().map_err(invalid)?,
            state,
            attempt: record.value.parse().map_err(invalid)?,
            owner: payload.owner,
            artifact: payload.artifact,
            definition,
        };
        task.validate()?;
        Ok(task)
    }

    fn validate(&self) -> Result<()> {
        if self.id == 0 || self.attempt > i64::MAX as u64 {
            return Err(invalid(
                "id must be nonzero and attempt must fit a nonnegative i64",
            ));
        }
        if let Some(owner) = self.owner() {
            validate_owner(owner)?;
        }
        for text in [self.owner(), self.artifact()].into_iter().flatten() {
            if text.is_empty() || text.chars().any(char::is_control) {
                return Err(invalid(
                    "owner and artifact must be nonempty, without control characters",
                ));
            }
        }
        // A retried pending task keeps its attempt count, but loses ownership and its artifact.
        let valid = match self.state {
            TaskState::Pending => self.owner.is_none() && self.artifact.is_none(),
            TaskState::Running => {
                self.attempt > 0 && self.owner.is_some() && self.artifact.is_none()
            }
            TaskState::Completed => {
                self.attempt > 0 && self.owner.is_some() && self.artifact.is_some()
            }
        };
        if !valid {
            return Err(invalid(
                "state, ownership, attempt and artifact are inconsistent",
            ));
        }
        Ok(())
    }
}

// Short field names share asmDB's 175-byte content budget, including JSON escaping.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    #[serde(rename = "o", skip_serializing_if = "Option::is_none")]
    owner: Option<String>,
    #[serde(rename = "r", skip_serializing_if = "Option::is_none")]
    artifact: Option<String>,
    #[serde(rename = "d", skip_serializing_if = "Option::is_none")]
    definition: Option<String>,
    #[serde(rename = "h", skip_serializing_if = "Option::is_none")]
    definition_sha256: Option<String>,
}

pub(crate) fn validate_owner(owner: &str) -> Result<()> {
    if owner.is_empty() || owner.len() > 32 || owner.chars().any(char::is_control) {
        return Err(invalid(
            "owner must be 1..=32 UTF-8 bytes, without control characters",
        ));
    }
    Ok(())
}

fn check_content(content: &str) -> Result<()> {
    if content.contains(['\0', '\t', '\r', '\n']) {
        return Err(invalid("content must not contain NUL, TAB, CR or LF"));
    }
    if content.len() > 175 {
        return Err(invalid(format!(
            "content is {} bytes; limit is 175",
            content.len()
        )));
    }
    Ok(())
}

fn invalid(message: impl std::fmt::Display) -> crate::Error {
    crate::Error::Invalid(message.to_string())
}
