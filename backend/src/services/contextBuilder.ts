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
  ATTRIBUTES,
  getCanonicalSkillLabel
} from '../domain/savage-worlds/constants.js'

function formatDie(die: DieType): string {
  return `d${die}`
}

function buildPlayerSkillsMap(skills: Record<string, DieType>): Record<string, string> {
  const byLabel: Record<string, DieType> = {}
  for (const [key, die] of Object.entries(skills)) {
    const label = getCanonicalSkillLabel(key) ?? key
    const current = byLabel[label]
    if (!current || die > current) {
      byLabel[label] = die
    }
  }

  return Object.fromEntries(
    Object.entries(byLabel).map(([label, die]) => [label, formatDie(die)])
  )
}

function normalizeLlmText(text: string): string {
  let normalized = text.replace(/\r\n?/g, '\n')

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const next = normalized
      .replace(/\\\\r\\\\n/g, '\n')
      .replace(/\\\\n/g, '\n')
      .replace(/\\\\r/g, '\n')
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\"/g, '"')

    if (next === normalized) break
    normalized = next
  }

  return normalized.normalize('NFC').trim()
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
    'Dano vs Resistência: dano >= Resistência → Abalado (Shaken). Cada +4 acima da Resistência = +1 Ferimento adicional. Já Abalado + novo golpe = +1 Ferimento imediato.',
    'Ferimentos (Wild Cards): -1 por ferimento em TODOS os testes (máx -3). 4+ ferimentos = Incapacitado.',
    'Extras (NPCs comuns, guardas, zumbis, bandidos): 1 único ferimento = removido de combate imediatamente. Sem Wild Die, sem Bennies.',
    'Wild Cards (heróis, vilões, chefes): suportam até 3 ferimentos como o jogador. Possuem Wild Die e Bennies.',
    'Soak (absorver ferimento): custa 1 Benny + rola Vigor. Sucesso = 1 ferimento absorvido. Cada raise = +1 ferimento absorvido.',
    'Bennies: gastar para re-rolar teste, fazer Soak (absorver ferimento), ou recuperar de Abalado.',
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
    npcsPresent: Array<{
      id: string
      name: string
      isWildCard: boolean
      disposition?: 'hostile' | 'neutral' | 'friendly'
      wounds: number
      maxWounds: number
      toughness: number
      parry: number
    }>
    situation: 'exploracao' | 'combat' | 'dialogo'
    inventory: InventoryItem[]
    activeStatusEffects: Array<{ id: string; name: string; turnsRemaining?: number }>
    /** Perícias do jogador com seus dados atuais (label PT-BR → "dN") */
    playerSkills: Record<string, string>
  }
  /** Digest compacto das regras SW + traços do personagem + equipamento */
  rulesDigest: string
  recentMessages: Array<{ role: string; narrative?: string; playerInput?: string; engineEvents?: Array<{ type: string; payload: Record<string, unknown> }> }>
}

function buildCombinedSummaryText(summary: SessionSummaryRow | null): string {
  return summary?.summaryText ? normalizeLlmText(summary.summaryText) : ''
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
        .map((n) => ({
          id: n.id,
          name: n.name,
          isWildCard: n.isWildCard,
          disposition: n.disposition,
          wounds: n.wounds,
          maxWounds: n.maxWounds,
          toughness: n.toughness,
          parry: n.parry
        })),
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
      narrative: typeof m.narrative === 'string' ? normalizeLlmText(m.narrative) : m.narrative,
      playerInput: typeof m.playerInput === 'string' ? normalizeLlmText(m.playerInput) : m.playerInput,
      engineEvents: m.engineEvents?.map((event) => ({
        type: event.type,
        payload: event.payload
      }))
    }))
  }
}
