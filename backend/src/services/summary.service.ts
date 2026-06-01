import { env } from '../config/env.js'
import { SessionEventRepo } from '../repositories/sessionEvent.repo.js'
import { SessionSummaryRepo } from '../repositories/sessionSummary.repo.js'
import { ChatMessageRepo } from '../repositories/chatMessage.repo.js'
import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'
import type { GameState } from '../domain/types/gameState.js'
import type { Narrator } from '../llm/narrator.js'
import { GeminiAdapter } from '../llm/gemini.adapter.js'
import { log, warn } from '../utils/file-logger.js'

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
  /** Número de mensagens recentes mantidas fora do resumo canônico. */
  private static readonly RECENT_MESSAGES_TO_KEEP = 20

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

    // Garante ordem cronológica: seq é o critério primário (atribuído na inserção),
    // turn é o fallback para mensagens legadas onde seq pode ser igual.
    const sorted = [...nonSummaryMessages].sort((a, b) => a.seq - b.seq || a.turn - b.turn)

    return sorted.map((m) => {
      if (m.role === 'narrator') return { role: m.role, text: m.narrative ?? '', turn: m.turn }
      if (m.role === 'player') return { role: m.role, text: m.playerInput ?? '', turn: m.turn }
      const eventsText = (m.engineEvents ?? [])
        .map((ev) => `[${ev.type}] ${JSON.stringify(ev.payload)}`)
        .join('; ')
      return { role: m.role as 'narrator' | 'player', text: eventsText, turn: m.turn }
    }).filter((m) => m.text.trim())
  }

  private async deleteCompactedMessages(sessionId: string, messages: ChatMessageRow[]): Promise<void> {
    const messageIds = [...new Set(messages.map((m) => m.messageId).filter(Boolean))]
    if (!messageIds.length) return

    try {
      await this.chatMessages.deleteBatch(sessionId, messageIds)
      log('summarizeHistory', `Deleted ${messageIds.length} compacted messages from session storage`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn('summarizeHistory', `Summary updated but compacted messages were not deleted: ${message}`)
    }
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

    // Quando não há resumo anterior, inclui também as primeiras mensagens (cena de abertura)
    // para que o LLM não perca o contexto do início do jogo.
    const openingRaw = existing?.summaryText ? [] : await this.chatMessages.getOldest(sessionId, 5)

    // Mesclar abertura + recentes, deduplicar por messageId, ordenar por seq
    const seenIds = new Set<string>()
    const mergedRaw = [...openingRaw, ...recentRaw].filter((m) => {
      if (seenIds.has(m.messageId)) return false
      seenIds.add(m.messageId)
      return true
    }).sort((a, b) => a.seq - b.seq)

    const recentMessages = this.buildMessagesForSummary(mergedRaw)

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

  /** Integra ao resumo apenas o excedente, preservando as 20 mensagens mais recentes. */
  async maybeSummarizeHistory(params: { state: GameState }): Promise<void> {
    const { state } = params
    const sessionId = state.meta.sessionId
    const totalMessages = await this.chatMessages.countBySession(sessionId)
    const messagesToCompact = totalMessages - SummaryService.RECENT_MESSAGES_TO_KEEP

    if (messagesToCompact <= 0) return

    log('summarizeHistory', `${totalMessages} messages, compacting oldest ${messagesToCompact} — keeping last ${SummaryService.RECENT_MESSAGES_TO_KEEP} intact`)

    const oldestMessages = await this.chatMessages.getOldest(sessionId, messagesToCompact)
    if (oldestMessages.length < messagesToCompact) return

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
      await this.deleteCompactedMessages(sessionId, oldestMessages)
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

    await this.deleteCompactedMessages(sessionId, oldestMessages)
    log('summarizeHistory', `Done — summary updated with ${nextSummaryText.length} chars`)
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
