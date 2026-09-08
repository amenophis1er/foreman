import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { doneWhen, eventLine, foremanTools, isForemanCheckout, waitForRunEvent } from './mcp.js';

/** A Foreman server as the tools see it: routes answered from a table, requests recorded. */
function fakeServer(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${url.pathname}${url.search}`;
    const keyNoQuery = `${init?.method ?? 'GET'} ${url.pathname}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, body });
    const hit = key in routes ? routes[key] : routes[keyNoQuery];
    if (hit === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const val = typeof hit === 'function' ? (hit as (b: unknown) => unknown)(body) : hit;
    if (val instanceof Response) return val;
    return new Response(JSON.stringify(val), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const run = (o: Record<string, unknown> = {}) => ({
  id: 'r1', projectId: 'p1', mission: 'Fix the thing', title: 'Fix', status: 'running', costUsd: 1.25, budgetUsd: 5,
  costBasis: 'priced', createdAt: 1, directorModel: 'fable', workerModel: 'opus',
  workers: [{ id: 'worker-1', status: 'done', costUsd: 0.4, task: 'write tests' }],
  git: { branch: 'foreman/fix-r1', base: 'main' }, ...o,
});
const tool = (tools: ReturnType<typeof foremanTools>, name: string) => tools.find((t) => t.name === name)!;

test('fleet_status reads /projects and says what needs a human', async () => {
  const { fetchImpl } = fakeServer({
    'GET /projects': { version: '0.1.12', projects: [
      { id: 'p1', name: 'app', folder: '/x/app', activeRun: run(), lastRun: null, pendingPermissions: 1, pendingQuestions: 0, git: { branch: 'main' } },
      { id: 'p2', name: 'lib', folder: '/x/lib', activeRun: null, lastRun: { id: 'r0', mission: 'Old', status: 'done', costUsd: 2, createdAt: 1 }, pendingPermissions: 0, pendingQuestions: 0 },
    ] },
  });
  const r = await tool(foremanTools({ base: 'http://f', fetchImpl }), 'fleet_status').run({});
  assert.match(r.text, /app \(p1\).*main\n  running: r1 · running · \$1\.25 of \$5\.00/);
  assert.match(r.text, /NEEDS YOU: 1 pending/);
  assert.match(r.text, /lib \(p2\)[^\n]*\n  idle · last: done · \$2\.00/);
});

test('run_status: crew, DONE WHEN from the mission doc, needs, and no wait on a finished run', async () => {
  const { fetchImpl, calls } = fakeServer({
    'GET /runs': { runs: [run({ status: 'interrupted', stopReason: 'budget' })] },
    'GET /projects': { projects: [{ id: 'p1', name: 'app', folder: '/x/app', activeRun: null, lastRun: null, needs: [] }] },
    'GET /missiondoc': { doc: '# M\n## DONE WHEN\n- [x] tests pass\n- [ ] docs updated\n' },
  });
  const r = await tool(foremanTools({ base: 'http://f', fetchImpl }), 'run_status').run({ runId: 'r1', wait_seconds: 30 });
  assert.match(r.text, /stopped at its budget cap/);
  assert.match(r.text, /DONE WHEN 1\/2\n  open: docs updated/);
  assert.match(r.text, /worker-1 · done/);
  assert.match(r.text, /changed: no/);
  assert.ok(!calls.some((c) => c.path.startsWith('/events')), 'a finished run is never waited on');
});

test('run_status with a wait subscribes to /events and returns on the first event for that run', async () => {
  const sse = new ReadableStream<Uint8Array>({
    start(c) {
      const enc = new TextEncoder();
      c.enqueue(enc.encode(': connected\n\n'));
      c.enqueue(enc.encode('event: cost\ndata: {"runId":"other","projectId":"p9","data":{}}\n\n'));
      c.enqueue(enc.encode('event: worker_started\ndata: {"runId":"r1","projectId":"p1","data":{"id":"worker-2"}}\n\n'));
    },
  });
  const { fetchImpl } = fakeServer({
    'GET /runs': { runs: [run()] },
    'GET /projects': { projects: [{ id: 'p1', name: 'app', folder: '/x/app', activeRun: run(), needs: [{ kind: 'perm', id: 'a1', runId: 'r1', text: 'director wants Bash — rm -rf dist' }] }] },
    'GET /missiondoc': { doc: '' },
    'GET /events': new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  });
  const r = await tool(foremanTools({ base: 'http://f', fetchImpl }), 'run_status').run({ runId: 'r1', wait_seconds: 5 });
  assert.match(r.text, /changed: yes/);
  assert.match(r.text, /NEEDS YOU \(1\) — only a human can answer/);
  assert.match(r.text, /\[perm\] director wants Bash/);
});

test('waitForRunEvent gives up at the timeout when nothing arrives for the run', async () => {
  const quiet = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(': connected\n\n')); } });
  const { fetchImpl } = fakeServer({ 'GET /events': new Response(quiet, { status: 200 }) });
  const t0 = Date.now();
  assert.equal(await waitForRunEvent('http://f', 'r1', 1, fetchImpl), false);
  assert.ok(Date.now() - t0 >= 900, 'waited about the timeout');
});

