import { env } from '../config/env.js'
import { SessionEventRepo } from '../repositories/sessionEvent.repo.js'
import { SessionSummaryRepo } from '../repositories/sessionSummary.repo.js'
import { ChatMessageRepo } from '../repositories/chatMessage.repo.js'
import type { GameState } from '../domain/types/gameState.js'
import type { Narrator } from '../llm/narrator.js'
import { GeminiAdapter } from '../llm/gemini.adapter.js'
import { log } from '../utils/file-logger.js'

export type SummaryDecisionHints = {
  endedCombat?: boolean
  endedChapter?: boolean
}

export class SummaryService {
  private static readonly HISTORY_BATCH_SIZE = 20
  /** Número mínimo de mensagens recentes que NUNCA são resumidas */
  private static readonly HISTORY_TAIL_KEEP = 10

  private isPersistedHistorySummary(message: {
    role: 'narrator' | 'player' | 'system'
    narrative?: string
    engineEvents?: Array<{ type: string; payload: Record<string, unknown> }>
  }): boolean {
    return message.role === 'system' && Boolean(message.narrative?.trim()) && !(message.engineEvents?.length)
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

    const summaryText = await this.narrator.summarize({
      previousSummary: existing?.summaryText ?? '',
      upToTurn: params.state.meta.turn,
      keyEvents,
      currentState: params.state,
      maxTokensHint: 500
    })

    await this.summaries.upsertSummary({
      sessionId,
      lastTurnIncluded: params.state.meta.turn,
      summaryText,
      keyEvents
    })
  }

  /**
   * Verifica se há >= 20 mensagens; se sim, resume as 20 mais antigas,
   * salva o resumo acumulado e apaga as mensagens resumidas.
   */
  async maybeSummarizeHistory(params: { sessionId: string; currentLocation: string }): Promise<void> {
    const { sessionId, currentLocation } = params
    const totalMessages = await this.chatMessages.countBySession(sessionId)
    const minToTrigger = SummaryService.HISTORY_BATCH_SIZE + SummaryService.HISTORY_TAIL_KEEP

    if (totalMessages < minToTrigger) return

    log('summarizeHistory', `${totalMessages} messages (min ${minToTrigger}), summarizing oldest ${SummaryService.HISTORY_BATCH_SIZE} — keeping last ${SummaryService.HISTORY_TAIL_KEEP} intact`)

    const oldestMessages = await this.chatMessages.getOldest(sessionId, SummaryService.HISTORY_BATCH_SIZE)
    if (oldestMessages.length < SummaryService.HISTORY_BATCH_SIZE) return

  const existing = await this.summaries.getSummary(sessionId)
  const legacySummaryMessage = oldestMessages.find((message) => this.isPersistedHistorySummary(message))
  const historySummarySeed = existing?.historySummaryText?.trim() || legacySummaryMessage?.narrative?.trim() || ''

    // Filtrar mensagens system que são resumos anteriores — não precisam ser
    // re-resumidas pois o previousSummary já é lido do _meta/summary.
    // Mensagens system com engineEvents (dados) também são ignoradas.
    const nonSummaryMessages = oldestMessages.filter((m) => {
      if (m.role === 'system') {
        // Se é system com narrative (resumo) → pular (já está em previousSummary)
        if (m.narrative && !m.engineEvents?.length) return false
        // Se é system com engineEvents (dados) → incluir como contexto
        if (m.engineEvents?.length) return true
        return false
      }
      return true
    })

    const messagesForLlm = nonSummaryMessages.map((m) => {
      if (m.role === 'narrator') return { role: m.role, text: m.narrative ?? '', turn: m.turn }
      if (m.role === 'player') return { role: m.role, text: m.playerInput ?? '', turn: m.turn }
      // system with engineEvents — describe dice results
      const eventsText = (m.engineEvents ?? [])
        .map((ev) => `[${ev.type}] ${JSON.stringify(ev.payload)}`)
        .join('; ')
      return { role: m.role as 'narrator' | 'player', text: eventsText, turn: m.turn }
    }).filter((m) => m.text.trim())

    if (messagesForLlm.length === 0) {
      if (historySummarySeed) {
        await this.summaries.upsertHistorySummary({
          sessionId,
          historySummaryText: historySummarySeed
        })
      }
      await this.chatMessages.deleteBatch(sessionId, oldestMessages.map((m) => m.messageId))
      return
    }

    const summaryText = await this.narrator.summarizeHistory({
      previousSummary: historySummarySeed,
      messages: messagesForLlm,
      currentLocation
    })

    await this.summaries.upsertHistorySummary({
      sessionId,
      historySummaryText: summaryText
    })

    const idsToDelete = oldestMessages.map((m) => m.messageId)
    await this.chatMessages.deleteBatch(sessionId, idsToDelete)

    log('summarizeHistory', `Done — summarized ${idsToDelete.length} messages, saved history summary with ${summaryText.length} chars`)
  }
}
