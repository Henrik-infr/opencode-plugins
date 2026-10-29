import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Shared } from "./shared"

export type Ask = { id: string; question: string; recommendation: string; at: number; resolved?: number }

async function readAll(dir: string): Promise<Record<string, Ask>> {
  try {
    return JSON.parse(await readFile(path.join(dir, "asks.json"), "utf8")) as Record<string, Ask>
  } catch {
    return {} // missing or corrupt file: start from empty, never throw
  }
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
        description: "Mark an open ask answered. Takes the ask id from ask_list. Also call it when the user answers the ask in chat.",
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
