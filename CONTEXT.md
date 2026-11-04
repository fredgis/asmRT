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

**Workflow 3: conditional graph** (`conversation.graph`, version `1`):
A committed routing result selects one of two model branches; the other records a skipped artifact. The final result joins the saved outputs.
_Avoid_: Arbitrary user-programmable graph, fresh routing on every restart.

**Workflow 4: role-based team** (`conversation.roles`, version `1`):
A manager briefs two parallel specialists, a writer merges their committed results, and the manager reviews the recommendation.

**Workflow 5: human approval** (`conversation.approval`, version `1`):
An explicit saved human decision releases a blocked workflow into local demo actions or recorded skips. Starting or resuming automatic playback is not approval.
_Avoid_: Model consent, inferred approval, exactly-once external effects.

**Workflow 6: agent handoff** (`conversation.handoff`, version `1`):
Committed triage selects a specialist; the other path records a skip. The chosen specialist's result returns with its saved context.
_Avoid_: Moving a live process, payment integration.

**Workflow 7: hybrid orchestration** (`conversation.hybrid`, version `1`):
Parallel specialist work feeds a merge, followed by bounded refinement/verification pairs and final synthesis. A committed DONE decision skips the remaining refinement work.

**Workflow 8: agent loop** (`conversation.loop`, version `1`):
A bounded plan/local-action/verify feedback cycle over saved context. DONE skips remaining cycles; RETRY continues only within the saved iteration budget. Final synthesis still runs.
_Avoid_: Unlimited autonomous execution.

**Turn**:
One planned contribution represented by a durable task: a model reply, human decision, local tool result or recorded skip. Independent turns can execute concurrently.

**Round**:
In Workflow 1, one ordered pass through all four roles. In Workflow 2, one three-role debate wave after Planner's opening idea. In Workflow 7, one refinement/verification pair; in Workflow 8, one plan/action/verify cycle. Workflows 3–6 have fixed job counts regardless of the saved rounds setting.

**Debate wave / fan-in**:
Three concurrent sibling jobs over the same committed input set. The next wave or final synthesis waits for all required completions.

**Committed input set**:
The saved, ordered dependency IDs whose verified replies form a job's context. Sibling replies from the current wave are excluded.

**Published reply**:
A flushed, non-clobber-published reply file that is available but not necessarily committed.

**Committed reply**:
A reply bound by its full-file hash to an acknowledged native task completion. Recovery validates that binding before admitting it to authoritative history.

**Committed prefix**:
Workflow 1's uninterrupted sequence of committed replies preceding the next unfinished turn.

**Overview / Details**:
Two presentations of the same run: graphical conversation and memory, or detailed runtime/database inspection. Switching views does not advance the workflow. A next-run workflow preview changes only the diagram, not the saved conversation or its memory.

**Reset demo**:
Stop playback and the owned runtime, clear the selected run and observations, and keep old run folders. The next Start creates a new run; reset itself starts no inference.
_Avoid_: Delete saved work, rewind committed history, resume the existing run.
