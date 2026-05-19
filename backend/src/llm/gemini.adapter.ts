import type {
  ExpandWorldRequest,
  ExpandWorldLoreRequest,
  ExpandAdventureStoryResult,
  StoryCharacter,
  GenerateImageDescriptionRequest,
  Narrator,
  SuggestedCharacter,
  SuggestCharacterFromWorldRequest,
  SummarizeHistoryRequest,
  SummarizeRequest
} from './narrator.js'
import type {
  NarrateStartRequest,
  NarrateTurnRequest,
  NarratorTurnResponse,
  NpcAttackEntry,
  ActionOption,
  NPCMention,
  ItemChange,
  StatusChange,
  DiceCheck,
  ValidateActionRequest,
  ValidateActionResponse
} from '../domain/types/narrative.js'
import { randomUUID } from 'node:crypto'
import { findSkillDefinition, getCanonicalSkillLabel } from '../domain/savage-worlds/constants.js'
import { logLlmRequest, logLlmResponse, logLlmError, log, warn, error as logErr } from '../utils/file-logger.js'
import { classifyTrivialAction } from '../core/trivial-action.js'

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string; thought?: boolean }>
    }
    finishReason?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    totalTokenCount?: number
    thoughtsTokenCount?: number
  }
}

type SupportedLlmProvider = 'gemini' | 'deepseek'

type DeepSeekChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string | null
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

const DEEPSEEK_MAX_TOKENS_LIMIT = 8192

/** Um turno individual no array multi-turn contents[] da API Gemini */
export type ContentEntry = { role: 'user' | 'model'; text: string }

type GenerateTextOptions = {
  timeoutMs?: number
  maxOutputTokens?: number
  responseMimeType?: string
  temperature?: number
  /** Quando presente, enviado como campo separado systemInstruction na API Gemini */
  systemInstruction?: string
  /** Limita tokens gastos no raciocínio interno (thinking) do modelo. Default: 0 (desativado). */
  thinkingBudget?: number
}

type GenerateTextResult = {
  text: string
  finishReason?: string
  promptTokens?: number
  outputTokens?: number
  durationMs: number
}

type NarratorPromptMode = 'start' | 'turn'

type SanitizedNarratorResponseOptions = {
  fillFallbackOptions?: boolean
  allowNarrativeFallback?: boolean
}

type JsonParseSource = 'direct' | 'fragment' | 'repaired' | 'regex'

type JsonParseResult = {
  value: Record<string, unknown>
  source: JsonParseSource
}

function readEnv(name: string, fallback = ''): string {
  const value = process.env[name]
  if (typeof value !== 'string') return fallback
  return value.trim().replace(/^"(.*)"$/, '$1')
}

function readLlmProvider(): SupportedLlmProvider {
  return readEnv('LLM_PROVIDER', 'gemini').toLowerCase() === 'deepseek'
    ? 'deepseek'
    : 'gemini'
}

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function withMin(value: number, min: number): number {
  return value < min ? min : value
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function normalizeFinishReason(provider: SupportedLlmProvider, finishReason: string | null | undefined): string | undefined {
  if (!finishReason) return undefined
  if (provider === 'gemini') return finishReason
  if (finishReason === 'length') return 'MAX_TOKENS'
  return finishReason.toUpperCase()
}

function buildOpenAiCompatibleMessages(
  promptOrContents: string | ContentEntry[],
  systemInstruction?: string
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = []

  if (systemInstruction) {
    messages.push({ role: 'system', content: systemInstruction })
  }

  if (Array.isArray(promptOrContents)) {
    for (const entry of promptOrContents) {
      messages.push({
        role: entry.role === 'model' ? 'assistant' : 'user',
        content: entry.text
      })
    }
  } else {
    messages.push({ role: 'user', content: promptOrContents })
  }

  return messages
}

function sanitizeSkillName(value: unknown): string | null {
  const skill = sanitizeNullableInlineText(value)
  if (!skill) return null
  const canonical = getCanonicalSkillLabel(skill)
  if (!canonical || !findSkillDefinition(canonical)) return null
  return canonical
}

function hydrateDiceCheckFromActionPayload(
  diceCheck: DiceCheck | null,
  actionPayload: Record<string, unknown>
): DiceCheck | null {
  if (!diceCheck) return null

  const payloadSkill = sanitizeSkillName(actionPayload.skill)
  const payloadAttribute = sanitizeNullableInlineText(actionPayload.attribute)

  return {
    ...diceCheck,
    skill: diceCheck.skill ?? payloadSkill,
    attribute: diceCheck.attribute ?? (diceCheck.skill ? diceCheck.attribute : payloadAttribute)
  }
}

function buildOptionSignature(option: {
  text: string
  actionType: string
  actionPayload: Record<string, unknown>
  diceCheck?: DiceCheck | null
}): string {
  const payloadSkill = typeof option.actionPayload.skill === 'string' ? option.actionPayload.skill : ''
  const payloadInput = typeof option.actionPayload.input === 'string' ? option.actionPayload.input : ''

  return [
    option.actionType,
    option.text.toLowerCase(),
    payloadSkill.toLowerCase(),
    payloadInput.toLowerCase(),
    option.diceCheck?.skill?.toLowerCase() ?? '',
    option.diceCheck?.attribute?.toLowerCase() ?? ''
  ].join('|')
}

function extractText(response: GeminiGenerateContentResponse): string {
  const candidate = response.candidates?.[0]
  const parts = candidate?.content?.parts ?? []

  // Filtrar thinking parts — só extrair o conteúdo visível
  const text = parts
    .filter((part) => !part.thought)
    .map((part) => part.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n')

  // Log de diagnóstico: finishReason e usage
  const finishReason = candidate?.finishReason ?? 'unknown'
  const usage = response.usageMetadata
  const thoughtTokens = usage?.thoughtsTokenCount ?? 0
  const outputTokens = usage?.candidatesTokenCount ?? 0
  const promptTokens = usage?.promptTokenCount ?? 0
  log('gemini', `finishReason=${finishReason} prompt=${promptTokens} output=${outputTokens} thought=${thoughtTokens} total=${usage?.totalTokenCount ?? 0} textLen=${text.length}`)

  return text
}

function extractDeepSeekText(response: DeepSeekChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content
  return typeof content === 'string' ? content.trim() : ''
}

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim()
  // Aceita qualquer language tag (json, markdown, md, text, js, ts, etc.) ou nenhuma
  const match = trimmed.match(/^```[a-zA-Z0-9]*\s*\r?\n([\s\S]*?)\r?\n```\s*$/i)
  if (!match?.[1]) return trimmed
  return match[1].trim()
}

function decodeLiteralEscapes(text: string): string {
  let normalized = text

  for (let iteration = 0; iteration < 2; iteration += 1) {
    const next = normalized
      .replace(/\\\\r\\\\n/g, '\n')
      .replace(/\\\\n/g, '\n')
      .replace(/\\\\r/g, '\n')
      .replace(/\\\\t/g, '\t')
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")

    if (next === normalized) break
    normalized = next
  }

  return normalized
}

function normalizeModelText(text: string): string {
  return decodeLiteralEscapes(stripMarkdownFence(text))
    .replace(/\r\n?/g, '\n')
    .normalize('NFC')
}

function isSeparator(line: string): boolean {
  return /^\s*(?:\*\*\*+|---+|___+)\s*$/.test(line)
}

function hasMetaCommentary(paragraph: string): boolean {
  return /^(excelente|ótimo|otimo|perfeito|boa escolha|que ideia|como seu|como sua|como narrador|como worldbuilder|vamos expandir|claro|com certeza|aqui est[áa]|segue|vamos lá)/i.test(
    paragraph.trim()
  )
}

function splitFirstParagraph(lines: string[]): { paragraph: string; rest: string[] } {
  const firstBreak = lines.findIndex((line) => !line.trim())
  if (firstBreak < 0) {
    return { paragraph: lines.join(' ').trim(), rest: [] }
  }

  const paragraph = lines
    .slice(0, firstBreak)
    .join(' ')
    .trim()
  const rest = lines.slice(firstBreak + 1)
  return { paragraph, rest }
}

function sanitizeNarrativeOutput(text: string): string {
  const original = normalizeModelText(text)
  if (!original) return ''

  let lines = original.split('\n').map((line) => line.trimEnd())

  for (let iteration = 0; iteration < 3; iteration += 1) {
    while (lines.length && (!lines[0]?.trim() || isSeparator(lines[0]))) {
      lines = lines.slice(1)
    }

    const { paragraph, rest } = splitFirstParagraph(lines)
    if (!paragraph || !hasMetaCommentary(paragraph)) break
    lines = rest
  }

  const compacted: string[] = []
  let previousBlank = false

  for (const line of lines) {
    if (!line.trim() || isSeparator(line)) {
      if (compacted.length && !previousBlank) {
        compacted.push('')
      }
      previousBlank = true
      continue
    }

    compacted.push(line)
    previousBlank = false
  }

  const cleaned = compacted.join('\n').trim()
  return cleaned || original
}

function formatEngineEventsForPrompt(events: Array<{ type: string; payload: unknown }>): string {
  return events
    .map((event) => `[${event.type}] ${JSON.stringify(event.payload)}`)
    .join('\n')
}

function sanitizeInlineText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  const cleaned = normalizeModelText(value)
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

function sanitizeNullableInlineText(value: unknown): string | null {
  const cleaned = sanitizeInlineText(value, '')
  return cleaned || null
}

function sanitizeImageDescriptionOutput(text: string): string {
  return sanitizeInlineText(text, '').slice(0, 420)
}

function sanitizeJsonLikeValue(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeInlineText(value, '')
  if (Array.isArray(value)) return value.map((item) => sanitizeJsonLikeValue(item))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizeJsonLikeValue(item)])
    )
  }
  return value
}

function sanitizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((entry) => sanitizeInlineText(entry, ''))
    .filter(Boolean)
}

function isActionType(value: unknown): value is ActionOption['actionType'] {
  return value === 'trait_test'
    || value === 'attack'
    || value === 'soak_roll'
    || value === 'spend_benny'
    || value === 'recover_shaken'
    || value === 'travel'
    || value === 'flag'
    || value === 'custom'
}

