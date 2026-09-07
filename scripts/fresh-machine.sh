#!/usr/bin/env bash
# A first-time user's machine, for looking at the onboarding: plain Node,
# nobody signed in to anything, no Chrome, no gh. Packs the working tree,
# installs it globally in a container as an ordinary user, and starts it with
# the dashboard on http://localhost:4190 (services on 4191).
#
#   scripts/fresh-machine.sh           build and start (replaces a running one)
#   scripts/fresh-machine.sh doctor    just run `foreman doctor` and exit
#   scripts/fresh-machine.sh stop      remove the container
#   ANTHROPIC_API_KEY=sk-ant-… scripts/fresh-machine.sh   the signed-in (API key) path
#   FRESH_BROWSER_DEPS=1 scripts/fresh-machine.sh          with Chromium's system libraries, so a
#                                                          browser installed from the setup page runs
#
# FOREMAN_BIND=all inside, because the container's loopback is not the host's;
# the port is published on 127.0.0.1 only, so nothing else can reach it.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=foreman-fresh
case "${1:-start}" in
  stop) docker rm -f "$NAME" >/dev/null 2>&1 || true; echo "stopped"; exit 0 ;;
esac
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT
cp scripts/fresh-machine/Dockerfile "$BUILD/Dockerfile"
TGZ=$(npm pack --pack-destination "$BUILD" 2>/dev/null | tail -1)
mv "$BUILD/$TGZ" "$BUILD/foreman.tgz"
docker build -q --build-arg "BROWSER_DEPS=${FRESH_BROWSER_DEPS:-0}" -t "$NAME" "$BUILD" >/dev/null
case "${1:-start}" in
  doctor) docker run --rm "$NAME" foreman doctor ;;
  start)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    # An API key set in the shell that runs this script is handed to the
    # container's environment — the signed-in path, without the key passing
    # through anything but the shell you typed it in. A key exported inside
    # `docker exec` reaches only that shell, never the server (PID 1).
    docker run -d --name "$NAME" -p 127.0.0.1:4190:4177 -p 127.0.0.1:4191:4178 \
      ${ANTHROPIC_API_KEY:+-e ANTHROPIC_API_KEY} "$NAME" >/dev/null
    sleep 3; docker logs "$NAME" 2>&1 | tail -20
    echo; echo "fresh machine: http://localhost:4190  ·  shell: docker exec -it $NAME bash  ·  stop: $0 stop" ;;
esac
