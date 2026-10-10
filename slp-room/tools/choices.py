#!/usr/bin/env python3
"""This machine's own choices, kept in $SLP_ROOM_HOME/setup.json and never in the repo: the seat HQ
runs on, and the seats added on top of paseo/seats.yml. Run by install.sh; gen-snippet.py reads
what it leaves."""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent.parent
MODELS = HERE / "room" / "models.json"
ROOM_HOME = pathlib.Path(os.environ.get("SLP_ROOM_HOME") or pathlib.Path.home() / ".config" / "slp-room")
SETUP = ROOM_HOME / "setup.json"

HARNESSES = ["claude", "codex", "pi", "opencode"]
ROLES = ["hq", "supervisor", "lead", "peer", "lens"]


def fail(message: str) -> SystemExit:
    print(message, file=sys.stderr)
    return SystemExit(1)


def catalog(harness: str) -> dict[str, dict] | None:
    """The harness's live model catalog from the daemon, or None when unavailable."""
    try:
        out = subprocess.run(["paseo", "provider", "models", harness, "--json"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    try:
        return {m["id"]: m for m in json.loads(out.stdout)}
    except (ValueError, KeyError, TypeError):
        return None


def is_seat(text: object) -> bool:
    harness, _, role = str(text).partition("-")
    return harness in HARNESSES and role in ROLES


def load_setup() -> dict:
    """setup.json, checked: it may have been edited by hand. `hq` is "default" or {provider, thinking};
    `seats` is a list of <harness>-<role>."""
    if not SETUP.exists():
        return {}
    try:
        setup = json.loads(SETUP.read_text())
    except ValueError as error:
        raise fail(f"{SETUP} is not JSON ({error})")
    if not isinstance(setup, dict):
        raise fail(f"{SETUP} must hold an object")
    hq = setup.get("hq", "default")
    if hq != "default":
        provider = hq.get("provider", "") if isinstance(hq, dict) else ""
        seat, _, model = str(provider).partition("/")
        if not (is_seat(seat) and seat.endswith("-hq") and model):
            raise fail(f'{SETUP}: "hq" must be "default" or {{"provider": "<harness>-hq/<model>", "thinking": "<id>"}}')
    seats = setup.get("seats", [])
    if not isinstance(seats, list) or not all(is_seat(s) for s in seats):
        raise fail(f'{SETUP}: "seats" must list <harness>-<role> ids; harnesses are {HARNESSES}, roles are {ROLES}')
    return setup


def hq_seat(harness: str, model: str, thinking: str | None) -> dict:
    """The setup.json entry for HQ on this harness and model, checked against the harness's catalog when it can be read."""
    if harness not in HARNESSES or not model:
        raise fail(f"--hq takes default, ask or <harness>/<model>; harnesses are {HARNESSES}")
    cat = catalog(harness)
    if cat is None:
        print(f"warning: cannot read the {harness} model catalog from the daemon; {model} is taken as given", file=sys.stderr)
    elif model not in cat:
        raise fail(f"{harness} has no model {model}; it has: {', '.join(cat)}")
    else:
        ids = cat[model].get("thinkingOptionIds") or []
        if thinking is None:
            thinking = cat[model].get("defaultThinkingOptionId")
        elif thinking not in ids:
            raise fail(f"{harness}/{model} has no thinking option {thinking}; it has: {', '.join(ids) or 'none'}")
    return {"provider": f"{harness}-hq/{model}", **({"thinking": thinking} if thinking else {})}


def pick(prompt: str, options: list[str], default: str | None = None) -> str:
    """One of `options`, by its number or its text; an empty answer or the end of input takes `default`."""
    while True:
        try:
            answer = input(f"{prompt} [{default}]: " if default else f"{prompt}: ").strip()
        except EOFError:
            answer = ""
        if not answer and default:
            return default
        if answer.isdigit() and 1 <= int(answer) <= len(options):
            return options[int(answer) - 1]
        if answer in options:
            return answer
        if not answer:
            raise fail("no answer")
        print(f"  {answer} is not one of them")


def ask_hq() -> dict | str:
    """Asks on the terminal: the room's HQ seat, or the user's own harness and model for it."""
    room = json.loads(MODELS.read_text())["seats"]["hq"]
    print("HQ is the seat you talk to about every project. What should it run on?")
    print(f"  1) default: {room['provider']}, thinking {room['thinking']}")
    print("  2) custom: you choose the agent CLI and the model")
    if pick("Choice", ["default", "custom"], "default") == "default":
        return "default"
    for i, harness in enumerate(HARNESSES, 1):
        print(f"  {i}) {harness}")
    harness = pick("Agent CLI", HARNESSES)
    cat = catalog(harness)
    if not cat:
        raise fail(f"cannot read the {harness} model catalog from Paseo: is the daemon running, and is {harness} installed?")
    for i, (model, row) in enumerate(cat.items(), 1):
        label = row.get("model")
        print(f"  {i}) {model}  ({label})" if label else f"  {i}) {model}")
    model = pick("Model", list(cat))
    ids = cat[model].get("thinkingOptionIds") or []
    thinking = pick(f"Thinking ({', '.join(ids)})", ids, cat[model].get("defaultThinkingOptionId") or ids[0]) if ids else None
    return {"provider": f"{harness}-hq/{model}", **({"thinking": thinking} if thinking else {})}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hq", metavar="default|ask|<harness>/<model>", help="the seat HQ runs on; asked on a first install from a terminal")
    parser.add_argument("--hq-thinking", metavar="<id>", help="thinking option for --hq <harness>/<model>; default: the model's own")
    parser.add_argument("--seat", action="append", default=[], metavar="<harness>-<role>", help="a seat to add on top of paseo/seats.yml")
    args = parser.parse_args()

    setup = load_setup()
    before = json.dumps(setup, sort_keys=True) if SETUP.exists() else None
    for seat in args.seat:
        if not is_seat(seat):
            raise fail(f"--seat {seat}: a seat is <harness>-<role>; harnesses are {HARNESSES}, roles are {ROLES}")
        if seat not in setup.setdefault("seats", []):
            setup["seats"].append(seat)
    choice = args.hq
    if choice is None and args.hq_thinking:
        raise fail("--hq-thinking goes with --hq <harness>/<model>")
    if choice is None and "hq" not in setup and sys.stdin.isatty():
        choice = "ask"  # a first install: the one question the installer has
    if choice == "ask":
        setup["hq"] = ask_hq()
    elif choice == "default":
        setup["hq"] = "default"
    elif choice is not None:
        harness, _, model = choice.partition("/")
        setup["hq"] = hq_seat(harness, model, args.hq_thinking)

    if json.dumps(setup, sort_keys=True) != before:
        ROOM_HOME.mkdir(parents=True, exist_ok=True)
        SETUP.write_text(json.dumps(setup, indent=2) + "\n")
    hq = setup.get("hq", "default")
    shown = "the room's" if hq == "default" else hq["provider"] + (f", thinking {hq['thinking']}" if hq.get("thinking") else "")
    print(f"HQ seat: {shown}; seats added on this machine: {', '.join(setup.get('seats', [])) or 'none'} ({SETUP})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
