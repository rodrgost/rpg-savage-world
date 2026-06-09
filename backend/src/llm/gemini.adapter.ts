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
  NarrativeSegment,
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

function normalizeMentionKey(value: string): string {
  return sanitizeInlineText(value, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
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

type RecentSuggestedCharacter = {
  name: string
  profession: string
  description: string
  campaignRole: string
}

const RECENT_CHARACTER_SUGGESTIONS_LIMIT = 8
const RECENT_CHARACTER_CONTEXTS_LIMIT = 40
const recentCharacterSuggestions = new Map<string, RecentSuggestedCharacter[]>()

function normalizeSuggestionText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

function buildCharacterSuggestionContextKey(req: SuggestCharacterFromWorldRequest): string {
  const worldName = normalizeSuggestionText(req.worldName ?? '').slice(0, 80)
  const lore = normalizeSuggestionText(req.worldLore ?? '').slice(0, 120)
  const story = normalizeSuggestionText(req.storyDescription ?? '').slice(0, 180)
  return `${worldName}|${lore}|${story}`
}

function uniqueSuggestionWords(value: string): Set<string> {
  const ignored = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'o', 'a', 'os', 'as', 'um', 'uma', 'para', 'por', 'com', 'sem', 'em', 'na', 'no'])
  return new Set(
    normalizeSuggestionText(value)
      .split(' ')
      .filter(word => word.length > 2 && !ignored.has(word))
  )
}

function jaccardSimilarity(left: string, right: string): number {
  const leftWords = uniqueSuggestionWords(left)
  const rightWords = uniqueSuggestionWords(right)
  if (leftWords.size === 0 || rightWords.size === 0) return 0

  let intersection = 0
  for (const word of leftWords) {
    if (rightWords.has(word)) intersection++
  }

  const union = leftWords.size + rightWords.size - intersection
  return union === 0 ? 0 : intersection / union
}

function getRecentCharacterSuggestions(contextKey: string): RecentSuggestedCharacter[] {
  return recentCharacterSuggestions.get(contextKey) ?? []
}

function rememberCharacterSuggestion(contextKey: string, character: SuggestedCharacter): void {
  const existing = getRecentCharacterSuggestions(contextKey)
  const next = [
    {
      name: character.name,
      profession: character.profession,
      description: character.description,
      campaignRole: character.campaignRole
    },
    ...existing
  ].slice(0, RECENT_CHARACTER_SUGGESTIONS_LIMIT)

  if (!recentCharacterSuggestions.has(contextKey) && recentCharacterSuggestions.size >= RECENT_CHARACTER_CONTEXTS_LIMIT) {
    const oldestKey = recentCharacterSuggestions.keys().next().value
    if (oldestKey) recentCharacterSuggestions.delete(oldestKey)
  }

  recentCharacterSuggestions.set(contextKey, next)
}

function getRecentSuggestionDiversityIssue(character: SuggestedCharacter, recent: RecentSuggestedCharacter[]): string | null {
  const name = normalizeSuggestionText(character.name)
  const profession = normalizeSuggestionText(character.profession)
  const description = normalizeSuggestionText(character.description)
  const campaignRole = normalizeSuggestionText(character.campaignRole)

  for (const previous of recent) {
    const previousName = normalizeSuggestionText(previous.name)
    const previousProfession = normalizeSuggestionText(previous.profession)
    const previousDescription = normalizeSuggestionText(previous.description)
    const previousCampaignRole = normalizeSuggestionText(previous.campaignRole)

    if (name && name === previousName) return `nome repetido (${character.name})`
    if (profession && profession === previousProfession && jaccardSimilarity(campaignRole, previousCampaignRole) >= 0.28) {
      return `profissao e papel muito parecidos (${character.profession})`
    }
    if (description && jaccardSimilarity(description, previousDescription) >= 0.55) {
      return 'descricao muito parecida com sugestao recente'
    }
  }

  return null
}

function buildRecentSuggestionAvoidanceLines(recent: RecentSuggestedCharacter[]): string[] {
  if (!recent.length) return []

  return [
    'Avoid repeating recent suggestions for this same adventure:',
    ...recent.slice(0, 5).map((character) => `  - ${character.name} / ${character.profession}`),
    'Create a new combination of name, profession, narrative role, and motivation.'
  ]
}

