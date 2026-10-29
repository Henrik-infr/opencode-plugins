import { describe, expect, test } from "vitest"
import { fenceConfig, pushProblem, sharedGitMutation } from "./fence"

const base = { forcePush: true, protectedPush: true, protectedBranch: /(^|:)(refs\/heads\/)?(main|master|dev)$/, noVerify: true, killByName: true, bannedRoots: [], bannedInCommand: [], sharedCheckout: false, sharedRoot: "", readLimitBytes: 0 }

describe("push parsing (ported)", () => {
  test("force flags and +refspec are refused", () => {
    expect(pushProblem("git push --force origin main", base)).toBe("a force-push")
    expect(pushProblem("git push --force-with-lease=abc origin main", base)).toBe("a force-push")
    expect(pushProblem("git push -f origin main", base)).toBe("a force-push")
    expect(pushProblem("git push origin +main", base)).toBe("a force-push (+refspec)")
  })
  test("protected branch targets are refused; feature branches are not", () => {
    expect(pushProblem("git push origin main", base)).toBe("a push to a protected branch")
    expect(pushProblem("git push origin refs/heads/master", base)).toBe("a push to a protected branch")
    expect(pushProblem("git push origin feat/x", base)).toBeUndefined()
    expect(pushProblem("git push --force origin feat/x", { ...base, forcePush: false })).toBeUndefined()
  })
})

describe("shared checkout git mutations (ported)", () => {
  const stat = async (p: string) => (p.endsWith("plain/.git") || p === "plain/.git" ? { isDirectory: true } : p.endsWith("worktree/.git") ? { isDirectory: false } : undefined)
  test("git -C into a plain checkout is caught; a worktree is not", async () => {
    expect(await sharedGitMutation(stat as any, "git -C plain commit -m x", base)).toMatch(/git commit in plain/)
    expect(await sharedGitMutation(stat as any, "git -C worktree commit -m x", base)).toBeUndefined()
    expect(await sharedGitMutation(stat as any, "git -C plain status", base)).toBeUndefined()
  })
})

describe("command guards (ported)", () => {
  test("kill by name", () => {
    expect(/taskkill \/IM node.exe/i.test("taskkill /IM node.exe")).toBe(true)
  })
})

test("banned paths normalize and build command regexes", () => {
  const cfg = fenceConfig({ banned_paths: ["C:\\Secrets"], guard_force_push: true })
  expect(cfg.bannedRoots).toEqual(["c:/secrets"])
  expect(cfg.bannedInCommand.length).toBe(1)
})
