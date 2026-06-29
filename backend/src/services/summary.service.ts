import { env } from '../config/env.js'
import { SessionSummaryRepo } from '../repositories/sessionSummary.repo.js'
import { ChatMessageRepo } from '../repositories/chatMessage.repo.js'
import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'
import type { GameState } from '../domain/types/gameState.js'
import type { Narrator } from '../llm/narrator.js'
import { GeminiAdapter } from '../llm/gemini.adapter.js'
import { log, warn } from '../utils/file-logger.js'
import { messageText } from '../domain/segments.js'

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
  /** Número de mensagens recentes mantidas fora do resumo canônico.
   *  Deve ser igual a RECENT_LLM_MESSAGE_LIMIT em session.service.ts.
   *  Use esta constante como fonte única da verdade. */
  static readonly RECENT_MESSAGES_TO_KEEP = 20

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
    const sorted = [...messages]
      .filter((m) => m.role === 'narrator' || m.role === 'player')
      .sort((a, b) => a.seq - b.seq || a.turn - b.turn)

    return sorted.map((m) => {
      if (m.role === 'narrator') return { role: m.role as 'narrator', text: messageText(m), turn: m.turn }
      return { role: m.role as 'player', text: m.playerInput ?? '', turn: m.turn }
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
    private readonly chatMessages = new ChatMessageRepo(),
    private readonly narrator: Narrator = new GeminiAdapter()
  ) {}

  /** Integra ao resumo apenas o excedente, preservando as RECENT_MESSAGES_TO_KEEP mensagens mais recentes. */
  private async compactOldMessages(params: { state: GameState; stateForSummary?: GameState }): Promise<void> {
    const { state, stateForSummary } = params
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
        currentState: stateForSummary ?? state
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

  /**
   * Ponto de entrada único para gerenciamento de resumo após cada turno.
   * Compacta as mensagens mais antigas quando o excedente atinge env.compactBatchMin,
   * atualizando o resumo canônico e apagando as mensagens incorporadas.
   */
  async manageSummaryAfterTurn(params: { state: GameState; stateBeforeTurn?: GameState }): Promise<void> {
    const { state, stateBeforeTurn } = params
    const sessionId = state.meta.sessionId

    const totalMessages = await this.chatMessages.countBySession(sessionId)
    const messagesToCompact = totalMessages - SummaryService.RECENT_MESSAGES_TO_KEEP

    if (messagesToCompact >= env.compactBatchMin) {
      log('manageSummary', `Compacting ${messagesToCompact} old messages (threshold=${env.compactBatchMin})`)
      await this.compactOldMessages({ state, stateForSummary: stateBeforeTurn })
    }
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
