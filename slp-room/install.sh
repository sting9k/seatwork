#!/usr/bin/env bash
# slp-room installer: room prompts + policy + Paseo providers/profiles + the slp-seat plugin.
#
#   ./install.sh                 everything
#   ./install.sh --no-plugin     skip npm install / paseo plugin install|reload
#   ./install.sh --no-reload     skip `paseo daemon reload`
#   ./install.sh --no-daemon-policy   do not touch daemon-wide switches (browser tools, voice, skills)
#   ./install.sh --no-pi-adapter      do not install npm:pi-mcp-adapter into ~/.pi/agent
#
# Writes:  $SLP_ROOM_HOME (default ~/.config/slp-room): room/, policy.json, seats.json, projects.json.example
#          ~/.paseo/config.json: providers + profiles from paseo/config.snippet.json (generated from
#          paseo/seats.yml + paseo/policy.json + paseo/profiles.json + room/models.json), plus the
#          daemon switches in policy.json (backup kept). Only the seats in seats.yml exist.
#          Paseo project hq-seatwork ($SLP_ROOM_HOME/hq-seatwork): created by the plugin when it loads.
# Never writes to ~/.claude, ~/.codex, ~/.pi or ~/.config/opencode. Runtimes are built by the
# plugin under $SLP_ROOM_HOME/runtimes/<harness>/<role>; they are rebuilt when policy changes
# (bump RUNTIME_VERSION in plugin/server/runtimes.ts or delete the runtime directory).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOM_HOME="${SLP_ROOM_HOME:-$HOME/.config/slp-room}"
PASEO_HOME="${PASEO_HOME:-$HOME/.paseo}"
CONFIG="$PASEO_HOME/config.json"
DO_PLUGIN=1; DO_RELOAD=1; DO_DAEMON_POLICY=1; DO_PI_ADAPTER=1
for arg in "$@"; do
  case "$arg" in
    --no-plugin) DO_PLUGIN=0 ;;
    --no-reload) DO_RELOAD=0 ;;
    --no-daemon-policy) DO_DAEMON_POLICY=0 ;;
    --no-pi-adapter) DO_PI_ADAPTER=0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
for bin in jq paseo python3; do command -v "$bin" >/dev/null || { echo "$bin is required" >&2; exit 1; }; done
python3 -c "import yaml" 2>/dev/null || { echo "python3 needs PyYAML (pip3 install pyyaml) to read paseo/seats.yml" >&2; exit 1; }

# --- 0. generate paseo/config.snippet.json and $ROOM_HOME/seats.json from seats.yml + policy + models ----
mkdir -p "$ROOM_HOME"
SLP_ROOM_HOME="$ROOM_HOME" python3 "$HERE/tools/gen-snippet.py"

# --- 1. room files --------------------------------------------------------------
umask 077
mkdir -p "$ROOM_HOME/room"
# the whole room tree: models.json, roles/, harness/, specs/, law/, skills/
rsync -a --delete "$HERE/room/" "$ROOM_HOME/room/"
cp "$HERE/paseo/policy.json" "$ROOM_HOME/policy.json"
# runtimes of seats no longer enabled are removed (the plugin rebuilds enabled ones)
if [ -d "$ROOM_HOME/runtimes" ]; then
  for dir in "$ROOM_HOME"/runtimes/*/*/; do
    [ -d "$dir" ] || continue
    h="$(basename "$(dirname "$dir")")"; r="$(basename "$dir")"
    if ! jq -e --arg p "$h-$r" '.providers | index($p)' "$ROOM_HOME/seats.json" >/dev/null; then rm -rf "$dir"; fi
  done
fi
if [ ! -f "$ROOM_HOME/projects.json" ]; then
  cat > "$ROOM_HOME/projects.json.example" <<'EOF'
{
  "projects": [
    { "name": "example", "cwd": "/Users/you/code/example" }
  ]
}
EOF
  echo "No $ROOM_HOME/projects.json: the room runs in OPEN mode (no project guard)."
  echo "  Copy projects.json.example to projects.json to switch on the registry."
fi
echo "Room files: $ROOM_HOME/room  policy: $ROOM_HOME/policy.json  seats: $(jq -r '.providers | join(", ")' "$ROOM_HOME/seats.json")"

