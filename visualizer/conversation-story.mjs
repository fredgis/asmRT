export const DEFAULT_TOPIC = 'Plan a free outdoor neighborhood book swap this Saturday. We have one table, two volunteers, and a chance of rain. Agree on the exchange rules, who does what, and a rain backup.';

export function conversationOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['topic', 'rounds'].includes(key))) {
    throw new Error('A conversation accepts a topic and an optional number of rounds.');
  }
  const topic = options.topic ?? DEFAULT_TOPIC;
  const rounds = options.rounds ?? 2;
  if (typeof topic !== 'string' || !topic.trim() || topic.includes('\0') || [...topic.trim()].length > 400
      || !Number.isInteger(rounds) || rounds < 1 || rounds > 3) {
    throw new Error('Choose a topic of 1 to 400 characters and 1 to 3 rounds.');
  }
  return { topic: topic.trim(), rounds };
}

export function localModelSettings(model, endpoint) {
  if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,99}$/.test(model)) throw new Error('Invalid local model name.');
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a local Ollama loopback HTTP URL without credentials or a path.');
  }
  return { model, ollama_url: url.origin };
}

export function describeConversation({ phase, checkpoint, tasks, summary, conversation, run }) {
  const completed = tasks.filter(task => task.state === 'completed').length;
  const total = run.tasks * 3 + 5;
  const scene = (id, title, description, next_label, action, duration_ms, index, focus = 'conversation') => ({
    scene: { id: `chat-${id}`, chapter: 'Conversation', title, description, next_label, focus },
    action, duration_ms, index, total,
  });
  if (phase === 'finished') {
    if (summary?.completed_now === 0 && summary?.model_calls_now === 0) {
      return scene('verified', 'Same conversation. Zero new model calls.',
        `Rust reopened all ${completed} replies, checked their definitions, input chains and SHA-256 commitments, and did not ask the model again.`,
        'Start another conversation', null, 0, total - 1);
    }
    return scene('completed', 'The group has finished its conversation.',
      `All ${completed} replies are saved and committed in asmDB. One final restart will verify that no completed turn calls the model again.`,
      'Restart and verify the saved conversation', 'resume', 4500, total - 2);
  }
  if (phase === 'interrupted') {
    if (!conversation) return scene('reopen', 'A saved conversation is available.',
      'No messages have been read in this controller session yet. Reopen the saved definition and asmDB before claiming what was completed.',
      'Read the saved conversation', 'resume', 2500, 0, 'database');
    return scene('crashed', 'Rust stopped. The conversation did not disappear.',
      `${completed} committed message${completed === 1 ? '' : 's'} remain visible as last-read evidence. The next process will reread the job definitions, messages and asmDB records.`,
      'Reopen the saved conversation', 'resume', 6500, completed * 3 + 1, 'database');
  }
  if (phase === 'running' && conversation?.active?.stage === 'generating') {
    const active = conversation.active;
    const agent = conversation.agents.find(agent => agent.id === active.agent_id);
    return scene('generating', `${agent?.name ?? 'The agent'} is replying to the group.`,
      `A real local model request is running with ${active.input_ids.length} previous saved message${active.input_ids.length === 1 ? '' : 's'}. No words are scripted or animated ahead of the reply.`,
      'Waiting for the local model', null, 0, (Number(active.task_id) - 1) * 3 + 1);
  }
  if (phase !== 'paused' || !checkpoint) return null;
  if (checkpoint.stage === 'ready') {
    const recovering = tasks.some(task => Number(task.attempt) > 0);
    return recovering
      ? scene('recovered', 'The new process has recovered the conversation.',
        `${completed} replies were verified from disk. The remaining turns retain their saved agent instructions, model identity and input references; they do not start a new discussion.`,
        'Continue from the saved messages', 'next', 4500, completed * 3, 'database')
      : scene('ready', 'Four agents. One small local model.',
        `${run.tasks} versioned turn definitions are now saved. Each agent will receive what the previous agents actually said. The database stores the definition hashes, not just status flags.`,
        'Give Planner the floor', 'next', 4500, 0);
  }
  const task = tasks.find(task => task.id === checkpoint.task_ids[0]);
  if (!task) return null;
  const number = Number(task.id);
  const agent = conversation?.agents.find(agent => agent.id === task.owner);
  const name = agent?.name ?? 'The agent';
  if (checkpoint.stage === 'claimed') {
    if (number === Math.floor(run.tasks / 2) + 1 && task.attempt === '1') {
      return scene('crash-next', 'An interruption, in the middle of the discussion.',
        `${completed} replies are already committed. ${name}'s next turn is assigned, but its model call has not started. We will stop Rust and resume from the saved conversation.`,
        'Stop the actual Rust process', 'interrupt', 4500, (number - 1) * 3 + 1, 'database');
    }
    return scene('assigned', `Turn ${number} of ${run.tasks}: ${name} has the floor.`,
      `${name} will read ${completed} preceding saved messages and its own persisted instructions. ${Number(task.attempt) > 1 ? 'This interrupted assignment is being retried.' : 'The other agents are listening.'}`,
      'Ask the local model', 'next', 1000, (number - 1) * 3 + 1);
  }
  if (checkpoint.stage === 'published') {
    const message = conversation?.messages.find(message => message.task_id === task.id);
    const words = message?.text.trim().split(/\s+/).length ?? 0;
    return scene('saved', `${name}'s reply is saved on disk.`,
      `${message?.reused ? 'This existing reply was reused without a model call.' : 'These are the model’s actual words.'} Its asmDB completion is not committed yet. Read the reply before the conversation moves on.`,
      'Commit this reply in asmDB', 'next', Math.max(6000, Math.min(18000, words * 300)), (number - 1) * 3 + 2);
  }
  if (checkpoint.stage === 'completed') return scene('committed', `${name}'s reply is now committed.`,
    `asmDB records the reply's SHA-256 as well as its task definition. The next agent can now use this message as a durable input.`,
    'Pass the conversation to the next agent', 'next', 900, number * 3, 'database');
  return null;
}
