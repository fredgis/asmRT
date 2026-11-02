// Renders the local demo, preserving saved transcripts while workflow controls dispatch explicit controller commands.
import { nativeRecordFields, conversationChapter, conversationMemory, conversationWorkflow, conversationActiveTurns, isConversationWorkflow, validConversation } from "/console-view.mjs";

const byId = (id) => document.getElementById(id);
const ui = {
  conversation: byId("conversation-view"), storageStory: byId("storage-story"),
  overview: byId("overview-stage"), overviewTitle: byId("overview-title"), overviewTopic: byId("overview-topic"),
  overviewStatus: byId("overview-status"), overviewMessages: byId("overview-messages"),
  overviewMessage: byId("overview-message"), overviewReplyScroll: byId("overview-reply-scroll"),
  overviewNavigation: byId("overview-reply-navigation"), overviewPosition: byId("overview-reply-position"), overviewLatest: byId("overview-latest"),
  memory: byId("overview-memory"), memoryCells: byId("overview-memory-cells"), memoryCount: byId("overview-memory-count"),
  memoryTotal: byId("overview-memory-total"), memoryNote: byId("overview-memory-note"), overviewProof: byId("overview-proof"),
  reset: byId("reset-demo"), resetDialog: byId("reset-dialog"), resetCancel: byId("cancel-reset"), resetConfirm: byId("confirm-reset"),
  controls: byId("controls-dialog"), openControls: byId("open-controls"), closeControls: byId("close-controls"),
  storageStart: byId("start-storage-story"), rawRecords: byId("raw-records"), allEvents: byId("all-events"),
  conversationForm: byId("conversation-form"), topic: byId("conversation-topic"), topicHelp: byId("conversation-topic-help"),
  workflow: byId("workflow-picker"), workflowLegend: byId("workflow-legend"), workflowHelp: byId("workflow-help"),
  workflowTitle: byId("overview-workflow-title"), workflowDescription: byId("overview-workflow-description"),
  workflowChain: byId("overview-workflow-chain"), workflowDiscussion: byId("overview-workflow-discussion"),
  overviewRoster: byId("overview-agents"),
  topicError: byId("conversation-topic-error"), conversationStart: byId("start-conversation"),
  conversationButton: byId("conversation-button-label"), conversationIcon: byId("conversation-icon"),
  conversationControl: byId("conversation-control-note"), model: byId("conversation-model"), roster: byId("agent-roster"),
  conversationTitle: byId("conversation-scene-title"), conversationDescription: byId("conversation-scene-description"),
  conversationTurn: byId("conversation-turn"), conversationRuntime: byId("conversation-runtime"),
  conversationScroll: byId("conversation-scroll"), messages: byId("conversation-messages"), conversationEmpty: byId("conversation-empty"),
  conversationActivity: byId("conversation-activity"), conversationProvenance: byId("conversation-provenance"), latestReply: byId("conversation-latest"),
  recovery: byId("conversation-recovery"), recoveryNote: byId("conversation-recovery-note"),
  conversationVerified: byId("conversation-verification"), conversationReused: byId("conversation-reused"),
  savedSummary: byId("conversation-save-summary"), savedTopic: byId("conversation-saved-topic"),
  definitionFile: byId("conversation-definition-file"), definitionHash: byId("conversation-definition-hash"), modelDigest: byId("conversation-model-digest"),
  jobs: byId("conversation-jobs"), jobsEmpty: byId("conversation-jobs-empty"),
  definitionPayload: byId("definition-payload"), definitionStatus: byId("definition-status"), definitionInputs: byId("definition-inputs"),
  definitionPre: byId("definition-pre"), definitionJSON: byId("definition-json"), definitionRetry: byId("definition-retry"),
  play: byId("play-story"), playLabel: byId("play-label"), playIcon: byId("play-icon"),
  sceneTitle: byId("scene-title"), sceneDescription: byId("scene-description"),
  countdown: byId("countdown-value"), countdownLabel: byId("countdown-label"), hint: byId("playback-hint"),
  connectionStatus: byId("connection-status"), actionStatus: byId("action-status"),
  connectionError: byId("connection-error"), connectionErrorTitle: byId("connection-error-title"),
  connectionErrorMessage: byId("connection-error-message"), retryConnection: byId("retry-connection"),
  actionError: byId("action-error"), actionErrorMessage: byId("action-error-message"),
  serverError: byId("server-error"), serverErrorMessage: byId("server-error-message"),
  stage: byId("live-stage"), workersStage: byId("workers-stage"), process: byId("process-info"),
  database: byId("database-panel"), databaseRows: byId("database-rows"), databaseCommands: byId("database-commands"),
  databaseStatus: byId("database-status"), databaseReadCount: byId("database-read-count"),
  databaseTime: byId("database-observed-at"), databaseEmpty: byId("database-empty"),
  filesPanel: byId("files-panel"), files: byId("file-list"), filesNote: byId("files-note"),
  filesEmpty: byId("files-empty"), published: byId("published-count"), verified: byId("verification-result"),
  form: byId("run-form"), start: byId("start-run"), interrupt: byId("interrupt-run"), resume: byId("resume-run"),
  next: byId("next-checkpoint"), taskCount: byId("task-count"), workDelay: byId("work-delay"), guided: byId("guided-run"),
  configurationError: byId("configuration-error"), controlNote: byId("control-note"),
  decodedRows: byId("decoded-rows"), decodedEmpty: byId("decoded-empty"), tasksTotal: byId("tasks-total"),
  pending: byId("count-pending"), running: byId("count-running"), completed: byId("count-completed"), retried: byId("count-retried"),
  events: byId("event-list"), journalCount: byId("journal-count"), journalEmpty: byId("journal-empty"),
  sourceEngine: byId("source-engine"), sourceBridge: byId("source-bridge"), sourceMode: byId("source-mode"),
  sourceDirectory: byId("source-directory"), sourceRun: byId("source-run"),
  dialog: byId("artifact-dialog"), dialogTitle: byId("artifact-title"), closeDialog: byId("close-artifact"),
  detailState: byId("detail-state"), detailOwner: byId("detail-owner"), detailAttempt: byId("detail-attempt"),
  detailNote: byId("detail-state-note"), record: byId("record-json"), artifactRef: byId("artifact-reference"),
  artifactPayload: byId("artifact-payload"), artifactStatus: byId("artifact-status"), artifactPre: byId("artifact-pre"),
  artifactJSON: byId("artifact-json"), artifactRetry: byId("artifact-retry"),
};

const POLL_DELAY = 400;
const REQUEST_TIMEOUT = 8000;
const CHAT_DOCUMENT_LIMIT = 256 * 1024;
const DEFAULT_MODEL = "qwen3.5:0.8b";
const DEFAULT_AGENTS = [
  { id: "planner", name: "Planner", role: "Proposes the plan" },
  { id: "builder", name: "Builder", role: "Makes it practical" },
  { id: "critic", name: "Critic", role: "Challenges assumptions" },
  { id: "editor", name: "Editor", role: "Brings it together" },
];
const EVENT_LIMIT = 20;
const phases = new Set(["idle", "starting", "running", "paused", "stopping", "interrupted", "finished", "error"]);
const activePhases = new Set(["starting", "running", "paused", "stopping"]);
const taskStates = new Set(["pending", "running", "completed"]);
const sceneChapters = { queued: 0, assigned: 1, published: 1, committed: 1, "crash-next": 2, crashed: 2, recovered: 3, retrying: 3, "recovered-files": 4, completed: 4, verified: 5 };
const eventLabels = {
  launching: "Runtime launching", ready: "State read", task_claimed: "Task assigned",
  artifact_published: "File published", task_completed: "Completion committed", checkpoint: "Checkpoint reached",
  interrupted: "Process stopped", finished: "Runtime finished", error: "Error reported",
  database: "Database read", database_read: "Database read", playback_paused: "Playback paused", playback_resumed: "Playback resumed",
  inference_started: "Model call started", message_published: "Reply saved",
};
const readEvents = new Set(["database", "database_read", "checkpoint"]);
const collator = new Intl.Collator("en", { numeric: true });
const nameList = new Intl.ListFormat("en", { style: "long", type: "conjunction" });
const clock = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const recordNodes = new Map();
const fileNodes = new Map();
const taskNodes = new Map();
const eventNodes = new Map();
const observedFiles = new Map();
const publicationRevisions = new Map();
const artifactCache = new Map();
const definitionCache = new Map();
const messageNodes = new Map();
const overviewMessageNodes = new Map();
const jobNodes = new Map();
const memoryNodes = new Map();
const overviewAgents = [...document.querySelectorAll("#overview-agents > li")].map(root => ({
  root, id: root.dataset.agentId, name: root.querySelector("h3"), status: root.querySelector(".overview-agent-status"),
}));
const overviewJourney = [...document.querySelectorAll("#overview-journey > li")];
const agents = [...document.querySelectorAll("#agent-roster [data-agent-id]")].map((root) => ({
  root, id: root.dataset.agentId, name: root.querySelector(".agent-name"), role: root.querySelector(".agent-role"),
  status: root.querySelector(".agent-status"), portrait: root.querySelector(".agent-portrait"),
}));
const flashTimers = new WeakMap();
const workers = [...document.querySelectorAll(".worker-lane")].map((root) => ({
  root, owner: root.dataset.workerId, task: root.querySelector(".worker-task"),
  phase: root.querySelector(".worker-phase"), attempt: root.querySelector(".worker-attempt"), signature: null,
}));
const chapters = [...document.querySelectorAll("#story-rail > li")];
let state = null;
let connected = false;
let connectionError = null;
let actionError = null;
let activeAction = null;
let pollInFlight = null;
let pollTimer = null;
let previousEventKeys = new Set();
let selectedTaskId = null;
let inspectorTrigger = null;
let artifactRequest = null;
let artifactView = null;
let definitionRequest = null;
let definitionView = null;
const chatChapters = [...document.querySelectorAll("#conversation-rail > li")];
const detailChoices = [...document.querySelectorAll('input[name="console-detail"]')];
const workflowChoices = [...document.querySelectorAll('input[name="workflow"]')];
let selectedWorkflow = "conversation.sequential";
let detailMode = "overview";
const DEFAULT_TOPIC = "Pizza night in 30 minutes. Eight friends, $40, one oven. Pick dinner and split the jobs.";
let lastConversation = null;
let selectedOverviewReply = null;

function text(node, value) {
  const next = String(value ?? "");
  if (node.textContent !== next) node.textContent = next;
}

function attribute(node, name, value) {
  const next = String(value);
  if (node.getAttribute(name) !== next) node.setAttribute(name, next);
}

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) text(node, value);
  return node;
}

function flash(node) {
  clearTimeout(flashTimers.get(node));
  node.classList.add("observed-change");
  flashTimers.set(node, setTimeout(() => node.classList.remove("observed-change"), 1000));
}

function reconcileChildren(parent, nodes) {
  let cursor = parent.firstElementChild;
  for (const node of nodes) {
    if (node === cursor) cursor = cursor.nextElementSibling;
    else parent.insertBefore(node, cursor);
  }
  while (cursor) {
    const next = cursor.nextElementSibling;
    cursor.remove();
    cursor = next;
  }
}

function eventKey(event) {
  return JSON.stringify([event.sequence, event.at, event.event, event.task_id ?? null]);
}

function runIdentity(value = state) {
  return value?.run ? JSON.stringify([value.run.id, value.run.directory]) : null;
}

