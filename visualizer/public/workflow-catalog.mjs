// +--------------------------------------------------------------------+
// | asmRT :: workflow-catalog.mjs -- workflow icons and live graphs      |
// +--------------------------------------------------------------------+
// Presentation metadata for the eight native patterns, not an executable
// graph definition. Compact picker icons and full diagrams have separate
// geometry so miniature strokes stay legible.

const chain = '<path d="M10 16h44"/><circle cx="6" cy="16" r="4"/><circle cx="23" cy="16" r="4"/><circle cx="41" cy="16" r="4"/><circle cx="58" cy="16" r="4"/>';
const fork = '<path d="M10 16h8V5h10m-10 11h10m-10 0v11h10M36 5h10v22H36m10-11h8"/><circle cx="6" cy="16" r="4"/><circle cx="32" cy="5" r="4"/><circle cx="32" cy="16" r="4"/><circle cx="32" cy="27" r="4"/><circle cx="58" cy="16" r="4"/>';
const route = '<path d="M10 16h10m12-4 12-7h10M32 20l12 7h10"/><circle cx="6" cy="16" r="4"/><path d="m20 16 6-7 7 7-7 7Z"/><circle cx="58" cy="5" r="4"/><circle cx="58" cy="27" r="4"/>';
const loop = '<path d="M10 16h44m-13 5v8H6V21m-3 3 3-3 3 3"/><circle cx="6" cy="16" r="4"/><circle cx="23" cy="16" r="4"/><circle cx="41" cy="16" r="4"/><circle cx="58" cy="16" r="4"/>';

export const WORKFLOWS = [
  { id: 'sequential', name: 'Relay', caption: 'One role at a time', diagram: chain,
    description: 'Planner → Builder → Critic → Editor. Each turn reads all earlier committed replies.' },
  { id: 'discussion', name: 'Discussion', caption: 'Debate, then synthesize', diagram: fork,
    description: 'Planner seeds parallel debate rounds. Builder, Critic and Editor share history, then Editor synthesizes.' },
  { id: 'graph', name: 'Conditional graph', caption: 'Decide which path runs', diagram: route,
    description: 'A committed routing decision selects a branch. The result is saved before the workflow continues.' },
  { id: 'roles', name: 'Role-based team', caption: 'Delegate by specialty', diagram: fork,
    description: 'A manager briefs specialist roles. Their committed results feed the final synthesis.' },
  { id: 'approval', name: 'Human approval', caption: 'Wait for your decision', diagram: '<path d="M10 16h12m18 0h14"/><circle cx="6" cy="16" r="4"/><rect x="22" y="5" width="18" height="22" rx="3"/><path d="m26 16 3 3 7-8"/><circle cx="58" cy="16" r="4"/>',
    description: 'Validate a proposal, wait for a human decision, then perform or skip local demo actions. No automatic approval.' },
  { id: 'handoff', name: 'Agent handoff', caption: 'Route to a specialist', diagram: route,
    description: 'Triage chooses a specialist. Context travels with the handoff and the result returns to the coordinator.' },
  { id: 'hybrid', name: 'Hybrid orchestration', caption: 'Sequence + parallel work', diagram: fork,
    description: 'A root agent coordinates a sequence and parallel specialist work, then merges their saved results.' },
  { id: 'loop', name: 'Agent loop', caption: 'Act, verify, improve', diagram: loop,
    description: 'Gather context, plan, act and verify. A bounded feedback loop improves the result without running forever.' },
].map((workflow, index) => ({ ...workflow, kind: `conversation.${workflow.id}`, number: index + 1 }));

export function workflowInfo(kind) {
  return WORKFLOWS.find(workflow => workflow.kind === kind) ?? WORKFLOWS[0];
}

export function workflowTurnCount(kind, rounds = 2) {
  switch (kind) {
    case 'conversation.sequential': return rounds * 4;
    case 'conversation.discussion':
    case 'conversation.loop': return rounds * 3 + 2;
    case 'conversation.graph':
    case 'conversation.handoff': return 4;
    case 'conversation.roles':
    case 'conversation.approval': return 5;
    case 'conversation.hybrid': return rounds * 2 + 5;
    default: return 8;
  }
}

export function workflowSVG(workflow) {
  return `<svg viewBox="0 0 64 32" width="64" height="32" fill="var(--surface)" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false">${workflow.diagram}</svg>`;
}

