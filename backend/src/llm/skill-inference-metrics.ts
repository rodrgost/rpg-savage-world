/**
 * Contador simples em memória (não persistido, reseta a cada restart do
 * processo) de quantas vezes uma opção com trait_test/attack chegou da LLM
 * sem uma perícia válida dentro da lista fechada (SKILLS, ver
 * domain/savage-worlds/constants.ts) e teve a rolagem descartada dentro de
 * sanitizeNarratorResponse (gemini.adapter.ts).
 *
 * Existe pra dar visibilidade agregada sobre o quanto o LLM ainda erra o
 * campo diceCheck.traco fora da lista fechada, sem precisar grepar o log de
 * LLM manualmente linha a linha em busca de "Sem perícia válida". Ver
 * GET /health/llm-metrics.
 *
 * Não há mais inferência de perícia por texto neste código: se "traco" não
 * bate com nenhum nome da lista fechada, a rolagem é sempre descartada — o
 * único desfecho possível aqui é 'discarded'.
 */

export type SkillInferenceOutcome = 'discarded'

const counters: Record<SkillInferenceOutcome, number> = {
  discarded: 0
}

const processStartMs = Date.now()

/** Incrementa o contador do desfecho e devolve o total acumulado desse desfecho (útil pra log inline). */
export function recordSkillInferenceOutcome(outcome: SkillInferenceOutcome): number {
  counters[outcome] += 1
  return counters[outcome]
}

export function getSkillInferenceMetrics(): {
  counters: Record<SkillInferenceOutcome, number>
  total: number
  sinceISO: string
} {
  return {
    counters: { ...counters },
    total: counters.discarded,
    sinceISO: new Date(processStartMs).toISOString()
  }
}
