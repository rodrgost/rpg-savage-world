import type { GameState, DieType, Hindrance, NpcDefinition } from '../domain/types/gameState.js'
import type { SessionSummaryRow } from '../repositories/sessionSummary.repo.js'
import type { InventoryItem } from '../domain/types/narrative.js'
import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'
import {
  SKILLS,
  EDGES,
  HINDRANCES,
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

  // 1. Mechanical summary
  sections.push([
    '=== SAVAGE WORLDS RULES (summary) ===',
    'Trait rolls: roll the skill/attribute die + Wild Die (d6). Use the HIGHEST result. Rolling the max value causes the die to "ace" (reroll and add).',
    'Success: total >= 4 (standard TN). Each +4 above TN = 1 Raise (exceptional success).',
    'Combat: Attack rolls Fighting/Shooting vs target\'s Parry (melee) or TN 4 (ranged). Raise on attack = +1d6 damage.',
    'Damage vs Toughness: damage >= Toughness → Shaken. Each +4 above Toughness = +1 additional Wound. Already Shaken + new hit = +1 immediate Wound.',
    'Wounds (Wild Cards): -1 per wound to ALL trait rolls (max -3). 4+ wounds = Incapacitated.',
    'Extras (common NPCs, guards, zombies, bandits): 1 wound = removed from combat immediately. No Wild Die, no Bennies.',
    'Wild Cards (heroes, villains, bosses): can sustain up to 3 wounds like a player. Have Wild Die and Bennies.',
    'Soak: costs 1 Benny + roll Vigor. Success = 1 wound soaked. Each raise = +1 additional wound soaked.',
    'Bennies: spend to reroll a trait test, Soak a wound, or recover from Shaken.',
    'Fatigue: accumulates from exertion, environment, powers. Causes -1 per level. Excess → Incapacitated.'
  ].join('\n'))

  // 2. Skills with descriptions
  sections.push([
    '=== AVAILABLE SKILLS ===',

    ...SKILLS.map(s => {
      const attr = ATTRIBUTES.find(a => a.key === s.linkedAttribute)
      return `${s.label} (${attr?.label ?? s.linkedAttribute}): ${s.description}`
    })
  ].join('\n'))

  // 3. Character edges
  const playerEdges = state.player.edges
  if (playerEdges.length > 0) {
    const edgeLines = playerEdges.map(edgeKey => {
      const def = EDGES.find(e => e.key === edgeKey)
      if (def) return `${def.label}: ${def.description}`
      return `${edgeKey}: (effect not catalogued)`
    })
    sections.push([
      '=== CHARACTER EDGES ===',
      ...edgeLines
    ].join('\n'))
  }

  // 4. Character hindrances
  const playerHindrances = state.player.hindrances
  if (playerHindrances.length > 0) {
    const hindranceLines = playerHindrances.map((h: Hindrance) => {
      const def = HINDRANCES.find(hd => hd.key === h.name)
      const severity = h.severity === 'major' ? 'Major' : 'Minor'
      if (def) return `${def.label} (${severity}): ${def.description}`
      return `${h.name} (${severity}): (effect not catalogued)`
    })
    sections.push([
      '=== CHARACTER HINDRANCES ===',
      ...hindranceLines
    ].join('\n'))
  }

  // 5. Character attributes
  const attrLines = ATTRIBUTES.map(a => {
    const die = state.player.attributes[a.key]
    return `${a.label}: d${die}`
  })
  sections.push([
    '=== CHARACTER ATTRIBUTES ===',
    ...attrLines,
    `Parry: ${state.player.parry} | Toughness: ${state.player.toughness} | Armor: ${state.player.armor} | Pace: ${state.player.pace}`
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
      statusEffects?: Array<{ id: string; name: string; turnsRemaining?: number }>
      personality?: string
      motivation?: string
      speechPattern?: string
    }>
    /** IDs de NPCs já derrotados nesta sessão — para orientar o LLM a não referenciá-los como ameaças ativas */
    defeatedNpcIds: string[]
    situation: 'exploracao' | 'combat' | 'dialogo'
    /**
     * Catálogo de NPCs nomeados do mundo — LLM deve referenciar estes NPCs por id canônico.
     * Apenas campos narrativos relevantes (id, name, description, dispositionDefault).
     */
    npcCatalog: Array<{ id: string; name: string; description?: string; dispositionDefault: string }>
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
  npcCatalog?: NpcDefinition[]
}): LlmContext {
  const { state, summary, recentMessages, npcCatalog } = params

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
          parry: n.parry,
          statusEffects: (n.statusEffects ?? []).map((effect) => ({
            id: effect.id,
            name: effect.name,
            turnsRemaining: effect.turnsRemaining
          })),
          ...(n.personality ? { personality: n.personality } : {}),
          ...(n.motivation ? { motivation: n.motivation } : {}),
          ...(n.speechPattern ? { speechPattern: n.speechPattern } : {})
        })),
      defeatedNpcIds: state.defeatedNpcIds ?? [],
      situation,
      npcCatalog: (npcCatalog ?? []).map((def) => ({
        id: def.id,
        name: def.name,
        ...(def.description ? { description: def.description } : {}),
        dispositionDefault: def.dispositionDefault
      })),
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
