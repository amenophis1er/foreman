# Foreman

An autonomous mission runner on the [Claude Agent SDK]. You link project
folders, write a mission, and Foreman's **director** agent plans it into
`.foreman/MISSION.md`, delegates implementation to **worker** sessions,
answers or escalates their questions, verifies the result independently, and
reports back — all from one browser dashboard, no terminal.

Foreman is the standalone evolution of [claude-golden-eye]'s director mode:
same director/worker doctrine, but the agents are embedded SDK sessions
driven by this app instead of terminal sessions observed by a plugin.
(Golden-eye still observes Foreman's agents for free — they are real Claude
Code sessions.)

## Run it

```sh
npm install && npm --prefix ui install
npm run ui:build     # build the dashboard
npm start            # serves http://localhost:4177
```

Auth: the SDK spawns your local Claude Code engine, so whatever Claude Code
is logged in with (claude.ai subscription or `ANTHROPIC_API_KEY`) is what
missions run on. Dollar figures shown are notional API-rate costs.

Dev loop: `npm run ui:dev` (Vite, proxies to :4177) · `npm test` (store
tests) · `npx tsc -p .` and `npm --prefix ui run typecheck`.

## Using it

1. **Fleet** (`/`): link a folder as a project. Cards show status, live
   mission cost, and a pulsing **needs you** strip when approvals or
   questions wait.
2. **Project view**: write the mission in the composer (say what DONE looks
   like; flag decisions the director must ask you about), set a budget cap
   and optional director/worker models, Start.
3. While running: approve/deny tool cards (or **Always** per tool per run),
   answer director questions, watch the plan board tick as MISSION.md
   updates. Interrupt anytime.
4. Every run persists (`~/.foreman/`): refresh-proof, browsable history with
   full replay, and a **⟳ Resume** button on interrupted runs that restores
   the director's session and re-verifies state before continuing.

Missions in real repositories are fine: `.foreman/` git-ignores itself, the
repo's `CLAUDE.md` loads into workers, and git operations go through your
approval cards.

## Architecture

```
ui/            React 19 + Vite dashboard (design tokens in src/design/)
src/server.ts  HTTP + SSE wiring only
src/orchestrator.ts  MissionRun: director + workers + budget + escalation
src/policy.ts  permission policy (what auto-allows vs. asks you)
src/store.ts   ~/.foreman persistence: append-only event logs, atomic meta
src/types.ts   shared contracts
```

- **One active mission per project; many across projects.** SSE frames carry
  `{runId, projectId}` envelopes; persisted logs are replayed through the
  same reducer that renders live events.
- The director's tools (`spawn_worker`, `message_worker`, `ask_human`) are
  in-process MCP tools; worker calls block inside the director's tool call,
  so reports land in its context as ordinary tool results.
- Budgets are enforced before any new worker work; guarded asks (e.g. writes
  outside the folder) always prompt, even after "Always".

Design history and roadmap: [DESIGN.md](DESIGN.md).

[Claude Agent SDK]: https://code.claude.com/docs/en/agent-sdk
[claude-golden-eye]: ../claude-golden-eye
