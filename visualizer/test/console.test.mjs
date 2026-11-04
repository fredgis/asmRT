// Verifies backward-compatible conversation metadata and honest, lossless native-memory presentation.
import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeRecordFields, conversationChapter, conversationMemory, conversationWorkflow, conversationActiveTurns, isConversationWorkflow, validConversation } from '../public/console-view.mjs';

const row = { id: '9007199254740993', value: '2', tag: 'asmrt.v2.completed', content: JSON.stringify({ o: 'planner', d: 'job:5', h: 'a'.repeat(64), r: 'b'.repeat(64) }) };

test('readable records decode only native fields, keep hashes distinct, and expose exact raw values', () => {
  assert.deepEqual(nativeRecordFields(row), { state: 'completed', tag: 'completed', content: 'planner / job:5', hashes: 'job aaaaaaaa…  reply bbbbbbbb…' });
  assert.deepEqual(nativeRecordFields(row, true), { state: 'completed', tag: row.tag, content: row.content, hashes: '' });
  assert.equal(row.id, '9007199254740993');
  assert.deepEqual(nativeRecordFields({ ...row, tag: 'asmrt.v1.completed', content: '{"o":"worker-1","r":"artifact:5"}' }), { state: 'completed', tag: 'completed', content: 'worker-1 / artifact:5', hashes: '' });
});

test('overview hides technical references and hashes even after raw mode, without changing the native record', () => {
  const before = JSON.stringify(row);
  assert.deepEqual(nativeRecordFields(row, true, 'overview'), { state: 'completed', tag: 'completed', content: 'planner', hashes: '' });
  assert.deepEqual(nativeRecordFields({ ...row, tag: 'asmrt.v2.pending', content: '{"d":"job:7","h":"' + 'a'.repeat(64) + '"}' }, false, 'overview'), { state: 'pending', tag: 'pending', content: 'job:7', hashes: '' });
  assert.equal(JSON.stringify(row), before);
  assert.equal(nativeRecordFields(row, true, 'deep').content, row.content);
});

test('unknown or malformed records remain exact rather than acquiring invented references', () => {
  for (const changed of [{ tag: 'other.completed' }, { content: 'not JSON' }, { content: 'null' }, { content: '[]' }, { content: '{"d":42}' }]) {
    const input = { ...row, ...changed };
    for (const detail of ['overview', 'deep']) {
      const result = nativeRecordFields(input, false, detail);
      assert.equal(result.tag, input.tag);
      assert.equal(result.content, input.content);
      assert.equal(result.hashes, '');
    }
  }
});

test('graphical memory separates published replies from native completion and preserves exact text', () => {
  const messages = [
    { task_id: '1', committed: true, text: 'A real reply.\nKept verbatim.' },
    { task_id: '2', committed: true, text: 'New reply; database listing is still older.' },
  ];
  const native = (id, state) => ({ id, tag: `asmrt.v2.${state}`, content: JSON.stringify({ d: `job:${id}`, h: 'a'.repeat(64), ...(state === 'completed' ? { r: 'b'.repeat(64) } : {}) }) });
  const database = { rows: [native('3', 'pending'), native('1', 'completed'), native('2', 'running')] };
  const before = JSON.stringify({ messages, database });
  const cells = conversationMemory({ messages }, database, 4);
  assert.deepEqual(cells.map(cell => cell.status), ['committed', 'saved', 'waiting', 'unobserved']);
  assert.strictEqual(cells[0].message, messages[0]);
  assert.equal(cells[1].message.text, messages[1].text);
  assert.equal(JSON.stringify({ messages, database }), before);
  assert.deepEqual(conversationMemory(null, null, 4).map(cell => cell.status), Array(4).fill('unobserved'));
});

test('graphical memory never turns an unknown or malformed native record into a successful commit', () => {
  const message = { task_id: '1', text: 'Saved on disk.', committed: true };
  for (const record of [
    { tag: 'other.completed', content: '{}' },
    { tag: 'asmrt.v2.completed', content: 'invalid' },
    { tag: 'asmrt.v2.completed', content: 'null' },
    { tag: 'asmrt.v2.completed', content: JSON.stringify({ d: 'job:1', h: 'a'.repeat(64) }) },
  ]) {
    const [cell] = conversationMemory({ messages: [message] }, { rows: [{ id: '1', ...record }] }, 1);
    assert.equal(cell.status, 'unknown');
    assert.strictEqual(cell.message, message);
  }
});

test('recovery progress follows actual scene and retry observations, not a browser timer', () => {
  assert.equal(conversationChapter(null), -1);
  assert.equal(conversationChapter('chat-saved', [{ attempt: '1' }]), 0);
  assert.equal(conversationChapter('chat-crash-next'), 1);
  assert.equal(conversationChapter('chat-crashed'), 1);
  assert.equal(conversationChapter('chat-recovered'), 2);
  assert.equal(conversationChapter('chat-saved', [{ attempt: '2' }]), 2);
  assert.equal(conversationChapter('chat-completed', [{ attempt: '2' }]), 3);
  assert.equal(conversationChapter('chat-verified'), 3);
});

