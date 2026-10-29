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
