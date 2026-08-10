import type { GameState } from '../domain/types/gameState.js'
import type { ChatMessageRow } from '../repositories/chatMessage.repo.js'
import { messageText } from '../domain/segments.js'

export type CanonicalAnchors = {
  currentLocation: string
  confirmedLocations: string[]
  presentNpcNames: string[]
  inventoryItemNames: string[]
  sceneObjectsCurrent: string[]
  activeStatusNames: string[]
  historicalProperNames: string[]
  /** Texto da narrativa do turno corrente — itens mencionados aqui são permitidos nas opções mesmo sem estar no inventário. */
  currentNarrativeText?: string
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
  'acionar',
  'aceitar',
  'acalmar',
  'agradecer',
  'agora',
  'ajudar',
  'alertar',
  'alcançar',
  'alcancar',
  'ameacas',
  'ameaças',
  'ameacar',
  'ameaçar',
  'andar',
  'antes',
  'aproximar',
  'arremessar',
  'atacar',
  'ativar',
  'abalado',
  'atravessar',
  'ainda',
  'bennies',
  'buscar',
  'campanha',
  'capturar',
  'carregar',
  'chamar',
  'checar',
  'cobrir',
  'comer',
  'comunicar',
  'confiscar',
  'conferir',
  'confrontar',
  'consertar',
  'consultar',
  'conversar',
  'convencer',
  'correr',
  'cuidar',
  'debater',
  'depois',
  'descricao',
  'descrição',
  'desviar',
  'disparar',
  'efeitos',
  'empunhar',
  'encarar',
  'encontrar',
  'enfrentar',
  'enquanto',
  'entrar',
  'entregar',
  'equipar',
  'escapar',
  'esconder',
  'escutar',
  'esperar',
  'espionar',
  'examinar',
  'explorar',
  'falar',
  'fechar',
  'ferimentos',
  'fotografar',
  'forcas',
  'forças',
  'guardar',
  'hackear',
  'identificar',
  'ignorar',
  'iluminar',
  'inspecionar',
  'interrogar',
  'inventario',
  'inventário',
  'investigar',
  'ir',
  'jogador',
  'jogo',
  'lancar',
  'lançar',
  'ler',
  'limpar',
  'local',
  'monitorar',
  'mostrar',
  'mover',
  'narrador',
  'negociar',
  'nenhum',
  'nenhuma',
  'observar',
  'ostentar',
  'pericias',
  'perícias',
  'perseguir',
  'partir',
  'pressionar',
  'problema',
  'procurar',
  'proximo',
  'próximo',
  'proteger',
  'rastrear',
  'recarregar',
  'recursos',
  'reparar',
  'resistir',
  'resumo',
  'resultado',
  'revistar',
  'rumar',
  'sabotar',
  'sacar',
  'salvar',
  'saquear',
  'seduzir',
  'sem',
  'seguir',
  'segurar',
  'situacao',
  'situação',
  'teste',
  'tentar',
  'tipo',
  'travar',
  'turno',
  'universo',
  'usar',
  'vasculhar',
  'viajar',
  'vestir',
  'verificar',
  'vigiar',
  'virar',
  'voltar',
  'voce',
  'você',
  // Verbos frequentes no início de opções que não são nomes próprios
  'agachar',
  'apertar',
  'atirar',
  'bloquear',
  'cercar',
  'contornar',
  'defender',
  'engatilhar',
  'esquivar',
  'gritar',
  'invocar',
  'mirar',
  'posicionar',
  'preparar',
  'recuar',
  'recuperar',
  'retirar',
  'soltar',
  'tentar'
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

const ITEM_REFERENCE_PATTERN = /(?<![\.\p{L}\d])(?:usar|sacar|mostrar|entregar|beber|comer|consultar|ler|vestir|equipar|recarregar|acender|examinar|abrir|fechar|guardar|checar|verificar|limpar|consertar|reparar|empunhar|disparar|arremessar|lancar|lançar|ativar|segurar|segura|carregar|carrega|ostentar|ostenta|conferir|confere)\s+(?:o|a|os|as|um|uma|meu|minha|meus|minhas|seu|sua|seus|suas)\s+([\p{L}\d' -]{2,60})(?![\p{L}\d])/iu
const NPC_REFERENCE_PATTERN = /(?<![\p{L}\d])(?:falar|conversar|interrogar|convencer|ameaçar|seguir|observar|enfrentar|atacar|ajudar|proteger|perseguir|espionar|abordar|chamar|encarar|vigiar)\s+(?:com\s+)?(?:o|a|os|as)\s+([\p{L}\d' -]{2,60})(?![\p{L}\d])/iu
const LOCATION_REFERENCE_PATTERN = /(?<![\p{L}\d])(?:ir|seguir|voltar|correr|avancar|avançar|viajar|mover|andar|partir|rumar)\s+(?:para|ate|até|em direção a|na direcao de|na direção de|ao encontro de)\s+([\p{L}\d' -]{2,60})(?![\p{L}\d])/iu
const PROPER_NAME_PATTERN = /(?<![\p{L}\d])[\p{Lu}][\p{L}\d'-]*(?:\s+(?:de|da|do|dos|das|e)\s+[\p{Lu}][\p{L}\d'-]*|\s+[\p{Lu}][\p{L}\d'-]*){0,4}(?![\p{L}\d])/gu
const LOCATION_CANDIDATE_PATTERN = /(?<![\p{L}\d])(?:em|na|no|para|rumo a|direcao a|direção a|ate|até)\s+([\p{Lu}][\p{L}\d'-]*(?:\s+(?:de|da|do|dos|das|e)\s+[\p{Lu}][\p{L}\d'-]*|\s+[\p{Lu}][\p{L}\d'-]*){0,5})(?![\p{L}\d])/gu

const SCENE_OBJECT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'terminal', pattern: /\bterminal\b/iu },
  { label: 'painel', pattern: /\bpainel\b/iu },
  { label: 'porta', pattern: /\bporta\b/iu },
  { label: 'escotilha', pattern: /\bescotilha\b/iu },
  { label: 'trava', pattern: /\btrava\b/iu },
  { label: 'corredor', pattern: /\bcorredor\b/iu },
  { label: 'piso', pattern: /\bpiso\b/iu },
  { label: 'risco escuro', pattern: /\brisco\s+escuro\b/iu },
  { label: 'linha escura', pattern: /\blinha\s+escura\b/iu },
  { label: 'escotilha aberta', pattern: /\bescotilha\s+aberta\b/iu },
  { label: 'luzes vermelhas', pattern: /\bluzes\s+vermelhas\b/iu },
  { label: 'fresta do piso', pattern: /\bfresta\s+do\s+piso\b/iu }
]

export function extractSceneObjectsFromText(text: string): string[] {
  const cleaned = text.trim()
  if (!cleaned) return []

  const objects: string[] = []
  for (const { label, pattern } of SCENE_OBJECT_PATTERNS) {
    if (pattern.test(cleaned)) objects.push(label)
  }
  return uniqueNames(objects)
}

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

/**
 * Calcula a distância de Levenshtein (edits) entre duas strings.
 * Usado para tolerância a erros de digitação no matching de nomes.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]
    dp[0] = i
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1])
      prev = temp
    }
  }
  return dp[n]
}

/**
 * Retorna true se `candidate` estiver "ancorado" em `searchableText`.
 *
 * Estratégia (em ordem de prioridade):
 * 1. Correspondência exata do nome completo normalizado (comportamento original).
 * 2. Correspondência fuzzy a nível de token: alguma palavra significativa do texto
 *    da ação encontra par próximo em alguma palavra do nome candidato.
 *    Isso cobre referências parciais ("viajante" → "Viajante Inquieto") e
 *    pequenos erros de digitação ("viagante" → "viajante").
 *    Limiar conservador para evitar falsos positivos.
 */
function hasAnchoredName(searchableText: string, candidate: string): boolean {
  const normalizedCandidate = normalizeCanonicalText(candidate)
  if (!normalizedCandidate) return false

  // 1. Correspondência exata (comportamento original)
  if (searchableText.includes(` ${normalizedCandidate} `)) return true

  // 2. Fuzzy a nível de token — palavras com >= 4 caracteres apenas
  const searchWords = searchableText.trim().split(/\s+/).filter((w) => w.length >= 4)
  const candidateWords = normalizedCandidate.split(/\s+/).filter((w) => w.length >= 4)
  if (searchWords.length === 0 || candidateWords.length === 0) return false

  return searchWords.some((sw) =>
    candidateWords.some((cw) => {
      // Para palavras curtas (4-5 chars) tolera 1 edição; para mais longas, 2 edições.
      const maxDist = sw.length <= 5 ? 1 : 2
      return levenshtein(sw, cw) <= maxDist
    })
  )
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
        if (normalized.length < 3) return false
        if (PROPER_NAME_STOPWORDS.has(normalized)) return false
        // Filtra também se a PRIMEIRA palavra for uma stopword conhecida.
        // Cobre padrões como "Posicionar-se" → primeira palavra "posicionar".
        const firstWord = normalized.split(' ')[0] ?? ''
        if (firstWord && PROPER_NAME_STOPWORDS.has(firstWord)) return false
        return true
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
    const mt = messageText(message)
    if (mt.trim()) lines.push(mt)
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
  currentNarrative?: string
}): CanonicalAnchors {
  const { state, recentMessages = [], summaryText, currentNarrative } = params

  const presentNpcNames = uniqueNames(
    state.npcs
      .filter((npc) => !npc.location || npc.location === state.worldState.activeLocation)
      .map((npc) => npc.name)
  )
  const inventoryItemNames = uniqueNames((state.player.inventory ?? []).map((item) => item.name))
  const sceneObjectsCurrent = uniqueNames([
    ...extractSceneObjectsFromText(currentNarrative ?? ''),
    ...recentMessages
      .filter((message) => message.role === 'narrator' && message.location === state.worldState.activeLocation)
      .flatMap((message) => extractSceneObjectsFromText(messageText(message)))
  ])
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
    sceneObjectsCurrent,
    activeStatusNames,
    historicalProperNames,
    currentNarrativeText: currentNarrative?.trim() || undefined
  }
}

export function buildCanonicalPromptSection(anchors: CanonicalAnchors): string {
  const npcsText = anchors.presentNpcNames.length ? anchors.presentNpcNames.join(', ') : 'nenhum'
  const inventoryText = anchors.inventoryItemNames.length ? anchors.inventoryItemNames.join(', ') : 'nenhum'
  const sceneObjectsText = anchors.sceneObjectsCurrent.length ? anchors.sceneObjectsCurrent.join(', ') : 'nenhum'
  const statusText = anchors.activeStatusNames.length ? anchors.activeStatusNames.join(', ') : 'nenhum'
  const locationsText = anchors.confirmedLocations.length ? anchors.confirmedLocations.join(', ') : anchors.currentLocation
  const historyNamesText = anchors.historicalProperNames.length ? anchors.historicalProperNames.slice(0, 12).join(', ') : 'nenhum'

  return [
    '=== ÂNCORAS CANÔNICAS ===',
    '- Prefira as entidades abaixo ao criar opções e interpretar ações.',
    '- Não invente NPCs, itens ou locais que não constem nas listas abaixo, a menos que a narrativa deste turno os introduza explicitamente.',
    '- Priorize entidades confirmadas abaixo para interação direta, ataque, diálogo, entrega de item ou deslocamento.',
    '- Nomes do histórico recente servem apenas para continuidade narrativa; não assuma presença imediata de NPCs ou OBJETOS DE CENÁRIO (móveis, terminais, portas, estruturas fixas) fora da cena atual.',
    '- Se "Objetos do cenário atual" estiver como "nenhum", use SOMENTE os elementos explicitamente narrados neste turno para construir opções; não recupere objetos de salas anteriores.',
    `Local atual confirmado: ${anchors.currentLocation}`,
    `NPCs presentes agora: ${npcsText}`,
    `Objetos do cenário atual: ${sceneObjectsText}`,
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
    // Usa hasAnchoredName com argumentos invertidos: verifica se o nome próprio
    // extraído aparece (exato ou fuzzy) como token dentro de algum nome permitido.
    // Isso permite que "Viajante" seja aceito quando "Viajante Inquieto" está na cena.
    if (allowedProperNames.some((allowed) => hasAnchoredName(toSearchableText(allowed), properName))) continue

    violations.set(`proper-name:${normalizedProperName}`, {
      category: 'proper-name',
      token: properName,
      reason: 'Nome próprio não confirmado nas âncoras canônicas.'
    })
  }

  const hasAnchoredItemMention = anchors.inventoryItemNames.some((name) => hasAnchoredName(searchableText, name))
  const itemReference = extractStructuredReference(trimmed, ITEM_REFERENCE_PATTERN)
  if (itemReference && !hasAnchoredItemMention) {
    // Verifica se o PRIMEIRO TOKEN da referência capturada é uma palavra genérica de
    // localização, NPC ou item — padrão similar ao check do NPC_REFERENCE_PATTERN abaixo.
    // Isso evita falsos positivos como "verificar o perímetro..." → item:"perímetro do motel..."
    const itemRefFirstToken = normalizeCanonicalText(itemReference).split(' ').filter(Boolean)[0] ?? ''
    const itemRefFirstIsGeneric =
      genericLocationTokens.has(itemRefFirstToken)
      || genericNpcTokens.has(itemRefFirstToken)
      || genericItemTokens.has(itemRefFirstToken)

    // Verifica se o item foi introduzido na narrativa corrente do turno (ainda não está
    // no inventário, mas acabou de ser mencionado pelo narrador).
    const narrativeNormalized = anchors.currentNarrativeText ? normalizeCanonicalText(anchors.currentNarrativeText) : ''
    const itemRefWords = normalizeCanonicalText(itemReference).split(' ').filter((w) => w.length >= 4).slice(0, 2)
    const itemInCurrentNarrative = narrativeNormalized.length > 0 && itemRefWords.length > 0
      && itemRefWords.every((w) => narrativeNormalized.includes(w))

    if (
      !itemRefFirstIsGeneric
      && !itemInCurrentNarrative
      && !isGenericReference(itemReference, GENERIC_ITEM_REFERENCES, genericItemTokens)
    ) {
      const normalizedReference = normalizeCanonicalText(itemReference)
      violations.set(`item:${normalizedReference}`, {
        category: 'item',
        token: itemReference,
        reason: 'Referência a item não confirmada no inventário atual.'
      })
    }
  }

  const hasAnchoredNpcMention = anchors.presentNpcNames.some((name) => hasAnchoredName(searchableText, name))
  const npcReference = extractStructuredReference(trimmed, NPC_REFERENCE_PATTERN)
  if (npcReference && !hasAnchoredNpcMention) {
    // Verifica se o PRIMEIRO TOKEN da referência capturada já é uma palavra genérica.
    // O NPC_REFERENCE_PATTERN pode capturar expressões longas como
    // "ambiente rapidamente em busca de uma vantagem tática" quando o verbo
    // ("observar") é seguido de um substantivo comum ("ambiente").
    const npcRefFirstToken = normalizeCanonicalText(npcReference).split(' ').filter(Boolean)[0] ?? ''
    const npcRefFirstIsGeneric =
      genericLocationTokens.has(npcRefFirstToken)
      || genericNpcTokens.has(npcRefFirstToken)
      || genericItemTokens.has(npcRefFirstToken)
    if (
      !npcRefFirstIsGeneric
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