const node = (id, label, agent, x, y = 100) => ({ id, label, agent, x, y });
const GRAPHS = {
  sequential: {
    nodes: [node('planner', 'Planner', 'planner', 90), node('builder', 'Builder', 'builder', 310), node('critic', 'Critic', 'critic', 530), node('editor', 'Editor', 'editor', 750)],
    edges: [['planner', 'builder'], ['builder', 'critic'], ['critic', 'editor'], ['editor', 'planner', 'Next round']],
  },
  discussion: {
    nodes: [node('seed', 'Seed', 'planner', 90), node('builder', 'Builder', 'builder', 420, 42), node('critic', 'Critic', 'critic', 420, 110), node('editor', 'Editor', 'editor', 420, 178), node('synthesis', 'Synthesis', 'editor', 750)],
    edges: [['seed', 'builder'], ['seed', 'critic'], ['seed', 'editor'], ['builder', 'synthesis'], ['critic', 'synthesis'], ['editor', 'synthesis']],
  },
  graph: {
    nodes: [node('route', 'Route', 'planner', 90), node('a', 'Path A', 'builder', 420, 55), node('b', 'Path B', 'critic', 420, 155), node('result', 'Result', 'editor', 750)],
    edges: [['route', 'a'], ['route', 'b'], ['a', 'result'], ['b', 'result']],
  },
  roles: {
    nodes: [node('brief', 'Manager brief', 'planner', 75), node('research', 'Researcher', 'builder', 300, 55), node('analysis', 'Analyst', 'critic', 300, 155), node('writer', 'Writer', 'editor', 530), node('review', 'Review', 'planner', 765)],
    edges: [['brief', 'research'], ['brief', 'analysis'], ['research', 'writer'], ['analysis', 'writer'], ['writer', 'review']],
  },
  approval: {
    nodes: [node('validate', 'Validate', 'planner', 75), node('human', 'Human decision', 'editor', 245), node('receipt', 'Local receipt', 'builder', 415), node('report', 'Report', 'critic', 585), node('notify', 'Notify draft', 'editor', 765)],
    edges: [['validate', 'human'], ['human', 'receipt'], ['receipt', 'report'], ['report', 'notify']],
  },
  handoff: {
    nodes: [node('triage', 'Triage', 'planner', 90), node('billing', 'Billing', 'builder', 420, 55), node('support', 'Support', 'critic', 420, 155), node('return', 'Return', 'editor', 750)],
    edges: [['triage', 'billing'], ['triage', 'support'], ['billing', 'return'], ['support', 'return']],
  },
  hybrid: {
    nodes: [node('brief', 'Brief', 'planner', 65), node('research', 'Research', 'builder', 205, 55), node('analysis', 'Analysis', 'critic', 205, 155), node('merge', 'Merge', 'editor', 345), node('refine', 'Refine', 'builder', 485), node('verify', 'Verify', 'critic', 625), node('synthesis', 'Synthesis', 'editor', 775)],
    edges: [['brief', 'research'], ['brief', 'analysis'], ['research', 'merge'], ['analysis', 'merge'], ['merge', 'refine'], ['refine', 'verify'], ['verify', 'refine', 'Next round'], ['verify', 'synthesis']],
  },
  loop: {
    nodes: [node('context', 'Context', 'planner', 75), node('plan', 'Plan', 'builder', 245), node('act', 'Local action', 'editor', 415), node('verify', 'Verify', 'critic', 585), node('result', 'Result', 'editor', 765)],
    edges: [['context', 'plan'], ['plan', 'act'], ['act', 'verify'], ['verify', 'plan', 'Retry within budget'], ['verify', 'result']],
  },
};

function graphFor(kind) {
  return GRAPHS[workflowInfo(kind).id];
}

export function graphSVG(kind, detailed = true) {
  const definition = graphFor(kind);
  const positions = {
    sequential: [[65, 65], [230, 65], [395, 65], [395, 180]],
    discussion: [[65, 110], [230, 40], [230, 110], [230, 180], [395, 110]],
    graph: [[65, 110], [230, 55], [230, 165], [395, 110]],
    roles: [[65, 110], [230, 55], [230, 165], [395, 110], [395, 210]],
    approval: [[65, 60], [230, 60], [395, 60], [395, 170], [230, 170]],
    handoff: [[65, 110], [230, 55], [230, 165], [395, 110]],
    hybrid: [[65, 90], [230, 40], [230, 140], [395, 90], [395, 210], [230, 210], [65, 210]],
    loop: [[65, 55], [230, 55], [395, 55], [395, 165], [65, 165]],
  }[workflowInfo(kind).id];
  const graph = { ...definition, nodes: definition.nodes.map((n, i) => detailed ? { ...n, x: positions[i][0], y: positions[i][1] } : n) };
  const edges = graph.edges.map(([from, to, feedback]) => {
    const a = graph.nodes.find(n => n.id === from);
    const b = graph.nodes.find(n => n.id === to);
    let path, arrow;
    if (feedback) {
      path = `M${a.x} ${a.y + 27}V${detailed ? 245 : 215}H${b.x}V${b.y + 32}`;
      arrow = `M${b.x - 4} ${b.y + 38}l4 -6 4 6`;
    } else if (a.x === b.x) {
      const direction = Math.sign(b.y - a.y);
      const end = b.y - direction * 32;
      path = `M${a.x} ${a.y + direction * 27}V${end}`;
      arrow = `M${b.x - 4} ${end - direction * 7}L${b.x} ${end}L${b.x + 4} ${end - direction * 7}`;
    } else {
      const direction = Math.sign(b.x - a.x);
      const end = b.x - direction * 59;
      path = `M${a.x + direction * 55} ${a.y}C${(a.x + b.x) / 2} ${a.y} ${(a.x + b.x) / 2} ${b.y} ${end} ${b.y}`;
      arrow = `M${end - direction * 6} ${b.y - 4}L${end} ${b.y}L${end - direction * 6} ${b.y + 4}`;
    }
    return `<g class="flow-edge" data-from="${from}" data-to="${to}"><path d="${path}" fill="none"/><path d="${arrow}" fill="none"/>${feedback && detailed ? `<text x="${(a.x + b.x) / 2}" y="268" text-anchor="middle">${feedback}</text>` : ''}</g>`;
  }).join('');
  const nodes = graph.nodes.map(n => `<g class="flow-node" data-node="${n.id}" data-agent-id="${n.agent}" data-state="pending" transform="translate(${n.x},${n.y})">
    <rect x="-55" y="-27" width="110" height="54" rx="${['route', 'human', 'triage', 'verify'].includes(n.id) ? 20 : 10}"/>
    ${detailed ? `<text class="flow-label" text-anchor="middle" y="-5">${n.label}</text><text class="flow-status" text-anchor="middle" y="15">Pending</text>` : ''}
    </g>`).join('');
  return `<svg viewBox="${detailed ? '0 0 460 280' : '0 0 850 245'}" ${detailed ? 'role="img" aria-label="Workflow steps"' : 'aria-hidden="true" focusable="false"'}>${edges}${nodes}</svg>`;
}

