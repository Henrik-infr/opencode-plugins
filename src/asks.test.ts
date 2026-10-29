import { describe, expect, test } from "vitest"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { addAsk, listAsks, resolveAsk } from "./asks"

const dir = () => mkdtemp(path.join(tmpdir(), "asks-"))
const NOW = Date.parse("2026-10-29T12:00:00Z")

describe("ask registry", () => {
  test("add, list, resolve", async () => {
    const d = await dir()
    const a = await addAsk(d, "Which database?", "staging", NOW)
    const b = await addAsk(d, "Ship Friday?", "yes", NOW + 1)
    expect((await listAsks(d)).map(x => x.id)).toEqual([a.id, b.id])
    expect(await resolveAsk(d, a.id, NOW + 2)).toBe(true)
    expect(await resolveAsk(d, a.id, NOW + 3)).toBe(false) // already resolved
    const open = await listAsks(d)
    expect(open.map(x => x.id)).toEqual([b.id])
  })
  test("a corrupt file yields an empty list, never a throw", async () => {
    const d = await dir()
    await writeFile(path.join(d, "s1.json"), "{not json")
    expect(await listAsks(path.join(d))).toEqual([])
  })
})
