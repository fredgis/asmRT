//! +--------------------------------------------------------------------+
//! | asmRT :: lib.rs -- public runtime API                               |
//! +--------------------------------------------------------------------+
//! Tasks and state handles coordinate durable work through the asmDB MCP
//! bridge. Storage belongs to one actor; model calls and artifact files
//! belong to the application, not this library.

#![forbid(unsafe_code)]

mod mcp;
mod model;
mod runtime;

pub use model::{DefinitionRef, Record, Task, TaskState};
pub use runtime::{Config, Runtime, StateHandle};

/// A transport failure can leave a write's outcome unknown. Reopen and
/// reconcile persisted state instead of blindly retrying the same operation.
#[derive(Clone, Debug, thiserror::Error)]
pub enum Error {
    #[error("invalid input or task record: {0}")]
    Invalid(String),
    #[error("MCP transport failed: {0}; reconnect and reconcile before retrying")]
    Transport(String),
    #[error("asmDB rejected the operation: {0}")]
    Backend(String),
    #[error("task conflict: {0}")]
    Conflict(String),
    #[error("the State Actor is closed")]
    Closed,
}

// Backend and transport failures stop the actor rather than allow further operations.
impl Error {
    fn is_fatal(&self) -> bool {
        matches!(self, Self::Transport(_) | Self::Backend(_))
    }
}

pub type Result<T> = std::result::Result<T, Error>;
