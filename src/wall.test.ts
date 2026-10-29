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
