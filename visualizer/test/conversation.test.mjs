// Exercises real Rust/MCP persistence and browser controls with an explicitly test-only HTTP model.
// Saved bytes, causal context and request gates distinguish recovery from fresh or sequential inference.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createVisualizer } from '../server.mjs';
import { describeConversation } from '../conversation-story.mjs';

const asmdbDir = process.env.ASMRT_ASMDB_REPO;
const enabled = { skip: !asmdbDir, timeout: 45000 };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('every new workflow crashes once at the claimed third task, never at the human gate', () => {
  for (const kind of ['graph', 'roles', 'approval', 'handoff', 'hybrid', 'loop']) {
    const state = { phase: 'paused', run: { workflow: `conversation.${kind}`, tasks: 5 },
      checkpoint: { stage: 'claimed', task_ids: ['3'] }, tasks: [{ id: '3', state: 'running', attempt: '1' }] };
    assert.equal(describeConversation(state).action, 'interrupt', kind);
    state.tasks[0].attempt = '2';
    assert.equal(describeConversation(state).action, 'next', `${kind} must not crash again after recovery`);
    if (kind === 'approval') {
      state.checkpoint.stage = 'approval';
      assert.equal(describeConversation(state).action, null, 'a human gate must remain blocked');
    }
  }
});

async function fixture(t, options = {}) {
  const requests = [];
  const replies = [];
  let tags = 0;
  let digest = 'a'.repeat(64);
  let available = true;
  let gate = null;
  let release = () => {};
  // This HTTP model exists only in tests. The application has no canned-response path.
  const model = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (!available) return send(503, { error: 'test-only endpoint deliberately unavailable' });
    if (request.url === '/api/tags' && request.method === 'GET') {
      tags++;
      return send(200, { models: [{ name: 'fixture-chat:tiny', digest }] });
    }
    if (request.url !== '/api/chat' || request.method !== 'POST') return send(404, {});
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const body = JSON.parse(raw.toString('utf8'));
    requests.push({ raw, body });
    const name = /^You are (\w+)\b/.exec(body.messages[0].content)?.[1] ?? 'Unknown';
    const text = options.reply?.(body) ?? `${name} test-only reply ${requests.length}: a unique idea-${requests.length} from the saved discussion.`;
    if (gate) await gate;
    replies.push(text);
    send(200, { model: 'fixture-chat:tiny', done: true, done_reason: 'stop',
      message: { role: 'assistant', content: text }, prompt_eval_count: 100 + requests.length, eval_count: 20 });
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const testRoot = path.resolve('.asmrt', 'backend-tests');
  await mkdir(testRoot, { recursive: true });
  const dataRoot = await mkdtemp(path.join(testRoot, 'conversation-'));
  const settings = { asmdbDir, binary: process.env.ASMRT_TEST_BINARY, dataRoot, port: 0, conversationModel: 'fixture-chat:tiny',
    ollamaUrl: `http://127.0.0.1:${model.address().port}`, storySceneMs: 180, ...options };
  let controller;
  t.after(async () => {
    release();
    if (controller) await controller.close();
    await new Promise((resolve, reject) => model.close(error => error ? reject(error) : resolve()));
    await rm(dataRoot, { recursive: true, force: true });
  });
  controller = await createVisualizer(settings);
  const state = async () => {
    const response = await fetch(`${controller.url}/api/state`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = async (action, body = {}) => {
    const snapshot = await state();
    return fetch(`${controller.url}/api/${action}`, { method: 'POST',
      headers: { Origin: controller.url, 'Content-Type': 'application/json', 'X-Asmrt-Token': snapshot.csrf_token },
      body: JSON.stringify(body) });
  };
  return {
    state, post, requests, replies,
    get url() { return controller.url; },
    get tags() { return tags; },
    set digest(value) { digest = value; },
    set available(value) { available = value; },
    get: route => fetch(`${controller.url}${route}`),
    hold() { gate = new Promise(resolve => { release = () => { gate = null; resolve(); }; }); },
    release: () => release(),
    async restart() { await controller.close(); controller = await createVisualizer(settings); },
  };
}

async function until(read, predicate, message) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const current = await read();
    if (predicate(current)) return current;
    if (current.phase === 'error') assert.fail(current.error);
    await delay(25);
  }
  assert.fail(message);
}

