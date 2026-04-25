import { env } from '../config/env.js'
import { SessionEventRepo } from '../repositories/sessionEvent.repo.js'
import { SessionSummaryRepo } from '../repositories/sessionSummary.repo.js'
import { ChatMessageRepo } from '../repositories/chatMessage.repo.js'
import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'
import type { GameState } from '../domain/types/gameState.js'
import type { Narrator } from '../llm/narrator.js'
import { GeminiAdapter } from '../llm/gemini.adapter.js'
import { log } from '../utils/file-logger.js'

export type SummaryDecisionHints = {
  endedCombat?: boolean
  endedChapter?: boolean
}

function trimIncompleteSummaryText(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return ''
  if (/[.!?…]["')\]]?\s*$/u.test(normalized)) return normalized

  const matches = [...normalized.matchAll(/[.!?…]["')\]]?(?=\s|$)/gu)]
  if (!matches.length) return normalized

  const last = matches[matches.length - 1]
  const index = last.index ?? 0
  return normalized.slice(0, index + last[0].length).trim()
}

export class SummaryService {
  private static readonly HISTORY_BATCH_SIZE = 20
  /** Número mínimo de mensagens recentes que NUNCA são resumidas */
  private static readonly HISTORY_TAIL_KEEP = 10

  private isPersistedLegacySummary(message: {
    role: 'narrator' | 'player' | 'system'
    narrative?: string
    engineEvents?: Array<{ type: string; payload: Record<string, unknown> }>
  }): boolean {
    return message.role === 'system' && Boolean(message.narrative?.trim()) && !(message.engineEvents?.length)
  }

  private buildSummarySeed(
    existing: { summaryText?: string | null } | null,
    messages: Array<{
      role: 'narrator' | 'player' | 'system'
      narrative?: string
      engineEvents?: Array<{ type: string; payload: Record<string, unknown> }>
    }>
  ): string {
    const legacySummaryMessage = messages.find((message) => this.isPersistedLegacySummary(message))
    return trimIncompleteSummaryText(
      existing?.summaryText?.trim() || legacySummaryMessage?.narrative?.trim() || ''
    )
  }

  private buildMessagesForSummary(messages: ChatMessageRow[]) {
    const nonSummaryMessages = messages.filter((m) => {
      if (m.role === 'system') {
        if (m.narrative && !m.engineEvents?.length) return false
        if (m.engineEvents?.length) return true
        return false
      }
      return true
    })

    return nonSummaryMessages.map((m) => {
      if (m.role === 'narrator') return { role: m.role, text: m.narrative ?? '', turn: m.turn }
      if (m.role === 'player') return { role: m.role, text: m.playerInput ?? '', turn: m.turn }
      const eventsText = (m.engineEvents ?? [])
        .map((ev) => `[${ev.type}] ${JSON.stringify(ev.payload)}`)
        .join('; ')
      return { role: m.role as 'narrator' | 'player', text: eventsText, turn: m.turn }
    }).filter((m) => m.text.trim())
  }

  constructor(
    private readonly summaries = new SessionSummaryRepo(),
    private readonly events = new SessionEventRepo(),
    private readonly chatMessages = new ChatMessageRepo(),
    private readonly narrator: Narrator = new GeminiAdapter()
  ) {}

  shouldSummarize(params: { turn: number; lastTurnIncluded: number; hints?: SummaryDecisionHints }): boolean {
    const { turn, lastTurnIncluded, hints } = params
    if (hints?.endedCombat) return true
    if (hints?.endedChapter) return true

    const interval = env.summaryIntervalTurns
    if (interval <= 0) return false

    const delta = turn - lastTurnIncluded
    return delta >= interval
  }

  async maybeUpdateSummary(params: { state: GameState; hints?: SummaryDecisionHints }): Promise<void> {
    const sessionId = params.state.meta.sessionId

    const existing = await this.summaries.getSummary(sessionId)
    const lastTurnIncluded = existing?.lastTurnIncluded ?? 0

    if (
      !this.shouldSummarize({
        turn: params.state.meta.turn,
        lastTurnIncluded,
        hints: params.hints
      })
    ) {
      return
    }

    const keyEvents = await this.events.listSince({ sessionId, afterTurn: lastTurnIncluded })
    const recentRaw = await this.chatMessages.getRecent(sessionId, 10)
    const recentMessages = this.buildMessagesForSummary(recentRaw)

    const summaryText = trimIncompleteSummaryText(await this.narrator.summarize({
      previousSummary: existing?.summaryText ?? '',
      upToTurn: params.state.meta.turn,
      keyEvents,
      currentState: params.state,
      maxTokensHint: 500,
      recentMessages
    }))

    await this.summaries.upsertSummary({
      sessionId,
      lastTurnIncluded: params.state.meta.turn,
      summaryText,
      keyEvents
    })
  }

  /**
   * Verifica se há >= 20 mensagens; se sim, integra as 20 mais antigas ao resumo
   * canônico e apaga apenas as mensagens já incorporadas.
   */
  async maybeSummarizeHistory(params: { state: GameState }): Promise<void> {
    const { state } = params
    const sessionId = state.meta.sessionId
    const totalMessages = await this.chatMessages.countBySession(sessionId)
    const minToTrigger = SummaryService.HISTORY_BATCH_SIZE + SummaryService.HISTORY_TAIL_KEEP

    if (totalMessages < minToTrigger) return

    log('summarizeHistory', `${totalMessages} messages (min ${minToTrigger}), summarizing oldest ${SummaryService.HISTORY_BATCH_SIZE} — keeping last ${SummaryService.HISTORY_TAIL_KEEP} intact`)

    const oldestMessages = await this.chatMessages.getOldest(sessionId, SummaryService.HISTORY_BATCH_SIZE)
    if (oldestMessages.length < SummaryService.HISTORY_BATCH_SIZE) return

    const existing = await this.summaries.getSummary(sessionId)
    const summarySeed = this.buildSummarySeed(existing, oldestMessages)
    const messagesForLlm = this.buildMessagesForSummary(oldestMessages)
    const coveredTurn = Math.max(
      existing?.lastTurnIncluded ?? 0,
      ...oldestMessages.map((message) => message.turn)
    )

    if (messagesForLlm.length === 0) {
      if (summarySeed) {
        await this.summaries.upsertSummary({
          sessionId,
          lastTurnIncluded: coveredTurn,
          summaryText: summarySeed
        })
      }
      await this.chatMessages.deleteBatch(sessionId, oldestMessages.map((m) => m.messageId))
      return
    }

    let nextSummaryText: string
    try {
      nextSummaryText = trimIncompleteSummaryText(await this.narrator.summarizeHistory({
        previousSummary: summarySeed,
        messages: messagesForLlm,
        currentState: state
      }))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('summarizeHistory', `Skipped history compaction because summary generation was unreliable: ${message}`)
      return
    }

    if (!nextSummaryText) {
      log('summarizeHistory', 'Skipped history compaction because summary text ended empty after cleanup')
      return
    }

    await this.summaries.upsertSummary({
      sessionId,
      lastTurnIncluded: coveredTurn,
      summaryText: nextSummaryText
    })

    const idsToDelete = oldestMessages.map((m) => m.messageId)
    await this.chatMessages.deleteBatch(sessionId, idsToDelete)

    log('summarizeHistory', `Done — compacted ${idsToDelete.length} messages into canonical summary with ${nextSummaryText.length} chars`)
  }

  async rebuildSummary(params: { state: GameState }): Promise<string> {
    const { state } = params
    const sessionId = state.meta.sessionId
    const existing = await this.summaries.getSummary(sessionId)
    const messages = await this.chatMessages.listBySession(sessionId)
    const summarySeed = this.buildSummarySeed(existing, messages)
    const messagesForLlm = this.buildMessagesForSummary(messages)

    const nextSummary = messagesForLlm.length
      ? trimIncompleteSummaryText(await this.narrator.summarizeHistory({
          previousSummary: summarySeed,
          messages: messagesForLlm,
          currentState: state
        }))
      : summarySeed

    await this.summaries.upsertSummary({
      sessionId,
      lastTurnIncluded: state.meta.turn,
      summaryText: nextSummary
    })

    log('summarizeHistory', `Canonical summary rebuilt on demand with ${nextSummary.length} chars`)
    return nextSummary
  }
}
