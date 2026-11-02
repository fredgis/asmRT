# Agent workflow types

A workflow type names an orchestration contract, not a task handler or a model. This reference defines the first implemented agent workflow. See the [architecture reference](ARCHITECTURE.md) for process boundaries, native records, and recovery details, and the [glossary](../CONTEXT.md) for terminology.

## Type registry

| Kind | Workflow version | Status | Contract |
| --- | --- | --- | --- |
| `conversation.sequential` | `1` | Implemented | Fixed-order agent turns over a shared committed conversation prefix, repeated for a fixed number of rounds. |

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

## `conversation.sequential` v1

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

## Versions and compatibility

| Namespace | Meaning |
| --- | --- |
| `workflow.kind` + `workflow.version` | Agent orchestration contract: `conversation.sequential` v1. |
| Job `kind` + `version` | Task/request handler: `llm.chat.turn` v1, v2, or v3; new jobs still use v3. These are **not workflow versions**. |
| `asmrt.conversation.v1`, `asmrt.task.v1`, `asmrt.chat.reply.v1` | JSON envelope/schema identifiers, unchanged by this descriptor. |
| Native record codec version | Independent coordination-record encoding, unchanged. |

An absent `workflow` on a legacy plan means `conversation.sequential` v1. It stays absent when that plan is serialized: loading does not inject metadata or rewrite immutable files. Existing job JSON, request hashes, reply formats, and native records are unchanged. New descriptor-bearing plans have their own plan-file hashes, as expected.

With events enabled, `ready.conversation.workflow` reports the **effective** descriptor, including for legacy plans. This observation does not change the saved plan or its hash. The controller already carries the full conversation snapshot, so no new event kind or controller protocol is required. An already-running older binary is not retroactively updated.

Compatibility means the updated reader accepts legacy plans; pre-descriptor binaries reject the new field under their strict schema validation. Do not edit saved plans to downgrade them.

## Future type boundaries

Parallel branches or conditional routing are unimplemented possibilities, not registered kinds, accepted configuration, or commitments. A future type would need its own explicit ordering, input, completion, and recovery contract. This registry does not introduce a generic workflow engine, DAG language, or configuration interface.

Implementation: [`Plan::prepare`, `Plan::validate`, `request`, and `run` in `src/chat.rs`](../src/chat.rs).
