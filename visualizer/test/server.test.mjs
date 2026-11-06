// +--------------------------------------------------------------------+
// | asmRT :: server.test.mjs -- local controller lifecycle checks        |
// +--------------------------------------------------------------------+
// Exercises process ownership, checkpoint pacing and browser commands.
// Fixtures own isolated run directories and close their writers before
// cleanup; no test should borrow the active user demo's storage.
import assert from 'node:assert/strict';
import { ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createVisualizer, validateTaskEvent } from '../server.mjs';

const asmdbDir = process.env.ASMRT_ASMDB_REPO;

function taskEvent(name, attempt, owner = 'worker-1', artifact = null, definition = null) {
  const state = name === 'task_claimed' ? 'running' : 'completed';
  const content = { o: owner, ...(artifact ? { r: artifact } : {}),
    ...(definition ? { d: definition.reference, h: definition.sha256 } : {}) };
  return { event: name, task_id: '1', owner, attempt, artifact,
    task: { id: '1', state, owner, attempt, artifact, definition,
      record: { id: '1', value: attempt, tag: `asmrt.v${definition ? 2 : 1}.${state}`, content: JSON.stringify(content) } } };
}

test('task events reject stale claims, forged completions and divergent native fields', () => {
  const pending = { ...taskEvent('task_claimed', '0').task, state: 'pending', owner: null, artifact: null };
  const claim = taskEvent('task_claimed', '1');
  assert.doesNotThrow(() => validateTaskEvent(claim, pending));
  for (const mutate of [
    e => { e.task.state = 'completed'; },
    e => { e.attempt = e.task.attempt = e.task.record.value = '0'; },
    e => { e.owner = 'other'; },
    e => { e.task.record.content = '{"o":"other"}'; },
    e => { e.task.record.tag = 'asmrt.v1.pending'; },
    e => { e.task.record.id = '2'; },
    e => { e.task.record.value = '2'; },
    e => { e.task.definition = { reference: 'job:1', sha256: 'a'.repeat(64) }; },
  ]) {
    const bad = structuredClone(claim);
    mutate(bad);
    assert.throws(() => validateTaskEvent(bad, pending), /task|claim|record|transition/i);
  }
  const published = { ...claim.task, published: true, published_sha256: 'artifact:1' };
  const completion = taskEvent('task_completed', '1', 'worker-1', 'artifact:1');
  assert.doesNotThrow(() => validateTaskEvent(completion, published));
  for (const previous of [pending, claim.task, completion.task]) {
    assert.throws(() => validateTaskEvent(completion, previous), /task|claim|record|transition/i);
  }
  assert.throws(() => validateTaskEvent(taskEvent('task_completed', '2', 'worker-1', 'artifact:1'), published), /task|claim|record|transition/i);
  assert.throws(() => validateTaskEvent(taskEvent('task_completed', '1', 'worker-2', 'artifact:1'), published), /task|claim|record|transition/i);
  assert.throws(() => validateTaskEvent(taskEvent('task_completed', '1', 'worker-1', 'artifact:2'), published), /task|claim|record|transition/i);
  const definition = { reference: 'job:1', sha256: 'a'.repeat(64) };
  const typed = taskEvent('task_claimed', '9007199254740993', 'planner', null, definition);
  const previous = { ...typed.task, state: 'pending', attempt: '9007199254740992', owner: null };
  assert.doesNotThrow(() => validateTaskEvent(typed, previous), 'attempts retain full integer precision');
});

async function fixture(t, options = {}) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'asmrt-visual-test-'));
  const settings = { asmdbDir, binary: process.env.ASMRT_TEST_BINARY, dataRoot, port: 0, ...options };
  let server = await createVisualizer(settings);
  t.after(async () => {
    await server.close();
    await rm(dataRoot, { recursive: true, force: true });
  });
  const state = async () => {
    const response = await fetch(`${server.url}/api/state`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = async (action, body = {}) => {
    const snapshot = await state();
    return fetch(`${server.url}/api/${action}`, {
      method: 'POST',
      headers: { Origin: server.url, 'Content-Type': 'application/json', 'X-Asmrt-Token': snapshot.csrf_token },
      body: JSON.stringify(body),
    });
  };
  return {
    server, dataRoot, state, post,
    async restart() {
      await server.close();
      server = await createVisualizer(settings);
    },
  };
}

async function until(read, predicate, message) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await read();
    if (state.phase === 'error') assert.fail(state.error);
    if (predicate(state)) return state;
    await delay(50);
  }
  assert.fail(message);
}

