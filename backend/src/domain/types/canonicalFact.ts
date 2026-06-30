/**
 * Fato canônico: evento atômico e irreversível da sessão (morte de NPC, inversão de
 * desfecho justificada na ficção, perda/ganho de item de missão). Complementa o
 * resumo de continuidade (prosa comprimida, sujeita a perda em recompactações) e as
 * âncoras canônicas (entidades, não eventos): é um registro append-only que nunca é
 * reescrito nem resumido, então sobrevive integralmente a qualquer número de
 * compactações de histórico.
 */
export type CanonicalFactCategory = 'npc_defeat' | 'outcome_override' | 'quest_item'

export type CanonicalFact = {
  id: string
  sessionId: string
  turn: number
  location: string
  category: CanonicalFactCategory
  text: string
}