test('start_mission: 409 is a fact, the run id is read back, and Foreman itself is refused', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'foreman-mcp-'));
  const self = path.join(dir, 'foreman'); await mkdir(path.join(self, 'src'), { recursive: true });
  await writeFile(path.join(self, 'package.json'), JSON.stringify({ name: 'x', bin: { foreman: 'bin/foreman.mjs' } }));
  assert.equal(isForemanCheckout(self), true);
  assert.equal(isForemanCheckout(dir), false);
  let started = false;
  const { fetchImpl, calls } = fakeServer({
    'GET /projects': { projects: [{ id: 'p1', name: 'app', folder: dir, activeRun: null }, { id: 'pf', name: 'foreman', folder: self, activeRun: null }] },
    'POST /run': (b: unknown) => { started = true; return (b as { projectId: string }).projectId === 'busy' ? new Response(JSON.stringify({ error: 'busy' }), { status: 409 }) : { ok: true }; },
    'GET /runs': () => ({ runs: started ? [run({ status: 'running', budgetUsd: 3 })] : [] }),
  });
  const tools = foremanTools({ base: 'http://f', fetchImpl });
  const refused = await tool(tools, 'start_mission').run({ projectId: 'pf', brief: 'Harden the server please', budgetUsd: 3 });
  assert.match(refused.text, /Refused: this folder is Foreman itself/);
  assert.ok(!calls.some((c) => c.method === 'POST'), 'nothing was posted for the refused one');
  const ok = await tool(tools, 'start_mission').run({ projectId: 'p1', brief: 'Fix the flaky test in ci', budgetUsd: 3, worker: 'sonnet' });
  assert.match(ok.text, /Started r1 on app, cap \$3\.00/);
  assert.deepEqual(calls.find((c) => c.method === 'POST')!.body, { projectId: 'p1', mission: 'Fix the flaky test in ci', budgetUsd: 3, workerModel: 'sonnet' });
  await rm(dir, { recursive: true, force: true });
});

test('the tool set has no human-only actions', () => {
  const names = foremanTools({ base: 'http://f' }).map((t) => t.name);
  for (const forbidden of ['approve', 'deny', 'permission', 'answer', 'interrupt', 'resume', 'budget', 'pull_request', 'open_pr', 'settings', 'key']) {
    assert.ok(!names.some((n) => n.split('_').includes(forbidden) || n === forbidden), `${forbidden} must not be a tool`);
  }
  assert.deepEqual(names, ['fleet_status', 'list_runs', 'run_status', 'run_transcript', 'mission_doc', 'project_memory', 'search_runs', 'doctor', 'link_project', 'start_mission', 'steer']);
});

test('a server that is not there is said in one sentence with the start command', async () => {
  const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
  await assert.rejects(tool(foremanTools({ base: 'http://localhost:4177', fetchImpl }), 'fleet_status').run({}), /not answering at http:\/\/localhost:4177 .*Start it with `foreman`/);
});

test('eventLine and doneWhen condense what the transcript and the doc say', () => {
  assert.equal(eventLine('permission_request', { agent: 'director', toolName: 'Bash', decisionReason: 'leaves the folder' }), 'NEEDS YOU — director wants Bash (leaves the folder)');
  assert.equal(eventLine('message', { agent: 'worker-1', msg: { type: 'assistant', message: { content: [{ type: 'text', text: 'Done.\n\nAll  green.' }] } } }), 'worker-1: Done. All green.');
  assert.equal(eventLine('message', { agent: 'w', msg: { type: 'user' } }), null);
  assert.equal(eventLine('cost', {}), null);
  assert.deepEqual(doneWhen('- [ ] a\n* [x] b\n- [X] c\nnot a box'), { done: ['b', 'c'], open: ['a'] });
});