function endsWithSentenceBoundary(text: string): boolean {
  return /[.!?…]["')\]]?\s*$/u.test(text.trim())
}

function sanitizeValidateActionResponse(
  raw: Record<string, unknown>,
  fallbackInput: string
): ValidateActionResponse | null {
  if (typeof raw.feasible !== 'boolean') return null
  if (!isActionType(raw.actionType)) return null

  const actionType = raw.actionType
  const actionPayloadRaw = raw.actionPayload && typeof raw.actionPayload === 'object' && !Array.isArray(raw.actionPayload)
    ? raw.actionPayload
    : { input: fallbackInput }
  const actionPayload = { ...(sanitizeJsonLikeValue(actionPayloadRaw) as Record<string, unknown>) }
  const interpretation = sanitizeInlineText(raw.interpretation, fallbackInput)
  if (!interpretation) return null

  const payloadSkill = sanitizeSkillName(actionPayload.skill)
  if (payloadSkill) {
    actionPayload.skill = payloadSkill
  } else if (typeof actionPayload.skill === 'string') {
    delete actionPayload.skill
  }

  const diceCheckRaw = raw.diceCheck && typeof raw.diceCheck === 'object' && !Array.isArray(raw.diceCheck)
    ? raw.diceCheck as Record<string, unknown>
    : null

  const diceCheck = hydrateDiceCheckFromActionPayload(
    diceCheckRaw
    ? {
        required: Boolean(diceCheckRaw.required),
        skill: sanitizeSkillName(diceCheckRaw.skill),
        attribute: sanitizeNullableInlineText(diceCheckRaw.attribute),
        modifier: Number(diceCheckRaw.modifier) || 0,
        tn: Number(diceCheckRaw.tn) || 4,
        reason: sanitizeInlineText(diceCheckRaw.reason, '')
      }
    : null,
    actionPayload
  )

  if (actionType === 'custom' && !sanitizeInlineText(actionPayload.input, '')) {
    actionPayload.input = interpretation
  }

  // Para ataques: mapear "target" → "targetId" se o LLM usou o campo errado.
  // Não rejeitar por targetId ausente — o alvo canônico é resolvido downstream.
  if (actionType === 'attack') {
    if (!actionPayload.targetId && typeof actionPayload.target === 'string') {
      actionPayload.targetId = actionPayload.target
    }
  }

  if (actionType === 'travel' && !sanitizeInlineText(actionPayload.to, '')) return null
  if (actionType === 'trait_test') {
    const payloadAttribute = sanitizeInlineText(actionPayload.attribute, '')
    if (!payloadSkill && !payloadAttribute && !diceCheck?.skill && !diceCheck?.attribute) {
      return null
    }
  }

  return {
    feasible: raw.feasible,
    feasibilityReason: sanitizeInlineText(raw.feasibilityReason, ''),
    diceCheck,
    actionType,
    actionPayload,
    interpretation
  }
}

function sanitizeCharacterField(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const cleaned = value
    .trim()
    .replace(/^['"“”‘’`]+|['"“”‘’`]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\s,;:|\-–—]+$/g, '')
  return cleaned || fallback
}

const DISALLOWED_CHARACTER_NAMES = new Set(['kael', 'khael', 'kaell', 'cael'])
const GENERIC_NAME_TOKENS = new Set(['aventureiro', 'aventureira', 'heroi', 'heroina', 'protagonista', 'personagem'])
const NAME_FALLBACK_POOL = [
  'Darian',
  'Liora',
  'Thoran',
  'Mirela',
  'Aedan',
  'Seris',
  'Breno',
  'Ysolda',
  'Ravena',
  'Caio',
  'Selene',
  'Tiber',
  'Nayra',
  'Orin',
  'Talissa',
  'Vitor'
]
type CharacterCategory = 'fighter' | 'arcane' | 'rogue' | 'support'

const APPEARANCE_BY_CATEGORY: Record<CharacterCategory, string[]> = {
  fighter: [
    'compleição robusta, cicatriz diagonal no queixo e olhar firme',
    'ombros largos e mãos calejadas pelas batalhas, cabelos raspados nas laterais',
    'estatura imponente, tatuagem tribal no antebraço esquerdo',
    'cabelos curtos e escuros, nariz quebrado e expressão resoluta'
  ],
  arcane: [
    'traços finos e olhos que parecem calcular tudo ao redor',
    'cabelos longos antes do tempo grisalhos, dedos manchados de tinta arcana',
    'estatura esguia, olhar distante e contemplativo, marcas de runa no pescoço',
    'pele pálida, olhos escuros e expressão sempre analítica'
  ],
  rogue: [
    'estatura baixa e ágil, olhar calculista e movimentos quase silenciosos',
    'cabelos escuros e curtos, cicatriz fina no supercílio esquerdo',
    'compleição magra e nervosa, sempre atento ao que acontece ao redor',
    'rosto comum que facilmente se perde na multidão, olhos atentos'
  ],
  support: [
    'cabelos longos e ruivos, rosto anguloso e gestos expressivos',
    'pele bronzeada, porte elegante e mãos ágeis sempre com algo para anotar',
    'olhos claros e penetrantes, postura ereta e ar de quem sabe mais do que diz',
    'estatura mediana, traços marcantes e sorriso que nunca entrega os planos'
  ]
}

const CLOTHING_BY_CATEGORY: Record<CharacterCategory, string[]> = {
  fighter: [
    'veste armadura de couro remendada com placas de metal nos ombros',
    'usa cota de malha surrada sob um capote de viagem com remendos de batalha',
    'porta proteções de couro reforçadas, sempre com a arma principal à mão',
    'veste uniforme militar fora de uso, ainda conservado com disciplina'
  ],
  arcane: [
    'usa robes de tecido escuro com bordados sutis nas mangas',
    'veste túnica simples sobre calças práticas, carregando uma bolsa cheia de pergaminhos',
    'porta manto de viagem com bolsos internos repletos de componentes e anotações',
    'veste roupas comuns propositalmente modestas para não atrair atenção'
  ],
  rogue: [
    'trajes escuros e práticos, cheios de bolsos ocultos e correias ajustáveis',
    'usa roupas de viajante comum que escondem armadura leve sob o casaco',
    'veste couro flexível escuro, silencioso ao menor movimento',
    'roupas de tecido grosso com capuz sempre pronto para cobrir o rosto'
  ],
  support: [
    'porta bolsa de couro repleta de mapas, instrumentos e anotações de campo',
    'veste robes de estudioso com remendos nos cotovelos e manchas de tinta',
    'usa vestes práticas para longas jornadas, com espaço para livros e ferramentas',
    'carrega um cajado de viagem e veste roupas resistentes mas sem ostentação'
  ]
}

const PERSONALITY_POOL = [
  'reservado, mas incondicionalmente leal a quem conquista sua confiança',
  'impulsivo e movido pela adrenalina do momento',
  'calculista — nunca age sem avaliar os riscos antes',
  'curioso e determinado a desvendar segredos ocultos',
  'sarcástico por fora, profundamente compassivo por dentro',
  'pragmático e direto, sem paciência para rodeios',
  'idealista que ainda acredita que o bem pode prevalecer',
  'desconfiado com estranhos, mas honrado com aliados'
]

function resolveCharacterCategory(characterClass: string, profession: string): CharacterCategory {
  const key = (characterClass + ' ' + profession)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
  if (/guerreir|patrulheir|ca[cç]ador|mercen|batalh|soldad|cavalei/.test(key)) return 'fighter'
  if (/arcani|mago|brux|feiticei|bardo|cleric|curand|druida/.test(key)) return 'arcane'
  if (/ladino|assassin|bateador|batedor|espi|mensageir|ladr/.test(key)) return 'rogue'
  return 'support'
}

function pickRandom<T>(items: T[], fallback: T): T {
  if (!items.length) return fallback
  const index = Math.floor(Math.random() * items.length)
  return items[index] ?? fallback
}

function normalizeNameForCheck(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z]/g, '')
    .toLowerCase()
}

function isDisallowedName(name: string): boolean {
  const normalized = normalizeNameForCheck(name)
  if (!normalized) return true
  if (GENERIC_NAME_TOKENS.has(normalized)) return true
  if (DISALLOWED_CHARACTER_NAMES.has(normalized)) return true
  return DISALLOWED_CHARACTER_NAMES.has(normalized.replace(/[^a-z]/g, ''))
}

function sanitizeCharacterResult(input: SuggestedCharacter): SuggestedCharacter {
  const output: SuggestedCharacter = { ...input }

  if (isDisallowedName(output.name)) {
    output.name = pickRandom(NAME_FALLBACK_POOL, 'Darian')
  }

  if (!output.description.trim()) {
    const category = resolveCharacterCategory(output.characterClass, output.profession)
    const appearance = pickRandom(APPEARANCE_BY_CATEGORY[category], 'olhos firmes e postura determinada')
    const clothing = pickRandom(CLOTHING_BY_CATEGORY[category], 'usa roupas práticas de viagem')
    const personality = pickRandom(PERSONALITY_POOL, 'determinado a encontrar seu lugar no mundo')
    const capClothing = clothing.charAt(0).toUpperCase() + clothing.slice(1)
    const capPersonality = personality.charAt(0).toUpperCase() + personality.slice(1)
    output.description = `${output.name} tem ${appearance}. ${capClothing}. ${capPersonality}.`
  }

  return output
}

function normalizeLookupKey(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
}

function collectEntries(source: unknown, prefix = '', depth = 0): Array<{ key: string; value: unknown }> {
  if (depth > 3 || !source || typeof source !== 'object') return []

  if (Array.isArray(source)) {
    return source.flatMap((item, index) => collectEntries(item, `${prefix}[${index}]`, depth + 1))
  }

  const record = source as Record<string, unknown>
  const entries: Array<{ key: string; value: unknown }> = []

  for (const [key, value] of Object.entries(record)) {
    const path = prefix ? `${prefix}.${key}` : key
    entries.push({ key: path, value })
    if (value && typeof value === 'object') {
      entries.push(...collectEntries(value, path, depth + 1))
    }
  }

  return entries
}

function repairTruncatedJson(text: string): string | null {
  let trimmed = text.trimEnd()
  if (!trimmed) return null

  // Remove trailing incomplete string value (e.g. truncated mid-sentence)
  // Pattern: remove a trailing unmatched quote + partial text
  trimmed = trimmed.replace(/,\s*$/, '')

  // Remove trailing key without value  e.g. ..."someKey":
  trimmed = trimmed.replace(/"[^"]*"\s*:\s*$/, '').replace(/,\s*$/, '')

  // Remove trailing incomplete string (opened quote never closed)
  // Count unescaped quotes to see if we have an open string
  const quoteCount = (trimmed.match(/(?<!\\)"/g) || []).length
  if (quoteCount % 2 !== 0) {
    // Truncated inside a string value — close it
    trimmed += '"'
  }

  // Remove trailing comma
  trimmed = trimmed.replace(/,\s*$/, '')

  // Count open/close brackets and braces to determine what needs closing
  const stack: string[] = []
  let inString = false
  let escape = false

  for (const ch of trimmed) {
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') stack.pop()
  }

  if (stack.length === 0) return trimmed

  // Close in reverse order
  return trimmed + stack.reverse().join('')
}

function parseJsonObjectDetailed(text: string): JsonParseResult | null {
  const raw = stripMarkdownFence(text)

  const tryParse = (input: string, source: JsonParseSource): JsonParseResult | null => {
    try {
      const parsed = JSON.parse(input)
      if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
        return { value: parsed[0] as Record<string, unknown>, source }
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { value: parsed as Record<string, unknown>, source }
      }
    } catch {
      return null
    }
    return null
  }

  const direct = tryParse(raw, 'direct')
  if (direct) return direct

  const start = raw.indexOf('{')
  if (start >= 0) {
    const end = raw.lastIndexOf('}')
    if (end > start) {
      const fragment = tryParse(raw.slice(start, end + 1), 'fragment')
      if (fragment) return fragment
    }

    // Truncated JSON: try repairing by closing all open brackets/braces
    const repaired = repairTruncatedJson(raw.slice(start))
    if (repaired) {
      const parsed = tryParse(repaired, 'repaired')
      if (parsed) return parsed
    }
  }

  // Last resort: extract "key": "value" pairs via regex
  const kvPattern = /"([^"\\]+)"\s*:\s*"((?:\\.|[^"\\])*)"/g
  let match: RegExpExecArray | null
  const record: Record<string, unknown> = {}
  while ((match = kvPattern.exec(raw)) !== null) {
    record[match[1]] = normalizeModelText(match[2])
  }
  if (Object.keys(record).length > 0) return { value: record, source: 'regex' }

  return null
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  return parseJsonObjectDetailed(text)?.value ?? null
}

function extractFieldFromRecord(source: Record<string, unknown>, aliases: string[]): unknown {
  const wanted = new Set(aliases.map(normalizeLookupKey))
  const direct = aliases.find((alias) => alias in source)
  if (direct) return source[direct]

  const entries = collectEntries(source)
  for (const entry of entries) {
    const keyLeaf = entry.key.split('.').at(-1) ?? entry.key
    if (wanted.has(normalizeLookupKey(keyLeaf))) return entry.value
  }

  return undefined
}

function buildSuggestedCharacterFromRecord(source: Record<string, unknown>): SuggestedCharacter {
  const nameValue = extractFieldFromRecord(source, ['name', 'nome', 'characterName', 'nomePersonagem'])
  const classValue = extractFieldFromRecord(source, [
    'characterClass',
    'class',
    'classe',
    'classePersonagem',
    'arquetipo',
    'arquétipo'
  ])
  const professionValue = extractFieldFromRecord(source, [
    'profession',
    'profissao',
    'profissão',
    'occupation',
    'ocupacao',
    'ocupação',
    'oficio',
    'ofício'
  ])
  const genderValue = extractFieldFromRecord(source, ['gender', 'sexo', 'genero', 'gênero'])
  const raceValue = extractFieldFromRecord(source, ['race', 'raca', 'raça', 'especie', 'espécie', 'species'])
  const descriptionValue = extractFieldFromRecord(source, [
    'description',
    'descricao',
    'descrição',
    'characterDescription',
    'resumo',
    'bio',
    'background'
  ])
  const campaignRoleValue = extractFieldFromRecord(source, [
    'campaignRole',
    'papel',
    'PAPEL',
    'papelNaCampanha',
    'role',
    'missao',
    'missão',
    'objetivo',
    'funcao',
    'função'
  ])

  return {
    name: sanitizeCharacterField(nameValue, 'Aventureiro'),
    gender: sanitizeCharacterField(genderValue, ''),
    race: sanitizeCharacterField(raceValue, 'Humano'),
    characterClass: sanitizeCharacterField(classValue, 'Aventureiro'),
    profession: sanitizeCharacterField(professionValue, ''),
    description: sanitizeCharacterField(descriptionValue, ''),
    campaignRole: sanitizeCharacterField(campaignRoleValue, '')
  }
}

function parseCharacterFromLooseText(text: string): Record<string, unknown> | null {
  const raw = stripMarkdownFence(text).replace(/\r\n?/g, '\n').trim()
  if (!raw) return null

  const flattened = raw
    .replace(/\*\*/g, '')
    .replace(/^[\-•]\s*/gm, '')
    .replace(/\s+/g, ' ')

  const lines = raw
    .split('\n')
    .map((line) => line.replace(/\*\*/g, '').replace(/^[\-•]\s*/, '').trim())
    .filter(Boolean)

  const stopAtNextLabel = (value: string): string =>
    value
      .replace(
        /(\s+)?(?:nome|name|sexo|gender|ra[cç]a|race|esp[eé]cie|classe|class|arqu[eê]tipo|profiss[aã]o|profession|occupation|of[ií]cio|descri[cç][aã]o|description|bio|background|papel|campanha|campaign|role|missao|miss[aã]o)\s*[:=\-].*$/i,
        ''
      )
      .trim()

  const cleanValue = (value: string): string => {
    const firstChunk = value.split(/[;|]/)[0] ?? value
    return stopAtNextLabel(firstChunk).trim()
  }

  const extractFromText = (source: string, patterns: RegExp[]): string | undefined => {
    for (const pattern of patterns) {
      const match = source.match(pattern)
      const value = match?.[1]?.trim()
      if (value) return cleanValue(value)
    }
    return undefined
  }

  const findInLines = (patterns: RegExp[]): string | undefined => {
    for (const line of lines) {
      const extracted = extractFromText(line, patterns)
      if (extracted) return extracted
    }
    return undefined
  }

  const namePatterns = [
    /(?:^|\b)(?:nome|name)\s*[:=\-]\s*([^\n]+)/i,
    /(?:^|\b)(?:personagem)\s*[:=\-]\s*([^\n]+)/i
  ]
  const genderPatterns = [
    /(?:^|\b)(?:sexo|gender|g[eê]nero)\s*[:=\-]\s*([^\n]+)/i
  ]
  const racePatterns = [
    /(?:^|\b)(?:ra[cç]a|race|esp[eé]cie|species)\s*[:=\-]\s*([^\n]+)/i
  ]
  const classPatterns = [
    /(?:^|\b)(?:classe|class|arqu[eê]tipo)\s*[:=\-]\s*([^\n]+)/i,
    /(?:^|\b)(?:tipo)\s*[:=\-]\s*([^\n]+)/i
  ]
  const professionPatterns = [
    /(?:^|\b)(?:profiss[aã]o|profession|occupation|of[ií]cio)\s*[:=\-]\s*([^\n]+)/i,
    /(?:^|\b)(?:papel|fun[cç][aã]o)\s*[:=\-]\s*([^\n]+)/i
  ]
  const descriptionPatterns = [
    /(?:^|\b)(?:descri[cç][aã]o|description|bio|background)\s*[:=\-]\s*([^\n]+)/i,
    /(?:^|\b)(?:resumo|conceito)\s*[:=\-]\s*([^\n]+)/i
  ]
  const campaignRolePatterns = [
    /(?:^|\b)(?:papel|PAPEL|papelenacampanha|campanha|campaign|role|miss[aã]o)\s*[:=\-]\s*([^\n]+)/i
  ]

  const name = findInLines(namePatterns) ?? extractFromText(flattened, namePatterns)
  const gender = findInLines(genderPatterns) ?? extractFromText(flattened, genderPatterns)
  const race = findInLines(racePatterns) ?? extractFromText(flattened, racePatterns)
  const characterClass = findInLines(classPatterns) ?? extractFromText(flattened, classPatterns)
  const profession = findInLines(professionPatterns) ?? extractFromText(flattened, professionPatterns)
  const description = findInLines(descriptionPatterns) ?? extractFromText(flattened, descriptionPatterns)
  const campaignRole = findInLines(campaignRolePatterns) ?? extractFromText(flattened, campaignRolePatterns)

  if (!name && !characterClass && !profession && !description) return null

  return {
    ...(name ? { name } : {}),
    ...(gender ? { gender } : {}),
    ...(race ? { race } : {}),
    ...(characterClass ? { characterClass } : {}),
    ...(profession ? { profession } : {}),
    ...(description ? { description } : {}),
    ...(campaignRole ? { campaignRole } : {})
  }
}

export class GeminiAdapter implements Narrator {
  private readonly provider = readLlmProvider()
  private readonly providerLabel = this.provider === 'deepseek' ? 'DeepSeek' : 'Gemini'
  private readonly logTag = this.provider === 'deepseek' ? 'deepseek' : 'gemini'
  private readonly apiKeyEnvName = this.provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'GEMINI_API_KEY'
  private readonly apiKey = this.provider === 'deepseek'
    ? readEnv('DEEPSEEK_API_KEY')
    : readEnv('GEMINI_API_KEY')
  private readonly model = this.provider === 'deepseek'
    ? readEnv('DEEPSEEK_MODEL', 'deepseek-chat')
    : readEnv('GEMINI_MODEL', 'gemini-2.5-flash')
  private readonly baseUrl = this.provider === 'deepseek'
    ? readEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')
    : readEnv('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com')
  private readonly temperature = toNumber(
    this.provider === 'deepseek'
      ? readEnv('DEEPSEEK_TEMPERATURE', '0.4')
      : readEnv('GEMINI_TEMPERATURE', '0.4'),
    0.4
  )
  private readonly maxOutputTokens = withMin(
    toNumber(
      this.provider === 'deepseek'
        ? readEnv('DEEPSEEK_MAX_OUTPUT_TOKENS', '8192')
        : readEnv('GEMINI_MAX_OUTPUT_TOKENS', '8192'),
      8192
    ),
    8192
  )
  private readonly worldMaxOutputTokens = withMin(
    toNumber(
      this.provider === 'deepseek'
        ? readEnv('DEEPSEEK_WORLD_MAX_OUTPUT_TOKENS', '16384')
        : readEnv('GEMINI_WORLD_MAX_OUTPUT_TOKENS', '16384'),
      16384
    ),
    4096
  )
  private readonly narrateStartMaxTokens = withMin(
    toNumber(
      this.provider === 'deepseek'
        ? readEnv('DEEPSEEK_NARRATE_START_MAX_TOKENS', '8192')
        : readEnv('GEMINI_NARRATE_START_MAX_TOKENS', '8192'),
      8192
    ),
    2048
  )
  private readonly narrateTurnMaxTokens = withMin(
    toNumber(
      this.provider === 'deepseek'
        ? readEnv('DEEPSEEK_NARRATE_TURN_MAX_TOKENS', '8192')
        : readEnv('GEMINI_NARRATE_TURN_MAX_TOKENS', '8192'),
      8192
    ),
    2048
  )
  private readonly timeoutMs = withMin(
    toNumber(
      this.provider === 'deepseek'
        ? readEnv('DEEPSEEK_TIMEOUT_MS', '90000')
        : readEnv('GEMINI_TIMEOUT_MS', '90000'),
      90000
    ),
    15000
  )
  private readonly narratorTimeoutMs = withMin(
    toNumber(
      this.provider === 'deepseek'
        ? readEnv('DEEPSEEK_NARRATOR_TIMEOUT_MS', '120000')
        : readEnv('GEMINI_NARRATOR_TIMEOUT_MS', '120000'),
      120000
    ),
    30000
  )
  private readonly narrateStartTemperature = toNumber(
    this.provider === 'deepseek'
      ? readEnv('DEEPSEEK_NARRATE_START_TEMPERATURE', '0.45')
      : readEnv('GEMINI_NARRATE_START_TEMPERATURE', '0.50'),
    this.provider === 'deepseek' ? 0.45 : 0.50
  )
  private readonly narrateTurnTemperature = toNumber(
    this.provider === 'deepseek'
      ? readEnv('DEEPSEEK_NARRATE_TURN_TEMPERATURE', '0.40')
      : readEnv('GEMINI_NARRATE_TURN_TEMPERATURE', '0.45'),
    this.provider === 'deepseek' ? 0.40 : 0.45
  )
  private readonly summaryTemperature = toNumber(
    this.provider === 'deepseek'
      ? readEnv('DEEPSEEK_SUMMARY_TEMPERATURE', '0.15')
      : readEnv('GEMINI_SUMMARY_TEMPERATURE', '0.20'),
    this.provider === 'deepseek' ? 0.15 : 0.20
  )
  private readonly summaryHistoryTemperature = toNumber(
    this.provider === 'deepseek'
      ? readEnv('DEEPSEEK_SUMMARY_HISTORY_TEMPERATURE', '0.10')
      : readEnv('GEMINI_SUMMARY_HISTORY_TEMPERATURE', '0.15'),
    this.provider === 'deepseek' ? 0.10 : 0.15
  )
  private readonly characterSuggestionTemperature = toNumber(
    this.provider === 'deepseek'
      ? readEnv('DEEPSEEK_CHARACTER_SUGGEST_TEMPERATURE', '1.0')
      : readEnv('GEMINI_CHARACTER_SUGGEST_TEMPERATURE', '1.0'),
    1.0
  )
  private readonly imageDescriptionTemperature = toNumber(
    this.provider === 'deepseek'
      ? readEnv('DEEPSEEK_IMAGE_DESCRIPTION_TEMPERATURE', '0.55')
      : readEnv('GEMINI_IMAGE_DESCRIPTION_TEMPERATURE', '0.55'),
    0.55
  )
  private readonly normalizedBaseUrl = this.baseUrl.replace(/\/+$/, '')

  private generateTextCallId = 0

  /**
   * Chamada genérica ao Gemini generateContent.
   * @param promptOrContents - string (single-turn) ou ContentEntry[] (multi-turn)
   * @param options - opções de geração
   * @param attempt - número da tentativa (1 = primeira, 2 = retry, etc.)
   */
  private async generateTextDetailed(
    promptOrContents: string | ContentEntry[],
    options: GenerateTextOptions = {},
    attempt: number = 1
  ): Promise<GenerateTextResult> {
    if (this.provider === 'deepseek') {
      return await this.generateDeepSeekTextDetailed(promptOrContents, options, attempt)
    }

    return await this.generateGeminiTextDetailed(promptOrContents, options, attempt)
  }

  private async generateGeminiTextDetailed(
    promptOrContents: string | ContentEntry[],
    options: GenerateTextOptions = {},
    attempt: number = 1
  ): Promise<GenerateTextResult> {
    if (!this.apiKey) {
      throw new Error(`${this.apiKeyEnvName} não configurada`)
    }

    const callTag = `${this.provider}-call-${++this.generateTextCallId}${attempt > 1 ? `/tentativa-${attempt}` : ''}`
    log(this.logTag, `Iniciando ${callTag} (tentativa ${attempt})`)
    const url = `${this.normalizedBaseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`
    const controller = new AbortController()
    const maxOutputTokens = options.maxOutputTokens ?? this.maxOutputTokens
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const responseMimeType = options.responseMimeType
    const temperature = options.temperature ?? this.temperature
    const systemInstruction = options.systemInstruction
    const thinkingBudget = options.thinkingBudget
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    // Montar contents conforme tipo do input
    const isMultiTurn = Array.isArray(promptOrContents)
    const contents = isMultiTurn
      ? promptOrContents.map((entry) => ({ role: entry.role, parts: [{ text: entry.text }] }))
      : [{ parts: [{ text: promptOrContents }] }]

    const logPrompt = isMultiTurn ? promptOrContents : promptOrContents

    logLlmRequest(callTag, {
      systemPrompt: systemInstruction,
      userPrompt: logPrompt,
      model: this.model,
      maxOutputTokens,
      temperature
    })

    const startMs = Date.now()

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(systemInstruction
            ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
            : {}),
          contents,
          generationConfig: {
            temperature,
            maxOutputTokens,
            ...(responseMimeType ? { responseMimeType } : {}),
            ...(thinkingBudget !== undefined
              ? { thinkingConfig: { thinkingBudget } }
              : {})
          }
        }),
        signal: controller.signal
      })

      const raw = await response.text()
      if (!response.ok) {
        const err = new Error(`${this.providerLabel} HTTP ${response.status}: ${raw.slice(0, 200)}`)
        logLlmError(callTag, err)
        throw err
      }

      const parsed = raw ? (JSON.parse(raw) as GeminiGenerateContentResponse) : {}
      const text = extractText(parsed)
      if (!text) {
        const err = new Error(`${this.providerLabel} retornou conteúdo vazio`)
        logLlmError(callTag, err)
        throw err
      }

      const durationMs = Date.now() - startMs
      const usage = parsed.usageMetadata
      const finishReason = normalizeFinishReason(this.provider, parsed.candidates?.[0]?.finishReason)
      logLlmResponse(callTag, {
        rawLength: text.length,
        responseText: text,
        durationMs,
        finishReason,
        promptTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount
      })

      return {
        text,
        finishReason,
        promptTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount,
        durationMs
      }
    } catch (err) {
      logLlmError(callTag, err)
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  private async generateDeepSeekTextDetailed(
    promptOrContents: string | ContentEntry[],
    options: GenerateTextOptions = {},
    attempt: number = 1
  ): Promise<GenerateTextResult> {
    if (!this.apiKey) {
      throw new Error(`${this.apiKeyEnvName} não configurada`)
    }

    const callTag = `${this.provider}-call-${++this.generateTextCallId}${attempt > 1 ? `/tentativa-${attempt}` : ''}`
    log(this.logTag, `Iniciando ${callTag} (tentativa ${attempt})`)

    const controller = new AbortController()
    const requestedMaxOutputTokens = options.maxOutputTokens ?? this.maxOutputTokens
    const maxOutputTokens = clamp(requestedMaxOutputTokens, 1, DEEPSEEK_MAX_TOKENS_LIMIT)
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const responseMimeType = options.responseMimeType
    const temperature = options.temperature ?? this.temperature
    const systemInstruction = options.systemInstruction
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    if (maxOutputTokens !== requestedMaxOutputTokens) {
      warn(
        this.logTag,
        `max_tokens ajustado de ${requestedMaxOutputTokens} para ${maxOutputTokens} (limite do DeepSeek)`
      )
    }

    const logPrompt = Array.isArray(promptOrContents) ? promptOrContents : promptOrContents
    logLlmRequest(callTag, {
      systemPrompt: systemInstruction,
      userPrompt: logPrompt,
      model: this.model,
      maxOutputTokens,
      temperature
    })

    const startMs = Date.now()

    try {
      const response = await fetch(`${this.normalizedBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          messages: buildOpenAiCompatibleMessages(promptOrContents, systemInstruction),
          temperature,
          max_tokens: maxOutputTokens,
          stream: false,
          ...(responseMimeType === 'application/json'
            ? { response_format: { type: 'json_object' } }
            : {})
        }),
        signal: controller.signal
      })

      const raw = await response.text()
      if (!response.ok) {
        const err = new Error(`${this.providerLabel} HTTP ${response.status}: ${raw.slice(0, 200)}`)
        logLlmError(callTag, err)
        throw err
      }

      const parsed = raw ? (JSON.parse(raw) as DeepSeekChatCompletionResponse) : {}
      const text = extractDeepSeekText(parsed)
      if (!text) {
        const err = new Error(`${this.providerLabel} retornou conteúdo vazio`)
        logLlmError(callTag, err)
        throw err
      }

      const durationMs = Date.now() - startMs
      const usage = parsed.usage
      const finishReason = normalizeFinishReason(this.provider, parsed.choices?.[0]?.finish_reason)

      logLlmResponse(callTag, {
        rawLength: text.length,
        responseText: text,
        durationMs,
        finishReason,
        promptTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens
      })

      return {
        text,
        finishReason,
        promptTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        durationMs
      }
    } catch (err) {
      logLlmError(callTag, err)
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  private async generateText(
    promptOrContents: string | ContentEntry[],
    options: GenerateTextOptions = {},
    attempt: number = 1
  ): Promise<string> {
    const result = await this.generateTextDetailed(promptOrContents, options, attempt)
    return result.text
  }

  async summarize(req: SummarizeRequest): Promise<string> {
    const state = req.currentState
    const p = state.player
    const npcsAtLocation = state.npcs.filter((npc) => !npc.location || npc.location === state.worldState.activeLocation)
    const hostileNpcs = npcsAtLocation.filter((npc) => npc.disposition === 'hostile')
    const activeFlags = Object.entries(state.worldState.worldFlags)
      .filter(([, value]) => value)
      .map(([key]) => key)

    const combatText = state.combat
      ? `Combate ativo na rodada ${state.combat.round} com ${state.combat.combatants.length} combatentes.`
      : 'Sem combate formal em andamento.'
    const threatsText = hostileNpcs.length
      ? hostileNpcs
        .slice(0, 6)
        .map((npc) => `${npc.name}${npc.wounds > 0 ? ` ferido ${npc.wounds}/${npc.maxWounds}` : ''}`)
        .join(', ')
      : 'Sem ameaça imediata confirmada.'
    const resourcesText = p.inventory.length
      ? p.inventory.slice(0, 8).map((item) => `${item.name} x${item.quantity}`).join(', ')
      : 'Nenhum recurso relevante carregado.'
    const forcesText = npcsAtLocation.length
      ? npcsAtLocation
        .slice(0, 8)
        .map((npc) => `${npc.name}${npc.disposition ? ` (${npc.disposition})` : ''}`)
        .join(', ')
      : 'Ninguém relevante visível no local.'
    const statusText = p.statusEffects.length
      ? p.statusEffects.map((effect) => `${effect.name}${effect.turnsRemaining != null ? ` (${effect.turnsRemaining}t)` : ''}`).join(', ')
      : 'Nenhum efeito ativo.'
    const activeFlagsText = activeFlags.length ? activeFlags.join(', ') : 'Nenhuma flag ativa relevante.'

    const sysPrompt = [
      'Você mantém o resumo canônico de continuidade de uma sessão de RPG Savage Worlds.',
      'Objetivo: gerar um resumo que preserva TANTO a continuidade mecânica QUANTO os fios narrativos abertos — permitindo que o narrador construa sobre o que já foi estabelecido.',
      'Regras:',
      '- Escreva em parágrafos corridos, sem títulos, rótulos ou seções.',
      '- Use 2 a 4 parágrafos — as informações que importam para a continuação imediata e para a coerência narrativa.',
      '- Preserve fatos que afetam a situação atual: posição, ameaças, objetivos pendentes, problemas não resolvidos.',
      '- TAMBÉM preserve fios narrativos abertos: mistérios levantados, promessas feitas, segredos revelados, perguntas sem resposta, tensões não resolvidas.',
      '- Preserve nome e pelo menos 1 traço de personalidade ou motivação de NPCs relevantes que apareceram — não apenas disposição.',
      '- Preserve descobertas de worldbuilding que podem ser referenciadas: detalhes específicos de locais, lore revelado, facções mencionadas, objetos significativos.',
      '- Não reconte a ação passo a passo. Não descreva golpes, quedas ou mortes antigas a menos que continuem ativas como consequência.',
      '- Nunca liste itens do inventário no resumo — eles são rastreados separadamente.',
      '- Preserve nomes próprios e contagens relevantes quando afetarem a próxima decisão.',
      '- Não use markdown, bullets, prefácio, saudação ou comentários metalinguísticos.'
    ].join('\n')

    const narrativeBlock = req.recentMessages?.length
      ? `Mensagens da sessão (ordem cronológica — inclui abertura e recentes):\n${req.recentMessages.map((m) => `[${m.role === 'narrator' ? 'Narrador' : 'Jogador'} T${m.turn}] ${m.text}`).join('\n')}`
      : null

    const prompt = [
      `Turno atual: ${req.upToTurn}.`,
      `Resumo anterior canônico: ${req.previousSummary || 'sem resumo anterior'}.`,
      `Local atual: ${state.worldState.activeLocation}.`,
      combatText,
      `Ferimentos: ${p.wounds}/${p.maxWounds}. Fadiga: ${p.fatigue}. Abalado: ${p.isShaken ? 'sim' : 'não'}. Bennies: ${p.bennies}.`,
      `Ameaças visíveis: ${threatsText}`,
      `Forças/NPCs relevantes no local: ${forcesText}`,
      `Efeitos ativos: ${statusText}`,
      `Flags de mundo ativas: ${activeFlagsText}`,
      `Eventos novos (JSON): ${JSON.stringify(req.keyEvents)}.`,
      narrativeBlock,
      'Atualize o resumo canônico sem repetir fatos antigos que já estejam cobertos.'
    ].filter(Boolean).join('\n')

    try {
      const generated = await this.generateText(prompt, {
        systemInstruction: sysPrompt,
        temperature: this.summaryTemperature
      })
      return sanitizeNarrativeOutput(generated)
    } catch {
      const parts: string[] = []
      parts.push(`O personagem está em ${state.worldState.activeLocation}. ${combatText}`)
      if (threatsText !== 'Sem ameaça imediata confirmada.') parts.push(threatsText)
      if (resourcesText !== 'Nenhum recurso relevante carregado.') parts.push(`Recursos disponíveis: ${resourcesText}.`)
      return parts.join(' ')
    }
  }

  async summarizeHistory(req: SummarizeHistoryRequest): Promise<string> {
    const state = req.currentState
    const p = state.player
    const npcsAtLocation = state.npcs.filter((npc) => !npc.location || npc.location === state.worldState.activeLocation)
    const hostileNpcs = npcsAtLocation.filter((npc) => npc.disposition === 'hostile')
    const activeFlags = Object.entries(state.worldState.worldFlags)
      .filter(([, value]) => value)
      .map(([key]) => key)

    const combatText = state.combat
      ? `Combate ativo na rodada ${state.combat.round} com ${state.combat.combatants.length} combatentes.`
      : 'Sem combate formal em andamento.'
    const threatsText = hostileNpcs.length
      ? hostileNpcs
        .slice(0, 6)
        .map((npc) => `${npc.name}${npc.wounds > 0 ? ` ferido ${npc.wounds}/${npc.maxWounds}` : ''}`)
        .join(', ')
      : 'Sem ameaça imediata confirmada.'
    const forcesText = npcsAtLocation.length
      ? npcsAtLocation
        .slice(0, 8)
        .map((npc) => `${npc.name}${npc.disposition ? ` (${npc.disposition})` : ''}`)
        .join(', ')
      : 'Ninguém relevante visível no local.'
    const statusText = p.statusEffects.length
      ? p.statusEffects.map((effect) => `${effect.name}${effect.turnsRemaining != null ? ` (${effect.turnsRemaining}t)` : ''}`).join(', ')
      : 'Nenhum efeito ativo.'
    const activeFlagsText = activeFlags.length ? activeFlags.join(', ') : 'Nenhuma flag ativa relevante.'

    const sysPrompt = [
      'Você mantém o resumo canônico de continuidade de uma sessão de RPG.',
      'Regras:',
      '- Use o resumo anterior como base principal e as mensagens fornecidas para incorporar contexto que ainda importe para a continuação imediata e para a coerência narrativa.',
      '- Não reconte a ação passo a passo e não duplique fatos já cobertos pelo resumo anterior.',
      '- Preserve posição atual, ameaça ativa, forças em cena e problema imediato.',
      '- TAMBÉM preserve fios narrativos abertos incorporados nas mensagens: mistérios, tensões, promessas, segredos, relações estabelecidas com NPCs.',
      '- Preserve nome e traço de personalidade de NPCs relevantes que aparecem no histórico — não apenas disposição.',
      '- Preserve descobertas de worldbuilding específicas: locais descritos, lore revelado, objetos significativos mencionados.',
      '- Nunca liste itens do inventário no resumo — eles são rastreados separadamente.',
      '- Escreva em parágrafos corridos, sem títulos, rótulos ou seções.',
      '- Use 2 a 4 parágrafos — as informações que ainda importam para continuação e coerência.',
      '- Preserve nomes próprios e contagens relevantes quando afetarem o próximo turno.',
      '- Não use markdown, bullets, prefácio, saudação ou comentários metalinguísticos.'
    ].join('\n')

    const messagesText = req.messages
      .map((m) => `[Turno ${m.turn}] ${m.role === 'narrator' ? 'Narrador' : 'Jogador'}: ${m.text}`)
      .join('\n')

    const prompt = [
      req.previousSummary ? `RESUMO CANÔNICO ATUAL:\n${req.previousSummary}\n` : 'RESUMO CANÔNICO ATUAL: sem resumo anterior\n',
      'MENSAGENS QUE SERÃO COMPACTADAS:',
      messagesText,
      '',
      `Local atual: ${state.worldState.activeLocation}.`,
      combatText,
      `Ferimentos: ${p.wounds}/${p.maxWounds}. Fadiga: ${p.fatigue}. Abalado: ${p.isShaken ? 'sim' : 'não'}. Bennies: ${p.bennies}.`,
      `Ameaças visíveis: ${threatsText}`,
      `Forças/NPCs relevantes no local: ${forcesText}`,
      `Efeitos ativos: ${statusText}`,
      `Flags de mundo ativas: ${activeFlagsText}`,
      '',
      'Atualize o resumo canônico final sem perder continuidade útil e sem repetir detalhes irrelevantes.'
    ].filter(Boolean).join('\n')

    let lastError: Error | null = null
    const attempts = [
      { maxOutputTokens: 2048, temperature: this.summaryHistoryTemperature },
      { maxOutputTokens: 4096, temperature: Math.max(0.05, this.summaryHistoryTemperature - 0.05) }
    ]

    for (let index = 0; index < attempts.length; index += 1) {
      const current = attempts[index]

      try {
        const result = await this.generateTextDetailed(prompt, {
          systemInstruction: sysPrompt,
          maxOutputTokens: current.maxOutputTokens,
          temperature: current.temperature
        }, index + 1)
        const cleaned = sanitizeNarrativeOutput(result.text)

        if (!cleaned) {
          lastError = new Error('Resumo histórico vazio')
          warn('summarizeHistory', `Tentativa ${index + 1} retornou resumo vazio`)
          continue
        }

        if (result.finishReason === 'MAX_TOKENS' || (!endsWithSentenceBoundary(cleaned) && cleaned.length >= 180)) {
          lastError = new Error(`Resumo histórico truncado (finish=${result.finishReason ?? 'unknown'})`)
          warn('summarizeHistory', `Tentativa ${index + 1} truncou o resumo histórico (finish=${result.finishReason ?? 'unknown'}, len=${cleaned.length})`)
          continue
        }

        return cleaned
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        warn('summarizeHistory', `Tentativa ${index + 1} falhou: ${lastError.message}`)
      }
    }

    logErr('summarizeHistory', 'Error:', lastError)
    throw lastError ?? new Error('Não foi possível gerar um resumo histórico confiável')
  }

  async expandAdventureStory(req: ExpandWorldRequest): Promise<ExpandAdventureStoryResult> {
    const sysPrompt = [
      'Você é um worldbuilder de RPG. Escreva em português do Brasil.',
      'Objetivo: criar ou expandir uma campanha de RPG completa a partir de um contexto mínimo.',
      'Saída esperada: um JSON válido com os seguintes campos:',
      '  "name": título curto e evocativo para a campanha (5-8 palavras).',
      '  "thematic": temática resumida da campanha (1 frase curta, ex: "Império em colapso e magia proibida").',
      '  "storyDescription": 3-6 parágrafos curtos com contexto, conflitos, facções, locais e 2-4 ganchos de aventura.',
      '  "storyCharacters": array de 3 a 7 NPCs do mundo relevantes para a narrativa, cada um com:',
      '    - "name": nome do personagem',
      '    - "role": papel na história (ex: antagonista, mentor, aliado, líder de facção, neutro)',
      '    - "description": descrição breve do personagem (1-2 frases)',
      '    - "status": situação atual na história (ex: ativo, foragido, morto, desconhecido)',
      'Restrições: retorne SOMENTE o JSON, sem prefácio, saudação, comentários ou separadores.',,
      'Se já existir uma temática ou descrição fornecida, mantenha consistência e evolua — não repita literalmente.',
      'Comece diretamente com { e termine com }.'
    ].join('\n')

    const prompt = [
      `Nome/contexto da campanha: ${req.campaignName || 'livre'}.`,
      `Temática (se informada): ${req.thematic?.trim() || 'a definir pelo LLM'}.`,
      `Descrição atual (se existir): ${req.currentDescription?.trim() || 'nenhuma'}.`
    ].join('\n')

    try {
      const generated = await this.generateText(prompt, {
        maxOutputTokens: this.worldMaxOutputTokens,
        timeoutMs: this.timeoutMs,
        systemInstruction: sysPrompt
      })

      const cleaned = generated.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
      const firstBrace = cleaned.indexOf('{')
      const lastBrace = cleaned.lastIndexOf('}')
      const jsonStr = firstBrace !== -1 && lastBrace > firstBrace ? cleaned.slice(firstBrace, lastBrace + 1) : cleaned

      let parsed: { name?: unknown; thematic?: unknown; storyDescription?: unknown; storyCharacters?: unknown }
      try {
        parsed = JSON.parse(jsonStr)
      } catch {
        // Fallback: retorna texto gerado como storyDescription sem personagens
        return { storyDescription: sanitizeNarrativeOutput(generated), storyCharacters: [] }
      }

      const storyDescription = sanitizeNarrativeOutput(
        typeof parsed.storyDescription === 'string' ? parsed.storyDescription : ''
      )

      const rawChars = Array.isArray(parsed.storyCharacters) ? parsed.storyCharacters : []
      const storyCharacters: StoryCharacter[] = rawChars
        .slice(0, 7)
        .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
        .map((c) => ({
          name: typeof c.name === 'string' ? c.name.trim() : '',
          role: typeof c.role === 'string' ? c.role.trim() : 'personagem',
          description: typeof c.description === 'string' ? c.description.trim() : '',
          status: typeof c.status === 'string' ? c.status.trim() : 'desconhecido'
        }))
        .filter((c) => c.name.length > 0)

      const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined
      const thematic = typeof parsed.thematic === 'string' && parsed.thematic.trim() ? parsed.thematic.trim() : undefined

      return { storyDescription, storyCharacters, name, thematic }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido'
      throw new Error(`Falha ao gerar história com ${this.providerLabel}: ${message}`)
    }
  }

  async expandWorldLore(req: ExpandWorldLoreRequest): Promise<string> {
    const sysPrompt = [
      'Você é um worldbuilder sênior especializado em RPG de mesa. Escreva exclusivamente em português do Brasil.',
      '',
      'Escreva com clareza e precisão — o texto serve tanto para quem nunca ouviu falar deste universo quanto para quem vai jogar nele.',
      'Ao introduzir pela primeira vez qualquer nome próprio, facção, tecnologia ou conceito exclusivo do universo, explique-o brevemente em linha — uma frase é suficiente.',
      'Crie coerência interna: nomes próprios, locais e facções mencionados em uma seção devem reaparecer e se reforçar nas demais.',
      'A escrita pode ser atmosférica e literária, mas nunca pressuponha que o leitor já conhece o cenário.'
    ].join('\n')

    const tema = [
      `Nome: ${req.name}.`,
      ...(req.description ? [`Descrição: ${req.description}.`] : []),
      ...(req.currentLore?.trim() ? [`Lore atual (mantenha consistência e expanda): ${req.currentLore.trim()}.`] : [])
    ].join('\n')

    const prompt = [
      `Tema: ${tema}`,
      '',
      'Construa o lore completo deste universo de RPG. Use OBRIGATORIAMENTE os 7 cabeçalhos abaixo, nesta ordem e sem alterar o texto dos cabeçalhos.',
      'Seções marcadas com (se aplicável) devem ser incluídas apenas se forem relevantes ao tema fornecido.',
      '',
      '## Em Poucas Palavras',
      'Explique este universo para alguém que nunca ouviu falar dele. Use linguagem direta, sem jargão.',
      'Responda em 3 a 5 frases:',
      '  • O que é este mundo? (uma frase-âncora: "É um mundo onde...", "Imagine X, mas Y")',
      '  • O que o distingue de outros universos do mesmo gênero? (o diferencial real, não o óbvio)',
      '  • O que qualquer jogador vê, ouve e sente no primeiro dia neste mundo? (realidade cotidiana concreta)',
      '',
      '## Atmosfera e Tom',
      'Descreva a estética visual dominante, o humor emocional do universo e a paleta sensorial (sons, cheiros, luz, temperatura).',
      'Defina a tensão central que permeia o cenário — esperança vs. desespero, ordem vs. caos, etc.',
      '3 parágrafos densos.',
      '',
      '## Origens e História',
      'Apresente as eras ou fases históricas que moldaram o presente, do macro (cosmologia, criação) ao micro (evento catalisador recente).',
      'Inclua ao menos um mistério histórico não resolvido que possa ser explorado em aventuras.',
      '3 parágrafos densos.',
      '',
      '## Doenças, Pragas e Contaminações (se aplicável)',
      'Se existirem doenças, vírus, pragas ou contaminações relevantes neste universo, defina:',
      '- **Origem:** natural, manufaturada, alienígena, mágica ou desconhecida.',
      '- **Vetor e progressão:** como se transmite, quais os estágios e quanto tempo cada um dura.',
      '- **Efeitos nos personagens:** consequências físicas, psicológicas e sociais — como a sociedade trata os infectados (isolamento, cura forçada, sacrifício, estigma)?',
      '- **Dilema narrativo:** existe cura? Quem a controla e por quê? A cura tem um custo moral?',
      '- **Impacto sistêmico:** a doença alterou estruturas políticas, religiosas ou econômicas do mundo?',
      '2 a 3 parágrafos densos.',
      '',
      '## Invasão e Presença Externa (se aplicável)',
      'Se existir uma força invasora — alienígena, interdimensional, divina ou outra — defina:',
      '- **Natureza da ameaça:** o que são, de onde vieram, o que querem. Eles comunicam? Negociam? São ininteligíveis?',
      '- **Modo de operação:** atacam em ondas, infiltram silenciosamente, transformam o ambiente, corrompem mentes?',
      '- **O que acontece com capturados ou expostos:** morte, transformação, escravidão, simbiose involuntária?',
      '- **Estado atual da invasão:** é recente e caótica, ou estabelecida há gerações e normalizada pela população?',
      '- **Resistência e adaptação:** como as facções responderam? Existe colaboração com os invasores?',
      '3 parágrafos densos.',
      '',
      '## Locais Marcantes',
      'Liste exatamente 2-5 locais canônicos. Para cada um, use este formato:',
      '*   **Nome do Local:** Descrição de 2 a 3 frases que capture sua função, atmosfera e por que é narrativamente relevante.',
      '',
      '## Facções e Poder',
      'Descreva 4 grupos com objetivos, filosofia e relações entre si. Cada facção deve ter uma tensão com pelo menos uma outra.',
      '3 parágrafos densos.',
      '',
      '## Magia, Tecnologia e Regras do Mundo',
      'Defina o que é possível neste universo: fontes de poder, limitações concretas e o que é proibido ou desconhecido.',
      'Inclua como esse sistema de regras cria dilemas morais para os personagens.',
      '3 parágrafos densos.',
      '',
      '### Poderes e Habilidades Especiais (se aplicável)',
      'Se personagens puderem ter poderes ou habilidades além do humano comum, defina:',
      '- **Origem dos poderes:** nascença, acidente, ritual, tecnologia, infecção, escolha divina?',
      '- **Custo e limitações concretas:** cansaço físico, perda de sanidade, redução de tempo de vida, dependência de recurso externo?',
      '- **Como a sociedade enxerga quem tem poderes:** reverenciados, perseguidos, recrutados à força, escondidos?',
      '- **Poderes proibidos ou desconhecidos:** existe algo que poderia ser feito mas que ninguém ousou ou sobreviveu para contar?',
      '- **Progressão e perda:** poderes podem crescer? Podem ser roubados, corrompidos ou perdidos permanentemente?',
      '2 parágrafos densos.',
      '',
      '## Ameaças e Conflitos',
      'Descreva os perigos recorrentes (internos e externos), o estado atual de tensão e um gatilho iminente que pode precipitar nova crise.',
      '3 parágrafos densos.',
      '',
      '## Impacto nos Personagens',
      'Traduza as forças do mundo em consequências concretas para quem vive nele:',
      '- **Traumas e marcas do cenário:** que bagagem emocional ou física a maioria dos personagens carrega por existir neste mundo?',
      '- **Escolhas recorrentes:** que dilemas o cenário força repetidamente — lealdade vs. sobrevivência, poder vs. custo humano?',
      '- **O que os personagens não sabem:** quais verdades são sistematicamente ocultadas da população comum?',
      '- **Pontos de virada pessoal:** que eventos podem mudar permanentemente um personagem — exposição a doença, contato com invasores, manifestação de poder, revelação histórica?',
      '2 parágrafos densos.',
      '',
      'Restrições absolutas: nenhum comentário fora do lore, nenhuma saudação, elogio, prefácio ou separador (***). Omita seções marcadas como (se aplicável) se não forem pertinentes ao tema. Comece imediatamente com ## Em Poucas Palavras.'
    ].join('\n')

    try {
      const generated = await this.generateText(prompt, {
        maxOutputTokens: this.worldMaxOutputTokens,
        timeoutMs: this.timeoutMs,
        systemInstruction: sysPrompt
      })
      return sanitizeNarrativeOutput(generated)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido'
      throw new Error(`Falha ao gerar lore com ${this.providerLabel}: ${message}`)
    }
  }

  async generateImageDescription(req: GenerateImageDescriptionRequest): Promise<string> {
    const sysPrompt = [
      'Você cria descrições visuais curtas para geração de imagem fotográfica.',
      'Saída esperada: um único parágrafo curto, com 1 ou 2 frases, focado em atmosfera, composição, cenário e detalhes visuais memoráveis.',
      'Se o título remeter a um filme, série, game, HQ ou livro conhecido, inspire-se na estética da arte de capa ou pôster oficial dessa obra: paleta de cores predominante, composição, enquadramento e atmosfera visual — mas sem reproduzir personagens protegidos, atores reais, rostos reconhecíveis, logotipos, títulos ou marcas.',
      'Caso o título não remeta a nenhuma obra conhecida, descreva uma cena épica e original coerente com o nome.',
      'Entregue somente a descrição visual final, sem listas, sem markdown, sem comentários sobre o pedido e sem instruções negativas.'
    ].join('\n')

    let prompt = ''

    if (req.entityType === 'world') {
      prompt = [
        `Título do universo: ${req.title}.`,
        'Se esse título remeter a um filme, série, game, HQ ou livro famoso, baseie TODA a descrição na estética visual característica dessa obra: paleta de cores, composição, atmosfera, iluminação e estilo visual — sem copiar personagens protegidos, atores reais, logotipos ou marcas. O tema da referência deve guiar cada elemento visual da imagem.',
        'Caso contrário, descreva uma cena épica e original com identidade visual forte e coerente com o nome e o tema do universo, capturando a essência temática de modo que toda a imagem reflita esse universo.',
      ].join('\n')
    } else if (req.entityType === 'campaign') {
      prompt = [
        `Título da campanha: ${req.title}.`,
        'Descreva uma imagem ampla que traduza a atmosfera da campanha como uma arte ilustrada marcante e cinematográfica.'
      ].join('\n')
    } else {
      prompt = [
        `Mundo: ${req.worldName}.`,
        `Campanha: ${req.campaignTitle}.`,
        ...(req.gender?.trim() ? [`Gênero: ${req.gender}.`] : []),
        ...(req.race?.trim() ? [`Raça ou espécie: ${req.race}.`] : []),
        `Classe: ${req.characterClass}.`,
        `Profissão: ${req.profession}.`,
        ...(req.additionalDescription?.trim() ? [`Detalhes fornecidos: ${req.additionalDescription}.`] : []),
        'Descreva um retrato de personagem coerente com esse contexto, destacando silhueta, vestimenta, expressão, postura e traços visuais marcantes.'
      ].join('\n')
    }

    try {
      const generated = await this.generateText(prompt, {
        maxOutputTokens: 180,
        timeoutMs: this.timeoutMs,
        temperature: this.imageDescriptionTemperature,
        systemInstruction: sysPrompt
      })
      return sanitizeImageDescriptionOutput(generated)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido'
      throw new Error(`Falha ao gerar descrição visual com ${this.providerLabel}: ${message}`)
    }
  }

  async suggestCharacterFromWorld(req: SuggestCharacterFromWorldRequest): Promise<SuggestedCharacter> {
    const existing = req.existingFields ?? {}
    const hasExisting = Object.values(existing).some(v => v?.trim())

    const existingLines: string[] = []
    if (hasExisting) {
      existingLines.push(
        'O jogador já preencheu os seguintes campos — MANTENHA esses valores exatamente como estão e preencha apenas os campos faltantes:'
      )
      if (existing.name) existingLines.push(`  name: "${existing.name}"`)
      if (existing.gender) existingLines.push(`  gender: "${existing.gender}"`)
      if (existing.race) existingLines.push(`  race: "${existing.race}"`)
      if (existing.characterClass) existingLines.push(`  characterClass: "${existing.characterClass}"`)
      if (existing.profession) existingLines.push(`  profession: "${existing.profession}"`)
      if (existing.description) existingLines.push(`  description: "${existing.description}"`)
      if (existing.campaignRole) existingLines.push(`  campaignRole: "${existing.campaignRole}"`)
    }

    const sysPrompt = [
      'Você é um designer de personagens para RPG.',
      'Leia o enredo fornecido e crie um personagem cujo papel e classe emergem NATURALMENTE da história — não escolha o arquétipo mais genérico.',
      'NÃO use os nomes: Kael, Khael, Kaell, Cael.',
      'NÃO use Guerreiro + Humano + Mercenário como combinação padrão — só os escolha se o enredo pedir diretamente.',
      'Exemplos de como derivar classe do enredo:',
      '  - Segredos, intrigas, poder → Espião, Arauto, Ladino, Diplomata',
      '  - Magia proibida, mistérios arcanos → Arcanista, Oráculo, Bruxo, Estudioso',
      '  - Conflito religioso, doenças, morte → Curandeiro, Clérigo, Sacerdote, Herético',
      '  - Exploração, territórios desconhecidos → Explorador, Batedor, Cartógrafa, Guia',
      '  - Comércio, contrabando, recursos → Negociante, Contrabandista, Atravessador',
      '  - Guerra, ocupação, resistência → Soldado, Guerrilheiro, Estrategista, Mensageiro',
      'Responda SOMENTE em JSON válido, sem markdown e sem comentários.',
      'Todos os 7 campos são OBRIGATÓRIOS e não podem estar vazios:',
      '{"name":"...","gender":"...","race":"...","characterClass":"...","profession":"...","description":"...","campaignRole":"..."}',
      '',
      'Instruções por campo:',
      '  name: nome criativo em português, sem clichês (ex: Mirela, Thoran, Seris)',
      '  gender: exatamente Masculino, Feminino ou Outro',
      '  race: espécie coerente com a temática; não use sempre Humano',
      '  characterClass: classe derivada do enredo (veja exemplos acima); máx 60 chars',
      '  profession: ofício derivado do enredo, diferente da classe; máx 60 chars',
      '  description: 2-3 frases descrevendo aparência física (cabelo, olhos, compleição ou cicatriz marcante), vestimenta ou equipamento coerente com a classe, e traço de personalidade com motivação. Mín 80 chars, máx 280 chars.',
      '  campaignRole: o que este personagem está fazendo nesta aventura específica, qual sua missão ou como se conecta ao enredo. Seja concreto, não genérico. Máx 200 chars.',
    ].join('\n')

    const prompt = [
      ...(existingLines.length > 0 ? [...existingLines, ''] : []),
      ...(req.worldLore ? [`Lore do universo: ${req.worldLore}.`, ''] : []),
      `Temática da aventura: ${req.thematic || 'não informada'}.`,
      `História da aventura: ${req.storyDescription || 'não informada'}.`,
      '',
      'Derive a classe e profissão diretamente desta história — qual arquétipo o ENREDO pede, não o mais comum de RPG.'
    ].join('\n')

    try {
      const generated = await this.generateText(prompt, {
        maxOutputTokens: 1536,
        timeoutMs: this.timeoutMs,
        responseMimeType: 'application/json',
        temperature: this.characterSuggestionTemperature,
        systemInstruction: sysPrompt
      })

      log('suggestCharacterFromWorld', 'LLM raw response:', generated)

      const parsed = parseJsonObject(generated) ?? parseCharacterFromLooseText(generated)
      log('suggestCharacterFromWorld', 'Parsed object:', JSON.stringify(parsed))

      if (parsed) {
        const firstTry = buildSuggestedCharacterFromRecord(parsed)
        log('suggestCharacterFromWorld', 'Built character:', JSON.stringify(firstTry))

        const isCompletelyEmpty = firstTry.name === 'Aventureiro' && firstTry.characterClass === 'Aventureiro' && !firstTry.profession.trim()
        if (!isCompletelyEmpty) {
          // If description came back empty, retry with a focused call before returning
          if (!firstTry.description.trim()) {
            log('suggestCharacterFromWorld', 'description vazio — fazendo retry focado')
            try {
              const descSysPrompt = 'Descreva o personagem RPG abaixo em 2-3 frases vívidas. Inclua: aparência física marcante (cabelo, olhos, compleição ou cicatriz), vestimenta ou equipamento coerente com a classe, e traço de personalidade com motivação. Responda APENAS com a descrição, sem introdução, sem JSON, sem aspas.'
              const descPrompt = `Nome: ${firstTry.name}. Classe: ${firstTry.characterClass}. Profissão: ${firstTry.profession}. Papel na aventura: ${firstTry.campaignRole || 'não definido'}.`
              const descGenerated = await this.generateText(descPrompt, {
                maxOutputTokens: 300,
                timeoutMs: this.timeoutMs,
                temperature: 0.9,
                systemInstruction: descSysPrompt
              })
              const cleaned = descGenerated.trim().replace(/^["'"']+|["'"']+$/g, '').trim()
              if (cleaned.length >= 30) firstTry.description = cleaned
            } catch {
              // pool fallback handled in sanitizeCharacterResult
            }
          }
          return sanitizeCharacterResult(firstTry)
        }
      }

      // Retry with plain line-by-line format (no JSON mode) when first pass returned empty/defaults
      const retrySysPrompt = [
        'Crie um personagem de RPG baseado no enredo abaixo. Responda em exatamente 7 linhas, sem texto adicional:',
        'NOME: nome criativo do personagem',
        'SEXO: Masculino, Feminino ou Outro',
        'RACA: raça ou espécie',
        'CLASSE: classe derivada do enredo',
        'PROFISSAO: profissão ou ofício',
        'DESCRICAO: 2-3 frases — aparência física marcante, vestimenta coerente com a classe, personalidade e motivação',
        'PAPEL: o que o personagem faz nesta aventura e como se conecta ao enredo',
        'Não use os nomes: Kael, Khael, Kaell, Cael.'
      ].join('\n')

      const retryPrompt = [
        `Temática: ${req.thematic || 'não informada'}.`,
        `História: ${req.storyDescription || 'não informada'}.`
      ].join('\n')

      log('suggestCharacterFromWorld', 'Primeira tentativa retornou vazia — fazendo retry...')
      const retryGenerated = await this.generateText(retryPrompt, {
        maxOutputTokens: 600,
        timeoutMs: this.timeoutMs,
        temperature: 0.9,
        systemInstruction: retrySysPrompt
      }, 2)

      const retryParsed = parseCharacterFromLooseText(retryGenerated)
      if (!retryParsed) throw new Error('Resposta não veio em formato legível')

      return sanitizeCharacterResult(buildSuggestedCharacterFromRecord(retryParsed))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido'
      throw new Error(`Falha ao sugerir personagem com ${this.providerLabel}: ${message}`)
    }
  }

  // ─── Narrative Chat Methods ───

  /**
   * Monta o system prompt do narrador.
   * Inclui regras fixas, formato JSON, dados do mundo E (opcionalmente) rulesDigest,
   * resumo da aventura e perícias do jogador — tudo que é (quase) estático entre turnos.
   */
  private buildNarratorSystemPrompt(opts: {
    world?: { name?: string; description?: string; lore?: string }
    campaign?: { name?: string; thematic?: string; storyDescription?: string }
    rulesDigest?: string
    summaryText?: string
    playerSkills?: Record<string, string>
    mode?: NarratorPromptMode
    narrativeStyle?: 'concise' | 'balanced' | 'theatrical'
    simpleVocabulary?: boolean
  } = {}): string {
    const { world, campaign, rulesDigest, summaryText, playerSkills, mode = 'turn', narrativeStyle, simpleVocabulary } = opts
    const lines = [
      'Você é o Narrador de um RPG Savage Worlds. Responda em português do Brasil, sempre em segunda pessoa do singular ("Você entra...", "Você vê...").',
      '',
      '━━━ REGRA PRINCIPAL DO CAMPO "narrative" ━━━',
      'Narre a consequência da ação do jogador de forma direta e progressiva.',
      'FOCO: o que mudou. Evite recapitulações, repetições de estado e conclusões editoriais.',
      'TOM e VOCABULÁRIO devem seguir a atmosfera do universo (ver seção VOZ NARRATIVA mais abaixo, se presente).',
      '',
      'ELEMENTOS DISPONÍVEIS (use os que forem naturais para a cena e o estilo ativo):',
      '  • o que concretamente aconteceu como resultado direto da ação',
      '  • como o ambiente imediato, NPCs ou a situação reagem',
      '  • referência a elemento já estabelecido (nomes, objetos, locais) — cria continuidade',
      '',
      'NÃO ESCREVA:',
      '  • estados inalterados repetidos: "tudo continua quieto", "nada mudou", "a noite segue escura igual antes"',
      '  • ausência de coisas como fato narrativo: "sem ameaças à vista", "nenhum som suspeito"',
      '  • filler genérico sem conexão com a cena: "o tempo passa", "o destino aguarda", "o mundo gira"',
      '  • termos mecânicos literais: "Abalado", "Ferido", "Fadiga" — narre em vez disso: "o braço cede", "a visão embaça"',
      '  • NPCs tomando decisões autônomas além da reação imediata à ação do jogador',
      '  • conclusões editoriais que tiram a agência: "a prioridade agora é...", "o próximo passo é...", "vocês dois precisam..."',
      '',
      'AGÊNCIA: situações em aberto (o que fazer com NPC, para onde ir) viram OPÇÕES — nunca sejam resolvidas na narrativa.',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      'O contexto estruturado desta chamada é a única fonte canônica para os campos JSON.',
      'Se um NPC, item, efeito, perícia, destino, condição ou recurso não estiver no contexto estruturado, ele NÃO pode ser criado nos campos do JSON.',
      'Se houver uma seção "ÂNCORAS CANÔNICAS ESTRITAS" no contexto, trate essa seção como lista fechada para opções, interpretação da ação e narrativa do turno normal.',
      'Em caso de dúvida, prefira manter npcs, itemChanges, statusChanges e locationChange vazios/null e preserve a continuidade apenas na narrative e nas options.',
      '',
      'Você DEVE retornar SOMENTE um JSON válido (sem markdown, sem comentários) com a seguinte estrutura:',
      '{',
      '  "narrative": "<texto narrativo do passo da história, 2-3 parágrafos curtos>",',
      '  "options": [',
      '    {',
      '      "id": "<uuid>",',
      '      "text": "<descrição narrativa da opção>",',
      '      "actionType": "<tipo da ação mecânica: custom|trait_test|attack|travel|flag>",',
      '      "actionPayload": { <campos parciais para montar a ação mecânica> },',
      '      "requiredItems": ["<nome do item do inventário, se necessário para a ação>"],',
      '      "feasible": true,',
      '      "feasibilityReason": "<motivo se feasible=false>",',
      '      "diceCheck": {',
      '        "required": true,',
      '        "skill": "<nome da perícia em PT-BR, ex: Percepção, Furtividade, Luta>",',
      '        "attribute": "<nome do atributo se não for perícia, ex: vigor, spirit>",',
      '        "modifier": 0,',
      '        "tn": 4,',
      '        "reason": "<justificativa narrativa para o teste>"',
      '      }',
      '    }',
      '  ],',
      '  "npcs": [',
      '    { "id": "<uuid>", "name": "<nome>", "disposition": "hostile|neutral|friendly", "newlyIntroduced": true|false }',
      '  ],',
      '  "itemChanges": [',
      '    { "itemId": "<uuid>", "name": "<nome do item>", "quantity": 1, "changeType": "gained|lost|used", "category": "weapon|armor|consumable|ammunition|money|vehicle|property|quest|misc" }',
      '  ],',
      '  "statusChanges": [',
      '    { "effectId": "<uuid>", "name": "<nome do efeito>", "changeType": "applied|removed", "turnsRemaining": 3, "description": "<desc>" }',
      '  ],',
      '  "npcAttacks": [',
      '    { "npcId": "<id do NPC que ataca>", "skillDie": <6|8|10|12>, "damageFormula": "<str+d6 ou 2d6 etc>", "ap": 0 }',
      '  ],',
      '  "locationChange": "<nova localização ou null>",',
      '  "chapterTitle": "<título do capítulo se mudou ou null>"',
      '}',
      '',
      'REGRAS DO CAMPO diceCheck (OBRIGATÓRIO em TODA opção):',
      '- Avalie para CADA opção se a ação exige um teste de dados com base nas regras de Savage Worlds.',
      '- PRINCÍPIO FUNDAMENTAL: Só exija teste quando AMBAS as condições forem verdadeiras:',
      '  (1) o resultado da ação é genuinamente incerto neste contexto, E',
      '  (2) a falha teria consequências narrativas interessantes.',
      '  Se qualquer uma dessas condições for falsa, "required" deve ser false.',
      '- REGRA DE DESEMPATE: NA DÚVIDA, use "required": false. Teste de dados é EXCEÇÃO, não regra.',
      '  Um dado pedido desnecessariamente interrompe o fluxo da história e frustra o jogador.',
      '  Se a opção descreve a INTENÇÃO do personagem mas não um esforço ou risco concreto',
      '  ("Tentar ajudar", "Procurar uma saída", "Verificar os arredores", "Se aproximar do NPC"),',
      '  prefira required: false — o narrador resolve o resultado narrativamente no próximo turno.',
      '',
      '- Ações que NÃO exigem teste (qualquer personagem faz automaticamente):',
      '  • Atender o telefone / celular / chamada',
      '  • Abrir uma porta destrancada ou desimpedida',
      '  • Sentar, deitar, levantar-se',
      '  • Ligar/desligar um aparelho simples, pressionar um botão',
      '  • Acenar, gesticular, cumprimentar alguém',
      '  • Pular um obstáculo claramente baixo e seguro (meio-fio, degrau, vão de 30 cm)',
      '  • Caminhar por um caminho seguro sem ameaças',
      '  • Descansar, respirar fundo, aguardar',
      '  • Examinar um item que já está no inventário',
      '  • Verificar a hora, olhar ao redor sem alvo oculto específico',
      '  • Aceitar/receber/pegar um item que um NPC entrega diretamente',
      '  • Conversar ou fazer perguntas simples a qualquer NPC — mesmo "neutral" — sem intenção de persuadir, intimidar ou obter segredo guardado',
      '  • Se aproximar de NPC ou objeto visível na cena (sem obstáculo físico ou resistência)',
      '  • Abordar NPC com disposition "friendly" para conversa ou pedido direto',
      '  • Usar rádio, comunicador ou celular para chamar apoio ou transmitir mensagem',
      '  • Procurar / encontrar local ou saída visivelmente acessível na cena (não oculto)',
      '  • Verificar condição de item, ferimento próprio ou ambiente próximo',
      '  • Tomar decisão / escolher direção quando não há obstáculo físico concreto',
      '  • Aceitar ou recusar proposta / informação de NPC',
      '  • Aguardar/observar passivamente sem alvo oculto específico (ficar no carro, vigiar de longe)',
      '  • Viajar para um local conhecido sem obstáculos — SEMPRE actionType "travel" e required: false',
      '  ATENÇÃO: se houver elemento de resistência, risco ou incerteza real no contexto, mesmo ações comuns podem exigir teste.',
      '  Ex.: abrir uma porta pode exigir Ladinagem se estiver trancada; pular pode exigir Atletismo se for um abismo.',
      '',
      '- Ações que EXIGEM teste (risco genuíno + falha com consequência interessante):',
      '  • Perceber algo oculto ou sutil → skill: "Percepção"',
      '  • Mover-se sem ser detectado → skill: "Furtividade"',
      '  • Escalar superfície difícil, saltar abismo real, correr sob pressão → skill: "Atletismo"',
      '  • Convencer NPC relutante, barganhar, enganar, persuadir contra a vontade → skill: "Persuasão"',
      '  • Intimidar alguém → skill: "Intimidação"',
      '  • Curar ferimentos → actionType: "heal", actionPayload: {} (não use trait_test para cura)',
      '  • Abrir fechadura trancada, desarmar armadilha → skill: "Ladinagem"',
      '  • Investigar pistas em cena, pesquisar informação escondida → skill: "Pesquisa"',
      '  • Conhecimento arcano / sobrenatural → skill: "Ocultismo"',
      '  • Resistir a veneno, doença, fadiga → attribute: "vigor"',
      '  • Resistir a medo, tentação → attribute: "spirit"',
      '  • Combate corpo a corpo → skill: "Luta" (use actionType "attack")',
      '  • Combate à distância → skill: "Tiro" (use actionType "attack")',
      '  ATENÇÃO: use actionType "trait_test" APENAS quando o teste é o FOCO PRINCIPAL da ação.',
      '  Ações custom quase sempre têm required: false — a narrativa resolve o resultado.',
      '',
      '- REGRA ESPECIAL — actionType "travel": diceCheck.required deve ser SEMPRE false. Viagem é narrativa; descreva obstáculos na narrativa, não em diceCheck.',
      '- "modifier": ajuste situacional (-2 para dificuldade alta, -4 para quase impossível, +2 para vantagem). Default: 0.',
      '- "tn": target number. Default 4. Aumente para situações especialmente difíceis (6, 8).',
      '- "reason": SEMPRE preencha com uma justificativa narrativa curta.',
      '- Use os nomes das perícias em português do Brasil conforme listado nas PERÍCIAS DO JOGADOR no contexto.',
      '',
      'REGRAS GERAIS:',
      '- O array "options" é OBRIGATÓRIO e NUNCA pode estar vazio. Sempre retorne EXATAMENTE 4 opções.',
      '- Se você retornar options vazio ou com menos de 4 itens, a resposta será considerada inválida.',
      '- Pelo menos 1 opção deve ser de exploração/investigação e 1 de interação social.',
      '- Se houver NPC hostil presente, inclua ao menos 1 opção de combate (actionType "attack").',
      '- O campo "feasible" deve ser false se o jogador não tiver os itens/condições necessárias.',
      '- Para actionType "trait_test", inclua "skill" ou "attribute" no actionPayload.',
      '- Para actionType "attack", inclua "targetId" e "damageFormula" no actionPayload.',
      '  Exemplos de damageFormula: "str" (soco/desarmado), "str+d4" (faca/canivete), "str+d6" (espada curta/clava/machado leve), "str+d8" (espada longa/machado pesado), "str+d10" (montante/arma duas mãos), "2d6" (pistola), "2d8" (rifle).',
      '- Para actionType "heal": inclua actionPayload: {} (cura o próprio jogador) ou actionPayload: { targetId: "<id do NPC aliado>" }.',
      '- ATAQUES DE NPC: quando um NPC hostil ataca o jogador neste turno, preencha o campo "npcAttacks" (array).',
      '  Cada entrada: { "npcId": "<id do NPC>", "skillDie": <6|8|10|12>, "damageFormula": "<fórmula>", "ap": 0 }.',
      '  skillDie: 6 = soldado comum, 8 = guerreiro treinado, 10 = campeão, 12 = elite.',
      '  damageFormula: "str+d4" (punho/faca), "str+d6" (espada), "str+d8" (machadão), "2d6" (pistola), "2d8" (rifle).',
      '  Se o NPC não atacar neste turno, deixe "npcAttacks": [].',
      '- Ao narrar Extras abatidos (isWildCard=false): descreva-os saindo de combate/fugindo/caindo com 1 único ferimento.',
      '- Ao narrar Wild Cards feridos: acumule penalidades, eles continuam combatendo até 4+ ferimentos.',
      '- Para actionType "travel", inclua "to" no actionPayload.',
      '- Para actionType "custom", inclua "input" no actionPayload com a descrição da ação.',
      '- Itens ganhos devem ter nomes criativos e coerentes com a ambientação.',
      '- NUNCA repita itemChanges de itens que já estão no inventário do jogador. Se o jogador já possui um item, NÃO o inclua novamente em itemChanges com changeType "gained". Consulte a seção INVENTÁRIO no contexto do turno.',
      '- Cada item deve aparecer NO MÁXIMO UMA VEZ no array itemChanges de uma mesma resposta.',
      '- Armas à distância (arco, besta, pistola, rifle, escopeta, etc.) SEMPRE devem ter sua munição correspondente como item separado no inventário (flechas, virotes, balas, cartuchos, etc.).',
      '- Munição (category "ammunition") SÓ deve aparecer em itemChanges com changeType "used" quando a AÇÃO DO JOGADOR deste turno for do tipo "attack" (disparo efetivamente efetuado). NUNCA registre consumo de munição em turnos de trait_test, custom, travel ou qualquer outro tipo que não seja attack — mesmo que NPCs hostis tenham sido introduzidos na narrativa.',
      '- Todo item DEVE ter o campo "category". Use: weapon (armas), armor (armaduras), consumable (consumíveis como poções/ração), ammunition (munição), money (dinheiro/moedas/recursos monetários — o campo "quantity" representa a quantidade exata de moedas/créditos/gold), vehicle (veículos: carro, moto, avião, barco, nave, etc.), property (propriedades: casa, apartamento, fazenda, escritório, etc.), quest (item narrativo/missão), misc (outros itens).',
      '- Qualquer item pode ser adicionado com changeType "gained" quando comprado, encontrado, saqueado ou entregue por um NPC neste turno. Isso inclui armas ("weapon"), armaduras ("armor"), consumíveis, munição, veículos, propriedades, itens de missão e misc.',
      '- Nunca quebre a imersão. Nunca mencione regras, dados ou mecânicas no texto narrativo.',
      '- Não repita a mesma narrativa. Evolua a história a cada turno.',
      '- Textos de opções devem ter no máximo 1 frase curta cada.',
      '- Não adicione campos extras além dos especificados acima.'
    ]

    // ─── ESTILO DE NARRATIVA (definido aqui, antes do contexto, para ter peso máximo) ───
    lines.push('')
    if (narrativeStyle === 'concise') {
      lines.push(
        '━━━ COMPRIMENTO OBRIGATÓRIO DO "narrative": CONCISO ━━━',
        'MÁXIMO 3 frases CURTAS. 1 parágrafo único.',
        'Narre apenas: (1) o que aconteceu, (2) o estado imediato resultante.',
        'NÃO ESCREVA neste estilo:',
        '  • detalhes sensoriais, atmosfera ou ambientação',
        '  • callbacks a eventos anteriores',
        '  • tension-building, ganchos ou suspense',
        'Frases devem ser CURTAS e DIRETAS — sem cláusulas encadeadas com vírgula.',
        'Qualquer resposta com mais de 3 frases viola esta instrução.',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
      )
    } else if (narrativeStyle === 'balanced') {
      lines.push(
        '━━━ COMPRIMENTO OBRIGATÓRIO DO "narrative": EQUILIBRADO ━━━',
        'ENTRE 4 e 6 frases distribuídas em 2 parágrafos.',
        'Parágrafo 1: consequência concreta da ação + reação do ambiente ou NPC.',
        'Parágrafo 2: gancho ou tensão para o próximo turno.',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
      )
    } else if (narrativeStyle === 'theatrical') {
      lines.push(
        '━━━ COMPRIMENTO OBRIGATÓRIO DO "narrative": TEATRAL ━━━',
        'MÍNIMO 9 frases distribuídas em 3 a 4 parágrafos. Narração cinematográfica e literária.',
        'Parágrafo 1 (abertura sensorial): comece com imagem, som, cheiro ou toque específico da cena — não com a ação em si.',
        'Parágrafo 2 (ação + impacto): descreva a consequência concreta com detalhe visual e dinâmica. Mostre, não conte.',
        'Parágrafo 3 (reação do mundo): como NPCs, ambiente ou atmosfera respondem — com personalidade, não apenas estado mecânico.',
        'Parágrafo 4 (gancho): termine com um detalhe inesperado, uma pergunta em aberto ou uma tensão que prenda o jogador.',
        'Qualquer resposta com menos de 9 frases viola esta instrução.',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
      )
    } else {
      lines.push(
        '━━━ COMPRIMENTO OBRIGATÓRIO DO "narrative" (PADRÃO) ━━━',
        'ENTRE 5 e 7 frases distribuídas em 2 a 3 parágrafos.',
        'Inclua: consequência direta + reação do mundo + gancho final.',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
      )
    }

    // ─── VOCABULÁRIO SIMPLES ───
    if (simpleVocabulary === true) {
      lines.push(
        '',
        '━━━ VOCABULÁRIO SIMPLES (ATIVO) ━━━',
        'Use APENAS palavras simples e comuns. Evite termos arcaicos, poéticos ou complexos.',
        'Prefira: "rosto" em vez de "semblante"; "antigo" em vez de "outrora"; "medo" em vez de "pavor visceral".',
        'Frases CURTAS e DIRETAS. Clareza sobre estilo literário.',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
      )
    }

    // ─── REGRA: INVENTÁRIO NA NARRATIVA ───
    lines.push(
      '',
      '⚠️ ITENS NA NARRATIVA: NUNCA mencione na narrativa (campo "narrative") itens, objetos, armas ou ferramentas que o jogador NÃO possua no INVENTÁRIO listado no contexto do turno.',
      'Se o jogador tentar usar um item que não possui, narre que ele procura pelo objeto mas não o encontra.',
      'Esta regra se aplica APENAS ao texto narrativo — não afeta os campos JSON de mecânica.'
    )

    // ─── REGRA: NARRAÇÃO DE INCAPACITAÇÃO ───
    lines.push(
      '',
      '🔴 INCAPACITAÇÃO: Se o personagem estiver Incapacitado (wounds >= maxWounds, ou seja, 4+ ferimentos),',
      'a narrativa DEVE refletir isso explicitamente: descreva o colapso, a escuridão, a luta pela consciência.',
      'As opções devem ser condizentes com a condição (ex: "Lutar pela sobrevivência", "Perder a consciência", "Pedir ajuda").',
      'NÃO ofereça ações normais de combate, exploração ou diálogo quando o personagem está incapacitado.'
    )

    const styleCheck = narrativeStyle === 'concise'
      ? 'A "narrative" tem NO MÁXIMO 3 frases (1 parágrafo)?'
      : narrativeStyle === 'balanced'
        ? 'A "narrative" tem ENTRE 4 e 6 frases (2 parágrafos)?'
        : narrativeStyle === 'theatrical'
          ? 'A "narrative" tem MÍNIMO 9 frases (3-4 parágrafos com abertura sensorial, ação, reação do mundo e gancho)?'
          : 'A "narrative" tem ENTRE 5 e 7 frases (2-3 parágrafos)?'
    lines.push(
      '',
      'CHECKLIST FINAL antes de enviar a resposta:',
      `1. ${styleCheck} ✓`,
      ...(narrativeStyle !== 'concise' ? [
        '2. A "narrative" inclui ao menos 1 referência a elemento já estabelecido (callback)? ✓',
        '3. A "narrative" finaliza com gancho, tensão ou detalhe inesperado? ✓',
        '4. O campo "options" tem EXATAMENTE 4 objetos com texto descritivo e motivante? ✓',
        '5. Cada opção tem id, text, actionType, actionPayload, feasible e diceCheck? ✓',
      ] : [
        '2. O campo "options" tem EXATAMENTE 4 objetos com texto descritivo e motivante? ✓',
        '3. Cada opção tem id, text, actionType, actionPayload, feasible e diceCheck? ✓',
      ])
    )

    // Injetar contexto do universo (lore macro — fixo durante toda a sessão)
    if (world && (world.description || world.lore)) {
      lines.push(
        '',
        '=== UNIVERSO ===',
        'As seções abaixo são a bíblia canônica deste universo. Use os locais, facções, tecnologias e ameaças listados ao construir narrativas, opções e NPCs. Não invente elementos que contradigam essas seções.',
        `Nome: ${world.name ?? 'Sem nome'}`,
        ...(world.description ? [`Descrição: ${world.description}`] : []),
        ...(world.lore ? ['', world.lore] : [])
      )

      // Instrução de voz narrativa baseada no lore do universo
      lines.push(
        '',
        '=== VOZ NARRATIVA (leia antes de escrever qualquer "narrative") ===',
        'Antes de redigir o campo "narrative" de cada turno, faça internamente os seguintes passos:',
        '1. Releia a seção "## Atmosfera e Tom" do universo acima.',
        '2. Identifique: qual é o humor emocional dominante? Que tensão ou sensação essa atmosfera evoca? Que tipo de imagens e palavras aparecem nela?',
        '3. Use essas referências ESPECÍFICAS — não estereótipos de gênero — para calibrar o vocabulário do turno atual.',
        '',
        'Restrições obrigatórias para o campo "narrative":',
        '- Tom neutro de livro de regras é PROIBIDO. A narrativa deve ter o sotaque deste universo.',
        '- Nunca use linguagem genérica de RPG ("você avança corajosamente", "o inimigo é derrotado"). Prefira imagens concretas do mundo.',
        '- Se o universo tem atmosfera de decadência, use decadência — palavras gastas, ferrugem, silêncios. Se tem grandiosidade, use grandiosidade — escala, mito, peso.',
        '- A voz narrativa deve ser sentida na escolha de palavras e metáforas, nunca declarada.'
      )
    }

    // Injetar contexto da campanha (temática e história específica)
    if (campaign && (campaign.thematic || campaign.storyDescription)) {
      lines.push(
        '',
        '=== CAMPANHA ===',
        `Nome: ${campaign.name ?? 'Sem nome'}`,
        `Temática: ${campaign.thematic ?? ''}`,
        `História: ${campaign.storyDescription ?? ''}`
      )
    }

    // Injetar digest de regras Savage Worlds (quase estático — só muda se edges/hindrances mudarem)
    if (rulesDigest) {
      lines.push('', rulesDigest)
    }

    // Perícias do jogador (nomes que a LLM deve usar no diceCheck)
    if (playerSkills && Object.keys(playerSkills).length > 0) {
      lines.push(
        '',
        '=== PERÍCIAS DO JOGADOR (use estes nomes exatos no diceCheck.skill) ===',
        ...Object.entries(playerSkills).map(([name, die]) => `- ${name}: ${die}`)
      )
    }

    // Resumo da aventura até agora
    if (summaryText) {
      lines.push('', '=== RESUMO DA AVENTURA ===', summaryText)
    }

    if (mode === 'start') {
      lines.push(
        '',
        '=== REGRAS DE INÍCIO DE SESSÃO ===',
        '- Você PODE introduzir 1 NPC inicial coerente com a cena.',
        '- Você PODE adicionar de 3 a 9 itens iniciais em itemChanges com changeType "gained".',
        '- Os itens iniciais devem representar pertences que o personagem já possui ao começar a aventura.',
        '- Mesmo no início, não invente perícias, ids mecânicos ou destinos fora da ambientação fornecida.'
      )
    } else {
      lines.push(
        '',
        '=== REGRAS DE TURNO CANÔNICO ===',
        '- No turno normal, use o array "npcs" para NPCs já listados em NPCs PRESENTES.',
        '- EXCEÇÃO: se sua narrativa DESTE turno introduz uma criatura/entidade hostil que ainda não estava listada, você DEVE registrá-la em "npcs" com newlyIntroduced: true, disposition: "hostile" e um UUID gerado por você como "id". Use o MESMO id no actionPayload.targetId de qualquer opção de ataque contra essa entidade.',
        '- No turno normal, NÃO crie itemChanges com changeType "gained" EXCETO nas situações abaixo:',
        '  (1) Qualquer categoria EXCETO "weapon" e "armor", quando a narrativa deste turno justificar (compra em loja, item encontrado, recompensa, herança, conquista).',
        '  (2) Um NPC PRESENTE NA CENA entrega explicitamente um item ao jogador NESTE turno (ex: passa uma chave, entrega um documento). Use changeType "gained" com a categoria correta do item.',
        '  Jamais use "gained" com categories "weapon" ou "armor" em turno normal.',
        '- No turno normal, use itemChanges apenas para "lost", "used" ou "gained" (conforme regras acima) de itens relevantes à ação deste turno.',
        '- No turno normal, NÃO aplique statusChanges novos sem evidência direta no RESULTADO MECÂNICO ou em EFEITOS ATIVOS já existentes.',
        '- No turno normal, só preencha locationChange se a ação do jogador for travel ou se o RESULTADO MECÂNICO trouxer location_change.',
        '- Use apenas IDs de NPC já listados em NPCs PRESENTES (ou do novo NPC hostil desta narrativa) para actionPayload.targetId.',
        '- Se faltar evidência canônica para mutação de estado, deixe os campos mutáveis vazios/null.',
        '- Se algum NPC for abatido, não o inclua em turnos subsequentes. Descreva-os como abatidos, fugindo ou caindo, mas não os mantenha como alvo de ações futuras.'
      )
    }

    // Instruções estáticas de narração
    lines.push(
      '',
      '=== INSTRUÇÕES DE NARRAÇÃO ===',
      'Aplique a REGRA PRINCIPAL do campo "narrative" definida no início deste prompt.',
      '',
      'RESULTADO DA AÇÃO:',
      '  • Sucesso: descreva a consequência positiva concreta + seu impacto imediato no mundo ou nos NPCs presentes.',
      '  • Falha: descreva o que especificamente falhou + uma nova complicação ou risco que emerge do fracasso (falha nunca é neutra — ela muda algo).',
      '  • Sucesso com Raise: narre um benefício extra inesperado além do esperado.',
      '',
      'PROGRESSÃO NARRATIVA (adapte ao estilo ativo):',
      '  • CONSTRUÇÃO (todos os estilos): quando natural, referencie elemento já estabelecido — NPC, objeto, local, frase dita.',
      '  • DESENVOLVIMENTO (balanced/theatrical): mostre NPCs com personalidade consistente — eles reagem, questionam, demonstram emoção.',
      '  • ESCALADA (balanced/theatrical): eleve stakes, adicione camadas ou revele algo novo a cada turno.',
      '  • GANCHO (balanced/theatrical): termine com algo em aberto — uma sombra vista, uma palavra ouvida, um aliado que hesita.',
      '  No estilo CONCISO, omitir desenvolvimento, escalada e gancho se não couberem nas 3 frases.',
      '',
      'Se houver conflito entre memória anterior e o estado estruturado desta chamada, o estado estruturado prevalece.',
      'Se a seção ÂNCORAS CANÔNICAS ESTRITAS estiver presente, não cite nomes fora dela no turno normal.',
      'Avalie se cada opção é viável considerando o inventário e estado do jogador.',
      'Inclua mudanças de itens ou status SOMENTE quando houver evidência canônica suficiente.',
      'Inclua um NPC em "npcs" somente se ele estiver canonicamente presente nesta cena.'
    )

    return lines.join('\n')
  }

  private sanitizeNarratorResponse(
    raw: Record<string, unknown>,
    opts: SanitizedNarratorResponseOptions = {}
  ): NarratorTurnResponse {
    const { fillFallbackOptions = true, allowNarrativeFallback = true } = opts
    const narrative = typeof raw.narrative === 'string'
      ? sanitizeNarrativeOutput(raw.narrative) || (allowNarrativeFallback ? 'A história continua...' : '')
      : (allowNarrativeFallback ? 'A história continua...' : '')

    // Parse options
    const rawOptions = Array.isArray(raw.options) ? raw.options : []
    const options: ActionOption[] = []
    const optionSignatures = new Set<string>()

    const pushOption = (candidate: Omit<ActionOption, 'id'> & { id?: string }) => {
      if (options.length >= 4) return

      const text = sanitizeInlineText(candidate.text, '')
      if (!text) return

      const actionPayload = { ...candidate.actionPayload }
      const payloadSkill = sanitizeSkillName(actionPayload.skill)
      if (payloadSkill) {
        actionPayload.skill = payloadSkill
      } else if (typeof actionPayload.skill === 'string') {
        delete actionPayload.skill
      }

      const diceCheck = hydrateDiceCheckFromActionPayload(
        candidate.diceCheck
          ? {
              ...candidate.diceCheck,
              skill: sanitizeSkillName(candidate.diceCheck.skill),
              attribute: sanitizeNullableInlineText(candidate.diceCheck.attribute),
              reason: sanitizeInlineText(candidate.diceCheck.reason, '')
            }
          : null,
        actionPayload
      )

      const signature = buildOptionSignature({
        text,
        actionType: candidate.actionType,
        actionPayload,
        diceCheck
      })

      if (optionSignatures.has(signature)) return
      optionSignatures.add(signature)

      options.push({
        ...candidate,
        id: candidate.id ?? randomUUID(),
        text,
        actionPayload,
        diceCheck
      })
    }

    for (const opt of rawOptions) {
      if (options.length >= 4) break

      const o = (opt && typeof opt === 'object' ? opt : {}) as Record<string, unknown>

      // Parse diceCheck
      let diceCheck: DiceCheck | null = null
      if (o.diceCheck && typeof o.diceCheck === 'object' && !Array.isArray(o.diceCheck)) {
        const dc = o.diceCheck as Record<string, unknown>
        diceCheck = {
          required: typeof dc.required === 'boolean' ? dc.required : false,
          skill: sanitizeSkillName(dc.skill),
          attribute: sanitizeNullableInlineText(dc.attribute),
          modifier: typeof dc.modifier === 'number' ? dc.modifier : 0,
          tn: typeof dc.tn === 'number' ? dc.tn : 4,
          reason: sanitizeInlineText(dc.reason, '')
        }
      }

      const actionType = isActionType(o.actionType) ? o.actionType : 'custom'
      const fallbackInput = sanitizeInlineText(o.text, '')
      const actionPayload = (o.actionPayload && typeof o.actionPayload === 'object'
        ? sanitizeJsonLikeValue(o.actionPayload)
        : sanitizeJsonLikeValue({ input: fallbackInput })) as Record<string, unknown>

      // Normalizar aliases de ataque: "target" → "targetId"
      if (actionType === 'attack') {
        if (!actionPayload.targetId && typeof actionPayload.target === 'string') {
          actionPayload.targetId = actionPayload.target
          delete actionPayload.target
        }
      }
      const text = sanitizeInlineText(
        o.text ?? (typeof actionPayload.input === 'string' ? actionPayload.input : ''),
        ''
      )

      pushOption({
        id: typeof o.id === 'string' ? o.id : randomUUID(),
        text,
        actionType,
        actionPayload,
        requiredItems: sanitizeStringList(o.requiredItems),
        feasible: typeof o.feasible === 'boolean' ? o.feasible : true,
        feasibilityReason: sanitizeNullableInlineText(o.feasibilityReason),
        diceCheck
      })
    }

    if (fillFallbackOptions) {
      // Completa até 4 opções caso parte da saída do LLM tenha sido descartada no saneamento.
      const fallbackOptions = [
        { text: 'Observar os arredores com atenção', actionType: 'trait_test' as const, actionPayload: { skill: 'Percepção' }, diceCheck: { required: true, skill: 'Percepção', reason: 'Perceber detalhes ocultos' } },
        { text: 'Investigar a área em busca de pistas', actionType: 'trait_test' as const, actionPayload: { skill: 'Pesquisa' }, diceCheck: { required: true, skill: 'Pesquisa', reason: 'Investigar requer análise cuidadosa' } },
        { text: 'Tentar conversar com alguém próximo', actionType: 'custom' as const, actionPayload: { input: 'Abordar alguém para conversar' }, diceCheck: { required: false, reason: 'Interação social simples' } },
        { text: 'Seguir adiante com cautela', actionType: 'custom' as const, actionPayload: { input: 'Seguir adiante com cautela' }, diceCheck: { required: false, reason: 'Movimento cauteloso sem ameaça imediata' } }
      ]

      for (const fb of fallbackOptions) {
        if (options.length >= 4) break
        pushOption({
          id: randomUUID(),
          text: fb.text,
          actionType: fb.actionType,
          actionPayload: fb.actionPayload,
          feasible: true,
          diceCheck: fb.diceCheck
        })
      }
    }

    // Pós-processamento: corrigir diceCheck.required em opções que o LLM marcou incorretamente
    for (const option of options) {
      if (!option.diceCheck) continue

      // Travel nunca requer dado — é ação narrativa
      if (option.actionType === 'travel' && option.diceCheck.required) {
        warn('sanitizeNarratorResponse', `Travel com required=true corrigido para false: "${option.text}"`)
        option.diceCheck = { ...option.diceCheck, required: false }
      }

      // Custom ou trait_test: verificar se o texto da opção é trivial
      if (
        option.diceCheck.required &&
        (option.actionType === 'custom' || option.actionType === 'trait_test')
      ) {
        const trivial = classifyTrivialAction(option.text)
        if (trivial.trivial) {
          warn('sanitizeNarratorResponse', `Opção trivial com required=true corrigida: "${option.text}"`)
          option.diceCheck = { ...option.diceCheck, required: false, reason: trivial.reason }
          // Rebaixar trait_test → custom para não gerar rolagem de dado
          if (option.actionType === 'trait_test') option.actionType = 'custom'
        }
      }

      // Guarda extra: custom com required=true mas sem skill e sem attribute → sem base mecânica
      if (
        option.actionType === 'custom' &&
        option.diceCheck.required &&
        !option.diceCheck.skill &&
        !option.diceCheck.attribute
      ) {
        warn('sanitizeNarratorResponse', `Opção custom com required=true sem skill/attribute corrigida: "${option.text}"`)
        option.diceCheck = { ...option.diceCheck, required: false }
      }
    }

    // Garantir que toda opção tenha diceCheck com reason não-vazio (requisito estrutural)
    for (const option of options) {
      if (!option.diceCheck) {
        option.diceCheck = { required: false, skill: null, attribute: null, modifier: 0, tn: 4, reason: 'Ação narrativa sem teste de dados' }
      } else if (!option.diceCheck.reason.trim()) {
        option.diceCheck = { ...option.diceCheck, reason: option.diceCheck.required ? 'Teste necessário para a ação' : 'Ação sem custo mecânico' }
      }
    }

    // Parse NPCs
    const rawNpcs = Array.isArray(raw.npcs) ? raw.npcs : []
    const npcs: NPCMention[] = rawNpcs.map((n: unknown) => {
      const npc = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>
      return {
        id: typeof npc.id === 'string' ? npc.id : randomUUID(),
        name: sanitizeInlineText(npc.name, 'Desconhecido'),
        disposition: (['hostile', 'neutral', 'friendly'].includes(npc.disposition as string) ? npc.disposition : 'neutral') as NPCMention['disposition'],
        newlyIntroduced: typeof npc.newlyIntroduced === 'boolean' ? npc.newlyIntroduced : true
      }
    })

    // Parse item changes
    const VALID_ITEM_CATEGORIES = new Set(['weapon', 'armor', 'consumable', 'ammunition', 'money', 'vehicle', 'property', 'quest', 'misc'])
    const rawItems = Array.isArray(raw.itemChanges) ? raw.itemChanges : []
    const parsedItems: ItemChange[] = rawItems.map((it: unknown) => {
      const item = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
      const rawCategory = typeof item.category === 'string' ? item.category : undefined
      return {
        itemId: typeof item.itemId === 'string' ? item.itemId : randomUUID(),
        name: sanitizeInlineText(item.name, 'Item'),
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        changeType: (['gained', 'lost', 'used'].includes(item.changeType as string) ? item.changeType : 'gained') as ItemChange['changeType'],
        ...(rawCategory && VALID_ITEM_CATEGORIES.has(rawCategory) ? { category: rawCategory as ItemChange['category'] } : {})
      }
    })

    // Deduplicar itens dentro da mesma resposta (mesmo nome → manter somente o primeiro)
    const seenItemNames = new Set<string>()
    const itemChanges: ItemChange[] = []
    for (const ic of parsedItems) {
      const key = ic.name.toLowerCase().trim()
      if (seenItemNames.has(key)) {
        warn('sanitizeNarratorResponse', `Item duplicado removido: "${ic.name}"`)
        continue
      }
      seenItemNames.add(key)
      itemChanges.push(ic)
    }

    // Parse status changes
    const rawStatus = Array.isArray(raw.statusChanges) ? raw.statusChanges : []
    const statusChanges: StatusChange[] = rawStatus.map((st: unknown) => {
      const status = (st && typeof st === 'object' ? st : {}) as Record<string, unknown>
      return {
        effectId: typeof status.effectId === 'string' ? status.effectId : randomUUID(),
        name: sanitizeInlineText(status.name, 'Efeito'),
        changeType: (['applied', 'removed'].includes(status.changeType as string) ? status.changeType : 'applied') as StatusChange['changeType'],
        turnsRemaining: typeof status.turnsRemaining === 'number' ? status.turnsRemaining : null,
        description: sanitizeInlineText(status.description, '')
      }
    })

    // Parse npc attacks
    const rawNpcAttacks = Array.isArray(raw.npcAttacks) ? raw.npcAttacks : []
    const npcAttacks: NpcAttackEntry[] = rawNpcAttacks.flatMap((entry: unknown) => {
      const e = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
      const npcId = typeof e.npcId === 'string' ? e.npcId.trim() : ''
      const skillDie = typeof e.skillDie === 'number' ? e.skillDie : 0
      const damageFormula = typeof e.damageFormula === 'string' ? e.damageFormula.trim() : ''
      if (!npcId || !damageFormula || ![4, 6, 8, 10, 12].includes(skillDie)) return []
      return [{ npcId, skillDie, damageFormula, ap: typeof e.ap === 'number' ? e.ap : 0 }]
    })

    return {
      narrative,
      options,
      npcs,
      itemChanges,
      statusChanges,
      npcAttacks,
      locationChange: sanitizeNullableInlineText(raw.locationChange),
      chapterTitle: sanitizeNullableInlineText(raw.chapterTitle)
    }
  }

  private isNarratorResponseStructurallyValid(response: NarratorTurnResponse): boolean {
    if (!response.narrative.trim()) return false
    if (response.options.length !== 4) return false

    return response.options.every((option) => {
      if (!option.text.trim() || !option.diceCheck || !option.diceCheck.reason.trim()) return false

      const payload = option.actionPayload ?? {}
      const payloadSkill = sanitizeSkillName(payload.skill)
      const payloadAttribute = sanitizeNullableInlineText(payload.attribute)
      const diceSkill = sanitizeSkillName(option.diceCheck.skill)
      const diceAttribute = sanitizeNullableInlineText(option.diceCheck.attribute)

      if (option.diceCheck.required && !diceSkill && !diceAttribute && !payloadSkill && !payloadAttribute) {
        return false
      }

      switch (option.actionType) {
        case 'attack':
          return sanitizeInlineText(payload.targetId, '').length > 0
        case 'travel':
          return sanitizeInlineText(payload.to, '').length > 0
        case 'trait_test':
          return Boolean(payloadSkill || payloadAttribute || diceSkill || diceAttribute)
        case 'custom':
          return Boolean(sanitizeInlineText(payload.input, option.text))
        case 'flag':
          return Boolean(sanitizeInlineText(payload.key, ''))
        default:
          return true
      }
    })
  }

  private buildNarratorRetrySystemPrompt(basePrompt: string): string {
    return [
      basePrompt,
      '',
      '=== CORREÇÃO OBRIGATÓRIA ===',
      '- A resposta anterior foi rejeitada por estar incompleta, truncada ou não canônica.',
      '- Retorne JSON completo e autoconsistente.',
      '- Não use entidades fora do contexto estruturado.',
      '- Não omita options, diceCheck ou actionPayload obrigatórios.',
      '- Se tiver dúvida sobre mutações de estado, deixe npcs, itemChanges, statusChanges e locationChange vazios/null.'
    ].join('\n')
  }

  /**
   * Gera a resposta do narrador.
   * Aceita single-turn (string) ou multi-turn (ContentEntry[]).
   */
  private async generateNarratorResponse(
    promptOrContents: string | ContentEntry[],
    maxTokens?: number,
    systemPromptOpts: {
      world?: { name?: string; description?: string; lore?: string }
      campaign?: { name?: string; thematic?: string; storyDescription?: string }
      rulesDigest?: string
      summaryText?: string
      playerSkills?: Record<string, string>
      mode?: NarratorPromptMode
      narrativeStyle?: 'concise' | 'balanced' | 'theatrical'
      simpleVocabulary?: boolean
    } = {}
  ): Promise<NarratorTurnResponse> {
    const narratorMode = systemPromptOpts.mode ?? 'turn'
    const systemPrompt = this.buildNarratorSystemPrompt(systemPromptOpts)
    const effectiveMaxTokens = maxTokens ?? this.worldMaxOutputTokens

    const baseTemperature = narratorMode === 'start'
      ? this.narrateStartTemperature
      : this.narrateTurnTemperature
    const attempts = [
      { temperature: baseTemperature, systemInstruction: systemPrompt },
      {
        temperature: Math.max(0.05, baseTemperature - 0.05),
        systemInstruction: this.buildNarratorRetrySystemPrompt(systemPrompt)
      }
    ] as const

    let lastError: Error | null = null
    let truncatedOnPreviousAttempt = false

    for (const [index, attempt] of attempts.entries()) {
      const attemptMaxTokens = truncatedOnPreviousAttempt
        ? Math.min(effectiveMaxTokens * 2, 16384)
        : effectiveMaxTokens
      try {
        const generated = await this.generateTextDetailed(promptOrContents, {
          maxOutputTokens: attemptMaxTokens,
          timeoutMs: this.narratorTimeoutMs,
          responseMimeType: 'application/json',
          temperature: attempt.temperature,
          systemInstruction: attempt.systemInstruction
        }, index + 1)
        log(
          'narratorResponse',
          `LLM raw length: ${generated.text.length} maxTokens: ${attemptMaxTokens} attempt=${index + 1} finish=${generated.finishReason ?? 'unknown'}`
        )

        if (generated.finishReason === 'MAX_TOKENS') {
          lastError = new Error('Resposta narrativa truncada por limite de tokens')
          warn('narratorResponse', `Attempt ${index + 1}/${attempts.length}: output truncado por limite de tokens (maxTokens=${attemptMaxTokens})`)
          truncatedOnPreviousAttempt = true
          continue
        }
        truncatedOnPreviousAttempt = false

        const parsed = parseJsonObjectDetailed(generated.text)
        if (!parsed) {
          lastError = new Error('Resposta narrativa sem JSON válido')
          warn('narratorResponse', `Attempt ${index + 1}/${attempts.length}: JSON parse failed`)
          continue
        }

        if (parsed.source !== 'direct' && parsed.source !== 'fragment' && parsed.source !== 'repaired') {
          lastError = new Error(`Resposta narrativa recuperada via ${parsed.source}`)
          warn('narratorResponse', `Attempt ${index + 1}/${attempts.length}: rejecting parse source ${parsed.source} — raw prefix: ${generated.text.slice(0, 300).replace(/\n/g, '\\n')}`)
          continue
        }

        const sanitized = this.sanitizeNarratorResponse(parsed.value, {
          fillFallbackOptions: false,
          allowNarrativeFallback: false
        })

        if (!this.isNarratorResponseStructurallyValid(sanitized)) {
          lastError = new Error('Resposta narrativa estruturalmente inválida')
          warn('narratorResponse', `Attempt ${index + 1}/${attempts.length}: sanitized response failed structural validation`)
          continue
        }

        if (parsed.source !== 'direct') {
          warn('narratorResponse', `Structured output recovered via ${parsed.source}`)
        }

        return sanitized
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))
        warn('narratorResponse', `Attempt ${index + 1}/${attempts.length}: geração falhou (${lastError.message})`)
      }
    }

    throw lastError ?? new Error('Não foi possível gerar uma resposta narrativa canônica')
  }

  // ─── Validação de ação custom ───────────────────────────────────────────────

  async validateAction(req: ValidateActionRequest): Promise<ValidateActionResponse> {
    // Atalho determinístico: ações inequivocamente triviais não precisam de LLM
    const trivialResult = classifyTrivialAction(req.input)
    if (trivialResult.trivial) {
      warn('validateAction', `Ação trivial detectada (sem chamada LLM): "${req.input}"`)
      return {
        feasible: true,
        actionType: 'custom',
        actionPayload: { input: req.input },
        diceCheck: { required: false, reason: trivialResult.reason },
        interpretation: req.input
      }
    }

    const sysPrompt = [
      'Você é o Narrador Mestre de um RPG de mesa Savage Worlds.',
      'O jogador digitou uma ação livre. Sua tarefa é VALIDAR se a ação é possível no contexto atual.',
      '',
      'Você DEVE retornar SOMENTE um JSON válido (sem markdown, sem comentários) com esta estrutura:',
      '{',
      '  "feasible": true|false,',
      '  "feasibilityReason": "<motivo se não for possível, ou vazio>",',
      '  "actionType": "<tipo inferido: custom|trait_test|attack|travel>",',
      '  "actionPayload": { <campos para montar a ação mecânica> },',
      '  "diceCheck": {',
      '    "required": true|false,',
      '    "skill": "<perícia necessária ou null>",',
      '    "attribute": "<atributo necessário ou null>",',
      '    "modifier": 0,',
      '    "tn": 4,',
      '    "reason": "<justificativa narrativa>"',
      '  },',
      '  "interpretation": "<breve descrição de como você interpretou a ação>"',
      '}',
      '',
      'REGRAS DE VALIDAÇÃO:',
      '- Se a ação é impossível no contexto (ex: usar item que não tem, atacar NPC que não está presente) → feasible: false.',
      '',
      '- PRINCÍPIO FUNDAMENTAL do teste de dados:',
      '  Só marque diceCheck.required: true quando AMBAS as condições forem verdadeiras:',
      '  (1) o resultado é genuinamente incerto neste contexto, E',
      '  (2) a falha teria consequências narrativas interessantes.',
      '  Se qualquer uma dessas condições for falsa → diceCheck.required: false.',
      '',
      '- Ações que NUNCA exigem teste (automáticas para qualquer personagem):',
      '  • Atender o telefone/celular/chamada',
      '  • Abrir uma porta destrancada ou desimpedida',
      '  • Sentar, deitar, levantar-se',
      '  • Ligar/desligar aparelho simples, pressionar botão óbvio',
      '  • Acenar, gesticular, cumprimentar com gesto',
      '  • Pular obstáculo claramente baixo e seguro (meio-fio, degrau)',
      '  • Conversar sem intenção de persuadir',
      '  • Andar por caminho seguro sem ameaças',
      '  • Descansar, respirar, aguardar',
      '  • Examinar item já em mãos / verificar inventário',
      '',
      '- Ações que EXIGEM teste:',
      '  • Perceber algo oculto → skill: "Percepção"',
      '  • Mover-se furtivamente → skill: "Furtividade"',
      '  • Escalar, saltar abismo, correr sob pressão → skill: "Atletismo"',
      '  • Convencer, enganar, barganhar → skill: "Persuasão"',
      '  • Intimidar → skill: "Intimidação"',
      '  • Curar ferimentos → actionType: "heal", actionPayload: {} (não use trait_test para cura)',
      '  • Arrombar fechadura, desarmar armadilha → skill: "Ladinagem"',
      '  • Investigar pistas → skill: "Pesquisa"',
      '  • Resistir a veneno/doença → attribute: "vigor"',
      '  • Resistir a medo → attribute: "spirit"',
      '  • Combate → actionType "attack"',
      '',
      '  ATENÇÃO contextual: "abrir a porta" pode exigir Ladinagem se o contexto indicar que está trancada;',
      '  "pular" pode exigir Atletismo se for um abismo real.',
      '',
      '- Para combate → actionType: "attack", inclua targetId e damageFormula no actionPayload.',
      '  Exemplos de damageFormula: "str" (soco/desarmado), "str+d4" (faca), "str+d6" (espada curta), "str+d8" (espada longa), "str+d10" (montante), "2d6" (pistola), "2d8" (rifle).',
      '  Use a arma equipada pelo personagem se disponível no inventário, senão use "str" (desarmado).',
      '- Para testes de habilidade → actionType: "trait_test", inclua skill ou attribute no actionPayload.',
      '- Para deslocamento a um LOCAL DIFERENTE do atual → actionType: "travel", inclua "to" no actionPayload com o nome do local de destino.',
      '  ATENÇÃO: mover-se em direção a um NPC que já está na cena (ex: "ir em direção ao homem", "se aproximar do estranho") NÃO é "travel" — use actionType: "custom".',
      '- Para ações narrativas simples → actionType: "custom".',
      '- Use os nomes das PERÍCIAS DO JOGADOR listadas no contexto.',
      '- O campo "interpretation" deve ser 1 frase curta explicando o que o jogador quer fazer.'
    ].join('\n')

    const ctx = req.context
    const inventoryText = ctx.inventory.length
      ? ctx.inventory.map((i) => `${i.name} (x${i.quantity})`).join(', ')
      : 'vazio'
    const npcsText = ctx.npcsPresent.length
      ? ctx.npcsPresent.map((n) => {
          const tipo = n.isWildCard ? 'Wild Card' : 'Extra'
          const disp = n.disposition ?? 'neutral'
          const status = n.wounds > 0 ? ` ferido ${n.wounds}/${n.maxWounds}` : ''
          return `${n.name} (${n.id}) [${tipo}, ${disp}, Res ${n.toughness}, Aparar ${n.parry}${status}]`
        }).join(', ')
      : 'nenhum'
    const defeatedText = (ctx.defeatedNpcIds ?? []).length
      ? (ctx.defeatedNpcIds ?? []).join(', ')
      : null
    const statusText = ctx.activeStatusEffects.length
      ? ctx.activeStatusEffects.map((s) => `${s.name}${s.turnsRemaining ? ` (${s.turnsRemaining} turnos)` : ''}`).join(', ')
      : 'nenhum'
    const skillsText = ctx.playerSkills
      ? Object.entries(ctx.playerSkills).map(([k, v]) => `${k}: ${v}`).join(', ')
      : 'desconhecidas'

    const recentText = req.recentMessages
      .slice(-5)
      .map((m) => m.role === 'narrator' ? `Narrador: ${(m.narrative ?? '').slice(0, 200)}` : `Jogador: ${m.playerInput ?? ''}`)
      .filter(Boolean)
      .join('\n')

    const prompt = [
      `AÇÃO DO JOGADOR: "${req.input}"`,
      '',
      '── CONTEXTO DA CENA ──',
      `Local: ${ctx.location}`,
      `Ferimentos: ${ctx.wounds} | Fadiga: ${ctx.fatigue} | Abalado: ${ctx.isShaken ? 'sim' : 'não'} | Bennies: ${ctx.bennies}`,
      `NPCs presentes: ${npcsText}`,
      defeatedText ? `NPCs derrotados (não são ameaças ativas): ${defeatedText}` : '',
      `Inventário: ${inventoryText}`,
      `Efeitos ativos: ${statusText}`,
      `Perícias do jogador: ${skillsText}`,
      ctx.rulesDigest ? `\nREGRAS:\n${ctx.rulesDigest}` : '',
      ctx.summaryText ? `\nRESUMO:\n${ctx.summaryText}` : '',
      '',
      '── ÚLTIMAS MENSAGENS ──',
      recentText,
      '',
      'Valide a ação e retorne o JSON.'
    ].filter(Boolean).join('\n')

    try {
      const attempts = [
        { maxOutputTokens: 1024, temperature: 0.2 },
        { maxOutputTokens: 2048, temperature: 0.15 }
      ] as const

      for (const [index, attempt] of attempts.entries()) {
        const generated = await this.generateTextDetailed(prompt, {
          systemInstruction: sysPrompt,
          maxOutputTokens: attempt.maxOutputTokens,
          temperature: attempt.temperature
        })

        const parsed = parseJsonObjectDetailed(generated.text)
        if (!parsed) {
          warn(
            'validateAction',
            `Attempt ${index + 1}/${attempts.length}: JSON parse failed (finish=${generated.finishReason ?? 'unknown'}, maxTokens=${attempt.maxOutputTokens})`
          )
          continue
        }

        if (parsed.source === 'regex') {
          warn(
            'validateAction',
            `Attempt ${index + 1}/${attempts.length}: ignoring regex-only recovery (finish=${generated.finishReason ?? 'unknown'})`
          )
          continue
        }

        const response = sanitizeValidateActionResponse(parsed.value, req.input)
        if (!response) {
          warn(
            'validateAction',
            `Attempt ${index + 1}/${attempts.length}: parsed JSON incomplete (${parsed.source}, finish=${generated.finishReason ?? 'unknown'})`
          )
          continue
        }

        if (generated.finishReason === 'MAX_TOKENS' && parsed.source !== 'direct' && index < attempts.length - 1) {
          warn(
            'validateAction',
            `Attempt ${index + 1}/${attempts.length}: output truncated after ${parsed.source} recovery, retrying`
          )
          continue
        }

        if (parsed.source !== 'direct') {
          warn('validateAction', `Structured output recovered via ${parsed.source}`)
        }

        return response
      }

      // Fallback: não conseguiu parsear — permite a ação como custom
      warn('validateAction', 'JSON parse failed, allowing action as custom')
      return {
        feasible: true,
        actionType: 'custom',
        actionPayload: { input: req.input },
        interpretation: req.input
      }
    } catch (error) {
      logErr('validateAction', 'Error:', error)
      // Em caso de erro, não bloquear — permitir como custom
      return {
        feasible: true,
        actionType: 'custom',
        actionPayload: { input: req.input },
        interpretation: req.input
      }
    }
  }

  async narrateStart(req: NarrateStartRequest): Promise<NarratorTurnResponse> {
    const characterTraits: string[] = []
    if (req.character.edges.length) characterTraits.push(`Vantagens: ${req.character.edges.join(', ')}`)
    if (req.character.hindrances.length) characterTraits.push(`Complicações: ${req.character.hindrances.map(h => `${h.name} (${h.severity})`).join(', ')}`)

    const userPrompt = [
      'INÍCIO DE SESSÃO — Narre a abertura desta aventura de RPG.',
      '',
      `PERSONAGEM: ${req.character.name}`,
      req.character.race ? `Raça: ${req.character.race}` : '',
      req.character.gender ? `Gênero: ${req.character.gender}` : '',
      req.character.characterClass ? `Classe: ${req.character.characterClass}` : '',
      req.character.profession ? `Profissão: ${req.character.profession}` : '',
      req.character.description ? `Descrição: ${req.character.description}` : '',
      ...characterTraits,
      '',
      'Crie uma abertura rica, imersiva e específica que coloque o personagem no centro da ação.',
      'Descreva a cena inicial com detalhes sensoriais concretos — cheiros, sons, temperatura, visão — que sejam específicos deste universo, não genéricos.',
      'Apresente um gancho narrativo claro: uma tensão palpável, um problema imediato ou uma oportunidade que exige decisão agora.',
      'Estabeleça ao menos 1 detalhe de worldbuilding específico (um nome de lugar, uma facção, um costume local, um objeto estranho) que o jogador possa explorar.',
      'Inclua pelo menos 1 NPC com traço de personalidade visível — não apenas "um mercador", mas alguém com urgência, nervosismo, arrogância ou curiosidade perceptíveis.',
      'Ofereça 4 opções variadas de ação para o jogador começar sua aventura — cada opção deve sentir-se como uma escolha de história, não um botão de menu.',
      'Para CADA opção, avalie se ela exige um teste de dados (diceCheck) conforme as regras de Savage Worlds.',
      '',
      'ITENS INICIAIS (OBRIGATÓRIO):',
      'Retorne em "itemChanges" de 3 a 6 itens iniciais com changeType "gained" que o personagem já possui ao começar a aventura.',
      'Escolha itens coerentes com a classe, profissão, raça e ambientação do mundo. Exemplos de categorias:',
      '- Arma principal adequada à classe/profissão (espada, arco, cajado, adaga, pistola, rifle, etc.)',
      '- Se a arma for à distância (arco, besta, pistola, rifle, escopeta, etc.), inclua OBRIGATORIAMENTE a munição correspondente como item separado (flechas, virotes, balas, cartuchos, etc.) com quantidade adequada ao contexto',
      '- Armadura ou vestimenta de proteção se aplicável',
      '- Provisões básicas de viagem (ração, cantil, bolsa)',
      '- 1 a 2 itens temáticos/narrativos que conectem o personagem ao mundo (amuleto de família, carta misteriosa, mapa antigo, diário, etc.)',
      '- Dinheiro inicial OBRIGATÓRIO: inclua 1 item com category "money" e o nome adequado ao cenário (ex: "Moedas de Ouro", "Créditos", "Dólares", "Gil", etc.) e "quantity" com a quantidade exata numérica coerente com a ambientação e o contexto do personagem.',
      '- Para ambientações modernas/futuristas: se o personagem tiver profissão ou contexto que justifique, inclua um veículo (category "vehicle": carro, moto, nave, etc.) ou propriedade (category "property": apartamento, base, etc.) como item inicial.',
      'Mencione os itens naturalmente dentro da narrativa de abertura (ex: descreva o personagem conferindo seus pertences, ou um NPC entregando algo).',
      'Use o mesmo formato itemChanges já definido no system prompt. Cada item DEVE ter o campo "category" preenchido corretamente.'
    ].filter(Boolean).join('\n')

    try {
      return await this.generateNarratorResponse(userPrompt, this.narrateStartMaxTokens, {
        world: req.world,
        campaign: req.campaign,
        mode: 'start',
        narrativeStyle: req.narrativeStyle,
        simpleVocabulary: req.simpleVocabulary
      })
    } catch (error) {
      logLlmError('narrateStart', error)
      // Fallback mínimo para não bloquear a sessão
      return {
        isFallback: true,
        narrative: `Você chega a um novo lugar. O ar carrega o peso de histórias não contadas. Ao seu redor, a paisagem de ${req.campaign.thematic} se estende até onde a vista alcança. Um caminho se abre à sua frente, e você sente que a aventura está prestes a começar.`,
        options: [
          { id: randomUUID(), text: 'Explorar o caminho principal', actionType: 'custom', actionPayload: { input: 'Explorar o caminho principal' }, feasible: true, diceCheck: { required: false, reason: 'Caminho seguro e acessível' } },
          { id: randomUUID(), text: 'Observar os arredores com atenção', actionType: 'trait_test', actionPayload: { skill: 'Percepção' }, feasible: true, diceCheck: { required: true, skill: 'Percepção', modifier: 0, tn: 4, reason: 'Detectar detalhes ocultos no ambiente' } },
          { id: randomUUID(), text: 'Procurar alguém para conversar', actionType: 'custom', actionPayload: { input: 'Procurar alguém para conversar' }, feasible: true, diceCheck: { required: false, reason: 'Ação social simples' } },
          { id: randomUUID(), text: 'Verificar seus pertences e seguir adiante', actionType: 'custom', actionPayload: { input: 'Verificar pertences e seguir adiante' }, feasible: true, diceCheck: { required: false, reason: 'Ação trivial sem risco' } }
        ],
        npcs: [],
        itemChanges: [],
        statusChanges: []
      }
    }
  }

  async narrateTurn(req: NarrateTurnRequest): Promise<NarratorTurnResponse> {
    // ── Montar array multi-turn a partir do histórico recente ──
    // Incluir player, narrator e resultados mecanicos system recentes.
    const contents: ContentEntry[] = []

    for (const msg of req.recentMessages) {
      if (msg.role === 'narrator' && msg.narrative) {
        contents.push({ role: 'model', text: msg.narrative })
      } else if (msg.role === 'player' && msg.playerInput) {
        contents.push({ role: 'user', text: msg.playerInput })
      } else if (msg.role === 'system' && Array.isArray(msg.engineEvents) && msg.engineEvents.length) {
        contents.push({
          role: 'user',
          text: `Resultado mecânico anterior:\n${formatEngineEventsForPrompt(msg.engineEvents)}`
        })
      }
      // system summaries ficam de fora; o resumo consolidado ja entra em summaryText
    }

    // Compatibilidade com Gemini: garantir que contents comece com user.
    // Se a primeira mensagem for model, prefixar com user de contexto
    if (contents.length > 0 && contents[0].role === 'model') {
      contents.unshift({ role: 'user', text: '(início da aventura)' })
    }

    // Compatibilidade com Gemini: garantir alternância user/model.
    const sanitizedContents: ContentEntry[] = []
    for (const entry of contents) {
      const last = sanitizedContents[sanitizedContents.length - 1]
      if (last && last.role === entry.role) {
        // Mesmo role consecutivo: mesclar no último
        last.text += '\n' + entry.text
      } else {
        sanitizedContents.push({ ...entry })
      }
    }

    // ── Montar a última mensagem user com contexto dinâmico do turno ──
    const inventoryList = req.context.inventory.length
      ? req.context.inventory.map(i => `- ${i.name} (x${i.quantity}): ${i.description}`).join('\n')
      : 'Nenhum item'

    const statusList = req.context.activeStatusEffects.length
      ? req.context.activeStatusEffects.map(s => `- ${s.name}${s.turnsRemaining !== undefined ? ` (${s.turnsRemaining} turnos)` : ''}`).join('\n')
      : 'Nenhum efeito ativo'

    const npcList = req.context.npcsPresent.length
      ? req.context.npcsPresent.map(n => {
          const tipo = n.isWildCard ? 'Wild Card' : 'Extra'
          const disp = n.disposition ?? 'neutral'
          const status = n.wounds > 0 ? ` | ferido ${n.wounds}/${n.maxWounds}` : ''
          return `- ${n.name} (${n.id}) [${tipo}, ${disp}, Res ${n.toughness}, Aparar ${n.parry}${status}]`
        }).join('\n')
      : 'Nenhum NPC presente'

    const defeatedNpcList = (req.context.defeatedNpcIds ?? []).length
      ? (req.context.defeatedNpcIds ?? []).join(', ')
      : null

    const engineResultText = req.engineEvents.length
      ? formatEngineEventsForPrompt(req.engineEvents)
      : 'Sem resultado mecânico'

    const currentTurnPrompt = [
      'TURNO DO JOGO — Narre a consequência da ação do jogador.',
      'Se houver conflito entre memória anterior e este estado estruturado do turno, este estado estruturado prevalece.',
      '',
      '── ESTADO ATUAL ──',
      `Local: ${req.context.location}`,
      `Ferimentos: ${req.context.wounds} | Fadiga: ${req.context.fatigue} | Abalado: ${req.context.isShaken ? 'Sim' : 'Não'} | Bennies: ${req.context.bennies}`,
      '',
      '── INVENTÁRIO ──',
      inventoryList,
      '',
      '── EFEITOS ATIVOS ──',
      statusList,
      '',
      '── NPCs PRESENTES ──',
      npcList,
      ...(defeatedNpcList ? ['', '── NPCs DERROTADOS (já eliminados — NÃO referenciar como ameaças ativas) ──', defeatedNpcList] : []),
      '',
      '── AÇÃO DO JOGADOR ──',
      `Tipo: ${req.playerAction.type}`,
      `Descrição: ${req.playerAction.description}`,
      '',
      '── RESULTADO MECÂNICO ──',
      engineResultText
    ].join('\n')

    // Adicionar último user turn com contexto dinâmico
    sanitizedContents.push({ role: 'user', text: currentTurnPrompt })

    // Se contents está vazio (sem histórico), ter apenas o currentTurnPrompt como user
    // Isso acontece no primeiro turno ou quando não há mensagens recentes

    try {
      return await this.generateNarratorResponse(
        sanitizedContents,
        this.narrateTurnMaxTokens,
        {
          world: req.world,
          campaign: req.campaign,
          rulesDigest: req.context.rulesDigest,
          summaryText: req.context.summaryText,
          playerSkills: req.context.playerSkills,
          mode: 'turn',
          narrativeStyle: req.narrativeStyle,
          simpleVocabulary: req.simpleVocabulary
        }
      )
    } catch (error) {
      logLlmError('narrateTurn', error)
      warn('narrateTurn', `Fallback ativado: ${error instanceof Error ? error.message : String(error)}`)
      return {
        isFallback: true,
        narrative: `Sua ação ecoa no ambiente. As consequências ainda não são claras, mas o mundo ao redor reage de formas sutis. O que fará agora?`,
        options: [
          { id: randomUUID(), text: 'Investigar o resultado da ação', actionType: 'custom', actionPayload: { input: 'Investigar o que aconteceu' }, feasible: true, diceCheck: { required: true, skill: 'Percepção', modifier: 0, tn: 4, reason: 'Investigar requer atenção aos detalhes' } },
          { id: randomUUID(), text: 'Seguir adiante com cautela', actionType: 'custom', actionPayload: { input: 'Seguir adiante com cautela' }, feasible: true, diceCheck: { required: false, reason: 'Movimento cauteloso sem ameaça imediata' } },
          { id: randomUUID(), text: 'Observar os arredores', actionType: 'trait_test', actionPayload: { skill: 'Percepção' }, feasible: true, diceCheck: { required: true, skill: 'Percepção', modifier: 0, tn: 4, reason: 'Detectar ameaças e oportunidades' } },
          { id: randomUUID(), text: 'Descansar um momento', actionType: 'custom', actionPayload: { input: 'Descansar e recuperar forças' }, feasible: true, diceCheck: { required: false, reason: 'Descanso simples sem perigo' } }
        ],
        npcs: [],
        itemChanges: [],
        statusChanges: []
      }
    }
  }
}
