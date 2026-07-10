// ─── Savage Worlds Core Types ───

import type { InventoryItem } from './narrative.js'

export type DieType = 4 | 6 | 8 | 10 | 12

export const DIE_STEPS: readonly DieType[] = [4, 6, 8, 10, 12] as const

export type AttributeName = 'agility' | 'smarts' | 'spirit' | 'strength' | 'vigor'

export type SWAttributes = Record<AttributeName, DieType>

export type Hindrance = {
  name: string
  severity: 'minor' | 'major'
}

export type StatusEffect = {
  id: string
  name: string
  turnsRemaining?: number
  targetType?: 'player' | 'npc'
  targetId?: string
}

/**
 * Definição canônica de um NPC no catálogo do mundo.
 * Usado pelo NpcService para criar NPCCombatant com stats reais
 * ao invés de stubs genéricos (toughness=4, parry=4).
 */
export type NpcDefinition = {
  id: string
  name: string
  /** Nome amigável exibido ao jogador. Quando ausente, usa-se `name`. */
  displayName?: string
  description?: string
  /** How this NPC acts: temperament, personality traits, behavioral tendencies */
  personality?: string
  /** What drives this NPC's decisions and actions */
  motivation?: string
  /** Distinctive speaking style: tone, vocabulary, speech habits or quirks */
  speechPattern?: string
  isWildCard: boolean
  dispositionDefault: 'hostile' | 'neutral' | 'friendly'
  toughness: number
  parry: number
  armor?: number
  pace?: number
  maxWounds?: number
  bennies?: number
  skills?: Record<string, DieType>
  attributes?: Partial<SWAttributes>
  tags?: string[]
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

/** Mapeia a disposition de cena para o status relacional durável. */
export const DISPOSITION_TO_RELATION: Readonly<
  Record<'hostile' | 'neutral' | 'friendly', RelationalStatus>
> = {
  friendly: 'amigavel',
  neutral: 'neutro',
  hostile: 'hostil'
}

export type NPCCombatant = {
  /** Identificador estável (hash determinístico do displayName). */
  id: string
  /** Alias de `displayName` mantido por retrocompatibilidade. */
  name: string
  /** Nome amigável exibido ao jogador. */
  displayName?: string
  isWildCard: boolean
  attributes: Partial<SWAttributes>
  skills: Record<string, DieType>
  wounds: number
  maxWounds: number
  fatigue: number
  isShaken: boolean
  toughness: number
  parry: number
  armor: number
  pace: number
  bennies: number
  tags?: string[]
  statusEffects?: StatusEffect[]
  disposition?: 'hostile' | 'neutral' | 'friendly'
  location?: string
  /** Condição atual do NPC */
  status?: 'active' | 'incapacitated' | 'defeated' | 'dead'
  /** Dado de ataque do NPC (ex: 6 = d6). Preenchido pelo LLM ao introduzir NPCs hostis. */
  attackSkillDie?: DieType
  /** Fórmula de dano do NPC (ex: "str+d6", "2d6"). Preenchido pelo LLM. */
  damageFormula?: string
  /** Penetração de Armadura do ataque do NPC. */
  ap?: number
  /** How this NPC acts: temperament, personality traits, behavioral tendencies */
  personality?: string
  /** What drives this NPC's decisions and actions */
  motivation?: string
  /** Distinctive speaking style: tone, vocabulary, speech habits or quirks */
  speechPattern?: string
}

export type CombatState = {
  encounterId: string
  round: number
  phase: 'initiative' | 'action' | 'end'
  combatants: NPCCombatant[]
}

export type NarrativeStyle = 'concise' | 'balanced'

export interface GameState {
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
    attributes: SWAttributes
    skills: Record<string, DieType>
    edges: string[]
    hindrances: Hindrance[]
    wounds: number
    maxWounds: number
    fatigue: number
    maxFatigue: number
    isShaken: boolean
    bennies: number
    pace: number
    parry: number
    toughness: number
    armor: number
    statusEffects: StatusEffect[]
    inventory: InventoryItem[]
    /**
     * Chave da arma equipada (referência a WEAPONS). Quando ausente, o motor
     * resolve a arma a partir do inventário (item de categoria "weapon" que
     * combina com o tipo de ataque) ou cai em "desarmado" (dano de Força).
     */
    equippedWeaponKey?: string
  }

  worldState: {
    activeLocation: string
    worldFlags: Record<string, boolean>
  }

  npcs: NPCCombatant[]

  /** IDs de NPCs já incapacitados/derrotados nesta sessão — impede reintrodução pelo narrador */
  defeatedNpcIds: string[]

  combat?: CombatState
}

// ─── Actions ───

export type CalledShotLocation = 'head' | 'vitals' | 'limb'

export type PlayerAction =
  | { type: 'trait_test'; skill?: string; attribute?: string; modifier?: number; description?: string }
  | { type: 'attack'; skill?: string; targetId: string; modifier?: number; damageFormula?: string; ap?: number; calledShot?: CalledShotLocation; hasMoved?: boolean }
  | { type: 'soak_roll' }
  | { type: 'spend_benny'; purpose: 'reroll' | 'soak' | 'unshake' }
  | { type: 'recover_shaken' }
  | { type: 'heal'; targetId?: string; modifier?: number }
  | { type: 'apply_fatigue'; amount: number; reason?: string }
  | { type: 'recover_fatigue'; amount?: number }
  | { type: 'travel'; to: string }
  | { type: 'flag'; key: string; value: boolean }
  | { type: 'custom'; input: string }

export type GameMode = 'exploracao' | 'combat' | 'dialogo'

export type EngineResult = {
  nextState: GameState
  emittedEvents: Array<{ type: string; payload: Record<string, unknown> }>
}
