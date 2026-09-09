#!/usr/bin/env bash
#
# Builds a self-contained Foreman bundle for a machine that cannot reach the
# npm registry: the package, every runtime dependency, the prebuilt dashboard
# and the target's platform binaries, in one tarball with an installer.
#
# Usage:
#   scripts/pack-offline.sh                          # this machine's platform, the version in package.json
#   scripts/pack-offline.sh --target linux-x64
#   scripts/pack-offline.sh --target linux-arm64-musl --version 0.1.17
#   scripts/pack-offline.sh --all                    # every target below
#   scripts/pack-offline.sh --target darwin-arm64 --out ~/bundles
#
# Targets: darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl
#
# The bundle is built from the PUBLISHED package, not from this checkout, so it
# is exactly what npm would install — and it is verified before it is packed:
# a cross-platform install silently omits optional binaries when the flags are
# wrong (npm skips what does not match os/cpu/libc), and a bundle missing them
# fails only on the target machine, hours later. This script would rather fail
# here.
set -euo pipefail

PKG=@amenophis1er/foreman
ALL_TARGETS="darwin-arm64 darwin-x64 linux-x64 linux-arm64 linux-x64-musl linux-arm64-musl"

here=$(cd "$(dirname "$0")/.." && pwd)
version=$(node -p "require('$here/package.json').version")
out="$here/dist-offline"
targets=""

while [ $# -gt 0 ]; do
  case "$1" in
    --target) targets="$targets $2"; shift 2 ;;
    --all) targets="$ALL_TARGETS"; shift ;;
    --version) version="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# On Linux the architecture is only half the answer: a glibc bundle's `claude`
# binary will not run on a musl machine, and `uname` says nothing about which
# this is. Ask ldd, and refuse to guess when it will not say.
host_libc() {
  if ldd --version 2>&1 | grep -qi musl; then echo musl
  elif ldd --version 2>&1 | grep -qiE 'glibc|gnu libc'; then echo glibc
  elif [ -e /lib/ld-musl-x86_64.so.1 ] || [ -e /lib/ld-musl-aarch64.so.1 ]; then echo musl
  else echo unknown
  fi
}

if [ -z "$targets" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) targets=darwin-arm64 ;;
    Darwin-x86_64) targets=darwin-x64 ;;
    Linux-x86_64|Linux-aarch64|Linux-arm64)
      case "$(uname -m)" in x86_64) arch=x64 ;; *) arch=arm64 ;; esac
      case "$(host_libc)" in
        glibc) targets="linux-$arch" ;;
        musl)  targets="linux-$arch-musl" ;;
        *) echo "cannot tell whether this machine is glibc or musl; pass --target linux-$arch or --target linux-$arch-musl" >&2; exit 2 ;;
      esac ;;
    *) echo "cannot guess this machine's target; pass --target" >&2; exit 2 ;;
  esac
fi

# npm needs --os/--cpu/--libc to fetch another platform's optional packages;
# they arrived in npm 10.
npm_major=$(npm --version | cut -d. -f1)
[ "$npm_major" -ge 10 ] || { echo "npm 10 or newer is needed to build for another platform (have $(npm --version))" >&2; exit 1; }

mkdir -p "$out"

for target in $targets; do
  case "$target" in
    darwin-arm64)      os=darwin cpu=arm64 libc="" ;;
    darwin-x64)        os=darwin cpu=x64   libc="" ;;
    linux-x64)         os=linux  cpu=x64   libc=glibc ;;
    linux-arm64)       os=linux  cpu=arm64 libc=glibc ;;
    linux-x64-musl)    os=linux  cpu=x64   libc=musl ;;
    linux-arm64-musl)  os=linux  cpu=arm64 libc=musl ;;
    *) echo "unknown target: $target (one of: $ALL_TARGETS)" >&2; exit 2 ;;
  esac

  echo "==> $PKG@$version for $target"
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT

  set -- --omit=dev --os="$os" --cpu="$cpu"
  [ -n "$libc" ] && set -- "$@" --libc="$libc"
  ( cd "$work" && npm install "$@" "$PKG@$version" >/dev/null 2>&1 )

  root="$work/node_modules"
  # The two that are platform-specific, and the two the target cannot do
  # without: tsx runs the server through esbuild, and the Agent SDK ships the
  # `claude` binary the crew actually runs.
  sdk_suffix="$target"
  case "$target" in *-musl) sdk_suffix="${target}" ;; esac
  for expected in "$root/@esbuild/${os}-${cpu}" "$root/@anthropic-ai/claude-agent-sdk-${sdk_suffix}"; do
    [ -d "$expected" ] || { echo "  MISSING $expected — the bundle would fail on the target machine" >&2; exit 1; }
  done
  [ -f "$root/@amenophis1er/foreman/ui/dist/index.html" ] || { echo "  the dashboard is not in the package" >&2; exit 1; }
  [ -e "$root/.bin/foreman" ] || { echo "  no foreman entry point in node_modules/.bin" >&2; exit 1; }

  stage="$work/stage/foreman-$version"
  mkdir -p "$stage"
  mv "$root" "$stage/node_modules"

  cat > "$stage/install.sh" <<'INSTALLER'
