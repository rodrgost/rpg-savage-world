import type { GameState } from '../domain/types/gameState.js'
import type { SessionSummaryRow } from '../repositories/sessionSummary.repo.js'

export type LlmContext = {
  summaryText: string
  stateBrief: {
    location: string
    playerHp: number
    situation: 'exploracao' | 'combat' | 'dialogo'
  }
}

export function buildLlmContext(params: { state: GameState; summary: SessionSummaryRow | null }): LlmContext {
  const { state, summary } = params
  const situation: LlmContext['stateBrief']['situation'] = state.combat ? 'combat' : 'exploracao'

  return {
    summaryText: summary?.summaryText ?? '',
    stateBrief: {
      location: state.worldState.activeLocation,
      playerHp: state.player.hp,
      situation
    }
  }
}
