# Foreman — design concept

> **Working name: Foreman.** A foreman runs a crew on a job site. Here the job
> site is a folder on your machine, the crew is Claude agents, and you hand it
> a mission instead of a checklist. Rename freely (alternates: Overseer, Helm,
> Conductor, Steward, Skipper).

**One line:** an autonomous mission runner. You pick a project folder, type a
mission, and Foreman plans it, spawns Claude agents to do the work in that
folder, steers them, answers their questions, approves their tools, verifies
the result, and reports back — from a single UI, with no terminal.

Status: **concept only.** No code yet. This document captures the idea and the
architecture while the lessons from `claude-golden-eye`'s director mode are
fresh.

---

## 1. Where this comes from

Foreman is the standalone, terminal-free evolution of **director mode**, which
we built and proved inside the `claude-golden-eye` plugin. There, one Claude
Code *session* (the director) autonomously ran a mission across other Claude
Code *sessions* (workers), observed and steered through golden-eye's hooks,
channel, and MCP tools. It works: in a soak test, a single mission prompt
produced a correct, tested CLI with the human touching nothing.

But director mode is bound to Claude Code **running in terminals**. That forces
two panes (director + worker), a channels research-preview flag on every
session, and manual session lifecycle. The friction is structural, not a bug.

**The pivot:** stop driving terminals. Use the **Claude Agent SDK** — the same
Claude Code engine, embeddable in an application — so Foreman *is* the program
that spawns and drives agents, with the UI as the only surface. Everything we
learned about director↔worker orchestration carries over; only the substrate
changes (SDK processes instead of terminal sessions).

### What carries over from director mode (hard-won, keep it)

- **Plan-first into a tracking doc.** The director always wrote `MISSION.md`
  (mission, DONE-when, budget, checklist, log, decisions) and re-read it every
  wake. The doc — not the context window — is the mission's source of truth, so
  it survives compaction/restart. Keep this verbatim.
- **The blocked-question protocol.** Terminal question dialogs can't be answered
  remotely, so workers were told: never ask interactively; when you need a
  decision, report "blocked" with the question and end your turn. Foreman keeps
  this shape (the SDK equivalent is a worker signalling the orchestrator), and
  it's cleaner here because the SDK has real permission callbacks.
- **Verify DONE independently.** The director never trusted a worker's "done" —
  it read the files and ran the tests itself. Non-negotiable.
- **The escalation contract.** Anything irreversible, out of scope, over
  budget, or looping → escalate to the human, don't power through.
- **Never let an agent modify its own oversight infrastructure.** A director
  once tried to patch and restart golden-eye's server to unblock itself. Hard
  rule: tooling failure is always an escalation, never a self-repair.
- **Deterministic loop guards.** The director's own events never woke it;
  action echoes weren't wake events. Any event-driven design needs the same.

---

## 2. Core concept

- **Folder-linked.** A Foreman run is bound to one directory on the system. That
  path becomes the `cwd` of every agent it spawns; all work happens there and in
  its subtree. Picking the folder in the UI is the entire "setup."
- **UI is the I/O surface.** Not a terminal. The UI: pick folder → state mission
  → watch live → answer the few things only a human should → get the result. The
  dashboard we already designed for golden-eye (agent tree, live transcripts,
  plan board, approve/deny cards) is the right starting shape.
- **Real agents, not headless one-shots.** Each worker is a full Agent-SDK
  agentic loop (tools, edits, bash, MCP, subagents) — the same Claude Code
  behavior, just embedded and streamed to the UI instead of a TTY.
- **A director drives workers.** The director role from golden-eye becomes an
  orchestration layer (see §4 for the key open decision on where its
  intelligence lives).

---

## 3. How it differs from golden-eye (and why it's a separate product)

| | golden-eye (keep as is) | Foreman (new) |
|---|---|---|
| What it is | Claude Code **plugin**: observes real terminal sessions | Standalone **app** that runs agents |
| Substrate | Claude Code CLI in terminals | Claude Agent SDK, embedded |
| Dependencies | zero runtime deps (a point of pride) | depends on the Agent SDK + tree |
| Spends tokens? | never — pure observer | yes — it *is* the agent runtime |
| Auth | none needed | Anthropic **API key** (see §9) |
| Surface | dashboard observes; terminals drive | dashboard **is** the driver |
| Lifecycle | humans open/close sessions | Foreman starts/kills/resumes agents |

