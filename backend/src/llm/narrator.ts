import type { GameState } from '../domain/types/gameState.js'
import type {
  NarrateStartRequest,
  NarrateTurnRequest,
  NarratorTurnResponse,
  ValidateActionRequest,
  ValidateActionResponse
} from '../domain/types/narrative.js'

export type SummarizeRequest = {
  previousSummary: string
  upToTurn: number
  keyEvents: Array<{ turn: number; type: string; payload: unknown }>
  currentState: GameState
  maxTokensHint?: number
}

export type SummarizeHistoryRequest = {
  previousSummary: string
  messages: Array<{ role: string; text: string; turn: number }>
  currentLocation: string
}

export type ExpandWorldRequest = {
  campaignName: string
  thematic: string
  currentDescription?: string
}

export type ExpandWorldLoreRequest = {
  name: string
  description: string
  currentLore?: string
}

export type SuggestCharacterFromWorldRequest = {
  thematic: string
  storyDescription: string
  worldLore?: string
  /** Campos já preenchidos pelo usuário — a IA não deve substituí-los */
  existingFields?: {
    name?: string
    gender?: string
    race?: string
    characterClass?: string
    profession?: string
    description?: string
  }
}
export type SuggestedCharacter = {
  name: string
  gender: string
  race: string
  characterClass: string
  profession: string
  description: string
}

export interface Narrator {
  summarize(req: SummarizeRequest): Promise<string>
  summarizeHistory(req: SummarizeHistoryRequest): Promise<string>
  expandWorld(req: ExpandWorldRequest): Promise<string>
  expandAdventureStory(req: ExpandWorldRequest): Promise<string>
  expandWorldLore(req: ExpandWorldLoreRequest): Promise<string>
  suggestCharacterFromWorld(req: SuggestCharacterFromWorldRequest): Promise<SuggestedCharacter>
  /** Valida uma ação custom do jogador antes de executá-la */
  validateAction(req: ValidateActionRequest): Promise<ValidateActionResponse>
  /** Gera a narrativa inicial ao começar uma sessão */
  narrateStart(req: NarrateStartRequest): Promise<NarratorTurnResponse>
  /** Gera a narrativa de um turno após a ação do jogador */
  narrateTurn(req: NarrateTurnRequest): Promise<NarratorTurnResponse>
}
