// Defines bounded conversation contracts and maps real runtime checkpoints to demo scenes.
// Story pacing observes execution; it never fabricates replies or decides task dependencies.
export const DEFAULT_TOPIC = 'Pizza night in 30 minutes. Eight friends, $40, one oven. Pick dinner and split the jobs.';
export const SEQUENTIAL = 'conversation.sequential';
export const DISCUSSION = 'conversation.discussion';
export const WORKFLOWS = [
  [SEQUENTIAL, 'Sequential', 'Each agent reads the preceding replies.', 'chain'],
  [DISCUSSION, 'Discussion', 'Parallel peers debate before a final synthesis.', 'waves'],
  ['conversation.graph', 'Graph', 'A committed router selects Node A or B; shared state merges the result.', 'conditional'],
  ['conversation.roles', 'Roles', 'A manager delegates research and analysis, then reviews the writer.', 'delegation'],
  ['conversation.approval', 'Approval', 'A human approves or rejects local receipt, report and notification artifacts.', 'human-gate'],
  ['conversation.handoff', 'Handoff', 'Triage transfers ownership to billing or support before returning the result.', 'handoff'],
  ['conversation.hybrid', 'Hybrid', 'Parallel subagents merge before bounded refinement and root synthesis.', 'parallel-loop'],
  ['conversation.loop', 'Loop', 'Gather context, plan, inspect local artifacts, verify, and stop or retry within a cap.', 'bounded-loop'],
].map(([kind, name, description, topology]) => ({ kind, version: 1, name, description, topology }));

// Normalize only new-run settings; saved plans keep their original workflow and prompts.
export function conversationOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => !['topic', 'rounds', 'workflow'].includes(key))) {
    throw new Error('A conversation accepts a topic, rounds and a workflow.');
  }
  const topic = options.topic ?? DEFAULT_TOPIC;
  const rounds = options.rounds ?? 2;
  const workflow = options.workflow === undefined ? SEQUENTIAL : options.workflow;
  if (typeof topic !== 'string' || !topic.trim() || topic.includes('\0') || [...topic.trim()].length > 400
      || !Number.isInteger(rounds) || rounds < 1 || rounds > 3) {
    throw new Error('Choose a topic of 1 to 400 characters and 1 to 3 rounds.');
  }
  if (!WORKFLOWS.some(item => item.kind === workflow)) throw new Error('Choose a supported conversation workflow.');
  return { topic: topic.trim(), rounds, workflow };
}

