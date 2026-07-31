import type { GameState, DieType, Hindrance, NpcDefinition } from '../domain/types/gameState.js'
import type { SessionSummaryRow } from '../repositories/sessionSummary.repo.js'
import type { EquippedItemsBrief, InventoryItem, NarrativeSegment } from '../domain/types/narrative.js'
import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'
import { messageText } from '../domain/segments.js'
import { extractSceneObjectsFromText } from './canonical-anchors.js'
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
  const byLabel: Record<string, string> = {}
  for (const [key, die] of Object.entries(skills)) {
    if (die && die > 0) {
      const label = getCanonicalSkillLabel(key) ?? key
      byLabel[label] = 'possui'
    }
  }

  return byLabel
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

  // Contexto do PERSONAGEM (perícias possuídas, Edges, Hindrances, atributos) que o
  // modelo precisa para narrar com coerência.

  // 1. Character attributes & skills
  const attrLines = ATTRIBUTES.map(a => a.label)
  const possessedSkills = Object.entries(state.player.skills ?? {})
    .filter(([_, die]) => die && die > 0)
    .map(([key]) => getCanonicalSkillLabel(key) ?? key)

  sections.push([
    '=== CARACTERÍSTICAS E HABILIDADES DO PERSONAGEM ===',
    `Atributos principais: ${attrLines.join(', ')}`,
    `Perícias/Habilidades que o personagem possui: ${possessedSkills.length > 0 ? possessedSkills.join(', ') : 'Nenhuma específica'}`
  ].join('\n'))

  // 2. Character edges
  const playerEdges = state.player.edges
  if (playerEdges.length > 0) {
    const edgeLines = playerEdges.map(edgeKey => {
      const def = EDGES.find(e => e.key === edgeKey)
      if (def) return `${def.label}: ${def.description}`
      return `${edgeKey}: (efeito não catalogado)`
    })
    sections.push([
      '=== CHARACTER EDGES ===',
      ...edgeLines
    ].join('\n'))
  }

  // 3. Character hindrances
  const playerHindrances = state.player.hindrances
  if (playerHindrances.length > 0) {
    const hindranceLines = playerHindrances.map((h: Hindrance) => {
      const def = HINDRANCES.find(hd => hd.key === h.name)
      const severity = h.severity === 'major' ? 'Major' : 'Minor'
      if (def) return `${def.label} (${severity}): ${def.description}`
      return `${h.name} (${severity}): (efeito não catalogado)`
    })
    sections.push([
      '=== CHARACTER HINDRANCES ===',
      ...hindranceLines
    ].join('\n'))
  }

  const equippedLines: string[] = []
  if (equippedItems.attack) {
    equippedLines.push(`Attack: ${equippedItems.attack.name}`)
  }
  if (equippedItems.armor) {
    equippedLines.push(`Armor: ${equippedItems.armor.name}`)
  }
  if (equippedItems.shield) {
    equippedLines.push(`Shield: ${equippedItems.shield.name}`)
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
    /** Objetos/estruturas fixas detectados no local atual a partir da narração recente */
    sceneObjectsCurrent: string[]
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

function buildSceneObjectsCurrent(recentMessages: ChatMessageRow[] | undefined, activeLocation: string): string[] {
  if (!recentMessages?.length) return []

  const unique = new Set<string>()
  const add = (value: string) => {
    const clean = value.trim()
    if (!clean) return
    unique.add(clean)
  }

  for (const message of recentMessages) {
    if (message.role !== 'narrator') continue
    if (message.location !== activeLocation) continue

    const text = messageText(message)
    for (const objectName of extractSceneObjectsFromText(text)) {
      add(objectName)
    }
  }

  return [...unique]
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
  const sceneObjectsCurrent = buildSceneObjectsCurrent(recentMessages, state.worldState.activeLocation)

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
      sceneObjectsCurrent,
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
