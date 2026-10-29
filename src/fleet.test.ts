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
