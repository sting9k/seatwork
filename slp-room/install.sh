#!/usr/bin/env bash
# slp-room installer: room files, policy, Paseo providers and profiles, the slp-seat plugin.
# Flags: --no-plugin  --no-reload  --no-daemon-policy  --no-pi-adapter
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

# the room home holds mail and copies of your harness config: its owner only, also when it already exists
umask 077
mkdir -p "$ROOM_HOME"
chmod 700 "$ROOM_HOME"

# --- 0. generate paseo/config.snippet.json and $ROOM_HOME/seats.json from seats.yml + policy + models ----
SLP_ROOM_HOME="$ROOM_HOME" python3 "$HERE/tools/gen-snippet.py"

# --- 1. room files --------------------------------------------------------------
mkdir -p "$ROOM_HOME/room"
# the whole room tree: models.json, roles/, harness/, specs/, law/, skills/
rsync -a --delete "$HERE/room/" "$ROOM_HOME/room/"
cp "$HERE/paseo/policy.json" "$ROOM_HOME/policy.json"
# runtimes of seats no longer enabled are removed (the plugin rebuilds the others when policy.json changed)
if [ -d "$ROOM_HOME/runtimes" ]; then
  for dir in "$ROOM_HOME"/runtimes/*/*/; do
    [ -d "$dir" ] || continue
    h="$(basename "$(dirname "$dir")")"; r="$(basename "$dir")"
    # Claude seats run on the user's ~/.claude and have no runtime; a leftover one is removed too
    if [ "$h" = "claude" ] || ! jq -e --arg p "$h-$r" '.providers | index($p)' "$ROOM_HOME/seats.json" >/dev/null; then rm -rf "$dir"; fi
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
  echo "  Ask HQ to onboard a project (or copy projects.json.example to projects.json) to switch on the registry."
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
