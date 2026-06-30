import type { GameState } from '../domain/types/gameState.js'
import type { NarratorTurnResponse } from '../domain/types/narrative.js'
import type { CanonicalFact } from '../domain/types/canonicalFact.js'
import type { NewCanonicalFact } from '../repositories/canonicalFact.repo.js'

/**
 * Deriva fatos canônicos deterministicamente a partir do que o turno já calculou
 * (estado antes/depois, resposta do narrador) — sem chamada extra ao LLM. Cobre
 * apenas eventos irreversíveis o suficiente para merecer um registro que nenhuma
 * recompactação de resumo pode apagar.
 */
export function deriveCanonicalFacts(params: {
  stateBeforeTurn: GameState
  finalState: GameState
  narratorResponse: NarratorTurnResponse
  /** Nome de exibição por id de NPC, coletado do estado e da resposta do narrador deste turno. */
  npcNameById: Map<string, string>
}): NewCanonicalFact[] {
  const { stateBeforeTurn, finalState, narratorResponse, npcNameById } = params
  const turn = finalState.meta.turn
  const location = finalState.worldState.activeLocation
  const facts: NewCanonicalFact[] = []

  const previouslyDefeated = new Set(stateBeforeTurn.defeatedNpcIds ?? [])
  const newlyDefeatedIds = (finalState.defeatedNpcIds ?? []).filter((id) => !previouslyDefeated.has(id))
  for (const id of newlyDefeatedIds) {
    const name = npcNameById.get(id) ?? id
    facts.push({
      turn,
      location,
      category: 'npc_defeat',
      text: `${name} foi derrotado em ${location} (turno ${turn}).`
    })
  }

  const override = narratorResponse.outcomeOverride
  if (override) {
    facts.push({
      turn,
      location,
      category: 'outcome_override',
      text: `Em ${location} (turno ${turn}), um resultado mecânico de ${override.mechanicalResult === 'success' ? 'sucesso' : 'falha'} foi narrado como ${override.narratedOutcome === 'success' ? 'sucesso' : 'falha'} — ${override.justification}`
    })
  }

  for (const change of narratorResponse.itemChanges) {
    if (change.category !== 'quest') continue
    const verb = change.changeType === 'gained' ? 'obteve' : change.changeType === 'used' ? 'usou' : 'perdeu'
    facts.push({
      turn,
      location,
      category: 'quest_item',
      text: `Jogador ${verb} o item de missão "${change.name}" em ${location} (turno ${turn}).`
    })
  }

  return facts
}

/** Renderiza o ledger de fatos canônicos para o prompt do narrador. Mais recentes por último (ordem cronológica). */
export function buildCanonicalFactsPromptSection(facts: CanonicalFact[], maxEntries = 40): string | null {
  if (!facts.length) return null
  const recent = facts.slice(-maxEntries)
  return [
    '=== FATOS CANÔNICOS (eventos confirmados, imutáveis) ===',
    '- Estes eventos aconteceram de fato e nunca devem ser contraditos, revertidos ou esquecidos.',
    ...recent.map((fact) => `- ${fact.text}`)
  ].join('\n')
}