async function startPaused(f, body = { rounds: 1 }) {
  assert.equal((await f.post('conversation', body)).status, 202);
  const ready = await until(f.state, state => state.checkpoint?.stage === 'ready', 'no conversation checkpoint');
  assert.equal((await f.post('pause')).status, 202);
  return ready;
}

async function next(f, stage, id) {
  const previous = (await f.state()).checkpoint;
  assert(previous, 'a real checkpoint must exist');
  assert.equal((await f.post('next', { checkpoint: previous.id })).status, 202);
  return until(f.state, state => state.checkpoint?.id !== previous.id && state.checkpoint?.stage === stage
    && (!id || state.checkpoint.task_ids[0] === id), `did not reach ${stage} for turn ${id}`);
}

async function savedFiles(run, ids) {
  return Promise.all(ids.map(async id => {
    const filename = path.join(run.directory, 'artifacts', `${id}.json`);
    return { filename, bytes: await readFile(filename), modified: (await stat(filename)).mtimeMs };
  }));
}

async function assertPreserved(files) {
  for (const file of files) {
    assert.deepEqual(await readFile(file.filename), file.bytes);
    assert.equal((await stat(file.filename)).mtimeMs, file.modified);
  }
}

test('six workflow handlers persist distinct control semantics and replay without model access', { ...enabled, timeout: 120000 }, async t => {
  for (const [workflow, total, calls] of [['graph', 4, 3], ['roles', 5, 5], ['approval', 5, 1],
    ['handoff', 4, 3], ['hybrid', 9, 7], ['loop', 8, 4]]) {
    await t.test(workflow, async t => {
      const f = await fixture(t, { storySceneMs: 60000, reply: body => {
        const id = body.options.seed - 42;
        if (id === 1 && workflow === 'graph') return 'Use the direct path.\nROUTE=A';
        if (id === 1 && workflow === 'handoff') return 'This is a billing question.\nROUTE=BILLING';
        if ((workflow === 'hybrid' && id === 6) || (workflow === 'loop' && id === 4)) return 'The bounded local goal is satisfied.\nRESULT=DONE';
        return `Fixture specialist result for ${workflow} task ${id}.`;
      } });
      let state = await startPaused(f, { workflow: `conversation.${workflow}`, rounds: 2 });
      const catalog = await (await f.get('/api/workflows')).json();
      assert.equal(catalog.length, 8);
      assert.equal(state.conversation.turns_total, total);
      let crashed = false;
      while (state.phase !== 'finished') {
        const checkpoint = state.checkpoint;
        assert(checkpoint);
        if (checkpoint.stage === 'approval') {
          assert.equal((await f.post('next', { checkpoint: checkpoint.id })).status, 409);
          assert.equal((await f.post('play')).status, 202);
          await delay(250);
          assert.equal((await f.state()).checkpoint.id, checkpoint.id, 'autoplay must not approve');
          assert.equal((await f.post('pause')).status, 202);
          assert.equal((await f.post('action', { action: 'approve', checkpoint: checkpoint.id })).status, 202);
        } else if (!crashed && ['graph', 'approval'].includes(workflow) && checkpoint.stage === 'published' && checkpoint.task_ids[0] === '2') {
          const files = await savedFiles(state.run, checkpoint.task_ids);
          const before = f.requests.length;
          assert.equal((await f.post('interrupt')).status, 202);
          await f.restart();
          assert.equal((await f.post('resume')).status, 202);
          state = await until(f.state, s => s.checkpoint?.stage === 'ready', 'no reopened workflow');
          assert.equal((await f.post('action', { action: 'reject', checkpoint: checkpoint.id })).status, 409);
          await assertPreserved(files);
          assert.equal(f.requests.length, before);
          crashed = true;
          continue;
        } else {
          assert.equal((await f.post('next', { checkpoint: checkpoint.id })).status, 202);
        }
        state = await until(f.state, s => s.phase === 'finished' || (s.checkpoint && s.checkpoint.id !== checkpoint.id), 'workflow did not advance');
      }
      assert.equal(state.summary.completed, total);
      assert.equal(f.requests.length, calls);
      const messages = state.conversation.messages;
      if (workflow === 'graph' || workflow === 'handoff') {
        assert.equal(messages[1].control.skipped, false);
        assert.equal(messages[2].control.skipped, true);
        assert.equal(messages[1].control.fallback, false);
      }
      if (workflow === 'approval') assert.equal(messages[1].control.value, 'approved');
      if (workflow === 'loop') {
        assert.match(messages[2].text, /Local inspect_context tool/);
        assert.equal(messages[4].control.skipped, true);
      }
      if (workflow === 'hybrid') assert.equal(messages[6].control.skipped, true);
      const originals = await savedFiles(state.run, messages.map(message => message.task_id));
      f.available = false;
      const tags = f.tags;
      assert.equal((await f.post('resume')).status, 202);
      state = await until(f.state, s => s.phase === 'finished', 'offline replay did not finish');
      assert.equal(state.summary.model_calls_now, 0);
      assert.equal(state.summary.completed_now, 0);
      assert.equal(f.tags, tags);
      await assertPreserved(originals);
    });
  }
});

