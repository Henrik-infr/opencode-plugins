import { expect, test } from "vitest"
import { applyMessage, budget, crossedLevel, elapsedPercent, paceOf, pruneEvents, windowStart, windowUsed } from "./budget"
import type { Shared } from "./shared"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const H = 3600_000, NOW = Date.parse("2026-10-29T12:00:00Z")

const msg = (id: string, tokens: number) => ({
  event: { type: "message.updated", properties: { info: { id, role: "assistant", tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } } } },
}) as any
const mkShared = (dir: string): Shared => ({
  currentSession: () => undefined,
  dataDir: async () => dir,
  toast: async () => {},
})

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

test("pruneEvents drops events older than 7 days and keeps newer", () => {
  const events = [{ t: NOW - 8 * 24 * H, d: 1000 }, { t: NOW - 24 * H, d: 50 }]
  expect(pruneEvents(events, NOW)).toEqual([{ t: NOW - 24 * H, d: 50 }])
})

test("budget windows persist events across restarts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "budget-"))
  const shared = mkShared(dir)
  const sum = (saved: any) => saved.events.reduce((s: number, e: any) => s + e.d, 0)

  const run1 = await budget({} as any, { budget5h: 1000, budget7d: 10000 }, shared)
  await run1.event!(msg("m1", 100)) // first sighting of the process: baseline
  await run1.event!(msg("m1", 250)) // +150
  const after1 = JSON.parse(await readFile(path.join(dir, "budget.json"), "utf8"))
  expect(sum(after1)).toBe(150)

  const run2 = await budget({} as any, { budget5h: 1000, budget7d: 10000 }, shared) // restart: loads persisted events
  await run2.event!(msg("m2", 60)) // first sighting of this process: baseline
  await run2.event!(msg("m3", 40)) // +40 on top of the persisted 150
  const after2 = JSON.parse(await readFile(path.join(dir, "budget.json"), "utf8"))
  expect(sum(after2)).toBe(190)
  expect(after2.windows.fiveHour.used).toBe(190)
})

test("pace over the margin refuses new subagent spawns", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "budget-"))
  const run = await budget({} as any, { budget7d: 100 }, mkShared(dir))
  await run.event!(msg("m1", 90))  // first sighting of the process: baseline
  await run.event!(msg("m1", 130)) // +40 of the 7-day budget with ~0% of the window gone: 40 points ahead of pace
  await expect(run["tool.execute.before"]!({ tool: "task" } as any, { args: {} } as any)).rejects.toThrow(/New subagents are refused until/)
})

test("windowStart is the oldest in-window event, now when empty", () => {
  const events = [{ t: NOW - H, d: 50 }, { t: NOW - 2 * H, d: 10 }, { t: NOW - 6 * H, d: 1 }]
  expect(windowStart(events, NOW, 5 * H)).toBe(NOW - 2 * H)
  expect(windowStart([], NOW, 5 * H)).toBe(NOW)
})
