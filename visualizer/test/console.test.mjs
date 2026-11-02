import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeRecordFields, conversationChapter, conversationMemory } from '../public/console-view.mjs';

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