test('human rejection durably suppresses every local action and malformed routes use a conservative fallback', enabled, async t => {
  for (const workflow of ['approval', 'graph']) {
    await t.test(workflow, async t => {
      const f = await fixture(t, { storySceneMs: 60000, reply: () => 'Ambiguous prose, not a control line.' });
      let state = await startPaused(f, { workflow: `conversation.${workflow}`, rounds: 1 });
      while (state.phase !== 'finished') {
        const checkpoint = state.checkpoint;
        const response = checkpoint.stage === 'approval'
          ? await f.post('action', { action: 'reject', checkpoint: checkpoint.id })
          : await f.post('next', { checkpoint: checkpoint.id });
        assert.equal(response.status, 202);
        state = await until(f.state, s => s.phase === 'finished' || (s.checkpoint && s.checkpoint.id !== checkpoint.id), 'workflow did not advance');
      }
      if (workflow === 'approval') {
        assert.equal(f.requests.length, 1);
        assert.equal(state.conversation.messages[1].control.value, 'rejected');
        assert(state.conversation.messages.slice(2).every(message => message.control.skipped));
      } else {
        assert.equal(f.requests.length, 3);
        assert.equal(state.conversation.messages[1].control.value, 'B');
        assert.equal(state.conversation.messages[1].control.fallback, true);
        assert.equal(state.conversation.messages[1].control.skipped, true);
        assert.equal(state.conversation.messages[2].control.skipped, false);
      }
    });
  }
});