// The observer validates this fixed topology against Rust's saved job dependencies.
export function conversationTurns({ workflow = SEQUENTIAL, rounds = 2 }) {
  if (!WORKFLOWS.some(item => item.kind === workflow) || !Number.isInteger(rounds) || rounds < 1 || rounds > 3) {
    throw new Error('Unsupported conversation topology.');
  }
  const turns = [];
  const prior = () => turns.map(turn => turn.task_id);
  const add = (agent_id, input_ids) => turns.push({ task_id: String(turns.length + 1), agent_id, input_ids: [...input_ids] });
  if (workflow === SEQUENTIAL) {
    for (let round = 0; round < rounds; round++) {
      for (const agent of ['planner', 'builder', 'critic', 'editor']) add(agent, prior());
    }
  } else if (workflow === DISCUSSION) {
    add('planner', []);
    for (let round = 0; round < rounds; round++) {
      const inputs = prior();
      for (const agent of ['builder', 'critic', 'editor']) add(agent, inputs);
    }
    add('editor', prior());
  } else if (['conversation.graph', 'conversation.handoff', 'conversation.roles', 'conversation.hybrid'].includes(workflow)) {
    add('planner', []);
    add('builder', ['1']);
    add('critic', ['1']);
    add('editor', prior());
    if (workflow === 'conversation.roles') add('planner', prior());
    if (workflow === 'conversation.hybrid') {
      for (let round = 0; round < rounds; round++) {
        add('builder', prior());
        add('critic', prior());
      }
      add('editor', prior());
    }
  } else if (workflow === 'conversation.approval') {
    for (const agent of ['planner', 'editor', 'builder', 'critic', 'editor']) add(agent, prior());
  } else {
    add('planner', []);
    for (let round = 0; round < rounds; round++) {
      for (const agent of ['builder', 'editor', 'critic']) add(agent, prior());
    }
    add('editor', prior());
  }
  return turns;
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

// Sequential scenes retain the original single-turn crash/recovery demonstration.
export function describeConversation({ phase, checkpoint, tasks, summary, conversation, run }) {
  if (run.workflow === DISCUSSION) return describeDiscussion({ phase, checkpoint, tasks, summary, conversation, run });
  if (run.workflow !== SEQUENTIAL) return describeWorkflow({ phase, checkpoint, tasks, summary, conversation, run });
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

function describeWorkflow({ phase, checkpoint, tasks, summary, conversation, run }) {
  const descriptor = WORKFLOWS.find(item => item.kind === run.workflow);
  const completed = tasks.filter(task => task.state === 'completed').length;
  const total = run.tasks * 3 + 5;
  const scene = (id, title, description, action, next_label, duration_ms = 1800) => ({
    scene: { id: `chat-${id}`, chapter: descriptor.name, title, description, next_label, focus: 'conversation' },
    action, duration_ms, index: Math.min(total - 1, completed * 3), total,
  });
  if (phase === 'finished') return summary?.completed_now === 0 && summary?.model_calls_now === 0
    ? scene('verified', 'Saved results verified.', 'No new model calls. Control decisions and local artifacts were reused.', null, 'Start another workflow', 0)
    : scene('completed', 'Workflow committed.', 'Restart to verify the same results and control decisions.', 'resume', 'Restart and verify');
  if (phase === 'interrupted') return scene('reopen', 'Reopen the same workflow.', 'Only unfinished work resumes. Committed decisions survive.', 'resume', 'Reopen workflow');
  if (phase === 'running') return scene('generating', 'Executing saved work.', 'Dependencies and control decisions come from committed artifacts.', null, 'Waiting for runtime', 0);
  if (phase !== 'paused' || !checkpoint) return null;
  if (checkpoint.stage === 'approval') return scene('approval', 'Human decision required.',
    'Approve or reject this local-only demonstration. No charge or external notification will occur. Automatic playback cannot decide.',
    null, 'Approve or reject', 0);
  if (checkpoint.stage === 'ready') return scene('ready', descriptor.name, descriptor.description, 'next', 'Begin workflow');
  const batch = checkpoint.task_ids.map(id => tasks.find(task => task.id === id)).filter(Boolean);
  if (checkpoint.stage === 'claimed' && batch.some(task => task.id === '3' && task.attempt === '1')) {
    return scene('crash-next', 'Interrupt before execution.', 'Saved dependencies and routing survive a real process restart.', 'interrupt', 'Stop runtime');
  }
  if (checkpoint.stage === 'published') return scene('saved', 'Artifacts saved.', 'Model replies, local results and skipped branches use the same durable hash commitment.', 'next', 'Commit artifacts', 4000);
  if (checkpoint.stage === 'completed') return scene('committed', 'Checkpoint committed.', 'The next jobs can now consume these results.', 'next', 'Continue');
  return scene('assigned', 'Jobs assigned.', 'Execute only the selected branch or local handler; retain the original job identity.', 'next', 'Execute');
}

// Discussion cues stop at whole-wave barriers, never between the three sibling requests.
function describeDiscussion({ phase, checkpoint, tasks, summary, conversation, run }) {
  const completed = tasks.filter(task => task.state === 'completed').length;
  const total = (run.rounds + 2) * 3 + 5;
  const wave = id => Number(id) === 1 ? 0 : Number(id) === run.tasks ? run.rounds + 1 : Math.floor((Number(id) - 2) / 3) + 1;
  const scene = (id, title, description, next_label, action, duration_ms, index, focus = 'conversation') => ({
    scene: { id: `chat-${id}`, chapter: 'Discussion', title, description, next_label, focus },
    action, duration_ms, index, total,
  });
  if (phase === 'finished') {
    return summary?.completed_now === 0 && summary?.model_calls_now === 0
      ? scene('verified', 'Same decision. Zero new model calls.', `${completed} replies verified from disk.`,
        'Start another discussion', null, 0, total - 1)
      : scene('completed', 'The team has a decision.', 'Every reply is committed. One restart proves they survive.',
        'Restart and verify', 'resume', 4500, total - 2);
  }
  if (phase === 'interrupted') {
    return conversation
      ? scene('crashed', 'Rust stopped. The debate survives.', `${completed} committed replies are still here.`,
        'Reopen the discussion', 'resume', 6500, Math.min(total - 3, completed + 2), 'database')
      : scene('reopen', 'Reopen the saved discussion.', 'Read its jobs and replies before continuing.',
        'Read saved work', 'resume', 2500, 0, 'database');
  }
  const generating = (conversation?.active_turns ?? []).filter(turn => turn.stage === 'generating');
  if (phase === 'running' && generating.length) {
    const index = wave(generating[0].task_id);
    const title = index === 0 ? 'Planner is pitching an idea.' : index === run.rounds + 1 ? 'Editor is writing the decision.' : 'The team is debating.';
    return scene('generating', title, `${generating.length} model request${generating.length === 1 ? '' : 's'} in flight. ${generating[0].input_ids.length} committed replies in context.`,
      'Waiting for Ollama', null, 0, index * 3 + 1);
  }
  if (phase !== 'paused' || !checkpoint) return null;
  if (checkpoint.stage === 'ready') {
    return tasks.some(task => Number(task.attempt) > 0)
      ? scene('recovered', 'Same debate. Only unfinished work resumes.', `${completed} replies verified. Completed branches stay untouched.`,
        'Continue the discussion', 'next', 4500, Math.min(total - 3, completed), 'database')
      : scene('ready', 'One idea. Three challengers.', 'Planner opens. Three peers debate. Editor brings it together.',
        'Give Planner the floor', 'next', 4500, 0);
  }
  const batch = checkpoint.task_ids.map(id => tasks.find(task => task.id === id)).filter(Boolean);
  if (!batch.length) return null;
  const index = wave(batch[0].id);
  const final = index === run.rounds + 1;
  if (checkpoint.stage === 'claimed') {
    const crashId = run.rounds > 1 ? '5' : '2';
    if (batch.some(task => task.id === crashId && task.attempt === '1')) {
      return scene('crash-next', 'Three jobs claimed. Now kill Rust.', 'The next debate round has not called the model yet.',
        'Stop the Rust process', 'interrupt', 5000, index * 3 + 1, 'database');
    }
    return scene('assigned', index === 0 ? 'Planner, pitch an idea.' : final ? 'Editor, bring it together.' : `Debate round ${index}.`,
      index === 0 ? 'A concrete starting point, not the final answer.' : final ? 'Read the full debate. Make one concrete decision.' : 'Builder, Critic and Editor get the same context. They reply in parallel.',
      final ? 'Write the decision' : index === 0 ? 'Ask Planner' : 'Open the debate', 'next', 1100, index * 3 + 1);
  }
  if (checkpoint.stage === 'published') {
    const messages = (conversation?.messages ?? []).filter(message => checkpoint.task_ids.includes(message.task_id));
    const words = messages.reduce((count, message) => count + message.text.trim().split(/\s+/).length, 0);
    return scene('saved', final ? 'The decision is saved.' : index === 0 ? 'The idea is saved.' : 'Three views, saved side by side.',
      messages.every(message => message.reused) ? 'Saved replies reused. No new model calls.' : 'Real replies on disk. Commit their hashes in asmDB next.',
      'Commit the replies', 'next', Math.max(6500, Math.min(14000, words * 160)), index * 3 + 2);
  }
  if (checkpoint.stage === 'completed') return scene('committed', index === 0 ? 'The idea is committed.' : `Debate round ${index} is committed.`,
    'The next wave can now use every reply from this round.', 'Continue the discussion', 'next', 1100, (index + 1) * 3, 'database');
  return null;
}
