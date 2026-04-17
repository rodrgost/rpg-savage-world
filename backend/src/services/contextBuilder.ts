import type { GameState, DieType, Hindrance } from '../domain/types/gameState.js'
import type { SessionSummaryRow } from '../repositories/sessionSummary.repo.js'
import type { InventoryItem } from '../domain/types/narrative.js'
import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'
import {
  SKILLS,
  EDGES,
  HINDRANCES,
  WEAPONS,
  ARMORS,
  ATTRIBUTES
} from '../domain/savage-worlds/constants.js'

function formatDie(die: DieType): string {
  return `d${die}`
}

function buildPlayerSkillsMap(skills: Record<string, DieType>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const [key, die] of Object.entries(skills)) {
    const def = SKILLS.find((s) => s.key === key)
    const label = def?.label ?? key
    result[label] = formatDie(die)
  }
  return result
}

// ─── Rules Digest ───

function buildRulesDigest(state: GameState): string {
  const sections: string[] = []

  // 1. Resumo mecânico
  sections.push([
    '=== REGRAS SAVAGE WORLDS (resumo) ===',
    'Testes: rola-se o dado da perícia/atributo + Wild Die (d6). Usa-se o MAIOR. Se tirar o máximo, o dado "explode" (re-rola e soma).',
    'Sucesso: total >= 4 (TN padrão). Cada +4 acima do TN = 1 Raise (sucesso excepcional).',
    'Combate: Ataque rola Luta/Tiro vs Aparar do alvo (corpo a corpo) ou TN 4 (distância). Raise no ataque = +1d6 de dano.',
    'Dano vs Resistência: dano >= Resistência → Abalado (Shaken). Cada raise = +1 Ferimento. Já Abalado + Abalado novamente = +1 Ferimento.',
    'Ferimentos: -1 por ferimento em TODOS os testes (máx -3). 4+ ferimentos = Incapacitado.',
    'Bennies: gastar para re-rolar teste, absorver ferimento (Soak com Vigor), ou recuperar de Abalado.',
    'Fadiga: acumula por esforço, ambiente, poderes. Causa -1 por nível. Em excesso → Incapacitado.'
  ].join('\n'))

  // 2. Perícias com descrições
  sections.push([
    '=== PERÍCIAS DISPONÍVEIS ===',
    ...SKILLS.map(s => {
      const attr = ATTRIBUTES.find(a => a.key === s.linkedAttribute)
      return `${s.label} (${attr?.label ?? s.linkedAttribute}): ${s.description}`
    })
  ].join('\n'))

  // 3. Edges do personagem
  const playerEdges = state.player.edges
  if (playerEdges.length > 0) {
    const edgeLines = playerEdges.map(edgeKey => {
      const def = EDGES.find(e => e.key === edgeKey)
      if (def) return `${def.label}: ${def.description}`
      return `${edgeKey}: (efeito não catalogado)`
    })
    sections.push([
      '=== VANTAGENS DO PERSONAGEM ===',
      ...edgeLines
    ].join('\n'))
  }

  // 4. Hindrances do personagem
  const playerHindrances = state.player.hindrances
  if (playerHindrances.length > 0) {
    const hindranceLines = playerHindrances.map((h: Hindrance) => {
      const def = HINDRANCES.find(hd => hd.key === h.name)
      const severity = h.severity === 'major' ? 'Maior' : 'Menor'
      if (def) return `${def.label} (${severity}): ${def.description}`
      return `${h.name} (${severity}): (efeito não catalogado)`
    })
    sections.push([
      '=== COMPLICAÇÕES DO PERSONAGEM ===',
      ...hindranceLines
    ].join('\n'))
  }

  // 5. Atributos do personagem
  const attrLines = ATTRIBUTES.map(a => {
    const die = state.player.attributes[a.key]
    return `${a.label}: d${die}`
  })
  sections.push([
    '=== ATRIBUTOS DO PERSONAGEM ===',
    ...attrLines,
    `Aparar: ${state.player.parry} | Resistência: ${state.player.toughness} | Armadura: ${state.player.armor} | Passo: ${state.player.pace}`
  ].join('\n'))

  // 6. Tabela de armas (resumida)
  const weaponLines = WEAPONS.map(w => {
    const parts = [`${w.label}: Dano ${w.damage}`]
    if (w.range) parts.push(`Alcance ${w.range}`)
    if (w.ap) parts.push(`AP ${w.ap}`)
    if (w.notes) parts.push(w.notes)
    return parts.join(', ')
  })
  sections.push([
    '=== ARMAS DISPONÍVEIS ===',
    ...weaponLines
  ].join('\n'))

  // 7. Tabela de armaduras (resumida)
  const armorLines = ARMORS.map(a => {
    const parts = [`${a.label}: +${a.armorValue} Armadura`]
    if (a.notes) parts.push(a.notes)
    return parts.join(', ')
  })
  sections.push([
    '=== ARMADURAS DISPONÍVEIS ===',
    ...armorLines
  ].join('\n'))

  return sections.join('\n\n')
}

export type LlmContext = {
  summaryText: string
  stateBrief: {
    location: string
    wounds: number
    fatigue: number
    isShaken: boolean
    bennies: number
    npcsPresent: Array<{ id: string; name: string }>
    situation: 'exploracao' | 'combat' | 'dialogo'
    inventory: InventoryItem[]
    activeStatusEffects: Array<{ id: string; name: string; turnsRemaining?: number }>
    /** Perícias do jogador com seus dados atuais (label PT-BR → "dN") */
    playerSkills: Record<string, string>
  }
  /** Digest compacto das regras SW + traços do personagem + equipamento */
  rulesDigest: string
  recentMessages: Array<{ role: string; narrative?: string; playerInput?: string }>
}

function buildCombinedSummaryText(summary: SessionSummaryRow | null): string {
  const sessionSummaryText = summary?.summaryText?.trim() ?? ''
  const historySummaryText = summary?.historySummaryText?.trim() ?? ''

  if (sessionSummaryText && historySummaryText) {
    return [
      `Resumo da sessao:\n${sessionSummaryText}`,
      `Historico resumido do chat:\n${historySummaryText}`
    ].join('\n\n')
  }

  return sessionSummaryText || historySummaryText
}

export function buildLlmContext(params: {
  state: GameState
  summary: SessionSummaryRow | null
  recentMessages?: ChatMessageRow[]
}): LlmContext {
  const { state, summary, recentMessages } = params

  const situation: LlmContext['stateBrief']['situation'] = state.combat ? 'combat' : 'exploracao'

  return {
    summaryText: buildCombinedSummaryText(summary),
    stateBrief: {
      location: state.worldState.activeLocation,
      wounds: state.player.wounds,
      fatigue: state.player.fatigue,
      isShaken: state.player.isShaken,
      bennies: state.player.bennies,
      npcsPresent: state.npcs
        .filter((n) => !n.location || n.location === state.worldState.activeLocation)
        .map((n) => ({ id: n.id, name: n.name })),
      situation,
      inventory: state.player.inventory ?? [],
      activeStatusEffects: state.player.statusEffects.map((e) => ({
        id: e.id,
        name: e.name,
        turnsRemaining: e.turnsRemaining
      })),
      playerSkills: buildPlayerSkillsMap(state.player.skills)
    },
    rulesDigest: buildRulesDigest(state),
    recentMessages: (recentMessages ?? []).map((m) => ({
      role: m.role,
      narrative: m.narrative,
      playerInput: m.playerInput
    }))
  }
}