function wasRetried(attempt) {
  return /^\d+$/.test(String(attempt)) && BigInt(attempt) > 1n;
}

function isConversation(value = state) {
  return value?.run?.kind === "conversation";
}

function conversationSnapshot() {
  return isConversation() ? state.conversation ?? lastConversation : null;
}

// A next-run choice never changes the topology or identity of a saved conversation.
function displayedWorkflow() {
  return isConversation() ? conversationWorkflow(conversationSnapshot(), state.run)
    : { kind: selectedWorkflow, version: 1 };
}

function agentName(snapshot, id) {
  return snapshot?.agents.find(agent => agent.id === id)?.name ?? DEFAULT_AGENTS.find(agent => agent.id === id)?.name ?? id;
}

function activeAgentNames(snapshot, turns) {
  return nameList.format([...new Set(turns.map(turn => agentName(snapshot, turn.agent_id)))]);
}

function turnInputs(turn) {
  return turn.input_ids.length ? `replies ${turn.input_ids.join(", ")}` : "saved topic";
}

function verifiedReplay() {
  if (isConversation()) return state.phase === "finished" && state.playback?.status === "finished"
    && String(state.summary?.completed_now) === "0" && String(state.summary?.model_calls_now) === "0";
  return state?.playback?.scene.id === "verified" && state.phase === "finished"
    && String(state.summary?.completed_now) === "0";
}

function workInFlight() {
  return Boolean(state && (state.pid != null || activePhases.has(state.phase)
    || state.playback?.status === "playing" || state.playback?.transitioning));
}

function storyOngoing() {
  return Boolean((state?.run?.story || isConversation()) && state.playback && !verifiedReplay() && workInFlight());
}

function incompatibleRun() {
  return Boolean(state?.run && workInFlight()
    && (isConversation() || !state.run.story || !state.playback));
}

function unobservedLegacyRun() {
  return Boolean(state?.run && !isConversation() && !state.run.story && !state.playback
    && state.phase === "interrupted" && !state.database
    && state.tasks.length === 0 && observedFiles.size === 0);
}

function primaryAction() {
  if (!isConversation() && state?.run?.story && !verifiedReplay()) {
    return state.playback?.status === "playing" ? "pause" : "play";
  }
  return "storage";
}

function conversationAction() {
  if (!isConversation()) return "conversation";
  if (state.playback?.status === "playing" && !verifiedReplay()) return "pause";
  if (state.playback?.status === "paused") return "play";
  if (["interrupted", "error"].includes(state.phase)) return "resume";
  return "conversation";
}

function hasLiveConversationProcess() {
  return isConversation() && connected && state.pid != null && ["running", "paused"].includes(state.phase);
}

function renderLayout() {
  const storage = Boolean(state?.run && !isConversation() && !unobservedLegacyRun());
  const overview = detailMode === "overview" && !storage;
  document.documentElement.dataset.presentation = overview ? "overview" : "details";
  ui.overview.hidden = !overview;
  ui.stage.hidden = overview;
  byId("journal").hidden = overview;
  ui.conversation.hidden = storage;
  ui.storageStory.hidden = !storage;
  ui.workersStage.hidden = !storage;
  ui.conversationRuntime.hidden = storage;
  text(byId("runtime-subtitle"), storage ? "Workers & execution" : "Agents & execution");
}

function currentProcessEvents() {
  const events = state?.events ?? [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].event === "launching") return events.slice(index);
  }
  return events;
}

function focusPrimary() {
  if (ui.controls.open) { ui.closeControls.focus({ preventScroll: true }); return; }
  const primary = !ui.storageStory.hidden && workInFlight() ? ui.play : ui.conversationStart;
  (primary.disabled ? byId("main") : primary).focus({ preventScroll: true });
}

