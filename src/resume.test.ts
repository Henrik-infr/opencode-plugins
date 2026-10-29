import { expect, test } from "vitest"
import { interrupted, resolveWhere, type Entry } from "./resume"

const NOW = Date.parse("2026-10-29T12:00:00Z")
const e = (over: Partial<Entry>): Entry => ({
  sessionId: "s1", directory: "C:/Work/app", title: "demo", startedAt: "2026-10-29T10:00:00.000Z",
  lastActive: new Date(NOW - 7200_000).toISOString(), ended: "", ...over,
})

test("interrupted = no ended marker, stale heartbeat, within max age", () => {
  const entries = [
    e({ sessionId: "dead" }),                                                   // stale, interrupted
    e({ sessionId: "alive", lastActive: new Date(NOW - 60_000).toISOString() }), // heartbeat fresh
    e({ sessionId: "exited", ended: "exited" }),                                // clean exit
    e({ sessionId: "old", lastActive: new Date(NOW - 100 * 3600_000).toISOString() }), // beyond 72h
  ]
  expect(interrupted(entries, NOW).map(x => x.sessionId)).toEqual(["dead"])
})

test("resolveWhere: defaults when unset, overrides when set, whitespace falls back", () => {
  const defaults = { registry: "R:/default-registry", script: "S:/default/resume-sessions.ps1" }
  expect(resolveWhere({}, defaults)).toEqual({ registry: "R:/default-registry", script: "S:/default/resume-sessions.ps1", powershell: "pwsh", terminal: "wezterm" })
  expect(resolveWhere({ registry_dir: " R:/opt-registry ", resume_script: " S:/opt/resume-sessions.ps1 ", powershell: " powershell ", terminal: " windows-terminal " }, defaults))
    .toEqual({ registry: "R:/opt-registry", script: "S:/opt/resume-sessions.ps1", powershell: "powershell", terminal: "windows-terminal" })
  expect(resolveWhere({ registry_dir: "   ", resume_script: "", powershell: "\t", terminal: " " }, defaults))
    .toEqual({ registry: "R:/default-registry", script: "S:/default/resume-sessions.ps1", powershell: "pwsh", terminal: "wezterm" })
})