// Repeated rounds share a visual stage; task IDs and observations still come from the saved run.
function stageFor(kind, index, total) {
  switch (kind) {
    case 'conversation.sequential': return ['planner', 'builder', 'critic', 'editor'][index % 4];
    case 'conversation.discussion': return index === 0 ? 'seed' : index === total - 1 ? 'synthesis' : ['builder', 'critic', 'editor'][(index - 1) % 3];
    case 'conversation.graph': return ['route', 'a', 'b', 'result'][index];
    case 'conversation.roles': return ['brief', 'research', 'analysis', 'writer', 'review'][index];
    case 'conversation.approval': return ['validate', 'human', 'receipt', 'report', 'notify'][index];
    case 'conversation.handoff': return ['triage', 'billing', 'support', 'return'][index];
    case 'conversation.hybrid': return index < 4 ? ['brief', 'research', 'analysis', 'merge'][index] : index === total - 1 ? 'synthesis' : ['refine', 'verify'][(index - 4) % 2];
    case 'conversation.loop': return index === 0 ? 'context' : index === total - 1 ? 'result' : ['plan', 'act', 'verify'][(index - 1) % 3];
  }
}

// A stage may represent several jobs: one committed round is not full completion.
// Retained observations override every live highlight after disconnection or stop.
export function workflowNodeStates(kind, { turns = [], cells = [], activeTurns = [], checkpoint, live = false, retained = false } = {}) {
  return graphFor(kind).nodes.map(n => {
    const ids = turns.filter((_, index) => stageFor(kind, index, turns.length) === n.id).map(turn => turn.task_id);
    const observations = cells.filter(cell => ids.includes(cell.id));
    const active = live && !retained ? activeTurns.filter(turn => ids.includes(turn.task_id)
      && !observations.some(cell => cell.id === turn.task_id && cell.status === 'committed')) : [];
    const approval = live && !retained && checkpoint?.stage === 'approval' && checkpoint.task_ids.some(id => ids.includes(id));
    const committed = observations.filter(cell => cell.status === 'committed').length;
    let state = 'pending';
    let label = committed ? `${committed}/${ids.length} committed` : 'Pending';
    if (ids.length && committed === ids.length) {
      state = observations.every(cell => cell.message?.control?.skipped) ? 'skipped' : 'completed';
      label = state === 'skipped' ? 'Skipped' : `${committed}/${ids.length} committed`;
    } else if (observations.some(cell => cell.status === 'unknown')) { state = 'unknown'; label = 'Unconfirmed'; }
    else if (observations.some(cell => cell.status === 'saved')) { state = 'saved'; label = 'Saved, not committed'; }
    else if (observations.some(cell => cell.status === 'assigned')) { state = 'retained'; label = 'Last observed claim'; }
    if (approval) { state = 'approval'; label = 'Your decision'; }
    else if (active.length) {
      state = active.every(turn => turn.stage === 'saved') ? 'saved' : 'active';
      label = active.some(turn => turn.stage === 'generating') ? 'Running' : state === 'saved' ? 'Saved, not committed' : 'Assigned';
    }
    if (retained) { state = 'retained'; label = 'Last observed'; }
    return { ...n, title: n.label, state, label, taskIds: ids };
  });
}
