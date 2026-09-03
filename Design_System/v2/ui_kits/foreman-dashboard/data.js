// Fake mission data for the Foreman dashboard UI kit. Shapes mirror src/types.ts.
const T0 = Date.now() - 75_000; // run started ~75s ago so the live timeline has a readable axis
const t = (s) => T0 + s * 1000;

const MISSION_ALPHA = 'Step 1: use ask_human to ask me which filename to create in the working directory. Wait for my answer. Step 2: spawn a worker to create that file containing the word "test". Step 3: verify it independently.';

const PLAN = (done) => {
  const items = [
    'Ask the human for the filename (ask_human) and wait for the answer.',
    'Spawn a worker to create the file with content "test".',
    'Verify the file exists and contains "test".',
  ];
  return ['# Mission', '', `Ask the human which filename to create, then have a worker create that file`,
    'containing the word "test".', '', '## DONE WHEN', '',
    ...items.map((x, i) => `- [${i < done ? 'x' : ' '}] ${x}`), '',
    '## Log', '', '- 07:53:14 director wrote this document', ...(done > 0 ? ['- 07:53:31 human answered: hello.txt'] : []),
  ].join('\n');
};

// One scripted run, advanced by the operator's own actions.
const PHASES = {
  planning: {
    runStatus: 'running', costUsd: 0.12, done: 0,
    agents: [{ id: 'director', status: 'running' }],
    entries: [
      { id: 1, agent: 'director', title: 'init', kind: 'system', body: 'model: claude-fable-5-1', ts: t(0) },
      { id: 2, agent: 'director', kind: 'text', body: "I'll write the mission file first, then ask you for the filename.", ts: t(2) },
      { id: 3, agent: 'director', title: 'Write', kind: 'tool', body: '{"file_path":"/Users/you/Projects/personal-foreman/scratchpad/fleet-alpha/.foreman/MISSION.md","content":"# Mission\\n\\nAsk the human which filename to create, then have a worker create that file containing the word \\"test\\".\\n\\n## DONE WHEN\\n\\n- A file with the chosen name exists in the working directory and contains the word \\"test\\".\\n- Verified by reading the file"}', ts: t(6) },
      { id: 4, agent: 'director', title: 'result', kind: 'result', body: 'The file /Users/you/Projects/personal-foreman/scratchpad/fleet-alpha/.foreman/MISSION.md has been updated successfully.', ts: t(7) },
    ],
    approvals: [], questions: [],
  },
  question: {
    runStatus: 'running', costUsd: 0.31, done: 0,
    agents: [{ id: 'director', status: 'running' }],
    entries: [
      { id: 5, agent: 'director', title: 'ask_human', kind: 'tool', body: '{"question":"Which filename should I create in the working directory (fleet-alpha)? The file will contain the word \\"test\\". Please reply with the exact filename, e.g. \\"hello.txt\\"."}', ts: t(11) },
    ],
    approvals: [],
    questions: [{ id: 'q1', question: 'Which filename should I create in the working directory (fleet-alpha)? The file will contain the word "test". Please reply with the exact filename, e.g. "hello.txt".' }],
  },
  spawning: {
    runStatus: 'running', costUsd: 0.74, done: 1,
    agents: [{ id: 'director', status: 'running' }, { id: 'worker-1', status: 'running', task: 'Create hello.txt containing the word "test" in the working directory.' }],
    entries: [
      { id: 6, agent: 'director', title: 'result', kind: 'result', body: 'hello.txt', ts: t(31) },
      { id: 7, agent: 'director', title: 'spawn_worker', kind: 'tool', body: '{"id":"worker-1","task":"Create hello.txt containing the word \\"test\\" in the working directory. Report back when the file exists."}', ts: t(33) },
      { id: 8, agent: 'worker-1', kind: 'text', body: 'Creating hello.txt in the project folder.', ts: t(36) },
    ],
    approvals: [{ id: 'a1', agent: 'worker-1', title: 'Wants to use Edit', decisionReason: 'edits a file the mission did not name', input: { file_path: '/Users/you/Projects/personal-foreman/scratchpad/fleet-alpha/README.md', old_string: '# fleet-alpha\n\nScratch project.', new_string: '# fleet-alpha\n\nScratch project.\n\nContains hello.txt (created by Foreman worker-1).' } }],
    questions: [],
  },
  verifying: {
    runStatus: 'running', costUsd: 1.24, done: 2,
    agents: [{ id: 'director', status: 'running' }, { id: 'worker-1', status: 'done', task: 'Create hello.txt containing the word "test" in the working directory.' }],
    entries: [
      { id: 9, agent: 'worker-1', title: 'Write', kind: 'tool', body: '{"file_path":"/Users/you/Projects/personal-foreman/scratchpad/fleet-alpha/hello.txt","content":"test\\n"}', ts: t(41) },
      { id: 14, agent: 'worker-1', title: 'Bash', kind: 'tool', body: '{"command":"cat hello.txt && wc -c hello.txt"}', ts: t(42) },
      { id: 10, agent: 'worker-1', kind: 'text', body: 'Created hello.txt containing "test". Reporting done.', ts: t(44) },
      { id: 11, agent: 'director', title: 'Read', kind: 'tool', body: '{"file_path":"/Users/you/Projects/personal-foreman/scratchpad/fleet-alpha/hello.txt"}', ts: t(47) },
      { id: 12, agent: 'director', kind: 'text', body: "Worker reports done. Verifying independently rather than trusting the report.", ts: t(48) },
    ],
    approvals: [], questions: [],
  },
  finished: {
    runStatus: 'done', costUsd: 1.38, done: 3,
    agents: [{ id: 'director', status: 'done' }, { id: 'worker-1', status: 'done', task: 'Create hello.txt containing the word "test" in the working directory.' }],
    entries: [
      { id: 13, agent: 'director', kind: 'text', body: 'Verified: hello.txt exists in fleet-alpha and contains "test". Mission complete — 3/3 checklist items closed, $1.38 of the $5 budget spent.', ts: t(52) },
    ],
    approvals: [], questions: [],
  },
};

