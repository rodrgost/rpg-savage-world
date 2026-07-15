import type { GameState, DieType, Hindrance, NpcDefinition } from '../domain/types/gameState.js'
import type { SessionSummaryRow } from '../repositories/sessionSummary.repo.js'
import type { EquippedItemsBrief, InventoryItem, NarrativeSegment } from '../domain/types/narrative.js'
import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'
import {
  EDGES,
  HINDRANCES,
  ATTRIBUTES,
  findWeaponDefinition,
  getCanonicalSkillLabel,
  resolveArmorValue,
  resolveShieldParryBonus
} from '../domain/savage-worlds/constants.js'

function resolveEquippedItemsBrief(state: GameState): EquippedItemsBrief {
  const inventory = state.player.inventory ?? []
  const findById = (itemId: string | undefined) =>
    itemId ? inventory.find((item) => item.id === itemId) : undefined

  const attackItem = findById(state.player.equippedAttackItemId)
  const armorItem = findById(state.player.equippedArmorItemId)
  const shieldItem = findById(state.player.equippedShieldItemId)

  const attackWeapon = findWeaponDefinition(attackItem?.name)
  const armorValue = resolveArmorValue(armorItem)
  const shieldParryBonus = resolveShieldParryBonus(shieldItem)

  return {
    ...(attackItem
      ? {
          attack: {
            itemId: attackItem.id,
            name: attackItem.name,
            isCatalogWeapon: Boolean(attackWeapon),
            damageFormula: attackWeapon?.damage ?? 'str',
            ap: attackWeapon?.ap ?? 0
          }
        }
      : {}),
    ...(armorItem && armorValue > 0
      ? {
          armor: {
            itemId: armorItem.id,
            name: armorItem.name,
            armorValue
          }
        }
      : {}),
    ...(shieldItem && shieldParryBonus > 0
      ? {
          shield: {
            itemId: shieldItem.id,
            name: shieldItem.name,
            parryBonus: shieldParryBonus
          }
        }
      : {})
  }
}

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
  const equippedItems = resolveEquippedItemsBrief(state)

  // NOTA: o resumo mecânico das regras de Savage Worlds (rolagens, dano vs.
  // Resistência, Ferimentos, Soak, Bennies, Fadiga) foi REMOVIDO do prompt.
  // Essas regras são fixas e aplicadas integralmente pelo rule-engine; o LLM
  // recebe os eventos já calculados e apenas narra. Mantemos aqui somente o
  // contexto do PERSONAGEM (perícias, Edges, Hindrances, atributos) que o
  // modelo precisa para escolher perícias e narrar com coerência.

  // A lista fechada de perícias válidas (nomes exatos para diceCheck/traco) já
  // vive no system prompt via DICE_TRACO_FIELD_EXPLANATION_PT (dice-rules.ts) —
  // manter "AVAILABLE SKILLS" aqui também só duplicava a mesma informação no
  // user prompt a cada turno, sem necessidade.

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

  /*// 5. Character attributes
  const attrLines = ATTRIBUTES.map(a => {
    const die = state.player.attributes[a.key]
    return `${a.label}: d${die}`
  })
  sections.push([
    '=== CHARACTER ATTRIBUTES ===',
    ...attrLines,
    `Parry: ${state.player.parry} | Toughness: ${state.player.toughness} | Armor: ${state.player.armor} | Pace: ${state.player.pace}`
  ].join('\n'))
  */

  const equippedLines: string[] = []
  if (equippedItems.attack) {
    equippedLines.push(`Attack: ${equippedItems.attack.name} (damage: ${equippedItems.attack.damageFormula}, AP: ${equippedItems.attack.ap})`)
  }
  if (equippedItems.armor) {
    equippedLines.push(`Armor: ${equippedItems.armor.name} (+${equippedItems.armor.armorValue} Armor)`)
  }
  if (equippedItems.shield) {
    equippedLines.push(`Shield: ${equippedItems.shield.name} (+${equippedItems.shield.parryBonus} Parry)`)
  }
  if (equippedLines.length > 0) {
    sections.push([
      '=== EQUIPPED ITEMS ===',
      ...equippedLines
    ].join('\n'))
  }

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
      displayName?: string
      isWildCard: boolean
      disposition?: 'hostile' | 'neutral' | 'friendly'
      wounds: number
      maxWounds: number
      toughness: number
      parry: number
      followsPlayer?: boolean
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
    equippedItems: EquippedItemsBrief
    activeStatusEffects: Array<{ id: string; name: string; turnsRemaining?: number }>
    /** Perícias do jogador com seus dados atuais (label PT-BR → "dN") */
    playerSkills: Record<string, string>
  }
  /** Digest compacto das regras SW + traços do personagem + equipamento */
  rulesDigest: string
  recentMessages: Array<{ role: string; segments?: NarrativeSegment[]; playerInput?: string; engineEvents?: Array<{ type: string; payload: Record<string, unknown> }> }>
}

function buildRecentSegments(m: ChatMessageRow): NarrativeSegment[] | undefined {
  const segs: NarrativeSegment[] = m.segments?.length
    ? m.segments
    : (m.narrative?.trim() ? [{ type: 'narrator' as const, text: m.narrative }] : [])
  if (!segs.length) return undefined
  return segs.map((seg) => ({ ...seg, text: typeof seg.text === 'string' ? normalizeLlmText(seg.text) : seg.text }))
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
  const equippedItems = resolveEquippedItemsBrief(state)

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
        .filter((n) => (!n.location || n.location === state.worldState.activeLocation) && n.status !== 'left')
        .map((n) => ({
          id: n.id,
          name: n.name,
          displayName: n.displayName ?? n.name,
          isWildCard: n.isWildCard,
          disposition: n.disposition,
          wounds: n.wounds,
          maxWounds: n.maxWounds,
          toughness: n.toughness,
          parry: n.parry,
          followsPlayer: n.followsPlayer,
          statusEffects: (n.statusEffects ?? []).map((effect) => ({
            id: effect.id,
            name: effect.name,
            turnsRemaining: effect.turnsRemaining
          })),
          personality: n.personality,
          motivation: n.motivation,
          speechPattern: n.speechPattern,
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
      equippedItems,
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
      segments: buildRecentSegments(m),
      playerInput: typeof m.playerInput === 'string' ? normalizeLlmText(m.playerInput) : m.playerInput,
      engineEvents: m.engineEvents?.map((event) => ({
        type: event.type,
        payload: event.payload
      }))
    }))
  }
}