These are different enough to be **two products sharing UI DNA**, not one. The
recommendation is to keep golden-eye exactly as it is (clean, zero-dep, ships
as v0.1.0) and grow Foreman independently, reusing dashboard patterns and the
director's charter wisdom. Do not rewrite golden-eye into this.

---

## 4. Architecture (draft)

```
┌─────────────────────────── UI (control plane) ───────────────────────────┐
│  pick folder · state mission · live transcripts · plan board ·            │
│  approve/deny cards · pause/kill · cost meter                             │
└───────────────▲───────────────────────────────────┬──────────────────────┘
                │ SSE/ws (stream out)                │ HTTP (commands in)
┌───────────────┴───────────────────────────────────▼──────────────────────┐
│  Orchestrator (Node service)                                              │
│   • owns runs: {folder, mission, budget, status}                         │
│   • spawns/streams/kills SDK agents; routes canUseTool → UI cards        │
│   • persists MISSION.md + run state; enforces budgets & guardrails       │
└───────────────┬───────────────────────────────────────────────────────────┘
                │ Agent SDK (query() / ClaudeSDKClient), cwd = the folder
   ┌────────────▼───────────┐        ┌──────────────────────────────┐
   │ Director agent          │  ───▶  │ Worker agent(s)              │
   │ (strong model, thinking)│        │ (build/edit/test in cwd)     │
   │ plans, steers, verifies │        │ report blocked → director    │
   └─────────────────────────┘        └──────────────────────────────┘
```

**SDK grounding (verified against current docs):**

- Package `@anthropic-ai/claude-agent-sdk` (TS) / `claude-agent-sdk` (Py);
  entry `query()` returns an async iterator of messages. Multi-turn
  continuity: Python has `ClaudeSDKClient`; TS has **no client class** — it
  uses streaming input (`AsyncIterable<SDKUserMessage>`) plus the
  `resume`/`continue` options. We stream `AssistantMessage` / `UserMessage` /
  `ResultMessage` to the UI.
- `cwd` option pins the agent to the chosen folder.
- `canUseTool(toolName, input, ctx)` callback → `Allow(updated_input?)` or
  `Deny(message)` — note deny takes **no `interrupt` flag**; mid-run
  interruption is done via the query/client's own `interrupt()` method.
  This is how UI approve/deny cards work —
  natively, no channels relay. Precedence: hooks → deny rules → ask rules →
  permission mode → allow rules → canUseTool.
- Permission modes: `default`, `acceptEdits`, `plan`, `dontAsk`, `auto`,
  `bypassPermissions`. Foreman would run workers in `default`/`acceptEdits`
  with a `canUseTool` gate, never blanket `bypassPermissions`.
- Hooks (`PreToolUse`/`PostToolUse`/`Stop`/`SubagentStop`/…) run **in the
  orchestrator process, no context cost** — perfect for feeding the same
  observability the golden-eye dashboard renders.
- `mcpServers` option → agents can use MCP tools (`mcp__<server>__<tool>`).
- Subagents via the `Agent`/`Task` tool; `agents={...}` defines them with
  per-agent model + tool restrictions + `max_turns`.
- Sessions: capture `session_id` from `ResultMessage`; `resume` / `continue` /
  `fork_session`; persisted under `~/.claude/projects/<cwd>/<id>.jsonl`, or a
  custom `session_store` for our own backend.

### The one decision that shapes everything: where does the director live?

- **Option A — Director is an SDK agent too.** Orchestrator spawns a director
  agent (strong model + extended thinking) whose *tools* are "spawn worker",
  "message worker", "answer worker", "read MISSION.md". Workers are separate SDK
  agents (or its subagents). Keeps intelligence in a model, mirrors what we
  proved. Most faithful to director mode.
- **Option B — Director is orchestrator code calling a model.** The Node
  service holds the loop and calls the model for judgment at each decision
  point. Simpler infra, but drifts back toward "intelligence in the server,"
  which we deliberately rejected in golden-eye.
