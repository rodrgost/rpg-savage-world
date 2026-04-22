import type { DieType, EngineResult, GameState, NPCCombatant, PlayerAction } from '../domain/types/gameState.js'
import { getCanonicalSkillLabel, resolveSkillDie } from '../domain/savage-worlds/constants.js'
import { rollTrait, rollDamage, countRaises } from './dice-engine.js'

// ─── Savage Worlds Rule Engine ───

function getSkillDie(state: GameState, skillName: string): DieType {
  return resolveSkillDie(state.player.skills, skillName) ?? 4
}

function getAttributeDie(state: GameState, attrName: string): DieType {
  const attrs = state.player.attributes as Record<string, DieType | undefined>
  return attrs[attrName] ?? 4
}

function findNPC(state: GameState, targetId: string): NPCCombatant | undefined {
  return state.npcs.find((n) => n.id === targetId) ?? state.combat?.combatants.find((c) => c.id === targetId)
}

function woundPenalty(wounds: number): number {
  return -Math.min(wounds, 3)
}

function applyShaken(target: { isShaken: boolean; wounds: number; maxWounds: number }): { wasAlreadyShaken: boolean; woundsApplied: number } {
  if (!target.isShaken) {
    target.isShaken = true
    return { wasAlreadyShaken: false, woundsApplied: 0 }
  }
  // Já Shaken → aplica 1 Wound
  target.wounds = Math.min(target.wounds + 1, target.maxWounds + 1)
  return { wasAlreadyShaken: true, woundsApplied: 1 }
}

function resolveDamageVsToughness(damage: number, toughness: number): { shaken: boolean; wounds: number } {
  if (damage < toughness) return { shaken: false, wounds: 0 }

  const excess = damage - toughness
  const raises = Math.floor(excess / 4)

  return { shaken: true, wounds: raises }
}

