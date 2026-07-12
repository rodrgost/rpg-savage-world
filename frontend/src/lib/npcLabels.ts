import type { RelationalStatus } from '../types'

/** Labels PT-BR do status relacional do NPC com o personagem. */
export const RELATION_LABELS: Record<RelationalStatus, string> = {
  desconhecido: 'Desconhecido',
  conhecido: 'Conhecido',
  aliado: 'Aliado',
  amigavel: 'Amigável',
  neutro: 'Neutro',
  desconfiado: 'Desconfiado',
  hostil: 'Hostil',
  inimigo: 'Inimigo'
}

export const RELATION_OPTIONS: Array<{ value: Exclude<RelationalStatus, 'desconhecido'>; label: string }> = [
  { value: 'conhecido', label: RELATION_LABELS.conhecido },
  { value: 'aliado', label: RELATION_LABELS.aliado },
  { value: 'amigavel', label: RELATION_LABELS.amigavel },
  { value: 'neutro', label: RELATION_LABELS.neutro },
  { value: 'desconfiado', label: RELATION_LABELS.desconfiado },
  { value: 'hostil', label: RELATION_LABELS.hostil },
  { value: 'inimigo', label: RELATION_LABELS.inimigo }
]

/** Classe CSS do badge de relação (relation-aliado, relation-hostil, ...). */
export function relationClass(status: RelationalStatus): string {
  return `relation-${status}`
}

/** Relação derivada da disposition de cena, usada como fallback antes do registro chegar. */
export function relationFromDisposition(disposition?: 'hostile' | 'neutral' | 'friendly'): RelationalStatus {
  switch (disposition) {
    case 'friendly': return 'amigavel'
    case 'hostile': return 'hostil'
    case 'neutral': return 'neutro'
    default: return 'conhecido'
  }
}
