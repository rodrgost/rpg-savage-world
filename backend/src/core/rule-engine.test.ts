import test from 'node:test'
import assert from 'node:assert/strict'

import { applyAction, applyNpcAttack } from './rule-engine.js'
import { findWeaponDefinition } from '../domain/savage-worlds/constants.js'
import type { GameState } from '../domain/types/gameState.js'
import type { NpcAttackEntry } from '../domain/types/narrative.js'

function makeBaseState(): GameState {
  return {
    meta: {
      sessionId: 's1',
      campaignId: 'c1',
      turn: 0,
      chapter: 1
    },
    player: {
      characterId: 'pc1',
      name: 'Heroi',
      attributes: {
        agility: 6,
        smarts: 6,
        spirit: 6,
        strength: 6,
        vigor: 6
      },
      skills: {},
      edges: [],
      hindrances: [],
      wounds: 0,
      maxWounds: 3,
      fatigue: 0,
      maxFatigue: 2,
      isShaken: false,
      bennies: 3,
      pace: 6,
      parry: 5,
      toughness: 6,
      armor: 0,
      statusEffects: [],
      inventory: []
    },
    worldState: {
      activeLocation: 'Taverna',
      worldFlags: {}
    },
    npcs: [],
    defeatedNpcIds: []
  }
}

test('travel move apenas NPC com followsPlayer=true', () => {
  const state = makeBaseState()
  state.npcs = [
    {
      id: 'npc-follow',
      name: 'Companheiro',
      displayName: 'Companheiro',
      isWildCard: false,
      attributes: {},
      skills: {},
      wounds: 0,
      maxWounds: 1,
      fatigue: 0,
      isShaken: false,
      toughness: 4,
      parry: 4,
      armor: 0,
      pace: 6,
      bennies: 0,
      disposition: 'friendly',
      location: 'Taverna',
      status: 'active',
      followsPlayer: true
    },
    {
      id: 'npc-stay',
      name: 'Mercador',
      displayName: 'Mercador',
      isWildCard: false,
      attributes: {},
      skills: {},
      wounds: 0,
      maxWounds: 1,
      fatigue: 0,
      isShaken: false,
      toughness: 4,
      parry: 4,
      armor: 0,
      pace: 6,
      bennies: 0,
      disposition: 'neutral',
      location: 'Taverna',
      status: 'active',
      followsPlayer: false
    }
  ]

  const result = applyAction(state, { type: 'travel', to: 'Bosque' })
  const moved = result.nextState.npcs.find((n) => n.id === 'npc-follow')
  const stayed = result.nextState.npcs.find((n) => n.id === 'npc-stay')

  assert.equal(result.nextState.worldState.activeLocation, 'Bosque')
  assert.ok(moved)
  assert.ok(stayed)
  assert.equal(moved?.location, 'Bosque')
  assert.equal(moved?.status, 'active')
  assert.equal(stayed?.location, 'Taverna')
  assert.equal(stayed?.status, 'left')
})

test('travel sanitiza nome de local vindo do LLM com underscores e inicial minúscula', () => {
  const state = makeBaseState()

  const result = applyAction(state, { type: 'travel', to: 'rua_do_portao_da_cidade' })

  assert.equal(result.nextState.worldState.activeLocation, 'Rua do Portao da Cidade')
})

test('travel nao altera NPC indisponivel (incapacitado/derrotado/morto)', () => {
  const state = makeBaseState()
  state.npcs = [
    {
      id: 'npc-down',
      name: 'Guarda Ferido',
      displayName: 'Guarda Ferido',
      isWildCard: false,
      attributes: {},
      skills: {},
      wounds: 2,
      maxWounds: 1,
      fatigue: 0,
      isShaken: true,
      toughness: 4,
      parry: 4,
      armor: 0,
      pace: 6,
      bennies: 0,
      disposition: 'hostile',
      location: 'Taverna',
      status: 'incapacitated',
      followsPlayer: false
    }
  ]

  const result = applyAction(state, { type: 'travel', to: 'Portao' })
  const downNpc = result.nextState.npcs.find((n) => n.id === 'npc-down')

  assert.ok(downNpc)
  assert.equal(downNpc?.location, 'Taverna')
  assert.equal(downNpc?.status, 'incapacitated')
})

