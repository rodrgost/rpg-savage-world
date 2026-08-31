import type { GameState } from '../domain/types/gameState.js'
import type { WorldGuide } from '../domain/types/world-guide.js'
import type {
  NarrateStartRequest,
  NarrateTurnRequest,
  NarratorTurnResponse,
  ValidateActionRequest,
  ValidateActionResponse
} from '../domain/types/narrative.js'
import type { StructuredSummary } from './summary-format.js'

export type { StructuredSummary, SummaryLocationBlock, SummaryCurrentBlock } from './summary-format.js'

export type SummarizeHistoryRequest = {
  /** null quando não há resumo anterior (primeira compactação da sessão). */
  previousSummary: StructuredSummary | null
  messages: Array<{ role: string; text: string; turn: number }>
  currentState: GameState
}

export type ExpandWorldRequest = {
  campaignName: string
  currentDescription?: string
  /** Guia canônico do mundo renderizado como contexto para diferenciar campanhas */
  worldGuideContext?: string
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

export type GenerateWorldGuideRequest = {
  name: string
  description: string
  currentGuide?: WorldGuide
  userInstruction?: string
}

export type SuggestCharacterFromWorldRequest = {
  worldName: string
  storyDescription: string
  worldGuide?: WorldGuide
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
  worldGuide?: WorldGuide
  campaignThematic?: string
  storyDescription?: string
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
      /** História da campanha ou guia de mundo renderizado usado como contexto visual */
      storyDescription?: string
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
  summarizeHistory(req: SummarizeHistoryRequest): Promise<StructuredSummary>
  expandAdventureStory(req: ExpandWorldRequest): Promise<ExpandAdventureStoryResult>
  generateWorldGuide(req: GenerateWorldGuideRequest): Promise<{ worldGuide: WorldGuide }>
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
