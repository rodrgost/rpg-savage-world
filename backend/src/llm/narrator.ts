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
  recentMessages?: Array<{ role: 'narrator' | 'player'; text: string; turn: number }>
}

export type SummarizeHistoryRequest = {
  previousSummary: string
  messages: Array<{ role: string; text: string; turn: number }>
  currentState: GameState
}

export type ExpandWorldRequest = {
  campaignName: string
  currentDescription?: string
}

export type StoryCharacter = {
  name: string
  role: string
  roleEn?: string
  description: string
  descriptionEn?: string
  status: string
  statusEn?: string
}

export type ExpandAdventureStoryResult = {
  storyDescription: string
  storyDescriptionEn?: string
  storyCharacters: StoryCharacter[]
  name?: string
  nameEn?: string
}

export type ExpandWorldLoreRequest = {
  name: string
  description: string
  currentLore?: string
}

export type SuggestCharacterFromWorldRequest = {
  worldName: string
  storyDescription: string
  worldLore?: string
  /** Campos já preenchidos pelo usuário — a IA não deve substituí-los */
  existingFields?: {
    name?: string
    gender?: string
    race?: string
    profession?: string
    description?: string
    campaignRole?: string
  }
}

export type SuggestCharacterFromDescriptionRequest = {
  characterConcept: string
  worldName?: string
  worldLore?: string
  campaignThematic?: string
}
export type SuggestedCharacter = {
  name: string
  gender: string
  race: string
  profession: string
  description: string
  campaignRole: string
  genderPt?: string
  racePt?: string
  professionPt?: string
  descriptionPt?: string
  campaignRolePt?: string
}

export type GenerateImageDescriptionRequest =
  | {
      entityType: 'world'
      title: string
    }
  | {
      entityType: 'campaign'
      title: string
    }
  | {
      entityType: 'character'
      worldName: string
      campaignTitle: string
      gender?: string
      race?: string
      profession: string
      additionalDescription?: string
    }

export interface Narrator {
  summarize(req: SummarizeRequest): Promise<string>
  summarizeHistory(req: SummarizeHistoryRequest): Promise<string>
  expandAdventureStory(req: ExpandWorldRequest): Promise<ExpandAdventureStoryResult>
  expandWorldLore(req: ExpandWorldLoreRequest): Promise<{ lore: string; loreEn?: string }>
  generateImageDescription(req: GenerateImageDescriptionRequest): Promise<string>
  suggestCharacterFromWorld(req: SuggestCharacterFromWorldRequest): Promise<SuggestedCharacter>
  suggestCharacterFromDescription(req: SuggestCharacterFromDescriptionRequest): Promise<SuggestedCharacter>
  /** Valida uma ação custom do jogador antes de executá-la */
  validateAction(req: ValidateActionRequest): Promise<ValidateActionResponse>
  /** Gera a narrativa inicial ao começar uma sessão */
  narrateStart(req: NarrateStartRequest): Promise<NarratorTurnResponse>
  /** Gera a narrativa de um turno após a ação do jogador */
  narrateTurn(req: NarrateTurnRequest): Promise<NarratorTurnResponse>
}