test('a real Rust conversation preserves causal messages through automatic crash, recovery and an offline zero-call replay', enabled, async t => {
  const f = await fixture(t);
  assert.equal((await f.post('conversation', { topic: 'Agree on one inexpensive neighborhood science activity.' })).status, 202);
  const scenes = new Map();
  const pids = new Set();
  let originals;
  let requestsBeforeReplay;
  let tagsBeforeReplay;
  const finished = await until(async () => {
    const state = await f.state();
    if (state.pid) pids.add(state.pid);
    if (state.playback && !state.playback.transitioning) scenes.set(state.playback.scene.id, state);
    if (!originals && state.playback?.scene.id === 'chat-crash-next') {
      assert.equal(f.requests.length, 4, 'the fifth inference must not start before the planned crash');
      originals = await savedFiles(state.run, ['1', '2', '3', '4']);
    }
    if (requestsBeforeReplay === undefined && state.playback?.scene.id === 'chat-completed') {
      requestsBeforeReplay = f.requests.length;
      tagsBeforeReplay = f.tags;
      f.available = false;
    }
    return state;
  }, state => state.playback?.status === 'finished', 'automatic conversation did not finish');
  assert.equal(finished.playback.scene.id, 'chat-verified');
  for (const scene of ['chat-ready', 'chat-assigned', 'chat-saved', 'chat-committed', 'chat-crash-next', 'chat-crashed', 'chat-recovered', 'chat-completed']) {
    assert(scenes.has(scene), `missing real scene: ${scene}`);
  }
  assert(pids.size >= 2, 'recovery uses a new actual process');
  const crashed = scenes.get('chat-crashed');
  assert.equal(crashed.pid, null);
  assert.equal(crashed.conversation.messages.length, 4);
  assert.equal(crashed.conversation.active, null);
  assert.equal(crashed.tasks.filter(task => task.state === 'running').length, 1);
  assert.equal(scenes.get('chat-recovered').conversation.messages.length, 4);
  assert.notEqual(crashed.database.launch_id, scenes.get('chat-recovered').database.launch_id);
  assert.equal(finished.summary.completed, 8);
  assert.equal(finished.summary.completed_now, 0);
  assert.equal(finished.summary.model_calls_now, 0);
  assert.equal(finished.summary.retried, 1);
  assert.equal(finished.tasks.find(task => task.id === '5').attempt, '2');
  assert(finished.tasks.filter(task => task.id !== '5').every(task => task.attempt === '1'));
  assert.equal(f.requests.length, 8);
  assert.equal(f.requests.length, requestsBeforeReplay);
  assert.equal(f.tags, tagsBeforeReplay, 'completed replay must not even query Ollama tags');
  assert.equal(new Set(f.requests.map(request => request.body.messages[0].content)).size, 4);
  await assertPreserved(originals);
  const hashes = [];
  for (let index = 0; index < 8; index++) {
    const id = String(index + 1);
    const task = finished.tasks.find(task => task.id === id);
    assert.equal(task.record.tag, 'asmrt.v2.completed');
    const fields = JSON.parse(task.record.content);
    assert.equal(fields.d, `job:${id}`);
    assert(Buffer.byteLength(task.record.content) <= 175);
    const response = await f.get(`/api/definitions/${id}`);
    assert.equal(response.status, 200);
    const descriptor = await response.json();
    const bytes = await readFile(path.join(finished.run.directory, 'definitions', `${id}.json`));
    assert.equal(descriptor.sha256, sha256(bytes));
    assert.equal(descriptor.sha256, fields.h);
    assert.equal(descriptor.content.kind, 'llm.chat.turn');
    assert.equal(descriptor.content.version, 3);
    assert.deepEqual(descriptor.content.input_ids, Array.from({ length: index }, (_, i) => String(i + 1)));
    const artifact = await f.get(`/api/artifacts/${id}`);
    assert.equal(artifact.status, 200);
    const replyBytes = Buffer.from(await artifact.arrayBuffer());
    const reply = JSON.parse(replyBytes.toString('utf8'));
    assert.equal(sha256(replyBytes), fields.r);
    assert.equal(reply.request_sha256, sha256(f.requests[index].raw));
    assert.deepEqual(reply.input_sha256, hashes);
    assert.equal(reply.text, f.replies[index]);
    const messages = f.requests[index].body.messages;
    assert.equal(messages.length, index + 3);
    for (const [prior, previous] of f.replies.slice(0, index).entries()) {
      const fromSelf = prior % 4 === index % 4;
      assert.equal(messages[prior + 2].role, fromSelf ? 'assistant' : 'user');
      assert.equal(messages[prior + 2].content, fromSelf ? previous : `${finished.conversation.agents[prior % 4].name} says: ${previous}`);
    }
    assert(messages.at(-1).content.includes(descriptor.content.instruction));
    assert.equal(messages[0].content, descriptor.content.agent.prompt);
    assert.equal(finished.conversation.messages[index].text, reply.text);
    assert.equal(finished.conversation.messages[index].committed, true);
    hashes.push(sha256(replyBytes));
  }

  const filename = path.join(finished.run.directory, 'artifacts', '1.json');
  const changed = JSON.parse(await readFile(filename, 'utf8'));
  changed.text += ' Modified after commit.';
  changed.text_sha256 = sha256(changed.text);
  await writeFile(filename, JSON.stringify(changed));
  assert.equal((await f.get('/api/artifacts/1')).status, 409);
  assert.equal((await f.post('resume')).status, 202);
  const rejected = await until(f.state, state => state.phase === 'error', 'changed committed reply was accepted');
  assert.match(rejected.error, /SHA-256 differs from its asmDB commitment/);
  assert.equal(f.requests.length, 8);
});

