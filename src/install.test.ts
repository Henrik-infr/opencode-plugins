import { describe, expect, test } from "vitest"
import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { copyIfChanged } from "./install"

async function dir(files: Record<string, string>): Promise<string> {
  const root = path.join(tmpdir(), `install-${Math.random().toString(36).slice(2)}`)
  for (const [name, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await writeFile(path.join(root, name), body)
  }
  return root
}

describe("copyIfChanged", () => {
  test("copies new files, skips identical, overwrites changed", async () => {
    const src = await dir({ "a/SKILL.md": "one", "sub/b.md": "two" })
    const dest = await dir({ "a/SKILL.md": "one" })
    const copied = await copyIfChanged(src, dest)
    expect(copied).toBe(1) // sub/b.md only
    const again = await copyIfChanged(src, dest)
    expect(again).toBe(0)
  })
})
