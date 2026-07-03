export type SummaryLocationBlock = {
  name: string
  turnStart: number
  turnEnd: number
  situation: string
  npcs?: string
  tensions?: string
}

export type SummaryCurrentBlock = {
  name: string
  turn: number
  situation: string
  npcs?: string
  goals?: string
  tensions?: string
}

export type StructuredSummary = {
  locations: SummaryLocationBlock[]
  current: SummaryCurrentBlock
}

/**
 * Renderiza o resumo estruturado para o mesmo formato textual que o prompt do
 * narrador já espera em "=== RESUMO DA AVENTURA (CÂNONE ESTABELECIDO) ===".
 * Mantém o contrato de prompt existente estável mesmo com a mudança interna
 * de prosa livre para JSON estruturado e validável.
 */
export function renderStructuredSummary(summary: StructuredSummary): string {
  const blocks: string[] = []

  for (const loc of summary.locations) {
    const lines = [`[LOCAL: ${loc.name} | T${loc.turnStart}–T${loc.turnEnd}]`, `Situação: ${loc.situation}`]
    if (loc.npcs?.trim()) lines.push(`NPCs: ${loc.npcs.trim()}`)
    if (loc.tensions?.trim()) lines.push(`Tensões: ${loc.tensions.trim()}`)
    blocks.push(lines.join('\n'))
  }

  const current = summary.current
  const currentLines = [`[ATUAL: ${current.name} | T${current.turn}]`, `Situação: ${current.situation}`]
  if (current.npcs?.trim()) currentLines.push(`NPCs: ${current.npcs.trim()}`)
  if (current.goals?.trim()) currentLines.push(`Objetivos: ${current.goals.trim()}`)
  if (current.tensions?.trim()) currentLines.push(`Tensões: ${current.tensions.trim()}`)
  blocks.push(currentLines.join('\n'))

  return blocks.join('\n\n')
}

function isEmptyCurrent(current: SummaryCurrentBlock | undefined): boolean {
  return !current || !current.situation?.trim()
}

export function isEmptyStructuredSummary(summary: StructuredSummary | null | undefined): boolean {
  if (!summary) return true
  return summary.locations.length === 0 && isEmptyCurrent(summary.current)
}

/** Resumo estruturado vazio — ponto de partida quando não há resumo anterior. */
export function emptyStructuredSummary(): StructuredSummary {
  return { locations: [], current: { name: '', turn: 0, situation: '' } }
}
