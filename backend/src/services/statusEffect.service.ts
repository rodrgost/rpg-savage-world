import type { GameState, NPCCombatant, PlayerAction, StatusEffect } from '../domain/types/gameState.js'
import type { StatusChange } from '../domain/types/narrative.js'

type StatusTarget = { type: 'player' } | { type: 'npc'; targetId: string }

const LONG_TIME_PATTERN = /\b(dia|dias|semana|semanas|mes|meses|ano|anos|noite|noites)\b/i
const MEDICAL_LONG_RECOVERY_PATTERN = /\b(hospital|interna|internado|internada|internacao|internação|alta|tratamento prolongado|reabilitacao|reabilitação|convalescenca|convalescença)\b/i
const RECOVERY_CONTEXT_PATTERN = /\b(hospital|interna|internado|internada|internacao|internação|alta|repouso|tratamento|reabilitacao|reabilitação|recupera|recuperacao|recuperação|convalescenca|convalescença|descanso|curar|cura|medico|médico|medica|médica)\b/i
const STRONG_RECOVERY_PATTERN = /\b(mes|meses|semanas|hospital|interna|internado|internada|internacao|internação|alta|tratamento prolongado|reabilitacao|reabilitação)\b/i
const PERSISTENT_STATUS_PATTERN = /\b(permanente|cronico|crônico|amputad|cicatriz|maldicao|maldição|curse|cursed|missing|perdido|mutilad)\b/i
const TEMPORARY_STATUS_PATTERN = /\b(abalad|atordo|tonto|sangr|ferid|machuc|lesao|lesão|fratura|queimad|venen|doenc|doenç|febre|infect|hospital|intern|fadiga|exaust|cansad|inconsciente|coma|sedad|paralis|cego|surdo|medo|panico|pânico|fobia|enjo|nause|náuse|dor|trauma|choque|stun|shaken|wound|poison|burn|bleed|fatigue|exhaust|fear|panic|sick|disease|injur|hospitalized)\b/i

function normalizeRecoveryText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function hasLongRecoverySignal(text: string): boolean {
  const normalized = normalizeRecoveryText(text)
  return MEDICAL_LONG_RECOVERY_PATTERN.test(normalized)
    || (LONG_TIME_PATTERN.test(normalized) && RECOVERY_CONTEXT_PATTERN.test(normalized))
}

function hasStrongRecoverySignal(text: string): boolean {
  const normalized = normalizeRecoveryText(text)
  return hasLongRecoverySignal(normalized) && STRONG_RECOVERY_PATTERN.test(normalized)
}

function isRecoverableStatusEffect(effect: StatusEffect, removeBroadTemporaryEffects: boolean): boolean {
  const key = normalizeRecoveryText(`${effect.id} ${effect.name}`)
  if (PERSISTENT_STATUS_PATTERN.test(key)) return false
  if (effect.turnsRemaining !== undefined) return true
  return removeBroadTemporaryEffects || TEMPORARY_STATUS_PATTERN.test(key)
}

function recoverStatusEffects(currentEffects: StatusEffect[] | undefined, removeBroadTemporaryEffects: boolean): StatusEffect[] {
  return (currentEffects ?? []).filter((effect) => !isRecoverableStatusEffect(effect, removeBroadTemporaryEffects))
}

function normalizeTurnsRemaining(turnsRemaining: number | null | undefined): number | undefined {
  return typeof turnsRemaining === 'number' ? turnsRemaining : undefined
}

function applyChangeToEffects(
  currentEffects: StatusEffect[] | undefined,
  change: StatusChange,
  target: StatusTarget
): StatusEffect[] {
  const effects = [...(currentEffects ?? [])].map((effect) => ({ ...effect }))
  const targetId = target.type === 'npc' ? target.targetId : undefined

  if (change.changeType === 'applied') {
    const existing = effects.find((effect) => effect.id === change.effectId || effect.name === change.name)
    if (existing) {
      existing.targetType = target.type
      if (targetId) existing.targetId = targetId
      else delete existing.targetId

      const turnsRemaining = normalizeTurnsRemaining(change.turnsRemaining)
      if (turnsRemaining !== undefined) existing.turnsRemaining = turnsRemaining
      else delete existing.turnsRemaining
    } else {
      const effect: StatusEffect = {
        id: change.effectId,
        name: change.name,
        targetType: target.type
      }
      if (targetId) effect.targetId = targetId

      const turnsRemaining = normalizeTurnsRemaining(change.turnsRemaining)
      if (turnsRemaining !== undefined) effect.turnsRemaining = turnsRemaining
      effects.push(effect)
    }
  } else {
    const idx = effects.findIndex((effect) => effect.id === change.effectId || effect.name === change.name)
    if (idx >= 0) effects.splice(idx, 1)
  }

  return effects
}