function getSuggestedCharacterIssues(character: SuggestedCharacter): string[] {
  const issues: string[] = []
  const description = character.description.trim()
  const campaignRole = character.campaignRole?.trim() ?? ''

  if (!character.name.trim()) issues.push('name vazio')
  if (!character.profession.trim()) issues.push('profissao vazia')
  if (description.length < 80) issues.push(`description curta (${description.length})`)
  if (description && !endsWithSentenceBoundary(description)) issues.push('description sem fim de frase')
  if (campaignRole.length < 30) issues.push(`campaignRole curto (${campaignRole.length})`)

  return issues
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
    name: sanitizeCharacterField(nameValue, ''),
    gender: sanitizeCharacterField(genderValue, ''),
    race: sanitizeCharacterField(raceValue, ''),
    profession: sanitizeCharacterField(professionValue, ''),
    description: sanitizeCharacterField(descriptionValue, ''),
    campaignRole: sanitizeCharacterField(campaignRoleValue, '')
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
      ? readEnv('DEEPSEEK_NARRATE_START_TEMPERATURE', '0.25')
      : readEnv('GEMINI_NARRATE_START_TEMPERATURE', '0.25'),
    this.provider === 'deepseek' ? 0.25 : 0.25
  )
  private readonly narrateTurnTemperature = toNumber(
    this.provider === 'deepseek'
      ? readEnv('DEEPSEEK_NARRATE_TURN_TEMPERATURE', '0.20')
      : readEnv('GEMINI_NARRATE_TURN_TEMPERATURE', '0.20'),
    this.provider === 'deepseek' ? 0.20 : 0.20
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
  private readonly characterSuggestionMaxOutputTokens = withMin(
    toNumber(
      this.provider === 'deepseek'
        ? readEnv('DEEPSEEK_CHARACTER_SUGGEST_MAX_OUTPUT_TOKENS', '2048')
        : readEnv('GEMINI_CHARACTER_SUGGEST_MAX_OUTPUT_TOKENS', '4096'),
      this.provider === 'deepseek' ? 2048 : 4096
    ),
    2048
  )
  private readonly characterSuggestionThinkingBudget = withMin(
    toNumber(readEnv('GEMINI_CHARACTER_SUGGEST_THINKING_BUDGET', '512'), 512),
    128
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
      ? `Active combat in round ${state.combat.round} with ${state.combat.combatants.length} combatants.`
      : 'No formal combat in progress.'
    const threatsText = hostileNpcs.length
      ? hostileNpcs
        .slice(0, 6)
        .map((npc) => `${npc.name}${npc.wounds > 0 ? ` wounded ${npc.wounds}/${npc.maxWounds}` : ''}`)
        .join(', ')
      : 'No immediate threat confirmed.'
    const resourcesText = p.inventory.length
      ? p.inventory.slice(0, 8).map((item) => `${item.name} x${item.quantity}`).join(', ')
      : 'No relevant resources carried.'
    const forcesText = npcsAtLocation.length
      ? npcsAtLocation
        .slice(0, 8)
        .map((npc) => `${npc.name}${npc.disposition ? ` (${npc.disposition})` : ''}`)
        .join(', ')
      : 'No one relevant visible at location.'
    const statusText = p.statusEffects.length
      ? p.statusEffects.map((effect) => `${effect.name}${effect.turnsRemaining != null ? ` (${effect.turnsRemaining}t)` : ''}`).join(', ')
      : 'No active effects.'
    const activeFlagsText = activeFlags.length ? activeFlags.join(', ') : 'No relevant active flags.'

    const sysPrompt = [
      'You maintain the canonical continuity summary of a story.',
      'Objective: generate a summary that preserves BOTH mechanical continuity AND open narrative threads — allowing the narrator to build on what has already been established.',
      'SOURCE PRIORITY (most to least authoritative):',
      '  1. CURRENT STRUCTURED STATE (factual anchor) — overrides any data in the previous summary or messages.',
      '  2. Most recent messages — take priority over older messages when there is a narrative conflict.',
      '  3. Previous summary — starting point; replace what has been superseded by recent events.',
      'Rules:',
      '- Write in flowing paragraphs, without titles, labels, or sections.',
      '- Use 2 to 4 paragraphs — the information that matters for immediate continuation and narrative coherence.',
      '- Preserve facts that affect the current situation: position, threats, pending objectives, unresolved problems.',
      '- DO NOT preserve situations, objectives, or states that have been explicitly fulfilled, defeated, or superseded — keeping them creates incoherence.',
      '- ALSO preserve open narrative threads: raised mysteries, promises made, revealed secrets, unanswered questions, unresolved tensions.',
      '- Preserve the name and at least 1 personality trait or motivation of relevant NPCs that appeared — not just disposition.',
      '- Preserve worldbuilding discoveries that can be referenced: specific location details, revealed lore, mentioned factions, significant objects.',
      '- Do not recount the action step by step. Do not describe old blows, falls, or deaths unless they continue as active consequences.',
      '- Never list inventory items in the summary — they are tracked separately.',
      '- Preserve proper names and relevant counts when they affect the next decision.',
      '- Do not use markdown, bullets, preamble, greetings, or metalinguistic comments.'
    ].join('\n')

    const narrativeBlock = req.recentMessages?.length
      ? `Session messages (opening and recent, chronological order):\n${req.recentMessages.map((m) => `[${m.role === 'narrator' ? 'Narrator' : 'Player'} T${m.turn}] ${m.text}`).join('\n')}`
      : null

    const prompt = [
      `=== CURRENT STATE (factual anchor — prevails in any conflict) ===`,
      `Turn: ${req.upToTurn}. Location: ${state.worldState.activeLocation}.`,
      combatText,
      `Wounds: ${p.wounds}/${p.maxWounds}. Fatigue: ${p.fatigue}. Shaken: ${p.isShaken ? 'yes' : 'no'}. Bennies: ${p.bennies}.`,
      `Visible threats: ${threatsText}`,
      `Forces/NPCs at location: ${forcesText}`,
      `Active effects: ${statusText}`,
      `Active world flags: ${activeFlagsText}`,
      '',
      `=== PREVIOUS SUMMARY (starting point — replace what has been superseded) ===`,
      req.previousSummary || 'no previous summary.',
      narrativeBlock ? '' : null,
      narrativeBlock,
      '',
      'Generate the updated summary. Discard from the previous summary everything that has been superseded. Do not repeat facts that the current state renders obsolete.'
    ].filter((line) => line !== null).join('\n')

    try {
      const generated = await this.generateText(prompt, {
        systemInstruction: sysPrompt,
        temperature: this.summaryTemperature
      })
      return sanitizeNarrativeOutput(generated)
    } catch {
      const parts: string[] = []
      parts.push(`The character is at ${state.worldState.activeLocation}. ${combatText}`)
      if (threatsText !== 'No immediate threat confirmed.') parts.push(threatsText)
      if (resourcesText !== 'No relevant resources carried.') parts.push(`Available resources: ${resourcesText}.`)
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
      ? `Active combat in round ${state.combat.round} with ${state.combat.combatants.length} combatants.`
      : 'No formal combat in progress.'
    const threatsText = hostileNpcs.length
      ? hostileNpcs
        .slice(0, 6)
        .map((npc) => `${npc.name}${npc.wounds > 0 ? ` wounded ${npc.wounds}/${npc.maxWounds}` : ''}`)
        .join(', ')
      : 'No immediate threat confirmed.'
    const forcesText = npcsAtLocation.length
      ? npcsAtLocation
        .slice(0, 8)
        .map((npc) => `${npc.name}${npc.disposition ? ` (${npc.disposition})` : ''}`)
        .join(', ')
      : 'No one relevant visible at location.'
    const statusText = p.statusEffects.length
      ? p.statusEffects.map((effect) => `${effect.name}${effect.turnsRemaining != null ? ` (${effect.turnsRemaining}t)` : ''}`).join(', ')
      : 'No active effects.'
    const activeFlagsText = activeFlags.length ? activeFlags.join(', ') : 'No relevant active flags.'

    const sysPrompt = [
      'You summarize the story of an RPG adventure.',
      'Read the messages below and generate a prose summary (2 to 4 paragraphs) of the important events.',
      'Preserve character names, visited locations, discoveries, and mysteries not yet resolved.',
      'Do not list inventory. Do not use markdown, titles, or bullets. Prose only in Brazilian Portuguese.'
    ].join('\n')

    const messagesText = req.messages
      .map((m) => `[Turn ${m.turn}] ${m.role === 'narrator' ? 'Narrator' : 'Player'}: ${m.text}`)
      .join('\n')

    const prompt = [
      req.previousSummary ? '=== Previous summary ===\n' + req.previousSummary : '',
      '',
      '=== New events (chronological order) ===',
      messagesText,
      '',
      'Generate the updated summary incorporating the new events above.'
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
      'You are an adventure builder. Write in Brazilian Portuguese.',
      'Objective: create from scratch a complete story from minimal context.',
      'Expected output: a valid JSON with the following fields:',
      '  "name": short and evocative title for the story (3-8 words).',
      '  "thematic": summarized thematic of the story (1 short sentence, e.g.: "Collapsing empire and forbidden magic").',
      '  "storyDescription": 3-6 paragraphs with context, conflicts, factions, locations, and 2-4 adventure hooks.',
      '  "storyCharacters": array of 3 to 7 world NPCs relevant to the narrative, each with:',
      '    - "name": character name',
      '    - "role": role in the story (e.g.: antagonist, mentor, ally, faction leader, neutral)',
      '    - "description": brief character description (1-2 sentences)',
      '    - "status": current situation in the story (e.g.: active, fugitive, dead, unknown)',
      'Constraints: return ONLY the JSON, without preamble, greeting, comments, or separators.',
      'Even when a thematic is provided, generate a title, refined thematic, story, and NPCs as a complete new creation.',
      'Start directly with { and end with }.'
    ].join('\n')

    const prompt = [
      `Campaign name/context: ${req.campaignName || 'free'}.`,
      `Thematic (if provided): ${req.thematic?.trim() || 'to be defined by the LLM'}.`,
      'Current description: ignore; generate from scratch.'
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
      'You are a senior worldbuilder specialized in history. Write exclusively in Brazilian Portuguese.',
      '',
      'Write with clarity and precision — the text serves both those who have never heard of this universe and those who will play in it.',
      'When introducing for the first time any proper name, faction, technology, or concept exclusive to the universe, briefly explain it inline — one sentence is enough.',
      'Create internal coherence: proper names, locations, and factions mentioned in one section must reappear and reinforce each other in the others.',
      'The writing can be atmospheric and literary, but never assume the reader already knows the setting.'
    ].join('\n')

    const tema = [
      `Nome: ${req.name}.`,
      ...(req.description ? [`Descrição: ${req.description}.`] : []),
      ...(req.currentLore?.trim() ? [`Lore atual (mantenha consistência e expanda): ${req.currentLore.trim()}.`] : [])
    ].join('\n')

    const prompt = [
      `Tema: ${tema}`,
      '',
      'Build the complete lore of this universe. MANDATORILY use the headings below, in this order and without altering the heading text.',
      'Sections marked with (if applicable) should be included only if relevant to the provided theme.',
      '',
      '## Em Poucas Palavras',
      'Explain this universe to someone who has never heard of it. Use direct language, without jargon.',
      'Answer in 5 to 7 sentences:',
      '  • What is this world? (an anchor sentence: "It is a world where...", "Imagine X, but Y")',
      '  • What distinguishes it from other universes of the same genre? (the real differentiator, not the obvious)',
      '  • What does any player see, hear, and feel on the first day in this world? (concrete everyday reality)',
      '',
      '## Origens e História',
      'Present the eras or historical phases that shaped the present, from macro (cosmology, creation) to micro (recent catalyst event).',
      '3 dense paragraphs.',
      '',
      '## Doenças, Pragas e Contaminações (se aplicável)',
      'If diseases, viruses, plagues, or contaminations exist in this universe, define:',
      '- **Origem:** natural, manufactured, alien, magical, or unknown.',
      '- **Vetor e progressão:** how it spreads, what the stages are, and how long each lasts.',
      '- **Efeitos nos personagens:** physical, psychological, and social consequences — how society treats the infected (isolation, forced cure, sacrifice, stigma)?',
      '- **Dilema narrativo:** is there a cure? Who controls it and why? Does the cure have a moral cost?',
      '- **Impacto sistêmico:** did the disease alter political, religious, or economic structures of the world?',
      '2 to 3 dense paragraphs.',
      '',
      '## Invasão e Presença Externa (se aplicável)',
      'If an invading force exists — alien, interdimensional, divine, or other — define:',
      '- **Natureza da ameaça:** what they are, where they came from, what they want. Do they communicate? Negotiate? Are they unintelligible?',
      '- **Modo de operação:** do they attack in waves, infiltrate silently, transform the environment, corrupt minds?',
      '- **O que acontece com capturados ou expostos:** death, transformation, enslavement, involuntary symbiosis?',
      '- **Estado atual da invasão:** is it recent and chaotic, or established for generations and normalized by the population?',
      '- **Resistência e adaptação:** how did factions respond? Is there collaboration with the invaders?',
      '3 dense paragraphs.',
      '',
      '## Locais Marcantes',
      'List exactly 2-5 canonical locations. For each, use this format:',
      '*   **Nome do Local:** Description of 2 to 3 sentences capturing its function, atmosphere, and why it is narratively relevant.',
      '',
      '## Facções e Poder',
      'Describe 4 groups with objectives, philosophy, and relations between them. Each faction must have tension with at least one other.',
      '3 dense paragraphs.',
      '',
      '## Magia, Tecnologia e Regras do Mundo',
      'Define what is possible in this universe: sources of power, concrete limitations, and what is forbidden or unknown.',
      'Include how this rule system creates moral dilemmas for characters.',
      'If characters can have powers or abilities beyond the common human, also include:',
      '- **Origem dos poderes:** birth, accident, ritual, technology, infection, divine choice?',
      '- **Custo e limitações concretas:** physical exhaustion, sanity loss, reduced lifespan, dependence on external resource?',
      '- **Como a sociedade enxerga quem tem poderes:** revered, persecuted, forcibly recruited, hidden?',
      '- **Poderes proibidos ou desconhecidos:** is there something that could be done but that no one dared or survived to tell?',
      '- **Progressão e perda:** can powers grow? Can they be stolen, corrupted, or permanently lost?',
      '3 to 5 dense paragraphs.',
      '',
      '## Impacto nos Personagens',
      'Translate the world\'s forces into concrete consequences for those who live in it:',
      '- **Traumas e marcas do cenário:** what emotional or physical baggage do most characters carry from existing in this world?',
      '- **Escolhas recorrentes:** what dilemmas does the setting repeatedly force — loyalty vs. survival, power vs. human cost?',
      '- **O que os personagens não sabem:** what truths are systematically hidden from the common population?',
      '- **Pontos de virada pessoal:** what events can permanently change a character — exposure to disease, contact with invaders, power manifestation, historical revelation?',
      '2 dense paragraphs.',
      '',
      'Absolute constraints: no comments outside the lore, no greeting, praise, preamble, or separator (***). Omit sections marked as (if applicable) if not pertinent to the theme. Start immediately with ## Em Poucas Palavras.'
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
      'You create short visual descriptions for photographic image generation.',
      'Expected output: a single short paragraph, with 1 or 2 sentences, focused on atmosphere, composition, setting, and memorable visual details.',
      'If the title refers to a well-known film, series, game, comic, or book, draw inspiration from the aesthetic of that work\'s official cover art or poster: predominant color palette, composition, framing, and visual atmosphere — but without reproducing protected characters, real actors, recognizable faces, logos, titles, or brands.',
      'If the title does not refer to any known work, describe an epic and original scene coherent with the name.',
      'Deliver only the final visual description, without lists, markdown, comments about the request, or negative instructions.'
    ].join('\n')

    let prompt = ''

    if (req.entityType === 'world') {
      prompt = [
        `Universe title: ${req.title}.`,
        'If this title refers to a famous film, series, game, comic, or book, base THE ENTIRE description on the characteristic visual aesthetic of that work: color palette, composition, atmosphere, lighting, and visual style — without copying protected characters, real actors, logos, or brands. The reference theme must guide every visual element of the image.',
        'Otherwise, describe an epic and original scene with strong visual identity coherent with the name and theme of the universe, capturing the thematic essence so that the entire image reflects that universe.',
      ].join('\n')
    } else if (req.entityType === 'campaign') {
      prompt = [
        `Campaign title: ${req.title}.`,
        'Describe a wide image that translates the campaign\'s atmosphere as striking and cinematic illustrated art.'
      ].join('\n')
    } else {
      prompt = [
        `World: ${req.worldName}.`,
        `Campaign: ${req.campaignTitle}.`,
        ...(req.gender?.trim() ? [`Gender: ${req.gender}.`] : []),
        ...(req.race?.trim() ? [`Race or species: ${req.race}.`] : []),
        `Profession: ${req.profession}.`,
        ...(req.additionalDescription?.trim() ? [`Provided details: ${req.additionalDescription}.`] : []),
        'Describe a character portrait coherent with this context, highlighting silhouette, clothing, expression, posture, and striking visual traits.'
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
    const worldName = req.worldName?.trim() ?? ''
    const worldLore = req.worldLore?.trim() ?? ''
    const storyDescription = req.storyDescription?.trim() ?? ''
    const promptWorldLore = worldLore.length > 6000 ? `${worldLore.slice(0, 6000)}...` : worldLore
    const promptStoryDescription = storyDescription.length > 2800 ? `${storyDescription.slice(0, 2800)}...` : storyDescription
    const contextKey = buildCharacterSuggestionContextKey(req)
    const creativeIdentityLocked = Boolean(existing.name?.trim())
    const existingLines: string[] = []
    if (hasExisting) {
      existingLines.push(
        'The player has already filled in the following fields — KEEP these values exactly as they are and fill in only the missing fields:'
      )
      if (existing.name) existingLines.push(`  name: "${existing.name}"`)
      if (existing.gender) existingLines.push(`  gender: "${existing.gender}"`)
      if (existing.race) existingLines.push(`  race: "${existing.race}"`)
      if (existing.profession) existingLines.push(`  profession: "${existing.profession}"`)
      if (existing.description) existingLines.push(`  description: "${existing.description}"`)
      if (existing.campaignRole) existingLines.push(`  campaignRole: "${existing.campaignRole}"`)
    }

    const sysPrompt = [
      'You are a character designer.',
      'Read the world name, universe lore, and adventure story. Create a character whose role and profession emerge NATURALLY from that data, without using pre-defined archetypes from the system.',
      'Respond ONLY in valid JSON, without markdown or comments.',
      'Always return the 6 keys; gender and race can be empty string when the context does not support an inference.',
      '{"name":"...","gender":"...","race":"...","profession":"...","description":"...","campaignRole":"..."}',
      '',
      'Field instructions:',
      '  name: name coherent with the context; if the player provided a name, preserve that value exactly and treat it only as an identity anchor',
      '  gender: Masculine, Feminine, or Other only when there is a contextual clue; otherwise empty string',
      '  race: race/species only when there is a contextual clue; otherwise empty string',
      '  profession: trade or social role derived exclusively from the world name, lore, and story; max 60 chars',
      '  description: 2-3 sentences derived primarily from the adventure story and lore, describing physical appearance (hair, eyes, build, or notable scar), clothing or equipment coherent with the profession, and personality trait with motivation. Min 80 chars, max 280 chars.',
      '  campaignRole: what this character is doing in this specific adventure, their mission, or how they connect to the plot. Derive from story/lore, be concrete and not generic. Max 300 chars.',
      'If a name is provided, do not invent the description from the sound of the name; use the name only to preserve identity and derive everything else from the adventure story and lore.',
      'In repeated calls for the same plot, vary the name, profession, narrative function, motivation, appearance, and entry point into the adventure.',
    ].join('\n')

    const buildPrompt = (attempt: number): string => {
      const recent = creativeIdentityLocked ? [] : getRecentCharacterSuggestions(contextKey)
      const avoidanceLines = buildRecentSuggestionAvoidanceLines(recent)
      return [
        ...(existingLines.length > 0 ? [...existingLines, ''] : []),
        ...(avoidanceLines.length > 0 ? [...avoidanceLines, ''] : []),
        `Variation attempt: ${attempt}.`,
        '',
        ...(worldName ? [`World/universe name: ${worldName}.`] : []),
        ...(promptWorldLore ? [`Universe lore: ${promptWorldLore}.`, ''] : []),
        `Adventure story: ${promptStoryDescription || 'not provided'}.`,
        '',
        'Derive the profession and role solely from the world/universe, the lore, and the adventure story.'
      ].join('\n')
    }

    try {
      const maxAttempts = creativeIdentityLocked ? 1 : 3
      let lastIssues: string[] = []

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const firstResult = await this.generateTextDetailed(buildPrompt(attempt), {
          maxOutputTokens: this.characterSuggestionMaxOutputTokens,
          timeoutMs: this.timeoutMs,
          responseMimeType: 'application/json',
          temperature: Math.max(this.characterSuggestionTemperature, attempt === 1 ? 0.95 : 1.15),
          systemInstruction: sysPrompt,
          ...(this.provider === 'gemini' ? { thinkingBudget: this.characterSuggestionThinkingBudget } : {})
        }, attempt)
        const generated = firstResult.text

        log('suggestCharacterFromWorld', `LLM raw response (attempt=${attempt}):`, generated)

        const parsedJson = parseJsonObjectDetailed(generated)
        const parsed = parsedJson?.value ?? null
        log('suggestCharacterFromWorld', `Parsed object (attempt=${attempt}, finish=${firstResult.finishReason ?? 'unknown'}, source=${parsedJson?.source ?? 'none'}):`, JSON.stringify(parsed))

        if (parsed) {
          const firstTry = buildSuggestedCharacterFromRecord(parsed)
          log('suggestCharacterFromWorld', `Built character (attempt=${attempt}):`, JSON.stringify({
            name: firstTry.name,
            profession: firstTry.profession,
            descriptionLength: firstTry.description.length,
            campaignRoleLength: firstTry.campaignRole.length
          }))

          const truncatedJson = firstResult.finishReason === 'MAX_TOKENS' && parsedJson?.source !== 'direct'
          const firstTryIssues = getSuggestedCharacterIssues(firstTry)
          const diversityIssue = creativeIdentityLocked ? null : getRecentSuggestionDiversityIssue(firstTry, getRecentCharacterSuggestions(contextKey))
          lastIssues = [
            ...(truncatedJson ? ['truncado'] : []),
            ...firstTryIssues,
            ...(diversityIssue ? [diversityIssue] : [])
          ]

          if (!truncatedJson && firstTryIssues.length === 0 && !diversityIssue) {
            const suggestion = firstTry
            if (!creativeIdentityLocked) rememberCharacterSuggestion(contextKey, suggestion)
            return suggestion
          }

          warn(
            'suggestCharacterFromWorld',
            `Tentativa insuficiente (attempt=${attempt}, finish=${firstResult.finishReason ?? 'unknown'}, source=${parsedJson?.source ?? 'none'}, issues=${lastIssues.join(', ') || 'desconhecido'})`
          )
        } else {
          lastIssues = ['resposta sem objeto legivel']
          warn('suggestCharacterFromWorld', `Tentativa sem parse legivel (attempt=${attempt}, finish=${firstResult.finishReason ?? 'unknown'})`)
        }
      }

      throw new Error(`Resposta veio incompleta, repetida ou fora do JSON esperado (${lastIssues.join(', ') || 'sem detalhe'})`)
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
    narrativeStyle?: 'concise' | 'balanced'
    simpleVocabulary?: boolean
  } = {}): string {
    const { world, campaign, rulesDigest, summaryText, playerSkills, mode = 'turn', narrativeStyle, simpleVocabulary } = opts
    const lines = [
      'You are the Narrator of a story. Respond in Brazilian Portuguese, always in second person singular ("Você entra...", "Você vê...").',
      '',
      '━━━ PRIMARY RULE FOR THE "narrative" FIELD ━━━',
      'Narrate ONLY the direct consequence of the player\'s current action. The narrative MUST stop exactly when the consequence is visible — do NOT describe what the player does after this moment.',
      'MANDATORY: The narrative covers ONE beat: what changed RIGHT NOW as a result of this action. The player\'s next move is ALWAYS chosen from the "options" field, NEVER decided inside "narrative".',
      'FOCUS: what changed, what happened. Avoid recaps, state repetitions, and editorial conclusions.',
      '',
      'DO NOT WRITE:',
      '  • states that didn\'t change, absent things, or generic filler ("nothing changed", "time passes", "no threats in sight")',
      '  • literal mechanical terms: "Shaken", "Wounded", "Fatigue" — narrate instead: "the arm gives out", "vision blurs"',
      '  • NPCs making autonomous decisions that REMOVE player agency or skip the player\'s next choice',
      '    (WRONG: "Marcus leaves, warns the others, and the building is surrounded." RIGHT: "Marcus steps back, hand moving toward his radio.")',
      '  • NOTE: NPCs MAY speak, threaten, taunt, react emotionally, or take immediate in-scene actions (draw a weapon, block a door, shout a warning) — this IS expected. The prohibition is on NPCs resolving the OUTCOME of the scene without player input.',
      '  • editorial conclusions that remove agency: "the priority now is...", "the next step is...", "you two need to...", "now you should...", "it\'s time to...", "you have to...", "you need to...", "you go to...", "you decide to..."',
      '',
      'AGENCY: open situations (what to do with an NPC, where to go) become OPTIONS — never resolved in the narrative.',
      '',
      'EXAMPLES OF CORRECT vs WRONG narrative endings:',
      '  ✅ CORRECT: "The guard\'s weapon clatters to the ground. Two others step forward, blades drawn."',
      '  ❌ WRONG:   "The guard falls. You charge the remaining two and escape through the window."',
      '  ✅ CORRECT: "The door opens, revealing a dimly lit corridor."',
      '  ❌ WRONG:   "The door opens. You step inside and search the room for clues."',
      '  ✅ CORRECT: "Mira flinches at your words, her expression shifting to something harder."',
      '  ❌ WRONG:   "Mira flinches. Now you need to decide whether to trust her or walk away."',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      'The structured context of this call is the only canonical source for JSON fields.',
      'If an NPC, item, effect, skill, destination, condition, or resource is not in the structured context, it CANNOT be created in the JSON fields.',
      'If there is a "STRICT CANONICAL ANCHORS" section in the context, treat that section as a closed list for options, action interpretation, and the normal turn narrative.',
      'When in doubt, prefer to keep npcs, itemChanges, and statusChanges empty/null and preserve continuity only in narrative and options.',
      '',
      'You MUST return ONLY a valid JSON (no markdown, no comments) with the following structure:',
      '{',
      '  "narrative": "<narrative text for this story step>",',
      '  "segments": [',
      '    { "type": "narrator", "text": "<narration, context description, or consequence>" },',
      '    { "type": "npc", "npcId": "<id of the present NPC>", "npcName": "<NPC name>", "disposition": "hostile|neutral|friendly", "text": "<NPC direct speech>" }',
      '  ],',
      '  "options": [',
      '    {',
      '      "id": "<uuid>",',
      '      "text": "<narrative description of the option (action label, 1 short sentence)>",',
      '      "playerSpeech": "<optional — what the player character says out loud when choosing this option. Only for dialogue, confrontation, negotiation, persuasion, or social actions. OMIT for attack, travel, skill tests with no speech. Max 1 sentence, first person, same language as narrative>",',
      '      "actionType": "<mechanical action type: custom|trait_test|attack|travel|flag>",',
      '      "actionPayload": { <partial fields to build the mechanical action> },',
      '      "requiredItems": ["<inventory item name, if required for the action>"],',
      '      "feasible": true,',
      '      "feasibilityReason": "<reason if feasible=false>",',
      '      "diceCheck": {',
      '        "required": true,',
      '        "skill": "<skill name in Brazilian Portuguese, e.g.: Percepção, Furtividade, Luta>",',
      '        "attribute": "<attribute name if not a skill, e.g.: vigor, spirit>",',
      '        "modifier": 0,',
      '        "tn": 4,',
      '        "reason": "<narrative justification for the roll>"',
      '      }',
      '    }',
      '  ],',
      '  "npcs": [',
      '    { "id": "<uuid>", "name": "<name>", "disposition": "hostile|neutral|friendly", "newlyIntroduced": true|false, "status": "active|incapacitated|defeated|dead" }',
      '  ],',
      '  "itemChanges": [',
      '    { "itemId": "<uuid>", "name": "<item name>", "quantity": 1, "changeType": "gained|lost|used", "category": "weapon|armor|consumable|ammunition|money|vehicle|property|quest|misc" }',
      '  ],',
      '  "statusChanges": [',
      '    { "effectId": "<uuid>", "name": "<effect name>", "changeType": "applied|removed", "turnsRemaining": 3, "description": "<desc>", "targetType": "player|npc", "targetId": "<NPC id when targetType=npc, or null>" }',
      '  ],',
      '  "npcAttacks": [',
      '    { "npcId": "<id of the attacking NPC>", "skillDie": <6|8|10|12>, "damageFormula": "<str+d6 or 2d6 etc>", "ap": 0 }',
      '  ]',
      '},',
      '',
      'playerSpeech FIELD RULES:',
      '- Include ONLY when the option naturally involves the player character speaking out loud.',
      '- ✅ USE for: dialogue, confrontation, negotiation, persuasion, taunt, plea, declaration, question directed at an NPC.',
      '- ❌ OMIT for: attack, travel, skill tests (Percepção, Furtividade, Luta...), inspect/search, inventory actions.',
      '- When used: 1 sentence max, first person, in the same language as the narrative. Write as direct speech (no attribution like "você diz:"). Example: "Sei que você está escondendo algo."',
      '',
      'diceCheck FIELD RULES (REQUIRED in EVERY option):',
      '- Only require a roll when BOTH: (1) outcome is genuinely uncertain, AND (2) failure has interesting consequences. If either is false → required=false.',
      '- WHEN IN DOUBT: required=false. Dice are the EXCEPTION. Intention-only options ("Try to help", "Look for a way out", "Check the surroundings") → required: false.',
      '- ACTIONTYPE RULE: if diceCheck.required=true, actionType MUST be "trait_test" or "attack" — NEVER "custom". Using "custom" with required=true causes a system promotion that may lose payload data.',
      '',
     /*  '- Ações que NÃO exigem teste (qualquer personagem faz automaticamente):',
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
      '', */
      '- SPECIAL RULE — actionType "travel": diceCheck.required must ALWAYS be false. Travel is narrative; describe obstacles in the narrative, not in diceCheck.',
      '- "modifier": situational adjustment (-2 for high difficulty, -4 for near-impossible, +2 for advantage). Default: 0.',
      '- "tn": target number. Default 4. Increase for especially difficult situations (6, 8).',
      '- "reason": ALWAYS fill with a short narrative justification.',
      '- Use skill names in Brazilian Portuguese as listed in the PLAYER SKILLS section of the context.',
      '',
      'GENERAL RULES:',
      '- "narrative": mandatory, full turn text (narration + direct speech combined).',
      '- "segments": type="narrator" for prose/description/consequences; type="npc" for NPC direct speech only. When npc: use npcId from PRESENT NPCS or this response\'s "npcs", same name/disposition. No NPC speech → single type="narrator" segment.',
      '- The "options" array is MANDATORY and can NEVER be empty. Always return EXACTLY 4 options.',
      '- If you return empty options or fewer than 4 items, the response will be considered invalid.',
      '- If a hostile NPC is present OR if your narrative this turn introduced hostile NPCs (which you MUST have registered in "npcs" with newlyIntroduced: true), include at least 1 combat option (actionType "attack"). NEVER use as targetId an NPC listed in DEFEATED NPCS — those enemies are out of combat.',
      '- The "feasible" field must be false if the player lacks the required items/conditions.',
      '- For actionType "trait_test", include "skill" or "attribute" in the actionPayload.',
      '- For actionType "attack", include "targetId" and "damageFormula" in the actionPayload.',
      '  damageFormula examples: "str" (punch/unarmed), "str+d4" (knife/dagger), "str+d6" (short sword/club/light axe), "str+d8" (long sword/heavy axe), "str+d10" (great sword/two-handed weapon), "2d6" (pistol), "2d8" (rifle).',
      '- For actionType "heal": include actionPayload: {} (heals the player) or actionPayload: { targetId: "<allied NPC id>" }.',
      '- NPC ATTACKS: hostile NPC attacks this turn → fill "npcAttacks": [{ "npcId", "skillDie": 6|8|10|12 (6=common, 8=trained, 10=champion, 12=elite), "damageFormula" (same formulas above), "ap": 0 }]. No attack → [].',
      '- When narrating downed Extras (isWildCard=false): describe them leaving combat/fleeing/falling with 1 single wound.',
      '- When narrating wounded Wild Cards: accumulate penalties, they keep fighting until 4+ wounds.',
      '- For actionType "travel", include "to" in the actionPayload.',
      '- For actionType "custom", include "input" in the actionPayload with the action description.',
      '- Gained items must have creative names coherent with the setting.',
      '- 🔴 CRITICAL RULE — itemChanges:',
      '  • changeType "gained": ONLY when the MECHANICAL RESULT contains explicit evidence ([item_gained]). Never invent gained items from narrative alone.',
      '  • changeType "lost" or "used": register when (a) the MECHANICAL RESULT has explicit evidence ([item_lost], [item_used], [ammunition_consumed]), OR (b) your narrative THIS TURN explicitly describes the item being dropped, destroyed, confiscated, consumed, or otherwise leaving the player\'s possession. Example: if the narrative says "forçando você a soltá-lo" about an item, register that item with changeType "lost".',
      '  ⚠️ FAILURE TO REGISTER A NARRATIVE ITEM LOSS IS A BUG: if your narrative says an item was lost but you omit the itemChanges entry, the item remains in inventory and future turns will contradict the story.',
      '- Items already in inventory must NOT appear in itemChanges with changeType "gained". Each item appears AT MOST ONCE per response.',
      '- Ranged weapons (bow, crossbow, pistol, rifle, shotgun, etc.) must ALWAYS have their corresponding ammunition as a separate inventory item (arrows, bolts, bullets, cartridges, etc.).',
      '- Ammunition (category "ammunition") should ONLY appear in itemChanges with changeType "used" when the PLAYER\'S ACTION this turn is of type "attack" (shot actually fired). NEVER register ammunition consumption on trait_test, custom, travel, or any other type that is not attack — even if hostile NPCs were introduced in the narrative.',
      '- Every item MUST have the "category" field. Use: weapon (weapons), armor (armor), consumable (consumables like potions/rations), ammunition (ammo), money (money/coins/monetary resources — the "quantity" field represents the exact amount of coins/credits/gold), vehicle (vehicles: car, motorcycle, plane, boat, ship, etc.), property (properties: house, apartment, farm, office, etc.), quest (narrative/quest item), misc (other items).',
      '- Never break immersion. Never mention rules, dice, or mechanics in the narrative text.',
      '- Do not repeat the same narrative. Advance the story each turn.',
      '- Option texts must be at most 1 short sentence each.',
      '- Do not add extra fields beyond those specified above.'
    ]

    // ─── NARRATIVE STYLE (defined here, before the context, for maximum weight) ───
    lines.push('')
    if (narrativeStyle === 'concise') {
      lines.push(
        '━━━ MANDATORY "narrative" LENGTH: CONCISE ━━━',
        'MAXIMUM 3 SHORT sentences. 1 single paragraph.',
        'Sentences must be SHORT and DIRECT — no comma-chained clauses.',
        'Any response with more than 3 sentences violates this instruction.',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
      )
    } else if (narrativeStyle === 'balanced') {
      lines.push(
        '━━━ MANDATORY "narrative" LENGTH: BALANCED ━━━',
        'BETWEEN 4 and 6 sentences distributed in 2 paragraphs.',
        'Paragraph 1: concrete consequence of the action + NPC reaction.',
        'Paragraph 2: hook or tension for the next turn.',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
      )
    } else {
      lines.push(
        '━━━ MANDATORY "narrative" LENGTH (DEFAULT) ━━━',
        'MAXIMUM 3 SHORT sentences. 1 single paragraph.',
        'Sentences must be SHORT and DIRECT — no comma-chained clauses.',
        'Any response with more than 3 sentences violates this instruction.',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
      )
    }

    // ─── SIMPLE VOCABULARY ───
    if (simpleVocabulary === true) {
      lines.push(
        '',
        '━━━ SIMPLE VOCABULARY (ACTIVE) ━━━',
        'Use ONLY simple and common words. Avoid archaic, poetic, or complex terms.',
        'Prefer: "rosto" instead of "semblante"; "antigo" instead of "outrora"; "medo" instead of "pavor visceral".',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
      )
    }

    // ─── RULE: ITEMS IN NARRATIVE ───
    lines.push(
      '',
      '⚠️ ITEMS IN NARRATIVE: Every item mentioned must come from: (1) player INVENTORY, (2) established NPC equipment, or (3) previously described scene object. Missing item → narrate they cannot find it. New item → establish it in THIS turn\'s narrative first. (Narrative text only — does not affect JSON fields.)'
    )

    // ─── RULE: INCAPACITATION NARRATION ───
    lines.push(
      '',
      '🔴 INCAPACITATION: If the character is Incapacitated (wounds >= maxWounds, i.e., 4+ wounds),',
      'the narrative MUST reflect this explicitly: describe the collapse, the darkness, the struggle for consciousness.',
      'Options must be consistent with the condition (e.g.: "Fight for survival", "Lose consciousness", "Call for help").',
      'DO NOT offer normal combat, exploration, or dialogue actions when the character is incapacitated.'
    )

    // Inject universe context (macro lore — fixed throughout the session)
    if (world && (world.description || world.lore)) {
      lines.push(
        '',
        '=== UNIVERSE ===',
        'The sections below are the canonical bible of this universe.',
        `Name: ${world.name ?? 'Unnamed'}`,
        ...(world.description ? [`Description: ${world.description}`] : []),
        ...(world.lore ? ['', world.lore] : [])
      )

      // Narrative voice instruction based on universe lore
      lines.push(
        '',
        '=== NARRATIVE VOICE ===',
        'Use the universe sections above to calibrate vocabulary and tone. Never use generic RPG language ("you advance courageously", "the enemy is defeated") — prefer concrete images from this world.',
        '- Neutral rulebook tone is FORBIDDEN. The narrative must carry the accent of this universe.',
        '- If the universe has an atmosphere of decay, use decay — worn-out words, rust, silences. If it has grandeur, use grandeur — scale, myth, weight.',
        '- The narrative voice must be felt in word choices and metaphors, never declared.'
      )
    }

    // Inject campaign context (thematic and specific story)
    if (campaign && (campaign.thematic || campaign.storyDescription)) {
      lines.push(
        '',
        '=== CAMPAIGN ===',
        `Name: ${campaign.name ?? 'Unnamed'}`,
        `Thematic: ${campaign.thematic ?? ''}`,
        `Story: ${campaign.storyDescription ?? ''}`
      )
    }

    // Inject Savage Worlds rules digest (nearly static — only changes if edges/hindrances change)
    if (rulesDigest) {
      lines.push('', rulesDigest)
    }

    // Player skills (names the LLM must use in diceCheck)
    if (playerSkills && Object.keys(playerSkills).length > 0) {
      lines.push(
        '',
        '=== PLAYER SKILLS (use these exact names in diceCheck.skill) ===',
        ...Object.entries(playerSkills).map(([name, die]) => `- ${name}: ${die}`)
      )
    }

    // Adventure summary so far
    if (summaryText) {
      lines.push('', '=== ADVENTURE SUMMARY ===', summaryText)
    }

    if (mode === 'start') {
      lines.push(
        '',
        '=== SESSION START RULES ===',
        '- You MAY introduce 1 initial NPC coherent with the scene.',
        '- You MAY add x initial items in itemChanges with changeType "gained". be generous.',
        '- Initial items must represent belongings the character already has at the start of the adventure.',
        '- Even at the start, do not invent skills, mechanical ids, or destinations outside the provided setting.'
      )
    } else {
      lines.push(
        '',
        '=== CANONICAL TURN RULES ===',
        '- On a normal turn, use the "npcs" array for NPCs already listed in PRESENT NPCS.',
        '- CRITICAL RULE — NPCS INTRODUCED IN THE NARRATIVE: If your narrative this turn mentions any NPC, agent, creature, or enemy that was NOT in PRESENT NPCS, you MUST register them in "npcs" with newlyIntroduced: true, appropriate disposition, and a short readable "id" (format: npc-<slug>-N, e.g.: "npc-guard-1", "npc-agent-2", "npc-bandit-1"). Use that SAME id in segments and in the actionPayload.targetId of any attack option against that entity. Without this registration, you will have no valid targetId to generate combat options, and the NPC will not appear in subsequent turns.',
        '',
        '- MANDATORY COUNT: If the narrative mentions a specific number of NPCs/creatures/agents ("two agents", "three guards", "a group of five", "a patrol of four"), you MUST create exactly that number of separate entries in the "npcs" array. Each entry needs: unique id (different UUID), differentiated name (e.g.: "UCT Agent #1", "UCT Agent #2"), and the same disposition. When mentioning a group without explicit number ("a group of", "several", "some"), create at least 2-3 entries to represent the multiple threat.',
        '',
        '  CORRECT EXAMPLE:',
        '  Narrative: "Two UCT agents enter the room, checking the tanks with flashlights."',
        '  npcs: [',
        '    { "id": "uct-agent-001", "name": "UCT Agent #1", "disposition": "hostile", "newlyIntroduced": true },',
        '    { "id": "uct-agent-002", "name": "UCT Agent #2", "disposition": "hostile", "newlyIntroduced": true }',
        '  ]',
        '',
        '  INCORRECT EXAMPLE (DO NOT DO THIS):',
        '  Narrative: "Two UCT agents enter the room."',
        '  npcs: [',
        '    { "id": "uct-agent-001", "name": "UCT Agent", "disposition": "hostile", "newlyIntroduced": true }',
        '  ]',
        '',
        '- The "status" field in NPCs is OPTIONAL. Use it ONLY when your narrative THIS turn explicitly indicates that an NPC was incapacitated, knocked out, defeated, or killed WITHOUT going through a formal mechanical attack from the system (if they went through a rule-engine attack/damage, the status is managed automatically). Possible values: "active", "incapacitated" (knocked out/unconscious), "defeated" (defeated), "dead" (dead). Omit the field if the status did not change or if the NPC was hit via the formal attack system.',
        '',
        /*'- On a normal turn, do NOT create itemChanges with changeType "gained" EXCEPT in the situations below:',
        '  (1) Any category EXCEPT "weapon" and "armor", when the narrative this turn justifies it (store purchase, found item, reward, inheritance, conquest).',
        '  (2) A NPC PRESENT IN THE SCENE explicitly gives an item to the player THIS turn (e.g.: passes a key, hands over a document). Use changeType "gained" with the correct item category.',
      */'- On a normal turn, use itemChanges only for "lost", "used", or "gained" (per rules above) for items relevant to this turn\'s action.',
        '- statusChanges "applied": ONLY for non-mechanical narrative effects (environmental poison, narrative burn, a story-driven fear or curse). NEVER register combat engine states via statusChanges — Shaken, Wounded, Fatigued, and all mechanical combat conditions are managed EXCLUSIVELY by the rule engine. If you register them here, they will be discarded.',
        '- statusChanges "removed": ONLY for effects already listed in ACTIVE EFFECTS. Use the exact effectId or name. Do not invent removals for effects that are not listed.',
        '- If the action or narrative establishes safe rest, hospitalization, medical discharge, or the passage of weeks/months, remove in statusChanges the temporary effects that have been healed or expired.',
        '- To remove a temporary status, use changeType "removed" with the exact effectId/name of the active effect. For player status use targetType "player"; for NPC status use targetType "npc" and the affected NPC\'s targetId.',
        '- turnsRemaining represents only short duration in narrative turns. When there is a long time skip, do not rely on turnsRemaining: register explicit removals in statusChanges.',
        '- Do not remove permanent statuses, complications, sequelae, or character conditions without direct narrative evidence of healing or resolution.',
        '- In statusChanges, always indicate targetType. Use targetType "npc" and the targetId of the affected NPC when the effect results from attack, damage, poison, burn, fear, or condition applied to the enemy. Use targetType "player" only for effects on the player character.',
        '- Use only NPC ids already listed in PRESENT NPCS (or the new hostile NPC from this narrative) for actionPayload.targetId.',
        '- If canonical evidence is missing for a state mutation, leave the mutable fields empty/null.',
        '- If any NPC is taken down, do not include them in subsequent turns. Describe them as taken down, fleeing, or falling, but do not keep them as targets of future actions.'
      )
    }

    // Static narration instructions
    lines.push(
      '',
      '=== NARRATION INSTRUCTIONS ===',
      'ACTION RESULT:',
      '  • Success: describe the concrete positive consequence + its immediate impact on the world or present NPCs.',
      '  • Failure: describe what specifically failed + a new complication or risk that emerges from the failure (failure is never neutral — it changes something).',
      '  • Success with Raise: narrate an unexpected extra benefit beyond what was expected.',
      '',
      'NARRATIVE PLAUSIBILITY:',
      '  • MECHANICAL RESULT is binding: success never becomes failure, failure never becomes clean success.',
      '  • On success: preserve the positive consequence; optionally add cost, friction, or dilemma.',
      '  • On failure: preserve the negative consequence; optionally reveal a clue or open a worse path.',
      '  • Use results to seed future plots naturally (social debt, alerted enemy, incomplete clue).',
      '  • JSON FIELDS: register only elements with explicit structured context support — no invented state.',
      '  • NARRATIVE TEXT: freely add atmosphere, sensory details, hints, world flavor — keep OUT of JSON fields.',
    )

    // NPC character participation rules
    lines.push(
      '',
      '=== NPC CHARACTER & PARTICIPATION ===',
      'When a PRESENT NPC has Personality, Motivation, or Speech fields:',
      '  • Use these to shape EVERY reaction, dialogue line, and behavior choice for that NPC.',
      '  • NPCs are CHARACTERS, not statblocks. They have opinions, fear, pride, goals.',
      '  • NPCs may speak (via segments type="npc"), threaten, taunt, plead, negotiate, or react emotionally in ways consistent with their character.',
      '  • Hostile NPCs may take immediate in-scene initiative: draw a weapon, step forward, shout a warning, call for backup — as long as the outcome of the SCENE remains unresolved and the player still chooses their next action from "options".',
      '  • NPCs without personality/motivation fields: use their disposition and context to infer a credible behavioral baseline.',
      '  • CONSISTENCY: if an NPC said or did something in a previous turn, stay true to that characterization. Never flip tone without narrative cause.',
      '  • SPEECH PATTERN matters: a cynical mercenary does not speak like a noble diplomat. Write dialogue that sounds like a real person, not a plot device.',
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
        playerSpeech: sanitizeNullableInlineText(o.playerSpeech),
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
      const status = ['active', 'incapacitated', 'defeated', 'dead'].includes(npc.status as string) 
        ? (npc.status as NPCMention['status']) 
        : undefined
      return {
        id: typeof npc.id === 'string' ? npc.id : randomUUID(),
        name: sanitizeInlineText(npc.name, 'Desconhecido'),
        disposition: (['hostile', 'neutral', 'friendly'].includes(npc.disposition as string) ? npc.disposition : 'neutral') as NPCMention['disposition'],
        newlyIntroduced: typeof npc.newlyIntroduced === 'boolean' ? npc.newlyIntroduced : true,
        ...(status ? { status } : {})
      }
    })

    const npcById = new Map(npcs.map((npc) => [npc.id, npc]))
    const npcsByName = new Map<string, NPCMention[]>()
    for (const npc of npcs) {
      const key = normalizeMentionKey(npc.name)
      npcsByName.set(key, [...(npcsByName.get(key) ?? []), npc])
    }

    const rawSegments = Array.isArray(raw.segments) ? raw.segments : []
    const segments: NarrativeSegment[] = []
    const pushNarratorSegment = (text: string) => {
      const previous = segments[segments.length - 1]
      if (previous?.type === 'narrator') {
        previous.text = `${previous.text}\n\n${text}`
        return
      }

      segments.push({ type: 'narrator', text })
    }

    for (const segment of rawSegments) {
      const source = (segment && typeof segment === 'object' ? segment : {}) as Record<string, unknown>
      const text = sanitizeInlineText(source.text, '')
      if (!text) continue

      if (source.type === 'npc') {
        const rawNpcId = sanitizeNullableInlineText(source.npcId)
        const rawNpcName = sanitizeInlineText(source.npcName, '')
        const nameMatches = rawNpcName ? npcsByName.get(normalizeMentionKey(rawNpcName)) ?? [] : []
        let matchedNpc = rawNpcId ? npcById.get(rawNpcId) : nameMatches.length === 1 ? nameMatches[0] : undefined
        const disposition = (['hostile', 'neutral', 'friendly'].includes(source.disposition as string)
          ? source.disposition
          : matchedNpc?.disposition ?? 'neutral') as NPCMention['disposition']

        // Fix C: se o LLM escreveu fala de NPC mas esqueceu de registrá-lo em npcs[],
        // auto-criar o NPCMention para que syncNarratorNpcs possa populá-lo no GameState.
        if (!matchedNpc && (rawNpcId || rawNpcName)) {
          const autoName = rawNpcName || rawNpcId || 'Desconhecido'
          const autoId = rawNpcId ?? randomUUID()
          matchedNpc = { id: autoId, name: autoName, disposition, newlyIntroduced: true }
          npcs.push(matchedNpc)
          npcById.set(autoId, matchedNpc)
          const nameKey = normalizeMentionKey(autoName)
          npcsByName.set(nameKey, [...(npcsByName.get(nameKey) ?? []), matchedNpc])
          warn('sanitizeNarratorResponse', `NPC ausente em npcs[] auto-criado a partir de segmento: "${autoName}" (${autoId})`)
        }

        // Fix D: se ainda sem match (sem id e sem nome), degradar para narrator
        if (!matchedNpc) {
          pushNarratorSegment(text)
          continue
        }

        segments.push({
          type: 'npc',
          npcId: matchedNpc.id,
          npcName: matchedNpc.name,
          disposition: matchedNpc.disposition,
          text
        })
        continue
      }

      pushNarratorSegment(text)
    }

    if (!segments.length && narrative) {
      pushNarratorSegment(narrative)
    }

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
      const targetType = status.targetType === 'player' || status.targetType === 'npc'
        ? status.targetType
        : undefined
      const targetId = typeof status.targetId === 'string' && status.targetId.trim()
        ? status.targetId.trim()
        : null
      return {
        effectId: typeof status.effectId === 'string' ? status.effectId : randomUUID(),
        name: sanitizeInlineText(status.name, 'Efeito'),
        changeType: (['applied', 'removed'].includes(status.changeType as string) ? status.changeType : 'applied') as StatusChange['changeType'],
        turnsRemaining: typeof status.turnsRemaining === 'number' ? status.turnsRemaining : null,
        description: sanitizeInlineText(status.description, ''),
        ...(targetType ? { targetType } : {}),
        ...(targetType === 'npc' ? { targetId } : {})
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
      // Fix F: descartar ataques de NPC cujo id não existe na cena ou na resposta
      if (!npcById.has(npcId)) {
        warn('sanitizeNarratorResponse', `npcAttacks: npcId desconhecido descartado: "${npcId}"`)
        return []
      }
      return [{ npcId, skillDie, damageFormula, ap: typeof e.ap === 'number' ? e.ap : 0 }]
    })

    // Fix B: opções de ataque com targetId desconhecido → downgrade para custom
    for (const option of options) {
      if (option.actionType !== 'attack') continue
      const targetId = sanitizeInlineText(option.actionPayload?.targetId, '')
      if (targetId && !npcById.has(targetId)) {
        warn('sanitizeNarratorResponse', `Opção de ataque com targetId desconhecido convertida para custom: "${option.text}" (targetId: ${targetId})`)
        option.actionType = 'custom'
        option.actionPayload = { input: option.text }
        if (option.diceCheck) option.diceCheck = { ...option.diceCheck, required: false }
      }
    }

    return {
      narrative,
      segments,
      options,
      npcs,
      itemChanges,
      statusChanges,
      npcAttacks
    }
  }

  private isNarratorResponseStructurallyValid(response: NarratorTurnResponse): { valid: true } | { valid: false; reason: string } {
    if (!response.narrative.trim()) return { valid: false, reason: 'narrative empty' }
    if (response.options.length !== 4) return { valid: false, reason: `options count=${response.options.length}` }

    for (let i = 0; i < response.options.length; i++) {
      const option = response.options[i]
      if (!option.text.trim()) return { valid: false, reason: `option[${i}] text empty` }
      if (!option.diceCheck) return { valid: false, reason: `option[${i}] diceCheck missing` }
      if (!option.diceCheck.reason.trim()) return { valid: false, reason: `option[${i}] diceCheck.reason empty` }

      const payload = option.actionPayload ?? {}
      const payloadSkill = sanitizeSkillName(payload.skill)
      const payloadAttribute = sanitizeNullableInlineText(payload.attribute)
      const diceSkill = sanitizeSkillName(option.diceCheck.skill)
      const diceAttribute = sanitizeNullableInlineText(option.diceCheck.attribute)

      if (option.diceCheck.required && !diceSkill && !diceAttribute && !payloadSkill && !payloadAttribute) {
        return { valid: false, reason: `option[${i}] diceCheck.required=true but no skill/attribute` }
      }

      switch (option.actionType) {
        case 'attack':
          if (!sanitizeInlineText(payload.targetId, '').length) return { valid: false, reason: `option[${i}] attack missing targetId` }
          break
        case 'travel':
          if (!sanitizeInlineText(payload.to, '').length) return { valid: false, reason: `option[${i}] travel missing to` }
          break
        case 'trait_test':
          if (!payloadSkill && !payloadAttribute && !diceSkill && !diceAttribute) return { valid: false, reason: `option[${i}] trait_test missing skill/attribute` }
          break
        case 'custom':
          if (!sanitizeInlineText(payload.input, option.text)) return { valid: false, reason: `option[${i}] custom missing input` }
          break
        case 'flag':
          if (!sanitizeInlineText(payload.key, '')) return { valid: false, reason: `option[${i}] flag missing key` }
          break
      }
    }

    return { valid: true }
  }

  private buildNarratorRetrySystemPrompt(basePrompt: string): string {
    return [
      basePrompt,
      '',
      '=== MANDATORY CORRECTION ===',
      '- The previous response was rejected for being incomplete, truncated, non-canonical, or for violating the agency rule.',
      '- Return complete and self-consistent JSON.',
      '- Do not use entities outside the structured context.',
      '- Do not omit required options, diceCheck, or actionPayload.',
      '- If in doubt about state mutations, leave npcs, itemChanges, and statusChanges empty/null.',
      '- CRITICAL AGENCY CHECK: The "narrative" field must NOT describe what the player does next.',
      '  It must end at the direct consequence of the current action — the player\'s next move is chosen from "options".',
      '  Remove any phrase like "you go to", "you decide to", "you step inside", "now you need to", "it\'s time to".'
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
      narrativeStyle?: 'concise' | 'balanced'
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
        temperature: Math.max(0.10, baseTemperature - 0.05),
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

        const validationResult = this.isNarratorResponseStructurallyValid(sanitized)
        if (!validationResult.valid) {
          lastError = new Error('Resposta narrativa estruturalmente inválida')
          warn('narratorResponse', `Attempt ${index + 1}/${attempts.length}: sanitized response failed structural validation — ${validationResult.reason}`)
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
      'You are the Narrator of a story.',
      'The player typed a free action. Your task is to VALIDATE whether the action is possible in the current context.',
      '',
      'You MUST return ONLY a valid JSON (no markdown, no comments) with this structure:',
      '{',
      '  "feasible": true|false,',
      '  "feasibilityReason": "<reason if not possible, or empty>",',
      '  "actionType": "<inferred type: custom|trait_test|attack|travel>",',
      '  "actionPayload": { <fields to build the mechanical action> },',
      '  "diceCheck": {',
      '    "required": true|false,',
      '    "skill": "<required skill or null>",',
      '    "attribute": "<required attribute or null>",',
      '    "modifier": 0,',
      '    "tn": 4,',
      '    "reason": "<narrative justification>"',
      '  },',
      '  "interpretation": "<brief description of how you interpreted the action>"',
      '}',
      '',
      'VALIDATION RULES:',
      '- If the action is impossible in the context (e.g.: use an item the player does not have, attack an NPC that is not present) → feasible: false.',
      '',
      '- FUNDAMENTAL PRINCIPLE of dice roll:',
      '  Only mark diceCheck.required: true when BOTH conditions are true:',
      '  (1) the outcome is genuinely uncertain in this context, AND',
      '  (2) failure would have interesting narrative consequences.',
      '  If either condition is false → diceCheck.required: false.',
      '',
      '- Actions that NEVER require a roll (automatic for any character):',
      '  • Answer the phone/cell/call',
      '  • Open an unlocked or unobstructed door',
      '  • Sit, lie down, stand up',
      '  • Turn on/off a simple device, press obvious button',
      '  • Wave, gesture, greet with a gesture',
      '  • Jump a clearly low and safe obstacle (curb, step)',
      '  • Talk without intent to persuade',
      '  • Walk along a safe path without threats',
      '  • Rest, breathe, wait',
      '  • Examine an item already in hand / check inventory',
      '',
      '- Actions that REQUIRE a roll:',
      '  • Perceive something hidden → skill: "Percepção"',
      '  • Move stealthily → skill: "Furtividade"',
      '  • Climb, jump across a chasm, run under pressure → skill: "Atletismo"',
      '  • Convince, deceive, bargain → skill: "Persuasão"',
      '  • Intimidate → skill: "Intimidação"',
      '  • Heal wounds → actionType: "heal", actionPayload: {} (do not use trait_test for healing)',
      '  • Pick a lock, disarm a trap → skill: "Ladinagem"',
      '  • Investigate clues → skill: "Pesquisa"',
      '  • Resist poison/disease → attribute: "vigor"',
      '  • Resist fear → attribute: "spirit"',
      '  • Combat → actionType "attack"',
      '',
      '  Contextual note: "open the door" may require Ladinagem if context indicates it is locked;',
      '  "jump" may require Atletismo if it is a real chasm.',
      '',
      '- For combat → actionType: "attack", include targetId and damageFormula in actionPayload.',
      '  damageFormula examples: "str" (punch/unarmed), "str+d4" (knife), "str+d6" (short sword), "str+d8" (long sword), "str+d10" (great sword), "2d6" (pistol), "2d8" (rifle).',
      '  Use the weapon equipped by the character if available in inventory, otherwise use "str" (unarmed).',
      '- For skill tests → actionType: "trait_test", include skill or attribute in actionPayload.',
      '- For movement to a DIFFERENT location from current → actionType: "travel", include "to" in actionPayload with the destination location name.',
      '  NOTE: moving toward an NPC already in the scene (e.g.: "go toward the man", "approach the stranger") is NOT "travel" — use actionType: "custom".',
      '- For simple narrative actions → actionType: "custom".',
      '- Use the PLAYER SKILL names listed in the context.',
      '- The "interpretation" field must be 1 short sentence explaining what the player wants to do.'
    ].join('\n')

    const ctx = req.context
    const inventoryText = ctx.inventory.length
      ? ctx.inventory.map((i) => `${i.name} (x${i.quantity})`).join(', ')
      : 'empty'
    const npcsText = ctx.npcsPresent.length
      ? ctx.npcsPresent.map((n) => {
          const tipo = n.isWildCard ? 'Wild Card' : 'Extra'
          const disp = n.disposition ?? 'neutral'
          const status = n.wounds > 0 ? ` wounded ${n.wounds}/${n.maxWounds}` : ''
          const effects = (n.statusEffects ?? []).length
            ? `, effects: ${(n.statusEffects ?? []).map((effect) => `${effect.name}${effect.turnsRemaining != null ? ` (${effect.turnsRemaining}t)` : ''}`).join(', ')}`
            : ''
          return `${n.name} (${n.id}) [${tipo}, ${disp}, Toughness ${n.toughness}, Parry ${n.parry}${status}${effects}]`
        }).join(', ')
      : 'none'
    const defeatedText = (ctx.defeatedNpcIds ?? []).length
      ? (ctx.defeatedNpcIds ?? []).join(', ')
      : null
    const statusText = ctx.activeStatusEffects.length
      ? ctx.activeStatusEffects.map((s) => `${s.name}${s.turnsRemaining ? ` (${s.turnsRemaining} turns)` : ''}`).join(', ')
      : 'none'
    const skillsText = ctx.playerSkills
      ? Object.entries(ctx.playerSkills).map(([k, v]) => `${k}: ${v}`).join(', ')
      : 'unknown'

    const recentText = req.recentMessages
      .slice(-5)
      .map((m) => m.role === 'narrator' ? `Narrator: ${(m.narrative ?? '').slice(0, 200)}` : `Player: ${m.playerInput ?? ''}`)
      .filter(Boolean)
      .join('\n')

    const prompt = [
      `PLAYER ACTION: "${req.input}"`,
      '',
      '── SCENE CONTEXT ──',
      `Location: ${ctx.location}`,
      `Wounds: ${ctx.wounds} | Fatigue: ${ctx.fatigue} | Shaken: ${ctx.isShaken ? 'yes' : 'no'} | Bennies: ${ctx.bennies}`,
      `Present NPCs: ${npcsText}`,
      defeatedText ? `Defeated NPCs (not active threats): ${defeatedText}` : '',
      `Inventory: ${inventoryText}`,
      `Active effects: ${statusText}`,
      `Player skills: ${skillsText}`,
      ctx.rulesDigest ? `\nRULES:\n${ctx.rulesDigest}` : '',
      ctx.summaryText ? `\nSUMMARY:\n${ctx.summaryText}` : '',
      '',
      '── RECENT MESSAGES ──',
      recentText,
      '',
      'Validate the action and return the JSON.'
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
    if (req.character.edges.length) characterTraits.push(`Edges: ${req.character.edges.join(', ')}`)
    if (req.character.hindrances.length) characterTraits.push(`Hindrances: ${req.character.hindrances.map(h => `${h.name} (${h.severity})`).join(', ')}`)

    const userPrompt = [
      'SESSION START — Narrate the opening of this story.',
      '',
      `CHARACTER: ${req.character.name}`,
      req.character.race ? `Race: ${req.character.race}` : '',
      req.character.gender ? `Gender: ${req.character.gender}` : '',
      req.character.profession ? `Profession: ${req.character.profession}` : '',
      req.character.description ? `Description: ${req.character.description}` : '',
      ...characterTraits,
      '',
      'Create a rich, immersive, and specific opening that places the character at the center of the action.',
      'Describe the opening scene with concrete sensory details — smells, sounds, temperature, vision — that are specific to this universe, not generic.',
      'Present a clear narrative hook: a palpable tension, an immediate problem, or an opportunity that requires a decision right now.',
      'Establish at least 1 specific worldbuilding detail (a place name, a faction, a local custom, a strange object) that the player can explore.',
      'Offer 4 varied action options for the player to start their adventure — each option must feel like a story choice, not a menu button.',
      'For EACH option, evaluate whether it requires a dice roll (diceCheck) according to Savage Worlds rules.',
      '',
      'STARTING ITEMS (MANDATORY):',
      'Return in "itemChanges" 3 to 10 initial items with changeType "gained" that the character already has at the start of the adventure.',
      'Choose items coherent with the profession, race, and world setting. Category examples:',
      '- Main weapon appropriate to the profession (sword, bow, staff, dagger, pistol, rifle, etc.)',
      '- If the weapon is ranged (bow, crossbow, pistol, rifle, shotgun, etc.), MANDATORILY include the corresponding ammunition as a separate item (arrows, bolts, bullets, cartridges, etc.) with quantity appropriate to the context',
      '- Armor or protective clothing if applicable',
      '- Basic travel supplies (rations, canteen, bag)',
      '- 1 to 2 thematic/narrative items that connect the character to the world (family amulet, mysterious letter, old map, diary, etc.)',
      '- MANDATORY starting money: include 1 item with category "money" and the name appropriate to the setting (e.g.: "Gold Coins", "Credits", "Dollars", "Gil", etc.) and "quantity" with the exact numerical amount coherent with the setting and character context.',
      '- For modern/futuristic settings: if the character has a profession or context that justifies it, include a vehicle (category "vehicle": car, motorcycle, ship, etc.) or property (category "property": apartment, base, etc.) as a starting item.',
      'Mention the items naturally within the opening narrative (e.g.: describe the character checking their belongings, or an NPC handing something over).',
      'Use the same itemChanges format already defined in the system prompt. Each item MUST have the "category" field correctly filled.'
    ].filter(Boolean).join('\n')

    try {
      return await this.generateNarratorResponse(userPrompt, this.narrateStartMaxTokens, {
        world: req.world,
        campaign: req.campaign,
        mode: 'start',
        narrativeStyle: 'balanced', // Forçar 'balanced' para garantir abertura rica e imersiva
        simpleVocabulary: req.simpleVocabulary
      })
    } catch (error) {
      logLlmError('narrateStart', error)
      // Fallback mínimo para não bloquear a sessão
      return {
        isFallback: true,
        narrative: `You arrive at a new place. The air carries the weight of untold stories. Around you, the landscape of ${req.campaign.thematic} stretches as far as the eye can see. A path opens before you, and you feel that adventure is about to begin.`,
        options: [
          { id: randomUUID(), text: 'Explore the main path', actionType: 'custom', actionPayload: { input: 'Explore the main path' }, feasible: true, diceCheck: { required: false, reason: 'Safe and accessible path' } },
          { id: randomUUID(), text: 'Observe the surroundings carefully', actionType: 'trait_test', actionPayload: { skill: 'Percepção' }, feasible: true, diceCheck: { required: true, skill: 'Percepção', modifier: 0, tn: 4, reason: 'Detect hidden details in the environment' } },
          { id: randomUUID(), text: 'Look for someone to talk to', actionType: 'custom', actionPayload: { input: 'Look for someone to talk to' }, feasible: true, diceCheck: { required: false, reason: 'Simple social action' } },
          { id: randomUUID(), text: 'Check your belongings and move on', actionType: 'custom', actionPayload: { input: 'Check belongings and move on' }, feasible: true, diceCheck: { required: false, reason: 'Trivial action with no risk' } }
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
      }
      // engineEvents históricos ficam de fora: o texto narrativo já captura o que aconteceu,
      // e incluir JSON mecânico de turnos passados confunde o LLM a recriar npcs/itemChanges já processados.
      // Os eventos do turno ATUAL entram em ── RESULTADO MECÂNICO ── no currentTurnPrompt.
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
      : 'No items'

    const statusList = req.context.activeStatusEffects.length
      ? req.context.activeStatusEffects.map(s => `- ${s.name}${s.turnsRemaining !== undefined ? ` (${s.turnsRemaining} turns)` : ''}`).join('\n')
      : 'No active effects'

    const npcList = req.context.npcsPresent.length
      ? req.context.npcsPresent.map(n => {
          const tipo = n.isWildCard ? 'Wild Card' : 'Extra'
          const disp = n.disposition ?? 'neutral'
          const status = n.wounds > 0 ? ` | wounded ${n.wounds}/${n.maxWounds}` : ''
          const effects = (n.statusEffects ?? []).length
            ? ` | effects: ${(n.statusEffects ?? []).map(effect => `${effect.name}${effect.turnsRemaining !== undefined ? ` (${effect.turnsRemaining} turns)` : ''}`).join(', ')}`
            : ''
          const personality = n.personality ? ` | Personality: ${n.personality}` : ''
          const motivation = n.motivation ? ` | Motivation: ${n.motivation}` : ''
          const speech = n.speechPattern ? ` | Speech: ${n.speechPattern}` : ''
          return `- ${n.name} (${n.id}) [${tipo}, ${disp}, Toughness ${n.toughness}, Parry ${n.parry}${status}${effects}${personality}${motivation}${speech}]`
        }).join('\n')
      : 'No NPCs present'

    const defeatedNpcList = (req.context.defeatedNpcIds ?? []).length
      ? (req.context.defeatedNpcIds ?? []).join(', ')
      : null

    const engineResultText = req.engineEvents.length
      ? formatEngineEventsForPrompt(req.engineEvents)
      : 'No mechanical result'

    const currentTurnPrompt = [
      'GAME TURN — Narrate the consequence of the player\'s action.',
      '',
      '── CURRENT STATE ──',
      `Location: ${req.context.location}`,
      `Wounds: ${req.context.wounds} | Fatigue: ${req.context.fatigue} | Shaken: ${req.context.isShaken ? 'Yes' : 'No'} | Bennies: ${req.context.bennies}`,
      '',
      '── INVENTORY ──',
      inventoryList,
      '',
      '── ACTIVE EFFECTS ──',
      statusList,
      '',
      '── PRESENT NPCS (copy IDs exactly — never modify them or reuse for new NPCs) ──',
      npcList,
      ...(defeatedNpcList ? ['', '── DEFEATED NPCS (already eliminated — DO NOT reference as active threats) ──', defeatedNpcList] : []),
      '',
      '── PLAYER ACTION ──',
      `Type: ${req.playerAction.type}`,
      `Description: ${req.playerAction.description}`,
      '',
      '── MECHANICAL RESULT ──',
      'Use this block as a mandatory anchor: narrate its consequences without contradicting any success, failure, damage, status, or changes described in it.',
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
        narrative: `Your action echoes through the environment. The consequences are not yet clear, but the world around you reacts in subtle ways. What will you do now?`,
        options: [
          { id: randomUUID(), text: 'Investigate the result of the action', actionType: 'custom', actionPayload: { input: 'Investigate what happened' }, feasible: true, diceCheck: { required: true, skill: 'Percepção', modifier: 0, tn: 4, reason: 'Investigation requires attention to detail' } },
          { id: randomUUID(), text: 'Move forward with caution', actionType: 'custom', actionPayload: { input: 'Move forward with caution' }, feasible: true, diceCheck: { required: false, reason: 'Cautious movement with no immediate threat' } },
          { id: randomUUID(), text: 'Observe the surroundings', actionType: 'trait_test', actionPayload: { skill: 'Percepção' }, feasible: true, diceCheck: { required: true, skill: 'Percepção', modifier: 0, tn: 4, reason: 'Detect threats and opportunities' } },
          { id: randomUUID(), text: 'Rest for a moment', actionType: 'custom', actionPayload: { input: 'Rest and recover strength' }, feasible: true, diceCheck: { required: false, reason: 'Simple rest with no danger' } }
        ],
        npcs: [],
        itemChanges: [],
        statusChanges: []
      }
    }
  }
}
