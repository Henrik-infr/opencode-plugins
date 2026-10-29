import { describe, expect, test } from "vitest"
import { flag, list, mergeHooks, norm, num, slashes } from "./shared"

describe("lenient option parsing", () => {
  test("list takes arrays or comma/newline strings", () => {
    expect(list(["a", "b"])).toEqual(["a", "b"])
    expect(list("a, b\nc")).toEqual(["a", "b", "c"])
    expect(list(undefined)).toEqual([])
    expect(list(7)).toEqual([])
  })
  test("flag falls back on non-booleans", () => {
    expect(flag(true, false)).toBe(true)
    expect(flag(undefined, true)).toBe(true)
    expect(flag("yes", false)).toBe(false)
  })
  test("num parses, falls back on garbage", () => {
    expect(num("45", 60)).toBe(45)
    expect(num(undefined, 60)).toBe(60)
    expect(num("x", 60)).toBe(60)
  })
})

describe("path normalization (ported from fence)", () => {
  test("slashes", () => {
    expect(slashes("C:\\a\\\\b/")).toBe("C:/a/b")
  })
  test("norm lowercases and fixes drive letters", () => {
    expect(norm("C:\\A\\B")).toBe("c:/a/b")
    expect(norm("/c/Users/x/")).toBe("c:/users/x")
  })
})

describe("mergeHooks", () => {
  test("chains event callbacks in order and merges tool objects", async () => {
    const seen: string[] = []
    const merged = mergeHooks([
      { event: async () => { seen.push("a") } },
      { tool: { one: {} as any } },
      { event: async () => { seen.push("b") } },
      { tool: { two: {} as any } },
    ] as any)
    await (merged.event as any)({ event: { type: "x", properties: {} } })
    expect(seen).toEqual(["a", "b"])
    expect(Object.keys(merged.tool!)).toEqual(["one", "two"])
  })
  test("a throw in an early tool.execute.before wins", async () => {
    const merged = mergeHooks([
      { "tool.execute.before": async () => { throw new Error("fence says no") } },
      { "tool.execute.before": async () => { throw new Error("should not run") } },
    ] as any)
    await expect((merged["tool.execute.before"] as any)({ tool: "bash", sessionID: "s", callID: "c" }, { args: {} }))
      .rejects.toThrow("fence says no")
  })
})
