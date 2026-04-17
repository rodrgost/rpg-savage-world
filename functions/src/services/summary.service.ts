import { env } from '../config/env.js'
import { SessionEventRepo } from '../repositories/sessionEvent.repo.js'
import { SessionSummaryRepo } from '../repositories/sessionSummary.repo.js'
import type { GameState } from '../domain/types/gameState.js'
import type { Narrator } from '../llm/narrator.js'
import { GeminiAdapter } from '../llm/gemini.adapter.js'

export type SummaryDecisionHints = {
  endedCombat?: boolean
  endedChapter?: boolean
}

export class SummaryService {
  constructor(
    private readonly summaries = new SessionSummaryRepo(),
    private readonly events = new SessionEventRepo(),
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

    if (!this.shouldSummarize({ turn: params.state.meta.turn, lastTurnIncluded, hints: params.hints })) return

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
}
