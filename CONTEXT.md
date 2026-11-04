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

**Workflow 2: discussion** (`conversation.discussion`, version `1`):
Planner proposes an idea. Builder, Critic and Editor debate in concurrent waves, each using the same prior committed history. Editor then synthesizes a final decision.
_Avoid_: Sequential relay, unlimited autonomous discussion, arbitrary DAG engine.

**Stateful agent**:
A role whose saved instructions, task progress and replies survive a process restart through asmRT, asmDB and immutable files. The LLM remains stateless; asmRT reconstructs its request context.
_Avoid_: Permanent model memory, unlimited context.

**Conditional graph / handoff**:
A saved routing result selects a branch or specialist. Recovery follows that durable choice rather than asking the model to choose again.
_Avoid_: Arbitrary user-programmable graph, fresh routing on every restart.

**Role-based team / hybrid orchestration**:
Known dependency patterns that delegate specialist work and merge committed results; independent jobs can run concurrently.

**Human approval**:
An explicit saved human decision that releases a blocked workflow. Starting or resuming automatic playback is not approval.
_Avoid_: Model consent, inferred approval, exactly-once external effects.

**Agent loop**:
A bounded act/verify feedback cycle over saved context, with a fixed iteration budget.
_Avoid_: Unlimited autonomous execution.

**Turn**:
One role's contribution represented by a durable task; turns in a discussion wave can execute concurrently.

**Round**:
In Workflow 1, one ordered pass through all four roles. In Workflow 2, one three-role debate wave after Planner's opening idea.

**Debate wave / fan-in**:
Three concurrent sibling jobs over the same committed input set. The next wave or final synthesis waits for all required completions.

**Committed input set**:
The saved, ordered dependency IDs whose verified replies form a job's context. Sibling replies from the current wave are excluded.

**Published reply**:
A produced contribution that is available but not necessarily committed.

**Committed reply**:
A reply accepted as completed work in the conversation's authoritative history.

**Committed prefix**:
Workflow 1's uninterrupted sequence of committed replies preceding the next unfinished turn.

**Overview / Details**:
Two presentations of the same run: graphical conversation and memory, or professional runtime/database inspection. Switching views does not advance the workflow.

**Reset demo**:
Stop playback and the owned runtime, clear the selected run and observations, and keep old run folders. The next Start creates a new run; reset itself starts no inference.
_Avoid_: Delete saved work, rewind committed history, resume the existing run.
