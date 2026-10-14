import { HARNESSES, parseSeat, type Harness } from "../../orchestration/seats";
import { ROLES, ROOM_ROLE, traits } from "../../../shared/workflow";
import { WATCHER_MODES, type Catalog, type Setup } from "./plan";

/** The installer's flags that are this machine's choices: --hq default|ask|<harness>/<model>, --watcher off|shadow|on|ask. */
export interface ChoiceFlags {
  hq?: string;
  hqThinking?: string;
  seats: string[];
  watcher?: string;
}

/** The terminal the installer runs on: a line typed at it (null at the end of input), a line printed on it. */
export interface Terminal {
  isTTY: boolean;
  ask(prompt: string): Promise<string | null>;
  say(line: string): void;
}

/** One of `options`, by its number or its text; an empty answer or the end of input takes `fallback`. */
async function pick(io: Terminal, prompt: string, options: string[], fallback?: string): Promise<string> {
  for (;;) {
    const answer = ((await io.ask(fallback ? `${prompt} [${fallback}]: ` : `${prompt}: `)) ?? "").trim();
    if (!answer && fallback) return fallback;
    if (/^\d+$/.test(answer) && Number(answer) >= 1 && Number(answer) <= options.length)
      return options[Number(answer) - 1];
    if (options.includes(answer)) return answer;
    if (!answer) throw new Error("no answer");
    io.say(`  ${answer} is not one of them`);
  }
}

/** The setup.json entry for the room's own seat on this harness and model, checked against the harness's catalog. */
async function hqSeat(
  harness: string,
  model: string,
  thinking: string | undefined,
  catalog: Catalog,
  io: Terminal,
): Promise<{ provider: string; thinking?: string }> {
  if (!(HARNESSES as readonly string[]).includes(harness) || !model)
    throw new Error(`--hq takes default, ask or <harness>/<model>; harnesses are ${HARNESSES.join(", ")}`);
  const cat = await catalog(harness as Harness);
  if (!cat) io.say(`warning: cannot read the ${harness} model catalog from the daemon; ${model} is taken as given`);
  else if (!(model in cat)) throw new Error(`${harness} has no model ${model}; it has: ${Object.keys(cat).join(", ")}`);
  else if (thinking === undefined) thinking = cat[model].defaultThinking;
  else if (!cat[model].thinking.includes(thinking))
    throw new Error(
      `${harness}/${model} has no thinking option ${thinking}; it has: ${cat[model].thinking.join(", ") || "none"}`,
    );
  return { provider: `${harness}-${ROOM_ROLE}/${model}`, ...(thinking ? { thinking } : {}) };
}

/** Asks on the terminal: the room's own seat as the table has it, or the user's own harness and model for it. */
async function askHq(
  io: Terminal,
  catalog: Catalog,
  roomHq: { provider: string; thinking: string },
): Promise<Setup["hq"]> {
  io.say(`${traits(ROOM_ROLE).label} is the seat you talk to about every project. What should it run on?`);
  io.say(`  1) default: ${roomHq.provider}, thinking ${roomHq.thinking}`);
  io.say("  2) custom: you choose the agent CLI and the model");
  if ((await pick(io, "Choice", ["default", "custom"], "default")) === "default") return "default";
  HARNESSES.forEach((harness, i) => io.say(`  ${i + 1}) ${harness}`));
  const harness = (await pick(io, "Agent CLI", [...HARNESSES])) as Harness;
  const cat = await catalog(harness);
  if (!cat || Object.keys(cat).length === 0)
    throw new Error(
      `cannot read the ${harness} model catalog from Paseo: is the daemon running, and is ${harness} installed?`,
    );
  Object.entries(cat).forEach(([model, row], i) =>
    io.say(row.label && row.label !== model ? `  ${i + 1}) ${model}  (${row.label})` : `  ${i + 1}) ${model}`),
  );
  const model = await pick(io, "Model", Object.keys(cat));
  const ids = cat[model].thinking;
  const thinking = ids.length
    ? await pick(io, `Thinking (${ids.join(", ")})`, ids, cat[model].defaultThinking || ids[0])
    : undefined;
  return { provider: `${harness}-${ROOM_ROLE}/${model}`, ...(thinking ? { thinking } : {}) };
}

/** Asks on the terminal whether the watcher is installed; installed, it starts in shadow mode. */
async function askWatcher(io: Terminal, keyFile: string): Promise<Setup["watcher"]> {
  io.say("The watcher reads the turns of the seats it watches and logs the signs of a turn going wrong.");
  io.say(`With a key in ${keyFile} it also sends a seat's final message to a decision model. Install it?`);
  io.say("  1) no");
  io.say("  2) shadow: it reads and logs, and mails nobody (`--watcher on` makes it mail the seat above)");
  return (await pick(io, "Choice", ["no", "shadow"], "no")) === "shadow" ? "shadow" : "off";
}

/** This machine's choices: the installer's flags, and on a first install from a terminal its two questions. */
export async function choose(
  before: Setup,
  flags: ChoiceFlags,
  io: Terminal,
  room: { catalog: Catalog; hq?: { provider: string; thinking: string }; watchKeyFile: string },
): Promise<Setup> {
  const setup: Setup = { ...before, ...(before.seats ? { seats: [...before.seats] } : {}) };
  for (const seat of flags.seats) {
    if (!parseSeat(seat))
      throw new Error(
        `--seat ${seat}: a seat is <harness>-<role>; harnesses are ${HARNESSES.join(", ")}, roles are ${ROLES.join(", ")}`,
      );
    if (!(setup.seats ??= []).includes(seat)) setup.seats.push(seat);
  }
  let hq = flags.hq;
  if (hq === undefined && flags.hqThinking) throw new Error("--hq-thinking goes with --hq <harness>/<model>");
  if (hq !== undefined && !ROOM_ROLE) throw new Error("--hq: the room's workflow has no role at home in the room");
  // a first install: the one question the installer has
  if (hq === undefined && setup.hq === undefined && io.isTTY && room.hq) hq = "ask";
  if (hq === "ask") setup.hq = room.hq ? await askHq(io, room.catalog, room.hq) : "default";
  else if (hq === "default") setup.hq = "default";
  else if (hq !== undefined) {
    const slash = hq.indexOf("/");
    setup.hq = await hqSeat(
      slash < 0 ? hq : hq.slice(0, slash),
      slash < 0 ? "" : hq.slice(slash + 1),
      flags.hqThinking,
      room.catalog,
      io,
    );
  }
  let watcher = flags.watcher;
  if (watcher === undefined && setup.watcher === undefined && io.isTTY) watcher = "ask";
  if (watcher === "ask") setup.watcher = await askWatcher(io, room.watchKeyFile);
  else if (watcher !== undefined) {
    if (!(WATCHER_MODES as readonly string[]).includes(watcher))
      throw new Error(`--watcher takes ${WATCHER_MODES.join(", ")} or ask`);
    setup.watcher = watcher as Setup["watcher"];
  }
  return setup;
}