test('a saved but uncommitted reply survives a controller restart without a second model request', enabled, async t => {
  const f = await fixture(t, { storySceneMs: 60000 });
  const initial = await startPaused(f);
  await next(f, 'claimed', '1');
  const published = await next(f, 'published', '1');
  assert.equal(published.conversation.messages[0].committed, false);
  assert.equal(published.conversation.active.stage, 'saved');
  assert.equal(published.tasks[0].record.tag, 'asmrt.v2.running');
  const original = await savedFiles(published.run, ['1']);
  assert.equal((await f.post('interrupt')).status, 202);
  await f.restart();
  const unloaded = await f.state();
  assert.equal(unloaded.run.id, initial.run.id);
  assert.equal(unloaded.run.kind, 'conversation');
  assert.equal(unloaded.conversation, null);
  assert.equal(unloaded.database, null);
  assert.equal(unloaded.pid, null);
  assert.equal(unloaded.playback.status, 'paused');
  assert.equal((await f.post('resume')).status, 202);
  const reopened = await until(f.state, state => state.checkpoint?.stage === 'ready', 'saved conversation did not reopen');
  assert.equal(reopened.conversation.messages.length, 0, 'an uncommitted file is not a completed input yet');
  assert.equal((await f.post('next', { checkpoint: initial.checkpoint.id })).status, 409);
  await next(f, 'claimed', '1');
  const reused = await next(f, 'published', '1');
  assert.equal(reused.tasks[0].attempt, '2');
  assert.equal(reused.conversation.messages[0].reused, true);
  assert.equal(reused.conversation.messages[0].text, published.conversation.messages[0].text);
  assert.equal(f.requests.length, 1);
  await assertPreserved(original);
  const committed = await next(f, 'completed', '1');
  assert.equal(committed.conversation.messages[0].committed, true);
});

test('reset forgets a paused conversation without deleting saved work, and Start creates an empty new run', enabled, async t => {
  const f = await fixture(t, { storySceneMs: 60000 });
  const idle = await f.state();
  await startPaused(f);
  await next(f, 'claimed', '1');
  await next(f, 'published', '1');
  await next(f, 'completed', '1');
  await next(f, 'claimed', '2');
  const saved = await next(f, 'published', '2');
  assert.deepEqual(saved.conversation.messages.map(message => message.committed), [true, false]);
  const originals = await savedFiles(saved.run, ['1', '2']);
  for (const relative of ['conversation.json', ...saved.tasks.map(task => path.join('definitions', `${task.id}.json`))]) {
    const filename = path.join(saved.run.directory, relative);
    originals.push({ filename, bytes: await readFile(filename), modified: (await stat(filename)).mtimeMs });
  }
  const entries = await readdir(saved.run.directory);
  const calls = f.requests.length;
  const tags = f.tags;
  const response = await f.post('reset');
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), idle, 'reset returns the fresh idle snapshot, retaining source and CSRF capabilities');
  assert.throws(() => process.kill(saved.pid, 0), { code: 'ESRCH' }, 'reset must wait for its Rust process to exit');
  assert.deepEqual(await f.state(), idle);
  assert.equal(f.requests.length, calls, 'reset must not generate another reply');
  assert.equal(f.tags, tags, 'reset must not open a model or a conversation');
  assert.deepEqual(await readdir(saved.run.directory), entries);
  await assertPreserved(originals);
  assert.equal((await f.get('/api/artifacts/1')).status, 404);
  assert.equal((await f.get('/api/definitions/1')).status, 404);
  assert.equal((await f.post('next', { checkpoint: saved.checkpoint.id })).status, 409);
  assert.equal((await f.post('resume')).status, 409);
  await f.restart();
  const restarted = await f.state();
  assert.deepEqual(restarted, { ...idle, csrf_token: restarted.csrf_token }, 'reset must also forget the selected run across controller restarts');
  const fresh = await startPaused(f, { topic: 'Choose a completely new conversation topic.', rounds: 1 });
  assert.notEqual(fresh.run.id, saved.run.id);
  assert.notEqual(fresh.run.directory, saved.run.directory);
  assert.deepEqual(fresh.conversation.messages, []);
  assert(fresh.tasks.every(task => task.state === 'pending' && task.attempt === '0'));
  assert(fresh.database.response.rows.every(row => row.tag === 'asmrt.v2.pending'));
  assert.equal(f.requests.length, calls);
  await next(f, 'claimed', '1');
  const published = await next(f, 'published', '1');
  assert.equal(published.conversation.messages.length, 1);
  assert.equal(f.requests.at(-1).body.messages.length, 3, 'the first new model request has no old replies in its context');
  assert.deepEqual(await readdir(saved.run.directory), entries);
  await assertPreserved(originals);
});

