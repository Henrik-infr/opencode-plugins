import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { stat as statNode } from "node:fs/promises"
import { flag, isSubagent, list, norm, num, slashes } from "./shared"

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
  const branches = list(options.protected_branches ?? ["main", "master", "dev"]).map(escapeRegex)
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

// Relative paths resolve against the opencode process working directory, so detection is exact only for project-local paths.
async function isSharedCheckout(stat: Stat, path: unknown, cfg: FenceConfig): Promise<boolean> {
  const n = norm(path)
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
          if (cfg.sharedCheckout) {
            const mutation = command ? await sharedGitMutation(stat, command, cfg) : undefined
            if (mutation) deny(`${mutation} changes a shared checkout. Run git only inside your own worktree.`)
          }
          if (cfg.readLimitBytes > 0 && i.tool === "read" && args.limit === undefined && !NOT_TEXT.test(String(path ?? ""))) {
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
