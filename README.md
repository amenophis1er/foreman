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
npm ci && npm --prefix ui ci   # ci, not install — honours the lockfiles
npm run ui:build               # build the dashboard
npm start                      # serves http://localhost:4177
```

Installed as a package, `foreman` starts the server from any directory;
`foreman --help` lists the environment variables.

### Which account pays

The SDK spawns your local Claude Code engine, so missions run on whatever that
install is logged in with — a Claude subscription or an `ANTHROPIC_API_KEY`.
Both report real per-run cost, so budgets bind either way.

A machine can hold more than one login, and `CLAUDE_CONFIG_DIR` inherited from
the launching shell silently decides which one is used. So startup prints the
account it resolved to, and the dashboard shows it beside every place a mission
can be started:

```
✓ Credentials     Claude subscription — you@example.com · Your Org
✓ Claude Code     /Users/you/.claude · bundled executable
```

Pin it explicitly with `FOREMAN_CLAUDE_CONFIG_DIR`, and assert the mode you
intend with `FOREMAN_AUTH_MODE=api-key|subscription` so an unset key fails at
startup instead of quietly billing the other account. A project can pin its own
install, and choose whether it inherits the server's billing or uses that
install's own login — which is what makes personal and work projects coexist on
one server.

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
