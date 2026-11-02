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

export function conversationChapter(scene, tasks = []) {
  if (!scene) return -1;
  if (['chat-verified', 'chat-completed'].includes(scene)) return 3;
  if (['chat-crash-next', 'chat-crashed', 'chat-reopen'].includes(scene)) return 1;
  if (scene === 'chat-recovered' || tasks.some(task => Number(task.attempt) > 1)) return 2;
  return 0;
}
