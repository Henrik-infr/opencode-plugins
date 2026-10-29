import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import { num } from "./shared"
import type { Shared } from "./shared"

const GIT_GH = /^(git|gh)(\s|$)/
const isNote = (p: unknown) => /\.(md|txt)$/.test(String(p ?? "").trim().toLowerCase())

export type Tracked = { id: string; startedAt: number; edits: number; context: number; warned: boolean; nudged: boolean }

export function gateMessage(t: Tracked, now: number, limitMs: number, tool: string, args: Record<string, unknown>): string | undefined {
  if (limitMs <= 0 || now - t.startedAt < limitMs) return undefined
  const allowed =
    tool === "bash" ? GIT_GH.test(String(args.command ?? "").trim())
    : tool === "edit" || tool === "write" ? isNote(args.filePath)
    : false
  if (allowed) return undefined
  return `subagent-wall: ${limitMs / 60000} minutes, at or past the ${limitMs / 60000}-minute limit. ` +
    "From here only git/gh commands and .md/.txt writes are allowed. Commit, push, put your report in the PR body or your final message, and end your turn."
}

export function warnMessage(t: Tracked, now: number, warnMs: number, limitMs: number): string | undefined {
  if (warnMs <= 0 || t.warned || now - t.startedAt < warnMs) return undefined
  return `subagent-wall: ${Math.floor((now - t.startedAt) / 60000)} minutes in. At ${limitMs / 60000} minutes only git, gh and .md/.txt writes will be allowed. Start no new item: finish the one in hand, commit, push, and report.`
}

export function nudgeMessage(t: Tracked, nudgeTokens: number): string | undefined {
  if (nudgeTokens <= 0 || t.nudged || t.edits > 0 || t.context < nudgeTokens) return undefined
  return `subagent-wall: about ${Math.round(t.context / 1000)}k tokens of context and no file edited yet. Stop exploring: make the change now from what you know, or report what blocks you.`
}

export async function wall(input: PluginInput, options: Record<string, unknown>, shared: Shared): Promise<Partial<Hooks>> {
  const warnMs = num(options.warnMinutes, 45) * 60_000
  const limitMs = num(options.limitMinutes, 60) * 60_000
  const nudgeTokens = num(options.noEditNudgeK, 100) * 1000
  const tracked = new Map<string, Tracked>()

  return {
    event: async ({ event }) => {
      if (event.type === "session.created" && event.properties.info.parentID) {
        tracked.set(event.properties.info.id, { id: event.properties.info.id, startedAt: event.properties.info.time?.created ?? Date.now(), edits: 0, context: 0, warned: false, nudged: false })
      }
      if (event.type === "message.updated" && event.properties.info?.role === "assistant") {
        const t = tracked.get(event.properties.info.sessionID)
        if (t) {
          const tk = event.properties.info.tokens
          t.context = Math.max(t.context, (tk?.input ?? 0) + (tk?.output ?? 0) + (tk?.reasoning ?? 0) + (tk?.cache?.read ?? 0) + (tk?.cache?.write ?? 0))
        }
      }
    },
    "tool.execute.before": async (i, output) => {
      const t = tracked.get(i.sessionID)
      if (!t) return
      const refusal = gateMessage(t, Date.now(), limitMs, i.tool, output.args ?? {})
      if (refusal) throw new Error(refusal)
    },
    "tool.execute.after": async (i) => {
      const t = tracked.get(i.sessionID)
      if (t && (i.tool === "edit" || i.tool === "write")) t.edits++
    },
    "experimental.chat.system.transform": async (i, output) => {
      const id = (i as any).sessionID
      const t = id ? tracked.get(id) : undefined
      if (!t) return
      const now = Date.now()
      const warn = warnMessage(t, now, warnMs, limitMs)
      if (warn) { t.warned = true; output.system.push(warn) }
      const nudge = nudgeMessage(t, nudgeTokens)
      if (nudge) { t.nudged = true; output.system.push(nudge) }
    },
  }
}
