import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { lstat, mkdir, open, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { describeStory } from './story.mjs';
import { conversationOptions, describeConversation, localModelSettings } from './conversation-story.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(root, 'visualizer', 'public');
const ownerMarker = 'asmrt-visualizer-v1\n';
const activePhases = new Set(['starting', 'running', 'paused', 'stopping']);
const checkpointStages = new Set(['ready', 'claimed', 'published', 'completed']);
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/console-view.mjs', ['console-view.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/workers.png', ['workers.png', 'image/png']],
]);

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function validateOptions(options) {
  if (!options || Object.keys(options).some(key => !['tasks', 'work_ms', 'guided'].includes(key))
      || !Number.isInteger(options.tasks) || options.tasks < 1 || options.tasks > 100
      || !Number.isInteger(options.work_ms) || options.work_ms < 0 || options.work_ms > 5000
      || (options.guided !== undefined && typeof options.guided !== 'boolean')) {
    throw new HttpError(400, 'Choose 1 to 100 tasks, a 0 to 5000 ms work delay, and a boolean guided option.');
  }
}

async function initializeDirectory(directory) {
  await mkdir(directory, { recursive: true });
  if (!(await lstat(directory)).isDirectory()) throw new Error('The visualizer needs a regular directory.');
  const marker = path.join(directory, '.visualizer-owner');
  try {
    if (!(await lstat(marker)).isFile() || await readFile(marker, 'utf8') !== ownerMarker) {
      throw new Error('Invalid visualizer ownership marker; directory left untouched.');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if ((await readdir(directory)).length !== 0) throw new Error('Refusing an unrelated nonempty visualizer directory.');
    await writeFile(marker, ownerMarker, { flag: 'wx' });
  }
}

async function readSmallFile(filename, limit) {
  if (!(await lstat(filename)).isFile()) throw new HttpError(404, 'A regular file is required.');
  const file = await open(filename, 'r');
  try {
    const data = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > limit) throw new HttpError(413, 'The file is too large.');
    return data.subarray(0, bytesRead);
  } finally { await file.close(); }
}

async function readBody(request) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new HttpError(415, 'A JSON request body is required.');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2048) throw new HttpError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Invalid JSON.'); }
}

