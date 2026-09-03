---
name: director
description: Kick off a Foreman mission for the current project — ensures the Foreman server is running, links the session's cwd as a project, starts a director-led mission with the given brief, and opens the dashboard. Usage - /director <mission brief> [--budget N] [--worker sonnet|haiku|opus] [--director opus|sonnet|haiku]
---

# /director — launch a Foreman mission from this session

You are the launcher only. The mission itself runs in Foreman's own director
and worker sessions with budgets, approval cards, and MISSION.md governance;
the human supervises from the dashboard, not from this session. Do NOT do the
mission's work yourself here.

Foreman lives at `~/Projects/personal/foreman`, serving `http://localhost:4177`.

## Steps

1. **Safety guard.** If the current working directory is inside
   `~/Projects/personal/foreman`, STOP and tell the user: Foreman must never
   run missions on itself (oversight-infrastructure rule).

2. **Parse the arguments.** Everything except the flags is the mission brief.
   Flags: `--budget N` (default 5), `--worker <model>`, `--director <model>`
   (models: opus | sonnet | haiku; omit for default). If there is no brief at
   all, skip steps 4–5: just ensure the server (step 3), link the project
   (step 4's curl), and open the dashboard.

3. **Ensure the server is up** (start detached if not):
   ```bash
   curl -sf -m 2 http://localhost:4177/projects >/dev/null || \
     (cd ~/Projects/personal/foreman && nohup npm start > /tmp/foreman-server.log 2>&1 & disown; sleep 3)
   ```

4. **Link the cwd as a project** (idempotent — relinking returns the existing
   project). Capture the project id from the JSON response:
   ```bash
   curl -s -X POST http://localhost:4177/projects \
     -H 'content-type: application/json' \
     -d "{\"folder\": \"$PWD\"}"
   ```

5. **Start the mission** (include directorModel/workerModel keys only when
   the flags were given):
   ```bash
   curl -s -X POST http://localhost:4177/run \
     -H 'content-type: application/json' \
     -d '{"projectId": "<id>", "mission": "<brief>", "budgetUsd": <budget>}'
   ```
   A 409 means this project already has an active mission — report that and
   still open the dashboard.

6. **Open the dashboard** on the project and report:
   ```bash
   open "http://localhost:4177/#/p/<projectId>"
   ```
   Tell the user: the mission is running under a $N budget; approvals and
   director questions will appear in the dashboard (they wait indefinitely —
   nothing expires); this terminal session is free for other work.
