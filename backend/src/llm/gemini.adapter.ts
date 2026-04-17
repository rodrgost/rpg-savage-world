import type {
  ExpandWorldRequest,
  ExpandWorldLoreRequest,
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
  ActionOption,
  NPCMention,
  ItemChange,
  StatusChange,
  DiceCheck,
  ValidateActionRequest,
  ValidateActionResponse
} from '../domain/types/narrative.js'
import { randomUUID } from 'node:crypto'
import { logLlmRequest, logLlmResponse, logLlmError, log, warn, error as logErr } from '../utils/file-logger.js'

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

function readEnv(name: string, fallback = ''): string {
  const value = process.env[name]
  if (typeof value !== 'string') return fallback
  return value.trim().replace(/^"(.*)"$/, '$1')
}

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function withMin(value: number, min: number): number {
  return value < min ? min : value
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

function stripMarkdownFence(text: string): string {
  const trimmed = text.trim()
  const match = trimmed.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i)
  if (!match?.[1]) return trimmed
  return match[1].trim()
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
  const original = stripMarkdownFence(text).replace(/\r\n?/g, '\n').trim()
  if (!original) return text

  let lines = original.split('\n')

  for (let iteration = 0; iteration < 3; iteration += 1) {
    while (lines.length && (!lines[0]?.trim() || isSeparator(lines[0]))) {
      lines = lines.slice(1)
    }

    const { paragraph, rest } = splitFirstParagraph(lines)
    if (!paragraph || !hasMetaCommentary(paragraph)) break
    lines = rest
  }

  const cleaned = lines.join('\n').trim()
  return cleaned || original
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
const CLASS_FALLBACK_POOL = ['Guerreiro', 'Arcanista', 'Patrulheiro', 'Ladino', 'Bardo', 'Clérigo']
const PROFESSION_FALLBACK_POOL = ['Batedor', 'Cartógrafa', 'Mercenário', 'Erudita', 'Mensageiro', 'Caçadora']

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

function diversifySuggestedCharacter(input: SuggestedCharacter): SuggestedCharacter {
  const output: SuggestedCharacter = { ...input }

  if (isDisallowedName(output.name)) {
    output.name = pickRandom(NAME_FALLBACK_POOL, 'Darian')
  }

  const classIsDefault = output.characterClass.localeCompare('Aventureiro', 'pt-BR', { sensitivity: 'base' }) === 0
  const professionIsDefault = output.profession.localeCompare('Mercenário', 'pt-BR', { sensitivity: 'base' }) === 0

  if (classIsDefault) {
    output.characterClass = pickRandom(CLASS_FALLBACK_POOL, 'Guerreiro')
  }

  if (professionIsDefault || output.profession.localeCompare(output.characterClass, 'pt-BR', { sensitivity: 'base' }) === 0) {
    const alternatives = PROFESSION_FALLBACK_POOL.filter(
      (item) => item.localeCompare(output.characterClass, 'pt-BR', { sensitivity: 'base' }) !== 0
    )
    output.profession = pickRandom(alternatives, 'Mercenário')
  }

  if (!output.description.trim()) {
    output.description = `${output.name} é ${output.profession.toLowerCase()} de perfil ${output.characterClass.toLowerCase()}, em busca de um lugar no conflito central do mundo.`
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

function parseJsonObject(text: string): Record<string, unknown> | null {
  const raw = stripMarkdownFence(text)

  const tryParse = (input: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(input)
      if (Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object' && !Array.isArray(parsed[0])) {
        return parsed[0] as Record<string, unknown>
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      return null
    }
    return null
  }

  const direct = tryParse(raw)
  if (direct) return direct

  const start = raw.indexOf('{')
  if (start >= 0) {
    const end = raw.lastIndexOf('}')
    if (end > start) {
      const fragment = tryParse(raw.slice(start, end + 1))
      if (fragment) return fragment
    }

    // Truncated JSON: try repairing by closing all open brackets/braces
    const repaired = repairTruncatedJson(raw.slice(start))
    if (repaired) {
      const parsed = tryParse(repaired)
      if (parsed) return parsed
    }
  }

  // Last resort: extract "key": "value" pairs via regex
  const kvPattern = /"(\w+)"\s*:\s*"([^"]*)"/g
  let match: RegExpExecArray | null
  const record: Record<string, unknown> = {}
  while ((match = kvPattern.exec(raw)) !== null) {
    record[match[1]] = match[2]
  }
  if (Object.keys(record).length > 0) return record

  return null
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

  const suggested: SuggestedCharacter = {
    name: sanitizeCharacterField(nameValue, 'Aventureiro'),
    gender: sanitizeCharacterField(genderValue, ''),
    race: sanitizeCharacterField(raceValue, 'Humano'),
    characterClass: sanitizeCharacterField(classValue, 'Aventureiro'),
    profession: sanitizeCharacterField(professionValue, 'Mercenário'),
    description: sanitizeCharacterField(descriptionValue, '')
  }

  if (suggested.characterClass.localeCompare(suggested.profession, 'pt-BR', { sensitivity: 'base' }) === 0) {
    suggested.profession = 'Mercenário'
  }

  return suggested
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
        /(\s+)?(?:nome|name|sexo|gender|ra[cç]a|race|esp[eé]cie|classe|class|arqu[eê]tipo|profiss[aã]o|profession|occupation|of[ií]cio|descri[cç][aã]o|description|bio|background)\s*[:=\-].*$/i,
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

  const name = findInLines(namePatterns) ?? extractFromText(flattened, namePatterns)
  const gender = findInLines(genderPatterns) ?? extractFromText(flattened, genderPatterns)
  const race = findInLines(racePatterns) ?? extractFromText(flattened, racePatterns)
  const characterClass = findInLines(classPatterns) ?? extractFromText(flattened, classPatterns)
  const profession = findInLines(professionPatterns) ?? extractFromText(flattened, professionPatterns)
  const description = findInLines(descriptionPatterns) ?? extractFromText(flattened, descriptionPatterns)

  if (!name && !characterClass && !profession && !description) return null

  return {
    ...(name ? { name } : {}),
    ...(gender ? { gender } : {}),
    ...(race ? { race } : {}),
    ...(characterClass ? { characterClass } : {}),
    ...(profession ? { profession } : {}),
    ...(description ? { description } : {})
  }
}

export class GeminiAdapter implements Narrator {
  private readonly apiKey = readEnv('GEMINI_API_KEY')
  private readonly model = readEnv('GEMINI_MODEL', 'gemini-2.5-flash')
  private readonly baseUrl = readEnv('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com')
  private readonly temperature = toNumber(readEnv('GEMINI_TEMPERATURE', '0.4'), 0.4)
  private readonly maxOutputTokens = withMin(toNumber(readEnv('GEMINI_MAX_OUTPUT_TOKENS', '8192'), 8192), 8192)
  private readonly worldMaxOutputTokens = withMin(
    toNumber(readEnv('GEMINI_WORLD_MAX_OUTPUT_TOKENS', '16384'), 16384),
    1024
  )
  private readonly narrateStartMaxTokens = withMin(
    toNumber(readEnv('GEMINI_NARRATE_START_MAX_TOKENS', '8192'), 8192),
    2048
  )
  private readonly narrateTurnMaxTokens = withMin(
    toNumber(readEnv('GEMINI_NARRATE_TURN_MAX_TOKENS', '8192'), 8192),
    2048
  )
  private readonly timeoutMs = withMin(toNumber(readEnv('GEMINI_TIMEOUT_MS', '90000'), 90000), 15000)
  private readonly narratorTimeoutMs = withMin(toNumber(readEnv('GEMINI_NARRATOR_TIMEOUT_MS', '120000'), 120000), 30000)
  private readonly characterSuggestionTemperature = toNumber(
    readEnv('GEMINI_CHARACTER_SUGGEST_TEMPERATURE', '1.0'),
    1.0
  )

  private generateTextCallId = 0

  /**
   * Chamada genérica ao Gemini generateContent.
   * @param promptOrContents - string (single-turn) ou ContentEntry[] (multi-turn)
   * @param options - opções de geração
   * @param attempt - número da tentativa (1 = primeira, 2 = retry, etc.)
   */
  private async generateText(
    promptOrContents: string | ContentEntry[],
    options: GenerateTextOptions = {},
    attempt: number = 1
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY não configurada')
    }

    const callTag = `call-${++this.generateTextCallId}${attempt > 1 ? `/tentativa-${attempt}` : ''}`
    log('gemini', `Iniciando ${callTag} (tentativa ${attempt})`)
    const url = `${this.baseUrl}/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`
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

    const logPrompt = isMultiTurn
      ? `[multi-turn ${promptOrContents.length} msgs] last: ${promptOrContents[promptOrContents.length - 1]?.text.slice(0, 200)}`
      : promptOrContents

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
        const err = new Error(`Gemini HTTP ${response.status}: ${raw.slice(0, 200)}`)
        logLlmError(callTag, err)
        throw err
      }

      const parsed = raw ? (JSON.parse(raw) as GeminiGenerateContentResponse) : {}
      const text = extractText(parsed)
      if (!text) {
        const err = new Error('Gemini retornou conteúdo vazio')
        logLlmError(callTag, err)
        throw err
      }

      const durationMs = Date.now() - startMs
      const usage = parsed.usageMetadata
      logLlmResponse(callTag, {
        rawLength: text.length,
        responseText: text,
        durationMs,
        finishReason: parsed.candidates?.[0]?.finishReason,
        promptTokens: usage?.promptTokenCount,
        outputTokens: usage?.candidatesTokenCount
      })

      return text
    } catch (err) {
      logLlmError(callTag, err)
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  async summarize(req: SummarizeRequest): Promise<string> {
    const p = req.currentState.player

    const sysPrompt = [
      'Você é um narrador de RPG Savage Worlds. Gere um resumo objetivo em português do Brasil.',
      'Regras: não invente mudanças mecânicas, apenas descreva fatos e consequências narrativas.',
      'Saída: entregue apenas o resumo final, sem comentários sobre o pedido, sem prefácio, sem saudação e sem separadores como ***.'
    ].join('\n')

    const prompt = [
      `Turno atual: ${req.upToTurn}.`,
      `Resumo anterior: ${req.previousSummary || 'sem resumo anterior'}.`,
      `Local atual: ${req.currentState.worldState.activeLocation}.`,
      `Ferimentos: ${p.wounds}/${p.maxWounds}. Fadiga: ${p.fatigue}. Abalado: ${p.isShaken ? 'sim' : 'não'}. Bennies: ${p.bennies}.`,
      `Eventos novos (JSON): ${JSON.stringify(req.keyEvents)}.`
    ].join('\n')

    try {
      const generated = await this.generateText(prompt, { systemInstruction: sysPrompt })
      return sanitizeNarrativeOutput(generated)
    } catch {
      return [
        `Resumo até o turno ${req.upToTurn}.`,
        `Eventos desde o último resumo: ${req.keyEvents.length}.`,
        `Local atual: ${req.currentState.worldState.activeLocation}.`,
        `Ferimentos: ${p.wounds}/${p.maxWounds}. Bennies: ${p.bennies}.`
      ].join('\n')
    }
  }

  async summarizeHistory(req: SummarizeHistoryRequest): Promise<string> {
    const sysPrompt = [
      'Você é um narrador de RPG. Resuma a história da aventura em português do Brasil.',
      'Regras:',
      '- Mantenha os fatos, decisões do jogador, consequências narrativas e NPCs encontrados.',
      '- Preserve nomes de personagens, locais e itens importantes.',
      '- Se houver um resumo anterior, integre-o ao novo resumo de forma coesa.',
      '- O resumo deve ter no máximo 4-6 parágrafos curtos.',
      '- Apenas texto narrativo objetivo. Sem comentários, sem prefácio, sem saudação.',
      '- Escreva em terceira pessoa.'
    ].join('\n')

    const messagesText = req.messages
      .map((m) => `[Turno ${m.turn}] ${m.role === 'narrator' ? 'Narrador' : 'Jogador'}: ${m.text}`)
      .join('\n')

    const prompt = [
      req.previousSummary ? `RESUMO ANTERIOR:\n${req.previousSummary}\n` : '',
      'MENSAGENS PARA RESUMIR:',
      messagesText,
      '',
      `Local atual: ${req.currentLocation}.`,
      '',
      'Gere um resumo coeso que integre o resumo anterior (se houver) com as novas mensagens.'
    ].filter(Boolean).join('\n')

    try {
      const generated = await this.generateText(prompt, {
        systemInstruction: sysPrompt,
        maxOutputTokens: 1024,
        temperature: 0.3
      })
      return sanitizeNarrativeOutput(generated)
    } catch (error) {
      logErr('summarizeHistory', 'Error:', error)
      return req.previousSummary
        ? `${req.previousSummary}\n\n(Novas interações ocorreram mas não puderam ser resumidas.)`
        : '(O resumo das interações não pôde ser gerado.)'
    }
  }

  async expandWorld(req: ExpandWorldRequest): Promise<string> {
    const sysPrompt = [
      'Você é um worldbuilder de RPG. Escreva em português do Brasil.',
      'Objetivo: expandir a história de um mundo de campanha com texto criativo e prático para jogo.',
      'Saída esperada: 3-6 parágrafos curtos com contexto, conflitos, facções, locais e 2-4 ganchos de aventura.',
      'Restrições de saída: entregue apenas o conteúdo do mundo; não inclua comentários sobre o pedido, elogios, prefácio, saudação, explicações do processo ou separadores como ***.',
      'Comece diretamente no conteúdo narrativo do mundo.'
    ].join('\n')

    const prompt = [
      `Nome da campanha: ${req.campaignName}.`,
      `Temática do mundo: ${req.thematic}.`,
      `Descrição atual (se existir): ${req.currentDescription?.trim() || 'nenhuma'}.`,
      'Mantenha consistência com a temática e evolua a história sem repetir literalmente a descrição atual.'
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
      throw new Error(`Falha ao gerar história com Gemini: ${message}`)
    }
  }

  /** Alias — usado para expandir a história de uma Adventure */
  async expandAdventureStory(req: ExpandWorldRequest): Promise<string> {
    return this.expandWorld(req)
  }

  async expandWorldLore(req: ExpandWorldLoreRequest): Promise<string> {
    const sysPrompt = [
      'Você é um worldbuilder de RPG. Escreva em português do Brasil.',
      'Objetivo: criar ou expandir o lore (a mitologia, a história profunda) de um universo de jogo.',
      'Saída esperada: 4-8 parágrafos descrevendo a cosmologia, história, facções, conflitos centrais, geografia e ambientação geral do universo.',
      'Restrições de saída: entregue apenas o conteúdo do lore; não inclua comentários sobre o pedido, elogios, prefácio, saudação, explicações do processo ou separadores como ***.',
      'Comece diretamente no conteúdo do lore.'
    ].join('\n')

    const prompt = [
      `Nome do universo: ${req.name}.`,
      `Descrição resumida: ${req.description || 'nenhuma'}.`,
      `Lore atual (se existir): ${req.currentLore?.trim() || 'nenhum'}.`,
      'Crie ou expanda o lore do universo com riqueza de detalhes, mantendo consistência com o que já existe.',
      'Inclua: origens do mundo, eras importantes, facções ou povos relevantes, fontes de poder/magia, conflitos centrais e o estado atual do universo.'
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
      throw new Error(`Falha ao gerar lore com Gemini: ${message}`)
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
    }

    const sysPrompt = [
      'Você é um designer de personagens para RPG.',
      'Com base na história de um mundo, sugira um personagem plausível para iniciar uma campanha.',
      'Evite nomes muito usados/clichês e NÃO use os nomes: Kael, Khael, Kaell, Cael.',
      'Procure variar classe e profissão entre chamadas diferentes.',
      'Responda SOMENTE em JSON válido, sem markdown e sem comentários.',
      'Formato obrigatório do JSON (TODOS os 6 campos são OBRIGATÓRIOS e não podem ser vazios):',
      '{',
      '  "name": "<nome criativo em português>",',
      '  "gender": "<Masculino, Feminino ou Outro>",',
      '  "race": "<raça/espécie coerente com a temática>",',
      '  "characterClass": "<classe do personagem>",',
      '  "profession": "<profissão ou ofício>",',
      '  "description": "<OBRIGATÓRIO: 1 ou 2 frases descrevendo aparência, motivação e papel do personagem no contexto do mundo>"',
      '}',
      'IMPORTANTE: o campo "description" é OBRIGATÓRIO e deve conter 1-2 frases descritivas. Nunca retorne description vazio.',
      'Cada campo deve ter no máximo 100 caracteres, exceto description que pode ter até 200 caracteres.',
      'Todos os campos devem ser strings curtas em português do Brasil.'
    ].join('\n')

    const prompt = [
      ...(existingLines.length > 0 ? [...existingLines, ''] : []),
      ...(req.worldLore ? [`Lore do universo: ${req.worldLore}.`, ''] : []),
      `Temática da aventura: ${req.thematic || 'não informada'}.`,
      `História da aventura: ${req.storyDescription || 'não informada'}.`
    ].join('\n')

    try {
      const generated = await this.generateText(prompt, {
        maxOutputTokens: 1024,
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

        if (
          firstTry.name !== 'Aventureiro' ||
          firstTry.characterClass !== 'Aventureiro' ||
          firstTry.profession !== 'Mercenário'
        ) {
          return diversifySuggestedCharacter(firstTry)
        }
      }

      const retrySysPrompt = [
        'Retorne exatamente 6 linhas em português do Brasil, sem texto adicional:',
        'NOME: <nome criativo>',
        'SEXO: <Masculino, Feminino ou Outro>',
        'RACA: <raça ou espécie>',
        'CLASSE: <classe do personagem>',
        'PROFISSAO: <profissão ou ofício>',
        'DESCRICAO: <OBRIGATÓRIO: 1-2 frases descrevendo aparência, motivação e papel do personagem>',
        'IMPORTANTE: a linha DESCRICAO é obrigatória e NÃO pode ficar vazia.',
        'NÃO use os nomes Kael, Khael, Kaell, Cael.'
      ].join('\n')

      const retryPrompt = [
        `Temática: ${req.thematic || 'não informada'}.`,
        `História: ${req.storyDescription || 'não informada'}.`
      ].join('\n')

      log('suggestCharacterFromWorld', 'Primeira tentativa insuficiente, fazendo retry...')
      const retryGenerated = await this.generateText(retryPrompt, {
        maxOutputTokens: 512,
        timeoutMs: this.timeoutMs,
        temperature: 0.8,
        systemInstruction: retrySysPrompt
      }, 2)

      const retryParsed = parseCharacterFromLooseText(retryGenerated)
      if (!retryParsed) throw new Error('Resposta não veio em formato legível')

      return diversifySuggestedCharacter(buildSuggestedCharacterFromRecord(retryParsed))
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido'
      throw new Error(`Falha ao sugerir personagem com Gemini: ${message}`)
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
  } = {}): string {
    const { world, campaign, rulesDigest, summaryText, playerSkills } = opts
    const lines = [
      'Você é o Narrador Mestre de um RPG de mesa Savage Worlds, contando a história em português do Brasil.',
      'Você narra de forma imersiva em segunda pessoa ("Você entra na taverna...").',
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
      '      "requiredItems": ["<itemId se necessário>"],',
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
      '    { "itemId": "<uuid>", "name": "<nome do item>", "quantity": 1, "changeType": "gained|lost|used" }',
      '  ],',
      '  "statusChanges": [',
      '    { "effectId": "<uuid>", "name": "<nome do efeito>", "changeType": "applied|removed", "turnsRemaining": 3, "description": "<desc>" }',
      '  ],',
      '  "locationChange": "<nova localização ou null>",',
      '  "chapterTitle": "<título do capítulo se mudou ou null>"',
      '}',
      '',
      'REGRAS DO CAMPO diceCheck (OBRIGATÓRIO em TODA opção):',
      '- Avalie para CADA opção se a ação exige um teste de dados com base nas regras de Savage Worlds.',
      '- Se a opção envolve risco, perigo, esforço físico ou mental significativo → "required": true.',
      '  Exemplos que EXIGEM teste:',
      '  • Perceber algo oculto ou sutil → skill: "Percepção"',
      '  • Mover-se sem ser detectado → skill: "Furtividade"',
      '  • Escalar, saltar, correr sob pressão → skill: "Atletismo"',
      '  • Convencer, barganhar, mentir → skill: "Persuasão"',
      '  • Intimidar alguém → skill: "Intimidação"',
      '  • Curar ferimentos → skill: "Medicina"',
      '  • Abrir fechaduras, desarmar armadilhas → skill: "Ladinagem"',
      '  • Investigar pistas, pesquisar → skill: "Pesquisa"',
      '  • Conhecimento arcano → skill: "Ocultismo"',
      '  • Resistir a veneno, doença, fadiga → attribute: "vigor"',
      '  • Resistir a medo, tentação → attribute: "spirit"',
      '  • Combate corpo a corpo → skill: "Luta" (use actionType "attack")',
      '  • Combate à distância → skill: "Tiro" (use actionType "attack")',
      '- Se a ação é segura, trivial ou puramente narrativa → "required": false, reason: "Ação simples sem risco".',
      '  Exemplos que NÃO exigem teste: conversar casualmente, caminhar por um caminho seguro, descansar, examinar um item no inventário.',
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
      '- Para actionType "attack", inclua "targetId" no actionPayload.',
      '- Para actionType "travel", inclua "to" no actionPayload.',
      '- Para actionType "custom", inclua "input" no actionPayload com a descrição da ação.',
      '- Itens ganhos devem ter nomes criativos e coerentes com a ambientação.',
      '- NUNCA repita itemChanges de itens que já estão no inventário do jogador. Se o jogador já possui um item, NÃO o inclua novamente em itemChanges com changeType "gained". Consulte a seção INVENTÁRIO no contexto do turno.',
      '- Cada item deve aparecer NO MÁXIMO UMA VEZ no array itemChanges de uma mesma resposta.',
      '- Nunca quebre a imersão. Nunca mencione regras, dados ou mecânicas no texto narrativo.',
      '- Não repita a mesma narrativa. Evolua a história a cada turno.',
      '- IMPORTANTE: Mantenha o JSON compacto. A narrativa deve ter no máximo 2-3 parágrafos curtos.',
      '- Textos de opções devem ter no máximo 1 frase curta cada.',
      '- Não adicione campos extras além dos especificados acima.',
      '',
      'CHECKLIST FINAL antes de enviar a resposta:',
      '1. O campo "narrative" tem 2-3 parágrafos? ✓',
      '2. O campo "options" tem EXATAMENTE 4 objetos? ✓',
      '3. Cada opção tem id, text, actionType, actionPayload, feasible e diceCheck? ✓'
    ]

    // Injetar contexto do universo (lore macro — fixo durante toda a sessão)
    if (world && (world.description || world.lore)) {
      lines.push(
        '',
        '=== UNIVERSO ===',
        `Nome: ${world.name ?? 'Sem nome'}`,
        `Descrição: ${world.description ?? ''}`,
        ...(world.lore ? [`Lore: ${world.lore}`] : [])
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

    // Instruções estáticas de narração que antes iam no user prompt
    lines.push(
      '',
      '=== INSTRUÇÕES DE NARRAÇÃO ===',
      'Narre a consequência da ação do jogador de forma imersiva.',
      'Se houve sucesso mecânico, descreva uma consequência positiva.',
      'Se houve falha, descreva a dificuldade mas mantenha o progresso narrativo.',
      'Ofereça 4 novas opções de ação variadas.',
      'Para CADA opção, avalie se exige teste de dados (diceCheck) com base na situação e nas regras de Savage Worlds.',
      'Use os nomes de perícias EXATAMENTE como listados em PERÍCIAS DO JOGADOR.',
      'Avalie se cada opção é viável considerando o inventário e estado do jogador.',
      'Inclua mudanças de itens ou status se fizer sentido narrativo.',
      'Se um NPC foi mencionado ou apareceu, inclua-o em "npcs".',
      'Evolua a história — não repita cenários anteriores.',
      'IMPORTANTE: Seja direto e conciso na narrativa. Máximo 2-3 parágrafos curtos.'
    )

    return lines.join('\n')
  }

  private sanitizeNarratorResponse(raw: Record<string, unknown>): NarratorTurnResponse {
    const narrative = typeof raw.narrative === 'string' ? sanitizeNarrativeOutput(raw.narrative) : 'A história continua...'

    // Parse options
    const rawOptions = Array.isArray(raw.options) ? raw.options : []
    const options: ActionOption[] = rawOptions.slice(0, 4).map((opt: unknown, i: number) => {
      const o = (opt && typeof opt === 'object' ? opt : {}) as Record<string, unknown>

      // Parse diceCheck
      let diceCheck: DiceCheck | null = null
      if (o.diceCheck && typeof o.diceCheck === 'object' && !Array.isArray(o.diceCheck)) {
        const dc = o.diceCheck as Record<string, unknown>
        diceCheck = {
          required: typeof dc.required === 'boolean' ? dc.required : false,
          skill: typeof dc.skill === 'string' && dc.skill.trim() ? dc.skill.trim() : null,
          attribute: typeof dc.attribute === 'string' && dc.attribute.trim() ? dc.attribute.trim() : null,
          modifier: typeof dc.modifier === 'number' ? dc.modifier : 0,
          tn: typeof dc.tn === 'number' ? dc.tn : 4,
          reason: typeof dc.reason === 'string' ? dc.reason : ''
        }
      }

      return {
        id: typeof o.id === 'string' ? o.id : randomUUID(),
        text: typeof o.text === 'string' ? o.text : `Opção ${i + 1}`,
        actionType: typeof o.actionType === 'string' ? o.actionType as ActionOption['actionType'] : 'custom',
        actionPayload: (o.actionPayload && typeof o.actionPayload === 'object' ? o.actionPayload : { input: typeof o.text === 'string' ? o.text : '' }) as Record<string, unknown>,
        requiredItems: Array.isArray(o.requiredItems) ? o.requiredItems.filter((r: unknown) => typeof r === 'string') as string[] : [],
        feasible: typeof o.feasible === 'boolean' ? o.feasible : true,
        feasibilityReason: typeof o.feasibilityReason === 'string' ? o.feasibilityReason : null,
        diceCheck
      }
    })

    // Pad to exactly 4 options if needed — generate contextual fallbacks
    const fallbackOptions = [
      { text: 'Observar os arredores com atenção', actionType: 'trait_test' as const, actionPayload: { skill: 'Percepção' }, diceCheck: { required: true, skill: 'Percepção', reason: 'Perceber detalhes ocultos' } },
      { text: 'Investigar a área em busca de pistas', actionType: 'trait_test' as const, actionPayload: { skill: 'Pesquisa' }, diceCheck: { required: true, skill: 'Pesquisa', reason: 'Investigar requer análise cuidadosa' } },
      { text: 'Tentar conversar com alguém próximo', actionType: 'custom' as const, actionPayload: { input: 'Abordar alguém para conversar' }, diceCheck: { required: false, reason: 'Interação social simples' } },
      { text: 'Seguir adiante com cautela', actionType: 'custom' as const, actionPayload: { input: 'Seguir adiante com cautela' }, diceCheck: { required: false, reason: 'Movimento cauteloso sem ameaça imediata' } }
    ]
    let fallbackIdx = 0
    while (options.length < 4) {
      const fb = fallbackOptions[fallbackIdx % fallbackOptions.length]
      options.push({
        id: randomUUID(),
        text: fb.text,
        actionType: fb.actionType,
        actionPayload: fb.actionPayload,
        feasible: true,
        diceCheck: fb.diceCheck
      })
      fallbackIdx++
    }

    // Parse NPCs
    const rawNpcs = Array.isArray(raw.npcs) ? raw.npcs : []
    const npcs: NPCMention[] = rawNpcs.map((n: unknown) => {
      const npc = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>
      return {
        id: typeof npc.id === 'string' ? npc.id : randomUUID(),
        name: typeof npc.name === 'string' ? npc.name : 'Desconhecido',
        disposition: (['hostile', 'neutral', 'friendly'].includes(npc.disposition as string) ? npc.disposition : 'neutral') as NPCMention['disposition'],
        newlyIntroduced: typeof npc.newlyIntroduced === 'boolean' ? npc.newlyIntroduced : true
      }
    })

    // Parse item changes
    const rawItems = Array.isArray(raw.itemChanges) ? raw.itemChanges : []
    const parsedItems: ItemChange[] = rawItems.map((it: unknown) => {
      const item = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
      return {
        itemId: typeof item.itemId === 'string' ? item.itemId : randomUUID(),
        name: typeof item.name === 'string' ? item.name : 'Item',
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        changeType: (['gained', 'lost', 'used'].includes(item.changeType as string) ? item.changeType : 'gained') as ItemChange['changeType']
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
        name: typeof status.name === 'string' ? status.name : 'Efeito',
        changeType: (['applied', 'removed'].includes(status.changeType as string) ? status.changeType : 'applied') as StatusChange['changeType'],
        turnsRemaining: typeof status.turnsRemaining === 'number' ? status.turnsRemaining : null,
        description: typeof status.description === 'string' ? status.description : ''
      }
    })

    return {
      narrative,
      options,
      npcs,
      itemChanges,
      statusChanges,
      locationChange: typeof raw.locationChange === 'string' ? raw.locationChange : null,
      chapterTitle: typeof raw.chapterTitle === 'string' ? raw.chapterTitle : null
    }
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
    } = {}
  ): Promise<NarratorTurnResponse> {
    const systemPrompt = this.buildNarratorSystemPrompt(systemPromptOpts)

    const effectiveMaxTokens = maxTokens ?? this.worldMaxOutputTokens

    const generated = await this.generateText(promptOrContents, {
      maxOutputTokens: effectiveMaxTokens,
      timeoutMs: this.narratorTimeoutMs,
      responseMimeType: 'application/json',
      temperature: this.temperature,
      systemInstruction: systemPrompt
    })
    log('narratorResponse', `LLM raw length: ${generated.length} maxTokens: ${effectiveMaxTokens}`)

    const parsed = parseJsonObject(generated)
    if (parsed) {
      log('narratorResponse', `Parse OK — options: ${(parsed.options as unknown[])?.length ?? 0}`)
      return this.sanitizeNarratorResponse(parsed)
    }

    // Parse falhou completamente — usar texto bruto como narrativa
    warn('narratorResponse', 'JSON parse failed, using raw text as narrative fallback')
    return this.sanitizeNarratorResponse({ narrative: sanitizeNarrativeOutput(generated) })
  }

  // ─── Validação de ação custom ───────────────────────────────────────────────

  async validateAction(req: ValidateActionRequest): Promise<ValidateActionResponse> {
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
      '- Se a ação é trivial/narrativa (conversar, andar, olhar ao redor) → feasible: true, diceCheck.required: false.',
      '- Se a ação envolve risco ou desafio → feasible: true, diceCheck.required: true, com a perícia/atributo corretos.',
      '- Para combate → actionType: "attack", inclua targetId no actionPayload.',
      '- Para testes de habilidade → actionType: "trait_test", inclua skill ou attribute no actionPayload.',
      '- Para deslocamento → actionType: "travel", inclua "to" no actionPayload.',
      '- Para ações narrativas simples → actionType: "custom".',
      '- Use os nomes das PERÍCIAS DO JOGADOR listadas no contexto.',
      '- O campo "interpretation" deve ser 1 frase curta explicando o que o jogador quer fazer.'
    ].join('\n')

    const ctx = req.context
    const inventoryText = ctx.inventory.length
      ? ctx.inventory.map((i) => `${i.name} (x${i.quantity})`).join(', ')
      : 'vazio'
    const npcsText = ctx.npcsPresent.length
      ? ctx.npcsPresent.map((n) => `${n.name} (${n.id})`).join(', ')
      : 'nenhum'
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
      const generated = await this.generateText(prompt, {
        systemInstruction: sysPrompt,
        maxOutputTokens: 1024,
        temperature: 0.2
      })

      const parsed = parseJsonObject(generated)
      if (parsed) {
        const diceCheckRaw = parsed.diceCheck as Record<string, unknown> | undefined
        const diceCheck: DiceCheck | null = diceCheckRaw
          ? {
              required: Boolean(diceCheckRaw.required),
              skill: (diceCheckRaw.skill as string) || null,
              attribute: (diceCheckRaw.attribute as string) || null,
              modifier: Number(diceCheckRaw.modifier) || 0,
              tn: Number(diceCheckRaw.tn) || 4,
              reason: String(diceCheckRaw.reason ?? '')
            }
          : null

        return {
          feasible: parsed.feasible !== false,
          feasibilityReason: String(parsed.feasibilityReason ?? ''),
          diceCheck,
          actionType: (parsed.actionType as ValidateActionResponse['actionType']) ?? 'custom',
          actionPayload: (parsed.actionPayload as Record<string, unknown>) ?? {},
          interpretation: String(parsed.interpretation ?? req.input)
        }
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
      'Crie uma abertura imersiva e envolvente que introduza o personagem neste mundo.',
      'Descreva a cena inicial, o ambiente, e apresente um gancho narrativo que motive a ação.',
      'Inclua pelo menos 1 NPC na cena (pode ser um mercador, guarda, viajante, etc.).',
      'Ofereça 4 opções variadas de ação para o jogador começar sua aventura.',
      'Para CADA opção, avalie se ela exige um teste de dados (diceCheck) conforme as regras de Savage Worlds.',
      '',
      'ITENS INICIAIS (OBRIGATÓRIO):',
      'Retorne em "itemChanges" de 3 a 6 itens iniciais com changeType "gained" que o personagem já possui ao começar a aventura.',
      'Escolha itens coerentes com a classe, profissão, raça e ambientação do mundo. Exemplos de categorias:',
      '- Arma principal adequada à classe/profissão (espada, arco, cajado, adaga, etc.)',
      '- Armadura ou vestimenta de proteção se aplicável',
      '- Provisões básicas de viagem (ração, cantil, bolsa)',
      '- 1 a 2 itens temáticos/narrativos que conectem o personagem ao mundo (amuleto de família, carta misteriosa, mapa antigo, diário, etc.)',
      '- Moedas ou recursos iniciais',
      'Mencione os itens naturalmente dentro da narrativa de abertura (ex: descreva o personagem conferindo seus pertences, ou um NPC entregando algo).',
      'Use o mesmo formato itemChanges já definido no system prompt. Cada item deve ter um nome criativo e coerente com a ambientação.'
    ].filter(Boolean).join('\n')

    try {
      return await this.generateNarratorResponse(userPrompt, this.narrateStartMaxTokens, { world: req.world, campaign: req.campaign })
    } catch (error) {
      logErr('narrateStart', 'Error:', error)
      // Fallback mínimo para não bloquear a sessão
      return {
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
    // Filtrar apenas mensagens de player e narrator (system messages não entram como turns)
    const contents: ContentEntry[] = []

    for (const msg of req.recentMessages) {
      if (msg.role === 'narrator' && msg.narrative) {
        contents.push({ role: 'model', text: msg.narrative })
      } else if (msg.role === 'player' && msg.playerInput) {
        contents.push({ role: 'user', text: msg.playerInput })
      }
      // skip system messages (summaries, dice events)
    }

    // Garantir que contents comece com user (requisito da API Gemini)
    // Se a primeira mensagem for model, prefixar com user de contexto
    if (contents.length > 0 && contents[0].role === 'model') {
      contents.unshift({ role: 'user', text: '(início da aventura)' })
    }

    // Garantir alternância user/model — Gemini exige que roles alternem
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
      ? req.context.npcsPresent.map(n => `- ${n.name} (${n.id})`).join('\n')
      : 'Nenhum NPC presente'

    const engineResultText = req.engineEvents.length
      ? req.engineEvents.map(e => `${e.type}: ${JSON.stringify(e.payload)}`).join(' | ')
      : 'Sem resultado mecânico'

    const currentTurnPrompt = [
      'TURNO DO JOGO — Narre a consequência da ação do jogador.',
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
          playerSkills: req.context.playerSkills
        }
      )
    } catch (error) {
      logErr('narrateTurn', 'Error:', error)
      return {
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
