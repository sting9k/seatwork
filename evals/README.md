# Evals

Each case opens one seat of a role in a real room and grades its turn. The plugin runs in a process of its own on a stand-in Paseo, with throwaway room and Paseo homes. The seat starts on its agent CLI from exactly what the room's hooks hand Paseo: the system prompt, the launch flags and folders, the environment, and the room's MCP server. It calls the room's real tools, and Paseo's agent tools through `paseo-stub.mjs`, whose `create_agent` goes through the room's own hooks. When the CLI exits, the turn's end goes to the room as Paseo would send it. The run is then graded on:
- what the seat said;
- what it called;
- what the room holds after the turn: its mail, its issues, the agents created;
- what the project holds: commits, changes and status since the turn began.

## Run

| Command | What it does | Costs |
|---|---|---|
| `node evals/run.cjs --list` | the runs a label would make | nothing |
| `node evals/run.cjs --harness script --label check` | every case's right turn, scripted, against the real room | nothing |
| `node evals/run.cjs --harness wrong --label wrong` | every case's wrong turn: each must come out `caught` | nothing |
| `node evals/run.cjs --dry --label start` | every seat started whole on its CLI; its first model call is kept in `request.json` and refused: the prompt and tools its model is given, each `started` | nothing |
| `node evals/run.cjs --spend --label <name>` | the seats on their agent CLIs | model calls; only on the owner's word |
| `node evals/run.cjs --regrade <name>` | a label's saved outcomes graded again | nothing |

Options for a spending run:
- `--harness claude|codex` keeps one agent CLI;
- `--tiers default,cheap` sets the Peer tiers from `room/models.json`;
- `--effort high` sets every seat's thinking;
- `--only <regex>` picks cases;
- `--jobs 2`, `--budget 4` (dollars a run, Claude), `--timeout 20` (minutes).

A run without `--spend` on a real CLI is refused.

Results land in `evals/results/<label>/`, which git ignores: `report.md`, `summary.json`, and one folder per run. A run's folder holds:
- `system-prompt.md` and `prompt.md`;
- `events.jsonl` or `script.jsonl`;
- `paseo.jsonl`;
- `final.md`;
- `outcome.json`, with the grades and the room and project after the turn.

A seat sees only paths under the system's temporary folder named after nothing (`sw-<hash>/<hash>`). A path that names "evals" or the case tells a seat it is graded.

## A case

Cases live in `cases.cjs`. A case has:
- `role` and `title`, and `owner`: the fixture seat it reports to;
- `rule`: the line of a role page or spec it guards;
- `files`: the project, committed as its base, and `uncommitted`: what lies on top;
- `arrange` and `before`: the seats and the state set before the seat opens and after;
- `prompt`: text, or `ctx.delivered()` for the mail the room handed the seat;
- `grades`: built with `g` from `graders.cjs`;
- `script`: the turn a right answer takes, and `wrong`: one that breaks the rule;
- `writes`: true for a seat that may edit; it then runs in the real seat's permission mode, and every other case is held to reading;
- `policy`: keys laid over the room's policy for this case.

Add a case when a rule of a role page, spec or skill has no run that would catch its loss.

## Before a number is trusted

- Its wrong turn is `caught` and its right turn passes, on the scripted harness. That proves the graders, not the prompt.
- Red first on a model: a new case runs once against the room without its rule (a copy of `plugin/room` with the line removed). A case that passes there cannot fail.
- Same cases before and after an edit, more than once each: a seat that passes three in four passes three in a row less than half the time.
- Read a transcript. A pass says the graders were satisfied. Open `final.md` and the calls of a few runs before believing the number.
- Check the variant: grep a run's `system-prompt.md` for a sentence only the variant has before reporting an A/B.

What a run leaves out against a real seat:
- the seat's later turns: one turn is graded;
- Paseo's permission flow;
- other seats acting: fixture seats only hold state.

A Claude seat runs with a Claude folder of the run's own and the login Paseo gives its seats (`CLAUDE_CODE_OAUTH_TOKEN`, from the environment or Paseo's `claude` provider); the user's `~/.claude` is not touched. A dry run's Codex seat talks to a provider of its own, the run's endpoint. Codex in code mode lists the room's MCP tools to its model only on request (`ALL_TOOLS` in its `exec` tool), so a dry run shows its own tools, not the room's.

Run a spending run from a clean environment (`env -i HOME=… USER=… PATH=… TMPDIR=…`): an agent CLI started from inside another agent's session inherits that session's variables.

Codex runs on the room's runtime home for its role, with full access for a case that writes, as a real seat runs (its `workspace-write` sandbox keeps `.git` read-only, so no commit), and `read-only` otherwise; the room's guard hook checks its commands as in a real seat.

## Jev

`evals/jev/<site>.json` holds labelled cases for each place the room asks the decision model: the raw fields that place builds its state from, and the answer it should get. `plugin/tools/jev-eval.ts` asks the provider in force with the key in the room home, and writes nothing there.

| Command (in `plugin/`) | What it does | Costs |
|---|---|---|
| `node --require ./test/register.cjs tools/jev-eval.ts --dry` | builds every request and counts its tokens | nothing |
| `node --require ./test/register.cjs tools/jev-eval.ts --label <name>` | every case, every variant | about 150,000 tokens, under 0.01 USD |
| `… --only '^(keep|duplicate)$'` | the sites whose name matches | less |
| `… --variants '^ends$' --questions <file>` | only the variants that match, and beside each shipped question the rewordings in `<file>` | less, or more per rewording |

Each choice is asked with its options in the listed order and reversed, in one request, and read three ways: `asked`, `reversed`, and `both` (their mean, sure only when the two orders agree, as the room reads it). A juror is read as written, reworded, and both. Variants vary the input: `head` and `ends` (a long text cut to its head, or to its head and tail), `with-olds` and `alone` (the keep gate with the older decisions in its state or without), `all` and `own` (the duplicate labels), `batch` and `solo` (several items in one state, or one).

`evals/results/jev-<label>/report.md` counts, per site, variant and reading: right, sure, sure and right, sure and wrong, and split. Sure and wrong is the number that matters: the room acts on it. A case belongs in a file when the room met it or a change is meant to fix it; write its `why`. A rewording is tried with `--questions`: `question` replaces the shipped one (a choice keeps its labels unless the rewording words them), `with` adds case fields to the state, and `nouls` asks a choice as one noul a label, acted on in `order`. Cases whose id starts with `held-` are written before a rewording is tried and kept out of tuning it; read them apart to see whether it holds.
