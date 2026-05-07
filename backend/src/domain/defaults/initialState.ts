import type { DieType, GameState, Hindrance, SWAttributes } from '../types/gameState.js'
import { DIE_STEPS } from '../types/gameState.js'
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

  // elderly / Idoso: -1 step em Agilidade, Força e Vigor
  if (hindrances.some((h) => h.name === 'elderly' || h.name === 'Idoso')) {
    const stepDown = (die: DieType): DieType => {
      const idx = DIE_STEPS.indexOf(die)
      return idx > 0 ? DIE_STEPS[idx - 1] : DIE_STEPS[0]
    }
    attributes.agility = stepDown(attributes.agility)
    attributes.strength = stepDown(attributes.strength)
    attributes.vigor = stepDown(attributes.vigor)
  }

  const fightingDie = resolveSkillDie(skills, 'Luta') ?? 0
  const pace = calcPace(edges, hindrances)
  const parry = calcParry(fightingDie as DieType | 0, edges)
  const toughness = calcToughness(attributes.vigor, armor, edges, hindrances)

  // Ajusta Bennies iniciais por Vantagens/Complicações
  const startingBennies = Math.max(
    0,
    CHARACTER_CREATION.startingBennies
      + (edges.some((e) => e === 'luck' || e === 'Sortudo') ? 1 : 0)
      + (edges.some((e) => e === 'young' || e === 'Jovem') ? 1 : 0)
      + (hindrances.some((h) => h.name === 'badLuck' || h.name === 'Azarado') ? -1 : 0)
  )

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
      bennies: startingBennies,
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
    npcs: [],
    defeatedNpcIds: []
  }
}
