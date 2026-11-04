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
