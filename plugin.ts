import type { Plugin, Hooks } from "@opencode-ai/plugin"
import { createShared, list, mergeHooks } from "./src/shared"
import { installAssets } from "./src/install"
import { fence } from "./src/fence"
import { asks } from "./src/asks"
import { fleet } from "./src/fleet"
import { budget } from "./src/budget"

type SubPlugin = (input: any, options: Record<string, unknown>, shared: ReturnType<typeof createShared>["shared"]) => Promise<Partial<Hooks>>

const SUBPLUGINS: Record<string, SubPlugin> = {
  fence,
  asks,
  fleet,
  budget,
  // wall: ..., resume: ...   (added in Tasks 8-9)
}

export default (async (input, options = {}) => {
  await installAssets().catch(() => undefined)
  const disabled = new Set(list((options as any).disabled))
  const { shared, hooks } = createShared(input)
  const parts: Array<Partial<Hooks>> = [hooks] // tracker first: currentSession is set before sub-plugins see events
  for (const [name, sub] of Object.entries(SUBPLUGINS)) {
    if (!disabled.has(name)) parts.push(await sub(input, (options as any)[name] ?? {}, shared))
  }
  return mergeHooks(parts)
}) satisfies Plugin