export function applyAction(state: GameState, action: PlayerAction): EngineResult {
  const emittedEvents: EngineResult['emittedEvents'] = []
  const nextState: GameState = structuredClone(state)
  nextState.meta.turn = state.meta.turn + 1

  switch (action.type) {
    // ─── Trait Test ───
    case 'trait_test': {
      const skillName = getCanonicalSkillLabel(action.skill)
      const traitName = skillName ?? action.attribute ?? 'Percepção'
      const traitDie = skillName
        ? getSkillDie(nextState, skillName)
        : action.attribute
          ? getAttributeDie(nextState, action.attribute)
          : 4 as DieType
      const penalty = woundPenalty(nextState.player.wounds)
      const modifier = (action.modifier ?? 0) + penalty
      const tn = 4

      const result = rollTrait(traitDie, true, modifier)

      emittedEvents.push({
        type: 'trait_test',
        payload: {
          trait: traitName,
          dieSides: traitDie,
          traitRoll: result.traitRoll,
          wildRoll: result.wildRoll,
          modifier,
          finalTotal: result.finalTotal,
          targetNumber: tn,
          isSuccess: result.finalTotal >= tn,
          raises: countRaises(result.finalTotal, tn),
          description: action.description
        }
      })
      break
    }

    // ─── Attack ───
    case 'attack': {
      const target = findNPC(nextState, action.targetId)
      if (!target) {
        emittedEvents.push({ type: 'attack_target_not_found', payload: { targetId: action.targetId } })
        break
      }

      const attackSkill = getCanonicalSkillLabel(action.skill) ?? 'Luta'
      const attackDie = getSkillDie(nextState, attackSkill)
      const penalty = woundPenalty(nextState.player.wounds)
      const attackModifier = (action.modifier ?? 0) + penalty
      const attackTN = target.parry
      const ap = action.ap ?? 0

      const attackResult = rollTrait(attackDie, true, attackModifier)

      if (attackResult.finalTotal < attackTN) {
        emittedEvents.push({
          type: 'attack_miss',
          payload: {
            targetId: target.id,
            targetName: target.name,
            skill: attackSkill,
            attackRoll: attackResult.finalTotal,
            targetParry: attackTN,
            traitRoll: attackResult.traitRoll,
            wildRoll: attackResult.wildRoll
          }
        })
        break
      }

      // Hit → roll damage
      const damageFormula = action.damageFormula ?? 'str+d6'
      const strengthDie = nextState.player.attributes.strength
      const attackRaises = countRaises(attackResult.finalTotal, attackTN)

      const damageResult = rollDamage(damageFormula, strengthDie)
      // Raise bonus: +1d6 per raise on attack
      let raiseBonusDamage = 0
      if (attackRaises > 0) {
        for (let i = 0; i < attackRaises; i++) {
          raiseBonusDamage += rollExplodingInline(6)
        }
      }

      const totalDamage = damageResult.total + raiseBonusDamage
      const effectiveToughness = Math.max(0, target.toughness - ap)
      const dmgResult = resolveDamageVsToughness(totalDamage, effectiveToughness)

      if (dmgResult.shaken || dmgResult.wounds > 0) {
        if (dmgResult.wounds > 0) {
          target.wounds = Math.min(target.wounds + dmgResult.wounds, target.maxWounds + 1)
          target.isShaken = true
        } else {
          applyShaken(target)
        }
      }

      const isIncapacitated = target.wounds > target.maxWounds

      emittedEvents.push({
        type: 'attack_hit',
        payload: {
          targetId: target.id,
          targetName: target.name,
          skill: attackSkill,
          attackRoll: attackResult.finalTotal,
          targetParry: attackTN,
          attackRaises,
          damageTotal: totalDamage,
          raiseBonusDamage,
          targetToughness: target.toughness,
          woundsInflicted: dmgResult.wounds,
          targetShaken: target.isShaken,
          targetWounds: target.wounds,
          targetIncapacitated: isIncapacitated,
          traitRoll: attackResult.traitRoll,
          wildRoll: attackResult.wildRoll,
          damageRolls: damageResult.dice
        }
      })
      break
    }

    // ─── Soak Roll (Vigor test to absorb wounds, costs 1 Benny) ───
    case 'soak_roll': {
      if (nextState.player.bennies <= 0) {
        emittedEvents.push({ type: 'no_bennies', payload: { action: 'soak_roll' } })
        break
      }

      nextState.player.bennies -= 1
      const vigorDie = nextState.player.attributes.vigor
      const soakResult = rollTrait(vigorDie, true)

      let woundsSoaked = 0
      if (soakResult.isSuccess) {
        woundsSoaked = 1 + soakResult.raises
        nextState.player.wounds = Math.max(0, nextState.player.wounds - woundsSoaked)
      }

      // Soak can also remove Shaken
      if (soakResult.isSuccess && nextState.player.isShaken && nextState.player.wounds === 0) {
        nextState.player.isShaken = false
      }

      emittedEvents.push({
        type: 'soak_roll',
        payload: {
          vigorDie,
          traitRoll: soakResult.traitRoll,
          wildRoll: soakResult.wildRoll,
          finalTotal: soakResult.finalTotal,
          isSuccess: soakResult.isSuccess,
          woundsSoaked,
          remainingWounds: nextState.player.wounds,
          remainingBennies: nextState.player.bennies,
          shakenRemoved: !nextState.player.isShaken
        }
      })
      break
    }

    // ─── Spend Benny ───
    case 'spend_benny': {
      if (nextState.player.bennies <= 0) {
        emittedEvents.push({ type: 'no_bennies', payload: { action: action.purpose } })
        break
      }

      nextState.player.bennies -= 1

      if (action.purpose === 'unshake') {
        nextState.player.isShaken = false
        emittedEvents.push({
          type: 'benny_spent',
          payload: { purpose: 'unshake', remainingBennies: nextState.player.bennies, shakenRemoved: true }
        })
      } else if (action.purpose === 'reroll') {
        // Re-roll é feito no frontend pela próxima ação — aqui só registra o gasto
        emittedEvents.push({
          type: 'benny_spent',
          payload: { purpose: 'reroll', remainingBennies: nextState.player.bennies }
        })
      } else if (action.purpose === 'soak') {
        // Soak é um caso especial (usar soak_roll action)
        emittedEvents.push({
          type: 'benny_spent',
          payload: { purpose: 'soak', remainingBennies: nextState.player.bennies }
        })
      }
      break
    }

    // ─── Recover from Shaken (Spirit roll at start of turn) ───
    case 'recover_shaken': {
      if (!nextState.player.isShaken) {
        emittedEvents.push({ type: 'not_shaken', payload: {} })
        break
      }

      const spiritDie = nextState.player.attributes.spirit
      const penalty = woundPenalty(nextState.player.wounds)
      const recoverResult = rollTrait(spiritDie, true, penalty)

      if (recoverResult.isSuccess) {
        nextState.player.isShaken = false
        emittedEvents.push({
          type: 'recover_shaken',
          payload: {
            spiritDie,
            traitRoll: recoverResult.traitRoll,
            wildRoll: recoverResult.wildRoll,
            finalTotal: recoverResult.finalTotal,
            recovered: true,
            withRaise: recoverResult.raises > 0
          }
        })
      } else {
        emittedEvents.push({
          type: 'recover_shaken_failed',
          payload: {
            spiritDie,
            traitRoll: recoverResult.traitRoll,
            wildRoll: recoverResult.wildRoll,
            finalTotal: recoverResult.finalTotal,
            recovered: false
          }
        })
      }
      break
    }

    // ─── Travel ───
    case 'travel': {
      const from = nextState.worldState.activeLocation
      nextState.worldState.activeLocation = action.to
      emittedEvents.push({ type: 'location_change', payload: { from, to: action.to } })
      break
    }

    // ─── Flag ───
    case 'flag': {
      nextState.worldState.worldFlags[action.key] = action.value
      emittedEvents.push({ type: 'world_flag', payload: { key: action.key, value: action.value } })
      break
    }

    // ─── Custom (free text → LLM) ───
    case 'custom': {
      emittedEvents.push({ type: 'custom_action', payload: { input: action.input } })
      break
    }
  }

  return { nextState, emittedEvents }
}

// Inline rollExploding to avoid circular-dep issues
function rollExplodingInline(sides: number, rng: () => number = Math.random): number {
  let total = 0
  for (let i = 0; i < 20; i++) {
    const r = Math.floor(rng() * sides) + 1
    total += r
    if (r !== sides) break
  }
  return total
}

