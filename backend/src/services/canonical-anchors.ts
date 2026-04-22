import type { GameState } from '../domain/types/gameState.js'
import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'

export type CanonicalAnchors = {
  currentLocation: string
  confirmedLocations: string[]
  presentNpcNames: string[]
  inventoryItemNames: string[]
  activeStatusNames: string[]
  historicalProperNames: string[]
}

export type CanonicalTextScope = 'option' | 'action' | 'narrative' | 'reason'

export type CanonicalTextViolation = {
  category: 'npc' | 'item' | 'location' | 'proper-name'
  token: string
  reason: string
}

const PROPER_NAME_STOPWORDS = new Set([
  'abordar',
  'acao',
  'ação',
  'acender',
  'ajudar',
  'ameacas',
  'ameaças',
  'ameacar',
  'ameaçar',
  'andar',
  'arremessar',
  'atacar',
  'ativar',
  'abalado',
  'bennies',
  'campanha',
  'carregar',
  'chamar',
  'checar',
  'comer',
  'conferir',
  'consertar',
  'consultar',
  'conversar',
  'convencer',
  'correr',
  'descricao',
  'descrição',
  'disparar',
  'efeitos',
  'empunhar',
  'encarar',
  'enfrentar',
  'entregar',
  'equipar',
  'espionar',
  'examinar',
  'falar',
  'fechar',
  'ferimentos',
  'forcas',
  'forças',
  'guardar',
  'interrogar',
  'inventario',
  'inventário',
  'ir',
  'jogador',
  'jogo',
  'lancar',
  'lançar',
  'ler',
  'limpar',
  'local',
  'mostrar',
  'mover',
  'narrador',
  'nenhum',
  'nenhuma',
  'observar',
  'ostentar',
  'pericias',
  'perícias',
  'perseguir',
  'partir',
  'problema',
  'proximo',
  'próximo',
  'proteger',
  'recarregar',
  'recursos',
  'reparar',
  'resumo',
  'resultado',
  'rumar',
  'sacar',
  'sem',
  'seguir',
  'segurar',
  'situacao',
  'situação',
  'teste',
  'tentar',
  'tipo',
  'turno',
  'universo',
  'usar',
  'viajar',
  'vestir',
  'verificar',
  'vigiar',
  'voltar',
  'voce',
  'você'
])

const GENERIC_ITEM_REFERENCES = new Set([
  'arma',
  'armas',
  'equipamento',
  'equipamentos',
  'ferramenta',
  'ferramentas',
  'inventario',
  'inventário',
  'pertences',
  'recursos',
  'suprimentos'
])

const GENERIC_NPC_REFERENCES = new Set([
  'alguem',
  'alguém',
  'figura',
  'figuras',
  'ninguem',
  'ninguém',
  'pessoa',
  'pessoas',
  'presenca',
  'presença'
])

const GENERIC_LOCATION_REFERENCES = new Set([
  'ambiente',
  'area',
  'área',
  'arredores',
  'caminho',
  'cena',
  'cobertura',
  'entrada',
  'entorno',
  'estrada',
  'local',
  'lugar',
  'perimetro',
  'perímetro',
  'posicao',
  'posição',
  'saida',
  'saída',
  'sombra',
  'terreno',
  'trilha'
])

