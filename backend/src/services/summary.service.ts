import { env } from '../config/env.js'
import { SessionSummaryRepo } from '../repositories/sessionSummary.repo.js'
import { ChatMessageRepo } from '../repositories/chatMessage.repo.js'
import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'
import type { GameState } from '../domain/types/gameState.js'
import type { Narrator } from '../llm/narrator.js'
import { GeminiAdapter } from '../llm/gemini.adapter.js'
import type { StructuredSummary } from '../llm/summary-format.js'
import { renderStructuredSummary, isEmptyStructuredSummary } from '../llm/summary-format.js'
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

/** Resumo legado (prosa livre) migrado para o formato estruturado — vira o bloco "atual" até a próxima compactação reorganizá-lo por local. */
function wrapLegacyTextAsStructuredSummary(text: string, lastTurnIncluded: number): StructuredSummary {
  return {
    locations: [],
    current: { name: 'Resumo anterior', turn: lastTurnIncluded, situation: text }
  }
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

  /** Resumo anterior como StructuredSummary. Migra resumos legados (prosa livre, pré-JSON) na primeira leitura. */
  private buildSummarySeed(
    existing: { summaryText?: string | null; summaryStructured?: StructuredSummary; lastTurnIncluded?: number } | null,
    messages: Array<{
      role: 'narrator' | 'player' | 'system'
      narrative?: string
      engineEvents?: Array<{ type: string; payload: Record<string, unknown> }>
    }>
  ): StructuredSummary | null {
    if (existing?.summaryStructured && !isEmptyStructuredSummary(existing.summaryStructured)) {
      return existing.summaryStructured
    }

    const legacySummaryMessage = messages.find((message) => this.isPersistedLegacySummary(message))
    const legacyText = trimIncompleteSummaryText(
      existing?.summaryText?.trim() || legacySummaryMessage?.narrative?.trim() || ''
    )

    return legacyText ? wrapLegacyTextAsStructuredSummary(legacyText, existing?.lastTurnIncluded ?? 0) : null
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

  /**
   * Move as mensagens já incorporadas ao resumo para a coleção de arquivo, em vez de
   * apagá-las. O texto bruto sobrevive para auditoria e para reconstrução completa
   * do resumo (rebuildSummary), mesmo que o resumo gerado pelo LLM tenha perdido
   * algum detalhe na compressão.
   */
  private async archiveCompactedMessages(sessionId: string, messages: ChatMessageRow[]): Promise<void> {
    const unique = [...new Map(messages.filter((m) => m.messageId).map((m) => [m.messageId, m])).values()]
    if (!unique.length) return

    try {
      await this.chatMessages.archiveBatch(sessionId, unique)
      log('summarizeHistory', `Archived ${unique.length} compacted messages (raw text preserved for audit/rebuild)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn('summarizeHistory', `Summary updated but compacted messages were not archived: ${message}`)
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
          summaryText: renderStructuredSummary(summarySeed),
          summaryStructured: summarySeed
        })
      }
      await this.archiveCompactedMessages(sessionId, oldestMessages)
      return
    }

    let nextSummary: StructuredSummary
    try {
      nextSummary = await this.narrator.summarizeHistory({
        previousSummary: summarySeed,
        messages: messagesForLlm,
        currentState: stateForSummary ?? state
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log('summarizeHistory', `Skipped history compaction because summary generation was unreliable: ${message}`)
      return
    }

    if (isEmptyStructuredSummary(nextSummary)) {
      log('summarizeHistory', 'Skipped history compaction because summary ended empty after cleanup')
      return
    }

    const nextSummaryText = renderStructuredSummary(nextSummary)
    await this.summaries.upsertSummary({
      sessionId,
      lastTurnIncluded: coveredTurn,
      summaryText: nextSummaryText,
      summaryStructured: nextSummary
    })

    await this.archiveCompactedMessages(sessionId, oldestMessages)
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

  /**
   * Reconstrói o resumo canônico do zero, a partir do texto bruto completo da sessão
   * (mensagens arquivadas + ativas), ignorando o resumo já salvo. Só é possível com
   * fidelidade total porque as mensagens compactadas são arquivadas, não apagadas
   * (ver archiveCompactedMessages). Processa em lotes cronológicos, dobrando cada
   * lote sobre o resumo acumulado do lote anterior — mesma operação usada na
   * compactação incremental, aplicada em sequência ao histórico inteiro.
   */
  async rebuildSummary(params: { state: GameState }): Promise<string> {
    const { state } = params
    const sessionId = state.meta.sessionId

    const [archived, active] = await Promise.all([
      this.chatMessages.listArchivedBySession(sessionId),
      this.chatMessages.listBySession(sessionId)
    ])
    const allMessages = [...archived, ...active].sort((a, b) => a.seq - b.seq || a.turn - b.turn)
    const messagesForLlm = this.buildMessagesForSummary(allMessages)

    const batchSize = SummaryService.RECENT_MESSAGES_TO_KEEP * 2
    let summary: StructuredSummary | null = null

    for (let i = 0; i < messagesForLlm.length; i += batchSize) {
      const chunk = messagesForLlm.slice(i, i + batchSize)
      if (!chunk.length) continue
      summary = await this.narrator.summarizeHistory({
        previousSummary: summary,
        messages: chunk,
        currentState: state
      })
    }

    const nextSummary = summary ?? { locations: [], current: { name: state.worldState.activeLocation, turn: state.meta.turn, situation: '' } }
    const nextSummaryText = renderStructuredSummary(nextSummary)
    await this.summaries.upsertSummary({
      sessionId,
      lastTurnIncluded: state.meta.turn,
      summaryText: nextSummaryText,
      summaryStructured: nextSummary
    })

    log('summarizeHistory', `Canonical summary rebuilt from full archive (${messagesForLlm.length} messages, ${nextSummaryText.length} chars)`)
    return nextSummaryText
  }
}
