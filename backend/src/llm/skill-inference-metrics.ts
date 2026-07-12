/**
 * Contador simples em memória (não persistido, reseta a cada restart do
 * processo) de quantas vezes a inferência determinística de skill
 * (inferSkillFromText, ver domain/savage-worlds/constants.ts) precisou ser
 * acionada dentro de sanitizeNarratorResponse — e com que resultado.
 *
 * Existe pra dar visibilidade agregada sobre o quanto o LLM ainda erra o
 * campo diceCheck.traco fora da lista fechada (SKILLS + ATTRIBUTES), sem
 * precisar grepar o log de LLM manualmente linha a linha em busca de
 * "Skill inferida" / "Sem trait inferível". Ver GET /health/llm-metrics.
 *
 * Idealmente, depois que o Structured Outputs da OpenAI estiver realmente em
 * produção (buildOpenAiJsonSchemaResponseFormat em openai-strict-schema.ts),
 * esses contadores devem tender a ~0 para o provider 'openai' — se não
 * tenderem, é sinal de que o schema não está sendo aplicado/respeitado.
 */

export type SkillInferenceOutcome = 'inferredFromText' | 'inferredFromReason' | 'discarded'

const counters: Record<SkillInferenceOutcome, number> = {
  inferredFromText: 0,
  inferredFromReason: 0,
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
    total: counters.inferredFromText + counters.inferredFromReason + counters.discarded,
    sinceISO: new Date(processStartMs).toISOString()
  }
}
