# Agent workflow types

A workflow type names an orchestration contract, not a task handler or a model. asmRT implements **Workflow 1: sequential conversation** and **Workflow 2: discussion**. See the [architecture reference](ARCHITECTURE.md) for process boundaries, native records, and recovery details, and the [glossary](../CONTEXT.md) for terminology.

## Type registry

| Workflow | Kind | Workflow version | Status | Contract |
| --- | --- | --- | --- | --- |
| 1 | `conversation.sequential` | `1` | Implemented | Fixed-order agent turns over a shared committed conversation prefix, repeated for a fixed number of rounds. |
| 2 | `conversation.discussion` | `1` | Implemented | Planner seed, concurrent Builder/Critic/Editor debate waves, committed fan-in, final Editor decision. |

The existing **storage demo** (`demo` CLI command) is a deterministic concurrent runtime exercise, not another registered agent workflow type.

New `conversation.json` plans include this field (manifest excerpt):

```json
{
  "workflow": {
    "kind": "conversation.sequential",
    "version": 1
  }
}
```

## Workflow 1: sequential conversation

Canonical descriptor: `conversation.sequential`, version `1`. “Workflow 1” is its documentation label, not an additional serialized field.

### Sequence and context

Rust orchestrates **Planner → Builder → Critic → Editor**, then repeats that order for the saved number of rounds. The default is two rounds (eight turns); one to three rounds are supported. This is a finite ordered plan, not an unbounded loop or a conversation that autonomously decides when to stop.

The four agents are logical roles sharing one saved model identity. There is **at most one model call at a time** within the conversation. They do not directly send or subscribe to peer messages: the orchestrator supplies their saved replies as later turns' inputs.

Turn `n` consumes **all preceding committed replies, in order** (`1` through `n − 1`), including that role's own earlier contributions. It is not merely a relay of the immediately preceding message. All those messages enter the request; this does not remove the model's finite context limit.

For the current `llm.chat.turn` handler v3, the request contains the saved system/role instruction, the shared goal, that committed prefix, and the saved current-turn instruction. Within the prefix:

- The speaking role's own earlier utterances are `assistant` messages.
- Other roles' utterances are `user` messages labeled `<Name> says: ...`, explicitly presented as teammate contributions rather than instructions.

Handler v1 and v2 retain their original history encodings on replay; they obey the same workflow ordering. Topic, model settings, prompts, and scenario instructions remain properties of the saved plan/jobs, not new workflow kinds.

### Completion and durability

Native task records and immutable external files have different responsibilities:

- `conversation.json` holds the plan and optional workflow descriptor. `definitions/<id>.json` holds each job, including its handler/version and complete preceding input-ID list.
- Native 256-byte records hold coordination state, claims/attempts, definition references, and completed reply hashes, not the conversation text or workflow descriptor.
- `artifacts/<id>.json` holds the actual reply, identities, job/request hashes, causal input-file hashes, and generation measurements.

The turn loop claims the next job, validates any existing reply or performs inference, flushes and atomically publishes the reply without overwriting saved work, then commits completion through the State Actor. **Only after completion is acknowledged does the reply enter the committed prefix and the loop advance to the next turn.** Guided checkpoints may delay advancement; they do not change this order. All jobs can already be enqueued as pending; pending status alone does not make a later turn eligible for inference.

### Validation, recovery, and retries

When loading an existing plan, `Plan::prepare` calls `Plan::validate` before chat prepares definition/artifact directories, enqueues tasks, or contacts Ollama. An explicitly unsupported workflow kind or version fails validation; it never silently falls back to sequential execution.

Recovery validates the ordered committed prefix, saved definitions, job/request identity, causal input hashes, and completed reply-file hashes. A missing or conflicting required file stops execution rather than being replaced. A fully validated reply published before a crash but not yet committed can be reused without another model call; completed turns are not regenerated. A valid completed replay needs no inference and can run with Ollama offline.

Before reply publication, a retry may repeat a model call even if inference already ran. The workflow does **not** promise exactly-once inference. Publication and native completion are separate durable steps.

**Open-order boundary:** the existing `Runtime::open` performs native recovery before the chat application's plan validation. Rejecting an unsupported plan therefore prevents subsequent chat preparation/execution, but does not make opening a run read-only or undo an earlier native `running → pending` recovery transition.

## Workflow 2: discussion

Canonical descriptor: `conversation.discussion`, version `1`. Planner opens with an idea; Builder, Critic and Editor debate in parallel; Editor then writes a concrete final decision.

### Waves and context

One to three debate rounds are supported, two by default. The total is `3 × rounds + 2` jobs: one seed, three jobs per debate round and one synthesis. The default plan is:

```text
1 Planner
   ├── 2 Builder ─┐
   ├── 3 Critic  ─┼── commit wave 1
   └── 4 Editor  ─┘
   ├── 5 Builder ─┐
   ├── 6 Critic  ─┼── commit wave 2
   └── 7 Editor  ─┘
                 └── 8 Editor: final decision
```

