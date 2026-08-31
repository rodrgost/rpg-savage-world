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

export type WorldGuideGlossaryTerm = {
  term: string
  definition: string
  preferredUsage?: string
  avoidTerms?: string[]
}

export type WorldGuideFaction = {
  name: string
  role: string
  publicFace: string
  powerBase: string
  relationships: string[]
}

export type WorldGuide = {
  llmPersona: {
    role: string
    perspective: string
    knowledgeLimits: string
  }
  universeRules: {
    magicAndPowers: string[]
    technology: string[]
    impossibilities: string[]
    costsAndLimits: string[]
  }
  glossary: {
    terms: WorldGuideGlossaryTerm[]
    forbiddenGenericTerms: string[]
  }
  factionsAndPower: {
    groups: WorldGuideFaction[]
    socialTensions: string[]
    speciesAndCultures: string[]
  }
  knowledgeHorizon: {
    currentMoment: string
    knownFacts: string[]
    unknownOrSpoilerFacts: string[]
  }
  geography: {
    immediateSetting: string
    keyLocations: string[]
    sensoryTexture: string
  }
  mood: {
    tone: string
    emotionalPalette: string
    languageStyle: string
    avoidStyle: string
  }
}

function renderList(items: string[] | undefined, empty = 'Não definido.'): string {
  const lines = (items ?? []).map((item) => item.trim()).filter(Boolean)
  if (!lines.length) return empty
  return lines.map((item) => `- ${item}`).join('\n')
}

export function renderWorldGuideMarkdown(worldGuide: WorldGuide | undefined): string {
  if (!worldGuide) return ''

  const glossaryTerms = worldGuide.glossary.terms.length
    ? worldGuide.glossary.terms
      .map((entry) => {
        const usage = entry.preferredUsage ? ` Uso preferido: ${entry.preferredUsage}.` : ''
        const avoidTerms = entry.avoidTerms?.length ? ` Evitar: ${entry.avoidTerms.join(', ')}.` : ''
        return `- ${entry.term}: ${entry.definition}.${usage}${avoidTerms}`
      })
      .join('\n')
    : 'Não definido.'

  const factions = worldGuide.factionsAndPower.groups.length
    ? worldGuide.factionsAndPower.groups
      .map((group) => `- ${group.name}: ${group.role}. Face pública: ${group.publicFace}. Base de poder: ${group.powerBase}. Relações: ${group.relationships.join('; ') || 'não definidas'}.`)
      .join('\n')
    : 'Não definido.'

  return [
    '## Persona e Perspectiva do LLM',
    `- Papel: ${worldGuide.llmPersona.role}`,
    `- Perspectiva: ${worldGuide.llmPersona.perspective}`,
    `- Limites de conhecimento: ${worldGuide.llmPersona.knowledgeLimits}`,
    '',
    '## Regras do Universo',
    '### Magia e poderes',
    renderList(worldGuide.universeRules.magicAndPowers),
    '### Tecnologia',
    renderList(worldGuide.universeRules.technology),
    '### Impossibilidades',
    renderList(worldGuide.universeRules.impossibilities),
    '### Custos e limites',
    renderList(worldGuide.universeRules.costsAndLimits),
    '',
    '## Glossário e Jargões Locais',
    glossaryTerms,
    '### Termos genéricos proibidos',
    renderList(worldGuide.glossary.forbiddenGenericTerms),
    '',
    '## Facções, Raças e Dinâmicas de Poder',
    factions,
    '### Tensões sociais',
    renderList(worldGuide.factionsAndPower.socialTensions),
    '### Espécies e culturas',
    renderList(worldGuide.factionsAndPower.speciesAndCultures),
    '',
    '## Linha do Tempo e Momento Atual',
    `- Momento atual: ${worldGuide.knowledgeHorizon.currentMoment}`,
    '### Fatos conhecidos',
    renderList(worldGuide.knowledgeHorizon.knownFacts),
    '### Fatos desconhecidos ou spoilers proibidos',
    renderList(worldGuide.knowledgeHorizon.unknownOrSpoilerFacts),
    '',
    '## Geografia e Cenário Imediato',
    `- Cenário imediato: ${worldGuide.geography.immediateSetting}`,
    '### Locais-chave',
    renderList(worldGuide.geography.keyLocations),
    `- Textura sensorial: ${worldGuide.geography.sensoryTexture}`,
    '',
    '## Tom e Atmosfera',
    `- Tom: ${worldGuide.mood.tone}`,
    `- Paleta emocional: ${worldGuide.mood.emotionalPalette}`,
    `- Estilo de linguagem: ${worldGuide.mood.languageStyle}`,
    `- Evitar: ${worldGuide.mood.avoidStyle}`
  ].join('\n')
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
  worldGuide?: WorldGuide
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
  /** Bônus de Resistência quando equipado como armadura corporal */
  armorValue?: number
  /** Bônus de Aparar quando equipado como escudo */
  parryBonus?: number
}

export type ItemChange = {
  itemId: string
  name: string
  quantity: number
  changeType: 'gained' | 'lost' | 'used'
  /** Descrição do que o item é / o que contém / para que serve — presente em itens não óbvios */
  description?: string
  category?: ItemCategory
  armorValue?: number
  parryBonus?: number
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
  status?: 'active' | 'incapacitated' | 'defeated' | 'dead' | 'left'
  /** Indica se o NPC acompanha o jogador em viagens. */
  followsPlayer?: boolean
  /** Mudança na relação do NPC com o personagem do jogador (omitir se inalterada) */
  relation?: Exclude<RelationalStatus, 'desconhecido'>
}

/**
 * Status da relação de um NPC com o personagem do jogador.
 * `desconhecido` é implícito (NPC ausente do registro) e nunca é gravado.
 */
export type RelationalStatus =
  | 'desconhecido'
  | 'conhecido'
  | 'aliado'
  | 'amigavel'
  | 'neutro'
  | 'desconfiado'
  | 'hostil'
  | 'inimigo'

/** Registro durável de um NPC conhecido pelo personagem (characters/{id}/knownNpcs). */
export type KnownNpc = {
  id: string
  npcId: string
  /** displayName do NPC no último avistamento */
  name: string
  relationalStatus: RelationalStatus
  /** Edição manual vence sobre atualizações do narrador */
  relationSource: 'auto' | 'manual'
  notes?: string
  disposition?: 'hostile' | 'neutral' | 'friendly'
  conditionStatus?: 'active' | 'incapacitated' | 'defeated' | 'dead' | 'left'
  followsPlayer?: boolean
  lastKnownLocation?: string
  isCatalogNpc?: boolean
  lastSessionId?: string
  firstMetAt?: unknown
  lastSeenAt?: unknown
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

export type ChanceCheck = {
  required: boolean
  /** Estimativa percentual (0–100) de sucesso — presente apenas quando required=true */
  successChance?: number | null
  reason: string
}

/** @deprecated Use ChanceCheck */
export type DiceCheck = ChanceCheck

export type ActionOption = {
  id: string
  text: string
  playerSpeech?: string | null
  actionType: string
  actionPayload: Record<string, unknown>
  diceCheck?: ChanceCheck | null
}

export type ValidateActionResponse = {
  feasible: boolean
  feasibilityReason?: string
  diceCheck?: ChanceCheck | null
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
    equippedAttackItemId?: string
    equippedArmorItemId?: string
    equippedShieldItemId?: string
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
  status?: 'active' | 'incapacitated' | 'defeated' | 'dead' | 'left'
  followsPlayer?: boolean
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
