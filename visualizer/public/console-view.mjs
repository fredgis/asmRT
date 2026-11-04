// +--------------------------------------------------------------------+
// | asmRT :: console-view.mjs -- pure observation-to-view helpers        |
// +--------------------------------------------------------------------+
// Validates conversation snapshots and decodes readable memory fields.
// Unknown records remain inspectable; a reply file alone never earns a
// native-commit checkmark. No process, network or storage mutations here.

export function isConversationWorkflow(kind) {
  return ['sequential', 'discussion', 'graph', 'roles', 'approval', 'handoff', 'hybrid', 'loop']
    .some(name => kind === `conversation.${name}`);
}

export function conversationWorkflow(snapshot, run) {
  return snapshot?.workflow ?? { kind: run?.workflow ?? 'conversation.sequential', version: 1 };
}

export function conversationActiveTurns(snapshot) {
  return snapshot?.active_turns ?? (snapshot?.active ? [snapshot.active] : []);
}

// New metadata is optional for legacy sequential snapshots, but must be well formed when present.
export function validConversation(snapshot) {
  const ids = value => Array.isArray(value) && value.every(id => typeof id === 'string');
  const turn = value => value && typeof value.task_id === 'string' && typeof value.agent_id === 'string' && ids(value.input_ids);
  const active = value => turn(value) && ['assigned', 'generating', 'saved'].includes(value.stage);
  const unique = values => new Set(values.map(value => value.task_id)).size === values.length;
  if (snapshot == null) return true;
  return snapshot.schema === 'asmrt.conversation.v1' && typeof snapshot.topic === 'string'
    && typeof snapshot.model?.name === 'string' && typeof snapshot.model.digest === 'string'
    && Array.isArray(snapshot.agents) && snapshot.agents.length === 4
    && snapshot.agents.every(agent => ['id', 'name', 'role', 'prompt'].every(key => typeof agent?.[key] === 'string'))
    && new Set(snapshot.agents.map(agent => agent.id)).size === 4
    && Number.isInteger(snapshot.rounds) && snapshot.rounds > 0
    && Number.isInteger(snapshot.turns_total) && snapshot.turns_total > 0
    && typeof snapshot.definition_file === 'string' && typeof snapshot.definition_sha256 === 'string'
    && (snapshot.workflow === undefined || (isConversationWorkflow(snapshot.workflow?.kind) && snapshot.workflow.version === 1))
    && (snapshot.turns === undefined || (Array.isArray(snapshot.turns) && snapshot.turns.every(turn) && unique(snapshot.turns)))
    && Array.isArray(snapshot.messages) && snapshot.messages.every(message =>
      message?.schema === 'asmrt.chat.reply.v1'
      && ['task_id', 'agent_id', 'agent_name', 'model', 'text'].every(key => typeof message[key] === 'string')
      && ids(message.input_ids) && typeof message.committed === 'boolean' && typeof message.reused === 'boolean')
    && unique(snapshot.messages)
    && (snapshot.active == null || active(snapshot.active))
    && (snapshot.active_turns === undefined || (Array.isArray(snapshot.active_turns)
      && snapshot.active_turns.every(active) && unique(snapshot.active_turns)));
}

export function nativeRecordFields(row, raw = false, detail = 'deep') {
  const overview = detail === 'overview';
  const state = /^asmrt\.v[12]\.(pending|running|completed)$/.exec(row.tag)?.[1] ?? '';
  const exact = { state, tag: row.tag, content: row.content, hashes: '' };
  if ((raw && !overview) || !state) return exact;
  let refs;
  try { refs = JSON.parse(row.content); } catch { return exact; }
  if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return exact;
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const owner = typeof refs.o === 'string' ? refs.o : '';
  const reference = typeof refs.d === 'string' ? refs.d
    : typeof refs.r === 'string' && !hash(refs.r) ? refs.r : '';
  if (!reference) return exact;
  return {
    state,
    tag: state,
    content: overview ? owner || reference : [owner, reference].filter(Boolean).join(' / '),
    hashes: overview ? '' : [hash(refs.h) ? `job ${refs.h.slice(0, 8)}…` : '', hash(refs.r) ? `reply ${refs.r.slice(0, 8)}…` : ''].filter(Boolean).join('  '),
  };
}

// Published text is not proof of a commit: only a valid native completion earns a checkmark.
export function conversationMemory(snapshot, database, total = 8) {
  const replies = new Map((snapshot?.messages ?? []).map(message => [message.task_id, message]));
  const rows = new Map((database?.rows ?? []).map(row => [row.id, row]));
  const turns = snapshot?.turns ?? Array.from({ length: total }, (_, index) => ({ task_id: String(index + 1) }));
  return turns.map(turn => {
    const id = turn.task_id;
    const message = replies.get(id);
    const row = rows.get(id);
    let nativeState = /^asmrt\.v2\.(pending|running|completed)$/.exec(row?.tag)?.[1];
    if (nativeState) {
      let refs;
      try { refs = JSON.parse(row.content); } catch { /* Unrecognized data stays in Details. */ }
      if (refs?.d !== `job:${id}` || !/^[a-f0-9]{64}$/.test(refs?.h ?? '')
        || (nativeState === 'completed' && !/^[a-f0-9]{64}$/.test(refs?.r ?? ''))) nativeState = undefined;
    }
    const status = row && !nativeState ? 'unknown' : nativeState === 'completed' ? 'committed'
      : message ? 'saved' : nativeState === 'running' ? 'assigned' : nativeState === 'pending' ? 'waiting' : 'unobserved';
    return { id, status, message, agent_id: turn.agent_id ?? message?.agent_id, input_ids: turn.input_ids ?? message?.input_ids };
  });
}

export function conversationChapter(scene, tasks = []) {
  if (!scene) return -1;
  if (['chat-verified', 'chat-completed'].includes(scene)) return 3;
  if (['chat-crash-next', 'chat-crashed', 'chat-reopen'].includes(scene)) return 1;
  if (scene === 'chat-recovered' || tasks.some(task => Number(task.attempt) > 1)) return 2;
  return 0;
}
