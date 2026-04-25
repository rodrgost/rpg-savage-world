// ─── Game Chat / Narrative Types ───
// Tipos para o sistema de chat narrativo do jogo.
// Cada resposta da LLM segue o formato NarratorTurnResponse.

import type { PlayerAction } from './gameState.js'

// ─── Inventário ───

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
  /** Categoria estruturada do item */
  category?: ItemCategory
  /** Tags opcionais para categorização adicional */
  tags?: string[]
}

export type ItemChange = {
  itemId: string
  name: string
  quantity: number
  changeType: 'gained' | 'lost' | 'used'
  /** Categoria do item — obrigatória para veículos e propriedades */
  category?: ItemCategory
}

// ─── Status Effects ───

export type StatusChange = {
  effectId: string
  name: string
  changeType: 'applied' | 'removed'
  turnsRemaining?: number | null
  description: string
}

// ─── NPCs mencionados ───

export type NPCMention = {
  id: string
  name: string
  disposition: 'hostile' | 'neutral' | 'friendly'
  newlyIntroduced: boolean
}

// ─── Dice Check (avaliação de teste de dados) ───

export type DiceCheck = {
  /** Se esta opção exige um teste de dados */
  required: boolean
  /** Nome da perícia Savage Worlds (ex: "Percepção", "Furtividade") */
  skill?: string | null
  /** Nome do atributo se não for perícia (ex: "vigor", "spirit") */
  attribute?: string | null
  /** Modificador situacional (default 0) */
  modifier?: number
  /** Target Number (default 4 em Savage Worlds) */
  tn?: number
  /** Justificativa narrativa para o teste (ex: "A escuridão dificulta a visão") */
  reason: string
}

// ─── Validação de ação custom ───

export type ValidateActionResponse = {
  /** Se a ação é viável dado o contexto atual */
  feasible: boolean
  /** Motivo caso não seja viável */
  feasibilityReason?: string
  /** Se a ação exige um teste de dados antes de ser executada */
  diceCheck?: DiceCheck | null
  /** Tipo de ação mecânica inferida (custom, trait_test, attack, travel) */
  actionType: PlayerAction['type']
  /** Payload parcial para montar o PlayerAction */
  actionPayload: Record<string, unknown>
  /** Breve descrição narrativa da interpretação da ação */
  interpretation: string
}

export type ValidateActionRequest = {
  /** Texto livre digitado pelo jogador */
  input: string
  /** Contexto atual da cena */
  context: {
    summaryText: string
    location: string
    wounds: number
    fatigue: number
    isShaken: boolean
    bennies: number
    npcsPresent: Array<{
      id: string
      name: string
      isWildCard: boolean
      disposition?: 'hostile' | 'neutral' | 'friendly'
      wounds: number
      maxWounds: number
      toughness: number
      parry: number
    }>
    /** IDs de NPCs já derrotados nesta sessão */
    defeatedNpcIds?: string[]
    inventory: InventoryItem[]
    activeStatusEffects: Array<{ id: string; name: string; turnsRemaining?: number }>
    playerSkills?: Record<string, string>
    rulesDigest?: string
  }
  recentMessages: Array<{ role: string; narrative?: string; playerInput?: string; engineEvents?: Array<{ type: string; payload: Record<string, unknown> }> }>
}

// ─── Opções de ação ───

export type ActionOption = {
  id: string
  /** Texto narrativo descritivo da opção */
  text: string
  /** Tipo da ação mecânica correspondente no rule-engine */
  actionType: PlayerAction['type']
  /** Payload parcial para montar o PlayerAction */
  actionPayload: Record<string, unknown>
  /** Itens necessários para esta opção (por itemId) */
  requiredItems?: string[] | null
  /** Se a opção é viável dado o estado atual */
  feasible: boolean
  /** Motivo caso não seja viável */
  feasibilityReason?: string | null
  /** Avaliação de necessidade de teste de dados para esta opção */
  diceCheck?: DiceCheck | null
}

// ─── Resposta completa de um turno narrativo ───

export type NarratorTurnResponse = {
  /** Texto narrativo descrevendo o passo da história */
  narrative: string
  /** Sempre 4 opções de ação para o jogador */
  options: ActionOption[]
  /** NPCs presentes ou mencionados na cena */
  npcs: NPCMention[]
  /** Itens ganhos, perdidos ou usados neste turno */
  itemChanges: ItemChange[]
  /** Efeitos de status aplicados ou removidos */
  statusChanges: StatusChange[]
  /** Nova localização, se houve mudança */
  locationChange?: string | null
  /** Título do capítulo, se mudou */
  chapterTitle?: string | null
  /** true quando o conteúdo é um fallback estático por falha do LLM */
  isFallback?: boolean
}

// ─── Requests para o Narrator ───

export type NarrateStartRequest = {
  world?: {
    name?: string
    description?: string
    lore?: string
  }
  campaign: {
    thematic: string
    storyDescription: string
    name?: string
  }
  character: {
    name: string
    characterClass?: string
    profession?: string
    race?: string
    gender?: string
    description?: string
    edges: string[]
    hindrances: Array<{ name: string; severity: string }>
  }
}

export type NarrateTurnRequest = {
  /** Ação escolhida pelo jogador (texto ou opcionId) */
  playerAction: {
    type: string
    description: string
  }
  /** Resultado mecânico do rule-engine */
  engineEvents: Array<{ type: string; payload: Record<string, unknown> }>
  /** Dados do universo (lore macro) — injetados no systemInstruction */
  world?: {
    name?: string
    description?: string
    lore?: string
  }
  /** Dados da campanha (temática, história) — injetados no systemInstruction */
  campaign?: {
    name?: string
    thematic?: string
    storyDescription?: string
  }
  /** Contexto para a LLM (summary, estado, inventário) */
  context: {
    summaryText: string
    location: string
    wounds: number
    fatigue: number
    isShaken: boolean
    bennies: number
    npcsPresent: Array<{
      id: string
      name: string
      isWildCard: boolean
      disposition?: 'hostile' | 'neutral' | 'friendly'
      wounds: number
      maxWounds: number
      toughness: number
      parry: number
    }>
    /** IDs de NPCs já derrotados nesta sessão */
    defeatedNpcIds?: string[]
    inventory: InventoryItem[]
    activeStatusEffects: Array<{ id: string; name: string; turnsRemaining?: number }>
    /** Perícias do personagem com seus dados atuais (ex: { "Percepção": "d6", "Luta": "d8" }) */
    playerSkills?: Record<string, string>
    /** Digest compacto das regras do jogo + traços do personagem */
    rulesDigest?: string
  }
  recentMessages: Array<{ role: string; narrative?: string; playerInput?: string; engineEvents?: Array<{ type: string; payload: Record<string, unknown> }> }>
}
