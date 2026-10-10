#!/usr/bin/env python3
"""Generate paseo/config.snippet.json and $SLP_ROOM_HOME/seats.json from seats.yml, policy.json,
profiles.json, models.json and this machine's own choices (setup.json, see choices.py). Run by
install.sh; safe to run by hand."""
from __future__ import annotations

import json
import pathlib
import sys

import yaml

from choices import HARNESSES, ROLES, ROOM_HOME, catalog, load_setup

HERE = pathlib.Path(__file__).resolve().parent.parent
SEATS_YML = HERE / "paseo" / "seats.yml"
POLICY = HERE / "paseo" / "policy.json"
PROFILES = HERE / "paseo" / "profiles.json"
MODELS = HERE / "room" / "models.json"
OUT = HERE / "paseo" / "config.snippet.json"
SEATS_OUT = ROOM_HOME / "seats.json"   # for the plugin; derived from seats.yml and setup.json, never committed

LABEL = {"claude": "Claude", "codex": "Codex", "pi": "Pi", "opencode": "OpenCode"}
ROLE_LABEL = {"hq": "HQ Supervisor", "supervisor": "Supervisor", "lead": "Lead", "peer": "Peer", "lens": "Lens"}
# How each harness is kept apart from the user's own setup (shown in the provider description).
ISOLATION = {
    "claude": "on the user's Claude sign-in with personal settings switched off",
    "codex": "on an isolated Codex runtime (CODEX_HOME per role)",
    "pi": "on an isolated Pi runtime (PI_CODING_AGENT_DIR per role)",
    "opencode": "on an isolated OpenCode runtime (OPENCODE_CONFIG_DIR per role)",
}


def providers_in_models(models: dict) -> dict[str, set[str]]:
    """provider id -> model ids models.json assigns to it."""
    used: dict[str, set[str]] = {}

    def add(spec: str) -> None:
        provider, _, model = spec.partition("/")
        if not model:
            print(f"models.json: '{spec}' must be <provider>/<model>", file=sys.stderr)
            raise SystemExit(1)
        used.setdefault(provider, set()).add(model)

    for seat in models["seats"].values():
        add(seat["provider"])  # hq, supervisor, lead
        for alt in seat.get("alternatives", []):
            add(alt)
    for tier in models["peer"]["tiers"].values():
        for p in tier["providers"]:
            add(p)
    lens = models["lens"]
    add(lens["oracle"])
    for p in ([lens["hard"]] if lens.get("hard") else []) + lens["pair"] + lens.get("pool", []):
        add(p)
    return used


