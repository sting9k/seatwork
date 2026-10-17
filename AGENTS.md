# Working on this repo

A Paseo plugin that runs a room of coding agents. This file is for an agent changing the plugin; what seats read lives in `plugin/room/`.

## Branches

- `dev/main` is where the plugin is changed, tested and evaluated; pull requests go to it.
- `main` holds releases only. `node scripts/release.cjs --push` makes one from `dev/main`: the same tree without `plugin/test`, `plugin/tools`, `evals` and `scripts`, its package and TypeScript files trimmed to compile without them, committed on top of `main`. Nothing is edited or merged on `main` by hand, and `main` is never merged back.

## Layout

| Path | Holds |
|---|---|
| `plugin/server/` | The districts: `coordination` (mail), `tasks`, `safety`, `jev` (decision model), `knowledge`, `operations`, `orchestration`. `paseo/` is the only code that talks to Paseo. |
| `plugin/shared/` | Tables the code imports: `workflow.json` (roles, routes, spawn), `tools.json`, `signals.json`, `settings.json`… |
| `plugin/paseo/` | A machine's policy, seats and profiles, written into `~/.config/seatwork` at setup |
| `plugin/room/` | What seats read: `harness/`, `roles/`, `specs/`, `skills/`, `models.json`, and `sql/` migrations. Copied whole to `~/.config/seatwork/room/` |
| `evals/`, `plugin/tools/` | Eval cases and runners, the decision model's eval tool: on `dev/main` only |
| `scripts/release.cjs` | Makes a release on `main` |
| `research/` | Notes, gitignored |

## Checks

In `plugin/`: `npm test`, `npm run typecheck`, `npm run format`, then `git diff --check`. Prettier covers code and JSON at 120 columns and leaves Markdown alone.

## Code

- Paseo compiles the plugin with esbuild and loads only imports under `client/`, `server/` and `shared/`; `shared/` imports no file outside `shared/`. A JSON file the code imports sits in `shared/`.
- The plugin has no npm runtime dependency: Paseo would have to install it on the user's machine. SQLite is `node:sqlite`.
- Roles are data. Code asks `shared/workflow.json` for a trait, route or spawn rule and never compares a role name, so the hierarchy can be swapped.
- Paseo stays behind contracts. A district defines the interface it needs; on the server, Paseo's SDK, hooks and CLI are called only from `server/paseo/` and wired in `index.server.ts`. The screens in `client/` and the RPC definitions in `shared/` use Paseo's plugin kit.
- A setting is written once, as data: a machine's policy in `paseo/policy.json`, the plugin's own tables in `shared/*.json`.
- Setup keeps the keys the owner or HQ changed in the room home's `policy.json` (`server/paseo/setup/policy-changes.ts`), so a new default in `paseo/policy.json` reaches only rooms that left that key alone.
- A store's layout changes by a new `room/sql/<store>/V<n>__<what>.sql`. An applied script stays as it is: its checksum is kept.
- Whatever grows (logs, records, seat homes) gets an end date in `server/gc.ts`, the one table-driven sweep.
- The room runs for days: keep per-call cost flat as history grows, bound every table, file and outside input, and release listeners and timers.
- Everything the plugin stores or sends to the decision model is English.
- Bump the version in `package.json`, `package-lock.json` and `index.server.ts` with a change to `room/` or `paseo/`: an installed room re-lays its files when the version differs.

## Comments

One line, at the head of a file, class or function. Fields, constants and variables carry none; a unit or null meaning goes in the docstring of their type. A JSON `$comment` or tool description says what a key means and, in a few words, why: no dates, incidents or measured counts.

## Tests

- Run them only through `npm test`. `test/isolate.cjs` sets throwaway homes before any module loads, because `server/paths.ts` reads the environment on import.
- After touching test support, prove the real homes untouched: touch a marker, run the suite, and `find ~/.config/seatwork ~/.paseo/config.json -newer <marker>` prints nothing.
- A new test protects a named regression and is seen red before its fix. A test a newer one supersedes is deleted.

## Room prompts and skills

- Code enforces, prompts inform. A prompt carries room facts and lines of authority; a rule the code enforces gets one line or none.
- A model's mistake is evidence to investigate. Fix it at the earliest source of the ambiguity, in code where possible, before adding a sentence.
- A skill answers a failure seen in a real run. Start from a proven base, keep its license in `room/skills/NOTICE.md`, and write judgment, not steps.
- `{{placeholders}}` come from `room/models.json` and the policy's `room.params`. `test/prompt-contract.test.ts` checks that every prompt renders and names only real tools, skills and specs.
- MIT or Apache text may be adapted with its notice. Dicklesworthstone repositories carry a rider against Anthropic and OpenAI: take ideas only.

## Owner's machine

- Secrets stay out of the repo, notes and logs. Scan the diff for the OpenRouter key prefix before a commit; a fake key in a test is built from parts.
- Installs, global npm packages and downloads wait for the owner's word.
- Code under test or in a script writes only to throwaway homes, never `~/.config/seatwork`, `~/.paseo`, `~/.claude` or `~/.codex`. One exception: a spending eval run's Claude seat signs in through `~/.claude`, as a real seat does, and keeps no session there.
- The owner's files go to the Trash, never a hard delete.
- Commit, push or open a pull request when the owner asks.
