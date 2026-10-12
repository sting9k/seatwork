#!/usr/bin/env bash
# seatwork from a terminal: the setup the plugin's own screen does (Seatwork, in Paseo's sidebar), without the app.
# Flags: --no-plugin  --no-reload
#   --hq default|ask|<harness>/<model> [--hq-thinking <id>]   what HQ runs on; asked once, on a first install from a terminal
#   --seat <harness>-<role>   set up one more seat (repeatable; kept in setup.json)
#   --watcher off|shadow|on|ask   the watcher on this machine; asked once, on a first install from a terminal
#   --mail-port <port>        the port of the room's mail server on this machine (kept in setup.json)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN="$HERE/plugin"
DO_PLUGIN=1; DO_RELOAD=1
SETUP=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-plugin) DO_PLUGIN=0 ;;
    --no-reload) DO_RELOAD=0 ;;
    --hq|--hq-thinking|--seat|--watcher|--mail-port)
      [ $# -ge 2 ] || { echo "$1 needs a value" >&2; exit 2; }
      SETUP+=("$1" "$2"); shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
for bin in node npm paseo; do command -v "$bin" >/dev/null || { echo "$bin is required" >&2; exit 1; }; done
# the daemon runs the plugin: its agent.closed hook and its setup screen need Paseo 0.11.2
PASEO_VERSION="$(paseo daemon status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.stdout.write(JSON.parse(s).daemonVersion||"")}catch{}})' || true)"
[ -n "$PASEO_VERSION" ] || PASEO_VERSION="$(paseo --version 2>/dev/null | head -n 1)"
if ! node -e 'const v=process.argv[1].split("-")[0].split(".").map(Number),w=[0,11,2];for(let i=0;i<3;i++)if((v[i]||0)!==w[i])process.exit((v[i]||0)>w[i]?0:1)' "$PASEO_VERSION"; then
  echo "Paseo ${PASEO_VERSION:-(unknown version)} is too old: the room needs 0.11.2 or later. Update it (npm install -g @getpaseo/cli@latest), run 'paseo daemon restart', then this again." >&2
  exit 1
fi

# the setup is the plugin's own TypeScript; its dev packages run it here
if [ "$DO_PLUGIN" = 1 ] || [ ! -d "$PLUGIN/node_modules/typescript" ]; then
  ( cd "$PLUGIN" && npm install --silent --no-audit --no-fund )
fi

# --- 1. this machine's choices, the room home, the seats and profiles in Paseo's config.json ---
# the room home holds mail and copies of your harness config: its owner only
umask 077
node --require "$PLUGIN/test/register.cjs" "$PLUGIN/tools/room-init.ts" ${SETUP[@]+"${SETUP[@]}"}

# --- 2. plugin ---
if [ "$DO_PLUGIN" = 1 ]; then
  ( cd "$PLUGIN" && npm run --silent typecheck )
  if paseo plugin ls --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{process.exit(JSON.parse(s).some((p)=>p.id==="slp-seat")?0:1)}catch{process.exit(1)}})'; then
    paseo plugin reload slp-seat
  else
    paseo plugin install "$PLUGIN"
  fi
fi

# --- 3. reload: Paseo picks the seats and profiles up from its config.json ---
if [ "$DO_RELOAD" = 1 ]; then
  paseo daemon reload </dev/null || echo "WARNING: 'paseo daemon reload' failed; restart Paseo yourself." >&2
fi
echo "Done. Open an agent on the 'Supervisor' profile inside a project, or 'HQ Supervisor' in the hq-seatwork project."