test('reset stops an in-flight conversation and late model replies cannot restore the old state', enabled, async t => {
  const f = await fixture(t, { storySceneMs: 220 });
  const idle = await f.state();
  f.hold();
  assert.equal((await f.post('conversation', { rounds: 1 })).status, 202);
  const generating = await until(f.state, state => state.conversation?.active?.stage === 'generating' && f.requests.length === 1,
    'no real in-flight model request observed');
  const tags = f.tags;
  const response = await f.post('reset');
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), idle);
  assert.throws(() => process.kill(generating.pid, 0), { code: 'ESRCH' });
  f.release();
  await delay(600);
  assert.equal(f.replies.length, 1, 'the test model released its late response');
  assert.equal(f.requests.length, 1, 'reset must not open another inference');
  assert.equal(f.tags, tags);
  assert.deepEqual(await f.state(), idle, 'late replies and old playback callbacks must not revive the discarded run');
  await assert.rejects(readFile(path.join(generating.run.directory, 'artifacts', '1.json')), { code: 'ENOENT' });
});

test('pausing a genuine in-flight model request finishes only at its saved-reply checkpoint', enabled, async t => {
  const f = await fixture(t, { storySceneMs: 220 });
  f.hold();
  assert.equal((await f.post('conversation', { rounds: 1 })).status, 202);
  const generating = await until(f.state, state => state.conversation?.active?.stage === 'generating', 'no real inference observed');
  assert.equal((await f.post('pause')).status, 202);
  await delay(450);
  const paused = await f.state();
  assert.equal(paused.pid, generating.pid);
  assert.equal(paused.phase, 'running');
  assert.equal(paused.playback.status, 'paused');
  assert.equal(paused.conversation.messages.length, 0);
  assert.equal(f.requests.length, 1);
  f.release();
  const saved = await until(f.state, state => state.checkpoint?.stage === 'published', 'inference did not finish at a safe checkpoint');
  await delay(450);
  assert.equal((await f.state()).checkpoint.id, saved.checkpoint.id);
  assert.equal(saved.conversation.messages[0].committed, false);
  assert.equal(saved.playback.status, 'paused');
});

