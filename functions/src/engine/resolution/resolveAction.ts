import type { EngineResult, GameState, PlayerAction } from '../../domain/types/gameState.js'

// Stateless + determinístico. Regras dinâmicas (RuleSet JSON) vão entrar aqui depois.
export function resolveAction(state: GameState, action: PlayerAction): EngineResult {
  const emittedEvents: EngineResult['emittedEvents'] = []
  const nextState: GameState = structuredClone(state)

  nextState.meta.turn = state.meta.turn + 1

  switch (action.type) {
    case 'travel': {
      const from = nextState.worldState.activeLocation
      nextState.worldState.activeLocation = action.to
      emittedEvents.push({ type: 'location_change', payload: { from, to: action.to } })
      break
    }
    case 'flag': {
      nextState.worldState.worldFlags[action.key] = action.value
      emittedEvents.push({ type: 'world_flag', payload: { key: action.key, value: action.value } })
      break
    }
    case 'damage': {
      nextState.player.hp = Math.max(0, nextState.player.hp - action.amount)
      emittedEvents.push({ type: 'player_hp_change', payload: { delta: -action.amount } })
      break
    }
    case 'custom': {
      emittedEvents.push({ type: 'custom_action', payload: { input: action.input } })
      break
    }
  }

  return { nextState, emittedEvents }
}
