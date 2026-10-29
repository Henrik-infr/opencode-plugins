# opencode-plugins — design

**Date:** 2026-10-29
**Package:** `opencode-darling-data`
**Source collection:** [claude-plugins](https://github.com/erikdarlingdata/claude-plugins) (Claude Code marketplace `erikdarling`)
**Status:** design approved in conversation 2026-10-29

## 1. Purpose

Port the Darling Data Claude Code plugin collection to opencode as one
npm-installable umbrella package. Every Claude plugin is ported, reimagined in
opencode's shape, or dropped with the reason recorded; nothing is silently
dropped.

Revised 2026-10-29 after external review: claims about opencode were checked
against the published config schema, the plugin/SDK docs, and the 1.18.35 SDK
types (the installed opencode version). plugin options are now spike 0, the skill installs through folders
opencode already reads, model-allowlist is dropped (no tier aliases exist in
opencode), and budget counts usage by per-message deltas.

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
  cached under `~/.cache/opencode/node_modules/`). The plugin signature is
  `(input, options?)`; whether the config `options` value actually reaches
  the second parameter on opencode 1.18.x is spike 0.
- **Hooks**: `tool.execute.before` (throw = refuse), `event`, `config`,
  `chat.params`, `experimental.chat.system.transform`,
  `experimental.chat.messages.transform`
- **Custom tools**: `tool()` helper (Zod args)
- **Commands**: markdown files; the plugin copies them into
  `~/.config/opencode/commands/` at startup, a folder opencode already reads
- **TUI**: toasts via `client.tui.showToast({ body: { message, variant } })`
  (plugins get the v1 client; the flat shape is v2); opencode
  has no status band
- **Skills**: same `SKILL.md` format as Claude Code, discovered from
  `~/.config/opencode/skills/` among other folders
- **Session model** (verified in the 1.18.35 SDK types): `Session.parentID`
  exists, `session.children()` lists a session's subagents, and
  `AssistantMessage` carries `cost` and `tokens`

## 4. Repo layout

No build step: opencode loads TypeScript directly, so the package ships `.ts`
source.

```
opencode-plugins/
  package.json          main: plugin.ts; files: src/, skills/, commands/, scripts/
  plugin.ts             entry: composes sub-plugins, applies options
  src/
    shared.ts           option parsing, path normalization, registry helpers
    fence.ts            subagent-fence
    wall.ts             subagent-wall
    asks.ts             open-asks
    fleet.ts            subagent-band
    budget.ts           usage-budget
    resume.ts           seat-resume
  skills/query-plan-analysis/   SKILL.md + scripts/extract.py + references (copied verbatim)
  commands/             asks.md, fleet.md, resume-sessions.md
  scripts/resume-sessions.ps1   ported from seat-resume
  tests/
  docs/superpowers/specs/
```

`@opencode-ai/plugin` is a dev dependency, used for types only, pinned to the
opencode version actually run (1.18.35 today) so the types match the runtime.

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

The `options` object reaching the plugin function is spike 0: the config
schema documents it, but the runtime wiring on opencode 1.18.x is unverified.
If it fails, options are read from `~/.config/opencode/darling-data.json`
instead, same shape.

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
- Reference while porting: the pi version (`pi-subagent-guardrails`' context
  wall) is closer to opencode's model than the Claude hook version.

### 6.3 `asks` (from open-asks)

- Custom tools `ask_add(question, recommendation)`, `ask_resolve(id)`,
  `ask_list()`, via the `tool()` helper.
- A persistent per-session registry file, so a resumed session keeps its asks.
- `client.tui.showToast` when an ask is added.
- `/asks` command: the agent lists pending asks from the registry.
- No band: the degradation is toast + command + persistence. Open asks are
  saved per session, as in the Claude version.

### 6.4 `fleet` (from subagent-band)

- `/fleet` command: list every child session of the current session via
  `session.children()` — agent, model, steps, context size, cost, finished
  ones included.
- `subagent_vitals` custom tool: a cheap vitals read so the model does not
  parse output files to check progress.
- Cost comes from the `cost` field opencode already puts on each assistant
  message (priced from models.dev). No price table of our own.

### 6.5 `budget` (from usage-budget)

opencode emits no rate-limit events, so this is a configured token budget
rather than percent-of-plan:

- Options: `budget5h` and `budget7d` (token amounts, one per window; `0`
  disables that window). The percent options below are percentages of these.
