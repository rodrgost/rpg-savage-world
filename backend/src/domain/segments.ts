// Helpers para derivar texto plano a partir de segmentos narrativos.
// `segments` é a fonte única da narração do narrador; `narrative` foi removido
// do contrato da LLM. Estes helpers concentram a conversão segments → texto
// usada em resumo, contexto da LLM, log de narração e continuidade.

import type { NarrativeSegment } from './types/narrative.js'

/** Junta os segmentos em texto plano. Falas de NPC ganham rótulo do interlocutor. */
export function segmentsToText(segments?: NarrativeSegment[] | null): string {
  if (!segments?.length) return ''
  return segments
    .map((seg) => {
      if (seg.type === 'npc') {
        const speaker = seg.npcDisplayName ?? seg.npcName
        return speaker ? `${speaker}: "${seg.text}"` : seg.text
      }
      return seg.text
    })
    .filter((t) => Boolean(t && t.trim()))
    .join('\n\n')
}

/**
 * Texto de uma mensagem persistida: usa `segments`; cai para `narrative` legado
 * (mensagens antigas gravadas antes da migração e mensagens de resumo).
 */
export function messageText(m: { segments?: NarrativeSegment[] | null; narrative?: string }): string {
  const fromSegments = segmentsToText(m.segments)
  if (fromSegments) return fromSegments
  return m.narrative?.trim() ? m.narrative : ''
}
