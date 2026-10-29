# opencode-plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the Darling Data Claude Code plugin collection to opencode as one npm package, `opencode-darling-data`.

**Architecture:** One umbrella plugin module (`plugin.ts`) composes six sub-plugins (`fence`, `wall`, `asks`, `fleet`, `budget`, `resume`) by merging their hook objects; a startup step copies the bundled skill and slash-command files into the opencode config folders opencode already reads. All ported logic lives in pure functions in `src/`, tested with vitest; hook wiring stays thin.

**Tech Stack:** TypeScript (shipped unbundled — opencode's Bun runtime loads `.ts` directly), `@opencode-ai/plugin` 1.18.35 (types only), vitest, node:fs/promises, PowerShell 5.1+ for the resume script.

**Spec:** `docs/superpowers/specs/2026-10-29-opencode-plugins-design.md` (this plan argues from the spec — read both)

## Global Constraints

- Runtime: opencode **1.18.35** (the installed version). `@opencode-ai/plugin` is pinned `"1.18.35"` so types match the runtime.
- No build step: the package ships `.ts` source. `package.json` `"main": "plugin.ts"`, `"type": "module"`, `"files": ["plugin.ts", "src/", "skills/", "commands/", "scripts/"]`.
- File IO uses `node:fs/promises` (works in both Bun and Node/vitest). Never `Bun.file` — tests run under Node.
- Hook shapes (verified in `@opencode-ai/plugin@1.18.35` types): `tool.execute.before` input is `{ tool, sessionID, callID }` with `output: { args }`; refusal = **throw**. Plugin signature is `(input, options?) => Promise<Hooks>`.
- The v1 SDK client wraps params in `{ body }` / `{ path }`: `client.tui.showToast({ body: { message, variant } })`, `client.session.get({ path: { id } })`.
- Option parsing is lenient: list options accept arrays or comma/newline-separated strings; booleans fall back to defaults on non-booleans.
- Tests: vitest, co-located as `src/*.test.ts`. Run with `npx vitest run`. Windows is the dev platform; paths in fixtures use forward slashes.
- Package name `opencode-darling-data`, MIT, author Erik Darling / Darling Data (same as the source repo).
- Port source: `C:\Users\aa958\Documents\GitHub\claude-plugins\plugins\<name>\` — read it before each port.
- Commit after every task. Never commit secrets.

---

### Task 1: Spikes — plugin options and subagent identity

**Files:**
- Create: `.opencode/spike.ts` (throwaway, deleted at the end of this task)
- Create: `.opencode/opencode.json` (throwaway, deleted at the end of this task)
- Modify: this plan file (record findings in the Spike Findings section below)

**Interfaces:**
- Consumes: nothing
- Produces: two facts later tasks branch on — (a) whether `options` reaches the plugin's second parameter, (b) whether `client.session.get({ path: { id } })` returns `parentID` for a `task`-spawned subagent. Every later task that reads options must use the resolution recorded here.

- [ ] **Step 1: Write the spike plugin**

`.opencode/spike.ts` (outside `plugins/` so it is NOT auto-loaded — it must load through the config entry, which is what carries options):

```ts
import { appendFile, mkdir } from "node:fs/promises"
import path from "node:path"

const out = path.join(import.meta.dir, "spike-findings.jsonl")
const log = async (o: unknown) => { await appendFile(out, `${JSON.stringify(o)}\n`) }

export const Spike = async (input: any, options?: any) => {
  await mkdir(import.meta.dir, { recursive: true })
  await log({ kind: "init", optionsReceived: options ?? null })
  return {
    event: async ({ event }: any) => {
      if (event.type === "session.created") {
        const i = event.properties.info
        await log({ kind: "session.created", id: i.id, parentID: i.parentID ?? null })
      }
    },
    "tool.execute.before": async (i: any) => {
      try {
        const s = await input.client.session.get({ path: { id: i.sessionID } })
        await log({ kind: "tool", tool: i.tool, sessionID: i.sessionID, parentID: s.data?.parentID ?? null })
      } catch (e) {
        await log({ kind: "tool", tool: i.tool, sessionID: i.sessionID, error: String(e) })
      }
    },
  }
}
```

- [ ] **Step 2: Point the project config at it, with options**

`.opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["./spike.ts", { "spike": 42 }]]
}
```

- [ ] **Step 3: Run opencode in this repo and exercise it**

Run `opencode` in `C:\Users\aa958\Documents\GitHub\opencode-plugins`, then:
1. Prompt: `run git status` (exercises `tool.execute.before` for the main session)
2. Prompt: `use a subagent to list the files in this repo` (exercises a task-spawned session)
3. Exit opencode (`/exit`)

- [ ] **Step 4: Read findings and record them in this plan**

Read `.opencode/spike-findings.jsonl`.

- Spike 0 result: `init` line — does `optionsReceived` equal `{"spike":42}`?
  - **Yes** → every sub-plugin reads options from the plugin's second parameter. Spec §5 stands as written.
  - **No/undefined** → options come from `~/.config/opencode/darling-data.json` instead: `plugin.ts` reads that file at init (same shape: `{ disabled: [], fence: {}, ... }`) and ignores the second parameter. Update spec §5's fallback note from "if it fails" to the chosen behavior.
- Spike 1 result: `tool` lines — for calls made inside the subagent, is `parentID` non-null?
  - **Yes** → `shared.isSubagent(client, sessionID)` (Task 2) uses `client.session.get` + `parentID`.
  - **No** → subagent-only guards (fence shared-checkout + read-limit, wall) treat every session as a subagent EXCEPT the latest main session (tracked from `session.created` without `parentID`); update the fallback note in spec §7 row 1 accordingly.

Write the findings into the **Spike Findings** section at the end of this plan file.

- [ ] **Step 5: Clean up and commit**

Delete `.opencode/spike.ts`, `.opencode/opencode.json`, `.opencode/spike-findings.jsonl` (the whole `.opencode/` folder if it holds nothing else). Commit the plan file with the findings:

```powershell
Remove-Item -Recurse -Force .opencode
git add docs/superpowers/plans/2026-10-29-opencode-plugins.md
git commit -m "docs: record spike findings (options, subagent identity)"
```

---

### Task 2: Package skeleton — plugin.ts composer and src/shared.ts

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `plugin.ts`
- Create: `src/shared.ts`, `src/shared.test.ts`
- Test: `src/shared.test.ts`

**Interfaces:**
- Consumes: nothing (spike findings only decide behavior, not signatures)
- Produces (later tasks import from `src/shared.ts`):
  - `list(v: unknown): string[]`
  - `flag(v: unknown, fallback: boolean): boolean`
  - `num(v: unknown, fallback: number): number`
  - `norm(p: unknown): string` and `slashes(p: string): string` (path normalization, ported verbatim from fence)
  - `Shared` type and `createShared(input: PluginInput): { shared: Shared; hooks: Partial<Hooks> }` where `Shared = { currentSession(): string | undefined; dataDir(sub: string): Promise<string>; toast(message: string, variant?: "info" | "success" | "warning" | "error"): Promise<void> }`
  - `mergeHooks(list: Array<Partial<Hooks>>): Hooks` — chains function-valued hooks in order (first throw wins), object-merges `tool`
  - Sub-plugin contract: `(input: PluginInput, options: Record<string, unknown>, shared: Shared) => Promise<Partial<Hooks>>`

- [ ] **Step 1: Verify the toolchain**

Run: `node --version`. Expected: v18+ prints. (If Node is missing, install it before continuing — vitest runs under Node.)

- [ ] **Step 2: Write the failing tests for shared**

`src/shared.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import { flag, list, mergeHooks, norm, num, slashes } from "./shared"

describe("lenient option parsing", () => {
  test("list takes arrays or comma/newline strings", () => {
    expect(list(["a", "b"])).toEqual(["a", "b"])
    expect(list("a, b\nc")).toEqual(["a", "b", "c"])
    expect(list(undefined)).toEqual([])
    expect(list(7)).toEqual([])
  })
  test("flag falls back on non-booleans", () => {
    expect(flag(true, false)).toBe(true)
    expect(flag(undefined, true)).toBe(true)
    expect(flag("yes", false)).toBe(false)
  })
  test("num parses, falls back on garbage", () => {
    expect(num("45", 60)).toBe(45)
    expect(num(undefined, 60)).toBe(60)
    expect(num("x", 60)).toBe(60)
  })
})

describe("path normalization (ported from fence)", () => {
  test("slashes", () => {
    expect(slashes("C:\\a\\\\b/")).toBe("C:/a/b")
  })
  test("norm lowercases and fixes drive letters", () => {
    expect(norm("C:\\A\\B")).toBe("c:/a/b")
    expect(norm("/c/Users/x/")).toBe("c:/users/x")
  })
})

