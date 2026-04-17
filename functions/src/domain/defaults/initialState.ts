import type { GameState } from '../types/gameState.js'

export function createInitialState(params: {
  sessionId: string
  campaignId: string
  characterId: string
  worldId?: string
}): GameState {
  return {
    meta: {
      sessionId: params.sessionId,
      campaignId: params.campaignId,
      worldId: params.worldId,
      turn: 0,
      chapter: 1
    },
    player: {
      characterId: params.characterId,
      attributes: {
        forca: 1,
        habilidade: 1,
        resistencia: 1,
        armadura: 0,
        poderFogo: 0
      },
      hp: 10,
      statusEffects: []
    },
    worldState: {
      activeLocation: 'inicio',
      worldFlags: {}
    },
    npcs: []
  }
}