function tickEffectList(currentEffects: StatusEffect[] | undefined): StatusEffect[] {
  return (currentEffects ?? [])
    .map<StatusEffect>((effect) => {
      if (effect.turnsRemaining !== undefined) {
        return { ...effect, turnsRemaining: effect.turnsRemaining - 1 }
      }
      const { turnsRemaining: _, ...rest } = effect
      return rest
    })
    .filter((effect) => effect.turnsRemaining === undefined || effect.turnsRemaining > 0)
}

function updateNpcStatusEffects(
  npcs: NPCCombatant[],
  targetId: string,
  updater: (effects: StatusEffect[] | undefined) => StatusEffect[]
): NPCCombatant[] {
  return npcs.map((npc) => (
    npc.id === targetId
      ? { ...npc, statusEffects: updater(npc.statusEffects) }
      : npc
  ))
}

/** Serviço para gerenciar efeitos de status narrativos no jogador e em NPCs. */
export class StatusEffectService {
  private resolveTarget(state: GameState, change: StatusChange, action?: PlayerAction): StatusTarget | null {
    if (change.targetType === 'player') return { type: 'player' }

    if (change.targetType === 'npc') {
      const targetId = typeof change.targetId === 'string' ? change.targetId.trim() : ''
      if (targetId) return { type: 'npc', targetId }
    }

    if (action?.type === 'attack') {
      const targetId = action.targetId.trim()
      const targetExists = state.npcs.some((npc) => npc.id === targetId)
        || state.combat?.combatants.some((npc) => npc.id === targetId)
      if (targetExists) return { type: 'npc', targetId }
    }

    return { type: 'player' }
  }

  /**
   * Aplica mudanças de status vindas da narrativa da LLM.
   * - applied: adiciona o efeito ou atualiza duração
   * - removed: remove o efeito
   */
  applyStatusChanges(state: GameState, changes: StatusChange[], options?: { action?: PlayerAction }): GameState {
    if (!changes.length) return state

    let nextState = state

    for (const change of changes) {
      const target = this.resolveTarget(nextState, change, options?.action)
      if (!target) continue

      if (target.type === 'player') {
        nextState = {
          ...nextState,
          player: {
            ...nextState.player,
            statusEffects: applyChangeToEffects(nextState.player.statusEffects, change, target)
          }
        }
      } else {
        const updater = (effects: StatusEffect[] | undefined) => applyChangeToEffects(effects, change, target)
        nextState = {
          ...nextState,
          npcs: updateNpcStatusEffects(nextState.npcs, target.targetId, updater),
          combat: nextState.combat
            ? {
                ...nextState.combat,
                combatants: updateNpcStatusEffects(nextState.combat.combatants, target.targetId, updater)
              }
            : nextState.combat
        }
      }
    }

    return nextState
  }

  /**
   * Decrementa turnsRemaining de todos os efeitos e remove expirados.
   * Deve ser chamado a cada turno.
   */
  tickEffects(state: GameState): GameState {
    return {
      ...state,
      player: {
        ...state.player,
        statusEffects: tickEffectList(state.player.statusEffects)
      },
      npcs: state.npcs.map((npc) => ({
        ...npc,
        statusEffects: tickEffectList(npc.statusEffects)
      })),
      combat: state.combat
        ? {
            ...state.combat,
            combatants: state.combat.combatants.map((npc) => ({
              ...npc,
              statusEffects: tickEffectList(npc.statusEffects)
            }))
          }
        : state.combat
    }
  }

  applyNarrativeRecovery(state: GameState, params: { actionText?: string; narrative?: string }): GameState {
    const text = [params.actionText, params.narrative].filter(Boolean).join('\n')
    if (!hasLongRecoverySignal(text)) return state

    const removeBroadTemporaryEffects = hasStrongRecoverySignal(text)

    return {
      ...state,
      player: {
        ...state.player,
        wounds: removeBroadTemporaryEffects ? 0 : state.player.wounds,
        fatigue: 0,
        isShaken: false,
        statusEffects: recoverStatusEffects(state.player.statusEffects, removeBroadTemporaryEffects)
      },
      npcs: state.npcs.map((npc) => ({
        ...npc,
        statusEffects: recoverStatusEffects(npc.statusEffects, removeBroadTemporaryEffects)
      })),
      combat: state.combat
        ? {
            ...state.combat,
            combatants: state.combat.combatants.map((npc) => ({
              ...npc,
              statusEffects: recoverStatusEffects(npc.statusEffects, removeBroadTemporaryEffects)
            }))
          }
        : state.combat
    }
  }

  /** Retorna efeitos ativos */
  getActiveEffects(state: GameState): StatusEffect[] {
    return state.player.statusEffects
  }
}