test('applyNpcAttack ignora atacante com status left', () => {
  const state = makeBaseState()
  state.npcs = [
    {
      id: 'npc-left',
      name: 'Andarilho',
      displayName: 'Andarilho',
      isWildCard: false,
      attributes: {},
      skills: {},
      wounds: 0,
      maxWounds: 1,
      fatigue: 0,
      isShaken: false,
      toughness: 4,
      parry: 4,
      armor: 0,
      pace: 6,
      bennies: 0,
      disposition: 'neutral',
      location: 'Taverna',
      status: 'left',
      followsPlayer: false
    }
  ]

  const attack: NpcAttackEntry = {
    npcId: 'npc-left',
    skillDie: 6,
    damageFormula: 'str+d4',
    ap: 0
  }

  const result = applyNpcAttack(state, attack)
  assert.equal(result.emittedEvents.length, 0)
  assert.equal(result.nextState.player.wounds, 0)
  assert.equal(result.nextState.player.isShaken, false)
})

test('applyAction emite evento chance_check_result', () => {
  const state = makeBaseState()
  const result = applyAction(state, {
    type: 'chance_check',
    success: true,
    chance: 75,
    roll: 42.5,
    reason: 'Desafio simples',
    description: 'Arrombar fechadura'
  })

  assert.equal(result.emittedEvents.length, 1)
  const ev = result.emittedEvents[0]
  assert.equal(ev.type, 'chance_check_result')
  assert.ok(ev.payload)
  assert.equal(ev.payload.success, true)
  assert.equal(ev.payload.chance, 75)
  assert.equal(ev.payload.roll, 42.5)
  assert.equal(ev.payload.reason, 'Desafio simples')
  assert.equal(ev.payload.description, 'Arrombar fechadura')
})

test('applyNpcAttack executa ataque de NPC ativo e emite hit ou miss', () => {
  const state = makeBaseState()
  state.npcs = [
    {
      id: 'npc-goblin',
      name: 'Goblin Salteador',
      displayName: 'Goblin Salteador',
      isWildCard: false,
      attributes: { strength: 6 },
      skills: {},
      wounds: 0,
      maxWounds: 1,
      fatigue: 0,
      isShaken: false,
      toughness: 4,
      parry: 4,
      armor: 0,
      pace: 6,
      bennies: 0,
      disposition: 'hostile',
      location: 'Floresta',
      status: 'active',
      followsPlayer: false
    }
  ]

  const attack: NpcAttackEntry = {
    npcId: 'npc-goblin',
    skillDie: 8,
    damageFormula: 'str+d6',
    ap: 0
  }

  const result = applyNpcAttack(state, attack)
  assert.equal(result.emittedEvents.length, 1)
  const evType = result.emittedEvents[0].type
  assert.ok(evType === 'npc_attack_hit' || evType === 'npc_attack_miss')
})

test('applyNpcAttack ignora atacante com status incapacitated ou defeated', () => {
  const state = makeBaseState()
  state.npcs = [
    {
      id: 'npc-orc',
      name: 'Orc Caído',
      displayName: 'Orc Caído',
      isWildCard: false,
      attributes: {},
      skills: {},
      wounds: 2,
      maxWounds: 1,
      fatigue: 0,
      isShaken: false,
      toughness: 6,
      parry: 5,
      armor: 1,
      pace: 6,
      bennies: 0,
      disposition: 'hostile',
      location: 'Floresta',
      status: 'incapacitated',
      followsPlayer: false
    }
  ]

  const attack: NpcAttackEntry = {
    npcId: 'npc-orc',
    skillDie: 8,
    damageFormula: 'str+d8',
    ap: 1
  }

  const result = applyNpcAttack(state, attack)
  assert.equal(result.emittedEvents.length, 0)
})

