import type { GameState, StatusEffect } from '../domain/types/gameState.js'
import type { StatusChange } from '../domain/types/narrative.js'

/**
 * Serviço para gerenciar efeitos de status narrativos no jogador.
 * Trabalha com o array statusEffects existente no GameState.
 */
export class StatusEffectService {
  /**
   * Aplica mudanças de status vindas da narrativa da LLM.
   * - applied: adiciona o efeito ou atualiza duração
   * - removed: remove o efeito
   */
  applyStatusChanges(state: GameState, changes: StatusChange[]): GameState {
    if (!changes.length) return state

    const effects = [...state.player.statusEffects].map((e) => ({ ...e }))

    for (const change of changes) {
      if (change.changeType === 'applied') {
        const existing = effects.find((e) => e.id === change.effectId || e.name === change.name)
        if (existing) {
          // Atualiza duração
          if (typeof change.turnsRemaining === 'number') {
            existing.turnsRemaining = change.turnsRemaining
          } else {
            delete existing.turnsRemaining
          }
        } else {
          const eff: { id: string; name: string; turnsRemaining?: number } = {
            id: change.effectId,
            name: change.name
          }
          if (typeof change.turnsRemaining === 'number') {
            eff.turnsRemaining = change.turnsRemaining
          }
          effects.push(eff)
        }
      } else {
        // removed
        const idx = effects.findIndex((e) => e.id === change.effectId || e.name === change.name)
        if (idx >= 0) effects.splice(idx, 1)
      }
    }

    return {
      ...state,
      player: {
        ...state.player,
        statusEffects: effects
      }
    }
  }

  /**
   * Decrementa turnsRemaining de todos os efeitos e remove expirados.
   * Deve ser chamado a cada turno.
   */
  tickEffects(state: GameState): GameState {
    const effects = state.player.statusEffects
      .map((e) => {
        if (e.turnsRemaining !== undefined) {
          return { ...e, turnsRemaining: e.turnsRemaining - 1 }
        }
        // Sem duração: efeito permanente
        const { turnsRemaining: _, ...rest } = e
        return rest as typeof e
      })
      .filter((e) => e.turnsRemaining === undefined || e.turnsRemaining > 0)

    return {
      ...state,
      player: {
        ...state.player,
        statusEffects: effects
      }
    }
  }

  /** Retorna efeitos ativos */
  getActiveEffects(state: GameState): StatusEffect[] {
    return state.player.statusEffects
  }
}
