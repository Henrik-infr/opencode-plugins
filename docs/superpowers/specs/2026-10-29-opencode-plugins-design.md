# opencode-plugins — design

**Date:** 2026-10-29
**Package:** `opencode-darling-data`
**Source collection:** [claude-plugins](https://github.com/erikdarlingdata/claude-plugins) (Claude Code marketplace `erikdarling`)
**Status:** design approved in conversation 2026-10-29

## 1. Purpose

Port the Darling Data Claude Code plugin collection to opencode as one
npm-installable umbrella package. Every Claude plugin is ported or consciously
reimagined in opencode's shape; nothing is silently dropped.

## 2. Decisions (fixed during brainstorming)

| Decision | Choice |
| --- | --- |
| Scope | Full collection |
| Repo | New repo `opencode-plugins`, separate from claude-plugins |
| Band plugins (`open-asks`, `subagent-band`) | Reimagined as custom tools + commands |
| Distribution | Published, npm-installable |
| Packaging | Single umbrella package `opencode-darling-data` |

## 3. opencode extension surface used

- **Plugins**: TS modules loaded from npm (auto-installed by Bun at startup,
  cached under `~/.cache/opencode/node_modules/`)
- **Hooks**: `tool.execute.before` (throw = refuse), `event`, `config`,
  `chat.params`, `experimental.chat.system.transform`,
  `experimental.chat.messages.transform`
- **Custom tools**: `tool()` helper (Zod args)
- **Commands**: injected programmatically via the `config` hook into
  `cfg.command`
- **TUI**: toasts only (`tui.toast.show`); opencode has no status band
- **Skills**: same `SKILL.md` format as Claude Code

## 4. Repo layout

No build step: opencode loads TypeScript directly, so the package ships `.ts`
source.

```
opencode-plugins/
  package.json          main: plugin.ts; files: src/, skills/, scripts/
  plugin.ts             entry: composes sub-plugins, applies options
  src/
    shared.ts           option parsing, path normalization, registry helpers
    fence.ts            subagent-fence
    wall.ts             subagent-wall
    allowlist.ts        model-allowlist
    asks.ts             open-asks
    fleet.ts            subagent-band
    budget.ts           usage-budget
    resume.ts           seat-resume
  skills/query-plan-analysis/   SKILL.md + scripts/extract.py + references (copied verbatim)
  scripts/resume-sessions.ps1   ported from seat-resume
  tests/
  docs/superpowers/specs/
```

`@opencode-ai/plugin` is a dev dependency, used for types only.

## 5. Install UX

```json
{ "plugin": ["opencode-darling-data"] }
```

Options arrive via the tuple form, namespaced per sub-plugin. A `disabled`
list turns a sub-plugin off entirely (the opt-out for the umbrella package):

```json
["opencode-darling-data", {
  "disabled": ["budget"],
  "fence": { "guard_force_push": true, "protected_branches": ["main", "master", "dev"] },
  "wall":  { "warnMinutes": 45, "limitMinutes": 60 }
}]
```

Each sub-plugin reads only its own namespace. Option parsing is lenient, as in
the Claude plugins: list options accept arrays or comma/newline-separated
strings; booleans fall back to their defaults on anything else.

## 6. Sub-plugin designs

### 6.1 `fence` (from subagent-fence)

Guards, each optional, defaults matching the Claude version:

- **bash tool**: force-push (including `--force-with-lease`, `-f`, `+refspec`),
  pushes targeting a protected branch, `--no-verify`, and kill-by-name
  (`pkill`, `killall`, `taskkill /IM`, `Stop-Process -Name`).
- **read/edit tools**: banned paths (never read, written, or entered), and
  `read_limit_bytes` refusing a whole-file read above the limit when the call
  gives no offset/limit.
- **shared-checkout guard**: a subagent's edits and mutating git commands in a
  plain checkout (`.git` is a directory; a linked worktree's `.git` is a file),
  scoped by `shared_checkout_root`.

Parsing logic (push refspec parsing, regexes, path normalization) is ported
from `hooks/register.ts`. Refusal = throw in `tool.execute.before`, same
message style.

### 6.2 `wall` (from subagent-wall)

- Track subagent session start times from `session.created` events.
- After `warnMinutes`: inject a finish-up instruction into the subagent via
  `experimental.chat.messages.transform`.
- After `limitMinutes`: `tool.execute.before` restricts the session to `git`,
  `gh`, and `.md`/`.txt` writes; it commits, reports, and ends.
- No-edit nudge at `noEditNudgeK` context tokens without an edited file,
  applied to `codeAgentTypes`.
- The main session is never limited.

### 6.3 `allowlist` (from model-allowlist)

opencode's `task` tool takes an agent type, not a model, so the spawn-time
check becomes a startup check plus a per-request check:

- `config` hook: validate every `cfg.agent[*].model` against the alias rules at
  startup; throw on a pinned id.
- `chat.params` hook: apply the same rules to per-request model overrides.
- The `rules` option (`agent pattern => model => brief pattern => message`)
  carries over; a rule that does not parse is skipped.

### 6.4 `asks` (from open-asks)

- Custom tools `ask_add(question, recommendation)`, `ask_resolve(id)`,
  `ask_list()`, via the `tool()` helper.
- A persistent per-session registry file, so a resumed session keeps its asks.
- `tui.toast.show` when an ask is added.
- `/asks` command: the agent lists pending asks from the registry.
- No band: the degradation is toast + command + persistence. Open asks are
  saved per session, as in the Claude version.

### 6.5 `fleet` (from subagent-band)

- `/fleet` command: list every subagent session of the current session through
  the SDK client — type, model, steps, context size, estimated cost, finished
  ones included.
- `subagent_vitals` custom tool: a cheap vitals read so the model does not
  parse output files to check progress.
- Cost estimates from message token-usage parts with the `priceTable` option
  (same defaults as the Claude version). List-price estimates, not a bill.

### 6.6 `budget` (from usage-budget)

opencode emits no rate-limit events, so this is a configured token/USD budget
rather than percent-of-plan:

- Options: `budget5h` and `budget7d` (token amounts, one per window; `0`
  disables that window). The percent options below are percentages of these.
- `message.updated` events accumulate token usage into persistent rolling 5h
  and 7d windows, written to `<config>/usage-budget/latest.json` using the
  same file contract as the Claude version (external readers keep working).
- `warnPercents` raise toasts, once each per window.
- Past `tellModelAtPercent`, inject a model-facing note via
  `experimental.chat.system.transform`.
- Past `spawnGatePercent`, `tool.execute.before` refuses new subagent spawns
  (the `task` tool).
- The pace check carries over: 7-day spend running `paceMargin` points ahead
  of the elapsed share of the window raises a toast and the gate, with the UTC
  time the refusal lifts if spend stays flat.

### 6.7 `resume` (from seat-resume)

- `event` hook on `session.created` / `session.idle` / `session.deleted`:
  write one small registry file per interactive session (id, directory, title,
  permission mode, last activity, ended-cleanly marker).
- `/resume-sessions` command: lists sessions interrupted within the last 72
  hours, then the agent runs the bundled `scripts/resume-sessions.ps1`.
- The script is ported: Windows process start-time comparison to tell a live
  session from a reused process id, `-Launch` reopens tabs in WezTerm or
  Windows Terminal. Windows only, as today.
- Options carried over: `registry_dir`, `sessions_dir`, `resume_script`,
  `powershell`, `terminal`.

### 6.8 `query-plan-analysis` (from sqlserver-query-plans)

- `skills/query-plan-analysis/` copied verbatim (SKILL.md, `extract.py`,
  references) — the content is harness-agnostic.
- Registration: the `config` hook appends the package's bundled `skills/`
  directory to `cfg.skills.paths`.
- If skills are scanned before plugin init (spike 1 fails), the fallback is
  whichever of these needs zero user steps, decided at spike time: a README
  line adding the package's `skills/` path (inside the opencode cache) via
  `skills.paths`, or a postinstall copy into `~/.config/opencode/skills/`.

### 6.9 Not ported

`pi-session-resume`, `pi-subagent-watchdog`, `pi-subagent-guardrails` are
pi-only. The README maps each to its opencode equivalent in this package
(`resume`, `fleet`/`budget`, `wall`).

## 7. Spikes (run before any port work)

Each spike is a throwaway local plugin file in `.opencode/plugins/` run
against a real opencode session. Findings are recorded in the implementation
notes; spike code is discarded.

| # | Question | Needed by | Fallback if it fails |
| --- | --- | --- | --- |
| 1 | Does a `config`-hook append to `cfg.skills.paths` register skills? | 6.8 | documented `skills.paths` entry or postinstall copy |
| 2 | Does `tool.execute.before` input identify the calling session/agent (subagent vs main)? | fence, wall | guards apply to all sessions (fence already guards the main session) |
| 3 | Do session events expose parent/child relationships? | wall, fleet | wall degrades to time-since-session-created; fleet lists all sessions in the project |
| 4 | What is the `tui.toast.show` shape from a plugin? | asks, budget | `client.app.log` only; README notes toasts unavailable |

## 8. Testing

- Unit tests per module for the pure logic: push parsing and regexes (fence),
  option parsing (shared), budget window math, registry read/write. The test
  setup mirrors claude-plugins (vitest).
- Each spike doubles as a manual integration check on Windows.
- One runnable self-check per non-trivial module, same standard as
  claude-plugins.

## 9. Deliberately out of scope

- No build step, bundler, or generated types — source TS ships as-is.
- No TUI status band; toasts and commands only.
- No Copilot or pi compatibility in this repo.
- No per-plugin npm packages; the umbrella package plus the `disabled` list
  covers opt-out.