// A held HTTP response cannot hide sequential execution: all siblings must arrive before release.
test('discussion fans out concurrent requests, preserves wave context and replays offline', enabled, async t => {
  const f = await fixture(t, { storySceneMs: 60000 });
  const ready = await startPaused(f, { rounds: 2, workflow: 'conversation.discussion' });
  assert.equal(ready.run.workflow, 'conversation.discussion');
  assert.deepEqual(ready.conversation.workflow, { kind: 'conversation.discussion', version: 1 });
  await next(f, 'claimed', '1');
  await next(f, 'published', '1');
  await next(f, 'completed', '1');
  const claimed = await next(f, 'claimed', '2');
  assert.deepEqual(claimed.checkpoint.task_ids, ['2', '3', '4']);
  f.hold();
  assert.equal((await f.post('next', { checkpoint: claimed.checkpoint.id })).status, 202);
  const concurrent = await until(f.state, state => f.requests.length === 4
    && state.conversation.active_turns.length === 3
    && state.conversation.active_turns.every(turn => turn.stage === 'generating'), 'three sibling requests did not overlap');
  assert.deepEqual(concurrent.conversation.active_turns.map(turn => turn.agent_id), ['builder', 'critic', 'editor']);
  assert(concurrent.conversation.active_turns.every(turn => JSON.stringify(turn.input_ids) === '["1"]'));
  assert.equal(concurrent.conversation.messages.length, 1, 'no sibling reply exists before the gate opens');
  const inputs = f.requests.slice(1).map(request => request.body.messages.slice(1, -1));
  assert.deepEqual(inputs[0], inputs[1]);
  assert.deepEqual(inputs[1], inputs[2]);
  f.release();
  const published = await until(f.state, state => state.checkpoint?.stage === 'published', 'debate replies were not published');
  assert.deepEqual(published.conversation.messages.map(message => message.task_id), ['1', '2', '3', '4']);
  assert(published.conversation.active_turns.every(turn => turn.stage === 'saved'));
  const originals = await savedFiles(published.run, ['1', '2', '3', '4']);

  // Reopen between publication and commitment; all three saved replies must be reused offline.
  assert.equal((await f.post('interrupt')).status, 202);
  await f.restart();
  assert.equal((await f.state()).run.workflow, 'conversation.discussion');
  const tagsBeforeReuse = f.tags;
  f.available = false;
  assert.equal((await f.post('resume')).status, 202);
  const recovered = await until(f.state, state => state.checkpoint?.stage === 'ready', 'discussion did not reopen');
  assert.equal(recovered.run.id, ready.run.id);
  assert.deepEqual(recovered.conversation.messages.map(message => message.task_id), ['1']);
  assert.deepEqual(recovered.conversation.active_turns, []);
  await next(f, 'claimed', '2');
  const reused = await next(f, 'published', '2');
  assert(reused.conversation.messages.filter(message => ['2', '3', '4'].includes(message.task_id)).every(message => message.reused));
  assert.equal(f.requests.length, 4);
  assert.equal(f.tags, tagsBeforeReuse);
  await next(f, 'completed', '2');
  await assertPreserved(originals);

  // The teaching crash affects a whole later wave and must not repeat after recovery.
  f.available = true;
  const secondWave = await next(f, 'claimed', '5');
  assert.equal(secondWave.playback.scene.id, 'chat-crash-next');
  assert.deepEqual(secondWave.checkpoint.task_ids, ['5', '6', '7']);
  assert.equal((await f.post('interrupt')).status, 202);
  assert.equal((await f.post('resume')).status, 202);
  await until(f.state, state => state.checkpoint?.stage === 'ready', 'second wave did not recover');
  const retry = await next(f, 'claimed', '5');
  assert.equal(retry.playback.scene.id, 'chat-assigned');
  assert(retry.tasks.filter(task => ['5', '6', '7'].includes(task.id)).every(task => task.attempt === '2'));
  const debated = await next(f, 'published', '5');
  for (const message of debated.conversation.messages.filter(message => Number(message.task_id) >= 5)) {
    assert.deepEqual(message.input_ids, ['1', '2', '3', '4']);
  }
  for (const request of f.requests.slice(4, 7)) {
    for (const previous of debated.conversation.messages.slice(0, 4)) {
      assert(request.body.messages.some(message => message.content.includes(previous.text)), 'later peers must see every prior committed view');
    }
  }
  await next(f, 'completed', '5');
  const synthesis = await next(f, 'claimed', '8');
  assert.deepEqual(synthesis.conversation.active_turns.map(turn => turn.agent_id), ['editor']);
  assert.deepEqual(synthesis.conversation.active.input_ids, ['1', '2', '3', '4', '5', '6', '7']);
  const result = await next(f, 'published', '8');
  assert.match(f.requests.at(-1).body.messages.at(-1).content, /final|decision|synthes/i);
  assert.equal((await f.post('next', { checkpoint: result.checkpoint.id })).status, 202);
  const finished = await until(f.state, state => state.phase === 'finished', 'discussion did not finish');
  assert.equal(finished.summary.completed, 8);
  assert.equal(f.requests.length, 8);
  assert.deepEqual(finished.conversation.active_turns, []);
  const allReplies = await savedFiles(finished.run, ['1', '2', '3', '4', '5', '6', '7', '8']);
  const tagsBeforeReplay = f.tags;
  f.available = false;
  assert.equal((await f.post('resume')).status, 202);
  const verified = await until(f.state, state => state.phase === 'finished', 'offline replay did not finish');
  assert.equal(verified.summary.completed_now, 0);
  assert.equal(verified.summary.model_calls_now, 0);
  assert.equal(f.requests.length, 8);
  assert.equal(f.tags, tagsBeforeReplay);
  await assertPreserved(allReplies);
});

