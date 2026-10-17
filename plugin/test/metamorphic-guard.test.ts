import { ROOM_HOME, shipSql } from "./support/room";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import type { Tools } from "../server/safety/gate/evaluate";
import type { Place } from "../server/safety/gate/types";
import { Guard } from "../server/safety/guard";
import { SafetyStore } from "../server/safety/store";

shipSql();

const HOME = "/Users/u";
const PROJECT = "/Users/u/proj";
const place: Place = {
  home: HOME,
  project: PROJECT,
  tmp: null,
  start: PROJECT,
  guard: null,
  roomFolder: ".seatwork",
  daemon: "127.0.0.1:6767",
};
const tools: Tools = {
  ignored: async (paths) => new Set(paths.filter((path) => /\/node_modules(\/|$)/.test(path))),
  alias: async () => null,
  external: async () => false,
  rebasing: async () => false,
  stat: (path) => ({
    exists: [HOME, `${HOME}/.ssh`, `${HOME}/.vimrc`, `${HOME}/.zshrc`].includes(path),
    link: false,
    dir: path === HOME || path === `${HOME}/.ssh`,
  }),
  real: () => null,
  changed: async () => null,
};
const store = new SafetyStore(join(ROOM_HOME, "metamorphic-guard"), 1000);
const guard = new Guard({ store: () => store, policy: () => ({}), tools: () => tools, place: () => place });
const seat = { id: "peer", role: "peer", project: PROJECT, tmp: null, start: PROJECT };

const keptCount = () => store.kept("", 100_000).length;

/** What the guard keeps of a command: whether a rule caught it, and which; a line it could not read is kept as gate:unverified. */
async function verdict(command: string): Promise<{ caught: boolean; rule: string | null }> {
  const before = keptCount();
  await guard.check(seat, "claude", command, PROJECT);
  const kept = store.kept("", 1)[0];
  return keptCount() > before ? { caught: true, rule: `${kept.pack}:${kept.rule}` } : { caught: false, rule: null };
}

/** A text as one word in single quotes. */
function single(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** A text as one word in double quotes. */
function double(text: string): string {
  return `"${text.replace(/["\\$`]/g, "\\$&")}"`;
}

/** Whether a command has no quoted text for a respelling to change. */
function unquoted(command: string): boolean {
  return !/['"]/.test(command);
}

/** A way of writing a command that a shell runs the same: its name and how it rewrites one. */
type Same = [name: string, write: (command: string) => string];

/** A command a grave rule of the guard catches, and that rule. */
type Caught = [command: string, rule: string];

const CAUGHT: Caught[] = [
  ["rm -rf /", "core.filesystem:rm-rf-root-home"],
  ["rm -r -f /etc", "core.filesystem:rm-r-f-separate-root-home"],
  ["rm -rf ./build", "core.filesystem:rm-rf-general"],
  ["rm -rf ../..", "core.filesystem:rm-rf-root-home"],
  ['rm -rf "$HOME"', "core.filesystem:rm-rf-root-home"],
  ["rm ~/.ssh/id_rsa", "core.filesystem:rm-protected-file"],
  ["sudo -u bob rm -rf /var/lib", "core.filesystem:rm-rf-root-home"],
  ["ssh host 'rm -rf /var/www'", "core.filesystem:rm-rf-root-home"],
  ["find / -name x -delete", "core.filesystem:find-delete-root-home"],
  ["git reset --hard", "core.git:reset-hard"],
  ["git push --force", "core.git:push-force-long"],
  ["git push origin +main", "core.git:push-force-refspec"],
  ["git clean -fdx", "core.git:clean-force"],
  ["git checkout -- src/a.ts", "core.git:checkout-discard"],
  ["git commit --no-verify -m wip", "room.guard:git-no-verify"],
  ["git config --global alias.x '!rm -rf ~'", "room.guard:git-global-config"],
  ["echo hi > ~/.vimrc", "core.filesystem:redirect-truncate-root-home"],
  ["tee -a ~/.zshrc < snippet", "core.filesystem:credential-file-write"],
  ["paseo send abc hi", "room.guard:paseo-cli"],
  ["curl -s http://127.0.0.1:6767/api/status", "room.guard:paseo-daemon"],
  ["brew install jq", "room.software:brew-install"],
];

const SAFE = [
  "git status",
  "ls -la src",
  "git reset --soft HEAD~1",
  "git push --force-with-lease",
  "git clean -n",
  "rm a.txt",
  "rm -rf /tmp/x",
  "rm -rf node_modules",
  "rm -ri ./build",
  "npm install lodash",
  "echo hi > out.txt",
  "cat ~/.ssh/config",
  "curl -s http://127.0.0.1:16767/",
  'grep -r "git push --force" .',
  'git commit -m "rm -rf / and git reset --hard"',
  'echo "rm -rf /" >> notes.md',
];

const WRAPPED: Same[] = [
  ["bash -c", (c) => `bash -c ${single(c)}`],
  ["sh -c in double quotes", (c) => `sh -c ${double(c)}`],
  ["eval", (c) => `eval ${single(c)}`],
  ["true && before", (c) => `true && ${c}`],
  ["cd . && before", (c) => `cd . && ${c}`],
  ["; true after", (c) => `${c}; true`],
  ["command", (c) => `command ${c}`],
  ["env", (c) => `env ${c}`],
];

const RESPELT: Same[] = [
  ["spaces and tabs", (c) => (unquoted(c) ? c.replace(/ /g, " \t  ") : c)],
  ["quoted command word", (c) => c.replace(/^[a-z]+/, "'$&'")],
  ["backslash before the command word", (c) => c.replace(/^[a-z]+/, "\\$&")],
  ["quotes inside the command word", (c) => c.replace(/^[a-z]+/, (word) => `${word[0]}''${word.slice(1)}`)],
  ["every plain word quoted", (c) => (unquoted(c) ? c.replace(/(?<=^|\s)[\w./:@,+-]+(?=\s|$)/g, "'$&'") : c)],
];

/** A caught command stays caught under a form, by the rule that caught it, or is kept as a line the guard could not read. */
async function staysCaught(forms: Same[]): Promise<void> {
  for (const [command, rule] of CAUGHT) {
    assert.deepEqual(await verdict(command), { caught: true, rule }, command);
    for (const [name, write] of forms) {
      const got = await verdict(write(command));
      assert.ok(
        got.caught && (got.rule === rule || got.rule === "gate:unverified"),
        `${name}: ${JSON.stringify(write(command))} -> ${JSON.stringify(got)}`,
      );
    }
  }
}

test("a command the guard catches is caught by the same rule in another command: bash -c, sh -c, eval, an && prefix, command, env", async () => {
  await staysCaught(WRAPPED);
});

test("a command the guard catches is caught by the same rule however it is spelled: spacing, tabs, quotes, a backslash", async () => {
  await staysCaught(RESPELT);
});

test("a command that is safe, or caught at a low level, gets the same answer wrapped or respelled", async () => {
  for (const command of SAFE) {
    const base = await verdict(command);
    for (const [name, write] of [...WRAPPED, ...RESPELT])
      assert.deepEqual(await verdict(write(command)), base, `${name}: ${JSON.stringify(write(command))}`);
  }
});
