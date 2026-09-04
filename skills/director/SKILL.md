---
name: director
description: Kick off a Foreman mission for the current project — ensures the Foreman server is running, links the session's cwd as a project, starts a director-led mission with the given brief, and opens the dashboard. Usage - /director <mission brief> [--budget N] [--worker sonnet|haiku|opus] [--director opus|sonnet|haiku]
---

# /director — launch a Foreman mission from this session

You are the launcher only. The mission itself runs in Foreman's own director
and worker sessions with budgets, approval cards, and MISSION.md governance;
the human supervises from the dashboard, not from this session. Do NOT do the
mission's work yourself here.

Foreman serves `http://localhost:4177` and is started with the `foreman`
command. Set `FOREMAN_URL` to point at a different host or port.

## Steps

1. **Safety guard.** If the current working directory is inside a Foreman
   checkout, STOP and tell the user: Foreman must never run missions on itself
   (oversight-infrastructure rule). A directory whose `package.json` has a
   `foreman` bin, or which contains `src/orchestrator.ts` alongside
   `src/policy.ts`, is a Foreman checkout.

2. **Parse the arguments.** Everything except the flags is the mission brief.
   Flags: `--budget N` (default 5), `--worker <model>`, `--director <model>`
   (models: opus | sonnet | haiku; omit for default). If there is no brief at
   all, skip steps 4–5: just ensure the server (step 3), link the project
   (step 4's curl), and open the dashboard.

3. **Ensure the server is up** (start detached if not):
   ```bash
   curl -sf -m 2 "${FOREMAN_URL:-http://localhost:4177}/projects" >/dev/null || \
     (nohup foreman start > /tmp/foreman-server.log 2>&1 & disown; sleep 3)
   ```

4. **Link the cwd as a project** (idempotent — relinking returns the existing
   project). Capture the project id from the JSON response:
   ```bash
   curl -s -X POST "${FOREMAN_URL:-http://localhost:4177}/projects" \
     -H 'content-type: application/json' \
     -d "{\"folder\": \"$PWD\"}"
   ```

5. **Start the mission** (include directorModel/workerModel keys only when
   the flags were given):
   ```bash
   curl -s -X POST "${FOREMAN_URL:-http://localhost:4177}/run" \
     -H 'content-type: application/json' \
     -d '{"projectId": "<id>", "mission": "<brief>", "budgetUsd": <budget>}'
   ```
   A 409 means this project already has an active mission — report that and
   still open the dashboard.

6. **Open the dashboard and hand off.** Auto-open the project view
   (ignore failure — e.g. over SSH):
   ```bash
   open "${FOREMAN_URL:-http://localhost:4177}/#/p/<projectId>" 2>/dev/null || true
   ```
   Then ALWAYS print the control URL verbatim in your final message — it is
   the single place to approve tools and answer the director's questions:

   > Mission running under a $N budget.
   > **Control it here: http://localhost:4177/#/p/<projectId>**
   > Approvals and questions wait there indefinitely (nothing expires);
   > this terminal session is free for other work.