test('ataque do jogador funciona sem ter perícia cadastrada e usa 50% de chance', () => {
  const state = makeBaseState()
  state.npcs = [
    {
      id: 'npc-bandit',
      name: 'Bandido',
      displayName: 'Bandido',
      isWildCard: false,
      attributes: { strength: 6 },
      skills: {},
      wounds: 0,
      maxWounds: 1,
      fatigue: 0,
      isShaken: false,
      toughness: 4,
      parry: 4,
      armor: 0,
      pace: 6,
      bennies: 0,
      disposition: 'hostile',
      location: 'Estrada',
      status: 'active',
      followsPlayer: false
    }
  ]

  // Teste de acerto (roll 40 <= 50)
  const hitResult = applyAction(state, { type: 'attack', targetId: 'npc-bandit' }, () => 0.39)
  assert.equal(hitResult.emittedEvents.length, 1)
  assert.equal(hitResult.emittedEvents[0].type, 'attack_hit')

  // Teste de erro (roll 60 > 50)
  const missResult = applyAction(state, { type: 'attack', targetId: 'npc-bandit' }, () => 0.59)
  assert.equal(missResult.emittedEvents.length, 1)
  assert.equal(missResult.emittedEvents[0].type, 'attack_miss')
})

test('ataque de NPC usa 20% para inimigo comum (Extra) e 50% para Wild Card', () => {
  const state = makeBaseState()
  state.npcs = [
    {
      id: 'extra-goblin',
      name: 'Goblin Comum',
      displayName: 'Goblin Comum',
      isWildCard: false,
      attributes: { strength: 6 },
      skills: {},
      wounds: 0,
      maxWounds: 1,
      fatigue: 0,
      isShaken: false,
      toughness: 4,
      parry: 4,
      armor: 0,
      pace: 6,
      bennies: 0,
      disposition: 'hostile',
      location: 'Caverna',
      status: 'active',
      followsPlayer: false
    },
    {
      id: 'wildcard-boss',
      name: 'Chefe Orc',
      displayName: 'Chefe Orc',
      isWildCard: true,
      attributes: { strength: 8 },
      skills: {},
      wounds: 0,
      maxWounds: 3,
      fatigue: 0,
      isShaken: false,
      toughness: 6,
      parry: 5,
      armor: 1,
      pace: 6,
      bennies: 2,
      disposition: 'hostile',
      location: 'Caverna',
      status: 'active',
      followsPlayer: false
    }
  ]

  const attackExtra: NpcAttackEntry = { npcId: 'extra-goblin', skillDie: 6, damageFormula: 'str+d4' }
  const attackBoss: NpcAttackEntry = { npcId: 'wildcard-boss', skillDie: 8, damageFormula: 'str+d6' }

  // Extra com roll 25 (> 20%) -> Erra
  const extraMiss = applyNpcAttack(state, attackExtra, () => 0.24)
  assert.equal(extraMiss.emittedEvents[0].type, 'npc_attack_miss')

  // Extra com roll 15 (<= 20%) -> Acerta
  const extraHit = applyNpcAttack(state, attackExtra, () => 0.14)
  assert.equal(extraHit.emittedEvents[0].type, 'npc_attack_hit')

  // Wild Card com roll 40 (<= 50%) -> Acerta
  const bossHit = applyNpcAttack(state, attackBoss, () => 0.39)
  assert.equal(bossHit.emittedEvents[0].type, 'npc_attack_hit')
})

test('findWeaponDefinition reconhece cassetete tatico de polimero', () => {
  const def = findWeaponDefinition('Cassetete Tático de Polímero')
  assert.ok(def)
  assert.equal(def?.damage, 'str+d4')
})