- **Option C — No separate director; one agent with subagents.** A single SDK
  agent runs the mission and uses the SDK's own subagents as its crew. Simplest,
  but loses the cross-agent supervision that makes this distinctive — it's
  really just normal delegation with a tracking doc.

**Leaning: A.** It preserves the director/worker separation and the
observability story; the orchestrator stays "dumb pipes + guardrails."
Workers as separate SDK sessions (not subagents) keep them independently
observable and resumable, matching golden-eye's model.

### The director's wake loop (the hardest part of Option A — design before spike 2)

In golden-eye, the channel and hooks defined *when* the director woke and
*what* it saw. In Foreman that becomes: how does the director learn a worker
finished, blocked, or went quiet? Under Option A the orchestrator must inject
events into the director's streaming input, and every director-mode question
returns:

- **Which events wake it.** Wake granularity drives cost: a strong-model
  director woken on every worker turn burns tokens fast. Default should be
  coarse — worker *blocked*, worker *done*, milestone reached, budget
  threshold, silence timeout — not per-turn.
- **Echo filtering.** The director's own actions (messages it sent, workers it
  spawned) must never wake it. Same deterministic loop guards as golden-eye.
- **Turn coalescing.** Events arriving while the director is mid-turn queue
  and coalesce into one wake, never interleave.

Also worth naming: the director's tools ("spawn worker", "message worker",
"answer worker", "read mission doc") are **custom in-process MCP tools** the
orchestrator implements via `createSdkMcpServer` — a real chunk of the
phase-2 work.

---

## 5. Mission model