# --- 1b. Pi MCP adapter: without it Pi seats get no Paseo tools -----------------------
if [ "$DO_PI_ADAPTER" = 1 ] && command -v pi >/dev/null; then
  if pi list 2>/dev/null | grep -q "pi-mcp-adapter"; then
    echo "Pi MCP adapter: already installed"
  else
    pi install npm:pi-mcp-adapter && echo "Pi MCP adapter: installed" || echo "WARNING: 'pi install npm:pi-mcp-adapter' failed; Pi seats will have no Paseo tools" >&2
    rm -rf "$ROOM_HOME/runtimes/pi"   # rebuilt by the plugin with the adapter package kept
  fi
fi

# --- 2. Paseo config: providers + profiles + daemon switches -------------------------
mkdir -p "$PASEO_HOME"
[ -f "$CONFIG" ] || echo '{"version":1}' > "$CONFIG"
chmod 600 "$CONFIG"
cp "$CONFIG" "$CONFIG.bak-$(date +%Y%m%d%H%M%S)"
TMP="$(mktemp "$CONFIG.XXXXXX")"
jq --slurpfile snip "$HERE/paseo/config.snippet.json" --slurpfile pol "$HERE/paseo/policy.json" --argjson daemonPolicy "$DO_DAEMON_POLICY" '
  ($snip[0].daemon.agentProfiles) as $new
  | ($new | map(.id)) as $ownedIds
  # every profile the room ever wrote (id prefix agent_profile_slp_) is replaced by the current set; user profiles are kept
  | .daemon.agentProfiles = (((.daemon.agentProfiles // []) | map(select(((.id // "") | startswith("agent_profile_slp_") | not) and ((.id as $i | $ownedIds | index($i)) == null)))) + $new)
  # every room-owned provider (<harness>-<role>) is dropped, then the enabled ones written back,
  # so a seat removed from seats.yml disappears from Paseo
  | .agents.providers = (((.agents.providers // {}) | with_entries(select(.key | test("^(claude|codex|pi|opencode)-(hq|supervisor|lead|peer|lens)$") | not))) + $snip[0].agents.providers)
  | .daemon.mcp.enabled = true
  | .daemon.mcp.injectIntoAgents = true
  | .pluginsEnabled = true
  | if $daemonPolicy == 1 then
      .daemon.browserTools.enabled = ($pol[0].daemon.browserTools // false)
      | .daemon.enableTerminalAgentHooks = ($pol[0].daemon.enableTerminalAgentHooks // false)
      | .features.dictation.enabled = ($pol[0].daemon.dictation // false)
      | .features.voiceMode.enabled = ($pol[0].daemon.voiceMode // false)
      | (if ($pol[0].daemon.bundledSkills // "none") == "none"
         then .agents.skills.selection = {"mode": "custom", "skills": []}
         else . end)
    else . end
' "$CONFIG" > "$TMP"
mv "$TMP" "$CONFIG"
chmod 600 "$CONFIG"
echo "Paseo config updated: $CONFIG (backup alongside)"
echo "  profiles:  $(jq -r '[.daemon.agentProfiles[].name] | join(", ")' "$HERE/paseo/config.snippet.json")"
echo "  providers: $(jq -r '.agents.providers | keys | join(", ")' "$HERE/paseo/config.snippet.json")"
[ "$DO_DAEMON_POLICY" = 1 ] && echo "  daemon:    browserTools=$(jq -c .daemon.browserTools.enabled "$CONFIG") terminalHooks=$(jq -c .daemon.enableTerminalAgentHooks "$CONFIG") bundledSkills=$(jq -c .agents.skills.selection "$CONFIG")"

# --- 3. plugin ----------------------------------------------------------------------
if [ "$DO_PLUGIN" = 1 ]; then
  ( cd "$HERE/plugin" && npm install --silent --no-audit --no-fund && npm run --silent typecheck )
  if paseo plugin ls --json 2>/dev/null | jq -e '.[]? | select(.id == "slp-seat")' >/dev/null 2>&1; then
    paseo plugin reload slp-seat
  else
    paseo plugin install "$HERE/plugin"
  fi
fi

# --- 4. reload ----------------------------------------------------------------------
if [ "$DO_RELOAD" = 1 ]; then
  paseo daemon reload </dev/null || echo "WARNING: 'paseo daemon reload' failed; restart Paseo yourself." >&2
fi
echo "Done. Open an agent on the 'Supervisor' profile inside a project, or 'HQ Supervisor' in the hq-seatwork project."