describe("mergeHooks", () => {
  test("chains event callbacks in order and merges tool objects", async () => {
    const seen: string[] = []
    const merged = mergeHooks([
      { event: async () => { seen.push("a") } },
      { tool: { one: {} as any } },
      { event: async () => { seen.push("b") } },
      { tool: { two: {} as any } },
    ] as any)
    await (merged.event as any)({ event: { type: "x", properties: {} } })
    expect(seen).toEqual(["a", "b"])
    expect(Object.keys(merged.tool!)).toEqual(["one", "two"])
  })
  test("a throw in an early tool.execute.before wins", async () => {
    const merged = mergeHooks([
      { "tool.execute.before": async () => { throw new Error("fence says no") } },
      { "tool.execute.before": async () => { throw new Error("should not run") } },
    ] as any)
    await expect((merged["tool.execute.before"] as any)({ tool: "bash", sessionID: "s", callID: "c" }, { args: {} }))
      .rejects.toThrow("fence says no")
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/shared.test.ts`
Expected: FAIL — cannot resolve `./shared`.

- [ ] **Step 4: Write package.json, tsconfig, .gitignore, shared.ts, plugin.ts**

`package.json`:

```json
{
  "name": "opencode-darling-data",
  "version": "0.1.0",
  "description": "Darling Data plugins for opencode: subagent fence, wall, open asks, fleet, usage budget, session resume, and the SQL Server query-plan skill",
  "license": "MIT",
  "author": "Erik Darling (https://erikdarling.com)",
  "repository": { "type": "git", "url": "git+https://github.com/erikdarlingdata/opencode-plugins.git" },
  "type": "module",
  "main": "plugin.ts",
  "files": ["plugin.ts", "src/", "skills/", "commands/", "scripts/"],
  "scripts": { "test": "vitest run", "typecheck": "tsc --noEmit" },
  "devDependencies": {
    "@opencode-ai/plugin": "1.18.35",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "keywords": ["opencode", "opencode-plugin", "subagents", "guardrails", "sql-server", "query-plan"]
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "types": []
  },
  "include": ["plugin.ts", "src/**/*.ts"]
}
```

`.gitignore`:

```
node_modules/
.opencode/
```

`src/shared.ts`:

```ts
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Paths compare in one form: forward slashes, no doubled slashes, lower case, /c/... as c:/...
export const slashes = (p: string) => p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/")
export const norm = (p: unknown) => slashes(String(p ?? "")).replace(/^\/([a-z])\//i, "$1:/").replace(/(.)\/$/, "$1").toLowerCase()

export const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [])
    .map(s => String(s).trim()).filter(Boolean)
export const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback)
export const num = (v: unknown, fallback: number) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim())
  return Number.isFinite(n) ? n : fallback
}

// The opencode config root: ~/.config/opencode (XDG_CONFIG_HOME respected).
export const configRoot = () =>
  path.join(process.env.XDG_CONFIG_HOME ? process.env.XDG_CONFIG_HOME : path.join(os.homedir(), ".config"), "opencode")

export type Shared = {
  currentSession(): string | undefined
  dataDir(sub: string): Promise<string>
  toast(message: string, variant?: "info" | "success" | "warning" | "error"): Promise<void>
}

const FUNCTION_KEYS: Array<keyof Hooks> = [
  "dispose", "event", "config", "chat.message", "chat.params", "chat.headers",
  "permission.ask", "command.execute.before", "tool.execute.before", "tool.execute.after",
  "shell.env", "experimental.chat.messages.transform", "experimental.chat.system.transform",
  "experimental.session.compacting", "experimental.compaction.autocontinue",
  "experimental.text.complete", "tool.definition",
] as any

// Chains function-valued hooks in order (first throw wins); object-merges tool.
export function mergeHooks(parts: Array<Partial<Hooks>>): Hooks {
  const out: Record<string, unknown> = { tool: {} }
  for (const part of parts) {
    for (const key of Object.keys(part) as Array<string>) {
      if (key === "tool") {
        Object.assign(out.tool as object, (part as any).tool)
      } else if (FUNCTION_KEYS.includes(key as keyof Hooks)) {
        const fns = ((out[key] as unknown) as Array<unknown> | undefined) ?? []
        fns.push((part as any)[key])
        out[key] = fns.length === 1 ? fns[0] : async (...a: unknown[]) => {
          for (const fn of fns) await (fn as any)(...a)
        }
      }
    }
  }
  return out as Hooks
}
```

`plugin.ts` (sub-plugins register one per task; the disabled set and `options` source follow the Task 1 spike findings):

```ts
import type { Plugin, Hooks } from "@opencode-ai/plugin"
import { createShared, list, mergeHooks } from "./src/shared"

type SubPlugin = (input: any, options: Record<string, unknown>, shared: ReturnType<typeof createShared>["shared"]) => Promise<Partial<Hooks>>

const SUBPLUGINS: Record<string, SubPlugin> = {
  // fence: ..., wall: ..., asks: ..., fleet: ..., budget: ..., resume: ...   (added in Tasks 3-9)
}

export default (async (input, options = {}) => {
  const disabled = new Set(list((options as any).disabled))
  const { shared, hooks } = createShared(input)
  const parts: Array<Partial<Hooks>> = [hooks] // tracker first: currentSession is set before sub-plugins see events
  for (const [name, sub] of Object.entries(SUBPLUGINS)) {
    if (!disabled.has(name)) parts.push(await sub(input, (options as any)[name] ?? {}, shared))
  }
  return mergeHooks(parts)
}) satisfies Plugin
```

`createShared` returns `{ shared, hooks }` — `hooks` carries the `event` tracker that keeps `currentSession()` pointed at the latest main session (`session.created` without `parentID`):

```ts
export function createShared(input: PluginInput): { shared: Shared; hooks: Partial<Hooks> } {
  let main: string | undefined
  const shared: Shared = {
    currentSession: () => main,
    dataDir: async sub => {
      const dir = path.join(configRoot(), "darling-data", sub)
      await mkdir(dir, { recursive: true })
      return dir
    },
    toast: async (message, variant = "info") => {
      try {
        await input.client.tui.showToast({ body: { message, variant } })
      } catch {
        try { await input.client.app.log({ body: { service: "darling-data", level: "warn", message } }) } catch { /* never fatal */ }
      }
    },
  }
  return {
    shared,
    hooks: {
      event: async ({ event }) => {
        if (event.type === "session.created" && !event.properties.info.parentID) main = event.properties.info.id
      },
    },
  }
}
```

(The plan shows `plugin.ts` first and `createShared` second so the composition reads top-down; in `src/shared.ts` they live in the order shown above — parsing helpers, `Shared`, `mergeHooks`, then `createShared`.)

- [ ] **Step 5: Install and run tests**

```powershell
npm install
npx vitest run
```
Expected: all `src/shared.test.ts` tests PASS.

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`. Expected: no errors.

- [ ] **Step 7: Commit**

```powershell
git add package.json tsconfig.json .gitignore plugin.ts src/
git commit -m "feat: package skeleton, hook composer, shared option parsing"
```

---

### Task 3: Fence

**Files:**
- Create: `src/fence.ts`, `src/fence.test.ts`
- Modify: `plugin.ts` (register the sub-plugin)
- Port source: `C:\Users\aa958\Documents\GitHub\claude-plugins\plugins\subagent-fence\hooks\register.ts` (read it in full first)

**Interfaces:**
- Consumes: `list`, `flag`, `num`, `norm`, `slashes`, `normCommand` (re-export from shared), `Shared.toast`
- Produces: `fence: SubPlugin` (default export from `src/fence.ts`) reading options `guard_force_push`, `guard_protected_branches`, `protected_branches`, `guard_no_verify`, `guard_kill_by_name`, `banned_paths`, `guard_shared_checkout`, `shared_checkout_root`, `read_limit_bytes` — same names, same defaults as the Claude plugin

- [ ] **Step 1: Write the failing tests**

`src/fence.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import { fenceConfig, pushProblem, sharedGitMutation } from "./fence"

const base = { forcePush: true, protectedPush: true, protectedBranch: /(^|:)(refs\/heads\/)?(main|master|dev)$/, noVerify: true, killByName: true, bannedRoots: [], bannedInCommand: [], sharedCheckout: false, sharedRoot: "", readLimitBytes: 0 }

describe("push parsing (ported)", () => {
  test("force flags and +refspec are refused", () => {
    expect(pushProblem("git push --force origin main", base)).toBe("a force-push")
    expect(pushProblem("git push --force-with-lease=abc origin main", base)).toBe("a force-push")
    expect(pushProblem("git push -f origin main", base)).toBe("a force-push")
    expect(pushProblem("git push origin +main", base)).toBe("a force-push (+refspec)")
  })
  test("protected branch targets are refused; feature branches are not", () => {
    expect(pushProblem("git push origin main", base)).toBe("a push to a protected branch")
    expect(pushProblem("git push origin refs/heads/master", base)).toBe("a push to a protected branch")
    expect(pushProblem("git push origin feat/x", base)).toBeUndefined()
    expect(pushProblem("git push --force origin feat/x", { ...base, forcePush: false })).toBeUndefined()
  })
})

describe("shared checkout git mutations (ported)", () => {
  const stat = async (p: string) => (p.endsWith("plain/.git") || p === "plain/.git" ? { isDirectory: true } : p.endsWith("worktree/.git") ? { isDirectory: false } : undefined)
  test("git -C into a plain checkout is caught; a worktree is not", async () => {
    expect(await sharedGitMutation(stat as any, "git -C plain commit -m x", base)).toMatch(/git commit in plain/)
    expect(await sharedGitMutation(stat as any, "git -C worktree commit -m x", base)).toBeUndefined()
    expect(await sharedGitMutation(stat as any, "git -C plain status", base)).toBeUndefined()
  })
})

describe("command guards (ported)", () => {
  test("kill by name", () => {
    expect(/taskkill \/IM node.exe/i.test("taskkill /IM node.exe")).toBe(true)
  })
})
```

Also port the option-parsing cases from the Claude plugin's own tests where practical (banned path matching):

```ts
import { fenceConfig } from "./fence"

test("banned paths normalize and build command regexes", () => {
  const cfg = fenceConfig({ banned_paths: ["C:\\Secrets"], guard_force_push: true })
  expect(cfg.bannedRoots).toEqual(["c:/secrets"])
  expect(cfg.bannedInCommand.length).toBe(1)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/fence.test.ts`
Expected: FAIL — cannot resolve `./fence`.

- [ ] **Step 3: Implement src/fence.ts**

Port from the source file, keeping every exported name above:

```ts
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { stat as statNode } from "node:fs/promises"
import { flag, list, norm, num, slashes } from "./shared"

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const normCommand = (c: string) => slashes(c).replace(/(^|[^a-z0-9])\/([a-z])\//gi, "$1$2:/").toLowerCase()

export const MUTATING_GIT = new Set(["add", "am", "apply", "checkout", "cherry-pick", "clean", "commit", "merge", "mv", "pull", "rebase", "reset", "restore", "revert", "rm", "stash", "switch"])
const NOT_TEXT = /\.(png|jpe?g|gif|webp|bmp|ico|pdf|ipynb)$/i
export const KILL_BY_NAME = /\bpkill\b|\bkillall\b|\btaskkill\b[^;&|\n]*\/+im\b|\bstop-process\b[^;&|\n]*-name\b/i
export const NO_VERIFY = /\bgit\b[^;&|\n]*\s--no-verify\b/

export type FenceConfig = {
  forcePush: boolean; protectedPush: boolean; protectedBranch: RegExp | undefined
  noVerify: boolean; killByName: boolean; bannedRoots: string[]; bannedInCommand: RegExp[]
  sharedCheckout: boolean; sharedRoot: string; readLimitBytes: number
}

export function fenceConfig(options: Record<string, unknown>): FenceConfig {
  const bannedRoots = list(options.banned_paths).map(norm).filter(Boolean)
  const branches = list(options.protected_branches).map(escapeRegex)
  const limit = num(options.read_limit_bytes, 0)
  return {
    forcePush: flag(options.guard_force_push, true),
    protectedPush: flag(options.guard_protected_branches, true),
    protectedBranch: branches.length ? new RegExp(`(^|:)(refs/heads/)?(${branches.join("|")})$`) : undefined,
    noVerify: flag(options.guard_no_verify, true),
    killByName: flag(options.guard_kill_by_name, true),
    bannedRoots,
    bannedInCommand: bannedRoots.map(root => new RegExp(`(^|[^a-z0-9_.-])${escapeRegex(root)}(?=[/'"\\s;&|)]|$)`)),
    sharedCheckout: flag(options.guard_shared_checkout, false),
    sharedRoot: norm(options.shared_checkout_root),
    readLimitBytes: limit > 0 ? limit : 0,
  }
}

export function pushProblem(command: string, cfg: FenceConfig): string | undefined {
  for (const m of command.matchAll(/\bgit\b(?:\s+-C\s+\S+)?\s+push\b([^;&|\n]*)/g)) {
    const words = m[1].trim().split(/\s+/).filter(Boolean)
    if (cfg.forcePush && words.some(w => /^(--force|--force-with-lease(=.*)?|--force-if-includes|-[a-zA-Z]*f[a-zA-Z]*)$/.test(w))) return "a force-push"
    const refspecs = words.filter(w => !w.startsWith("-")).slice(1)
    if (cfg.forcePush && refspecs.some(r => r.startsWith("+"))) return "a force-push (+refspec)"
    if (cfg.protectedPush && cfg.protectedBranch && refspecs.some(r => cfg.protectedBranch!.test(r))) return "a push to a protected branch"
  }
  return undefined
}

// stat(p) resolves { isDirectory } | undefined for p; injected so tests need no disk.
export type Stat = (p: string) => Promise<{ isDirectory: boolean } | undefined>

async function isSharedCheckout(stat: Stat, path: unknown, cfg: FenceConfig): Promise<boolean> {
  const n = norm(path)
  if (!/^([a-z]:)?\//.test(n)) return false
  if (cfg.sharedRoot && !n.startsWith(`${cfg.sharedRoot}/`)) return false
  let dir = slashes(String(path)).replace(/^\/([a-z])\//i, "$1:/").replace(/(.)\/$/, "$1")
  for (let i = 0; i < 40 && dir; i++) {
    const git = await stat(`${dir}/.git`)
    if (git) return git.isDirectory
    const up = dir.replace(/\/[^/]*$/, "")
    if (up === dir || !up || /^[a-z]:$/i.test(up)) break
    dir = up
  }
  return false
}

export async function sharedGitMutation(stat: Stat, command: string, cfg: FenceConfig): Promise<string | undefined> {
  const found = [
    ...[...command.matchAll(/\bgit\s+-C\s+["']?([^\s"']+)["']?\s+([a-z-]+)/g)].map(m => [m[1], m[2]]),
    ...[...command.matchAll(/\bcd\s+["']?([^\s"';&|]+)["']?\s*(?:&&|;)\s*git\s+([a-z-]+)/g)].map(m => [m[1], m[2]]),
  ]
  for (const [dir, verb] of found) {
    if (MUTATING_GIT.has(verb) && await isSharedCheckout(stat, `${dir}/`, cfg)) return `git ${verb} in ${dir}`
  }
  return undefined
}

const deny = (why: string) => { throw new Error(`subagent-fence: ${why}`) }

// Subagent check per the Task 1 spike findings: either client.session.get + parentID,
// or "every session except shared.currentSession()".
async function isSubagent(input: PluginInput, shared: { currentSession(): string | undefined }, sessionID: string): Promise<boolean> {
  try {
    const s = await input.client.session.get({ path: { id: sessionID } })
    return Boolean((s.data as any)?.parentID)
  } catch {
    return false // the fence failing never blocks the call
  }
}

export async function fence(input: PluginInput, options: Record<string, unknown>, shared: any): Promise<Partial<Hooks>> {
  const cfg = fenceConfig(options)
  const stat: Stat = async p => {
    try {
      const s = await statNode(p)
      return s?.isFile() ? { isDirectory: false } : s?.isDirectory() ? { isDirectory: true } : undefined
    } catch { return undefined }
  }
  return {
    "tool.execute.before": async (i, output) => {
      try {
        const args = output.args as Record<string, unknown>
        const command = i.tool === "bash" ? String(args.command ?? "") : ""
        const path = args.filePath ?? args.path
        const sub = await isSubagent(input, shared, i.sessionID)

        if (cfg.bannedRoots.length) {
          const n = norm(path)
          const hit = cfg.bannedRoots.some(root => n === root || n.startsWith(`${root}/`))
            || (command && cfg.bannedInCommand.some(re => re.test(normCommand(command))))
          if (hit) deny("that path is on the banned list (the banned_paths option). Never read, write or enter it.")
        }
        if (command) {
          const push = pushProblem(command, cfg)
          if (push) deny(`${push} is never allowed here. Push a feature branch and open a PR; never force-push.`)
          if (cfg.noVerify && NO_VERIFY.test(command)) deny("--no-verify bypasses the hooks, which is never allowed. Fix what the hook reports instead.")
          if (cfg.killByName && KILL_BY_NAME.test(command)) deny("killing processes by name can kill other sessions' processes. Kill by PID only.")
        }
        if (sub) {
          if (cfg.sharedCheckout && (i.tool === "edit" || i.tool === "write") && await isSharedCheckout(stat, path, cfg)) {
            deny(`${String(path)} is in a shared checkout. Edit only inside your own worktree; never the main checkout.`)
          }
          const mutation = command ? await sharedGitMutation(stat, command, cfg) : undefined
          if (mutation) deny(`${mutation} changes a shared checkout. Run git only inside your own worktree.`)          if (cfg.readLimitBytes > 0 && i.tool === "read" && args.limit === undefined && !NOT_TEXT.test(String(path ?? ""))) {
            const size = await statNode(String(path)).then(s => (s?.isFile() ? s.size : 0)).catch(() => 0)
            if (size > cfg.readLimitBytes) {
              deny(`${String(path)} is ${Math.round(size / 1000)} KB. Read it by offset and limit (150 lines or fewer): find the line with grep -n first, then read that window.`)
            }
          }
        }
      } catch (e) {
        if (String(e).startsWith("Error: subagent-fence:")) throw e // our refusal
        // the fence itself failing never blocks the call
      }
    },
  }
}
```

Note: the catch-and-rethrow pattern keeps refusals flowing while fence bugs never block a call (same contract as the Claude version's `.catch(($, e, next) => next(e))`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/fence.test.ts`
Expected: PASS.

- [ ] **Step 5: Register in plugin.ts**

```ts
import { fence } from "./src/fence"
const SUBPLUGINS: Record<string, SubPlugin> = { fence }
```

- [ ] **Step 6: Typecheck and full test run**

Run: `npx tsc --noEmit; npx vitest run`. Expected: clean, all green.

- [ ] **Step 7: Commit**

```powershell
git add plugin.ts src/fence.ts src/fence.test.ts
git commit -m "feat: port subagent-fence (force-push, protected branches, no-verify, kill-by-name, banned paths, shared checkout, read limit)"
```

---

### Task 4: Skill and command installer

**Files:**
- Create: `skills/query-plan-analysis/` (copied verbatim from claude-plugins), `src/install.ts`, `src/install.test.ts`
- Modify: `plugin.ts` (call the installer at init)

**Interfaces:**
- Consumes: `configRoot()` from shared
- Produces: `installAssets(): Promise<{ copied: number }>` (default export `installAssets`); copies `<pkg>/skills/*` → `~/.config/opencode/skills/` and `<pkg>/commands/*.md` → `~/.config/opencode/commands/`, skipping files whose content already matches

- [ ] **Step 1: Copy the skill in verbatim**

```powershell
New-Item -ItemType Directory -Force skills | Out-Null
Copy-Item -Recurse -Force "C:\Users\aa958\Documents\GitHub\claude-plugins\plugins\sqlserver-query-plans\skills\query-plan-analysis" skills/
```

Verify: `skills/query-plan-analysis/SKILL.md`, `skills/query-plan-analysis/scripts/extract.py`, and the 8 `references/*.md` files exist.

- [ ] **Step 2: Write the failing test**

`src/install.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { copyIfChanged } from "./install"

async function dir(files: Record<string, string>): Promise<string> {
  const root = await mkdir(path.join(tmpdir(), `install-${Math.random().toString(36).slice(2)}`), { recursive: true })
    .then(() => path.join(tmpdir(), `install-${Math.random().toString(36).slice(2)}`))
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), body)
  }
  return root
}

describe("copyIfChanged", () => {
  test("copies new files, skips identical, overwrites changed", async () => {
    const src = await dir({ "a/SKILL.md": "one", "sub/b.md": "two" })
    const dest = await dir({ "a/SKILL.md": "one" })
    const copied = await copyIfChanged(src, dest)
    expect(copied).toBe(1) // sub/b.md only
    const again = await copyIfChanged(src, dest)
    expect(again).toBe(0)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/install.test.ts` — expected: FAIL, no `./install`.

- [ ] **Step 4: Implement src/install.ts**

```ts
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { configRoot } from "./shared"

// Copies every file under srcDir into destDir, skipping files whose content already matches.
export async function copyIfChanged(srcDir: string, destDir: string): Promise<number> {
  let copied = 0
  async function walk(src: string, rel: string) {
    for (const entry of await readdir(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name)
      const r = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isDirectory()) { await walk(s, r); continue }
      const dest = path.join(destDir, r)
      const body = await readFile(s)
      const existing = await readFile(dest).catch(() => undefined)
      if (existing && Buffer.compare(existing, body) === 0) continue
      await mkdir(path.dirname(dest), { recursive: true })
      await writeFile(dest, body)
      copied++
    }
  }
  await walk(srcDir, "")
  return copied
}

const pkgRoot = path.resolve(import.meta.dir, "..")

export async function installAssets(): Promise<{ copied: number }> {
  const root = configRoot()
  let copied = 0
  copied += await copyIfChanged(path.join(pkgRoot, "skills"), path.join(root, "skills")).catch(() => 0)
  copied += await copyIfChanged(path.join(pkgRoot, "commands"), path.join(root, "commands")).catch(() => 0)
  return { copied }
}
```

- [ ] **Step 5: Run tests** — `npx vitest run src/install.test.ts`, expected PASS.

- [ ] **Step 6: Wire into plugin.ts and verify locally**

In `plugin.ts`, first line of the plugin function: `await installAssets().catch(() => undefined)`.

Verify the real target folder exists on this machine: `Test-Path ~\.config\opencode` — expected True (this is where opencode already reads global config; if False, stop and re-check `configRoot` against the customize-opencode docs).

- [ ] **Step 7: Commit**

```powershell
git add skills/ src/install.ts src/install.test.ts plugin.ts
git commit -m "feat: bundle query-plan-analysis skill; install skill and commands into opencode config folders"
```

---

### Task 5: Asks

**Files:**
- Create: `src/asks.ts`, `src/asks.test.ts`, `commands/asks.md`

**Interfaces:**
- Consumes: `Shared.currentSession`, `Shared.dataDir`, `tool` from `@opencode-ai/plugin`
- Produces: `asks: SubPlugin`; custom tools `ask_add(question, recommendation)`, `ask_resolve(id)`, `ask_list()`; registry files at `~/.config/opencode/darling-data/asks/<sessionID>.json`

- [ ] **Step 1: Write the failing test**

`src/asks.test.ts`:

```ts
import { describe, expect, test } from "vitest"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { addAsk, listAsks, resolveAsk } from "./asks"

const dir = () => mkdtemp(path.join(tmpdir(), "asks-"))
const NOW = Date.parse("2026-10-29T12:00:00Z")

describe("ask registry", () => {
  test("add, list, resolve", async () => {
    const d = await dir()
    const a = await addAsk(d, "Which database?", "staging", NOW)
    const b = await addAsk(d, "Ship Friday?", "yes", NOW + 1)
    expect((await listAsks(d)).map(x => x.id)).toEqual([a.id, b.id])
    expect(await resolveAsk(d, a.id, NOW + 2)).toBe(true)
    expect(await resolveAsk(d, a.id, NOW + 3)).toBe(false) // already resolved
    const open = await listAsks(d)
    expect(open.map(x => x.id)).toEqual([b.id])
  })
  test("a corrupt file yields an empty list, never a throw", async () => {
    const d = await dir()
    await writeFile(path.join(d, "s1.json"), "{not json")
    expect(await listAsks(path.join(d))).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run src/asks.test.ts`, FAIL.

- [ ] **Step 3: Implement src/asks.ts**

```ts
import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Shared } from "./shared"

export type Ask = { id: string; question: string; recommendation: string; at: number; resolved?: number }

async function readAll(dir: string): Promise<Record<string, Ask>> {
  return JSON.parse(await readFile(path.join(dir, "asks.json"), "utf8").catch(() => "{}")) as Record<string, Ask>
}
async function writeAll(dir: string, all: Record<string, Ask>) {
  await writeFile(path.join(dir, "asks.json"), `${JSON.stringify(all, null, 2)}\n`)
}

export async function addAsk(dir: string, question: string, recommendation: string, now: number): Promise<Ask> {
  const all = await readAll(dir)
  const id = Math.random().toString(36).slice(2, 8)
  all[id] = { id, question, recommendation, at: now }
  await writeAll(dir, all)
  return all[id]
}
export async function resolveAsk(dir: string, id: string, now: number): Promise<boolean> {
  const all = await readAll(dir)
  if (!all[id] || all[id].resolved) return false
  all[id].resolved = now
  await writeAll(dir, all)
  return true
}
export async function listAsks(dir: string): Promise<Ask[]> {
  const all = await readAll(dir)
  return Object.values(all).filter(a => !a.resolved).sort((a, b) => a.at - b.at)
}

export async function asks(_input: PluginInput, _options: Record<string, unknown>, shared: Shared): Promise<Partial<Hooks>> {
  return {
    tool: {
      ask_add: tool({
        description: "Record a question you are leaving for the user, with your recommended answer. Use whenever your reply asks the user something or leaves them a decision.",
        args: { question: tool.schema.string(), recommendation: tool.schema.string() },
        async execute(args) {
          const session = shared.currentSession() ?? "default"
          const dir = await shared.dataDir(`asks/${session}`)
          const ask = await addAsk(dir, args.question, args.recommendation, Date.now())
          await shared.toast(`Open ask: ${args.question.slice(0, 120)}`, "info")
          return `Recorded ask ${ask.id}. The user can answer it later with /asks.`
        },
      }),
      ask_resolve: tool({
        description: "Mark an open ask answered. Takes the ask id from ask_list.",
        args: { id: tool.schema.string() },
        async execute(args) {
          const session = shared.currentSession() ?? "default"
          const dir = await shared.dataDir(`asks/${session}`)
          return (await resolveAsk(dir, args.id, Date.now())) ? `Ask ${args.id} resolved.` : `No open ask ${args.id}.`
        },
      }),
      ask_list: tool({
        description: "List this session's open asks: id, question, recommended answer.",
        args: {},
        async execute() {
          const session = shared.currentSession() ?? "default"
          const dir = await shared.dataDir(`asks/${session}`)
          const open = await listAsks(dir)
          return open.length
            ? open.map(a => `${a.id}: ${a.question}\n  recommended: ${a.recommendation}`).join("\n")
            : "No open asks."
        },
      }),
    },
  }
}
```

(`ask_resolve` should also be called by the model when the user answers in chat; document that in the tool description if desired — same text as above is acceptable.)

- [ ] **Step 4: Write commands/asks.md**

```markdown
---
description: List the open asks this session is waiting on
---
Call the ask_list tool and show each open ask: id, question, and the recommended answer. Suggest answering by id.
```

- [ ] **Step 5: Run tests, register, commit**

`npx vitest run src/asks.test.ts` — PASS. Register `asks` in `plugin.ts` SUBPLUGINS. `npx tsc --noEmit; npx vitest run` — clean.

```powershell
git add src/asks.ts src/asks.test.ts commands/asks.md plugin.ts
git commit -m "feat: port open-asks as ask_add/ask_resolve/ask_list tools with /asks command"
```

---

### Task 6: Fleet

**Files:**
- Create: `src/fleet.ts`, `src/fleet.test.ts`, `commands/fleet.md`

**Interfaces:**
- Consumes: `Shared.currentSession`, `client.session.children({ path: { id } })`, `client.session.messages({ path: { id } })`
- Produces: `fleet: SubPlugin`; custom tool `subagent_vitals()`; `formatFleet(rows: FleetRow[]): string` (exported for tests) where `FleetRow = { id: string; title: string; cost: number; tokens: number; created: number; updated: number; running: boolean }`

- [ ] **Step 1: Write the failing test**

`src/fleet.test.ts`:

```ts
import { expect, test } from "vitest"
import { formatFleet } from "./fleet"

const NOW = Date.parse("2026-10-29T12:00:00Z")

test("formatFleet lists every child with cost, tokens and age", () => {
  const text = formatFleet([
    { id: "ses_abc123def456", title: "Explore repo", cost: 0.0123, tokens: 42000, created: NOW - 600000, updated: NOW - 60000, running: true },
    { id: "ses_xyz789", title: "Write tests", cost: 1, tokens: 900000, created: NOW - 7200000, updated: NOW - 300000, running: false },
  ], NOW)
  expect(text).toContain("ses_abc123de")       // short id
  expect(text).toContain("Explore repo")
  expect(text).toContain("$0.01")
  expect(text).toContain("42k tok")
  expect(text).toContain("running")
  expect(text).toContain("done")
  expect(text.indexOf("Explore repo")).toBeLessThan(text.indexOf("Write tests")) // newest first
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL, no `./fleet`.

- [ ] **Step 3: Implement src/fleet.ts**

```ts
import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import type { Shared } from "./shared"

export type FleetRow = { id: string; title: string; cost: number; tokens: number; created: number; updated: number; running: boolean }

export function formatFleet(rows: FleetRow[], now: number): string {
  const sorted = [...rows].sort((a, b) => b.updated - a.updated)
  if (sorted.length === 0) return "No subagent sessions."
  return sorted.map(r => {
    const age = Math.max(0, Math.round((now - r.created) / 60000))
    const status = r.running ? "running" : "done"
    return `${r.id.slice(0, 10)}  ${status}  ${age}m  ${Math.round(r.tokens / 1000)}k tok  $${r.cost.toFixed(2)}  ${r.title}`
  }).join("\n")
}

async function fleetRows(input: PluginInput, parentID: string): Promise<FleetRow[]> {
  const children = await input.client.session.children({ path: { id: parentID } }).then(r => r.data ?? []).catch(() => [])
  const rows: FleetRow[] = []
  for (const child of children as any[]) {
    const msgs = await input.client.session.messages({ path: { id: child.id } }).then(r => r.data ?? []).catch(() => [])
    let cost = 0, tokens = 0, updated = child.time?.updated ?? child.time?.created ?? 0
    for (const m of msgs as any[]) {
      const info = m.info ?? {}
      if (info.role === "assistant") {
        cost += Number(info.cost ?? 0)
        tokens += (info.tokens?.input ?? 0) + (info.tokens?.output ?? 0) + (info.tokens?.reasoning ?? 0)
          + (info.tokens?.cache?.read ?? 0) + (info.tokens?.cache?.write ?? 0)
        if (info.time?.completed) updated = Math.max(updated, info.time.completed)
      }
    }
    rows.push({ id: child.id, title: child.title ?? "(untitled)", cost, tokens, created: child.time?.created ?? 0, updated, running: child.running ?? false })
  }
  return rows
}

export async function fleet(input: PluginInput, _options: Record<string, unknown>, shared: Shared): Promise<Partial<Hooks>> {
  return {
    tool: {
      subagent_vitals: tool({
        description: "A cheap read of this session's subagents: id, status, age, context tokens and cost, so you can check progress without parsing output files.",
        args: {},
        async execute() {
          const parent = shared.currentSession()
          if (!parent) return "No current session."
          return formatFleet(await fleetRows(input, parent), Date.now())
        },
      }),
    },
  }
}
```

(If `session.children` results do not carry `running`, drop the column and derive `running` from `session.status` events; the test then expects `age`-based rows — keep `formatFleet` signature unchanged.)

- [ ] **Step 4: Write commands/fleet.md**

```markdown
---
description: Show every subagent of this session — status, age, context and cost
---
Call the subagent_vitals tool and present the result as a table. Include finished subagents; note the total cost.
```

- [ ] **Step 5: Run tests, register, commit**

`npx vitest run src/fleet.test.ts` — PASS. Register `fleet`. `npx tsc --noEmit; npx vitest run` — clean.

```powershell
git add src/fleet.ts src/fleet.test.ts commands/fleet.md plugin.ts
git commit -m "feat: port subagent-band as subagent_vitals tool with /fleet command"
```

---

### Task 7: Budget

**Files:**
- Create: `src/budget.ts`, `src/budget.test.ts`

**Interfaces:**
- Consumes: `Shared.toast`, `list`, `num`; state file `~/.config/opencode/darling-data/budget.json`
- Produces: `budget: SubPlugin`; exported pure functions (tested): `applyMessage`, `windowUsed`, `elapsedPercent`, `crossedLevel`, `paceOf`; file schema `{ at, windows: { fiveHour: { budget, used, percent, windowStart }, sevenDay: { ... } }, pace: { used, elapsed, ahead, until } | null }`
- Options: `budget5h`, `budget7d` (token amounts, `0` disables the window), `warnPercents` (default `70,85,95`), `tellModelAtPercent` (default 85), `spawnGatePercent` (default 95), `paceMargin` (default 10)

- [ ] **Step 1: Write the failing tests**

`src/budget.test.ts`:

```ts
import { expect, test } from "vitest"
import { applyMessage, crossedLevel, elapsedPercent, paceOf, windowUsed } from "./budget"

const H = 3600_000, NOW = Date.parse("2026-10-29T12:00:00Z")

test("streaming message updates count once (delta accumulation)", () => {
  let state = { last: {} as Record<string, number>, events: [] as Array<{ t: number; d: number }> }
  state = applyMessage(state, "m1", 100, NOW)[0]      // first sighting
  state = applyMessage(state, "m1", 250, NOW + 1000)[0] // +150
  state = applyMessage(state, "m1", 250, NOW + 2000)[0] // no change
  state = applyMessage(state, "m2", 40, NOW + 3000)[0]  // +40
  expect(windowUsed(state.events, NOW + 4000, 5 * H)).toBe(190)
})

test("windowUsed only sums events inside the window", () => {
  const events = [{ t: NOW - 6 * H, d: 1000 }, { t: NOW - H, d: 50 }]
  expect(windowUsed(events, NOW, 5 * H)).toBe(50)
  expect(windowUsed(events, NOW, 7 * 24 * H)).toBe(1050)
})

test("elapsedPercent measures the window's span", () => {
  const week = 7 * 24 * H
  expect(elapsedPercent(NOW - 0.3 * week, NOW, week)).toBeCloseTo(30, 5)
  expect(elapsedPercent(NOW - 2 * week, NOW, week)).toBe(100) // capped
})

test("crossedLevel returns the highest threshold met", () => {
  expect(crossedLevel(69, [70, 85, 95])).toBe(0)
  expect(crossedLevel(85, [70, 85, 95])).toBe(85)
  expect(crossedLevel(97, [70, 85, 95])).toBe(95)
})

test("paceOf flags spend ahead of the window's elapsed share", () => {
  const week = 7 * 24 * H
  const pace = paceOf(75, NOW - 0.6 * week, NOW, week, 10)!
  expect(pace).not.toBeNull()
  expect(pace.elapsed).toBeCloseTo(60, 5)
  expect(pace.ahead).toBeCloseTo(15, 5)
  expect(paceOf(65, NOW - 0.6 * week, NOW, week, 10)).toBeNull()
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL, no `./budget`.

- [ ] **Step 3: Implement src/budget.ts**

```ts
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { list, num } from "./shared"
import type { Shared } from "./shared"

export type UsageEvent = { t: number; d: number }
export type BudgetState = { last: Record<string, number>; events: UsageEvent[] }

// The message's tokens are a running total; keep the latest per message id and emit deltas.
export function applyMessage(state: BudgetState, messageID: string, tokens: number, now: number): [BudgetState, number] {
  const prior = state.last[messageID]
  const delta = prior === undefined ? tokens : tokens - prior
  const next: BudgetState = {
    last: { ...state.last, [messageID]: tokens },
    events: delta > 0 ? [...state.events, { t: now, d: delta }] : state.events,
  }
  return [next, Math.max(0, delta)]
}

export const windowUsed = (events: UsageEvent[], now: number, windowMs: number): number =>
  events.filter(e => now - e.t < windowMs).reduce((s, e) => s + e.d, 0)

export const windowStart = (events: UsageEvent[], now: number, windowMs: number): number =>
  events.filter(e => now - e.t < windowMs).reduce((min, e) => Math.min(min, e.t), now - windowMs)

export function elapsedPercent(windowStartMs: number, now: number, windowMs: number): number {
  return Math.min(100, Math.max(0, (100 * (now - windowStartMs)) / windowMs))
}

export const crossedLevel = (percent: number, thresholds: number[]): number =>
  thresholds.filter(t => percent >= t).reduce((m, t) => Math.max(m, t), 0)

export function paceOf(usedPercent: number, windowStartMs: number, now: number, windowMs: number, margin: number) {
  const elapsed = elapsedPercent(windowStartMs, now, windowMs)
  const ahead = usedPercent - elapsed
  if (margin <= 0 || ahead < margin - 1e-9) return null
  const liftsAt = windowStartMs + ((usedPercent - margin) / 100) * windowMs
  const until = new Date(Math.ceil(liftsAt / 60000 - 1e-6) * 60000).toISOString()
  return { used: usedPercent, elapsed, ahead, until }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000, FIVE_H_MS = 5 * 60 * 60 * 1000

type FileShape = {
  at: string
  windows: { fiveHour: Window; sevenDay: Window }
  pace: { used: number; elapsed: number; ahead: number; until: string } | null
  warned: Record<string, number>
}
type Window = { budget: number; used: number; percent: number; windowStart: number }

export async function budget(input: PluginInput, options: Record<string, unknown>, shared: Shared): Promise<Partial<Hooks>> {
  const budget5h = Math.max(0, num(options.budget5h, 0))
  const budget7d = Math.max(0, num(options.budget7d, 0))
  const thresholds = (() => {
    const parsed = list(options.warnPercents).map(Number).filter(n => Number.isFinite(n) && n > 0 && n <= 100)
    return parsed.length ? parsed : [70, 85, 95]
  })()
  const tellAt = num(options.tellModelAtPercent, 85)
  const gate = num(options.spawnGatePercent, 95)
  const paceMargin = num(options.paceMargin, 10)

  const file = path.join(await shared.dataDir(""), "budget.json")
  let state: BudgetState = { last: {}, events: [] }
  let warned: Record<string, number> = {}

  async function load() {
    try {
      const saved = JSON.parse(await readFile(file, "utf8")) as any
      state = { last: {}, events: saved.events ?? [] } // `last` is per-process; deltas already applied
      warned = saved.warned ?? {}
    } catch { /* first run */ }
  }
  async function save(now: number) {
    const body: FileShape = {
      at: new Date(now).toISOString(),
      windows: {
        fiveHour: { budget: budget5h, used: windowUsed(state.events, now, FIVE_H_MS), percent: 0, windowStart: windowStart(state.events, now, FIVE_H_MS) },
        sevenDay: { budget: budget7d, used: windowUsed(state.events, now, WEEK_MS), percent: 0, windowStart: windowStart(state.events, now, WEEK_MS) },
      },
      pace: null,
      warned,
    }
    for (const w of [body.windows.fiveHour, body.windows.sevenDay]) w.percent = w.budget > 0 ? (100 * w.used) / w.budget : 0
    body.pace = budget7d > 0 && paceMargin > 0 ? paceOf(body.windows.sevenDay.percent, body.windows.sevenDay.windowStart, now, WEEK_MS, paceMargin) : null
    await writeFile(file, `${JSON.stringify(body, null, 2)}\n`)
    return body
  }

  await load()

  async function measure(now = Date.now()) {
    const body = await save(now)
    for (const [key, w] of Object.entries({ five_hour: body.windows.fiveHour, seven_day: body.windows.sevenDay })) {
      if (w.budget <= 0) continue
      const level = crossedLevel(w.percent, thresholds)
      if (level > (warned[key] ?? 0)) {
        warned[key] = level
        await shared.toast(`Usage: the ${key === "five_hour" ? "5-hour" : "7-day"} token window is at ${Math.round(w.percent)}% of budget`, "warning")
      }
    }
    if (body.pace) {
      const level = Math.floor((body.pace.ahead + 1e-9) / paceMargin)
      if (level > (warned.seven_day_pace ?? 0)) {
        warned.seven_day_pace = level
        await shared.toast(`Usage: 7-day spend is ${Math.round(body.pace.ahead)} points ahead of pace; subagents refused until ${body.pace.until} if spend stays flat`, "warning")
      }
    }
    await save(now)
  }

  return {
    event: async ({ event }) => {
      if (event.type === "message.updated" && event.properties.info?.role === "assistant" && event.properties.info?.tokens) {
        const info = event.properties.info
        const tokens = (info.tokens.input ?? 0) + (info.tokens.output ?? 0) + (info.tokens.reasoning ?? 0)
          + (info.tokens.cache?.read ?? 0) + (info.tokens.cache?.write ?? 0)
        const [next] = applyMessage(state, info.id, tokens, Date.now())
        state = next
        if (budget5h > 0 || budget7d > 0) await measure().catch(() => undefined)
      }
    },
    "experimental.chat.system.transform": async (i, output) => {
      if (tellAt <= 0) return
      const saved = JSON.parse(await readFile(file, "utf8").catch(() => "null")) as FileShape | null
      if (!saved) return
      const over = Object.values(saved.windows).find(w => w.budget > 0 && w.percent >= tellAt)
      if (over) {
        output.system.push(
          `usage-budget: token spend is at ${Math.round(over.percent)}% of the ${over === saved.windows.fiveHour ? "5-hour" : "7-day"} budget. ` +
          "Start no new optional work, finish what is in flight, keep the handoff current, and tell the user.")
      }
    },
    "tool.execute.before": async (i) => {
      if (gate <= 0 || i.tool !== "task") return
      const saved = JSON.parse(await readFile(file, "utf8").catch(() => "null")) as FileShape | null
      if (!saved) return
      const over = Object.values(saved.windows).find(w => w.budget > 0 && w.percent >= gate)
      if (over) {
        throw new Error(
          `usage-budget: the ${over === saved.windows.fiveHour ? "5-hour" : "7-day"} token window is at ${Math.round(over.percent)}% of budget, ` +
          `at or past the ${gate}% limit for new subagents. Spawn none; finish the work in hand, write the handoff, and tell the user.`)
      }
    },
  }
}
```

- [ ] **Step 4: Run tests** — `npx vitest run src/budget.test.ts` PASS; `npx tsc --noEmit` clean.

- [ ] **Step 5: Register and commit**

```powershell
git add src/budget.ts src/budget.test.ts plugin.ts
git commit -m "feat: port usage-budget as token budgets with delta accumulation, toasts, model note and spawn gate"
```

---

### Task 8: Resume

**Files:**
- Create: `src/resume.ts`, `src/resume.test.ts`, `scripts/resume-sessions.ps1`, `commands/resume-sessions.md`
- Port source: `C:\Users\aa958\Documents\GitHub\claude-plugins\plugins\seat-resume\scripts\resume-sessions.ps1` (read it in full first)

**Interfaces:**
- Consumes: `Shared.dataDir`; registry at `~/.config/opencode/darling-data/sessions-registry/<sessionID>.json`
- Produces: `resume: SubPlugin`; exported pure `interrupted(entries: Entry[], now: number, maxAgeHours?: number, staleMinutes?: number): Entry[]` where `Entry = { sessionId: string; directory: string; title: string; startedAt: string; lastActive: string; ended: string }`; custom tool `resume_sessions()` that runs the ps1; heartbeat interval cleared in `dispose`

- [ ] **Step 1: Write the failing test**

`src/resume.test.ts`:

```ts
import { expect, test } from "vitest"
import { interrupted, type Entry } from "./resume"

const NOW = Date.parse("2026-10-29T12:00:00Z")
const e = (over: Partial<Entry>): Entry => ({
  sessionId: "s1", directory: "C:/Work/app", title: "demo", startedAt: "2026-10-29T10:00:00.000Z",
  lastActive: new Date(NOW - 7200_000).toISOString(), ended: "", ...over,
})

test("interrupted = no ended marker, stale heartbeat, within max age", () => {
  const entries = [
    e({ sessionId: "dead" }),                                                   // stale, interrupted
    e({ sessionId: "alive", lastActive: new Date(NOW - 60_000).toISOString() }), // heartbeat fresh
    e({ sessionId: "exited", ended: "exited" }),                                // clean exit
    e({ sessionId: "old", lastActive: new Date(NOW - 100 * 3600_000).toISOString() }), // beyond 72h
  ]
  expect(interrupted(entries, NOW).map(x => x.sessionId)).toEqual(["dead"])
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL, no `./resume`.

- [ ] **Step 3: Implement src/resume.ts**

```ts
import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Shared } from "./shared"

export type Entry = { sessionId: string; directory: string; title: string; startedAt: string; lastActive: string; ended: string }

export function interrupted(entries: Entry[], now: number, maxAgeHours = 72, staleMinutes = 10): Entry[] {
  return entries.filter(e =>
    !e.ended &&
    Date.parse(e.lastActive) <= now - staleMinutes * 60_000 &&
    Date.parse(e.lastActive) >= now - maxAgeHours * 3600_000)
}

export async function resume(input: PluginInput, options: Record<string, unknown>, shared: Shared): Promise<Partial<Hooks>> {
  const registry = await shared.dataDir("sessions-registry")
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let entry: Entry | null = null

  const save = async (next: Entry) => {
    entry = next
    await writeFile(path.join(registry, `${next.sessionId}.json`), `${JSON.stringify(next, null, 2)}\n`).catch(() => undefined)
  }
  const current = async (info: { id: string; directory: string; title?: string }): Promise<Entry> => {
    const saved = await readFile(path.join(registry, `${info.id}.json`), "utf8")
      .then(b => JSON.parse(b) as Entry).catch(() => null)
    const now = new Date().toISOString()
    return { sessionId: info.id, directory: info.directory, title: saved?.title ?? info.title ?? "", startedAt: saved?.startedAt ?? now, lastActive: now, ended: "" }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created" && !event.properties.info.parentID) {
        await save(await current(event.properties.info))
        clearInterval(heartbeat) // one heartbeat per main session in this process
        heartbeat = setInterval(() => {
          if (entry) save({ ...entry, lastActive: new Date().toISOString() }).catch(() => undefined)
        }, 60_000)
      }
      if (event.type === "session.deleted" && entry && event.properties.info.id === entry.sessionId) {
        await save({ ...entry, ended: "exited", lastActive: new Date().toISOString() })
      }
    },
    tool: {
      resume_sessions: tool({
        description: "List the interactive opencode sessions that died or were interrupted in the last 72 hours, with the command that reopens each. Add -Launch to reopen them all as terminal tabs.",
        args: { launch: tool.schema.boolean().optional() },
        async execute(args) {
          const ps = String(options.powershell ?? "pwsh")
          const script = path.resolve(import.meta.dir, "../scripts/resume-sessions.ps1")
          const argv = [ps, "-NoProfile", "-File", script, "-Registry", registry]
          if (args.launch) argv.push("-Launch")
          if (options.terminal && options.terminal !== "wezterm") argv.push("-Terminal", String(options.terminal))
          const { execFileSync } = await import("node:child_process")
          try {
            const out = execFileSync(argv[0], argv.slice(1), { cwd: registry, encoding: "utf8", timeout: 30_000, windowsHide: true })
            return out.trim() || "The resume script printed nothing."
          } catch (e: any) {
            return `${String(e.stdout ?? "")}${String(e.stderr ?? "")}`.trim() || `The resume script failed: ${e.message}`
          }
        },
      }),
    },
    dispose: async () => { clearInterval(heartbeat) },
  }
}
```

(`execFileSync` from `node:child_process` runs under both Bun and Node, so the module typechecks without bun-types and vitest can import it safely.)

- [ ] **Step 4: Run tests** — `npx vitest run src/resume.test.ts` PASS.

- [ ] **Step 5: Port scripts/resume-sessions.ps1**

Copy the source ps1, then apply exactly these changes (everything else stays):
1. Header comment: Claude Code → opencode; registry is written by the opencode plugin.
2. `$Sessions` parameter and the whole `$live` pid-file block: **delete** — liveness is the heartbeat (an entry with a fresh `lastActive` is alive).
3. Default `$Registry`: `Join-Path $env:USERPROFILE '.config\opencode\darling-data\sessions-registry'`.
4. In the registry loop, replace the `$live.ContainsKey(...)` skip with: `if ([DateTime]($e.lastActive) -gt $now.AddMinutes(-10)) { continue }` (parse `lastActive` the same way the source parses `lastActive` — keep its `[DateTime]::Parse` handling).
5. `Get-ResumeArgs`: replace the `claude --resume ... --permission-mode` body with `@('--session', [string]$e.sessionId)` and note in the comment that the tab must start in the entry's directory.
6. In the `-Launch` branch, start the tab process with `-WorkingDirectory $e.directory` (the source already opens tabs; point the command at `opencode` resolved via `(Get-Command opencode ...)` instead of `claude`).
7. Drop the `permissionMode` references in the list output.

- [ ] **Step 6: Write commands/resume-sessions.md**

```markdown
---
description: List the interactive sessions interrupted in the last 72 hours
---
Call the resume_sessions tool and show the output: each interrupted session, its directory, and when it was last active. Offer to pass launch=true to reopen them all as terminal tabs.
```

- [ ] **Step 7: Register and commit**

Register `resume` in `plugin.ts`. `npx tsc --noEmit; npx vitest run` — clean.

```powershell
git add src/resume.ts src/resume.test.ts scripts/resume-sessions.ps1 commands/resume-sessions.md plugin.ts
git commit -m "feat: port seat-resume with heartbeat liveness and resume_sessions tool"
```

---

### Task 9: Wall

**Files:**
- Create: `src/wall.ts`, `src/wall.test.ts`
- Port sources: `subagent-wall/hooks/register.ts` (Claude) and `pi-subagent-guardrails/subagent-extensions/context-wall.ts` (pi, the closer model — read both)

**Interfaces:**
- Consumes: spike-1 subagent identity (same helper pattern as fence), `client.session.get`
- Produces: `wall: SubPlugin`; exported pure functions: `gateMessage(tracked, now, limitMs, tool, args): string | undefined`, `warnMessage(tracked, now, warnMs, limitMs): string | undefined`, `nudgeMessage(tracked, nudgeTokens): string | undefined`, with `Tracked = { id: string; startedAt: number; edits: number; context: number; warned: boolean; nudged: boolean }`
- Options: `warnMinutes` (45), `limitMinutes` (60), `noEditNudgeK` (100)

- [ ] **Step 1: Write the failing tests**

`src/wall.test.ts`:

```ts
import { expect, test } from "vitest"
import { gateMessage, nudgeMessage, warnMessage, type Tracked } from "./wall"

const NOW = Date.parse("2026-10-29T12:00:00Z")
const tracked = (over: Partial<Tracked> = {}): Tracked => ({ id: "sub1", startedAt: NOW - 50 * 60_000, edits: 0, context: 0, warned: false, nudged: false, ...over })
const LIMIT = 60 * 60_000, WARN = 45 * 60_000

test("past the limit only git/gh and .md/.txt writes pass", () => {
  const t = tracked({ startedAt: NOW - 61 * 60_000 })
  expect(gateMessage(t, NOW, LIMIT, "bash", { command: "git commit -m x" })).toBeUndefined()
  expect(gateMessage(t, NOW, LIMIT, "bash", { command: "gh pr view" })).toBeUndefined()
  expect(gateMessage(t, NOW, LIMIT, "edit", { filePath: "C:/w/report.md" })).toBeUndefined()
  expect(gateMessage(t, NOW, LIMIT, "bash", { command: "npm test" })).toMatch(/subagent-wall: 60 minutes/)
  expect(gateMessage(t, NOW, LIMIT, "edit", { filePath: "C:/w/src/app.ts" })).toMatch(/subagent-wall/)
})

test("warn fires once, after warnMinutes", () => {
  const fresh = tracked({ startedAt: NOW - 46 * 60_000 })
  expect(warnMessage(fresh, NOW, WARN, LIMIT)).toMatch(/finish the one in hand/)
  const warned = { ...fresh, warned: true }
  expect(warnMessage(warned, NOW, WARN, LIMIT)).toBeUndefined()
})

test("no-edit nudge fires once at the context threshold", () => {
  const t = tracked({ context: 150_000, edits: 0 })
  expect(nudgeMessage(t, 100)).toMatch(/no file edited yet/)
  expect(nudgeMessage({ ...t, edits: 1 }, 100)).toBeUndefined()
  expect(nudgeMessage({ ...t, nudged: true }, 100)).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify it fails** — FAIL, no `./wall`.

- [ ] **Step 3: Implement src/wall.ts**

```ts
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { num } from "./shared"
import type { Shared } from "./shared"

const GIT_GH = /^(git|gh)(\s|$)/
const isNote = (p: unknown) => /\.(md|txt)$/.test(String(p ?? "").trim().toLowerCase())

export type Tracked = { id: string; startedAt: number; edits: number; context: number; warned: boolean; nudged: boolean }

export function gateMessage(t: Tracked, now: number, limitMs: number, tool: string, args: Record<string, unknown>): string | undefined {
  if (limitMs <= 0 || now - t.startedAt < limitMs) return undefined
  const allowed =
    tool === "bash" ? GIT_GH.test(String(args.command ?? "").trim())
    : tool === "edit" || tool === "write" ? isNote(args.filePath)
    : false
  if (allowed) return undefined
  return `subagent-wall: ${Math.floor((now - t.startedAt) / 60000)} minutes, at or past the ${limitMs / 60000}-minute limit. ` +
    "From here only git/gh commands and .md/.txt writes are allowed. Commit, push, put your report in the PR body or your final message, and end your turn."
}

export function warnMessage(t: Tracked, now: number, warnMs: number, limitMs: number): string | undefined {
  if (warnMs <= 0 || t.warned || now - t.startedAt < warnMs) return undefined
  return `subagent-wall: ${Math.floor((now - t.startedAt) / 60000)} minutes in. At ${limitMs / 60000} minutes only git, gh and .md/.txt writes will be allowed. Start no new item: finish the one in hand, commit, push, and report.`
}

export function nudgeMessage(t: Tracked, nudgeTokens: number): string | undefined {
  if (nudgeTokens <= 0 || t.nudged || t.edits > 0 || t.context < nudgeTokens) return undefined
  return `subagent-wall: about ${Math.round(t.context / 1000)}k tokens of context and no file edited yet. Stop exploring: make the change now from what you know, or report what blocks you.`
}

export async function wall(input: PluginInput, options: Record<string, unknown>, shared: Shared): Promise<Partial<Hooks>> {
  const warnMs = num(options.warnMinutes, 45) * 60_000
  const limitMs = num(options.limitMinutes, 60) * 60_000
  const nudgeTokens = num(options.noEditNudgeK, 100) * 1000
  const tracked = new Map<string, Tracked>()

  // Subagent identity per spike findings (same helper as fence).
  const isSub = async (sessionID: string) => {
    if (sessionID === shared.currentSession()) return false
    try {
      const s = await input.client.session.get({ path: { id: sessionID } })
      return Boolean((s.data as any)?.parentID)
    } catch { return false }
  }

  return {
    event: async ({ event }) => {
      if (event.type === "session.created" && event.properties.info.parentID) {
        tracked.set(event.properties.info.id, { id: event.properties.info.id, startedAt: event.properties.info.time?.created ?? Date.now(), edits: 0, context: 0, warned: false, nudged: false })
      }
      if (event.type === "message.updated" && event.properties.info?.role === "assistant") {
        const t = tracked.get(event.properties.info.sessionID)
        if (t) {
          const tk = event.properties.info.tokens
          t.context = Math.max(t.context, (tk?.input ?? 0) + (tk?.output ?? 0) + (tk?.reasoning ?? 0) + (tk?.cache?.read ?? 0) + (tk?.cache?.write ?? 0))
        }
      }
    },
    "tool.execute.before": async (i, output) => {
      const t = tracked.get(i.sessionID)
      if (!t) return
      const refusal = gateMessage(t, Date.now(), limitMs, i.tool, output.args ?? {})
      if (refusal) throw new Error(refusal)
    },
    "tool.execute.after": async (i) => {
      const t = tracked.get(i.sessionID)
      if (t && (i.tool === "edit" || i.tool === "write")) t.edits++
    },
    "experimental.chat.system.transform": async (i, output) => {
      const id = (i as any).sessionID
      const t = id ? tracked.get(id) : undefined
      if (!t) return
      const now = Date.now()
      const warn = warnMessage(t, now, warnMs, limitMs)
      if (warn) { t.warned = true; output.system.push(warn) }
      const nudge = nudgeMessage(t, nudgeTokens)
      if (nudge) { t.nudged = true; output.system.push(nudge) }
    },
  }
}
```

(`tool.execute.before` is `(input, output)` — the tool arguments come from `output.args`, as wired above. The gate only runs for tracked subagent sessions, which `tracked.get` already ensures; the main session is never in the map.)

- [ ] **Step 4: Run tests, register, commit**

`npx vitest run src/wall.test.ts` PASS. Register `wall`. `npx tsc --noEmit; npx vitest run` — clean.

```powershell
git add src/wall.ts src/wall.test.ts plugin.ts
git commit -m "feat: port subagent-wall (time limit gate, finish-up warning, no-edit nudge)"
```

---

### Task 10: README, LICENSE, options docs

**Files:**
- Create: `README.md`, `LICENSE`
- Modify: none

**Interfaces:**
- Consumes: all sub-plugin option names from Tasks 3-9
- Produces: user-facing install and options documentation

- [ ] **Step 1: Copy LICENSE** — copy `C:\Users\aa958\Documents\GitHub\claude-plugins\LICENSE` (MIT, Darling Data) verbatim.

- [ ] **Step 2: Write README.md**

Structure (match the claude-plugins README's tone — plain, specific, option tables):
1. Title + one-paragraph description + install block:
   ```json
   { "$schema": "https://opencode.ai/config.json", "plugin": ["opencode-darling-data"] }
   ```
   plus the options tuple example from spec §5 (disabled, fence, wall) and the options-file fallback from the spike-0 finding.
2. One section per sub-plugin, each with: what it refuses/does (one paragraph, ported from the claude-plugins README wording), and an option table (name / default / what it does) with the exact option names from Tasks 3-9.
3. `query-plan-analysis` section: point at a `.sqlplan` and ask; note the second-launch behavior on a fresh install and that the skill folder is copied to `~/.config/opencode/skills/`.
4. "Not ported" section: model-allowlist (with the spec §6.8 reason, one sentence), pi plugins with their equivalents here.
5. Windows note for resume; MIT license footer.

- [ ] **Step 3: Commit**

```powershell
git add README.md LICENSE
git commit -m "docs: README with install, options and not-ported notes"
```

---

### Task 11: Smoke test and publish prep

**Files:**
- Create: `.opencode/opencode.json` in a scratch directory (NOT committed)

**Interfaces:**
- Consumes: everything
- Produces: a verified package ready for `npm publish` (publishing itself is the user's call)

- [ ] **Step 1: Full check**

Run: `npx vitest run; npx tsc --noEmit`. Expected: all green, no errors.

- [ ] **Step 2: Smoke test against a real opencode**

```powershell
$scratch = Join-Path $env:TEMP "darling-smoke"
New-Item -ItemType Directory -Force $scratch | Out-Null
Set-Content (Join-Path $scratch "opencode.json") '{ "plugin": ["C:/Users/aa958/Documents/GitHub/opencode-plugins/plugin.ts"] }'
```

Run `opencode` inside `$scratch` and check, in order:
1. It starts without a plugin error (config loads).
2. `~/.config/opencode/skills/query-plan-analysis/SKILL.md` now exists (installer ran).
3. Prompt: `try to run a force push` → fence refuses with the force-push message.
4. Prompt: `ask me whether we should use staging or production` then `/asks` → the ask is listed.
5. Prompt: `spawn a subagent to explore this directory` then `/fleet` → the subagent appears with cost.
6. `Test-Path ~\.config\opencode\darling-data\sessions-registry` → True (heartbeat registered this session).

- [ ] **Step 3: Pack check**

Run: `npm pack --dry-run`. Expected: tarball contains `plugin.ts`, `src/`, `skills/`, `commands/`, `scripts/`, `README.md`, `LICENSE`, `package.json` — and nothing else (no tests, no `.opencode`).

- [ ] **Step 4: Clean up and commit (if anything changed)**

Remove the scratch dir. If the smoke test forced fixes, commit them:

```powershell
Remove-Item -Recurse -Force (Join-Path $env:TEMP "darling-smoke") -ErrorAction SilentlyContinue
git status --short   # commit any fixups: "fix: smoke test fixups"
```

Do NOT run `npm publish` — that is the user's decision.

---

## Spike Findings

(Record Task 1 results here before deleting the spike files)

- Spike 0 (options reach the plugin): _pending_
- Spike 1 (subagent identity via parentID): _pending_

## Self-Review Notes

- Spec coverage: fence §6.1 → Task 3; wall §6.2 → Task 9; asks §6.3 → Task 5; fleet §6.4 → Task 6; budget §6.5 → Task 7; resume §6.6 → Task 8; skill §6.7 → Tasks 1 (spike), 4; not-ported §6.8 → Task 10 README; install UX §5 → Tasks 2, 10; testing §8 → every task; spikes §7 → Task 1.
- The two `isSubagent` helpers (fence, wall) intentionally duplicate the spike-1-dependent lookup; if the findings match, hoist one `isSubagent(input, shared, sessionID)` into `src/shared.ts` during Task 9 and reuse it from fence.
- Sub-plugin option namespaces: `fence`, `wall`, `asks`, `fleet`, `budget`, `resume` — the `disabled` list uses the same names.
