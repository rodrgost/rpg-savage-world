import test from 'node:test'
import assert from 'node:assert/strict'

import { createInitialState } from '../../domain/defaults/initialState.js'
import type { SessionObjective } from '../../domain/types/gameState.js'
import {
  DEFAULT_CAMPAIGN_FINALE_SYSTEM_PROMPT,
  CAMPAIGN_FINALE_PROMPT_METADATA
} from '../../llm/prompts/campaign-finale.prompt.js'

test('createInitialState inicializa objetivos de sessão corretamente', () => {
  const mockObjectives: SessionObjective[] = [
    {
      id: 'obj-1',
      title: 'Investigar as Ruínas',
      description: 'Encontrar a entrada das catacumbas.',
      chapter: 1,
      status: 'active'
    },
    {
      id: 'obj-2',
      title: 'Derrotar o Guardião',
      description: 'Enfrentar o guardião de pedra.',
      chapter: 2,
      status: 'pending'
    },
    {
      id: 'obj-3',
      title: 'Recuperar o Artefato',
      description: 'Pegar o amuleto ancestral.',
      chapter: 3,
      status: 'pending'
    }
  ]

  const state = createInitialState({
    sessionId: 'session-123',
    campaignId: 'campaign-123',
    worldId: 'world-123',
    character: {
      characterId: 'char-123',
      name: 'Valerius',
      attributes: { agility: 8, smarts: 6, spirit: 6, strength: 8, vigor: 8 },
      skills: { lutar: 8, atirar: 6 },
      edges: ['Corajoso'],
      hindrances: [{ name: 'Leal', severity: 'minor' }],
      armor: 0
    },
    objectives: mockObjectives
  })

  assert.equal(state.meta.chapter, 1, 'Capítulo inicial deve ser 1')
  assert.equal(state.meta.currentObjectiveTitle, 'Investigar as Ruínas')
  assert.equal(state.meta.campaignStatus, 'in_progress')
  assert.equal(state.objectives?.length, 3)
  assert.equal(state.objectives?.[0].status, 'active')
  assert.equal(state.objectives?.[1].status, 'pending')
})

test('Progressão de objetivos avança capítulos sequencialmente', () => {
  const objectives: SessionObjective[] = [
    {
      id: 'obj-1',
      title: 'Capítulo 1',
      description: 'Primeiro objetivo',
      chapter: 1,
      status: 'active'
    },
    {
      id: 'obj-2',
      title: 'Capítulo 2',
      description: 'Segundo objetivo',
      chapter: 2,
      status: 'pending'
    }
  ]

  const currentTurn = 4
  const activeObjective = objectives.find((o) => o.status === 'active')
  assert.ok(activeObjective)

  // Simula a lógica de conclusão do objetivo aplicada em session.service
  const updatedObjectives = objectives.map((obj) => {
    if (obj.id === activeObjective.id) {
      return {
        ...obj,
        status: 'completed' as const,
        completedAtTurn: currentTurn
      }
    }
    return obj
  })

  const nextPending = updatedObjectives.find((obj) => obj.status === 'pending')
  assert.ok(nextPending)
  nextPending.status = 'active'

  assert.equal(updatedObjectives[0].status, 'completed')
  assert.equal(updatedObjectives[0].completedAtTurn, 4)
  assert.equal(updatedObjectives[1].status, 'active')
  assert.equal(nextPending.chapter, 2)
  assert.equal(nextPending.title, 'Capítulo 2')
})

test('Conclusão do último objetivo encerra a campanha', () => {
  const objectives: SessionObjective[] = [
    {
      id: 'obj-1',
      title: 'Capítulo 1',
      description: 'Primeiro objetivo',
      chapter: 1,
      status: 'completed',
      completedAtTurn: 3
    },
    {
      id: 'obj-2',
      title: 'Capítulo Final',
      description: 'Objetivo final',
      chapter: 2,
      status: 'active'
    }
  ]

  const currentTurn = 7
  const activeObjective = objectives.find((o) => o.status === 'active')
  assert.ok(activeObjective)

  const updatedObjectives = objectives.map((obj) => {
    if (obj.id === activeObjective.id) {
      return {
        ...obj,
        status: 'completed' as const,
        completedAtTurn: currentTurn
      }
    }
    return obj
  })

  const nextPending = updatedObjectives.find((obj) => obj.status === 'pending')
  assert.equal(nextPending, undefined, 'Não deve haver mais objetivos pendentes')

  const isCampaignCompleted = updatedObjectives.every((obj) => obj.status === 'completed')
  assert.equal(isCampaignCompleted, true)
})

test('Prompt de finalização de campanha está configurado corretamente', () => {
  assert.equal(CAMPAIGN_FINALE_PROMPT_METADATA.key, 'campaign_finale')
  assert.equal(CAMPAIGN_FINALE_PROMPT_METADATA.enabled, true)
  assert.ok(DEFAULT_CAMPAIGN_FINALE_SYSTEM_PROMPT.length > 300)
  assert.match(DEFAULT_CAMPAIGN_FINALE_SYSTEM_PROMPT, /Conclusão da Campanha/i)
  assert.match(DEFAULT_CAMPAIGN_FINALE_SYSTEM_PROMPT, /Epílogo/i)
})

test('Início de jogo: descritivo público da campanha seleciona apenas storyDescription (sem vazar storyDetails)', () => {
  const campaign = {
    storyDescription: 'Nas terras ermas de Fronteira, monstros rondam a noite e aldeões buscam bravos defensores.',
    storyDetails: 'SECRETO DO MESTRE: O prefeito é o verdadeiro vilão e planeja trair os heróis no capítulo 3.',
    storyMissions: []
  }

  // Lógica aplicada em session.service para o trecho introdutório do narrador
  const campaignDescription = (campaign.storyDescription ?? '').trim()

  assert.equal(campaignDescription, 'Nas terras ermas de Fronteira, monstros rondam a noite e aldeões buscam bravos defensores.')
  assert.equal(campaignDescription.includes('SECRETO DO MESTRE'), false, 'Não deve conter detalhes estratégicos secretos')
})

