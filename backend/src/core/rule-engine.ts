import type { CalledShotLocation, DieType, EngineResult, GameState, NPCCombatant, PlayerAction } from '../domain/types/gameState.js'
import type { NpcAttackEntry } from '../domain/types/narrative.js'
import { findSkillDefinition, getCanonicalSkillLabel, resolveSkillDie } from '../domain/savage-worlds/constants.js'
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

/**
 * Determina o status (condição) de um NPC baseado em seus ferimentos.
 * - 'active': NPC está ativo e pode agir normalmente
 * - 'incapacitated': NPC está incapacitado (wounds > maxWounds)
 * - 'defeated': NPC foi derrotado (mesmo que incapacitated, mas marcado como tal)
 * - 'dead': NPC está morto (normalmente não usado em Savage Worlds, mas disponível)
 */
function determineNpcStatus(npc: NPCCombatant): NPCCombatant['status'] {
  if (npc.wounds > npc.maxWounds) {
    return 'incapacitated'
  }
  return npc.status ?? 'active'
}

function woundPenalty(wounds: number): number {
  return -Math.min(wounds, 3)
}

/**
 * Calcula bônus/penalidade de Vantagens (Edges) e Complicações (Hindrances)
 * para um teste de atributo ou perícia específico.
 */
function traitEdgeHindranceBonus(state: GameState, skillName: string | undefined): number {
  let bonus = 0
  const edges = state.player.edges
  const hindrances = state.player.hindrances
  const skillKey = findSkillDefinition(skillName)?.key ?? ''

  // ── Vantagens ──────────────────────────────────────────────────────────────
  // alertness / Alerta: +2 em Percepção
  if (skillKey === 'notice' && edges.some((e) => e === 'alertness' || e === 'Alerta')) bonus += 2

  // healer / Curandeiro: +2 em Medicina
  if (skillKey === 'healing' && edges.some((e) => e === 'healer' || e === 'Curandeiro')) bonus += 2

  // investigator / Investigador: +2 em Pesquisa e Percepção
  if ((skillKey === 'notice' || skillKey === 'research') && edges.some((e) => e === 'investigator' || e === 'Investigador')) bonus += 2

  // woodsman / Mateiro: +2 em Sobrevivência e Furtividade
  if ((skillKey === 'survival' || skillKey === 'stealth') && edges.some((e) => e === 'woodsman' || e === 'Mateiro')) bonus += 2

  // strongWilled / Determinado: +2 em testes de Espírito para resistir Intimidação ou Provocação
  if ((skillKey === 'intimidation' || skillKey === 'taunt') && edges.some((e) => e === 'strongWilled' || e === 'Determinado')) bonus += 2

  // ── Complicações ────────────────────────────────────────────────────────────
  // allThumbs / Desastrado: -2 em dispositivos mecânicos e eletrônicos
  if ((skillKey === 'electronics' || skillKey === 'hacking' || skillKey === 'repair')
    && hindrances.some((h) => h.name === 'allThumbs' || h.name === 'Desastrado')) bonus -= 2

  // clueless / Desinformado: -1 em Conhecimento Geral e Percepção
  if ((skillKey === 'commonKnowledge' || skillKey === 'notice')
    && hindrances.some((h) => h.name === 'clueless' || h.name === 'Desinformado')) bonus -= 1

  // clumsy / Desajeitado: -2 em Atletismo e Furtividade
  if ((skillKey === 'athletics' || skillKey === 'stealth')
    && hindrances.some((h) => h.name === 'clumsy' || h.name === 'Desajeitado')) bonus -= 2

  // mean / Rude: -1 em Persuasão
  if (skillKey === 'persuasion' && hindrances.some((h) => h.name === 'mean' || h.name === 'Rude')) bonus -= 1

  // outsider / Forasteiro: -2 em Persuasão
  if (skillKey === 'persuasion' && hindrances.some((h) => h.name === 'outsider' || h.name === 'Forasteiro')) bonus -= 2

  // acrobat / Acrobata: +2 em Atletismo para acrobacias
  if (skillKey === 'athletics' && edges.some((e) => e === 'acrobat' || e === 'Acrobata')) bonus += 2

  // berserk / Berserk: +1 em Luta enquanto em Fúria Berserk
  if (skillKey === 'fighting' && state.player.statusEffects.some((se) => se.id === 'berserk_rage')) bonus += 1

  // badEyes / Má Visão: -1 (minor) ou -2 (major) em testes visuais à distância
  if (skillKey === 'shooting' || skillKey === 'notice') {
    const badEyes = hindrances.find((h) => h.name === 'badEyes' || h.name === 'Má Visão')
    if (badEyes) bonus += badEyes.severity === 'major' ? -2 : -1
  }

  // phobia / Fobia: -1 (minor) ou -2 (major) em todos os testes quando o objeto de medo está presente
  // O narrator deve adicionar um StatusEffect com id prefixado 'phobia_' quando a fobia for ativada
  if (state.player.statusEffects.some((se) => se.id.startsWith('phobia_'))) {
    const phobia = hindrances.find((h) => h.name === 'phobia' || h.name === 'Fobia')
    if (phobia) bonus += phobia.severity === 'major' ? -2 : -1
  }

  return bonus
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
      // nerveOfSteel / Nervos de Aço: reduz penalidade de ferimento em 1
      const rawWoundPenalty = woundPenalty(nextState.player.wounds)
      const nerveBonus = nextState.player.edges.some((e) => e === 'nerveOfSteel' || e === 'Nervos de Aço') ? 1 : 0
      const edgeHindranceMod = traitEdgeHindranceBonus(nextState, skillName)
      const modifier = (action.modifier ?? 0) + Math.min(0, rawWoundPenalty + nerveBonus) + edgeHindranceMod
      const tn = 4

      const result = rollTrait(traitDie, true, modifier)

      // charismatic / Carismático: re-rola uma falha de Persuasão uma vez por interação
      const skillKey = findSkillDefinition(skillName)?.key ?? ''
      const isCharismaticReroll = skillKey === 'persuasion'
        && result.finalTotal < tn
        && nextState.player.edges.some((e) => e === 'charismatic' || e === 'Carismático')
      const finalResult = isCharismaticReroll ? rollTrait(traitDie, true, modifier) : result

      emittedEvents.push({
        type: 'trait_test',
        payload: {
          trait: traitName,
          dieSides: traitDie,
          traitRoll: finalResult.traitRoll,
          wildRoll: finalResult.wildRoll,
          modifier,
          finalTotal: finalResult.finalTotal,
          targetNumber: tn,
          isSuccess: finalResult.finalTotal >= tn,
          raises: countRaises(finalResult.finalTotal, tn),
          description: action.description,
          charismaticReroll: isCharismaticReroll
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
      const attackSkillKey = findSkillDefinition(attackSkill)?.key ?? ''
      const attackDie = getSkillDie(nextState, attackSkill)
      const penalty = woundPenalty(nextState.player.wounds)
      const calledShotPenalty = action.calledShot ? -2 : 0
      // marksman / Atirador: +1 em Tiro se não se moveu
      const marksmanBonus = (!action.hasMoved && attackSkillKey === 'shooting'
        && nextState.player.edges.some((e) => e === 'marksman' || e === 'Atirador')) ? 1 : 0
      const attackModifier = (action.modifier ?? 0) + penalty + calledShotPenalty + marksmanBonus
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
      const damageFormula = action.damageFormula ?? 'str+d4'
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

      // Called Shot bonus damage (head or vitals: +4)
      const calledShotDamageBonus = (action.calledShot === 'head' || action.calledShot === 'vitals') ? 4 : 0

      // assassin / Assassino: +2 de dano contra alvos Atordoados (Shaken = Vulnerável)
      const assassinBonus = (target.isShaken && nextState.player.edges.some((e) => e === 'assassin' || e === 'Assassino')) ? 2 : 0

      // champion / Campeão: +2 de dano contra criaturas sobrenaturais malignas
      const championBonus = (target.tags?.includes('supernatural') && nextState.player.edges.some((e) => e === 'champion' || e === 'Campeão')) ? 2 : 0

      // berserk / Berserk: +1 de dano enquanto em Fúria
      const berserkDamageBonus = nextState.player.statusEffects.some((se) => se.id === 'berserk_rage') ? 1 : 0

      const totalDamage = damageResult.total + raiseBonusDamage + calledShotDamageBonus + assassinBonus + championBonus + berserkDamageBonus
      const effectiveToughness = Math.max(0, target.toughness - ap)
      const dmgResult = resolveDamageVsToughness(totalDamage, effectiveToughness)

      // Called Shot limb: cap wounds at 1
      const finalWounds = action.calledShot === 'limb' ? Math.min(dmgResult.wounds, 1) : dmgResult.wounds
      const finalShaken = dmgResult.shaken || finalWounds > 0

      if (finalShaken || finalWounds > 0) {
        if (finalWounds > 0) {
          target.wounds = Math.min(target.wounds + finalWounds, target.maxWounds + 1)
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
          calledShotDamageBonus,
          calledShot: action.calledShot ?? null,
          targetToughness: target.toughness,
          woundsInflicted: finalWounds,
          targetShaken: target.isShaken,
          targetWounds: target.wounds,
          targetIncapacitated: isIncapacitated,
          traitRoll: attackResult.traitRoll,
          wildRoll: attackResult.wildRoll,
          damageRolls: damageResult.dice
        }
      })

      // NPC incapacitado: atualiza status, remove da lista de combatentes ativos e registra como derrotado
      if (isIncapacitated) {
        target.status = 'incapacitated'
        nextState.npcs = nextState.npcs.filter((n) => n.id !== target.id)
        nextState.defeatedNpcIds = [...(nextState.defeatedNpcIds ?? []), target.id]
      }
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
      const soakPenalty = woundPenalty(nextState.player.wounds)
      const soakResult = rollTrait(vigorDie, true, soakPenalty)

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
          modifier: soakPenalty,
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
      // combatReflexes / Reflexos de Combate: +2 para recuperar Atordoamento
      const combatReflexBonus = nextState.player.edges.some((e) => e === 'combatReflexes' || e === 'Reflexos de Combate') ? 2 : 0
      const recoverResult = rollTrait(spiritDie, true, penalty + combatReflexBonus)

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

    // ─── Heal (Medicina test to remove wounds) ───
    case 'heal': {
      const healingDie = getSkillDie(nextState, 'Medicina')
      const penalty = woundPenalty(nextState.player.wounds)
      const healerBonus = nextState.player.edges.some((e) => e === 'Curandeiro' || e === 'healer') ? 2 : 0
      const healModifier = (action.modifier ?? 0) + penalty + healerBonus
      const tn = 4

      const healResult = rollTrait(healingDie, true, healModifier)

      if (healResult.isSuccess) {
        const woundsHealed = 1 + healResult.raises
        if (action.targetId) {
          const targetNpc = nextState.npcs.find((n) => n.id === action.targetId)
          if (targetNpc) {
            targetNpc.wounds = Math.max(0, targetNpc.wounds - woundsHealed)
          }
        } else {
          nextState.player.wounds = Math.max(0, nextState.player.wounds - woundsHealed)
        }
        emittedEvents.push({
          type: 'heal_success',
          payload: {
            healingDie,
            modifier: healModifier,
            traitRoll: healResult.traitRoll,
            wildRoll: healResult.wildRoll,
            finalTotal: healResult.finalTotal,
            woundsHealed,
            targetId: action.targetId ?? 'player',
            remainingWounds: action.targetId
              ? (nextState.npcs.find((n) => n.id === action.targetId)?.wounds ?? 0)
              : nextState.player.wounds
          }
        })
      } else {
        emittedEvents.push({
          type: 'heal_failure',
          payload: {
            healingDie,
            modifier: healModifier,
            traitRoll: healResult.traitRoll,
            wildRoll: healResult.wildRoll,
            finalTotal: healResult.finalTotal,
            targetId: action.targetId ?? 'player'
          }
        })
      }
      break
    }

    // ─── Apply Fatigue ───
    case 'apply_fatigue': {
      const amount = Math.max(1, action.amount ?? 1)
      nextState.player.fatigue = Math.min(nextState.player.fatigue + amount, nextState.player.maxFatigue + 1)
      emittedEvents.push({
        type: 'fatigue_applied',
        payload: { amount, reason: action.reason ?? '', fatigue: nextState.player.fatigue, maxFatigue: nextState.player.maxFatigue }
      })
      break
    }

    // ─── Recover Fatigue ───
    case 'recover_fatigue': {
      const amount = Math.max(1, action.amount ?? 1)
      nextState.player.fatigue = Math.max(0, nextState.player.fatigue - amount)
      emittedEvents.push({
        type: 'fatigue_recovered',
        payload: { amount, fatigue: nextState.player.fatigue }
      })
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

// ─── NPC → Player Attack ───

export function applyNpcAttack(
  state: GameState,
  entry: NpcAttackEntry
): { nextState: GameState; emittedEvents: EngineResult['emittedEvents'] } {
  const emittedEvents: EngineResult['emittedEvents'] = []
  const nextState: GameState = structuredClone(state)

  const npc = nextState.npcs.find((n) => n.id === entry.npcId)
  if (!npc) {
    emittedEvents.push({ type: 'npc_attack_target_not_found', payload: { npcId: entry.npcId } })
    return { nextState, emittedEvents }
  }

  // NPCs incapacitados não atacam
  if (npc.wounds > npc.maxWounds) {
    return { nextState, emittedEvents }
  }

  const skillDie = entry.skillDie as DieType
  const npcWoundPenalty = -Math.min(npc.wounds, 3)
  const attackResult = rollTrait(skillDie, npc.isWildCard, npcWoundPenalty)
  // dodge / Esquivar: +2 de TN efetivo contra ataques à distância
  const dodgeBonus = (entry.isRanged && nextState.player.edges.some((e) => e === 'dodge' || e === 'Esquivar')) ? 2 : 0
  const attackTN = nextState.player.parry + dodgeBonus

  if (attackResult.finalTotal < attackTN) {
    emittedEvents.push({
      type: 'npc_attack_miss',
      payload: {
        npcId: npc.id,
        npcName: npc.name,
        skillDie,
        attackRoll: attackResult.finalTotal,
        targetParry: attackTN,
        traitRoll: attackResult.traitRoll,
        wildRoll: attackResult.wildRoll
      }
    })
    return { nextState, emittedEvents }
  }

  // Hit → rola dano
  const npcStrengthDie = (npc.attributes.strength ?? 6) as DieType
  const attackRaises = countRaises(attackResult.finalTotal, attackTN)
  const damageResult = rollDamage(entry.damageFormula, npcStrengthDie)

  let raiseBonusDamage = 0
  for (let i = 0; i < attackRaises; i++) {
    raiseBonusDamage += rollExplodingInline(6)
  }

  const totalDamage = damageResult.total + raiseBonusDamage
  const ap = entry.ap ?? 0
  const effectiveToughness = Math.max(0, nextState.player.toughness - ap)
  const dmgResult = resolveDamageVsToughness(totalDamage, effectiveToughness)

  if (dmgResult.shaken || dmgResult.wounds > 0) {
    if (dmgResult.wounds > 0) {
      nextState.player.wounds = Math.min(nextState.player.wounds + dmgResult.wounds, nextState.player.maxWounds + 1)
      nextState.player.isShaken = true

      // berserk / Berserk: entra em Fúria ao receber ferimento (se ainda não estiver)
      if (nextState.player.edges.some((e) => e === 'berserk' || e === 'Berserk')
        && !nextState.player.statusEffects.some((se) => se.id === 'berserk_rage')) {
        nextState.player.statusEffects = [
          ...nextState.player.statusEffects,
          { id: 'berserk_rage', name: 'Fúria Berserk' }
        ]
        emittedEvents.push({ type: 'berserk_rage_activated', payload: {} })
      }
    } else {
      applyShaken(nextState.player)
    }
  }

  emittedEvents.push({
    type: 'npc_attack_hit',
    payload: {
      npcId: npc.id,
      npcName: npc.name,
      skillDie,
      attackRoll: attackResult.finalTotal,
      targetParry: attackTN,
      attackRaises,
      damageTotal: totalDamage,
      raiseBonusDamage,
      playerToughness: nextState.player.toughness,
      woundsInflicted: dmgResult.wounds,
      playerShaken: nextState.player.isShaken,
      playerWounds: nextState.player.wounds,
      playerIncapacitated: nextState.player.wounds > nextState.player.maxWounds,
      traitRoll: attackResult.traitRoll,
      wildRoll: attackResult.wildRoll,
      damageRolls: damageResult.dice
    }
  })

  return { nextState, emittedEvents }
}

