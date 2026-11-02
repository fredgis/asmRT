import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeRecordFields, conversationChapter } from '../public/console-view.mjs';

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