def main() -> int:
    seats_cfg = yaml.safe_load(SEATS_YML.read_text()) or {}
    seats: dict[str, list[str]] = {role: list(harnesses or []) for role, harnesses in (seats_cfg.get("seats") or {}).items()}
    restrict = bool(seats_cfg.get("restrict_models", True))
    policy = json.loads(POLICY.read_text())
    profiles = json.loads(PROFILES.read_text())
    models = json.loads(MODELS.read_text())
    setup = load_setup()
    # HQ on the seat this machine chose: in the table the checks below read, and in the profile the user opens
    hq = setup.get("hq") if isinstance(setup.get("hq"), dict) else None
    if hq:
        models["seats"]["hq"] = {**models["seats"]["hq"], **hq}
        provider, _, model = hq["provider"].partition("/")
        for profile in profiles:
            if profile["provider"].endswith("-hq"):
                profile.update(provider=provider, model=model)
                # a harness without session modes, or a model without thinking options, takes no such setting: Paseo refuses one
                for key, value in (("modeId", models["modes"].get(provider.split("-")[0])), ("thinkingOptionId", hq.get("thinking"))):
                    profile.pop(key, None)
                    if value:
                        profile[key] = value
    tools = policy["paseoTools"]
    all_tools: list[str] = tools["all"]
    allow: dict[str, list[str]] = tools["allow"]

    enabled: list[tuple[str, str]] = []
    for role, harnesses in seats.items():
        if role not in ROLES:
            print(f"seats.yml: unknown role {role}; roles are {ROLES}", file=sys.stderr)
            return 1
        for harness in harnesses:
            if harness not in HARNESSES:
                print(f"seats.yml: unknown harness {harness} under {role}; harnesses are {HARNESSES}", file=sys.stderr)
                return 1
            enabled.append((harness, role))
    # the seats this machine added: HQ's own, and those a project's table asked for
    for seat in ([hq["provider"].split("/")[0]] if hq else []) + setup.get("seats", []):
        harness, _, role = seat.partition("-")
        if (harness, role) not in enabled:
            enabled.append((harness, role))
            seats.setdefault(role, []).append(harness)
    if not enabled:
        print("seats.yml: no seats enabled", file=sys.stderr)
        return 1
    for role, names in allow.items():
        unknown = sorted(set(names) - set(all_tools))
        if unknown:
            print(f"policy.json: role {role} allows unknown Paseo tools: {unknown}", file=sys.stderr)
            return 1

    enabled_ids = {f"{h}-{r}" for h, r in enabled}
    used = providers_in_models(models)
    missing = sorted(set(used) - enabled_ids)
    if missing:
        print(f"room/models.json names providers that seats.yml does not enable: {missing}. Enable them in seats.yml or remove them from models.json.", file=sys.stderr)
        return 1

    catalogs: dict[str, dict[str, dict] | None] = {}
    providers: dict[str, dict] = {}
    for harness, role in enabled:
        pid = f"{harness}-{role}"
        disabled = [t for t in all_tools if t not in set(allow[role])]
        entry: dict = {
            "extends": harness,
            "label": f"{LABEL[harness]} {ROLE_LABEL[role]}",
            "description": f"{ROLE_LABEL[role]} seat {ISOLATION[harness]}; Paseo tools: {', '.join(allow[role]) or 'none'}",
            "paseoTools": {"enabled": True, "disabledTools": disabled},
        }
        if harness == "claude":
            denied_skills = [f"Skill(skill:{name})" for name in policy["claude"].get("deniedSkills", [])]
            entry["disallowedTools"] = policy["claude"]["disallowedTools"][role] + denied_skills
        if restrict and used.get(pid):
            if harness not in catalogs:
                catalogs[harness] = catalog(harness)
            cat = catalogs[harness]
            if cat is None:
                print(f"warning: cannot read the {harness} model catalog from the daemon; {pid} keeps the full list", file=sys.stderr)
            else:
                rows = []
                for mid in sorted(used[pid]):
                    m = cat.get(mid)
                    if m is None:
                        print(f"warning: models.json assigns {mid} to {pid} but the {harness} catalog has no such model", file=sys.stderr)
                        continue
                    row = {"id": mid, "label": m.get("model") or mid}
                    if m.get("description"):
                        row["description"] = m["description"]
                    ids = m.get("thinkingOptionIds") or []
                    if ids:
                        default = m.get("defaultThinkingOptionId")
                        row["thinkingOptions"] = [{"id": t, "label": t, **({"isDefault": True} if t == default else {})} for t in ids]
                    rows.append(row)
                if rows:
                    rows[0]["isDefault"] = True
                    entry["models"] = rows
        providers[pid] = entry

    for profile in profiles:
        if profile["provider"] not in providers:
            print(f"profiles.json: profile {profile['id']} uses provider {profile['provider']}, which seats.yml does not enable", file=sys.stderr)
            return 1

    snippet = {"daemon": {"agentProfiles": profiles}, "agents": {"providers": providers}}
    OUT.write_text(json.dumps(snippet, indent=2, ensure_ascii=False) + "\n")
    SEATS_OUT.parent.mkdir(parents=True, exist_ok=True)
    # installer: where the plugin finds install.sh when a project's table needs a seat the room does not have
    SEATS_OUT.write_text(json.dumps({"seats": seats, "providers": sorted(providers), "installer": str(HERE / "install.sh")}, indent=2) + "\n")
    print(f"wrote {OUT.relative_to(HERE)}: {len(providers)} providers, {len(profiles)} profiles; seats → {SEATS_OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