- Jobs 2/3/4 all read `[1]`; jobs 5/6/7 all read `[1,2,3,4]`; job 8 reads `[1,2,3,4,5,6,7]`.
- Rust launches three asynchronous model requests per debate wave. This is not a loop awaiting one reply before starting its sibling. Ollama can still serialize or queue token generation internally; runtime concurrency does not promise GPU parallelism or a speedup.
- Each sibling receives the same prior-wave history, in task-ID order. Role-aware v3 encoding still marks that speaker's own earlier replies as assistant messages. No current-wave sibling leaks into another request because it happened to finish first.
- Later rounds explicitly confront named teammates' proposals and objections. The final Editor instruction asks for a decision, not another debate contribution.
- There is one saved model identity, not four model processes. This fixed fan-out/fan-in contract is neither an arbitrary DAG language nor an unbounded autonomous conversation.

### Publication, fan-in and recovery

The same State Actor, MCP connection, native records and immutable file formats are used. Rust claims current-wave pending jobs in ascending ID order before inference. Guided checkpoints are shared by the wave: claim the batch, launch its model requests together, publish replies, then commit completion. Only committed dependencies can release a later wave or final synthesis. There are no competing stdin readers.

Recovery validates each job's required committed input set and exact file hashes. Completed siblings need not form a contiguous prefix: valid tasks 1, 3 and 4 can survive while task 2 remains unfinished. Only the missing branch resumes; later waves still wait for all prerequisites. Valid published-but-uncommitted replies are reused. Completed offline replay performs zero model calls and zero new completions.

The automatic two-round demo deliberately stops Rust after claiming jobs 5/6/7, before their inference. With one debate round, it stops after claiming 2/3/4 instead. Recovery increments only interrupted claims; the planned interruption does not repeat on attempt 2. The standalone CLI does not inject the demo crash.

Unsupported kinds, versions or dependency topologies are rejected. The publication/commit distinction, possible repeated inference before publication, and `Runtime::open` ordering caveat described above also apply here.

## Selecting a workflow

The console offers compact diagrammed choices before **Start conversation**. `POST /api/conversation` accepts `workflow: "conversation.sequential"` or `workflow: "conversation.discussion"`; omission defaults to sequential. A selected run retains its workflow across controller restarts.

The CLI accepts `chat --workflow sequential` or `chat --workflow discussion`. Omission means sequential for a new plan and preserves the saved workflow for an existing plan. An explicit conflicting selection is rejected rather than rewriting saved work.

The playful **Overview** and professional **Details** present the same run. Browsing a saved reply or switching views does not schedule an agent or alter the workflow. Overview's committed-memory checks come from native record observations, not merely from reply files.

**Pause** holds future story transitions; active inference may still finish. **Reset demo** stops playback and the owned runtime, clears the selected run and observations, and preserves old run directories. It starts no inference. The next **Start conversation** creates a new directory and plan with the chosen workflow. See the [controller contract](ARCHITECTURE.md#7-browser-controller-and-observable-evidence).

## Versions and compatibility

| Namespace | Meaning |
| --- | --- |
| `workflow.kind` + `workflow.version` | Agent orchestration contract: `conversation.sequential` v1 or `conversation.discussion` v1. |
| Job `kind` + `version` | Task/request handler: `llm.chat.turn` v1, v2, or v3; new jobs still use v3. These are **not workflow versions**. |
| `asmrt.conversation.v1`, `asmrt.task.v1`, `asmrt.chat.reply.v1` | JSON envelope/schema identifiers, unchanged by this descriptor. |
| Native record codec version | Independent coordination-record encoding, unchanged. |

An absent `workflow` on a legacy plan means `conversation.sequential` v1. It stays absent when that plan is serialized: loading does not inject metadata or rewrite immutable files. Existing job JSON, request hashes, reply formats, and native records are unchanged. New descriptor-bearing plans have their own plan-file hashes, as expected.

With events enabled, `ready.conversation.workflow` reports the **effective** descriptor, including for legacy plans. Additive `ready.conversation.turns` metadata lists each `task_id`, `agent_id` and saved `input_ids`. These observations do not change a saved plan or its hash; existing event names remain unchanged.

The browser snapshot persists the canonical string in `run.workflow` and exposes the descriptor object in `conversation.workflow`. `conversation.active_turns` tracks each active job independently; `conversation.active` remains the first active job or null for compatibility. Messages are displayed in saved task-ID order, not network-completion order. Closing or resetting a runtime clears all active jobs. Update the controller and Rust binary together; an already-running older binary is not retroactively updated.

Compatibility means the updated reader accepts legacy plans; pre-descriptor binaries reject the new field under their strict schema validation. Do not edit saved plans to downgrade them.

## Future type boundaries

Conditional routing, arbitrary branching graphs and unbounded discussions are future possibilities, not registered kinds or accepted configuration. A future type needs its own explicit ordering, input, completion and recovery contract. Workflow 2's fixed parallel debate does not imply support for arbitrary DAG configuration.

Implementation: [`Plan::prepare`, `Plan::validate`, `request`, and `run` in `src/chat.rs`](../src/chat.rs).
