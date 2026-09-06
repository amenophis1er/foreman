#!/usr/bin/env bash
# Restart the dev server — but only when nothing would be lost.
#
# A restart kills every run and planner turn in flight. Checking "is anything
# running?" and then restarting a moment later once raced a mission started
# from a phone in between, and cut it off thirteen seconds in. So the check
# and the kill happen here, back to back, and the script refuses when a run
# is active, an ask is waiting, or a planner is replying. Pass --force to
# override, on purpose, with your eyes open.
set -euo pipefail
PORT="${PORT:-4177}"
LOG="${FOREMAN_LOG:-/private/tmp/foreman-server.log}"
FORCE="${1:-}"

busy() {
  curl -sf "http://localhost:${PORT}/projects" | python3 -c '
import json, sys, urllib.request
d = json.load(sys.stdin)
running = [p["name"] for p in d["projects"] if p.get("activeRun")]
needs = sum(len(p.get("needs") or []) for p in d["projects"])
thinking = []
for p in d["projects"]:
    try:
        c = json.load(urllib.request.urlopen(f"http://localhost:'"${PORT}"'/chat?projectId={p[\"id\"]}", timeout=3))
        if c.get("thinking"): thinking.append(p["name"])
    except Exception:
        pass
if running or needs or thinking:
    print(f"running={running} needs={needs} planners={thinking}")
    sys.exit(1)
' 2>/dev/null
}

if [ "$FORCE" != "--force" ]; then
  if ! out=$(busy); then
    echo "refusing to restart: $out" >&2
    echo "  (pass --force to do it anyway)" >&2
    exit 2
  fi
fi

pkill -f "tsx src/server.ts" || true
sleep 1
nohup npm exec tsx src/server.ts > "$LOG" 2>&1 &
for _ in $(seq 1 30); do
  sleep 0.5
  if curl -sf "http://localhost:${PORT}/projects" >/dev/null 2>&1; then
    tail -n 1 "$LOG"
    exit 0
  fi
done
echo "server did not come up; see $LOG" >&2
exit 1
