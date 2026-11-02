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

export function conversationMemory(snapshot, database, total = 8) {
  const replies = new Map((snapshot?.messages ?? []).map(message => [message.task_id, message]));
  const rows = new Map((database?.rows ?? []).map(row => [row.id, row]));
  return Array.from({ length: total }, (_, index) => {
    const id = String(index + 1);
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
    return { id, status, message };
  });
}

export function conversationChapter(scene, tasks = []) {
  if (!scene) return -1;
  if (['chat-verified', 'chat-completed'].includes(scene)) return 3;
  if (['chat-crash-next', 'chat-crashed', 'chat-reopen'].includes(scene)) return 1;
  if (scene === 'chat-recovered' || tasks.some(task => Number(task.attempt) > 1)) return 2;
  return 0;
}
