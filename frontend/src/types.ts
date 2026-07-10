export type DieType = 4 | 6 | 8 | 10 | 12

export type Visibility = 'private' | 'public'

export type OwnerProfile = {
  uid: string
  displayName: string
  photoUrl?: string
}

export type Hindrance = {
  name: string
  severity: 'minor' | 'major'
}

export type StoryCharacter = {
  name: string
  role: string
  description: string
  status: string
}

export type Campaign = {
  id: string
  worldId: string
  ownerId: string
  ownerProfile?: OwnerProfile
  visibility: Visibility
  name?: string
  storyDescription: string
  storyDescriptionEn?: string
  storyCharacters?: StoryCharacter[]
  image?: {
    mimeType: string
    base64: string
  }
  youtubeUrl?: string
}

export type World = {
  id: string
  ownerId: string
  ownerProfile?: OwnerProfile
  visibility: Visibility
  name: string
  description: string
  lore: string
  narrativeStyleGuide?: string
  ruleSetId: string
  image?: {
    mimeType: string
    base64: string
  }
}

export type Character = {
  id: string
  campaignId: string
  worldId?: string
  ownerId: string
  ownerProfile?: OwnerProfile
  visibility: Visibility
  name: string
  gender?: string
  race?: string
  profession?: string
  description?: string
  campaignRole?: string
  attributes: Record<string, number>
  skills?: Record<string, number>
  edges?: string[]
  hindrances?: Hindrance[]
  hindranceAllocation?: {
    extraEdges: number
    extraAttributePoints: number
    extraSkillPoints: number
  }
  sheetValues?: Record<string, unknown>
  image?: {
    mimeType: string
    base64: string
  }
}

// ─── Inventory & Narrative Types ───

export type ItemCategory =
  | 'weapon'
  | 'armor'
  | 'consumable'
  | 'ammunition'
  | 'vehicle'
  | 'property'
  | 'quest'
  | 'misc'

export type InventoryItem = {
  id: string
  name: string
  description: string
  quantity: number
  category?: ItemCategory
  tags?: string[]
}

export type ItemChange = {
  itemId: string
  name: string
  quantity: number
  changeType: 'gained' | 'lost' | 'used'
  category?: ItemCategory
}

export type StatusChange = {
  effectId: string
  name: string
  changeType: 'applied' | 'removed'
  turnsRemaining?: number | null
  description: string
  targetType?: 'player' | 'npc'
  targetId?: string | null
}

export type StatusEffect = {
  id: string
  name: string
  turnsRemaining?: number
  targetType?: 'player' | 'npc'
  targetId?: string
}

export type NPCMention = {
  /** Identificador estável (hash determinístico do displayName). */
  id: string
  /** Alias de `displayName` mantido por retrocompatibilidade. */
  name: string
  /** Nome amigável exibido ao jogador. */
  displayName?: string
  disposition: 'hostile' | 'neutral' | 'friendly'
  newlyIntroduced: boolean
  /** Status do NPC se houver mudança narrativa (ex: incapacitado, derrotado) */
  status?: 'active' | 'incapacitated' | 'defeated' | 'dead'
}

export type NarrativeSegment =
  | {
      type: 'narrator'
      text: string
    }
  | {
      type: 'npc'
      npcId?: string | null
      npcName: string
      /** Nome amigável exibido ao jogador. */
      npcDisplayName?: string
      disposition: NPCMention['disposition']
      text: string
    }

export type DiceCheck = {
  required: boolean
  skill?: string | null
  attribute?: string | null
  modifier?: number
  tn?: number
  reason: string
}

export type ActionOption = {
  id: string
  text: string
  playerSpeech?: string | null
  actionType: string
  actionPayload: Record<string, unknown>
  diceCheck?: DiceCheck | null
}

export type ValidateActionResponse = {
  feasible: boolean
  feasibilityReason?: string
  diceCheck?: DiceCheck | null
  actionType: string
  actionPayload: Record<string, unknown>
  interpretation: string
}

export type NarratorTurnResponse = {
  segments: NarrativeSegment[]
  options: ActionOption[]
  npcs: NPCMention[]
  itemChanges: ItemChange[]
  statusChanges: StatusChange[]
  /** true quando o conteúdo é um fallback estático por falha do LLM */
  isFallback?: boolean
}

export type ChatMessage = {
  messageId: string
  sessionId: string
  turn: number
  /** Sequência incremental — garante ordem determinística */
  seq?: number
  role: 'narrator' | 'player' | 'system'
  narrative?: string
  segments?: NarrativeSegment[]
  playerInput?: string
  options?: ActionOption[]
  npcs?: NPCMention[]
  itemChanges?: ItemChange[]
  statusChanges?: StatusChange[]
  /** Engine events (e.g. dice roll results) attached to system messages */
  engineEvents?: Array<{ type: string; payload: Record<string, unknown> }>
}

// ─── Game State ───

export type NarrativeStyle = 'concise' | 'balanced'

export type GameState = {
  meta: {
    sessionId: string
    campaignId: string
    worldId?: string
    turn: number
    chapter: number
    narrativeStyle?: NarrativeStyle
    simpleVocabulary?: boolean
  }
  player: {
    characterId: string
    name: string
    attributes: Record<string, number>
    skills: Record<string, number>
    edges: string[]
    hindrances: Hindrance[]
    wounds: number
    maxWounds: number
    fatigue: number
    isShaken: boolean
    bennies: number
    pace: number
    parry: number
    toughness: number
    armor: number
    statusEffects: StatusEffect[]
    inventory: InventoryItem[]
  }
  worldState: {
    activeLocation: string
    worldFlags: Record<string, boolean>
  }
  npcs?: NPCCombatant[]
}

export type NPCCombatant = {
  id: string
  name: string
  /** Nome amigável exibido ao jogador. */
  displayName?: string
  isWildCard: boolean
  wounds: number
  maxWounds: number
  fatigue?: number
  isShaken: boolean
  toughness: number
  parry: number
  armor?: number
  pace?: number
  bennies?: number
  tags?: string[]
  statusEffects?: StatusEffect[]
  disposition?: 'hostile' | 'neutral' | 'friendly'
  location?: string
  /** Condição atual do NPC */
  status?: 'active' | 'incapacitated' | 'defeated' | 'dead'
}

export type DiceRollDetail = {
  sides: number
  rolls: number[]
  total: number
  aced: boolean
  /** Identifica a origem do dado: 'str' = Força, 'weapon' = dano da arma */
  label?: 'str' | 'weapon' | 'bonus'
}

export type TraitTestPayload = {
  trait: string
  dieSides: number
  traitRoll: DiceRollDetail
  wildRoll: DiceRollDetail | null
  modifier: number
  finalTotal: number
  targetNumber?: number
  isSuccess?: boolean
  raises?: number
  description?: string
}

export type SessionEvent = {
  id: string
  turn: number
  type: string
  payload: Record<string, unknown>
}

export type SummaryDoc = {
  summaryText: string
  lastTurnIncluded: number
}
