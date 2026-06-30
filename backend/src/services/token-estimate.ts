import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'
import { messageText } from '../domain/segments.js'

/**
 * Estimativa grosseira de tokens (~4 caracteres por token, válida tanto para
 * PT-BR quanto para o JSON em inglês trocado com a API). Não há tokenizer real
 * instalado no projeto — esta heurística existe só para dimensionar a janela
 * de histórico/compactação de forma robusta a mensagens de tamanho variável,
 * não para contabilidade de custo exata.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** Estimativa de tokens do texto efetivamente reenviado ao LLM para esta mensagem (narração ou fala do jogador). */
export function estimateMessageTokens(message: ChatMessageRow): number {
  const text = message.role === 'player' ? (message.playerInput ?? '') : messageText(message)
  return estimateTokens(text)
}

/**
 * Seleciona o maior sufixo cronológico (mensagens mais recentes) cujo total de
 * tokens estimados não ultrapassa o orçamento — substitui uma janela de
 * tamanho fixo (N mensagens) por uma janela de tamanho fixo em tokens, robusta
 * a turnos com mensagens muito curtas ou muito longas.
 * Sempre inclui ao menos 1 mensagem (a mais recente), mesmo que ela sozinha
 * já exceda o orçamento.
 */
export function selectRecentWindowByTokenBudget<T extends ChatMessageRow>(
  messagesAsc: T[],
  budgetTokens: number
): T[] {
  let total = 0
  let cutoff = messagesAsc.length
  for (let i = messagesAsc.length - 1; i >= 0; i -= 1) {
    const tokens = estimateMessageTokens(messagesAsc[i])
    if (total + tokens > budgetTokens && cutoff !== messagesAsc.length) break
    total += tokens
    cutoff = i
  }
  return messagesAsc.slice(cutoff)
}

/**
 * Divide uma lista cronológica em lotes consecutivos cujo total de tokens
 * estimados não ultrapassa o orçamento (cada lote tem ao menos 1 item, mesmo
 * que ele sozinho exceda o orçamento). Usado para dobrar lotes de histórico
 * em chamadas sucessivas de summarizeHistory sem depender de uma contagem
 * fixa de mensagens por lote.
 */
export function chunkByTokenBudget<T>(itemsAsc: T[], budgetTokens: number, estimate: (item: T) => number): T[][] {
  const chunks: T[][] = []
  let current: T[] = []
  let total = 0

  for (const item of itemsAsc) {
    const tokens = estimate(item)
    if (current.length > 0 && total + tokens > budgetTokens) {
      chunks.push(current)
      current = []
      total = 0
    }
    current.push(item)
    total += tokens
  }
  if (current.length > 0) chunks.push(current)

  return chunks
}