- `message.updated` events accumulate usage into persistent rolling 5h and 7d
  windows, written to `~/.config/opencode/darling-data/budget.json`. The
  numbers are a configured budget, not a plan's rate limit, so this is a new
  file rather than the Claude version's contract. Schema per window:
  `{ budget, used, percent, windowStart }`.
- `message.updated` fires repeatedly while a message streams, and the
  message's `cost` and `tokens` are running totals: usage is tracked per
  message id and accumulated as deltas, so nothing is counted twice.
- `warnPercents` raise toasts, once each per window.
- Past `tellModelAtPercent`, inject a model-facing note via
  `experimental.chat.system.transform`.
- Past `spawnGatePercent`, `tool.execute.before` refuses new subagent spawns
  (the `task` tool).
- The pace check carries over: 7-day spend running `paceMargin` points ahead
  of the elapsed share of the window raises a toast and the gate, with the UTC
  time the refusal lifts if spend stays flat.

### 6.6 `resume` (from seat-resume)

- `event` hook on `session.created` / `session.idle` / `session.deleted`:
  opencode already stores its own sessions (id, directory, title, timestamps).
  The registry adds only what that storage lacks: an ended-cleanly marker per
  session id, plus last activity. Check opencode's session storage layout
  during implementation before adding anything else to the registry.
- `/resume-sessions` command: lists sessions interrupted within the last 72
  hours, then the agent runs the bundled `scripts/resume-sessions.ps1`.
- The script is ported: Windows process start-time comparison to tell a live
  session from a reused process id, `-Launch` reopens tabs in WezTerm or
  Windows Terminal. Windows only, as today.
- Options carried over: `registry_dir`, `sessions_dir`, `resume_script`,
  `powershell`, `terminal`.

### 6.7 `query-plan-analysis` (from sqlserver-query-plans)

- `skills/query-plan-analysis/` copied verbatim (SKILL.md, `extract.py`,
  references) — the content is harness-agnostic.
- Registration: at plugin startup, `plugin.ts` copies
  `skills/query-plan-analysis/` into `~/.config/opencode/skills/` and
  `commands/*.md` into `~/.config/opencode/commands/` — folders opencode
  already reads — skipping files whose content already matches. Zero user
  steps, and the copies follow package updates. Skills and commands may be
  scanned before plugin init, so on a fresh install they appear from the
  second launch; the README says so. No runtime config mutation.

### 6.8 Not ported

- **model-allowlist**: opencode has no tier aliases — every model is a pinned
  `provider/model` id, so the plugin's core rule (refuse pins, ask for the
  alias) has nothing to check. Throwing from the `config` hook would crash
  opencode at startup, and throwing from `chat.params` would break the main
  chat. opencode itself errors on an unknown model id.
- `pi-session-resume`, `pi-subagent-watchdog`, `pi-subagent-guardrails` are
  pi-only. The README maps each to its opencode equivalent in this package
  (`resume`, `fleet`/`budget`, `wall`).

## 7. Spikes (run before any port work)

Each spike is a throwaway local plugin file in `.opencode/plugins/` run
against a real opencode session. Findings are recorded in the implementation
notes; spike code is discarded.

| # | Question | Needed by | Fallback if it fails |
| --- | --- | --- | --- |
| 0 | Does the config `options` value reach the plugin function's second parameter on opencode 1.18.x? | every sub-plugin | options read from `~/.config/opencode/darling-data.json`, same shape |
| 1 | Given the `sessionID` from `tool.execute.before` (confirmed in types), does a session lookup at runtime return `parentID` for a `task`-spawned subagent? | fence, wall | guards apply to all sessions (fence already guards the main session) |

Resolved during review against the SDK types and docs — no spike needed:
sessions have `parentID` and `session.children()` lists subagents; toasts go
through `client.tui.showToast({ body })`; `tool.execute.before` input is
`{ tool, sessionID, callID }`; assistant messages carry `cost` and `tokens`.

## 8. Testing

- Unit tests per module for the pure logic: push parsing and regexes (fence),
  option parsing (shared), budget window and delta math, registry read/write.
  The test setup mirrors claude-plugins (vitest).
- Each spike doubles as a manual integration check on Windows.

## 9. Deliberately out of scope

- No build step, bundler, or generated types — source TS ships as-is.
- No TUI status band; toasts and commands only.
- No Copilot or pi compatibility in this repo.
- No per-plugin npm packages; the umbrella package plus the `disabled` list
  covers opt-out.
