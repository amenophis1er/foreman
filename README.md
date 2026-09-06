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

## Install

Foreman needs Node 20 or newer and a Claude Code login (or an API key) on the
machine it runs on. Then:

```sh
npx @amenophis1er/foreman            # try it — starts the server, serves http://localhost:4177
npm install -g @amenophis1er/foreman # keep it — then `foreman` from any shell
```

```sh
foreman doctor             # what this machine can run, what is missing, how to fix it
foreman                    # start in this terminal (Ctrl+C stops it)
foreman up                 # …or in the background; foreman down stops it, foreman status asks
foreman open               # the dashboard, in your browser
foreman service install    # keep it running for good: start at login, restart if it dies
foreman --help             # the rest, and the environment variables
```

`foreman doctor` prints the same checklist the server prints on start —
credentials and which account pays, the Claude Code install, Ollama and Codex
if present, the browser missions will use, the port, Tailscale, the data
directory — and exits. Nothing blocks unless it says so.

**On the move.** If the machine is on a [Tailscale] tailnet, Foreman listens
on the tailnet address too (never on every interface — there is no login),
and the links it sends to your phone use the tailnet name. Link the Telegram
bot in Settings → Notifications and the phone can answer asks, plan and start
missions, and open what the crew built. `foreman service install` is what
keeps the server up while the lid is closed.

**Platforms.** macOS is where Foreman is developed and tested. Linux is
verified on Debian with Node 22: install, `foreman doctor`, `foreman up` /
`status` / `down` and the dashboard all work; `foreman service install` needs
a systemd user session (a desktop, or `loginctl enable-linger`), and browser
missions need Google Chrome or `npx playwright install chromium` with
`FOREMAN_BROWSER=chromium`. Windows is not yet tested natively — use WSL2 for
now; `foreman service` has no Windows implementation, `foreman up` works.

**From a checkout** (contributing):

```sh
npm ci && npm run setup      # dependencies, then the dashboard build
npm start                    # serves http://localhost:4177
npm test · npm run typecheck · npm run dev   # tests · both tsconfigs · API + Vite together
```

[Tailscale]: https://tailscale.com

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

Dev loop: `npm run dev` (API + Vite, proxied to :4177) · `npm test` ·
`npm run typecheck` · `scripts/dev-restart.sh` (restarts the server only when
no run, ask or planner turn would be lost).

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
