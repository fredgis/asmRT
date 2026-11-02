# asmRT conversations

Language for agent conversations and their workflow types.

## Language

**Agent workflow type**:
A named, versioned contract for how agent turns depend on one another and advance.
_Avoid_: Task handler version.

**Conversation**:
An exchange among agent roles working toward a shared goal.

**Agent role**:
A named participant with a distinct responsibility in the conversation.
_Avoid_: Model instance, worker process.

**Workflow 1: sequential conversation** (`conversation.sequential`, version `1`):
A conversation in which one role speaks at a time, using all earlier committed replies as context. Rust sequences Planner → Builder → Critic → Editor for the saved number of rounds; one shared model receives at most one call at a time. See the [workflow contract](Docs/WORKFLOWS.md).
_Avoid_: Peer-to-peer message bus, last-message relay, general parallel-workflow engine.

**Turn**:
One role's contribution at a specified position in a conversation.

**Round**:
One ordered pass through Planner, Builder, Critic, and Editor.

**Published reply**:
A produced contribution that is available but not necessarily committed.

**Committed reply**:
A reply accepted as completed work in the conversation's authoritative history.

**Committed prefix**:
The uninterrupted sequence of committed replies preceding the next unfinished turn.

**Overview / Details**:
Two presentations of the same run: graphical conversation and memory, or professional runtime/database inspection. Switching views does not advance the workflow.

**Reset demo**:
Stop playback and the owned runtime, clear the selected run and observations, and keep old run folders. The next Start creates a new run; reset itself starts no inference.
_Avoid_: Delete saved work, rewind committed history, resume the existing run.