function deadline(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Child cleanup timed out; no new writer was started.')), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

export async function createVisualizer({
  asmdbDir = process.env.ASMRT_ASMDB_REPO,
  binary = path.join(root, 'target', 'debug', process.platform === 'win32' ? 'asmrt.exe' : 'asmrt'),
  dataRoot = path.join(root, '.asmrt', 'visual'),
  port = 8787,
  storySceneMs,
  conversationModel = process.env.ASMRT_OLLAMA_MODEL ?? 'qwen3.5:0.8b',
  ollamaUrl = process.env.ASMRT_OLLAMA_URL ?? 'http://127.0.0.1:11434',
} = {}) {
  const modelSettings = localModelSettings(conversationModel, ollamaUrl);
  if (storySceneMs !== undefined && (!Number.isInteger(storySceneMs) || storySceneMs < 100 || storySceneMs > 60000)) {
    throw new Error('Story scene duration must be an integer from 100 to 60000 milliseconds.');
  }
  if (!asmdbDir) throw new Error('Pass --asmdb-dir or set ASMRT_ASMDB_REPO.');
  asmdbDir = path.resolve(asmdbDir);
  binary = path.resolve(binary);
  dataRoot = path.resolve(dataRoot);
  const engine = path.join(asmdbDir, 'build', process.platform === 'win32' ? 'asmdb.exe' : 'asmdb');
  const bridge = path.join(asmdbDir, 'mcp', 'src', 'server.js');
  for (const filename of [binary, engine, bridge]) {
    if (!(await lstat(filename)).isFile()) throw new Error(`Missing regular file: ${filename}`);
  }
  await initializeDirectory(dataRoot);
  const manifest = path.join(dataRoot, 'latest.json');
  const token = randomBytes(24).toString('hex');
  const tasks = new Map();
  let run = null;
  let phase = 'idle';
  let events = [];
  let sequence = 0;
  let summary = null;
  let checkpoint = null;
  let launchId = null;
  let checkpointSequence = 0;
  let database = null;
  let conversation = null;
  let databaseSequence = 0;
  let playback = null;
  let cueTimer = null;
  let cueDeadline = null;
  let cueRemaining = 0;
  let cueGeneration = 0;
  let cueAction = null;
  let sceneKey = null;
  let error = null;
  let child = null;
  let childClosed = Promise.resolve();
  let changing = false;
  let closing = false;
  let url;

  try {
    const saved = JSON.parse((await readSmallFile(manifest, 4096)).toString('utf8'));
    if (saved.schema !== 1 || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(saved.id)) {
      throw new Error('Invalid visualizer manifest; no database was opened.');
    }
    validateOptions({ tasks: saved.tasks, work_ms: saved.work_ms, guided: saved.guided });
    if ((saved.story !== undefined && typeof saved.story !== 'boolean') || (saved.story && (saved.tasks !== 8 || saved.guided !== true))) {
      throw new Error('Invalid saved story configuration; no database was opened.');
    }
    if (saved.kind !== undefined && !['demo', 'conversation'].includes(saved.kind)) throw new Error('Unsupported saved run kind.');
    let chatSettings = {};
    if (saved.kind === 'conversation') {
      chatSettings = { ...conversationOptions({ topic: saved.topic, rounds: saved.rounds }), ...localModelSettings(saved.model, saved.ollama_url) };
      if (saved.tasks !== chatSettings.rounds * 4 || !saved.guided || saved.story || saved.topic !== chatSettings.topic) throw new Error('Invalid saved conversation configuration.');
    }
    run = { id: saved.id, directory: path.join(dataRoot, saved.id), tasks: saved.tasks, workers: 4, work_ms: saved.work_ms,
      guided: saved.guided ?? false, story: saved.story ?? false, kind: saved.kind ?? 'demo', ...chatSettings };
    phase = 'interrupted';
  } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }

  const append = event => {
    const { event: name, task_id, owner, attempt, artifact, message } = event;
    events.push({ sequence: ++sequence, at: new Date().toISOString(), event: name, task_id, owner, attempt, artifact, message });
    if (events.length > 160) events = events.slice(-160);
  };
  const snapshot = () => ({
    csrf_token: token, phase, run, tasks: [...tasks.values()], events, summary, checkpoint, error, database, conversation,
    playback: playback ? { ...playback, remaining_ms: Math.ceil(cueDeadline === null ? cueRemaining : Math.max(0, cueDeadline - performance.now())) } : null,
    pid: child?.exitCode === null && child?.signalCode === null ? child.pid : null,
    source: { engine, bridge, mode: 'Acknowledged CLI events and real SELECT * reads through the same MCP connection; not CDC or an engine heartbeat.' },
  });

  function consume(event) {
    if (event.event === 'ready') {
      if (!Array.isArray(event.task_snapshot) || event.task_snapshot.length !== run.tasks) {
        throw new Error('Missing task snapshot: rebuild asmRT with --events support.');
      }
      tasks.clear();
      for (const task of event.task_snapshot) {
        tasks.set(task.id, { ...task, published: task.state === 'completed' });
      }
      if (run.kind === 'conversation') {
        const restored = event.conversation;
        const done = [...tasks.values()].filter(task => task.state === 'completed');
        if (restored?.schema !== 'asmrt.conversation.v1' || restored.topic !== run.topic
            || restored.model?.name !== run.model || restored.turns_total !== run.tasks
            || !Array.isArray(restored.agents) || restored.agents.length !== 4
            || !Array.isArray(restored.messages) || restored.messages.length !== done.length
            || restored.messages.some((message, index) => message.task_id !== String(index + 1)
              || tasks.get(message.task_id)?.state !== 'completed' || message.committed !== true)) {
          throw new Error('The saved conversation does not match the acknowledged tasks.');
        }
        conversation = { ...restored, active: null };
      }
      if (phase !== 'stopping') phase = 'running';
      append({ event: 'ready', message: 'State reloaded from asmDB. Interrupted assignments are pending again.' });
    } else if (event.event === 'task_claimed' || event.event === 'task_completed') {
      if (!tasks.has(event.task_id) || event.task?.id !== event.task_id) throw new Error('Unexpected task event.');
      tasks.set(event.task_id, { ...event.task, published: event.task.state === 'completed' });
      if (conversation) {
        if (event.event === 'task_claimed') {
          conversation.active = { task_id: event.task_id, agent_id: event.task.owner, stage: 'assigned',
            input_ids: conversation.messages.filter(message => message.committed).map(message => message.task_id) };
        } else {
          const message = conversation.messages.find(message => message.task_id === event.task_id);
          if (!message) throw new Error('Conversation completion without an observed reply.');
          message.committed = true;
          conversation.active = null;
        }
      }
      append(event);
    } else if (event.event === 'inference_started') {
      if (!conversation || conversation.active?.task_id !== event.task_id
          || conversation.active.agent_id !== event.agent_id
          || JSON.stringify(event.input_ids) !== JSON.stringify(conversation.active.input_ids)) {
        throw new Error('Inference does not match the current agent and saved messages.');
      }
      conversation.active.stage = 'generating';
      append({ event: event.event, task_id: event.task_id, owner: event.agent_id, message: 'A real local Ollama request is running.' });
      synchronizePlayback();
    } else if (event.event === 'message_published') {
      const message = event.message;
      const task = tasks.get(message?.task_id);
      if (!conversation || !task?.published || task.owner !== message.agent_id
          || task.definition?.sha256 !== message.job_sha256 || typeof message.text !== 'string' || !message.text.trim()
          || JSON.stringify(message.input_ids) !== JSON.stringify(conversation.active?.input_ids)
          || conversation.messages.some(existing => existing.task_id === message.task_id)) {
        throw new Error('Published reply does not match its task definition and conversation inputs.');
      }
      conversation.messages.push({ ...message, committed: false, reused: event.reused === true });
      conversation.active.stage = 'saved';
      append({ event: event.event, task_id: message.task_id, owner: message.agent_id,
        message: event.reused ? 'Existing reply reused without a model call.' : 'The generated reply was saved; its completion is not committed yet.' });
    } else if (event.event === 'artifact_published') {
      const task = tasks.get(event.task_id);
      if (!task) throw new Error('Artifact event without a task.');
      task.published = true;
      task.published_sha256 = event.artifact;
      append(event);
    } else if (event.event === 'database_read') {
      const rows = event.response?.rows;
      if (event.tool !== 'db_list' || event.arguments?.limit !== 1000 || event.arguments?.offset !== 0
          || event.response?.ok !== true || !Array.isArray(rows) || rows.length !== run.tasks
          || new Set(rows.map(row => row.id)).size !== run.tasks
          || rows.some(row => !tasks.has(row.id) || ['id', 'value', 'tag', 'content'].some(key => row[key] !== tasks.get(row.id).record[key]))) {
        throw new Error('The asmDB record read does not match the acknowledged task state.');
      }
      database = { sequence: ++databaseSequence, at: new Date().toISOString(), launch_id: launchId,
        tool: event.tool, arguments: event.arguments, commands: event.commands, response: event.response };
      append({ event: 'database_read', message: `SELECT * returned ${rows.length} records through the existing MCP connection.` });
    } else if (event.event === 'checkpoint') {
      if (!run.guided || !checkpointStages.has(event.stage)
          || !Number.isSafeInteger(event.sequence) || event.sequence <= checkpointSequence
          || !Array.isArray(event.task_ids) || event.task_ids.some(id => !tasks.has(id))) {
        throw new Error('Invalid guided checkpoint.');
      }
      checkpointSequence = event.sequence;
      if (phase !== 'stopping') {
        checkpoint = { id: `${launchId}:${event.sequence}`, sequence: event.sequence, stage: event.stage, task_ids: event.task_ids };
        phase = 'paused';
        append({ event: 'checkpoint', message: `Acknowledged checkpoint: ${event.stage}. Rust is waiting for the next cue.` });
        synchronizePlayback();
      }
    } else if (event.event === 'finished') {
      checkpoint = null;
      summary = event;
    } else {
      throw new Error(`Unexpected CLI event: ${event.event}`);
    }
  }

  function cancelCue() {
    if (cueDeadline !== null) cueRemaining = Math.max(0, cueDeadline - performance.now());
    clearTimeout(cueTimer);
    cueTimer = null;
    cueDeadline = null;
    cueGeneration++;
  }

  function preparePlayback(status, kind = run?.kind) {
    cancelCue();
    cueRemaining = 0;
    cueAction = null;
    sceneKey = null;
    const chat = kind === 'conversation';
    playback = {
      status, index: 0, total: chat ? 29 : 11, duration_ms: 0, transitioning: true,
      scene: { id: chat ? 'chat-opening' : 'queued', chapter: chat ? 'Conversation' : 'Queue',
        title: chat ? 'Opening the saved conversation.' : 'Opening asmDB.',
        description: chat ? 'Reading the local model identity, task definitions and real asmDB records.'
          : 'Starting Rust, its State Actor and its only database connection.',
        focus: 'database', next_label: 'Read the task records' },
    };
  }

  function pausePlayback() {
    if (!playback) return;
    cancelCue();
    playback.status = 'paused';
    append({ event: 'playback_paused', message: 'Story timer paused. Any current operation will finish at its next acknowledged checkpoint.' });
  }

  function synchronizePlayback() {
    if ((!run?.story && run?.kind !== 'conversation') || !playback || closing) return;
    if (phase === 'error') {
      cancelCue();
      playback.status = 'error';
      playback.transitioning = false;
      return;
    }
    const next = run.kind === 'conversation'
      ? describeConversation({ phase, checkpoint, tasks: [...tasks.values()], summary, conversation, run })
      : describeStory({ phase, checkpoint, tasks: [...tasks.values()], summary, database });
    if (!next) { playback.transitioning = true; return; }
    const key = `${run.id}:${launchId ?? 'restored'}:${checkpoint?.id ?? phase}`;
    if (sceneKey !== key) {
      cancelCue();
      sceneKey = key;
      cueAction = next.action;
      cueRemaining = next.duration_ms === 0 ? 0 : (storySceneMs ?? next.duration_ms);
      playback.scene = next.scene;
      playback.index = next.index;
      playback.total = next.total;
      playback.duration_ms = cueRemaining;
      playback.transitioning = false;
      if (['verified', 'chat-verified'].includes(next.scene.id)) playback.status = 'finished';
    }
    if (playback.status === 'playing' && cueAction && cueTimer === null && !changing) {
      const expected = { generation: cueGeneration, run: run.id, scene: sceneKey, checkpoint: checkpoint?.id, action: cueAction };
      cueDeadline = performance.now() + cueRemaining;
      cueTimer = setTimeout(() => { void runCue(expected); }, cueRemaining);
    }
  }

  async function advanceCheckpoint(id) {
    if (!child?.stdin?.writable || phase !== 'paused' || checkpoint?.id !== id) {
      throw new HttpError(409, 'This checkpoint has changed. Refresh before continuing.');
    }
    const command = `next ${checkpoint.sequence}\n`;
    checkpoint = null;
    phase = 'running';
    await new Promise((resolve, reject) => child.stdin.write(command, failure => failure ? reject(failure) : resolve()));
  }

  async function interruptRuntime() {
    if (!child || !['running', 'paused'].includes(phase)) throw new HttpError(409, 'No running runtime to interrupt.');
    child.interrupt();
    await deadline(childClosed, 15000);
  }

  async function runCue(expected) {
    // A cancelled timer must never affect a later checkpoint, launch or run.
    if (closing || expected.generation !== cueGeneration || expected.run !== run?.id
        || expected.scene !== sceneKey || playback?.status !== 'playing') return;
    cueTimer = null;
    cueDeadline = null;
    cueRemaining = 0;
    if (changing) {
      cueTimer = setTimeout(() => { void runCue(expected); }, 25);
      return;
    }
    changing = true;
    playback.transitioning = true;
    try {
      if (expected.action === 'next') await advanceCheckpoint(expected.checkpoint);
      else if (expected.action === 'interrupt') await interruptRuntime();
      else if (expected.action === 'resume') {
        if (child || activePhases.has(phase)) throw new HttpError(409, 'The previous writer has not closed yet.');
        await launch();
      }
    } catch (failure) {
      if (!closing) {
        cancelCue();
        playback.status = 'error';
        playback.transitioning = false;
        error = failure.message;
        append({ event: 'error', message: `Automatic playback stopped: ${error}` });
      }
    } finally {
      changing = false;
      synchronizePlayback();
    }
  }

  function requireEmptyBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0) {
      throw new HttpError(400, 'This command requires an empty JSON object.');
    }
  }

  async function persistRun() {
    const temporary = path.join(dataRoot, `.latest-${randomUUID()}.tmp`);
    const file = await open(temporary, 'wx');
    try {
      await file.writeFile(JSON.stringify({ schema: 1, id: run.id, tasks: run.tasks, work_ms: run.work_ms,
        guided: run.guided, story: run.story, kind: run.kind,
        ...(run.kind === 'conversation' ? { topic: run.topic, rounds: run.rounds, model: run.model, ollama_url: run.ollama_url } : {}) }) + '\n');
      await file.sync();
    } finally { await file.close(); }
    await rename(temporary, manifest);
  }

  async function launch(options, story = false, chatSettings = null) {
    if (options) {
      validateOptions(options);
      const id = randomUUID();
      run = { id, directory: path.join(dataRoot, id), tasks: options.tasks, workers: 4, work_ms: options.work_ms,
        guided: options.guided ?? false, story, kind: chatSettings ? 'conversation' : 'demo', ...chatSettings };
      if (!story && !chatSettings) { cancelCue(); playback = null; }
      events = [];
      database = null;
      conversation = null;
      tasks.clear();
    } else if (!run) {
      throw new HttpError(409, 'There is no saved run to resume.');
    }
    cancelCue();
    sceneKey = null;
    if (playback) playback.transitioning = true;
    phase = 'starting';
    error = null;
    summary = null;
    checkpoint = null;
    launchId = randomUUID();
    checkpointSequence = 0;
    try { await persistRun(); }
    catch (failure) { phase = 'error'; error = failure.message; throw failure; }
    if (closing) {
      phase = 'interrupted';
      throw new HttpError(409, 'The controller is closing; no runtime was launched.');
    }
    append({ event: 'launching', message: 'Opening the Rust runtime and its single asmDB writer.' });
    const command = run.kind === 'conversation'
      ? ['chat', `--topic=${run.topic}`, '--model', run.model, '--ollama-url', run.ollama_url, '--rounds', String(run.rounds)]
      : ['demo', '--tasks', String(run.tasks), '--workers', '4', '--work-ms', String(run.work_ms)];
    const process = spawn(binary, [
      '--asmdb-dir', asmdbDir, '--data-dir', run.directory,
      ...command, '--events', ...(run.guided ? ['--guided'] : []),
    ], { cwd: root, windowsHide: true, stdio: [run.guided ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    child = process;
    let buffered = '';
    let diagnostic = '';
    let failure = null;
    let interrupted = false;
    let finish;
    childClosed = new Promise(resolve => { finish = resolve; });
    process.interrupt = () => {
      interrupted = true;
      checkpoint = null;
      phase = 'stopping';
      process.kill('SIGKILL');
    };
    const fail = problem => {
      failure ??= problem.message;
      checkpoint = null;
      process.kill('SIGKILL');
    };
    process.on('error', fail);
    process.stdin?.on('error', fail);
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-8192); });
    process.stdout.setEncoding('utf8');
    process.stdout.on('data', chunk => {
      buffered += chunk;
      if (buffered.length > 1024 * 1024) { fail(new Error('CLI frame exceeded 1 MiB.')); return; }
      let end;
      while ((end = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 1);
        try { consume(JSON.parse(line)); }
        catch (problem) { fail(problem); return; }
      }
    });
    // close, unlike exit, also waits for inherited pipe handles to close.
    process.on('close', code => {
      child = null;
      checkpoint = null;
      if (conversation) conversation.active = null;
      if (interrupted) {
        phase = 'interrupted';
        summary = null;
        append({ event: 'interrupted', message: 'Rust process killed. Last observations retained; reopen to reread asmDB.' });
      } else if (code === 0 && summary?.completed === run.tasks && !failure && buffered.length === 0) {
        phase = 'finished';
        append({ event: 'finished', message: `${summary.completed_now} task(s) executed in this pass. Runtime closed cleanly.` });
      } else {
        phase = 'error';
        error = failure ?? (diagnostic.trim() || 'The runtime exited without confirming completion.');
        summary = null;
        append({ event: 'error', message: error });
      }
      finish();
      synchronizePlayback();
    });
  }

  const send = (response, status, value, contentType = 'application/json; charset=utf-8') => {
    response.writeHead(status, { 'Content-Type': contentType });
    response.end(contentType.startsWith('application/json') && !Buffer.isBuffer(value) ? JSON.stringify(value) : value);
  };

  if (run?.story || run?.kind === 'conversation') { preparePlayback('paused'); synchronizePlayback(); }

  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const host = new URL(url).host;
      if (request.headers.host !== host) throw new HttpError(403, 'Use the local address printed at startup.');
      const route = new URL(request.url, url).pathname;
      if (request.method === 'GET' && route === '/api/state') return send(response, 200, snapshot());
      if (request.method === 'GET' && route === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      if (request.method === 'GET' && assets.has(route)) {
        const [filename, type] = assets.get(route);
        return send(response, 200, await readFile(path.join(publicRoot, filename)), type);
      }
      const artifact = /^\/api\/artifacts\/([1-9][0-9]{0,2})$/.exec(route);
      if (request.method === 'GET' && artifact) {
        const task = tasks.get(artifact[1]);
        if (!run || !task?.published) throw new HttpError(404, 'This result file has not been observed yet.');
        const bytes = await readSmallFile(path.join(run.directory, 'artifacts', `${artifact[1]}.json`), run.kind === 'conversation' ? 128 * 1024 : 4096);
        if (run.kind === 'conversation' && createHash('sha256').update(bytes).digest('hex') !== (task.artifact ?? task.published_sha256)) {
          throw new HttpError(409, 'This reply no longer matches its observed SHA-256.');
        }
        return send(response, 200, bytes);
      }
      const definition = /^\/api\/definitions\/([1-9][0-9]{0,2})$/.exec(route);
      if (request.method === 'GET' && definition) {
        const reference = tasks.get(definition[1])?.definition;
        if (run?.kind !== 'conversation' || reference?.reference !== `job:${definition[1]}`) {
          throw new HttpError(404, 'No saved definition has been observed for this task.');
        }
        const filename = `definitions/${definition[1]}.json`;
        const bytes = await readSmallFile(path.join(run.directory, 'definitions', `${definition[1]}.json`), 128 * 1024);
        if (createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
          throw new HttpError(409, 'This definition no longer matches the SHA-256 in asmDB.');
        }
        return send(response, 200, { task_id: definition[1], filename, sha256: reference.sha256, content: JSON.parse(bytes.toString('utf8')) });
      }
      if (request.method !== 'POST' || !['/api/run', '/api/resume', '/api/interrupt', '/api/next', '/api/play', '/api/pause', '/api/conversation', '/api/storage'].includes(route)) throw new HttpError(404, 'Unknown route.');
      if (request.headers.origin !== url || request.headers['x-asmrt-token'] !== token) {
        throw new HttpError(403, 'Commands are only allowed from this local view.');
      }
      const body = await readBody(request);
      if (closing) throw new HttpError(409, 'The controller is closing.');
      if (route === '/api/pause') {
        requireEmptyBody(body);
        if (playback?.status !== 'playing') throw new HttpError(409, 'No automatic playback is running.');
        pausePlayback();
        return send(response, 202, snapshot());
      }
      if (changing) throw new HttpError(409, 'Another command is in progress.');
      changing = true;
      try {
        if (route === '/api/conversation') {
          if (child || activePhases.has(phase)) throw new HttpError(409, 'Stop the current runtime before starting another conversation.');
          let settings;
          try { settings = conversationOptions(body); }
          catch (failure) { throw new HttpError(400, failure.message); }
          preparePlayback('playing', 'conversation');
          await launch({ tasks: settings.rounds * 4, work_ms: 0, guided: true }, false, { ...settings, ...modelSettings });
        } else if (route === '/api/storage') {
          requireEmptyBody(body);
          if (child || activePhases.has(phase)) throw new HttpError(409, 'Stop the current runtime before starting a storage story.');
          preparePlayback('playing', 'demo');
          await launch({ tasks: 8, work_ms: 600, guided: true }, true);
        } else if (route === '/api/play') {
          requireEmptyBody(body);
          if (playback?.status === 'playing') throw new HttpError(409, 'The story is already playing.');
          const automatic = run?.story || run?.kind === 'conversation';
          if (automatic && playback?.status === 'paused') {
            playback.status = 'playing';
          } else {
            if (child || activePhases.has(phase)) throw new HttpError(409, 'Stop the current runtime before starting a story.');
            const recovering = automatic && playback?.status === 'error';
            preparePlayback('playing', recovering ? run.kind : 'demo');
            if (recovering) await launch();
            else await launch({ tasks: 8, work_ms: 600, guided: true }, true);
          }
        } else if (route === '/api/next') {
          if (!body || Object.keys(body).length !== 1 || typeof body.checkpoint !== 'string') {
            throw new HttpError(400, 'The exact current checkpoint identity is required.');
          }
          if (playback?.status === 'playing') throw new HttpError(409, 'Pause automatic playback before using manual steps.');
          await advanceCheckpoint(body.checkpoint);
        } else if (route === '/api/interrupt') {
          requireEmptyBody(body);
          if (!child || !['running', 'paused'].includes(phase)) throw new HttpError(409, 'No running runtime to interrupt.');
          pausePlayback();
          await interruptRuntime();
        } else {
          if (child || activePhases.has(phase)) throw new HttpError(409, 'A runtime is already active; wait for it to close.');
          if (route === '/api/run') await launch(body);
          else {
            requireEmptyBody(body);
            pausePlayback();
            await launch();
          }
        }
      } finally { changing = false; synchronizePlayback(); }
      return send(response, 202, snapshot());
    } catch (failure) {
      if (!response.headersSent) send(response, failure.status ?? (failure.code === 'ENOENT' ? 404 : 500), { error: failure.message });
      else response.destroy();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      url = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
  return {
    url,
    async close() {
      closing = true;
      cancelCue();
      if (child) { child.interrupt(); await deadline(childClosed, 15000); }
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: {
      'asmdb-dir': { type: 'string' }, 'data-root': { type: 'string' },
      binary: { type: 'string' }, port: { type: 'string', default: '8787' },
      'conversation-model': { type: 'string' }, 'ollama-url': { type: 'string' },
    } });
    if (!/^\d+$/.test(values.port) || Number(values.port) > 65535) throw new Error('Invalid port.');
    const server = await createVisualizer({ asmdbDir: values['asmdb-dir'], dataRoot: values['data-root'], binary: values.binary,
      port: Number(values.port), conversationModel: values['conversation-model'], ollamaUrl: values['ollama-url'] });
    console.log(JSON.stringify({ event: 'visualizer_ready', url: server.url }));
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try { await server.close(); }
      catch (error) { console.error(error.message); process.exitCode = 1; }
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) { console.error(`asmRT visualizer: ${error.message}`); process.exitCode = 1; }
}
