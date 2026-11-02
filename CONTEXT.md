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

**Sequential conversation** (`conversation.sequential`):
A conversation in which one role speaks at a time, using all earlier committed replies as context.
_Avoid_: Peer-to-peer message bus, last-message relay.

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
