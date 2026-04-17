export type StatusEffect = {
  id: string
  name: string
  turnsRemaining?: number
}

export type NPC = {
  id: string
  name: string
  tags?: string[]
  disposition?: 'hostile' | 'neutral' | 'friendly'
  location?: string
  state?: Record<string, unknown>
}

export type CombatState = {
  encounterId: string
  round: number
  phase: 'start' | 'player' | 'enemy' | 'end'
  enemies: Array<{ id: string; name: string; hp: number }>
}

export interface GameState {
  meta: {
    sessionId: string
    campaignId: string
    worldId?: string
    turn: number
    chapter: number
  }

  player: {
    characterId: string
    attributes: Record<string, number>
    hp: number
    statusEffects: StatusEffect[]
  }

  worldState: {
    activeLocation: string
    worldFlags: Record<string, boolean>
  }

  npcs: NPC[]

  combat?: CombatState
}

export type PlayerAction =
  | { type: 'travel'; to: string }
  | { type: 'flag'; key: string; value: boolean }
  | { type: 'damage'; amount: number }
  | { type: 'custom'; input: string }

export type EngineResult = {
  nextState: GameState
  emittedEvents: Array<{ type: string; payload: Record<string, unknown> }>
}
