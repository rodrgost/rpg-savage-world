import type { GameState } from '../domain/types/gameState.js'

export type SummarizeHistoryRequest = {
  previousSummary: string
  messages: Array<{ role: string; text: string; turn: number }>
  currentState: GameState
}

export interface Narrator {
  summarizeHistory(req: SummarizeHistoryRequest): Promise<string>
}
