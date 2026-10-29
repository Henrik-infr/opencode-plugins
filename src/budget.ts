import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { list, num } from "./shared"
import type { Shared } from "./shared"

export type UsageEvent = { t: number; d: number }
export type BudgetState = { last: Record<string, number>; events: UsageEvent[] }

// The message's tokens are a running total; keep the latest per message id and emit deltas.
// The first sighting of a process is a snapshot: its tokens may already be in the persisted
// events (restart mid-stream), so it baselines instead of counting; later messages count in full.
export function applyMessage(state: BudgetState, messageID: string, tokens: number, now: number): [BudgetState, number] {
  const prior = state.last[messageID] ?? (Object.keys(state.last).length === 0 ? tokens : 0)
  const delta = tokens - prior
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