#!/bin/sh
# Foreman, with every dependency already inside. No registry needed.
#
#   ./install.sh              → beside node if that directory is writable,
#                               otherwise ~/.local/bin
#   ./install.sh ~/somewhere  → wherever you say
set -e
here=$(cd "$(dirname "$0")" && pwd)
target="$here/node_modules/.bin/foreman"

command -v node >/dev/null 2>&1 || { echo "node is not on PATH; Foreman needs Node 20 or newer."; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 20 ] || { echo "Node $(node -v) is too old; Foreman needs 20 or newer."; exit 1; }
[ -f "$target" ] || { echo "This archive looks incomplete: $target is missing."; exit 1; }

bin=${1:-}
if [ -z "$bin" ]; then
  beside=$(dirname "$(command -v node)")
  if [ -w "$beside" ]; then bin="$beside"; else bin="$HOME/.local/bin"; fi
fi
mkdir -p "$bin" 2>/dev/null || { echo "Cannot create $bin. Pass a directory you own: ./install.sh ~/.local/bin"; exit 1; }
[ -w "$bin" ] || { echo "$bin is not writable. Pass a directory you own (./install.sh ~/.local/bin), or re-run with sudo."; exit 1; }

ln -sf "$target" "$bin/foreman"
echo "Linked $bin/foreman -> $target"
case ":$PATH:" in
  *":$bin:"*) ;;
  *) echo "NOTE: $bin is not on your PATH. Add it, or re-run with a directory that is." ;;
esac
echo
echo "Next:"
echo "  foreman doctor   # credentials, ports, browser"
echo "  foreman up       # start in the background"
echo
echo "Foreman reads the credentials the Claude CLI already wrote in ~/.claude;"
echo "it never asks for a key of its own. Keep this folder where it is — the"
echo "link points into it. To uninstall: foreman stop, then remove the link"
echo "and this folder."
INSTALLER
  chmod +x "$stage/install.sh"

  cat > "$stage/README-OFFLINE.md" <<EOF
# Foreman $version — offline bundle ($target)

Everything is here: the package, its runtime dependencies, the prebuilt
dashboard and this architecture's binaries. Nothing is fetched at install time.

    tar xzf foreman-$version-$target.tgz
    cd foreman-$version
    ./install.sh

## The target machine still needs

- **Node 20 or newer**, already installed. The installer checks and refuses without it.
- **The Claude CLI's credentials** in \`~/.claude\`, for missions to run on your
  subscription. Foreman reads what a first-party CLI wrote; it never mints or
  stores credentials of its own.

Check with \`foreman doctor\`, start with \`foreman up\`.

## Notes

- Built for **$target** only. Other architectures: \`scripts/pack-offline.sh --target <name>\`.
- Each machine keeps its own \`~/.foreman\`: separate projects, runs and settings.
- \`foreman update\` needs the registry. On a machine without it, unpack a newer
  bundle and run \`install.sh\` again.
EOF

  archive="$out/foreman-$version-$target.tgz"
  tar czf "$archive" -C "$work/stage" "foreman-$version"
  rm -rf "$work"; trap - EXIT

  size=$(du -h "$archive" | cut -f1 | tr -d ' ')
  sum=$(shasum -a 256 "$archive" 2>/dev/null | cut -d' ' -f1 || sha256sum "$archive" | cut -d' ' -f1)
  echo "    $archive  ($size)"
  echo "    sha256 $sum"
done
