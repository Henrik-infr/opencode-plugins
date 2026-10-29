import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { mkdir } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Paths compare in one form: forward slashes, no doubled slashes, lower case, /c/... as c:/...
export const slashes = (p: string) => p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/\/+$/, "")
export const norm = (p: unknown) => slashes(String(p ?? "")).replace(/^\/([a-z])\//i, "$1:/").replace(/(.)\/$/, "$1").toLowerCase()

export const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [])
    .map(s => String(s).trim()).filter(Boolean)
export const flag = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback)
export const num = (v: unknown, fallback: number) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim() || NaN)
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
  const chains: Record<string, Array<unknown>> = {}
  for (const part of parts) {
    for (const key of Object.keys(part) as Array<string>) {
      if (key === "tool") {
        Object.assign(out.tool as object, (part as any).tool)
      } else if (FUNCTION_KEYS.includes(key as keyof Hooks)) {
        const fns = chains[key] ?? (chains[key] = [])
        fns.push((part as any)[key])
        out[key] = fns.length === 1 ? fns[0] : async (...a: unknown[]) => {
          for (const fn of fns) await (fn as any)(...a)
        }
      }
    }
  }
  return out as Hooks
}

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