class RequestError extends Error {
  constructor(message, kind = "network", status = 0) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

// Keep requests same-origin and validate observations before they enter the rendering state.
async function requestJSON(path, { method = "GET", body = {}, token, signal, maxBytes } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT);
  try {
    const headers = { Accept: "application/json" };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      headers["X-Asmrt-Token"] = token;
    }
    const response = await fetch(path, {
      method, headers, signal: controller.signal, cache: "no-store", credentials: "same-origin", mode: "same-origin",
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await response.text();
    if (maxBytes && new TextEncoder().encode(raw).byteLength > maxBytes) {
      throw new RequestError(`The response exceeds the ${maxBytes.toLocaleString("en-US")}-byte inspection limit.`, "invalid");
    }
    let data;
    try { data = JSON.parse(raw); }
    catch {
      throw new RequestError(response.ok ? "The controller returned invalid JSON." : `The controller returned HTTP ${response.status}.`, response.ok ? "invalid" : "http", response.status);
    }
    if (!response.ok) throw new RequestError(typeof data?.error === "string" ? data.error : `The controller returned HTTP ${response.status}.`, "http", response.status);
    return data;
  } catch (error) {
    if (signal?.aborted || error instanceof RequestError) throw error;
    throw new RequestError(timedOut ? "The controller did not respond within 8 seconds." : "The local controller could not be reached.");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function validateState(next) {
  const validTasks = Array.isArray(next?.tasks) && next.tasks.every((task) =>
    typeof task?.id === "string" && taskStates.has(task.state) && typeof task.attempt === "string"
    && task.record && typeof task.record === "object" && (task.published == null || typeof task.published === "boolean")
    && (task.definition == null || (typeof task.definition.reference === "string" && typeof task.definition.sha256 === "string")));
  const validEvents = Array.isArray(next?.events) && next.events.every((event) =>
    event && typeof event.event === "string" && typeof event.sequence === "number" && typeof event.at === "string"
    && (event.task_ids == null || (Array.isArray(event.task_ids) && event.task_ids.every(id => typeof id === "string"))));
  const db = next?.database;
  const validDatabase = db == null || (Number.isSafeInteger(db.sequence) && typeof db.at === "string"
    && typeof db.launch_id === "string" && db.tool === "db_list" && Array.isArray(db.commands)
    && db.commands.every((command) => typeof command === "string") && db.response?.ok === true
    && Number.isSafeInteger(db.response.count) && Array.isArray(db.response.rows)
    && db.response.rows.every((row) => row && ["id", "value", "tag", "content"].every((key) => typeof row[key] === "string"))
    && new Set(db.response.rows.map((row) => row.id)).size === db.response.rows.length);
  const playback = next?.playback;
  const validPlayback = playback == null || (["playing", "paused", "finished", "error"].includes(playback.status)
    && typeof playback.scene?.id === "string" && typeof playback.scene.title === "string"
    && typeof playback.scene.description === "string" && typeof playback.scene.focus === "string"
    && Number.isInteger(playback.index) && Number.isInteger(playback.total) && playback.index >= 0 && playback.index < playback.total
    && Number.isFinite(playback.duration_ms) && Number.isFinite(playback.remaining_ms) && typeof playback.transitioning === "boolean");
  if (!next || !phases.has(next.phase) || typeof next.csrf_token !== "string" || !next.csrf_token
      || !validTasks || !validEvents || !validDatabase || !validPlayback || !validConversation(next.conversation)
      || (next.run !== null && typeof next.run?.id !== "string")
      || (next.run?.workflow != null && !isConversationWorkflow(next.run.workflow))
      || new Set(next.tasks.map((task) => task.id)).size !== next.tasks.length) {
    throw new RequestError("The controller returned an incomplete or invalid state.", "invalid");
  }
  return next;
}

function acceptState(next) {
  validateState(next);
  const hadState = state !== null;
  const runChanged = runIdentity() !== runIdentity(next);
  const freshEvents = hadState && !runChanged ? next.events.filter((event) => !previousEventKeys.has(eventKey(event))) : [];
  if (runChanged) {
    if (ui.dialog.open) ui.dialog.close();
    const focusRemoved = [ui.files, ui.decodedRows, ui.messages, ui.jobs, ui.memoryCells].some((node) => node.contains(document.activeElement));
    cancelArtifact();
    cancelDefinition();
    selectedTaskId = null;
    artifactView = null;
    definitionView = null;
    lastConversation = null;
    selectedOverviewReply = null;
    overviewMessageNodes.clear();
    ui.overviewMessages.replaceChildren();
    ui.overviewReplyScroll.scrollTop = 0;
    memoryNodes.clear();
    ui.memoryCells.replaceChildren();
    artifactCache.clear();
    definitionCache.clear();
    messageNodes.clear();
    jobNodes.clear();
    ui.messages.replaceChildren();
    ui.jobs.replaceChildren();
    observedFiles.clear();
    publicationRevisions.clear();
    recordNodes.clear();
    fileNodes.clear();
    taskNodes.clear();
    eventNodes.clear();
    ui.files.replaceChildren();
    ui.decodedRows.replaceChildren();
    ui.databaseRows.replaceChildren();
    workers.forEach((worker) => { worker.signature = null; });
    if (focusRemoved) focusPrimary();
  }
  for (const event of next.events) {
    if (event.event === "artifact_published" && event.task_id) publicationRevisions.set(event.task_id, eventKey(event));
  }
  const replyIds = new Set(isConversation(next) ? (next.conversation?.messages ?? []).map((message) => message.task_id) : []);
  for (const task of next.tasks) {
    if (task.published || (task.state === "completed" && task.artifact) || replyIds.has(task.id)) {
      observedFiles.set(task.id, { task, attempt: task.attempt, revision: publicationRevisions.get(task.id) ?? null });
    }
  }
  if (isConversation(next) && next.conversation) lastConversation = next.conversation;
  if (isConversation(next) && (runChanged || activePhases.has(next.phase)
    || ["playing", "paused"].includes(next.playback?.status))) {
    selectedWorkflow = conversationWorkflow(next.conversation ?? lastConversation, next.run).kind;
  }
  if (runChanged && isConversation(next)) {
    ui.topic.value = next.conversation?.topic ?? next.run.topic ?? ui.topic.value;
    ui.topic.removeAttribute("aria-invalid");
    ui.topicError.hidden = true;
  }
  state = next;
  connected = true;
  connectionError = null;
  previousEventKeys = new Set(next.events.map(eventKey));
  render({ highlight: hadState && !runChanged, freshEvents });
}

function markDisconnected(error) {
  connected = false;
  connectionError = error.message || "The controller could not be read.";
  render();
}

function actionAllowed(kind) {
  if (!connected || !state?.csrf_token) return false;
  if (kind === "reset") return true;
  if (["conversation", "storage"].includes(kind)) return !workInFlight();
  if (kind === "pause") return Boolean((isConversation() || state.run?.story)
    && state.playback?.status === "playing" && !verifiedReplay());
  if (kind === "play") {
    if (isConversation()) return state.playback?.status === "paused" && !state.playback.transitioning;
    if (incompatibleRun()) return false;
    if (verifiedReplay()) return !workInFlight();
    if (state.run?.story && state.playback?.status === "paused") return !state.playback.transitioning;
    return !workInFlight();
  }
  if (kind === "interrupt") return state.pid != null && ["running", "paused"].includes(state.phase);
  if (storyOngoing()) return false;
  if (kind === "run") return !workInFlight();
  if (kind === "resume") return Boolean(state.run && !workInFlight() && ["interrupted", "error", "finished"].includes(state.phase));
  if (kind === "next") return Boolean(state.run?.guided && !state.run.story && state.phase === "paused" && state.checkpoint?.id);
  return false;
}

function schedulePoll(delay = POLL_DELAY) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(() => { pollTimer = null; void poll(); }, delay);
}

function poll() {
  if (pollInFlight || activeAction) return pollInFlight;
  clearTimeout(pollTimer);
  pollTimer = null;
  pollInFlight = (async () => {
    try { acceptState(await requestJSON("/api/state")); }
    catch (error) { markDisconnected(error); }
    finally {
      pollInFlight = null;
      renderControls();
      if (!activeAction) schedulePoll(connected ? POLL_DELAY : 1500);
    }
  })();
  renderControls();
  return pollInFlight;
}

async function performAction(kind, options = {}) {
  if (activeAction || !actionAllowed(kind)) return;
  const payload = kind === "next" ? { checkpoint: state.checkpoint.id } : options;
  const trigger = document.activeElement;
  activeAction = kind;
  actionError = null;
  clearTimeout(pollTimer);
  pollTimer = null;
  renderControls();
  renderStory();
  renderNotices();
  // Drain an older GET before posting so it cannot overwrite the command response.
  if (pollInFlight) await pollInFlight;
  try {
    if (!actionAllowed(kind) || (kind === "next" && state.checkpoint?.id !== payload.checkpoint)) {
      throw new RequestError("The run changed before this command could be sent.", "http", 409);
    }
    acceptState(await requestJSON(`/api/${kind}`, { method: "POST", body: payload, token: state.csrf_token }));
  } catch (error) {
    if (error.status === 409) {
      actionError = "The run changed before the command was accepted. Refreshing its state; no command will be repeated automatically.";
      try { acceptState(await requestJSON("/api/state")); }
      catch (refreshError) { markDisconnected(refreshError); }
    } else if (error.kind === "http") {
      actionError = error.message;
    } else {
      markDisconnected(error);
      actionError = `${error.message} The command may already have reached the controller. It will not be sent again automatically.`;
    }
  } finally {
    activeAction = null;
    renderControls();
    renderStory();
    renderNotices();
    if (document.activeElement === document.body) {
      if (trigger?.isConnected && !trigger.disabled && trigger.getClientRects().length) trigger.focus({ preventScroll: true });
      else focusPrimary();
    }
    schedulePoll(100);
  }
}

function renderControls() {
  const busy = activeAction !== null;
  ui.reset.disabled = busy || !actionAllowed("reset");
  ui.resetConfirm.disabled = ui.reset.disabled;
  text(ui.resetConfirm, activeAction === "reset" ? "Resetting..." : "Reset demo");
  ui.play.disabled = busy || !actionAllowed(primaryAction());
  ui.storageStart.disabled = busy || !actionAllowed("storage");
  ui.start.disabled = busy || !actionAllowed("run");
  ui.interrupt.disabled = busy || !actionAllowed("interrupt");
  ui.resume.disabled = busy || !actionAllowed("resume");
  ui.next.disabled = busy || !actionAllowed("next");
  ui.next.hidden = !state?.run?.guided || Boolean(state.run.story) || isConversation();
  for (const input of [ui.taskCount, ui.workDelay, ui.guided]) input.disabled = ui.start.disabled;
  ui.retryConnection.disabled = busy || Boolean(pollInFlight);
  text(ui.retryConnection, pollInFlight ? "Reading controller..." : "Retry connection");
  text(ui.start, activeAction === "run" ? "Starting..." : "New run");
  text(ui.interrupt, activeAction === "interrupt" ? "Stopping..." : "Stop runtime");
  text(ui.storageStart, activeAction === "storage" ? "Starting..." : "Storage-only demo");
  text(ui.resume, activeAction === "resume" ? "Reopening..." : state?.phase === "finished" ? "Check replay" : "Reopen run");
  text(ui.next, activeAction === "next" ? "Continuing..." : "Next checkpoint");
  const messages = { conversation: "Starting a fresh conversation. Rust will execute the saved jobs using the local model.", storage: "Starting a fresh storage story in a separate run folder.", play: "Resuming server-timed playback.", pause: "Requesting a pause. The current operation may finish at its safe checkpoint.", run: "Starting an independent Rust run.", interrupt: "Stopping this run's real runtime. Its files and database are kept.", resume: "Reopening the existing run and reading its durable state.", next: "Advancing only the checkpoint selected by your click." };
  text(ui.actionStatus, activeAction === "reset" ? "Stopping playback and clearing this view. Saved runs are kept; no new model call starts." : messages[activeAction] ?? "");
  text(ui.controlNote, !connected ? "Commands are disabled until the local controller is reachable."
    : busy ? "Waiting for the current command. No duplicate command is sent."
      : storyOngoing() ? "Playback is still in flight. Pause holds at a safe checkpoint; Stop runtime is available only while Rust is running. Saved work is kept."
        : state.phase === "starting" || state.phase === "stopping" ? "Wait for the runtime to reach a safe state before sending another command."
          : state.phase === "paused" ? "A real manual checkpoint is held. Next advances exactly this checkpoint; Stop terminates the runtime."
            : state.run && !workInFlight() ? "No runtime or playback is active. Reopen uses the saved folder. New run preserves previous folders."
              : "Stop terminates the real runtime. Reopen uses the same folder. New run preserves previous folders.");
  renderConversationControls();
}

function renderConversationControls() {
  const kind = conversationAction();
  const busy = activeAction !== null;
  ui.conversationStart.disabled = busy || !actionAllowed(kind);
  attribute(ui.conversationStart, "data-action", kind);
  attribute(ui.conversationForm, "aria-busy", busy);
  ui.workflow.disabled = busy || kind !== "conversation" || !actionAllowed("conversation");
  for (const choice of workflowChoices) choice.checked = choice.value === selectedWorkflow;
  text(ui.workflowLegend, isConversation() && ui.workflow.disabled ? "Saved demo" : "Demo for next run");
  text(ui.workflowHelp, !connected ? "Waiting for the controller. No run is changed."
    : ui.workflow.disabled ? "Reset demo to choose another. Saved files stay."
      : isConversation() ? "Next run only. This saved conversation stays."
        : "Choose a demo, then Start. Same local model.");
  text(ui.conversationButton, activeAction === "conversation" ? "Starting..." : activeAction === "pause" ? "Pausing..."
    : activeAction === "play" ? "Resuming..." : activeAction === "resume" ? "Reopening..."
      : kind === "pause" ? "Pause" : kind === "play" ? "Resume" : kind === "resume" ? "Reopen conversation"
        : isConversation() && state.phase === "finished" ? "New conversation"
          : isConversation() && activePhases.has(state.phase) ? "Conversation active" : "Start conversation");
  text(ui.conversationIcon, kind === "pause" ? "Ⅱ" : "▶");
  ui.topic.readOnly = kind !== "conversation" || busy || (isConversation() && activePhases.has(state.phase));
  const pizza = ui.topic.value.trim() === DEFAULT_TOPIC;
  text(ui.topicHelp, ui.topic.readOnly ? "Saved mission. Resume keeps the same instructions and history."
    : pizza ? "Eight short replies. A broken oven. A real process crash." : "1-400 characters. Eight replies, with a real crash halfway through.");
  let note = "One click. The rest is automatic.";
  if (!connected) note = state ? "Controller offline. Reconnecting..." : "Connecting to the local controller.";
  else if (busy) note = activeAction === "pause" ? "Pausing. In-flight model calls may finish first." : "Waiting for the controller.";
  else if (!isConversation() && workInFlight()) note = "Storage run active. Follow it below.";
  else if (!isConversation() && state.run) note = "Starts fresh. Previous run files are kept.";
  else if (kind === "pause") note = "Automatic playback. Pause for more reading time.";
  else if (kind === "play") note = state.playback.transitioning ? "Finishing the current operation." : "Paused. Resume continues this conversation.";
  else if (kind === "resume") note = "Reopen the saved jobs and replies.";
  else if (isConversation() && activePhases.has(state.phase)) note = "Runtime active. Waiting for its next checkpoint.";
  else if (isConversation() && state.phase === "finished") note = "Choose the next demo, or Reset to clear this view. This run is kept.";
  text(ui.conversationControl, note);
  attribute(ui.conversationControl, "data-essential", !connected || busy || (!isConversation() && workInFlight())
    || kind === "resume" || Boolean(state?.playback?.transitioning));
}

function inspectorButton(label, id, definition = false) {
  const button = element("button", "message-inspect", label);
  button.type = "button";
  button.dataset[definition ? "definitionId" : "taskId"] = id;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", "artifact-dialog");
  return button;
}

function newMessageNode(message) {
  const root = element("li", "conversation-message");
  root.dataset.messageId = message.task_id;
  const heading = element("div", "message-heading");
  const speaker = element("h3", "message-speaker");
  const turn = element("span", "message-turn");
  const saved = element("span", "message-saved", "Disk saved");
  const committed = element("span", "message-commit");
  heading.append(speaker, turn, saved, committed);
  const body = element("p", "message-text");
  const footer = element("div", "message-footer");
  const inputs = element("span", "message-inputs");
  const metrics = element("span", "message-metrics");
  const reused = element("span", "message-reused", "Reused saved reply");
  const job = inspectorButton("Saved job & inputs", message.task_id, true);
  const file = inspectorButton("Reply JSON", message.task_id);
  footer.append(inputs, metrics, reused, job, file);
  root.append(heading, body, footer);
  return { root, speaker, turn, committed, body, inputs, metrics, reused, job, file };
}

function renderMessages(snapshot) {
  const messages = snapshot?.messages ?? [];
  const total = snapshot?.turns_total ?? state?.run?.tasks ?? 8;
  const atEnd = ui.conversationScroll.scrollHeight - ui.conversationScroll.scrollTop - ui.conversationScroll.clientHeight < 64;
  const previousIds = new Set(messageNodes.keys());
  const ids = new Set(messages.map((message) => message.task_id));
  for (const id of messageNodes.keys()) if (!ids.has(id)) messageNodes.delete(id);
  const nodes = messages.map((message) => {
    let entry = messageNodes.get(message.task_id);
    if (!entry) { entry = newMessageNode(message); messageNodes.set(message.task_id, entry); }
    attribute(entry.root, "data-speaker", message.agent_id);
    attribute(entry.root, "data-committed", message.committed);
    attribute(entry.root, "data-reused", message.reused);
    text(entry.speaker, message.agent_name);
    text(entry.turn, `Turn ${message.task_id} / ${total}`);
    text(entry.committed, message.committed ? "asmDB completed" : "Completion pending");
    text(entry.body, message.text);
    text(entry.inputs, message.input_ids.length ? `Inputs: turns ${message.input_ids.join(", ")}` : "Input: saved topic");
    const metrics = [];
    if (Number.isFinite(message.completion_tokens)) metrics.push(`${message.completion_tokens} output tokens`);
    if (Number.isFinite(message.duration_ms)) metrics.push(`${(message.duration_ms / 1000).toFixed(1)}s`);
    text(entry.metrics, metrics.join(" · "));
    entry.reused.hidden = !message.reused;
    const task = state?.tasks.find((item) => item.id === message.task_id) ?? observedFiles.get(message.task_id)?.task;
    entry.job.hidden = !task?.definition;
    entry.file.hidden = !task;
    attribute(entry.job, "aria-label", `Inspect saved job and inputs for turn ${message.task_id}, ${message.agent_name}`);
    attribute(entry.file, "aria-label", `Inspect actual reply JSON for turn ${message.task_id}, ${message.agent_name}`);
    return entry.root;
  });
  reconcileChildren(ui.messages, nodes);
  ui.conversationEmpty.hidden = messages.length > 0;
  ui.latestReply.hidden = messages.length === 0;
  if (messages.some((message) => !previousIds.has(message.task_id)) && atEnd && !ui.conversationScroll.contains(document.activeElement)) {
    ui.conversationScroll.scrollTop = ui.conversationScroll.scrollHeight;
  }
}

function renderConversationJobs(snapshot) {
  const tasks = isConversation() ? state.tasks.filter((task) => task.definition).sort((a, b) => collator.compare(a.id, b.id)) : [];
  const ids = new Set(tasks.map((task) => task.id));
  for (const id of jobNodes.keys()) if (!ids.has(id)) jobNodes.delete(id);
  const nodes = tasks.map((task) => {
    let entry = jobNodes.get(task.id);
    if (!entry) {
      const root = element("li");
      const button = inspectorButton(`Turn ${task.id} job`, task.id, true);
      root.append(button);
      entry = { root, button };
      jobNodes.set(task.id, entry);
    }
    attribute(entry.button, "aria-label", `Inspect saved job definition and inputs for turn ${task.id}`);
    return entry.root;
  });
  reconcileChildren(ui.jobs, nodes);
  ui.jobsEmpty.hidden = tasks.length > 0;
  const messages = snapshot?.messages ?? [];
  text(ui.savedSummary, snapshot ? `${messages.length} disk-saved replies / ${messages.filter((message) => message.committed).length} asmDB-completed` : "Not observed yet");
  text(ui.savedTopic, snapshot?.topic ?? "Not read yet");
  const workflow = conversationWorkflow(snapshot, isConversation() ? state.run : null);
  text(byId("conversation-workflow"), isConversation()
    ? `${workflow.kind} / v${workflow.version}${snapshot?.workflow || state.run.workflow ? "" : " (legacy plan)"}`
    : "Not read yet");
  text(ui.definitionFile, snapshot?.definition_file ?? "Not read yet");
  text(ui.definitionHash, snapshot?.definition_sha256 ?? "Not read yet");
  text(ui.modelDigest, snapshot?.model.digest ?? "Not read yet");
}

// Track each reported branch independently; a saved reply is not a linear execution cursor.
function renderConversation() {
  const current = isConversation();
  const snapshot = conversationSnapshot();
  const messages = snapshot?.messages ?? [];
  const activeTurns = conversationActiveTurns(snapshot);
  const discussion = displayedWorkflow().kind === "conversation.discussion";
  const playback = current ? state.playback : null;
  const liveProcess = hasLiveConversationProcess();
  const stopped = current && ["interrupted", "error", "stopping"].includes(state.phase);
  const retained = current && (!connected || !state.conversation || ["starting", "stopping", "interrupted", "error"].includes(state.phase));
  const liveTurns = liveProcess && !retained ? conversationActiveTurns(state.conversation) : [];
  const generating = liveTurns.some(turn => turn.stage === "generating");
  const total = snapshot?.turns_total ?? (current ? state.run.tasks : 8);
  const retries = activeTurns.map(turn => ({ turn, task: state?.tasks.find(task => task.id === turn.task_id) }))
    .filter(({ task }) => task && wasRetried(task.attempt));
  const scene = playback?.scene;
  if (current) {
    attribute(ui.stage, "data-focus", playback?.scene.focus ?? "");
    attribute(ui.stage, "data-scene", playback?.scene.id ?? "idle");
  }
  text(ui.model, snapshot?.model.name ?? (current ? state.run.model : null) ?? DEFAULT_MODEL);
  attribute(ui.roster, "data-runtime", !connected && current ? "unknown" : stopped ? "stopped" : liveProcess ? "active" : "idle");
  for (const agent of agents) {
    const definition = snapshot?.agents.find((item) => item.id === agent.id) ?? DEFAULT_AGENTS.find((item) => item.id === agent.id);
    text(agent.name, definition.name);
    text(agent.role, definition.role);
    attribute(agent.portrait, "aria-label", `${definition.name} robot portrait`);
    const replies = messages.filter((message) => message.agent_id === agent.id);
    let status = !current ? "Ready" : discussion ? "Waiting for dependencies" : "Waiting for turn";
    let key = "ready";
    if (replies.length) { status = `${replies.length} ${replies.length === 1 ? "reply" : "replies"} saved`; key = "saved"; }
    const active = liveTurns.find(turn => turn.agent_id === agent.id);
    if (active) {
      key = active.stage;
      status = active.stage === "generating" ? `Generating turn ${active.task_id}` : active.stage === "saved" ? "Reply saved, completing" : `Turn ${active.task_id} assigned`;
    }
    if (current && state.phase === "starting") { status = "Opening saved jobs"; key = "waiting"; }
    if (current && state.phase === "finished") { status = verifiedReplay() ? "No new model call" : "Finished"; key = "finished"; }
    if (stopped) { status = state.phase === "stopping" ? "Stopping" : "Stopped"; key = "stopped"; }
    if (!connected && current) { status = "Last observed"; key = "unknown"; }
    text(agent.status, status);
    attribute(agent.root, "data-state", key);
  }
  const pizza = (snapshot?.topic ?? ui.topic.value.trim()) === DEFAULT_TOPIC;
  text(ui.conversationTitle, scene?.title ?? (stopped ? "Conversation stopped" : current ? "Opening saved work" : pizza ? "Can they save pizza night?" : "The team has a mission."));
  text(ui.conversationDescription, scene?.description ?? (current ? "Reading saved jobs and replies from this run."
    : discussion ? "Planner seeds the debate. Builder, Critic and Editor exchange in parallel rounds, then Editor synthesizes. Each round waits for all three replies."
      : "Four roles, one local model. Each agent reads the previous replies."));
  text(ui.conversationTurn, discussion ? `${messages.length} / ${total} saved${liveTurns.length ? ` · ${liveTurns.length} active` : ""}`
    : `${current ? activeTurns[0]?.task_id ?? messages.length : 0} / ${total}`);
  text(ui.conversationRuntime, !current ? "Not started" : !connected ? "Process unconfirmed" : state.phase === "stopping" ? "Stopping Rust" : stopped ? "Rust stopped"
    : state.phase === "starting" ? "Opening runtime" : state.phase === "finished" ? "Rust finished"
      : liveProcess ? `${playback?.status === "paused" ? "Paused" : "Running"}${detailMode === "deep" ? ` / PID ${state.pid}` : ""}` : "Awaiting runtime");
  attribute(ui.conversationRuntime, "data-tone", stopped && connected ? "danger" : liveProcess ? "rust" : verifiedReplay() && current ? "success" : "neutral");
  const chapter = conversationChapter(scene?.id, current ? state.tasks : []);
  for (const item of chatChapters) {
    const index = Number(item.dataset.chatChapter);
    if (index === chapter) attribute(item, "aria-current", "step");
    else item.removeAttribute("aria-current");
    attribute(item, "data-past", index < chapter);
  }
  text(byId("conversation-clock"), !current ? "Automatic" : !connected ? "Offline" : verifiedReplay() ? "Verified"
    : playback?.status === "paused" ? "Paused" : generating ? "Generating..."
      : playback?.remaining_ms > 0 ? `Next in ${Math.ceil(playback.remaining_ms / 1000)}s` : stopped ? "Stopped" : state.phase === "finished" ? "Finished" : "Working...");
  let activity = "Local inference through Ollama. No scripted replies.";
  if (current) {
    if (!connected) activity = "Disconnected. Live activity cannot be confirmed.";
    else if (state.phase === "stopping") activity = "Stopping Rust. Saved replies stay visible.";
    else if (stopped) activity = "Process stopped. Showing the last observed replies.";
    else if (state.phase === "starting" || !state.conversation) activity = "Reading saved instructions and conversation history...";
    else if (verifiedReplay()) activity = "Reopened and checked. No new model calls.";
    else if (liveTurns.length) {
      activity = liveTurns.map(turn => `${agentName(snapshot, turn.agent_id)}: turn ${turn.task_id} ${turn.stage}; input ${turnInputs(turn)}`).join(" · ");
      if (discussion && generating) activity += ". Debate requests launch together; the local provider may queue inference.";
    }
    else if (playback?.status === "paused") activity = "Paused. Take your time; saved replies stay here.";
    else if (state.phase === "finished") activity = playback?.status === "playing" ? "All replies saved. Next: restart and verify." : "Conversation finished. All replies are on disk.";
    else activity = "Waiting for the next runtime event.";
  }
  text(ui.conversationActivity, activity);
  attribute(ui.conversationActivity, "data-generating", generating);
  attribute(ui.conversationProvenance.parentElement, "data-retained", retained);
  text(ui.conversationProvenance, !snapshot ? "Reply files appear here after publication." : retained
    ? "Last observed files. Awaiting a fresh read." : "Real reply files. Saved ≠ committed.");
  const emptyTitle = !current ? pizza ? "Dinner needs a plan." : "Give the team a problem." : stopped ? "Stopped before the first reply." : "The team is thinking.";
  text(ui.conversationEmpty.querySelector("h3"), emptyTitle);
  text(ui.conversationEmpty.querySelector("p"), !current ? "Press Start conversation. Watch the agents talk while asmDB keeps their work."
    : stopped ? "Reopen to read the saved jobs." : "Waiting for a complete local-model reply. Nothing is prewritten.");
  ui.recovery.hidden = !current || !(stopped || retries.length || (state.phase === "starting" && messages.length));
  text(ui.recoveryNote, stopped ? `${messages.length} replies retained on screen. Reopening will verify them from disk.`
    : retries.length ? retries.map(({ turn, task }) => `Turn ${turn.task_id}, attempt ${task.attempt}. Same saved job; input ${turnInputs(turn)}.`).join(" ")
      : "Rereading the saved jobs and replies, not starting over.");
  ui.conversationVerified.hidden = !current || !verifiedReplay();
  text(ui.conversationReused, current && verifiedReplay() ? `${messages.length} replies checked from disk` : "");
  renderMessages(snapshot);
  renderConversationJobs(snapshot);
}

function renderOverview() {
  const current = isConversation();
  const snapshot = conversationSnapshot();
  const messages = snapshot?.messages ?? [];
  const total = snapshot?.turns_total ?? (current ? state.run.tasks : 8);
  const workflow = displayedWorkflow();
  const discussion = workflow.kind === "conversation.discussion";
  const rounds = snapshot?.rounds ?? (current ? state.run.rounds : null) ?? 2;
  const liveTurns = hasLiveConversationProcess() && state.conversation ? conversationActiveTurns(state.conversation) : [];
  const generatingTurns = liveTurns.filter(turn => turn.stage === "generating");
  const savedTurns = liveTurns.filter(turn => turn.stage === "saved");
  const assignedTurns = liveTurns.filter(turn => turn.stage === "assigned");
  const latestLaunch = currentProcessEvents().find(event => event.event === "launching");
  const awaitingNativeRead = Boolean(state?.database && latestLaunch && Date.parse(state.database.at) < Date.parse(latestLaunch.at));
  const retained = current && (!connected || !state.conversation || awaitingNativeRead || ["starting", "stopping", "interrupted", "error"].includes(state.phase));
  const topic = snapshot?.topic ?? (current ? state.run.topic : ui.topic.value.trim());
  const pizza = topic === DEFAULT_TOPIC;
  const cells = conversationMemory(snapshot, current ? state.database?.response : null, total);
  let index = messages.findIndex(message => message.task_id === selectedOverviewReply);
  if (index < 0) { selectedOverviewReply = null; index = messages.length - 1; }
  const message = messages[index];
  const scene = current ? state.playback?.scene.id : null;
  const chapter = conversationChapter(scene, current ? state.tasks : []);
  const verified = current && verifiedReplay();

  const topology = discussion
    ? `Planner seed → Builder / Critic / Editor in parallel × ${rounds} shared ${rounds === 1 ? "round" : "rounds"} → Editor synthesis.`
    : `Planner → Builder → Critic → Editor · ${rounds} ${rounds === 1 ? "round" : "rounds"}, one role at a time.`;
  text(ui.workflowTitle, `${discussion ? "Discussion" : "Relay"} · ${current ? "saved run" : "next run"}`);
  text(ui.workflowDescription, topology);
  ui.workflowChain.toggleAttribute("hidden", discussion);
  ui.workflowDiscussion.toggleAttribute("hidden", !discussion);
  attribute(ui.overviewRoster, "data-workflow", workflow.kind);
  attribute(ui.overviewRoster, "aria-label", topology);
  attribute(ui.roster, "aria-label", topology);
  text(ui.overviewTitle, pizza ? "Can they save pizza night?" : "The team has a mission.");
  text(ui.overviewTopic, pizza ? "Eight friends. $40. One oven." : topic || "Give the team a problem in Details.");
  let status = "Ready when you are.";
  if (!connected) status = state ? "Offline. Last observed replies." : "Connecting...";
  else if (current) {
    if (state.phase === "error") status = "Runtime error. Saved work is kept.";
    else if (state.phase === "stopping") status = "Stopping the runtime...";
    else if (state.phase === "interrupted") status = "Runtime stopped. Memory stays.";
    else if (state.phase === "starting" || !state.conversation) status = "Reading saved work...";
    else if (verified) status = "Replay verified.";
    else if (generatingTurns.length) status = `${activeAgentNames(snapshot, generatingTurns)} ${generatingTurns.length === 1 ? "is" : "are"} thinking...`;
    else if (state.playback?.status === "paused") status = "Paused. Take your time.";
    else if (state.phase === "finished") status = state.playback?.status === "playing" ? "Checking what survived..." : "Conversation finished.";
    else if (scene === "chat-crash-next") status = "Next up: a real process crash.";
    else if (savedTurns.length) status = `${activeAgentNames(snapshot, savedTurns)}: ${savedTurns.length === 1 ? "reply" : "replies"} saved.`;
    else if (assignedTurns.length) status = `${activeAgentNames(snapshot, assignedTurns)}: assigned.`;
    else status = discussion ? "Waiting for the next round or synthesis." : "Passing the conversation along.";
  }
  text(ui.overviewStatus, status);
  attribute(ui.overview, "data-retained", retained);
  for (const agent of overviewAgents) {
    const definition = snapshot?.agents.find(item => item.id === agent.id) ?? DEFAULT_AGENTS.find(item => item.id === agent.id);
    const active = liveTurns.find(turn => turn.agent_id === agent.id);
    const thinking = active?.stage === "generating";
    const selected = message?.agent_id === agent.id;
    text(agent.name, definition.name);
    text(agent.status, thinking ? "Thinking..." : active?.stage === "assigned" ? "Assigned" : active?.stage === "saved" ? "Reply saved"
      : selected ? index === messages.length - 1 ? "Latest reply" : `Reply ${message.task_id}` : "");
    attribute(agent.root, "data-active", Boolean(active));
    attribute(agent.root, "data-thinking", thinking);
    attribute(agent.root, "data-selected", selected);
  }
  // Reuse every reply node and exact text; polling never collapses the transcript or steals its focus.
  const scroll = ui.overviewReplyScroll;
  const previousLatest = ui.overviewMessages.lastElementChild?.dataset.replyId;
  const follow = selectedOverviewReply === null && !scroll.contains(document.activeElement)
    && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48;
  const replyIds = new Set(messages.map(reply => reply.task_id));
  for (const id of overviewMessageNodes.keys()) if (!replyIds.has(id)) overviewMessageNodes.delete(id);
  const replies = messages.map(reply => {
    let entry = overviewMessageNodes.get(reply.task_id);
    if (!entry) {
      const root = element("li", "conversation-message overview-message");
      root.dataset.replyId = reply.task_id;
      const speaker = element("h4", "message-speaker");
      const body = element("p", "message-text");
      root.append(speaker, body);
      entry = { root, speaker, body };
      overviewMessageNodes.set(reply.task_id, entry);
    }
    attribute(entry.root, "data-speaker", reply.agent_id);
    text(entry.speaker, reply.agent_name);
    text(entry.body, reply.text);
    return entry.root;
  });
  reconcileChildren(ui.overviewMessages, replies);
  ui.overviewMessage.hidden = messages.length > 0;
  text(ui.overviewMessage, current ? "Waiting for a complete reply. Nothing is prewritten." : "Press Start conversation. The robots take it from here.");
  ui.overviewNavigation.hidden = messages.length === 0;
  ui.overviewLatest.hidden = messages.length < 2;
  text(ui.overviewPosition, `${messages.length} ${messages.length === 1 ? "reply" : "replies"}`);
  if (previousLatest && previousLatest !== messages.at(-1)?.task_id && follow) scroll.scrollTop = scroll.scrollHeight;

  const labels = { committed: "Committed in asmDB", saved: "Reply saved; native completion not observed", assigned: "Assigned", waiting: "Pending", unobserved: "Not observed", unknown: "Unrecognized native record" };
  const marks = { committed: "✓", saved: "○", assigned: "…", waiting: "·", unobserved: "·", unknown: "?" };
  const nodes = cells.map(cell => {
    let entry = memoryNodes.get(cell.id);
    if (!entry) {
      const root = element("li");
      const button = element("button", "memory-cell");
      button.type = "button";
      button.dataset.overviewReply = cell.id;
      const turn = element("span", "memory-turn", cell.id);
      const mark = element("span", "memory-mark");
      mark.setAttribute("aria-hidden", "true");
      button.append(turn, mark);
      root.append(button);
      entry = { root, button, mark };
      memoryNodes.set(cell.id, entry);
    }
    entry.button.disabled = !cell.message;
    text(entry.mark, marks[cell.status]);
    attribute(entry.button, "data-state", cell.status);
    attribute(entry.button, "aria-pressed", Boolean(message && cell.id === message.task_id));
    attribute(entry.button, "aria-label", `Turn ${cell.id}.${cell.agent_id ? ` ${agentName(snapshot, cell.agent_id)}.` : ""} ${labels[cell.status]}.${cell.message ? ` Read ${cell.message.agent_name}'s reply.` : ""}`);
    return entry.root;
  });
  reconcileChildren(ui.memoryCells, nodes);
  const committed = cells.filter(cell => cell.status === "committed").length;
  const saved = cells.filter(cell => cell.status === "saved");
  const uncommitted = saved.filter(cell => !cell.message.committed).length;
  const awaitingRead = saved.length > uncommitted;
  text(ui.memoryCount, current && !state.database ? "?" : committed);
  text(ui.memoryTotal, total);
  attribute(ui.memory, "data-retained", retained);
  text(ui.memoryNote, retained ? "Last observed memory, not a live read."
    : cells.some(cell => cell.status === "unknown") ? "Some native records need inspection in Details."
      : uncommitted ? `${uncommitted} ${uncommitted === 1 ? "reply saved" : "replies saved"}, awaiting commit.${awaitingRead ? " Other completions await a DB read." : ""}`
        : awaitingRead ? "New completions appear on the next database read."
          : messages.length ? "Real reply files. Real asmDB records." : current ? "Waiting for the first saved reply." : "Nothing saved yet.");
  ui.overviewProof.hidden = !verified;
  for (const item of overviewJourney) {
    const step = Number(item.dataset.chatChapter);
    if (step === chapter && !verified) attribute(item, "aria-current", "step");
    else item.removeAttribute("aria-current");
    attribute(item, "data-past", step < chapter || verified);
    text(item.querySelector("span"), step < chapter || verified ? "✓" : step + 1);
  }
}

function renderStory() {
  const chat = isConversation();
  const playback = !chat && state?.run?.story ? state.playback : null;
  const verified = !chat && verifiedReplay();
  let title = "Workers stop. Work survives.";
  let description = "8 files. 4 Rust workers. One crash. Watch what survives.";
  if (playback) {
    title = playback.scene.title;
    description = playback.scene.description;
  } else if (incompatibleRun()) {
    title = chat ? "A conversation is active." : "A separate run is active.";
    description = chat ? "Follow it in Agent conversation. Starting a storage story never silently stops existing work."
      : actionAllowed("interrupt") ? "Stop that runtime to watch the timed story. Its database and files will be kept."
        : "Wait for the current runtime operation before starting the timed story. Its database and files will be kept.";
  } else if (chat) {
    title = "Try the storage demo.";
    description = "Eight deterministic file jobs, four Rust workers. A separate run, no model calls.";
  } else if (state?.run?.story) {
    title = "Your run can be reopened.";
    description = "Resume the timed story. The controller will reread asmDB before showing what survived.";
  }
  text(ui.sceneTitle, title);
  text(ui.sceneDescription, description);
  const kind = primaryAction();
  text(ui.playLabel, activeAction === "pause" ? "Pausing..." : ["play", "storage"].includes(activeAction) ? "Starting..."
    : kind === "pause" ? "Pause" : verified ? "Play again" : kind === "play" ? "Resume" : "Play");
  text(ui.playIcon, kind === "pause" ? "Ⅱ" : "▶");
  attribute(ui.play, "data-action", kind);
  let value = "~75s";
  let label = "start to finish";
  let hint = chat ? "Play starts a new storage story. The saved conversation is kept." : "One click. Everything else is timed.";
  if (playback) {
    value = `${Math.ceil(Math.max(0, playback.remaining_ms) / 1000)}s`;
    label = "to next cue";
    hint = playback.scene.next_label ? `Next: ${playback.scene.next_label}` : "The server advances the story automatically.";
    if (playback.status === "paused") {
      label = "remaining, paused";
      hint = "Resume continues the server timer.";
    }
    if (playback.transitioning || (playback.status === "playing" && playback.remaining_ms <= 0)) {
      value = "...";
      label = "applying cue";
      hint = playback.status === "paused" ? "Finishing the current operation, then holding at a safe checkpoint." : "Operation in progress. Waiting for the next real observation.";
    }
    if (playback.status === "error") {
      value = "Stopped";
      label = "playback error";
      hint = "Playback stopped safely. Read the error below before resuming.";
    }
  }
  if (verified) {
    value = "Done";
    label = "replay verified";
    hint = "Play again uses a new folder. This run is kept.";
  } else if (incompatibleRun()) hint = actionAllowed("interrupt")
    ? "Wait for the current run to finish, or explicitly stop its runtime first."
    : "The current sequence is still in flight. Follow it in its view; pause playback or wait for the current operation.";
  else if (!playback && !chat && state?.run?.story) hint = "Resume reopens the retained story.";
  if (!connected) {
    hint = state ? "Controller offline. Playback timing cannot be confirmed." : "Connecting to the local controller.";
    if (state) { value = "?"; label = "disconnected"; }
  } else if (["play", "storage"].includes(activeAction)) hint = "Starting or resuming the real runtime. Please wait.";
  else if (activeAction === "pause") hint = "Freezing the server timer at a safe checkpoint.";
  text(ui.countdown, value);
  text(ui.countdownLabel, label);
  text(ui.hint, hint);
  const chapter = playback ? sceneChapters[playback.scene.id] ?? -1 : -1;
  for (const item of chapters) {
    const index = Number(item.dataset.chapter);
    if (index === chapter) attribute(item, "aria-current", "step");
    else item.removeAttribute("aria-current");
    attribute(item, "data-past", index < chapter);
  }
  if (!chat) {
    attribute(ui.stage, "data-focus", playback?.scene.focus ?? "");
    attribute(ui.stage, "data-scene", playback?.scene.id ?? "idle");
  }
  attribute(ui.filesPanel, "data-focus", (chat ? state.playback : playback)?.scene.focus === "files");
  attribute(ui.play, "data-playback", playback?.status ?? "idle");
}

function renderNotices() {
  const retryHadFocus = ui.connectionError.contains(document.activeElement);
  ui.connectionError.hidden = !connectionError;
  if (connectionError) {
    text(ui.connectionErrorTitle, state ? "Controller connection lost" : "Controller unavailable");
    text(ui.connectionErrorMessage, `${connectionError} ${state ? "The last observations remain visible, not confirmed live activity." : "No task state has been invented."} Reconnecting automatically.`);
  } else if (retryHadFocus) focusPrimary();
  ui.actionError.hidden = !actionError;
  text(ui.actionErrorMessage, actionError ?? "");
  ui.serverError.hidden = !state?.error;
  text(ui.serverErrorMessage, state?.error ?? "");
}

function renderWorkers(highlight) {
  const tasks = state?.tasks ?? [];
  const awaitingPlay = unobservedLegacyRun();
  const offline = !awaitingPlay && ["interrupted", "error"].includes(state?.phase);
  const unknown = !connected && state !== null;
  attribute(ui.workersStage, "data-runtime", unknown ? "unknown" : awaitingPlay ? "idle" : offline ? "offline" : state?.phase ?? "idle");
  let process = awaitingPlay ? "Ready to start" : !state?.run ? "Not started" : state.phase === "paused" ? "At checkpoint" : state.phase === "running" ? "Rust live"
    : state.phase === "starting" ? "Opening runtime" : state.phase === "stopping" ? "Stopping runtime"
      : offline ? "Process offline" : state.phase === "finished" ? "Process finished" : "No live process";
  if (state?.pid != null && !offline && !awaitingPlay && connected) process += ` / PID ${state.pid}`;
  if (unknown) process = "Process unconfirmed";
  text(ui.process, process);
  attribute(ui.process, "data-tone", unknown || awaitingPlay ? "neutral" : offline ? "danger" : state?.phase === "finished" ? "success" : state?.pid ? "rust" : "neutral");
  const processEvents = currentProcessEvents();
  const checkpointIds = new Set(state?.checkpoint?.task_ids ?? []);
  for (const worker of workers) {
    let task = tasks.find((item) => item.owner === worker.owner && item.state === "running");
    if (!task && !["starting", "interrupted", "error"].includes(state?.phase)) {
      task = tasks.find((item) => item.owner === worker.owner && checkpointIds.has(item.id));
      if (!task) {
        const event = [...processEvents].reverse().find((item) => ["task_claimed", "task_completed"].includes(item.event)
          && tasks.some((candidate) => candidate.id === item.task_id && candidate.owner === worker.owner));
        if (event) task = tasks.find((item) => item.id === event.task_id);
      }
    }
    let key = "idle";
    let phase = awaitingPlay ? "Ready to start" : !state?.run ? "Not started" : "Waiting";
    if (task) {
      if (task.state === "completed") { key = "completed"; phase = "Committed"; }
      else if (task.published) { key = "written"; phase = "Written, not committed"; }
      else if (state.phase === "running") { key = "writing"; phase = "Writing"; }
      else { key = "assigned"; phase = "Assigned, waiting"; }
    }
    if (state?.phase === "starting") { key = "idle"; phase = "Opening runtime"; }
    if (state?.phase === "stopping") { key = "offline"; phase = "Stopping"; }
    if (offline) { key = "offline"; phase = "Offline"; }
    if (unknown) { key = "unknown"; phase = "Last observed"; }
    if (verifiedReplay()) { task = null; key = "completed"; phase = "No new work"; }
    const taskLabel = task ? `Task ${task.id}` : verifiedReplay() ? "Nothing to repeat" : "No assignment";
    const signature = JSON.stringify([task?.id, task?.attempt, key, phase]);
    text(worker.task, taskLabel);
    text(worker.phase, phase);
    text(worker.attempt, task ? `attempt ${task.attempt}` : "");
    attribute(worker.root, "data-state", key);
    attribute(worker.root, "data-task-id", task?.id ?? "");
    if (highlight && worker.signature !== null && worker.signature !== signature) flash(worker.root);
    worker.signature = signature;
  }
}

function newRecordNode(row) {
  const root = element("tr");
  root.dataset.recordId = row.id;
  const id = element("th", "", row.id);
  id.scope = "row";
  const value = element("td");
  const tag = element("td");
  const cell = element("td");
  const inspect = inspectorButton("", row.id);
  inspect.className = "record-inspect";
  attribute(inspect, "aria-label", `Inspect record ${row.id}, saved job and reply`);
  const content = element("span", "record-reference");
  const hashes = element("span", "record-hashes");
  inspect.append(content, hashes);
  cell.append(inspect);
  root.append(id, value, tag, cell);
  return { root, value, tag, content, hashes, inspect, signature: null };
}

function renderDatabase(highlight) {
  const db = state?.database;
  const latestLaunch = currentProcessEvents().find((event) => event.event === "launching");
  const awaitingRead = Boolean(db && latestLaunch && Date.parse(db.at) < Date.parse(latestLaunch.at));
  const retained = !connected || awaitingRead || ["starting", "stopping", "interrupted", "error"].includes(state?.phase);
  attribute(ui.database, "data-retained", Boolean(db && retained));
  attribute(ui.database, "data-sequence", db?.sequence ?? "");
  const raw = detailMode === "deep" && ui.rawRecords.checked;
  attribute(ui.database, "data-raw", raw);
  const rows = db?.response.rows ?? [];
  const ids = new Set(rows.map((row) => row.id));
  for (const id of recordNodes.keys()) if (!ids.has(id)) recordNodes.delete(id);
  const nodes = rows.map((row) => {
    let entry = recordNodes.get(row.id);
    if (!entry) { entry = newRecordNode(row); recordNodes.set(row.id, entry); }
    const signature = JSON.stringify([row.value, row.tag, row.content]);
    const fields = nativeRecordFields(row, raw, detailMode);
    text(entry.value, row.value);
    text(entry.tag, fields.tag);
    entry.tag.title = row.tag;
    text(entry.content, fields.content);
    text(entry.hashes, fields.hashes);
    entry.hashes.hidden = !fields.hashes;
    entry.inspect.title = row.content;
    entry.inspect.disabled = !state.tasks.some(task => task.id === row.id) && !observedFiles.has(row.id);
    attribute(entry.root, "data-state", fields.state);
    attribute(entry.root, "data-retried", wasRetried(row.value));
    if (highlight && signature !== entry.signature) flash(entry.root);
    entry.signature = signature;
    return entry.root;
  });
  reconcileChildren(ui.databaseRows, nodes);
  ui.databaseEmpty.hidden = rows.length > 0;
  text(ui.databaseReadCount, db ? `${db.response.count} rows` : "No read yet");
  text(ui.databaseCommands, db ? db.commands.join("  →  ") : "Awaiting db_list");
  let status = "Waiting for the first database read.";
  if (db) {
    status = !connected ? "Offline. Last observed listing."
      : state.phase === "interrupted" || state.phase === "error" ? "Rust stopped. Last listing retained; recovery will reread it."
        : state.phase === "starting" || awaitingRead ? "Reopening. Previous listing shown until the next read."
          : state.phase === "stopping" ? "Stopping Rust. Last observed records."
            : verifiedReplay() ? "Reread after restart. No new completions."
              : state.phase === "finished" ? "Runtime finished. Last SELECT * response."
                : "Real SELECT * rows. Native order, not chronological.";
  } else if (unobservedLegacyRun()) status = "Previous run kept. Ready for a new conversation.";
  else if (state?.run) status = "Run found. Waiting to read its database.";
  text(ui.databaseStatus, status);
  text(byId("database-provenance"), db && (retained || state?.phase === "finished") ? "Last SELECT * via MCP · same writer" : "SELECT * via MCP · same writer");
  const date = db ? new Date(db.at) : null;
  text(ui.databaseTime, db ? `Read #${db.sequence} at ${date && !Number.isNaN(date.getTime()) ? clock.format(date) : db.at}` : "Not observed");
  text(ui.databaseEmpty.querySelector("strong"), db ? "The database returned no rows." : "No records read yet.");
  text(ui.databaseEmpty.querySelector("p"), db ? "This is an empty response from the real database."
    : unobservedLegacyRun() ? "Play starts a fresh demo and reads its records."
      : state?.run ? "Reopening the runtime will read its existing task records." : "Play opens an isolated asmDB and starts the real runtime.");
}

function newFileNode(id) {
  const item = element("li");
  const button = element("button", "file-tile");
  button.type = "button";
  button.dataset.taskId = id;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", "artifact-dialog");
  const icon = element("span", "file-icon", "{}");
  icon.setAttribute("aria-hidden", "true");
  const info = element("span", "file-info");
  const name = element("code", "file-name", `${id}.json`);
  const label = element("span", "file-state");
  info.append(name, label);
  button.append(icon, info);
  item.append(button);
  return { item, button, label, signature: null };
}

function renderFiles(highlight) {
  const ids = [...observedFiles.keys()].sort(collator.compare);
  const retained = !connected || ["starting", "stopping", "interrupted", "error"].includes(state?.phase);
  const nodes = ids.map((id) => {
    let entry = fileNodes.get(id);
    if (!entry) { entry = newFileNode(id); fileNodes.set(id, entry); }
    const task = state?.tasks.find((item) => item.id === id);
    const replyObserved = isConversation() && state.conversation?.messages.some((message) => message.task_id === id);
    const key = retained || (!task?.published && !replyObserved && task?.state !== "completed") ? "retained" : task?.state === "completed" ? "completed" : "published";
    const label = key === "retained" ? "Seen earlier" : key === "completed" ? "Committed" : "Published";
    const observed = observedFiles.get(id);
    const signature = JSON.stringify([key, observed.attempt, observed.revision]);
    text(entry.label, label);
    attribute(entry.button, "data-state", key);
    attribute(entry.button, "aria-label", `Inspect ${id}.json. ${label}. Read the actual file.`);
    if (highlight && entry.signature !== signature) flash(entry.button);
    entry.signature = signature;
    return entry.item;
  });
  reconcileChildren(ui.files, nodes);
  text(ui.published, `${ids.length} / ${state?.run?.tasks ?? 8} observed`);
  ui.filesEmpty.hidden = ids.length > 0;
  text(ui.filesEmpty, state?.run ? "No publication has been observed for this run yet. Unseen does not mean absent." : "Nothing published yet. Files appear here only after an observation.");
  text(ui.filesNote, retained && ids.length ? "Previously observed files stay visible. Select one to reread its real JSON."
    : "Real JSON, outside asmDB. Select a published file to inspect it.");
  ui.verified.hidden = !verifiedReplay();
  text(byId("verified-note"), isConversation() ? "model_calls_now = 0. Saved replies were reused." : "No new completions after a real restart.");
}

function newTaskNode(task) {
  const root = element("tr");
  root.dataset.taskId = task.id;
  const id = element("td");
  const button = element("button", "task-selector", task.id);
  button.type = "button";
  button.dataset.taskId = task.id;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", "artifact-dialog");
  id.append(button);
  const stateCell = element("td");
  const owner = element("td");
  const attempt = element("td");
  const artifact = element("td");
  root.append(id, stateCell, owner, attempt, artifact);
  return { root, button, stateCell, owner, attempt, artifact };
}

function renderDecodedTasks() {
  const tasks = [...(state?.tasks ?? [])].sort((a, b) => collator.compare(a.id, b.id));
  const present = new Set(tasks.map((task) => task.id));
  for (const id of taskNodes.keys()) if (!present.has(id)) taskNodes.delete(id);
  const counts = { pending: 0, running: 0, completed: 0, retried: 0 };
  const nodes = tasks.map((task) => {
    counts[task.state] += 1;
    if (wasRetried(task.attempt)) counts.retried += 1;
    let entry = taskNodes.get(task.id);
    if (!entry) { entry = newTaskNode(task); taskNodes.set(task.id, entry); }
    text(entry.stateCell, task.state);
    text(entry.owner, task.owner ?? "Unassigned");
    text(entry.attempt, task.attempt);
    text(entry.artifact, task.artifact ?? "Not recorded");
    attribute(entry.button, "aria-label", `Inspect task ${task.id}, ${task.state}, attempt ${task.attempt}`);
    return entry.root;
  });
  reconcileChildren(ui.decodedRows, nodes);
  for (const key of Object.keys(counts)) text(ui[key], state?.run && !tasks.length ? "?" : counts[key]);
  text(ui.tasksTotal, tasks.length ? `${tasks.length} task observations${!connected ? ", last received" : ""}` : state?.run ? "Awaiting a real snapshot" : "No run");
  ui.decodedEmpty.hidden = tasks.length > 0;
}

function cancelArtifact() {
  artifactRequest?.controller.abort();
  artifactRequest = null;
}

function artifactKey(task) {
  const observed = observedFiles.get(task.id);
  return JSON.stringify([runIdentity(), task.id, observed?.attempt, observed?.revision, task.artifact]);
}

function selectedTask() {
  return state?.tasks.find((task) => task.id === selectedTaskId) ?? observedFiles.get(selectedTaskId)?.task ?? null;
}

function openInspector(id, trigger) {
  if (!state?.tasks.some((task) => task.id === id) && !observedFiles.has(id)) return;
  selectedTaskId = id;
  inspectorTrigger = trigger;
  if (connected && observedFiles.has(id)) {
    cancelArtifact();
    artifactView = { key: artifactKey(selectedTask()), status: "offline" };
  }
  if (connected && selectedTask()?.definition) {
    cancelDefinition();
    definitionView = { key: definitionKey(selectedTask()), status: "offline" };
  }
  if (!ui.dialog.open) {
    ui.dialog.showModal();
    ui.dialog.scrollTop = 0;
    ui.closeDialog.focus({ preventScroll: true });
  }
  renderInspector();
}

function renderInspector() {
  if (!ui.dialog.open) return;
  const task = selectedTask();
  if (!task) { ui.dialog.close(); return; }
  text(ui.dialogTitle, isConversation() ? `Turn ${task.id} / saved job & reply` : `Task ${task.id} / ${task.id}.json`);
  text(byId("artifact-reference-label"), isConversation() ? "Reply file SHA-256" : "Artifact reference");
  text(ui.detailState, task.state);
  text(ui.detailOwner, task.owner ?? "Unassigned");
  text(ui.detailAttempt, task.attempt);
  text(ui.artifactRef, task.artifact ?? "Not recorded");
  text(ui.record, JSON.stringify(task.record, null, 2));
  text(ui.detailNote, !connected ? "Last decoded observation. The controller is disconnected."
    : task.state === "completed" ? isConversation() ? "The completion records the reply file’s SHA-256. The executable job and full conversation text live in separate persisted JSON files."
      : "The completion records an external file reference. The JSON itself is not stored in this record."
      : task.published || (isConversation() && state.conversation?.messages.some((message) => message.task_id === task.id)) ? "The file was published, but this task has not yet been committed as completed."
        : task.state === "running" ? "This is a recorded assignment, not proof that a worker is currently computing."
          : "The task is waiting for a claim. A missing publication observation does not prove that no file exists.");
  if (!observedFiles.has(task.id)) {
    cancelArtifact();
    artifactView = { key: null, status: "waiting" };
  } else {
    const key = artifactKey(task);
    if (artifactView?.key !== key) {
      cancelArtifact();
      artifactView = artifactCache.has(key) ? { key, status: "ready", data: artifactCache.get(key) } : { key, status: "offline" };
    }
    if (artifactView.status === "offline" && connected) void loadArtifact(task, key);
  }
  renderArtifact();
  renderDefinition(task);
}

async function loadArtifact(task, key) {
  cancelArtifact();
  const controller = new AbortController();
  const request = { key, controller };
  artifactRequest = request;
  artifactView = { key, status: "loading" };
  renderArtifact();
  try {
    const data = await requestJSON(`/api/artifacts/${encodeURIComponent(task.id)}`, { signal: controller.signal, maxBytes: isConversation() ? CHAT_DOCUMENT_LIMIT : 4096 });
    if (controller.signal.aborted || artifactRequest !== request || artifactView?.key !== key || !ui.dialog.open) return;
    const formatted = JSON.stringify(data, null, 2);
    artifactCache.set(key, formatted);
    artifactView = { key, status: "ready", data: formatted };
  } catch (error) {
    if (controller.signal.aborted || artifactRequest !== request || artifactView?.key !== key) return;
    artifactView = { key, status: "error", error: error.message };
  } finally {
    if (artifactRequest === request) { artifactRequest = null; renderArtifact(); }
  }
}

function renderArtifact() {
  const status = artifactView?.status ?? "waiting";
  attribute(ui.artifactPayload, "data-status", status);
  attribute(ui.artifactPayload, "aria-busy", status === "loading");
  ui.artifactPre.hidden = status !== "ready";
  const retryFocused = document.activeElement === ui.artifactRetry;
  ui.artifactRetry.hidden = !["error", "offline"].includes(status);
  ui.artifactRetry.disabled = !connected;
  if (retryFocused && ui.artifactRetry.hidden) ui.closeDialog.focus({ preventScroll: true });
  text(ui.artifactJSON, status === "ready" ? artifactView.data : "");
  text(ui.artifactStatus, status === "loading" ? "Reading the actual JSON file..."
    : status === "ready" ? connected ? "Actual file content, read through the artifact endpoint." : "Previously read file content. The controller is offline."
      : status === "error" ? `File read failed: ${artifactView.error}`
        : status === "offline" ? "The file was observed earlier. Reconnect to read its contents."
          : "No publication has been observed for this task. No file content is assumed.");
}

function cancelDefinition() {
  definitionRequest?.controller.abort();
  definitionRequest = null;
}

function definitionKey(task) {
  return JSON.stringify([runIdentity(), task.id, task.definition.reference, task.definition.sha256]);
}

function renderDefinition(task) {
  ui.definitionPayload.hidden = !task.definition;
  if (!task.definition) { cancelDefinition(); definitionView = null; return; }
  const key = definitionKey(task);
  if (definitionView?.key !== key) {
    cancelDefinition();
    definitionView = definitionCache.has(key) ? { key, status: "ready", data: definitionCache.get(key) } : { key, status: "offline" };
  }
  if (definitionView.status === "offline" && connected) void loadDefinition(task, key);
  renderDefinitionPayload();
}

async function loadDefinition(task, key) {
  cancelDefinition();
  const controller = new AbortController();
  const request = { key, controller };
  definitionRequest = request;
  definitionView = { key, status: "loading" };
  renderDefinitionPayload();
  try {
    const data = await requestJSON(`/api/definitions/${encodeURIComponent(task.id)}`, { signal: controller.signal, maxBytes: CHAT_DOCUMENT_LIMIT });
    if (controller.signal.aborted || definitionRequest !== request || definitionView?.key !== key || !ui.dialog.open) return;
    if (data?.task_id !== task.id || typeof data.filename !== "string" || data.sha256 !== task.definition.sha256
      || data.content?.schema !== "asmrt.task.v1" || !Number.isSafeInteger(data.content.id)
      || data.content.id < 1 || data.content.id > 12 || String(data.content.id) !== task.id
      || task.definition.reference !== `job:${task.id}` || typeof data.content.kind !== "string"
      || !Number.isInteger(data.content.version) || data.content.version < 1
      || !Array.isArray(data.content.input_ids) || !data.content.input_ids.every((id) => typeof id === "string")) {
      throw new RequestError("The job response does not match this task’s saved definition reference.", "invalid");
    }
    definitionCache.set(key, data);
    definitionView = { key, status: "ready", data };
  } catch (error) {
    if (controller.signal.aborted || definitionRequest !== request || definitionView?.key !== key) return;
    definitionView = { key, status: "error", error: error.message };
  } finally {
    if (definitionRequest === request) { definitionRequest = null; renderDefinitionPayload(); }
  }
}

function renderDefinitionPayload() {
  const status = definitionView?.status ?? "offline";
  attribute(ui.definitionPayload, "data-status", status);
  attribute(ui.definitionPayload, "aria-busy", status === "loading");
  ui.definitionPre.hidden = status !== "ready";
  ui.definitionInputs.hidden = status !== "ready";
  const retryFocused = document.activeElement === ui.definitionRetry;
  ui.definitionRetry.hidden = !["error", "offline"].includes(status);
  ui.definitionRetry.disabled = !connected;
  if (retryFocused && ui.definitionRetry.hidden) ui.closeDialog.focus({ preventScroll: true });
  const data = definitionView?.data;
  text(ui.definitionJSON, status === "ready" ? JSON.stringify(data, null, 2) : "");
  text(ui.definitionInputs, status === "ready" ? data.content.input_ids.length
    ? `Saved input references: replies ${data.content.input_ids.join(", ")}. The role prompt, topic and model are in the job below.`
    : "No prior replies. This job begins from its saved topic, role prompt and model configuration." : "");
  text(ui.definitionStatus, status === "loading" ? "Reading the persisted executable job..."
    : status === "ready" ? `${data.content.kind} / version ${data.content.version}. ${connected ? "Actual job file, hash-validated by the controller against the native task record." : "Previously read job file. The controller is offline."}`
      : status === "error" ? `Job read failed: ${definitionView.error}` : "Reconnect to read this task’s saved job definition.");
}

function newEventNode(event) {
  const root = element("li", "event-row");
  root.dataset.event = event.event;
  const timeGroup = element("span", "event-time");
  const time = element("time");
  const date = new Date(event.at);
  if (!Number.isNaN(date.getTime())) { time.dateTime = event.at; time.title = date.toLocaleString("en-GB"); text(time, clock.format(date)); }
  else text(time, "Unknown time");
  timeGroup.append(time, element("span", "event-detail", `#${event.sequence}`));
  const label = element("span", "event-label", eventLabels[event.event] ?? event.event);
  label.title = event.event;
  const context = element("span", "event-context");
  if (event.task_ids?.length) context.append(element("code", "", `${isConversation() ? "turns" : "tasks"} ${event.task_ids.join(", ")}`));
  else if (event.task_id) context.append(element("code", "", `${isConversation() ? "turn" : "task"} ${event.task_id}`));
  if (event.owner || event.agent_id) context.append(element("code", "", event.owner ?? event.agent_id));
  if (event.attempt != null) context.append(element("span", "event-detail", `attempt ${event.attempt}`));
  if (event.pid != null) context.append(element("code", "event-detail", `PID ${event.pid}`));
  if (event.artifact) {
    const value = String(event.artifact);
    const hash = element("code", "event-detail", value.length > 16 ? `${value.slice(0, 12)}…` : value);
    hash.title = value;
    context.append(hash);
  }
  if (event.message) context.append(element("span", "event-message", event.message));
  root.append(timeGroup, label, context);
  return root;
}

function renderEvents(freshEvents) {
  const all = state?.events ?? [];
  const events = detailMode === "deep" && ui.allEvents.checked ? all : all.filter(event => !readEvents.has(event.event));
  const visible = events.slice(-EVENT_LIMIT).reverse();
  const fresh = new Set(freshEvents.map(eventKey));
  const keys = new Set(visible.map(eventKey));
  for (const key of eventNodes.keys()) if (!keys.has(key)) eventNodes.delete(key);
  const nodes = visible.map((event) => {
    const key = eventKey(event);
    let node = eventNodes.get(key);
    if (!node) { node = newEventNode(event); eventNodes.set(key, node); if (fresh.has(key)) flash(node); }
    return node;
  });
  reconcileChildren(ui.events, nodes);
  ui.journalEmpty.hidden = events.length > 0;
  text(ui.journalCount, events.length > EVENT_LIMIT ? `Latest ${EVENT_LIMIT} of ${events.length}` : `${events.length} events`);
}

function renderSources() {
  text(ui.sourceEngine, state?.source?.engine ?? "Not reported");
  text(ui.sourceBridge, state?.source?.bridge ?? "Not reported");
  text(ui.sourceMode, state?.source?.mode ?? "Not reported");
  text(ui.sourceDirectory, state?.run?.directory ?? "No run");
  text(ui.sourceRun, isConversation() ? `${state.run.id}: ${state.run.tasks} ${displayedWorkflow().kind === "conversation.discussion" ? "discussion turns with parallel debate rounds" : "sequential turns"}, 4 roles, one shared ${state.run.model} model`
    : state?.run ? `${state.run.id}: ${state.run.tasks} tasks, ${state.run.workers} workers, ${state.run.work_ms} ms teaching delay` : "No run");
}

function render({ highlight = false, freshEvents = [] } = {}) {
  text(ui.connectionStatus, connected ? "Connected" : connectionError ? "Disconnected" : "Connecting");
  attribute(ui.connectionStatus, "data-connected", connected);
  renderLayout();
  renderControls();
  renderStory();
  renderNotices();
  renderConversation();
  renderOverview();
  renderWorkers(highlight);
  renderDatabase(highlight);
  renderFiles(highlight);
  renderDecodedTasks();
  renderInspector();
  renderEvents(freshEvents);
  renderSources();
}

function bindCommand(button, callback) {
  button.addEventListener("click", (event) => { if (event.detail <= 1 && !activeAction) callback(); });
  button.addEventListener("keydown", (event) => { if (event.repeat && ["Enter", " "].includes(event.key)) event.preventDefault(); });
}

// Native controls preserve keyboard behavior; only explicit commands can start, resume or reset a run.
ui.openControls.addEventListener("click", () => { ui.controls.showModal(); ui.closeControls.focus({ preventScroll: true }); });
ui.closeControls.addEventListener("click", () => ui.controls.close());
ui.controls.addEventListener("close", () => ui.openControls.focus({ preventScroll: true }));
bindCommand(ui.reset, () => { if (actionAllowed("reset")) { ui.resetDialog.showModal(); ui.resetCancel.focus({ preventScroll: true }); } });
ui.resetCancel.addEventListener("click", () => ui.resetDialog.close());
ui.resetDialog.addEventListener("close", () => { if (!ui.reset.disabled) ui.reset.focus({ preventScroll: true }); else focusPrimary(); });
bindCommand(ui.resetConfirm, () => { if (actionAllowed("reset")) { ui.resetDialog.close(); void performAction("reset"); } });
ui.overviewLatest.addEventListener("click", () => {
  selectedOverviewReply = null;
  renderOverview();
  ui.overviewReplyScroll.scrollTop = ui.overviewReplyScroll.scrollHeight;
});
ui.memoryCells.addEventListener("click", event => {
  const button = event.target.closest("button[data-overview-reply]");
  if (!button || !ui.memoryCells.contains(button) || button.disabled) return;
  selectedOverviewReply = button.dataset.overviewReply;
  renderOverview();
  overviewMessageNodes.get(selectedOverviewReply)?.root.scrollIntoView({ block: "nearest" });
});
ui.rawRecords.addEventListener("change", () => renderDatabase(false));
ui.allEvents.addEventListener("change", () => renderEvents([]));
bindCommand(ui.storageStart, () => { if (actionAllowed("storage")) { ui.controls.close(); void performAction("storage"); } });
ui.latestReply.addEventListener("click", () => { ui.conversationScroll.scrollTop = ui.conversationScroll.scrollHeight; });
ui.conversationStart.addEventListener("click", (event) => { if (event.detail > 1) event.preventDefault(); });
ui.conversationForm.addEventListener("keydown", (event) => {
  if (event.target !== ui.topic && event.repeat && event.key === "Enter") event.preventDefault();
});
ui.conversationForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const kind = conversationAction();
  if (activeAction || !actionAllowed(kind)) return;
  const topic = ui.topic.value.trim();
  if (kind === "conversation") {
    const valid = [...topic].length >= 1 && [...topic].length <= 400 && !topic.includes("\0");
    attribute(ui.topic, "aria-invalid", !valid);
    ui.topicError.hidden = valid;
    text(ui.topicError, valid ? "" : "Enter a topic from 1 to 400 characters.");
    if (!valid) { selectDetail("deep"); ui.topic.focus(); return; }
  }
  if (kind === "conversation" && !isConversationWorkflow(selectedWorkflow)) return;
  void performAction(kind, kind === "conversation" ? { topic, workflow: selectedWorkflow } : {});
});
for (const choice of workflowChoices) choice.addEventListener("change", () => {
  if (!choice.checked || ui.workflow.disabled || !isConversationWorkflow(choice.value)) return;
  selectedWorkflow = choice.value;
  renderConversationControls();
  renderConversation();
  renderOverview();
});
ui.topic.addEventListener("input", () => { ui.topic.removeAttribute("aria-invalid"); ui.topicError.hidden = true; renderConversationControls(); renderConversation(); renderOverview(); });
bindCommand(ui.play, () => { void performAction(primaryAction()); });
bindCommand(ui.interrupt, () => { void performAction("interrupt"); });
bindCommand(ui.resume, () => { void performAction("resume"); });
bindCommand(ui.next, () => { void performAction("next"); });
ui.start.addEventListener("click", (event) => { if (event.detail > 1) event.preventDefault(); });
ui.form.addEventListener("keydown", (event) => {
  if (event.repeat && event.key === "Enter") event.preventDefault();
});
ui.form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (activeAction || !actionAllowed("run")) return;
  const tasks = Number(ui.taskCount.value);
  const workMs = Number(ui.workDelay.value);
  const validTasks = ui.taskCount.value !== "" && Number.isInteger(tasks) && tasks >= 1 && tasks <= 100;
  const validDelay = ui.workDelay.value !== "" && Number.isInteger(workMs) && workMs >= 0 && workMs <= 5000;
  attribute(ui.taskCount, "aria-invalid", !validTasks);
  attribute(ui.workDelay, "aria-invalid", !validDelay);
  ui.configurationError.hidden = validTasks && validDelay;
  text(ui.configurationError, validTasks ? "Enter a whole-number delay from 0 to 5000 ms." : "Enter a whole number of tasks from 1 to 100.");
  if (!validTasks || !validDelay) { (validTasks ? ui.workDelay : ui.taskCount).focus(); return; }
  void performAction("run", { tasks, work_ms: workMs, guided: ui.guided.checked });
});
for (const input of [ui.taskCount, ui.workDelay]) {
  input.addEventListener("input", () => { input.removeAttribute("aria-invalid"); ui.configurationError.hidden = true; });
}
ui.retryConnection.addEventListener("click", () => { void poll(); });
byId("dismiss-action-error").addEventListener("click", () => { actionError = null; renderNotices(); focusPrimary(); });
for (const list of [ui.files, ui.decodedRows, ui.messages, ui.jobs, ui.databaseRows]) {
  list.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-definition-id], button[data-task-id]");
    if (button && list.contains(button)) openInspector(button.dataset.definitionId ?? button.dataset.taskId, button);
  });
}
ui.closeDialog.addEventListener("click", () => ui.dialog.close());
ui.dialog.addEventListener("close", () => {
  cancelArtifact();
  cancelDefinition();
  selectedTaskId = null;
  artifactView = null;
  definitionView = null;
  if (inspectorTrigger?.isConnected && !inspectorTrigger.disabled && inspectorTrigger.getClientRects().length) inspectorTrigger.focus({ preventScroll: true });
  else focusPrimary();
  inspectorTrigger = null;
});
ui.artifactRetry.addEventListener("click", () => {
  const task = selectedTask();
  if (connected && task && observedFiles.has(task.id)) void loadArtifact(task, artifactKey(task));
});

