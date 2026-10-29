import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { configRoot } from "./shared"

// Copies every file under srcDir into destDir, skipping files whose content already matches.
export async function copyIfChanged(srcDir: string, destDir: string): Promise<number> {
  let copied = 0
  async function walk(src: string, rel: string) {
    for (const entry of await readdir(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name)
      const r = rel ? path.join(rel, entry.name) : entry.name
      if (entry.isDirectory()) { await walk(s, r); continue }
      const dest = path.join(destDir, r)
      const body = await readFile(s)
      const existing = await readFile(dest).catch(() => undefined)
      if (existing && Buffer.compare(existing, body) === 0) continue
      await mkdir(path.dirname(dest), { recursive: true })
      await writeFile(dest, body)
      copied++
    }
  }
  await walk(srcDir, "")
  return copied
}

const pkgRoot = path.resolve(import.meta.dirname, "..")

export async function installAssets(): Promise<{ copied: number }> {
  const root = configRoot()
  let copied = 0
  copied += await copyIfChanged(path.join(pkgRoot, "skills"), path.join(root, "skills")).catch(() => 0)
  copied += await copyIfChanged(path.join(pkgRoot, "commands"), path.join(root, "commands")).catch(() => 0)
  return { copied }
}
