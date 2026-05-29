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

export type NPCCombatant = {
  id: string
  name: string
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
  /** Dado de ataque do NPC (ex: 6 = d6). Preenchido pelo LLM ao introduzir NPCs hostis. */
  attackSkillDie?: DieType
  /** Fórmula de dano do NPC (ex: "str+d6", "2d6"). Preenchido pelo LLM. */
  damageFormula?: string
  /** Penetração de Armadura do ataque do NPC. */
  ap?: number
}

export type CombatState = {
  encounterId: string
  round: number
  phase: 'initiative' | 'action' | 'end'
  combatants: NPCCombatant[]
}

export interface GameState {
  meta: {
    sessionId: string
    campaignId: string
    worldId?: string
    turn: number
    chapter: number
    narrativeStyle?: 'concise' | 'balanced' | 'theatrical'
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
