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

export function resolveWhere(options: Record<string, unknown>, defaults: { registry: string; script: string }): {
  registry: string; script: string; powershell: string; terminal: string
} {
  const text = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim() : fallback)
  return {
    registry: text(options.registry_dir, defaults.registry),
    script: text(options.resume_script, defaults.script),
    powershell: text(options.powershell, "pwsh"),
    terminal: text(options.terminal, "wezterm"),
  }
}

export async function resume(input: PluginInput, options: Record<string, unknown>, shared: Shared): Promise<Partial<Hooks>> {
  const where = resolveWhere(options, {
    registry: await shared.dataDir("sessions-registry"),
    script: path.resolve(import.meta.dirname, "../scripts/resume-sessions.ps1"),
  })
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let entry: Entry | null = null

  const save = async (next: Entry) => {
    entry = next
    await writeFile(path.join(where.registry, `${next.sessionId}.json`), `${JSON.stringify(next, null, 2)}\n`).catch(() => undefined)
  }
  const current = async (info: { id: string; directory: string; title?: string }): Promise<Entry> => {
    const saved = await readFile(path.join(where.registry, `${info.id}.json`), "utf8")
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
          const argv = [where.powershell, "-NoProfile", "-File", where.script, "-Registry", where.registry]
          if (args.launch) argv.push("-Launch")
          if (where.terminal !== "wezterm") argv.push("-Terminal", where.terminal)
          const { execFileSync } = await import("node:child_process")
          try {
            const out = execFileSync(argv[0], argv.slice(1), { cwd: where.registry, encoding: "utf8", timeout: 30_000, windowsHide: true })
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