ui.definitionRetry.addEventListener("click", () => {
  const task = selectedTask();
  if (connected && task?.definition) void loadDefinition(task, definitionKey(task));
});

const themeToggle = byId("theme-toggle");
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
let chosenTheme = null;
try {
  const savedTheme = localStorage.getItem("asmrt-visualizer-theme");
  if (["light", "dark"].includes(savedTheme)) chosenTheme = savedTheme;
} catch { /* Theme switching still works when browser storage is unavailable. */ }
function renderTheme() {
  const dark = chosenTheme ? chosenTheme === "dark" : systemTheme.matches;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  attribute(themeToggle, "aria-pressed", dark);
}
themeToggle.addEventListener("click", () => {
  chosenTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("asmrt-visualizer-theme", chosenTheme); } catch { /* Persistence is optional. */ }
  renderTheme();
});
systemTheme.addEventListener("change", () => { if (!chosenTheme) renderTheme(); });

try {
  if (localStorage.getItem("asmrt-visualizer-detail") === "deep") detailMode = "deep";
} catch { /* View switching still works without browser storage. */ }
function renderDetail() {
  document.documentElement.dataset.detail = detailMode;
  for (const choice of detailChoices) choice.checked = choice.value === detailMode;
}
function selectDetail(value) {
  detailMode = value;
  try { localStorage.setItem("asmrt-visualizer-detail", detailMode); } catch { /* Persistence is optional. */ }
  renderDetail();
  render();
}
for (const choice of detailChoices) choice.addEventListener("change", () => {
  if (choice.checked) selectDetail(choice.value);
});
renderDetail();
renderTheme();
render();
void poll();
