import test from 'node:test'
import assert from 'node:assert/strict'

import { applyAction, applyNpcAttack } from './rule-engine.js'
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