for (const mutation of ['modified job', 'missing job', 'missing plan', 'unsupported handler']) {
  test(`${mutation} is rejected before inference instead of guessing the work from its status`, enabled, async t => {
    const f = await fixture(t, { storySceneMs: 60000 });
    const ready = await startPaused(f);
    assert.equal((await f.get('/api/definitions/2')).status, 200);
    assert.equal((await f.post('interrupt')).status, 202);
    const filename = path.join(ready.run.directory, 'definitions', '2.json');
    if (mutation === 'modified job') {
      const job = JSON.parse(await readFile(filename, 'utf8'));
      job.instruction = 'A changed task must not execute.';
      await writeFile(filename, JSON.stringify(job));
      assert.equal((await f.get('/api/definitions/2')).status, 409);
    } else if (mutation === 'missing job') {
      await rm(filename);
      assert.equal((await f.get('/api/definitions/2')).status, 404);
    } else if (mutation === 'missing plan') {
      await rm(path.join(ready.run.directory, 'conversation.json'));
    } else {
      const planPath = path.join(ready.run.directory, 'conversation.json');
      const plan = JSON.parse(await readFile(planPath, 'utf8'));
      plan.turns[0].version = 999;
      await writeFile(planPath, JSON.stringify(plan));
    }
    assert.equal((await f.post('resume')).status, 202);
    const rejected = await until(f.state, state => state.phase === 'error', 'invalid saved work was accepted');
    assert.match(rejected.error, /modified|definition is missing|refusing to guess|unsupported task handler/);
    assert.equal(f.requests.length, 0);
  });
}

test('a changed installed model digest cannot silently replace the saved model', enabled, async t => {
  const f = await fixture(t, { storySceneMs: 60000 });
  await startPaused(f);
  await next(f, 'claimed', '1');
  f.digest = 'b'.repeat(64);
  const checkpoint = (await f.state()).checkpoint;
  assert.equal((await f.post('next', { checkpoint: checkpoint.id })).status, 202);
  const rejected = await until(f.state, state => state.phase === 'error', 'model drift was accepted');
  assert.match(rejected.error, /installed model digest changed/);
  assert.equal(rejected.conversation.active, null);
  assert.equal(f.requests.length, 0);
});

test('conversation commands preserve local authorization, validate topics and treat hyphenated topics as data', enabled, async t => {
  const f = await fixture(t, { storySceneMs: 60000 });
  const unauthorized = await fetch(`${f.url}/api/conversation`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: '{}' });
  assert.equal(unauthorized.status, 403);
  for (const body of [null, [], { topic: '' }, { topic: 'x'.repeat(401) }, { topic: 'bad\0topic' }, { rounds: 0 }, { rounds: 4 }, { workflow: null }, { workflow: 'parallel' }, { workflow: { kind: 'conversation.discussion' } }, { model: 'remote' }, { ollama_url: 'https://example.com' }]) {
    assert.equal((await f.post('conversation', body)).status, 400);
  }
  assert.equal((await f.get('/api/definitions/1')).status, 404);
  assert.equal((await f.state()).pid, null);
  assert.equal(f.tags, 0);
  const ready = await startPaused(f, { topic: '--this-is-a-topic-not-an-option', rounds: 1 });
  assert.equal(ready.conversation.topic, '--this-is-a-topic-not-an-option');
  assert.equal((await f.post('conversation', { topic: 'Do not interrupt this run.' })).status, 409);
  assert.equal((await f.post('storage')).status, 409);
  assert.equal((await f.state()).run.id, ready.run.id);
  assert.equal((await f.post('interrupt')).status, 202);
  assert.equal((await f.post('storage')).status, 202);
  const storage = await until(f.state, state => state.checkpoint?.stage === 'ready', 'old storage story is unreachable');
  assert.equal(storage.run.kind, 'demo');
  assert.equal(storage.run.story, true);
  assert.equal(storage.conversation, null);
  assert(storage.database.response.rows.every(row => row.tag === 'asmrt.v1.pending'));
});