const ITEM_REFERENCE_PATTERN = /(?<![\p{L}\d])(?:usar|sacar|mostrar|entregar|beber|comer|consultar|ler|vestir|equipar|recarregar|acender|examinar|abrir|fechar|guardar|checar|verificar|limpar|consertar|reparar|empunhar|disparar|arremessar|lancar|lançar|ativar|segurar|segura|carregar|carrega|ostentar|ostenta|conferir|confere)\s+(?:o|a|os|as|um|uma|meu|minha|meus|minhas|seu|sua|seus|suas)\s+([\p{L}\d' -]{2,60})(?![\p{L}\d])/iu
const NPC_REFERENCE_PATTERN = /(?<![\p{L}\d])(?:falar|conversar|interrogar|convencer|ameaçar|seguir|observar|enfrentar|atacar|ajudar|proteger|perseguir|espionar|abordar|chamar|encarar|vigiar)\s+(?:com\s+)?(?:o|a|os|as)\s+([\p{L}\d' -]{2,60})(?![\p{L}\d])/iu
const LOCATION_REFERENCE_PATTERN = /(?<![\p{L}\d])(?:ir|seguir|voltar|correr|avancar|avançar|viajar|mover|andar|partir|rumar)\s+(?:para|ate|até|em direção a|na direcao de|na direção de|ao encontro de)\s+([\p{L}\d' -]{2,60})(?![\p{L}\d])/iu
const PROPER_NAME_PATTERN = /(?<![\p{L}\d])[\p{Lu}][\p{L}\d'-]*(?:\s+(?:de|da|do|dos|das|e)\s+[\p{Lu}][\p{L}\d'-]*|\s+[\p{Lu}][\p{L}\d'-]*){0,4}(?![\p{L}\d])/gu
const LOCATION_CANDIDATE_PATTERN = /(?<![\p{L}\d])(?:em|na|no|para|rumo a|direcao a|direção a|ate|até)\s+([\p{Lu}][\p{L}\d'-]*(?:\s+(?:de|da|do|dos|das|e)\s+[\p{Lu}][\p{L}\d'-]*|\s+[\p{Lu}][\p{L}\d'-]*){0,5})(?![\p{L}\d])/gu

function normalizeCanonicalToken(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

export function normalizeCanonicalText(value: string | null | undefined): string {
  return normalizeCanonicalToken(value ?? '')
    .replace(/[^\p{L}\d]+/gu, ' ')
    .trim()
}

function toSearchableText(value: string): string {
  const normalized = normalizeCanonicalText(value)
  return normalized ? ` ${normalized} ` : ' '
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const name of names) {
    const clean = name.replace(/\s+/g, ' ').trim()
    const normalized = normalizeCanonicalText(clean)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(clean)
  }

  return result
}

function hasAnchoredName(searchableText: string, candidate: string): boolean {
  const normalizedCandidate = normalizeCanonicalText(candidate)
  if (!normalizedCandidate) return false
  return searchableText.includes(` ${normalizedCandidate} `)
}

function extractStructuredReference(text: string, pattern: RegExp): string | null {
  const match = text.match(pattern)
  if (!match?.[1]) return null

  const candidate = match[1]
    .split(/[,.!?;:]/, 1)[0]
    .split(/\b(?:para|com|sobre|contra|usando|enquanto|antes de|depois de|sem)\b/i, 1)[0]
    .replace(/\s+/g, ' ')
    .trim()

  return candidate || null
}

function extractProperNames(text: string): string[] {
  const matches = [...text.matchAll(PROPER_NAME_PATTERN)]
  return uniqueNames(
    matches
      .map((match) => match[0]?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean)
      .filter((candidate) => {
        const normalized = normalizeCanonicalText(candidate)
        return normalized.length >= 3 && !PROPER_NAME_STOPWORDS.has(normalized)
      })
  )
}

function extractLocationCandidates(text: string): string[] {
  const matches = [...text.matchAll(LOCATION_CANDIDATE_PATTERN)]
  return uniqueNames(
    matches
      .map((match) => match[1]?.replace(/\s+/g, ' ').trim() ?? '')
      .filter(Boolean)
      .filter((candidate) => normalizeCanonicalText(candidate).length >= 3)
  )
}

function collectHistoricalText(recentMessages: ChatMessageRow[], summaryText?: string): string[] {
  const lines: string[] = []

  if (summaryText?.trim()) lines.push(summaryText)

  for (const message of recentMessages) {
    if (message.narrative?.trim()) lines.push(message.narrative)
    if (message.playerInput?.trim()) lines.push(message.playerInput)
    if (Array.isArray(message.npcs)) {
      lines.push(...message.npcs.map((npc) => npc.name))
    }
    if (Array.isArray(message.itemChanges)) {
      lines.push(...message.itemChanges.map((item) => item.name))
    }
  }

  return lines
}

function buildGenericTokenSet(entries: Set<string>): Set<string> {
  const tokens = new Set<string>()

  for (const entry of entries) {
    for (const token of normalizeCanonicalText(entry).split(' ').filter(Boolean)) {
      tokens.add(token)
    }
  }

  return tokens
}

function isGenericReference(candidate: string, entries: Set<string>, tokens: Set<string>): boolean {
  const normalized = normalizeCanonicalText(candidate)
  if (!normalized) return true
  if (entries.has(normalized)) return true

  const words = normalized.split(' ').filter(Boolean)
  return words.length > 0 && words.every((word) => tokens.has(word))
}

export function buildCanonicalAnchors(params: {
  state: GameState
  recentMessages?: ChatMessageRow[]
  summaryText?: string
}): CanonicalAnchors {
  const { state, recentMessages = [], summaryText } = params

  const presentNpcNames = uniqueNames(
    state.npcs
      .filter((npc) => !npc.location || npc.location === state.worldState.activeLocation)
      .map((npc) => npc.name)
  )
  const inventoryItemNames = uniqueNames((state.player.inventory ?? []).map((item) => item.name))
  const activeStatusNames = uniqueNames((state.player.statusEffects ?? []).map((effect) => effect.name))
  const historicalText = collectHistoricalText(recentMessages, summaryText)
  const historicalProperNames = uniqueNames([
    state.worldState.activeLocation,
    ...presentNpcNames,
    ...inventoryItemNames,
    ...activeStatusNames,
    ...historicalText.flatMap((entry) => extractProperNames(entry))
  ])
  const confirmedLocations = uniqueNames([
    state.worldState.activeLocation,
    ...historicalText.flatMap((entry) => extractLocationCandidates(entry))
  ])

  return {
    currentLocation: state.worldState.activeLocation,
    confirmedLocations,
    presentNpcNames,
    inventoryItemNames,
    activeStatusNames,
    historicalProperNames
  }
}

export function buildCanonicalPromptSection(anchors: CanonicalAnchors): string {
  const npcsText = anchors.presentNpcNames.length ? anchors.presentNpcNames.join(', ') : 'nenhum'
  const inventoryText = anchors.inventoryItemNames.length ? anchors.inventoryItemNames.join(', ') : 'nenhum'
  const statusText = anchors.activeStatusNames.length ? anchors.activeStatusNames.join(', ') : 'nenhum'
  const locationsText = anchors.confirmedLocations.length ? anchors.confirmedLocations.join(', ') : anchors.currentLocation
  const historyNamesText = anchors.historicalProperNames.length ? anchors.historicalProperNames.slice(0, 12).join(', ') : 'nenhum'

  return [
    '=== ÂNCORAS CANÔNICAS ESTRITAS ===',
    '- No turno normal, trate as listas abaixo como fechadas.',
    '- Se uma opção ou interpretação citar item, NPC, local ou nome próprio fora destas listas, a resposta será descartada.',
    '- Para interação direta, ataque, diálogo, entrega de item ou deslocamento, use apenas entidades confirmadas abaixo.',
    '- Nomes do histórico recente servem apenas para continuidade narrativa; não use isso para fingir presença imediata de NPC fora da cena.',
    `Local atual confirmado: ${anchors.currentLocation}`,
    `NPCs presentes agora: ${npcsText}`,
    `Itens disponíveis agora: ${inventoryText}`,
    `Efeitos ativos confirmados: ${statusText}`,
    `Locais já confirmados no histórico: ${locationsText}`,
    `Nomes próprios já confirmados no histórico: ${historyNamesText}`
  ].join('\n')
}

export function isCanonicalLocation(destination: string, anchors: CanonicalAnchors): boolean {
  const normalizedDestination = normalizeCanonicalText(destination)
  if (!normalizedDestination) return false

  return anchors.confirmedLocations.some((location) => normalizeCanonicalText(location) === normalizedDestination)
}

export function findCanonicalTextViolations(
  text: string,
  anchors: CanonicalAnchors,
  opts: { scope?: CanonicalTextScope; allowHistoricalProperNames?: boolean } = {}
): CanonicalTextViolation[] {
  const { allowHistoricalProperNames = false } = opts
  const trimmed = text.trim()
  if (!trimmed) return []

  const searchableText = toSearchableText(trimmed)
  const violations = new Map<string, CanonicalTextViolation>()
  const genericItemTokens = buildGenericTokenSet(GENERIC_ITEM_REFERENCES)
  const genericNpcTokens = buildGenericTokenSet(GENERIC_NPC_REFERENCES)
  const genericLocationTokens = buildGenericTokenSet(GENERIC_LOCATION_REFERENCES)
  const allowedProperNames = allowHistoricalProperNames
    ? anchors.historicalProperNames
    : [
        ...anchors.presentNpcNames,
        ...anchors.confirmedLocations,
        ...anchors.inventoryItemNames.filter((item) => /\p{Lu}/u.test(item)),
        ...anchors.activeStatusNames.filter((status) => /\p{Lu}/u.test(status))
      ]

  for (const properName of extractProperNames(trimmed)) {
    const normalizedProperName = normalizeCanonicalText(properName)
    if (!normalizedProperName) continue
    if (allowedProperNames.some((allowed) => normalizeCanonicalText(allowed) === normalizedProperName)) continue

    violations.set(`proper-name:${normalizedProperName}`, {
      category: 'proper-name',
      token: properName,
      reason: 'Nome próprio não confirmado nas âncoras canônicas.'
    })
  }

  const hasAnchoredItemMention = anchors.inventoryItemNames.some((name) => hasAnchoredName(searchableText, name))
  const itemReference = extractStructuredReference(trimmed, ITEM_REFERENCE_PATTERN)
  if (
    itemReference
    && !hasAnchoredItemMention
    && !isGenericReference(itemReference, GENERIC_ITEM_REFERENCES, genericItemTokens)
  ) {
    const normalizedReference = normalizeCanonicalText(itemReference)
    violations.set(`item:${normalizedReference}`, {
      category: 'item',
      token: itemReference,
      reason: 'Referência a item não confirmada no inventário atual.'
    })
  }

  const hasAnchoredNpcMention = anchors.presentNpcNames.some((name) => hasAnchoredName(searchableText, name))
  const npcReference = extractStructuredReference(trimmed, NPC_REFERENCE_PATTERN)
  if (
    npcReference
    && !hasAnchoredNpcMention
    && !isGenericReference(npcReference, GENERIC_NPC_REFERENCES, genericNpcTokens)
    && !isGenericReference(npcReference, GENERIC_LOCATION_REFERENCES, genericLocationTokens)
    && !isGenericReference(npcReference, GENERIC_ITEM_REFERENCES, genericItemTokens)
  ) {
    const normalizedReference = normalizeCanonicalText(npcReference)
    violations.set(`npc:${normalizedReference}`, {
      category: 'npc',
      token: npcReference,
      reason: 'Referência a NPC não confirmada na cena atual.'
    })
  }

  const hasAnchoredLocationMention = anchors.confirmedLocations.some((name) => hasAnchoredName(searchableText, name))
  const locationReference = extractStructuredReference(trimmed, LOCATION_REFERENCE_PATTERN)
  if (
    locationReference
    && !hasAnchoredLocationMention
    && !isCanonicalLocation(locationReference, anchors)
    && !isGenericReference(locationReference, GENERIC_LOCATION_REFERENCES, genericLocationTokens)
  ) {
    const normalizedReference = normalizeCanonicalText(locationReference)
    violations.set(`location:${normalizedReference}`, {
      category: 'location',
      token: locationReference,
      reason: 'Referência a local não confirmada no contexto atual.'
    })
  }

  return [...violations.values()]
}