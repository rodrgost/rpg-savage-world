import type { GameState } from '../domain/types/gameState.js'

export type SummarizeRequest = {
  previousSummary: string
  upToTurn: number
  keyEvents: Array<{ turn: number; type: string; payload: unknown }>
  currentState: GameState
  maxTokensHint?: number
}

export interface Narrator {
  summarize(req: SummarizeRequest): Promise<string>
}