test('one controller owns a data root until close, without affecting independent roots', { skip: !asmdbDir }, async t => {
  const { server, dataRoot, state, post } = await fixture(t);
  await assert.rejects(async () => {
    const second = await createVisualizer({ asmdbDir, binary: process.env.ASMRT_TEST_BINARY, dataRoot, port: 0 });
    await second.close();
  }, /already owned|locked/i);
  const independent = await fixture(t);
  assert.equal((await independent.state()).phase, 'idle');
  assert.equal((await post('run', { tasks: 1, work_ms: 0 })).status, 202);
  await until(state, s => s.phase === 'finished', 'first controller lost ownership');
  const saved = await readFile(path.join(dataRoot, 'latest.json'), 'utf8');
  await server.close();
  const replacement = await createVisualizer({ asmdbDir, binary: process.env.ASMRT_TEST_BINARY, dataRoot, port: 0 });
  try {
    assert.equal((await (await fetch(`${replacement.url}/api/state`)).json()).phase, 'interrupted');
    assert.equal(await readFile(path.join(dataRoot, 'latest.json'), 'utf8'), saved);
  } finally { await replacement.close(); }
});

test('controller startup failure releases ownership and serves the compiled release identity', { skip: !asmdbDir }, async t => {
  const occupied = await fixture(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'asmrt-lock-startup-'));
  const options = { asmdbDir, binary: process.env.ASMRT_TEST_BINARY, dataRoot: directory };
  try {
    await assert.rejects(createVisualizer({ ...options, port: Number(new URL(occupied.server.url).port) }), { code: 'EADDRINUSE' });
    const retry = await createVisualizer({ ...options, port: 0 });
    try {
      const state = await (await fetch(`${retry.url}/api/state`)).json();
      const version = (await readFile(new URL('../../VERSION', import.meta.url), 'utf8')).trim();
      assert.deepEqual(state.version, { console: version, runtime: version });
      const html = await (await fetch(retry.url)).text();
      assert(html.includes(`<span id="release-version">asmRT ${version}</span>`));
      assert(!html.includes('Version unavailable'));
    } finally { await retry.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('loss of controller ownership stops its worker and rejects subsequent commands', { skip: !asmdbDir }, async t => {
  const spawn = ChildProcess.prototype.spawn;
  let holder;
  const observe = t.mock.method(ChildProcess.prototype, 'spawn', function(options) {
    const result = spawn.call(this, options);
    if (options.args.includes('controller-lock')) holder = this;
    return result;
  });
  const { state, post } = await fixture(t);
  observe.mock.restore();
  assert(holder);
  assert.equal((await post('run', { tasks: 4, work_ms: 5000 })).status, 202);
  const running = await until(state, s => s.tasks.some(task => task.state === 'running'), 'worker did not claim a task');
  holder.kill('SIGKILL');
  let stopped;
  for (let attempt = 0; attempt < 100; attempt++) {
    stopped = await state();
    if (stopped.phase === 'error') break;
    await delay(50);
  }
  assert.equal(stopped.phase, 'error');
  assert.match(stopped.error, /ownership lost/i);
  assert.equal(stopped.pid, null);
  assert.throws(() => process.kill(running.pid, 0), { code: 'ESRCH' });
  assert.equal((await post('reset')).status, 409);
});

test('a malformed native claim cannot change the HTTP task snapshot', { skip: !asmdbDir }, async t => {
  const { state, post } = await fixture(t);
  const spawn = ChildProcess.prototype.spawn;
  let injected = false;
  t.mock.method(ChildProcess.prototype, 'spawn', function(options) {
    const result = spawn.call(this, options);
    if (!options.args.includes('demo')) return result;
    const emit = this.stdout.emit;
    let buffered = '';
    t.mock.method(this.stdout, 'emit', function(name, ...args) {
      if (name !== 'data') return emit.call(this, name, ...args);
      buffered += args[0];
      let end;
      while ((end = buffered.indexOf('\n')) !== -1) {
        const event = JSON.parse(buffered.slice(0, end));
        buffered = buffered.slice(end + 1);
        if (!injected && event.event === 'task_claimed') {
          const valid = JSON.stringify(event);
          event.task.record.content = '{"o":"forged"}';
          injected = true;
          emit.call(this, 'data', `${JSON.stringify(event)}\n`);
          emit.call(this, 'data', `${valid}\n`);
          continue;
        }
        emit.call(this, 'data', `${JSON.stringify(event)}\n`);
      }
      return true;
    });
    return result;
  });
  assert.equal((await post('run', { tasks: 1, work_ms: 5000 })).status, 202);
  let rejected;
  for (let attempt = 0; attempt < 100; attempt++) {
    rejected = await state();
    if (rejected.phase === 'error') break;
    await delay(50);
  }
  assert(injected);
  assert.equal(rejected.phase, 'error');
  assert.match(rejected.error, /record payload disagrees/i);
  assert.equal(rejected.tasks[0].state, 'pending');
  assert.equal(rejected.tasks[0].attempt, '0');
  assert.equal(rejected.tasks[0].record.content, '{}');
});

test('one Play command times a real crash, rereads asmDB, recovers only unfinished work and verifies zero-work replay', { skip: !asmdbDir }, async t => {
  const { state, post } = await fixture(t, { storySceneMs: 180 });
  assert.equal((await post('play')).status, 202);
  const scenes = new Map();
  const pids = new Set();
  const finished = await until(async () => {
    const current = await state();
    if (current.pid) pids.add(current.pid);
    if (current.playback && !current.playback.transitioning) scenes.set(current.playback.scene.id, current);
    return current;
  }, s => s.playback?.status === 'finished', 'the one-click story did not finish');
  assert.deepEqual([...scenes.keys()], ['queued', 'assigned', 'published', 'committed', 'crash-next', 'crashed', 'recovered', 'retrying', 'recovered-files', 'completed', 'verified']);
  const queued = scenes.get('queued');
  assert.equal(queued.database.response.rows.length, 8);
  assert(queued.database.response.rows.every(row => row.tag === 'asmrt.v1.pending' && row.value === '0'));
  assert.deepEqual(queued.database.commands, ['PAGE 1000 0', 'SELECT *']);
  const published = scenes.get('published');
  assert.equal(published.tasks.filter(task => task.published).length, 4);
  assert.equal(published.database.response.rows.filter(row => row.tag === 'asmrt.v1.completed').length, 0);
  const crashed = scenes.get('crashed');
  assert.equal(crashed.phase, 'interrupted');
  assert.equal(crashed.pid, null);
  assert.equal(crashed.database.response.rows.filter(row => row.tag === 'asmrt.v1.running').length, 4);
  const recovered = scenes.get('recovered');
  assert.equal(recovered.database.response.rows.filter(row => row.tag === 'asmrt.v1.pending').length, 4);
  assert.equal(recovered.database.response.rows.filter(row => row.tag === 'asmrt.v1.completed').length, 4);
  assert.notEqual(recovered.database.launch_id, crashed.database.launch_id);
  assert.match(scenes.get('retrying').playback.scene.description, /\b4 completed records\b/);
  assert.match(scenes.get('recovered-files').playback.scene.description, /\b4 completed records\b/);
  assert(pids.size >= 2, 'recovery must use a new real process');
  const preserved = recovered.tasks.filter(task => task.state === 'completed').map(task => task.id);
  assert(finished.tasks.filter(task => preserved.includes(task.id)).every(task => task.attempt === '1'));
  assert(finished.tasks.filter(task => !preserved.includes(task.id)).every(task => task.attempt === '2'));
  assert.equal(scenes.get('completed').summary.completed_now, 4);
  assert.equal(finished.summary.completed_now, 0);
  assert.equal(finished.summary.completed, 8);
  assert.equal(finished.summary.retried, 4);
  assert.equal(finished.run.id, queued.run.id);
  assert.notEqual(finished.database.launch_id, recovered.database.launch_id);
  assert(finished.database.response.rows.every(row => row.tag === 'asmrt.v1.completed'));
});

test('pausing freezes the cue, holds an in-flight operation at its next checkpoint, and old cues cannot affect a new run', { skip: !asmdbDir }, async t => {
  const { state, post } = await fixture(t, { storySceneMs: 450 });
  assert.equal((await post('play')).status, 202);
  await until(state, s => s.phase === 'paused' && s.checkpoint.stage === 'ready', 'no initial checkpoint');
  assert.equal((await post('pause')).status, 202);
  const paused = await state();
  await delay(750);
  const reread = await state();
  assert.equal(reread.playback.status, 'paused');
  assert.equal(reread.playback.remaining_ms, paused.playback.remaining_ms);
  assert.equal(reread.checkpoint.id, paused.checkpoint.id);
  assert.deepEqual(reread.database, paused.database);
  assert.equal(reread.pid, paused.pid, 'pause must not kill Rust');
  assert.equal((await post('play')).status, 202);
  const resumed = await state();
  assert(resumed.playback.remaining_ms <= paused.playback.remaining_ms, 'resume must keep the remaining time');
  await until(state, s => s.phase === 'running' && s.playback.scene.id === 'assigned', 'did not observe the actual file-writing operation');
  assert.equal((await post('pause')).status, 202);
  const published = await until(state, s => s.phase === 'paused' && s.checkpoint.stage === 'published', 'the current operation did not reach its safe checkpoint');
  assert.equal(published.playback.status, 'paused');
  assert.equal(published.tasks.filter(task => task.published).length, 4);
  await delay(750);
  assert.equal((await state()).checkpoint.id, published.checkpoint.id);
  assert((await state()).tasks.every(task => task.state !== 'completed'));
  assert.equal((await post('play')).status, 202);
  const crashed = await until(state, s => s.playback.scene.id === 'crashed' && s.phase === 'interrupted', 'no automatic crash');
  assert.equal((await post('run', { tasks: 4, work_ms: 1200 })).status, 202);
  const independent = await until(state, s => s.phase === 'running', 'the independent run did not start');
  assert.notEqual(independent.run.id, crashed.run.id);
  assert.equal(independent.playback, null);
  await delay(700);
  const stillWorking = await state();
  assert.equal(stillWorking.run.id, independent.run.id);
  assert.equal(stillWorking.pid, independent.pid, 'the cancelled story must not reopen or kill a different runtime');
  const finished = await until(state, s => s.phase === 'finished', 'independent work did not finish');
  assert.equal(finished.summary.completed_now, 4);
  assert.equal(finished.summary.retried, 0);
});

test('reset waits for owned-process cleanup, rejects overlapping commands and cancels old cues', { skip: !asmdbDir }, async t => {
  const { state, post } = await fixture(t, { storySceneMs: 450 });
  const idle = await state();
  assert.equal((await post('play')).status, 202);
  const playing = await until(state, s => s.phase === 'paused', 'no armed story checkpoint');
  assert.equal(playing.playback.status, 'playing');
  const kill = ChildProcess.prototype.kill;
  let held;
  // Hold only this fixture's OS stop to make the command-conflict window deterministic.
  const stop = t.mock.method(ChildProcess.prototype, 'kill', function(signal) {
    if (this.pid !== playing.pid) return kill.call(this, signal);
    held = { child: this, signal };
    return true;
  });
  const resetting = post('reset');
  let response;
  try {
    const stopping = await until(state, s => s.phase === 'stopping', 'reset did not await its owned process');
    assert.equal(stopping.pid, playing.pid);
    for (const [action, body] of [['reset', {}], ['run', { tasks: 4, work_ms: 0 }]]) {
      const conflict = await post(action, body);
      assert.equal(conflict.status, 409);
      assert.deepEqual(await conflict.json(), { error: 'Another command is in progress.' });
    }
  } finally {
    stop.mock.restore();
    if (held) kill.call(held.child, held.signal);
    response = await resetting;
  }
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), idle);
  assert.throws(() => process.kill(playing.pid, 0), { code: 'ESRCH' });
  await delay(750);
  assert.deepEqual(await state(), idle, 'the old cue must not reopen or advance a run after reset');
});

test('an early story restart reports the real completed count and reuses uncommitted files', { skip: !asmdbDir }, async t => {
  const { state, post, restart } = await fixture(t, { storySceneMs: 450 });
  assert.equal((await post('play')).status, 202);
  const original = await until(state, s => s.phase === 'paused' && s.checkpoint.stage === 'published', 'no first published results');
  assert.equal((await post('pause')).status, 202);
  const files = await Promise.all(original.tasks.filter(task => task.published).map(async task => {
    const filename = path.join(original.run.directory, 'artifacts', `${task.id}.json`);
    return { filename, bytes: await readFile(filename), modified: (await stat(filename)).mtimeMs };
  }));
  assert.equal(files.length, 4);
  assert(original.tasks.every(task => task.state !== 'completed'));
  await restart();
  assert.equal((await post('play')).status, 202);
  const retrying = await until(state, s => s.phase === 'paused' && s.playback.scene.id === 'retrying', 'the early interruption did not recover');
  assert.equal((await post('pause')).status, 202);
  assert.equal(retrying.run.id, original.run.id);
  assert.equal(retrying.database.response.rows.filter(row => row.tag === 'asmrt.v1.completed').length, 0);
  assert.match(retrying.playback.scene.description, /\b0 completed records\b/);
  assert.equal((await post('play')).status, 202);
  const published = await until(state, s => s.phase === 'paused' && s.playback.scene.id === 'recovered-files', 'the interrupted results were not republished');
  assert.equal((await post('pause')).status, 202);
  assert.equal(published.tasks.filter(task => task.published).length, 4);
  assert.match(published.playback.scene.description, /\b0 completed records\b/);
  assert.doesNotMatch(published.playback.scene.title, /new files|four originals/i);
  for (const file of files) {
    assert.deepEqual(await readFile(file.filename), file.bytes);
    assert.equal((await stat(file.filename)).mtimeMs, file.modified);
  }
});

test('restarting a playing controller cancels its timer and waits for Play before reopening the saved database', { skip: !asmdbDir }, async t => {
  const { state, post, restart } = await fixture(t, { storySceneMs: 450 });
  assert.equal((await post('play')).status, 202);
  const original = await until(state, s => s.phase === 'paused', 'no initial story checkpoint');
  await restart();
  await delay(750);
  const stopped = await state();
  assert.equal(stopped.run.id, original.run.id);
  assert.equal(stopped.run.story, true);
  assert.equal(stopped.phase, 'interrupted');
  assert.equal(stopped.pid, null);
  assert.equal(stopped.database, null, 'a restored configuration is not a fresh database read');
  assert.equal(stopped.tasks.length, 0);
  assert.equal(stopped.playback.status, 'paused');
  assert.equal((await post('play')).status, 202);
  const recovered = await until(state, s => s.phase === 'paused', 'Play did not reopen the saved run');
  assert.equal((await post('pause')).status, 202);
  assert.equal(recovered.run.id, original.run.id);
  assert.notEqual(recovered.pid, original.pid);
  assert.notEqual(recovered.checkpoint.id, original.checkpoint.id);
  assert.equal(recovered.database.response.rows.length, 8);
  assert.equal((await post('next', { checkpoint: original.checkpoint.id })).status, 409);
});

test('restarting the viewer retains its run and rereads durable state without replaying completed work', { skip: !asmdbDir }, async t => {
  const { state, post, restart } = await fixture(t);
  assert.equal((await post('run', { tasks: 4, work_ms: 0 })).status, 202);
  const finished = await until(state, s => s.phase === 'finished', 'initial demo did not finish');
  await restart();
  const unloaded = await state();
  assert.equal(unloaded.run.directory, finished.run.directory);
  assert.equal(unloaded.phase, 'interrupted');
  assert.equal(unloaded.tasks.length, 0, 'do not invent observations after controller restart');
  assert.equal((await post('resume')).status, 202);
  const resumed = await until(state, s => s.phase === 'finished', 'restored session did not finish');
  assert.equal(resumed.summary.completed_now, 0);
  assert.equal(resumed.summary.completed, 4);
  assert.equal(resumed.run.id, finished.run.id);
});

test('commands preserve local authorization and input validation; idle reset is idempotent', { skip: !asmdbDir }, async t => {
  const { server, dataRoot, state, post } = await fixture(t);
  const snapshot = await state();
  for (const headers of [
    { Origin: 'https://unrelated.example', 'X-Asmrt-Token': snapshot.csrf_token },
    { Origin: server.url, 'X-Asmrt-Token': 'wrong-token' },
  ]) {
    for (const action of ['run', 'reset']) {
      const response = await fetch(`${server.url}/api/${action}`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'run' ? { tasks: 4, work_ms: 0 } : {}),
      });
      assert.equal(response.status, 403);
    }
  }
  const rejectedHost = await new Promise((resolve, reject) => {
    get(`${server.url}/api/state`, { headers: { Host: 'unrelated.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(rejectedHost, 403);
  assert.equal((await post('run', { tasks: 4, work_ms: 0, data_dir: dataRoot })).status, 400);
  assert.equal((await post('run', { tasks: 101, work_ms: 0 })).status, 400);
  for (const body of [null, [], false, { directory: dataRoot }]) {
    assert.equal((await post('reset', body)).status, 400);
  }
  const nonJson = await fetch(`${server.url}/api/reset`, { method: 'POST',
    headers: { Origin: server.url, 'X-Asmrt-Token': snapshot.csrf_token, 'Content-Type': 'text/plain' }, body: '{}' });
  assert.equal(nonJson.status, 415);
  assert.equal((await fetch(`${server.url}/api/reset`)).status, 404);
  assert.equal((await post('resume')).status, 409);
  assert.deepEqual(await state(), snapshot);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await post('reset');
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), snapshot);
  }
});

test('interrupting the owned process preserves completed work and resumes interrupted attempts', { skip: !asmdbDir }, async t => {
  const { state, post } = await fixture(t);
  assert.equal((await post('run', { tasks: 16, work_ms: 400 })).status, 202);
  const working = await until(state, s => s.tasks.some(task => task.state === 'completed') && s.tasks.some(task => task.state === 'running'), 'no concurrent work observed');
  const completed = working.tasks.find(task => task.state === 'completed');
  const filename = path.join(working.run.directory, 'artifacts', `${completed.id}.json`);
  const before = await readFile(filename);
  const modified = (await stat(filename)).mtimeMs;
  assert.equal((await post('run', { tasks: 4, work_ms: 0 })).status, 409);
  assert.equal((await post('interrupt')).status, 202);
  const stopped = await state();
  assert.equal(stopped.phase, 'interrupted');
  assert.equal(stopped.pid, null);
  assert.equal((await post('resume')).status, 202);
  const finished = await until(state, s => s.phase === 'finished', 'interrupted work did not recover');
  assert.equal(finished.summary.completed, 16);
  assert(finished.summary.retried > 0);
  assert(finished.summary.completed_now < 16);
  assert.equal(finished.tasks.find(task => task.id === completed.id).attempt, completed.attempt);
  assert.deepEqual(await readFile(filename), before);
  assert.equal((await stat(filename)).mtimeMs, modified);
});

test('guided steps wait for the reader, reject stale clicks, and recover only unfinished files after a controller restart', { skip: !asmdbDir }, async t => {
  const { server, state, post, restart } = await fixture(t);
  assert.equal((await post('run', { tasks: 8, work_ms: 0, guided: true })).status, 202);
  let current = await until(state, s => s.phase === 'paused', 'the guided demo did not pause');
  assert.equal(current.checkpoint.stage, 'ready');
  assert(current.tasks.every(task => task.state === 'pending' && task.attempt === '0'));
  const initialCheckpoint = current.checkpoint.id;
  await delay(600);
  assert.deepEqual((await state()).tasks, current.tasks, 'no autonomous work while the reader pauses');
  assert.equal((await state()).checkpoint.id, initialCheckpoint);
  assert.equal((await post('run', { tasks: 4, work_ms: 0 })).status, 409);
  const advance = async expected => {
    const checkpoint = current.checkpoint.id;
    assert.equal((await post('next', { checkpoint })).status, 202);
    current = await until(state, s => s.phase === 'finished' || (s.phase === 'paused' && s.checkpoint.id !== checkpoint), 'next checkpoint was not reached');
    assert.equal(current.checkpoint?.stage ?? current.phase, expected);
  };
  await advance('claimed');
  assert.equal(current.tasks.filter(task => task.state === 'running').length, 4);
  assert(current.tasks.every(task => !task.published));
  assert.equal((await post('next', { checkpoint: initialCheckpoint })).status, 409, 'a repeated click cannot skip the current explanation');
  assert.equal((await fetch(`${server.url}/api/artifacts/1`)).status, 404);
  await advance('published');
  assert.equal(current.tasks.filter(task => task.published).length, 4);
  assert.equal(current.tasks.filter(task => task.state === 'completed').length, 0, 'a published file is not yet a completed task');
  assert.equal((await fetch(`${server.url}/api/artifacts/1`)).status, 200);
  await delay(600);
  assert.equal((await state()).checkpoint.id, current.checkpoint.id);
  await advance('completed');
  assert.equal(current.tasks.filter(task => task.state === 'completed').length, 4);
  const completed = current.tasks.filter(task => task.state === 'completed');
  const file = path.join(current.run.directory, 'artifacts', `${completed[0].id}.json`);
  const before = await readFile(file);
  const modified = (await stat(file)).mtimeMs;
  await advance('claimed');
  assert.equal(current.tasks.filter(task => task.state === 'running').length, 4);
  const oldCheckpoint = current.checkpoint.id;
  assert.equal((await post('interrupt')).status, 202);
  assert.equal((await state()).pid, null);
  assert.equal((await state()).checkpoint, null);
  await restart();
  const unloaded = await state();
  assert.equal(unloaded.run.guided, true);
  assert.equal(unloaded.tasks.length, 0);
  assert.equal((await post('resume')).status, 202);
  current = await until(state, s => s.phase === 'paused', 'recovered state did not pause');
  assert.equal(current.checkpoint.stage, 'ready');
  assert.equal(current.tasks.filter(task => task.state === 'completed').length, 4);
  assert.equal(current.tasks.filter(task => task.state === 'pending').length, 4);
  assert.equal((await post('next', { checkpoint: oldCheckpoint })).status, 409);
  await advance('claimed');
  assert(current.tasks.filter(task => task.state === 'running').every(task => task.attempt === '2'));
  await advance('published');
  await advance('finished');
  assert.equal(current.summary.completed, 8);
  assert.equal(current.summary.completed_now, 4);
  assert.equal(current.summary.retried, 4);
  assert(current.tasks.filter(task => completed.some(old => old.id === task.id)).every(task => task.attempt === '1'));
  assert.deepEqual(await readFile(file), before);
  assert.equal((await stat(file)).mtimeMs, modified);
  assert.equal((await post('resume')).status, 202);
  const replay = await until(state, s => s.phase === 'finished' && s.summary?.completed_now === 0, 'guided replay waited for input or repeated work');
  assert.equal(replay.checkpoint, null);
  assert.equal(replay.summary.completed, 8);
});

test('HTTP view follows real task acknowledgements, serves results, and replays without work', { skip: !asmdbDir }, async t => {
  const { server, state, post } = await fixture(t);
  assert.equal((await state()).phase, 'idle');
  assert.equal((await post('run', { tasks: 8, work_ms: 40 })).status, 202);
  const finished = await until(state, s => s.phase === 'finished', 'demo did not finish');
  assert.equal(finished.summary.completed_now, 8);
  assert.equal(finished.tasks.length, 8);
  assert(finished.tasks.every(task => task.state === 'completed' && task.attempt === '1'));
  assert.equal(finished.events.filter(event => event.event === 'task_claimed').length, 8);
  const artifact = await fetch(`${server.url}/api/artifacts/1`);
  assert.equal(artifact.status, 200);
  assert.deepEqual(await artifact.json(), { schema: 'asmrt.demo.v1', task_id: '1', result: 'deterministic completion' });
  const file = path.join(finished.run.directory, 'artifacts', '1.json');
  const original = await stat(file);
  const lastSequence = finished.events.at(-1).sequence;
  assert.equal((await post('resume')).status, 202);
  const repeated = await until(state, s => s.phase === 'finished' && s.summary?.completed_now === 0, 'replay did not finish');
  assert.equal(repeated.summary.completed, 8);
  assert.equal(repeated.events.filter(event => event.sequence > lastSequence && event.event === 'task_claimed').length, 0);
  assert.equal((await stat(file)).mtimeMs, original.mtimeMs);
});
