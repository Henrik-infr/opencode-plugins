import { tool, type Hooks, type PluginInput } from "@opencode-ai/plugin"
import type { Shared } from "./shared"

export type FleetRow = { id: string; title: string; cost: number; tokens: number; created: number; updated: number; running: boolean }

export function formatFleet(rows: FleetRow[], now: number): string {
  const sorted = [...rows].sort((a, b) => b.updated - a.updated)
  if (sorted.length === 0) return "No subagent sessions."
  return sorted.map(r => {
    const age = Math.max(0, Math.round((now - r.created) / 60000))
    const status = r.running ? "running" : "done"
    return `${r.id.slice(0, 12)}  ${status}  ${age}m  ${Math.round(r.tokens / 1000)}k tok  $${r.cost.toFixed(2)}  ${r.title}`
  }).join("\n")
}

async function fleetRows(input: PluginInput, parentID: string, running: ReadonlySet<string>): Promise<FleetRow[]> {
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
    rows.push({ id: child.id, title: child.title ?? "(untitled)", cost, tokens, created: child.time?.created ?? 0, updated, running: running.has(child.id) })
  }
  return rows
}

export async function fleet(input: PluginInput, _options: Record<string, unknown>, shared: Shared): Promise<Partial<Hooks>> {
  // ponytail: the SDK Session carries no `running` — tracked from session.status events instead; a child busy before plugin load reads "done" until its next event.
  const running = new Set<string>()
  return {
    event: async ({ event }) => {
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties
        if (status.type === "idle") running.delete(sessionID)
        else running.add(sessionID)
      }
    },
    tool: {
      subagent_vitals: tool({
        description: "A cheap read of this session's subagents: id, status, age, context tokens and cost, so you can check progress without parsing output files.",
        args: {},
        async execute() {
          const parent = shared.currentSession()
          if (!parent) return "No current session."
          return formatFleet(await fleetRows(input, parent, running), Date.now())
        },
      }),
    },
  }
}