Unchanged from director mode. On start, the director writes the mission doc at
`.foreman/MISSION.md` inside the target folder (gitignored by default —
polluting a real repo's root with an agent artifact is the wrong default):

```markdown
# MISSION: <one line>
DONE WHEN: <verifiable criteria>
BUDGET: max <N> turns · <$X> · escalate at <T>
## Plan
- [ ] 1. <verifiable milestone>
## Log
## Decisions
```

The UI renders this as the plan board and reads it as run state. It is the
durable record; a Foreman run can be killed and resumed from it. That includes
**orchestrator crash recovery**: if the Node service dies mid-run, the mission
doc plus persisted SDK sessions (`sessionStore` + `resume`) are enough to
reconstruct and continue the run.

---

## 6. Safety & guardrails (first-class, not bolted on)

An autonomous agent runtime with shell access and a wallet is a different risk
class than an observer. Non-negotiables:

- **Bounded runs.** `max_turns` and `max_budget_usd` per run (the SDK enforces
  both; `error_max_budget_usd` stops subagents and refuses new spawns). Surface
  a live cost meter (`ResultMessage.total_cost_usd`) and a hard cap in the UI.
- **`canUseTool` gate, deny-by-default for danger.** Auto-allow in-folder,
  reversible operations; route anything irreversible or out-of-scope to a UI
  approve/deny card; hard-deny known-destructive patterns.
- **Folder confinement — policy-enforced, not sandboxed.** `cwd` pins where
  the agent works; it does **not** sandbox anything — Bash can write anywhere,
  and `canUseTool` path-inspection of shell commands is best-effort (paths
  hide inside scripts, redirects, `cd`). Policy: auto-allow only clearly
  in-folder writes, route the rest to approval. OS-level sandboxing (or
  containerized workers, see open questions) is the hardening path if
  policy-only proves too leaky.
- **Escalation contract** (from director mode): irreversible / out-of-scope /
  over-budget / looping → stop and ask the human.
- **No self-modification of Foreman itself.** The infra rule, carried over.
- **Pause / kill switch** always available in the UI; the orchestrator
  interrupts a running agent via the SDK's `interrupt()` on the query/client
  (deny responses carry no interrupt flag).

---

## 7. Observability

Reuse golden-eye's dashboard patterns wholesale: agent tree, full-height live
transcripts, plan board, timeline, cost/token meters. Because SDK hooks run in
the orchestrator process, we get the event stream for free without tailing
JSONL. This is where Foreman and golden-eye visibly share DNA.

---

## 8. Worker senses: browser tooling & visual verification

Workers (and the director) shouldn't have to trust "tests pass" — they should
be able to *look at* the running app. This is mostly free via `mcpServers`,
but the choice of tool matters:

- **Playwright MCP (`@playwright/mcp`) is the default.** Given to workers via
  `mcpServers`, it launches a **headless, disposable** browser: navigate,
  click, fill forms, read console errors, take screenshots. Agents genuinely
  *see* — the Read tool renders images, so a worker screenshots the page and
  visually inspects the result. The director uses the same to verify DONE
  against the real app, not just the test suite.
- **Ruled out as defaults:** tools that drive the human's real Chrome
  (claude-in-chrome style — your logged-in sessions and cookies under an
  unattended agent) and full **computer use** (desktop control — hands the
  whole machine to an agent whose story is "confined to a folder"). Keep the
  browser headless and disposable.
- **Guardrails compose.** Browser MCP tools flow through the same
  `canUseTool` gate as everything else: auto-allow navigation to
  `localhost`, route external URLs to an approval card.
- **Docker synergy:** a Playwright-enabled base image gives the browser
  story and the isolation story in one artifact (see §12 on containerized
  workers).

---

## 9. Auth & billing (the real gate)

- **API key only.** SDK apps authenticate via `ANTHROPIC_API_KEY` (or a cloud
  provider: Bedrock/Vertex/Foundry). Anthropic does **not** permit third-party
  SDK apps to offer claude.ai login to end users — so a distributed Foreman
  can't ride users' subscriptions; each install brings its own key. For
  **personal use this is fine** (your key, your machine).
- **Foreman spends money autonomously.** Every run bills the key. Budgets and
  the cost meter aren't nice-to-haves; they're the safety floor.

---

## 10. Phased build (when we start)

> **Status (2026-09-03).** Phases 1–3 are built and verified, plus several
> items beyond the original plan:
> phase 1 spike (one worker, SSE transcript, approve/deny) ✅ ·
> phase 2 director (MISSION.md, spawn/message workers, ask_human, budgets,
> independent verification) ✅ · phase 3 dashboard (React + design system,
> agent tree, transcript, plan board) ✅ · persistence (append-only event
> logs, atomic meta, orphan sweep, history replay) ✅ · **fleet** (multi-
> project home, zoomable project views, composer, concurrent missions —
> one per project) ✅ · per-mission model selection (director/workers) ✅ ·
> resume of interrupted runs via director session restore ✅.
> Parallel workers already occur naturally (the director issues parallel
> spawn_worker tool calls); phase 4 below remains for the *management*
> around them (wake loop, steering, conflict policy).

1. **Spike:** orchestrator spawns ONE SDK worker in a chosen folder, streams its
   transcript to a minimal UI, `canUseTool` → an approve/deny card. Prove the
   substrate end to end.
2. **Mission + director (Option A):** director agent plans `MISSION.md`, spawns
   one worker, steers via tools, verifies DONE, respects budgets. This is
   director-mode reborn without terminals.
3. **Dashboard parity:** port golden-eye's tree/transcript/plan/timeline views.
4. **Multi-worker:** director runs N workers for one mission. N workers
   sharing one `cwd` will trample each other's edits — per-worker git
   worktrees (or serialized write access) is the likely answer.
5. **Polish:** pause/resume/kill, run history, cost caps, guardrail tuning.

---

## 11. Non-goals (at least at first)

- Not a hosted/multi-tenant service (API-key + local only to start).
- Not a replacement for golden-eye — the observer plugin stays its own thing.
- Not blanket `bypassPermissions`. Autonomy comes from good `canUseTool`
  policy + budgets, never from removing the floor.

---

## 12. Open questions

- Director substrate: confirm Option A vs C after the spike.
- Workers as separate SDK sessions vs subagents (observability & resume vs
  simplicity).
- How much of golden-eye's server/UI can be literally reused vs forked.
- Do we ever need a human-in-the-loop "review before commit/push" stage as a
  built-in mission phase?
- Containerized workers (Docker): worth it for isolation/"full unleash" runs,
  or is policy + budgets enough for personal use?