const ORDER = ['planning', 'question', 'spawning', 'verifying', 'finished'];

/** Accumulate every phase up to `phase` into one run view. */
function runAt(phase, { interrupted = false } = {}) {
  const upto = ORDER.slice(0, ORDER.indexOf(phase) + 1);
  const last = PHASES[phase];
  const entries = upto.flatMap((p) => PHASES[p].entries);
  return {
    mission: MISSION_ALPHA,
    budgetUsd: 5,
    costUsd: last.costUsd,
    runStatus: interrupted ? 'interrupted' : last.runStatus,
    agents: interrupted ? last.agents.map((a) => ({ ...a, status: a.status === 'done' && a.id !== 'director' ? 'done' : 'interrupted' })) : last.agents,
    entries: interrupted
      ? [...entries, { id: 99, agent: 'director', title: 'interrupted', kind: 'error', body: 'Run interrupted by the operator. The director session is preserved; Resume re-verifies state before continuing.', ts: t(60) }]
      : entries,
    approvals: interrupted ? [] : last.approvals,
    questions: interrupted ? [] : last.questions,
    missionDoc: PLAN(last.done),
    directorSessionId: 'c16e338e-4b2a-4e77-9d31-7a5a9f2c1b04',
  };
}

const HISTORY = [
  { id: 'r-old-1', mission: 'Ask me first via ask_human: which colour should the badge be? Then apply it.', createdAt: Date.now() - 7.6 * 3600_000, costUsd: 0.55, status: 'done' },
  { id: 'r-old-2', mission: 'Have a worker create alpha.txt containing the word test, then verify it.', createdAt: Date.now() - 7.65 * 3600_000, costUsd: 0.68, status: 'done' },
  { id: 'r-old-3', mission: 'Refactor the store reducer into pure functions and add tests.', createdAt: Date.now() - 10.8 * 3600_000, costUsd: 2.9, status: 'interrupted' },
];

const FOLDERS = {
  '/Users/you': { parent: null, dirs: ['Archive', 'Documents', 'Downloads', 'Projects'] },
  '/Users/you/Projects': { parent: '/Users/you', dirs: ['claude-golden-eye', 'personal-foreman', 'website'] },
  '/Users/you/Projects/personal-foreman': { parent: '/Users/you/Projects', dirs: ['scratchpad', 'src', 'ui'] },
  '/Users/you/Projects/personal-foreman/scratchpad': { parent: '/Users/you/Projects/personal-foreman', dirs: ['fleet-alpha', 'fleet-beta', 'fleet-gamma'] },
};

/** What `GET /models` returns. The kit resolves it after a short delay so the picker's loading state is visible. */
const MODELS = [
  { id: 'fable', label: 'Fable', model: 'claude-fable-5-1', cost: 4, note: 'Frontier. Long-horizon planning and verification.' },
  { id: 'opus', label: 'Opus', model: 'claude-opus-4-1', cost: 3, note: 'Deep reasoning for hard refactors.' },
  { id: 'sonnet', label: 'Sonnet', model: 'claude-sonnet-4-5', cost: 2, note: 'Balanced. The usual worker.' },
  { id: 'haiku', label: 'Haiku', model: 'claude-haiku-4-5', cost: 1, note: 'Fast and cheap for reads and mechanical edits.' },
];
const fetchModels = () => new Promise((r) => setTimeout(() => r(MODELS), 900));

Object.assign(window, { FMK: { MISSION_ALPHA, ORDER, runAt, HISTORY, FOLDERS, PLAN, MODELS, fetchModels } });
