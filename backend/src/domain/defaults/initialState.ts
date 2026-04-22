import type { DieType, GameState, Hindrance, SWAttributes } from '../types/gameState.js'
import {
  calcPace,
  calcParry,
  calcToughness,
  CHARACTER_CREATION,
  defaultAttributes,
  resolveSkillDie
} from '../savage-worlds/constants.js'

export type CharacterInput = {
  characterId: string
  attributes?: Partial<SWAttributes>
  skills?: Record<string, DieType>
  edges?: string[]
  hindrances?: Hindrance[]
  armor?: number
}

export function createInitialState(params: { sessionId: string; campaignId: string; worldId?: string; character?: CharacterInput }): GameState {
  const char = params.character
  const attributes: SWAttributes = { ...defaultAttributes(), ...(char?.attributes ?? {}) }
  const skills: Record<string, DieType> = { ...(char?.skills ?? {}) }
  const edges = char?.edges ?? []
  const hindrances = char?.hindrances ?? []
  const armor = char?.armor ?? 0

  const fightingDie = resolveSkillDie(skills, 'Luta') ?? 0
  const pace = calcPace(edges, hindrances)
  const parry = calcParry(fightingDie as DieType | 0, edges)
  const toughness = calcToughness(attributes.vigor, armor, edges, hindrances)

  return {
    meta: {
      sessionId: params.sessionId,
      campaignId: params.campaignId,
      ...(params.worldId ? { worldId: params.worldId } : {}),
      turn: 0,
      chapter: 1
    },
    player: {
      characterId: char?.characterId ?? '',
      attributes,
      skills,
      edges,
      hindrances,
      wounds: 0,
      maxWounds: CHARACTER_CREATION.maxWounds,
      fatigue: 0,
      maxFatigue: CHARACTER_CREATION.maxFatigue,
      isShaken: false,
      bennies: CHARACTER_CREATION.startingBennies,
      pace,
      parry,
      toughness,
      armor,
      statusEffects: [],
      inventory: []
    },
    worldState: {
      activeLocation: 'inicio',
      worldFlags: {}
    },
    npcs: []
  }
}
