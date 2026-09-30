import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectRecentWindowByTokenBudget } from './token-estimate.js'
import { SummaryService } from './summary.service.js'
import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'
import type { StructuredSummary } from '../llm/summary-format.js'

test('selectRecentWindowByTokenBudget alinha para a fronteira do turno (não quebra um turno ao meio)', () => {
  const messages: ChatMessageRow[] = [
    { messageId: 'm1', sessionId: 's1', turn: 1, seq: 1, role: 'player', playerInput: 'Ação do turno 1 com texto longo para consumir tokens suficientes' },
    { messageId: 'm2', sessionId: 's1', turn: 1, seq: 2, role: 'narrator', narrative: 'Narração do turno 1 detalhando os eventos e consequências imediatas' },
    { messageId: 'm3', sessionId: 's1', turn: 2, seq: 3, role: 'player', playerInput: 'Ação do turno 2' },
    { messageId: 'm4', sessionId: 's1', turn: 2, seq: 4, role: 'narrator', narrative: 'Narração do turno 2' },
  ]

  // Orçamento que cobriria apenas m4 e m3, mas se o cutoff caísse entre m1 e m2, não deve dividir o turno 1
  const result = selectRecentWindowByTokenBudget(messages, 30)

  // Deve conter o turno 2 inteiro
  assert.ok(result.some((m) => m.turn === 2))
  // Se o turno 2 for incluído, todas as suas mensagens devem estar presentes
  const turn2Messages = result.filter((m) => m.turn === 2)
  assert.equal(turn2Messages.length, 2)
})

test('SummaryService.getRecentWindow exclui mensagens de turnos já inclusos no resumo', async () => {
  const mockSummaryRepo = {
    getSummary: async () => ({
      sessionId: 's1',
      lastTurnIncluded: 2,
      summaryText: 'Resumo dos turnos 1 e 2',
      summaryStructured: {
        locations: [],
        current: { name: 'Sala', turn: 2, situation: 'Tudo calmo' }
      } as StructuredSummary
    }),
    upsertSummary: async () => {}
  }

  const mockChatRepo = {
    getRecent: async () => [
      { messageId: 'm1', sessionId: 's1', turn: 1, seq: 1, role: 'player', playerInput: 'Ação 1' },
      { messageId: 'm2', sessionId: 's1', turn: 1, seq: 2, role: 'narrator', narrative: 'Narração 1' },
      { messageId: 'm3', sessionId: 's1', turn: 2, seq: 3, role: 'player', playerInput: 'Ação 2' },
      { messageId: 'm4', sessionId: 's1', turn: 2, seq: 4, role: 'narrator', narrative: 'Narração 2' },
      { messageId: 'm5', sessionId: 's1', turn: 3, seq: 5, role: 'player', playerInput: 'Ação 3' },
      { messageId: 'm6', sessionId: 's1', turn: 3, seq: 6, role: 'narrator', narrative: 'Narração 3' },
    ] as ChatMessageRow[],
    listBySession: async () => [],
    listArchivedBySession: async () => [],
    archiveBatch: async () => {},
  }

  const service = new SummaryService(mockSummaryRepo as any, mockChatRepo as any, {} as any)
  const window = await service.getRecentWindow('s1')

  // Deve conter APENAS mensagens com turn > 2
  assert.equal(window.length, 2)
  assert.ok(window.every((m) => m.turn > 2))
  assert.equal(window[0].messageId, 'm5')
  assert.equal(window[1].messageId, 'm6')
})