// Workflow metadata is additive: old relay snapshots and independently arriving debate replies both remain readable.
const discussionTurns = [
  { task_id: '1', agent_id: 'planner', input_ids: [] },
  { task_id: '2', agent_id: 'builder', input_ids: ['1'] },
  { task_id: '3', agent_id: 'critic', input_ids: ['1'] },
  { task_id: '4', agent_id: 'editor', input_ids: ['1'] },
  { task_id: '5', agent_id: 'builder', input_ids: ['2', '3', '4'] },
  { task_id: '6', agent_id: 'critic', input_ids: ['2', '3', '4'] },
  { task_id: '7', agent_id: 'editor', input_ids: ['2', '3', '4'] },
  { task_id: '8', agent_id: 'editor', input_ids: ['5', '6', '7'] },
];
const debate = discussionTurns.slice(1, 4).map((turn, index) => ({ ...turn, stage: ['generating', 'assigned', 'saved'][index] }));
const legacyConversation = {
  schema: 'asmrt.conversation.v1', topic: 'Plan a dinner.', model: { name: 'local', digest: 'model-digest' },
  agents: ['planner', 'builder', 'critic', 'editor'].map(id => ({ id, name: id, role: id, prompt: id })),
  rounds: 2, turns_total: 8, definition_file: 'conversation.json', definition_sha256: 'a'.repeat(64), messages: [], active: null,
};

test('saved workflow descriptors take precedence over run metadata, with a sequential legacy fallback', () => {
  const snapshot = { workflow: { kind: 'conversation.discussion', version: 1 } };
  const run = { workflow: 'conversation.sequential' };
  const before = JSON.stringify({ snapshot, run });
  assert.deepEqual(conversationWorkflow(snapshot, run), { kind: 'conversation.discussion', version: 1 });
  assert.deepEqual(conversationWorkflow(null, { workflow: 'conversation.discussion' }), snapshot.workflow);
  assert.deepEqual(conversationWorkflow({}, {}), { kind: 'conversation.sequential', version: 1 });
  assert.equal(JSON.stringify({ snapshot, run }), before);
  assert.equal(isConversationWorkflow(snapshot.workflow.kind), true);
  for (const invalid of ['discussion', 'conversation.other', snapshot.workflow, null]) assert.equal(isConversationWorkflow(invalid), false);
});

test('active turns preserve all branch stages and explicit empty batches override the legacy active turn', () => {
  const snapshot = { active: debate[0], active_turns: debate };
  const before = JSON.stringify(snapshot);
  assert.deepEqual(conversationActiveTurns(snapshot), debate);
  assert.deepEqual(conversationActiveTurns({ active: debate[0], active_turns: [] }), []);
  assert.deepEqual(conversationActiveTurns({ active: debate[0] }), [debate[0]]);
  assert.deepEqual(conversationActiveTurns(null), []);
  assert.equal(JSON.stringify(snapshot), before);
});

test('snapshot validation accepts legacy relay and additive discussion metadata', () => {
  assert.equal(validConversation(legacyConversation), true);
  assert.equal(validConversation({ ...legacyConversation, workflow: { kind: 'conversation.sequential', version: 1 } }), true);
  assert.equal(validConversation({ ...legacyConversation, workflow: { kind: 'conversation.discussion', version: 1 }, turns: discussionTurns, active: debate[0], active_turns: debate }), true);
  assert.equal(validConversation({ ...legacyConversation, active: debate[0], active_turns: [] }), true);
  for (const kind of ['graph', 'roles', 'approval', 'handoff', 'hybrid', 'loop']) {
    assert.equal(validConversation({ ...legacyConversation, workflow: { kind: `conversation.${kind}`, version: 1 }, turns: discussionTurns }), true);
  }
});

test('snapshot validation rejects malformed workflow, dependency and concurrent-turn metadata', () => {
  for (const change of [
    { workflow: 'conversation.discussion' },
    { workflow: { kind: 'conversation.discussion', version: 2 } },
    { workflow: { kind: 'conversation.unknown', version: 1 } },
    { turns: [{ ...discussionTurns[0], input_ids: [1] }] },
    { turns: [discussionTurns[0], discussionTurns[0]] },
    { active_turns: null },
    { active_turns: [debate[0], debate[0]] },
    { active_turns: [{ ...debate[0], stage: 'completed' }] },
    { active_turns: [{ ...debate[0], input_ids: '1' }] },
  ]) assert.equal(validConversation({ ...legacyConversation, ...change }), false, JSON.stringify(change));
});

test('discussion memory follows saved turn roles and dependencies, not publication order or a four-role cycle', () => {
  const turns = [...discussionTurns.slice(0, 4), { task_id: '5', agent_id: 'editor', input_ids: ['2', '3', '4'] }];
  const messages = [
    { task_id: '4', agent_id: 'editor', text: 'Arrived before the other branches.', committed: true },
    { task_id: '2', agent_id: 'builder', text: 'A complete reply.\n'.repeat(100), committed: true },
  ];
  const native = (id, state) => ({ id, tag: `asmrt.v2.${state}`, content: JSON.stringify({ d: `job:${id}`, h: 'a'.repeat(64), ...(state === 'completed' ? { r: 'b'.repeat(64) } : {}) }) });
  const database = { rows: [native('5', 'pending'), native('2', 'running'), native('1', 'completed'), native('3', 'pending'), { id: '4', tag: 'asmrt.v2.completed', content: '{}' }] };
  const snapshot = { turns, messages, workflow: { kind: 'conversation.discussion', version: 1 } };
  const before = JSON.stringify({ snapshot, database });
  const cells = conversationMemory(snapshot, database);
  assert.deepEqual(cells.map(cell => cell.id), ['1', '2', '3', '4', '5']);
  assert.deepEqual(cells.map(cell => cell.agent_id), ['planner', 'builder', 'critic', 'editor', 'editor']);
  assert.deepEqual(cells.map(cell => cell.status), ['committed', 'saved', 'waiting', 'unknown', 'waiting']);
  assert.deepEqual(cells[4].input_ids, ['2', '3', '4']);
  assert.strictEqual(cells[1].message, messages[1]);
  assert.equal(cells[1].message.text, messages[1].text);
  assert.equal(JSON.stringify({ snapshot, database }), before);
});
