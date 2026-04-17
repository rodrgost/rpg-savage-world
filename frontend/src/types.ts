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

export type Campaign = {
  id: string
  worldId: string
  ownerId: string
  ownerProfile?: OwnerProfile
  visibility: Visibility
  name?: string
  thematic: string
  storyDescription: string
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
  characterClass?: string
  profession?: string
  description?: string
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

export type InventoryItem = {
  id: string
  name: string
  description: string
  quantity: number
  tags?: string[]
}

export type ItemChange = {
  itemId: string
  name: string
  quantity: number
  changeType: 'gained' | 'lost' | 'used'
}

export type StatusChange = {
  effectId: string
  name: string
  changeType: 'applied' | 'removed'
  turnsRemaining?: number
  description: string
}

export type NPCMention = {
  id: string
  name: string
  disposition: 'hostile' | 'neutral' | 'friendly'
  newlyIntroduced: boolean
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
  actionType: string
  actionPayload: Record<string, unknown>
  requiredItems?: string[]
  feasible: boolean
  feasibilityReason?: string
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
  narrative: string
  options: ActionOption[]
  npcs: NPCMention[]
  itemChanges: ItemChange[]
  statusChanges: StatusChange[]
  locationChange?: string
  chapterTitle?: string
}

export type ChatMessage = {
  messageId: string
  sessionId: string
  turn: number
  /** Sequência incremental — garante ordem determinística */
  seq?: number
  role: 'narrator' | 'player' | 'system'
  narrative?: string
  playerInput?: string
  options?: ActionOption[]
  npcs?: NPCMention[]
  itemChanges?: ItemChange[]
  statusChanges?: StatusChange[]
  /** Engine events (e.g. dice roll results) attached to system messages */
  engineEvents?: Array<{ type: string; payload: Record<string, unknown> }>
}

// ─── Game State ───

export type GameState = {
  meta: {
    sessionId: string
    campaignId: string
    worldId?: string
    turn: number
    chapter: number
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
    statusEffects: Array<{ id: string; name: string; turnsRemaining?: number }>
    inventory: InventoryItem[]
  }
  worldState: {
    activeLocation: string
    worldFlags: Record<string, boolean>
  }
}

export type DiceRollDetail = {
  sides: number
  rolls: number[]
  total: number
  aced: boolean
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
  historySummaryText?: string
}
