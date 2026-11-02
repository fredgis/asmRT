export const DEFAULT_TOPIC = 'Pizza night in 30 minutes. Eight friends, $40, one oven. Pick dinner and split the jobs.';

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
  const pizza = conversation?.topic === DEFAULT_TOPIC;
  const scene = (id, title, description, next_label, action, duration_ms, index, focus = 'conversation') => ({
    scene: { id: `chat-${id}`, chapter: 'Conversation', title, description, next_label, focus },
    action, duration_ms, index, total,
  });
  if (phase === 'finished') {
    if (summary?.completed_now === 0 && summary?.model_calls_now === 0) {
      return scene('verified', 'Same replies. Zero new model calls.',
        `${completed} replies reopened and verified. Nothing was generated again.`,
        'Start another conversation', null, 0, total - 1);
    }
    return scene('completed', 'Conversation saved. One last check.',
      `${completed} replies committed. Restarting to prove they are reused.`,
      'Restart and verify', 'resume', 4500, total - 2);
  }
  if (phase === 'interrupted') {
    if (!conversation) return scene('reopen', 'Reopen the saved conversation.',
      'Read the jobs and replies from disk before continuing.',
      'Read saved work', 'resume', 2500, 0, 'database');
    return scene('crashed', 'Rust is gone. The work is here.',
      `${completed} committed replies remain visible. A new process will verify them from disk.`,
      'Reopen the same conversation', 'resume', 7000, completed * 3 + 1, 'database');
  }
  if (phase === 'running' && conversation?.active?.stage === 'generating') {
    const active = conversation.active;
    const agent = conversation.agents.find(agent => agent.id === active.agent_id);
    return scene('generating', `${agent?.name ?? 'The agent'} is replying.`,
      `${active.input_ids.length} saved replies in context. Waiting for the real local model.`,
      'Waiting for Ollama', null, 0, (Number(active.task_id) - 1) * 3 + 1);
  }
  if (phase !== 'paused' || !checkpoint) return null;
  if (checkpoint.stage === 'ready') {
    const recovering = tasks.some(task => Number(task.attempt) > 0);
    return recovering
      ? scene('recovered', 'New process. Same conversation.',
        `${completed} replies verified. Saved instructions tell the next agent what to do.`,
        'Continue the conversation', 'next', 5000, completed * 3, 'database')
      : scene('ready', pizza ? 'Can they save pizza night?' : 'The team has a mission.',
        `${run.tasks} jobs saved. Every agent will read the previous replies.`,
        'Give Planner the floor', 'next', 4500, 0);
  }
  const task = tasks.find(task => task.id === checkpoint.task_ids[0]);
  if (!task) return null;
  const number = Number(task.id);
  const agent = conversation?.agents.find(agent => agent.id === task.owner);
  const name = agent?.name ?? 'The agent';
  if (checkpoint.stage === 'claimed') {
    if (number === Math.floor(run.tasks / 2) + 1 && task.attempt === '1') {
      return scene('crash-next', pizza && number === 5 ? 'The oven broke. Now Rust stops.' : 'Time for a real crash.',
        `${completed} replies committed. Turn ${number} assigned, but its model call has not started.`,
        'Stop the Rust process', 'interrupt', 5000, (number - 1) * 3 + 1, 'database');
    }
    return scene('assigned', `${name}, your turn.`,
      `${completed} saved replies to read. ${Number(task.attempt) > 1 ? 'Retrying the same job, not the whole discussion.' : 'The others are listening.'}`,
      'Ask the local model', 'next', 1100, (number - 1) * 3 + 1);
  }
  if (checkpoint.stage === 'published') {
    const message = conversation?.messages.find(message => message.task_id === task.id);
    const words = message?.text.trim().split(/\s+/).length ?? 0;
    return scene('saved', `${name}'s reply is saved.`,
      message?.reused ? 'Existing reply reused. No model call.' : 'Real words, on disk. Next: commit their hash in asmDB.',
      'Commit the reply', 'next', Math.max(6500, Math.min(18000, words * 300)), (number - 1) * 3 + 2);
  }
  if (checkpoint.stage === 'completed') return scene('committed', `${name}'s reply is committed.`,
    'asmDB has its hash. The next agent can use this reply.',
    'Pass to the next agent', 'next', 1100, number * 3, 'database');
  return null;
}
