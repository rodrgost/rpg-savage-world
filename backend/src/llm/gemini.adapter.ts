import type {
  ExpandWorldRequest,
  GenerateWorldGuideRequest,
  ExpandAdventureStoryResult,
  StoryCharacter,
  CampaignMission,
  GenerateImageDescriptionRequest,
  Narrator,
  SuggestedCharacter,
  SuggestCharacterFromWorldRequest,
  SuggestCharacterFromDescriptionRequest,
  SummarizeHistoryRequest
} from './narrator.js'
import type {
  NarrateStartRequest,
  NarrateTurnRequest,
  NarratorTurnResponse,
  NpcAttackEntry,
  OutcomeOverride,
  NarrativeSegment,
  ActionOption,
  NPCMention,
  ItemChange,
  StatusChange,
  DiceCheck,
  ValidateActionRequest,
  ValidateActionResponse,
  InventoryItem,
  EquippedItemsBrief
} from '../domain/types/narrative.js'
import { segmentsToText } from '../domain/segments.js'
import { randomUUID, createHash } from 'node:crypto'
import { NARRATOR_RESPONSE_SCHEMA, VALIDATE_ACTION_RESPONSE_SCHEMA } from './schemas/narrator-response.schema.js'
import { SUMMARY_RESPONSE_SCHEMA } from './schemas/summary-response.schema.js'
// dice-rules.ts — importações removidas (DICE_ROLL_PRINCIPLE_PT, DICE_TRACO_FIELD_EXPLANATION_PT não utilizadas)
import type { StructuredSummary, SummaryLocationBlock, SummaryCurrentBlock } from './summary-format.js'
import { emptyStructuredSummary } from './summary-format.js'
import type { WorldGuide, WorldGuideFaction, WorldGuideGlossaryTerm } from '../domain/types/world-guide.js'
import { renderWorldGuideMarkdown } from '../domain/types/world-guide.js'
// findSkillDefinition e getCanonicalSkillLabel — não mais utilizados após migração chanceCheck
import { logLlmRequest, logLlmResponse, logLlmError, log, warn, error as logErr } from '../utils/file-logger.js'
import { buildOpenAiJsonSchemaResponseFormat } from './schemas/openai-strict-schema.js'
// recordSkillInferenceOutcome — não mais utilizado após migração chanceCheck
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

type SupportedLlmProvider = 'gemini' | 'deepseek' | 'openai'

type OpenAiCompatibleChatCompletionResponse = {
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
  /** Schema (subconjunto OpenAPI aceito pelo Gemini) para forçar JSON estruturado. Só tem efeito com responseMimeType 'application/json'. */
  responseSchema?: Record<string, unknown>
  temperature?: number
  /** Quando presente, enviado como campo separado systemInstruction na API Gemini */
  systemInstruction?: string
  /** Referência de cache explícito do Gemini (ex.: cachedContents/abc123). */
  cachedContent?: string
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
  allowNarrativeFallback?: boolean
  /**
   * Estilo de tamanho ativo na geração. Só o estilo "balanced" tem mínimo de
   * frases (2) — usado para o aviso de narração curta demais.
   */
  narrativeStyle?: 'concise' | 'balanced'
  /**
   * NPCs já presentes na cena (id estável + nome). Usado para preservar o id de
   * NPCs em continuidade (em vez de gerar um novo hash) quando o LLM os referencia
   * por id ou por nome.
   */
  presentNpcs?: { id: string; name: string }[]
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
  const provider = readEnv('LLM_PROVIDER', 'gemini').toLowerCase()
  if (provider === 'deepseek' || provider === 'openai') return provider
  return 'gemini'
}

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function withMin(value: number, min: number): number {
  return value < min ? min : value
}

function truncateForPrompt(value: string | undefined, max = 280): string | undefined {
  if (!value) return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max)}...`
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = readEnv(name).toLowerCase()
  if (raw === '') return fallback
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on'
}

function normalizeGeminiCachedContentName(value: string | undefined): string | undefined {
  if (!value) return undefined
  const normalized = value.trim()
  if (!normalized) return undefined
  if (normalized.startsWith('cachedContents/') || normalized.startsWith('projects/')) {
    return normalized
  }
  if (normalized.includes('/')) return normalized
  return `cachedContents/${normalized}`
}

// Alguns modelos OpenAI (família de raciocínio: gpt-5, o1, o3, o4, ...) só aceitam
// o valor padrão de temperature (1). Qualquer outro valor — inclusive 1.05 gerado
// pelo decremento das tentativas de retry — é rejeitado com HTTP 400
// ("Unsupported value: 'temperature' does not support X with this model.").
// Nesses casos o parâmetro deve ser omitido para que a API use o default.
function openAiModelOnlySupportsDefaultTemperature(model: string): boolean {
  const normalized = model.trim().toLowerCase()
  return /^o\d/.test(normalized) || normalized.startsWith('gpt-5')
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


function buildOptionSignature(option: {
  text: string
  actionType: string
  actionPayload: Record<string, unknown>
  diceCheck?: DiceCheck | null
}): string {
  const payloadInput = typeof option.actionPayload.input === 'string' ? option.actionPayload.input : ''

  return [
    option.actionType,
    option.text.toLowerCase(),
    payloadInput.toLowerCase()
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

function extractOpenAiCompatibleText(response: OpenAiCompatibleChatCompletionResponse): string {
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

function formatTraitTestResult(payload: Record<string, unknown>): string {
  const trait = typeof payload.trait === 'string' ? payload.trait : 'Atributo'
  const dieSides = typeof payload.dieSides === 'number' ? payload.dieSides : null
  const finalTotal = typeof payload.finalTotal === 'number' ? payload.finalTotal : null
  const tn = typeof payload.targetNumber === 'number' ? payload.targetNumber : 4
  const isSuccess = payload.isSuccess === true
  const raises = typeof payload.raises === 'number' ? payload.raises : 0
  const description = typeof payload.description === 'string' ? payload.description : ''

  // Falha crítica: 1 natural no dado da perícia E no Wild Die.
  const traitRoll = payload.traitRoll as { rolls?: unknown } | null | undefined
  const wildRoll = payload.wildRoll as { rolls?: unknown } | null | undefined
  const traitNat = Array.isArray(traitRoll?.rolls) ? traitRoll!.rolls[0] : undefined
  const wildNat = Array.isArray(wildRoll?.rolls) ? wildRoll!.rolls[0] : undefined
  const criticalFailure = traitNat === 1 && wildNat === 1

  let outcome: string
  if (criticalFailure) outcome = 'MUITA FALHA (falha crítica)'
  else if (!isSuccess) outcome = 'FALHA'
  else if (raises >= 1) outcome = `MUITO SUCESSO (${raises} aumento${raises > 1 ? 's' : ''})`
  else outcome = 'SUCESSO'

  const dieLabel = dieSides ? ` d${dieSides}` : ''
  const numbers = finalTotal !== null ? ` [total ${finalTotal} vs alvo ${tn}]` : ''
  const action = description ? ` Ação: ${description}` : ''
  return `[trait_test] ${outcome} — ${trait}${dieLabel}.${numbers}${action}`.replace(/\s+$/, '')
}

function formatEngineEventsForPrompt(events: Array<{ type: string; payload: unknown }>): string {
  return events
    .map((event) => {
      if (
        event.type === 'chance_check_result'
        && event.payload
        && typeof event.payload === 'object'
        && !Array.isArray(event.payload)
      ) {
        const p = event.payload as Record<string, unknown>
        const outcome = p.success ? 'SUCESSO' : 'FALHA'
        const desc = p.description ? ` Ação: ${p.description}` : ''
        const reasonText = p.reason ? ` Motivo: ${p.reason}.` : ''
        return `[chance_check] ${outcome} — Rolagem: ${Math.round(Number(p.roll))} vs Chance: ${p.chance}%.${reasonText}${desc}`
      }
      if (
        event.type === 'trait_test'
        && event.payload
        && typeof event.payload === 'object'
        && !Array.isArray(event.payload)
      ) {
        return formatTraitTestResult(event.payload as Record<string, unknown>)
      }
      return `[${event.type}] ${JSON.stringify(event.payload)}`
    })
    .join('\n')
}

function formatBoolPt(value: boolean): string {
  return value ? 'Sim' : 'Não'
}

function renderInventoryMarkdown(items: InventoryItem[]): string {
  if (!items.length) return 'Nenhum item.'
  return items
    .map((item) => {
      const details: string[] = []
      if (item.category) details.push(`categoria: ${item.category}`)
      if (typeof item.armorValue === 'number') details.push(`Resistência +${item.armorValue}`)
      if (typeof item.parryBonus === 'number') details.push(`Aparar +${item.parryBonus}`)
      if (item.tags?.length) details.push(`tags: ${item.tags.join(', ')}`)
      const detailsText = details.length ? ` — ${details.join(', ')}` : ''
      const descText = item.description ? `: ${item.description}` : ''
      return `- ${item.name} (x${item.quantity})${detailsText}${descText}`
    })
    .join('\n')
}

function renderEquippedItemsMarkdown(equipped?: EquippedItemsBrief): string | null {
  if (!equipped) return null
  const lines: string[] = []
  if (equipped.attack) lines.push(`- Arma: ${equipped.attack.name} (dano ${equipped.attack.damageFormula}, AP ${equipped.attack.ap})`)
  if (equipped.armor) lines.push(`- Armadura: ${equipped.armor.name} (Resistência +${equipped.armor.armorValue})`)
  if (equipped.shield) lines.push(`- Escudo: ${equipped.shield.name} (Aparar +${equipped.shield.parryBonus})`)
  return lines.length ? lines.join('\n') : null
}

function renderStatusEffectsMarkdown(effects: Array<{ id: string; name: string; turnsRemaining?: number }>): string | null {
  if (!effects.length) return null
  return effects
    .map((e) => `- ${e.name}${typeof e.turnsRemaining === 'number' ? ` (${e.turnsRemaining} turnos restantes)` : ''}`)
    .join('\n')
}

type ScenePromptNpc = {
  id: string
  name: string
  displayName?: string
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
}

function renderNpcsPresentMarkdown(npcs: ScenePromptNpc[]): string | null {
  if (!npcs.length) return null
  return npcs
    .map((npc) => {
      const label = npc.displayName || npc.name
      const kind = npc.isWildCard ? 'Wild Card' : 'Extra'
      const disposition = npc.disposition ?? 'neutral'
      const extras: string[] = []
      if (npc.personality) extras.push(`personalidade: ${npc.personality}`)
      if (npc.motivation) extras.push(`motivação: ${npc.motivation}`)
      if (npc.speechPattern) extras.push(`fala: ${npc.speechPattern}`)
      if (npc.statusEffects?.length) extras.push(`efeitos: ${npc.statusEffects.map((e) => e.name).join(', ')}`)
      const extrasText = extras.length ? ` — ${extras.join('; ')}` : ''
      return `- ${label} (\`${npc.id}\`) — ${kind}, disposição: ${disposition}, Ferimentos ${npc.wounds}/${npc.maxWounds}, Resistência ${npc.toughness}, Aparar ${npc.parry}${extrasText}`
    })
    .join('\n')
}

function renderNpcCatalogMarkdown(catalog?: Array<{ id: string; name: string; description?: string; dispositionDefault: string }>): string | null {
  if (!catalog?.length) return null
  return catalog
    .map((npc) => `- ${npc.name} (\`${npc.id}\`) — disposição padrão: ${npc.dispositionDefault}${npc.description ? `: ${npc.description}` : ''}`)
    .join('\n')
}

function renderPlayerSkillsMarkdown(skills?: Record<string, string>): string | null {
  if (!skills || !Object.keys(skills).length) return null
  return Object.entries(skills)
    .map(([skill, die]) => `- ${skill}: ${die}`)
    .join('\n')
}

function renderSceneObjectsMarkdown(sceneObjects?: string[]): string | null {
  if (!sceneObjects?.length) {
    return '- nenhum objeto de cenário confirmado neste momento; use apenas elementos explicitamente narrados neste turno.'
  }
  return sceneObjects.map((name) => `- ${name}`).join('\n')
}

type ScenePromptState = {
  location: string
  situationLabel?: string
  wounds: number
  fatigue: number
  isShaken: boolean
  bennies: number
  inventory: InventoryItem[]
  equippedItems?: EquippedItemsBrief
  activeStatusEffects: Array<{ id: string; name: string; turnsRemaining?: number }>
  npcsPresent: ScenePromptNpc[]
  defeatedNpcIds?: string[]
  npcCatalog?: Array<{ id: string; name: string; description?: string; dispositionDefault: string }>
  sceneObjectsCurrent?: string[]
  playerSkills?: Record<string, string>
  rulesDigest?: string
  summaryText?: string
}

/**
 * Renderiza o estado compartilhado da cena (local, ferimentos, inventário, NPCs,
 * efeitos, perícias, regras, resumo) como Markdown, no lugar do antigo envelope
 * JSON. Seções vazias/ausentes são omitidas.
 */
function renderSceneStateMarkdown(state: ScenePromptState): string {
  const sections: string[] = []

  // Referência estática (perícias catalogadas, hindrances, atributos, âncoras
  // canônicas) primeiro: quase não muda entre turnos, então fica longe do
  // ponto de geração — o final do prompt fica reservado para o que é
  // específico deste turno (estado, resumo, ação, resultado mecânico).
  if (state.rulesDigest) sections.push(`## Regras\n${state.rulesDigest}`)

  const stateLines = [
    `- Local: ${state.location}`,
    state.situationLabel ? `- Cena: ${state.situationLabel}` : null,
    `- Ferimentos: ${state.wounds} | Fadiga: ${state.fatigue} | Abalado: ${formatBoolPt(state.isShaken)} | Bennies: ${state.bennies}`
  ].filter((line): line is string => Boolean(line))
  sections.push(`## Estado Atual\n${stateLines.join('\n')}`)

  const sceneObjectsText = renderSceneObjectsMarkdown(state.sceneObjectsCurrent)
  sections.push(`## Objetos do Cenário Atual\n${sceneObjectsText}`)

  sections.push(`## Inventário\n${renderInventoryMarkdown(state.inventory)}`)

  const equippedText = renderEquippedItemsMarkdown(state.equippedItems)
  if (equippedText) sections.push(`## Itens Equipados\n${equippedText}`)

  const statusText = renderStatusEffectsMarkdown(state.activeStatusEffects)
  if (statusText) sections.push(`## Efeitos Ativos\n${statusText}`)

  const npcsText = renderNpcsPresentMarkdown(state.npcsPresent)
  if (npcsText) sections.push(`## NPCs Presentes\n${npcsText}`)

  if (state.defeatedNpcIds?.length) {
    sections.push(`## NPCs Derrotados (não referenciar como ameaças)\n${state.defeatedNpcIds.map((id) => `- ${id}`).join('\n')}`)
  }

  const catalogText = renderNpcCatalogMarkdown(state.npcCatalog)
  if (catalogText) sections.push(`## Catálogo de NPCs do Mundo\n${catalogText}`)

  const skillsText = renderPlayerSkillsMarkdown(state.playerSkills)
  if (skillsText) sections.push(`## Perícias do Jogador\n${skillsText}`)

  // Resumo da Aventura fica por último: é o elo narrativo mais próximo da
  // Ação do Jogador / Resultado Mecânico que vêm a seguir no prompt do turno.
  if (state.summaryText) sections.push(`## Resumo da Aventura\n${state.summaryText}`)

  return sections.join('\n\n')
}

function sanitizeInlineText(value: unknown, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  const cleaned = normalizeModelText(value)
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || fallback
}

// Remove padrões de quantidade que o LLM pode incluir no nome do item
// Ex: "Espada x3", "Espada (x3)", "Espada ×3", "Espada x 3"
function stripQuantityFromName(name: string): string {
  const stripped = name.replace(/\s*[\(（]?\s*[x×]\s*\d+\s*[\)）]?\s*$/i, '').trim()
  return stripped || name
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

/**
 * Gera um identificador est\u00e1vel e determin\u00edstico para um NPC a partir do seu
 * nome amig\u00e1vel (displayName). O mesmo nome sempre produz o mesmo id, o que
 * garante continuidade entre turnos sem depender de o LLM "copiar" ids.
 * Formato: `npc-<10 hex de sha1 do nome normalizado>`.
 */
function npcIdFromDisplayName(displayName: string): string {
  const key = normalizeMentionKey(displayName).replace(/\s+/g, ' ').trim()
  if (!key) return `npc-${randomUUID().replace(/-/g, '').slice(0, 10)}`
  return `npc-${createHash('sha1').update(key).digest('hex').slice(0, 10)}`
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

function sanitizeLimitedStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  return sanitizeStringList(value)
    .map((entry) => entry.slice(0, maxLength))
    .slice(0, maxItems)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function sanitizeGuideText(value: unknown, fallback = 'Não definido.', max = 600): string {
  return sanitizeInlineText(value, fallback).slice(0, max) || fallback
}

function sanitizeWorldGuideFromRecord(source: Record<string, unknown>, fallback: { name: string; description?: string }): WorldGuide {
  const root = source.worldGuide && typeof source.worldGuide === 'object' && !Array.isArray(source.worldGuide)
    ? source.worldGuide as Record<string, unknown>
    : source
  const llmPersona = asRecord(root.llmPersona)
  const universeRules = asRecord(root.universeRules)
  const glossary = asRecord(root.glossary)
  const factionsAndPower = asRecord(root.factionsAndPower)
  const knowledgeHorizon = asRecord(root.knowledgeHorizon)
  const geography = asRecord(root.geography)
  const mood = asRecord(root.mood)

  const terms: WorldGuideGlossaryTerm[] = (Array.isArray(glossary.terms) ? glossary.terms : [])
    .slice(0, 24)
    .map((entry) => {
      const term = asRecord(entry)
      return {
        term: sanitizeGuideText(term.term, '', 80),
        definition: sanitizeGuideText(term.definition, '', 360),
        preferredUsage: sanitizeGuideText(term.preferredUsage, '', 180) || undefined,
        avoidTerms: sanitizeLimitedStringList(term.avoidTerms, 8, 80)
      }
    })
    .filter((entry) => entry.term && entry.definition)

  const groups: WorldGuideFaction[] = (Array.isArray(factionsAndPower.groups) ? factionsAndPower.groups : [])
    .slice(0, 12)
    .map((entry) => {
      const group = asRecord(entry)
      return {
        name: sanitizeGuideText(group.name, '', 100),
        role: sanitizeGuideText(group.role, '', 240),
        publicFace: sanitizeGuideText(group.publicFace, '', 360),
        powerBase: sanitizeGuideText(group.powerBase, '', 260),
        relationships: sanitizeLimitedStringList(group.relationships, 10, 180)
      }
    })
    .filter((group) => group.name && group.role)

  const description = sanitizeInlineText(fallback.description, '')
  const name = sanitizeInlineText(fallback.name, 'este universo')

  return {
    llmPersona: {
      role: sanitizeGuideText(llmPersona.role, `Observador interno de ${name}`, 220),
      perspective: sanitizeGuideText(llmPersona.perspective, description || `Perspectiva nativa de ${name}.`, 500),
      knowledgeLimits: sanitizeGuideText(llmPersona.knowledgeLimits, 'Sabe apenas o que seria conhecido no momento atual do cenário; não antecipa segredos futuros.', 500)
    },
    universeRules: {
      magicAndPowers: sanitizeLimitedStringList(universeRules.magicAndPowers, 12, 260),
      technology: sanitizeLimitedStringList(universeRules.technology, 12, 260),
      impossibilities: sanitizeLimitedStringList(universeRules.impossibilities, 12, 260),
      costsAndLimits: sanitizeLimitedStringList(universeRules.costsAndLimits, 12, 260)
    },
    glossary: {
      terms,
      forbiddenGenericTerms: sanitizeLimitedStringList(glossary.forbiddenGenericTerms, 16, 80)
    },
    factionsAndPower: {
      groups,
      socialTensions: sanitizeLimitedStringList(factionsAndPower.socialTensions, 12, 260),
      speciesAndCultures: sanitizeLimitedStringList(factionsAndPower.speciesAndCultures, 12, 220)
    },
    knowledgeHorizon: {
      currentMoment: sanitizeGuideText(knowledgeHorizon.currentMoment, 'Momento atual não definido.', 260),
      knownFacts: sanitizeLimitedStringList(knowledgeHorizon.knownFacts, 16, 260),
      unknownOrSpoilerFacts: sanitizeLimitedStringList(knowledgeHorizon.unknownOrSpoilerFacts, 16, 260)
    },
    geography: {
      immediateSetting: sanitizeGuideText(geography.immediateSetting, 'Cenário imediato não definido.', 500),
      keyLocations: sanitizeLimitedStringList(geography.keyLocations, 12, 260),
      sensoryTexture: sanitizeGuideText(geography.sensoryTexture, 'Textura sensorial não definida.', 420)
    },
    mood: {
      tone: sanitizeGuideText(mood.tone, 'Tom de aventura de RPG coerente com o cenário.', 260),
      emotionalPalette: sanitizeGuideText(mood.emotionalPalette, 'Paleta emocional não definida.', 260),
      languageStyle: sanitizeGuideText(mood.languageStyle, 'Português do Brasil claro e concreto.', 260),
      avoidStyle: sanitizeGuideText(mood.avoidStyle, 'Evite termos genéricos que quebrem a identidade do universo.', 260)
    }
  }
}

function buildWorldGuideStyleGuide(worldGuide?: WorldGuide): string {
  if (!worldGuide) return ''
  return [
    worldGuide.mood.tone,
    worldGuide.mood.emotionalPalette,
    worldGuide.mood.languageStyle,
    `Evite: ${worldGuide.mood.avoidStyle}`
  ].filter(Boolean).join(' ')
}

function isActionType(value: unknown): value is ActionOption['actionType'] {
  return value === 'trait_test'
    || value === 'chance_check'
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

/**
 * Parser mínimo da resposta de validateAction — substitui o antigo
 * sanitizeValidateActionResponse. Sem reparo, sem inferência de perícia: o
 * traco já chega dentro do enum fechado (VALIDATE_ACTION_RESPONSE_SCHEMA,
 * aplicado via responseSchema como no narrador). Se "traco" vier vazio/
 * inválido para um trait_test, a ação vira "custom" sem teste — nunca é
 * rejeitada por causa disso (a resposta inteira só é descartada se os campos
 * estruturais básicos, feasible/actionType/interpretation, estiverem ausentes).
 */
function parseValidateActionResponse(
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

  // Parse chanceCheck (novo formato)
  const chanceCheckRaw = raw.chanceCheck && typeof raw.chanceCheck === 'object' && !Array.isArray(raw.chanceCheck)
    ? raw.chanceCheck as Record<string, unknown>
    : null

  let diceCheck: DiceCheck | null = null
  if (chanceCheckRaw) {
    let required = chanceCheckRaw.required === true
    const successChance = typeof chanceCheckRaw.successChance === 'number' && Number.isFinite(chanceCheckRaw.successChance)
      ? Math.min(100, Math.max(0, Math.round(chanceCheckRaw.successChance)))
      : null
    // Se required=true mas successChance inválido, força required=false
    if (required && typeof successChance !== 'number') {
      required = false
    }
    diceCheck = {
      required,
      successChance: required ? successChance : null,
      reason: sanitizeInlineText(chanceCheckRaw.reason, '')
    }
  }

  if (actionType === 'custom' && !sanitizeInlineText(actionPayload.input, '')) {
    actionPayload.input = interpretation
  }

  if (actionType === 'attack') {
    if (!actionPayload.targetId && typeof actionPayload.target === 'string') {
      actionPayload.targetId = actionPayload.target
    }
  }

  if (actionType === 'travel' && !sanitizeInlineText(actionPayload.to, '')) return null

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

const OVERUSED_SUGGESTION_NAMES = [
  'Vance', 'Kael', 'Elara', 'Aria', 'Lyra', 'Cassius', 'Rourke',
  'Garrick', 'Dorian', 'Seraphina', 'Thorne', 'Kaelen'
]
const NAME_INITIAL_POOL = 'ABCDEFGHIJLMNOPRSTV'

function buildNameDiversityLine(conditional = false): string {
  const letter = NAME_INITIAL_POOL[Math.floor(Math.random() * NAME_INITIAL_POOL.length)]
  const prefix = conditional
    ? `Se o jogador não especificou um nome, o primeiro nome do personagem DEVE começar com a letra "${letter}"`
    : `Restrição de nomeação: o primeiro nome do personagem DEVE começar com a letra "${letter}"`
  return `${prefix}. Nunca use nenhum destes nomes muito repetidos: ${OVERUSED_SUGGESTION_NAMES.join(', ')}.`
}

function buildUniverseStyleInferenceLines(opts: {
  concise?: boolean
  forCharacterSuggestion?: boolean
  explicitGuide?: string
} = {}): string[] {
  const { concise = false, forCharacterSuggestion = false, explicitGuide = '' } = opts
  const guide = explicitGuide.trim()

  if (forCharacterSuggestion) {
    return [
      ...(guide
        ? [
            `Use esta diretriz explícita de tom e clima do universo como direção principal: ${guide}`,
            'Trate esta diretriz como prioridade mais alta do que inferência automática. Use nome do mundo, lore e história da aventura apenas para complementar lacunas e manter coerência.'
          ]
        : []),
      'Antes de escolher os detalhes do personagem, infira a partir do nome do mundo, lore e história da aventura uma diretriz breve de tom para este universo: clima, humor, temperatura emocional, textura social, vocabulário e os tipos de profissões e conflitos concretos que pertencem a ele.',
      'Não exiba essa diretriz explicitamente. Aplique-a internamente para que profissão, descrição e papel na campanha soem nativos deste universo, e não como preenchimento genérico de fantasia/ficção científica.',
      'Se o universo sugerir melancolia, humor seco, pulpa aventureira, horror cósmico, ironia trágica, paranoia, ternura, brutalidade ou assombro, deixe isso moldar concretamente as escolhas do personagem.'
    ]
  }

  if (concise) {
    return [
      '### Tom e Humor do Universo',
      ...(guide
        ? [
            `Diretriz explícita de tom, humor e clima do universo (prioridade alta): ${guide}`,
            'Use essa diretriz como camada principal do texto. Universo e campanha servem para complementar lacunas e manter coerência.'
          ]
        : []),
      'Antes de escrever, infira silenciosamente a partir do UNIVERSO e da CAMPANHA uma diretriz de tom deste cenário: humor, clima emocional, nível de ironia, peso dramático, textura social e tipo de tensão dominante.',
      'NÃO escreva essa diretriz. Apenas aplique o resultado no texto final.',
      'Mesmo usando a diretriz do universo, mantenha a execução concisa: extraia sobretudo nomes próprios, conflitos, instituições, tecnologias, crenças, objetos característicos e o humor dominante da cena.',
      'Evite copiar floreio atmosférico do lore. Converta o universo em escolhas específicas de palavras e fatos concretos.'
    ]
  }

  return [
    '### Tom e Humor do Universo',
    ...(guide
      ? [
          `Diretriz explícita de tom, humor e clima do universo (prioridade alta): ${guide}`,
          'Use essa diretriz como camada principal do texto. Universo e campanha servem para complementar lacunas e manter coerência.'
        ]
      : []),
    'Antes de escrever, infira silenciosamente a partir do UNIVERSO e da CAMPANHA uma diretriz de tom deste cenário: humor, clima emocional, nível de ironia, peso dramático, textura social e tipo de tensão dominante.',
    'NÃO escreva essa diretriz. Apenas aplique o resultado no texto final.',
    'A narração deve soar nativa deste universo, não como fantasia/RPG genérico. Se o mundo pede humor seco, melancolia, paranoia, solenidade, brutalidade, ternura, ironia ou assombro, isso deve aparecer nas palavras escolhidas e nos detalhes concretos da cena.',
    'Nunca use linguagem neutra de manual. Prefira imagens, instituições, objetos, tecnologias, crenças, conflitos e um humor compatível com este mundo.'
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

  const genderPtValue = extractFieldFromRecord(source, ['genderPt', 'generoPt', 'gêneroPt'])
  const racePtValue = extractFieldFromRecord(source, ['racePt', 'racaPt', 'raçaPt'])
  const professionPtValue = extractFieldFromRecord(source, ['professionPt', 'profissaoPt', 'profissãoPt'])
  const descriptionPtValue = extractFieldFromRecord(source, ['descriptionPt', 'descricaoPt', 'descriçãoPt'])
  const campaignRolePtValue = extractFieldFromRecord(source, ['campaignRolePt', 'papelPt', 'papelNaCampanhaPt'])

  return {
    name: sanitizeCharacterField(nameValue, ''),
    gender: sanitizeCharacterField(genderValue, ''),
    race: sanitizeCharacterField(raceValue, ''),
    profession: sanitizeCharacterField(professionValue, ''),
    description: sanitizeCharacterField(descriptionValue, ''),
    campaignRole: sanitizeCharacterField(campaignRoleValue, ''),
    genderPt: sanitizeCharacterField(genderPtValue, '') || undefined,
    racePt: sanitizeCharacterField(racePtValue, '') || undefined,
    professionPt: sanitizeCharacterField(professionPtValue, '') || undefined,
    descriptionPt: sanitizeCharacterField(descriptionPtValue, '') || undefined,
    campaignRolePt: sanitizeCharacterField(campaignRolePtValue, '') || undefined,
  }
}

export class GeminiAdapter implements Narrator {
  private readonly provider = readLlmProvider()
  private readonly providerLabel = this.provider === 'deepseek'
    ? 'DeepSeek'
    : this.provider === 'openai'
      ? 'OpenAI'
      : 'Gemini'
  private readonly logTag = this.provider === 'gemini' ? 'gemini' : this.provider
  private readonly openAiCompatibleEnvPrefix = this.provider === 'openai' ? 'OPENAI' : 'DEEPSEEK'
  private readonly apiKeyEnvName = this.provider === 'gemini'
    ? 'GEMINI_API_KEY'
    : `${this.openAiCompatibleEnvPrefix}_API_KEY`
  private readonly apiKey = this.provider === 'gemini'
    ? readEnv('GEMINI_API_KEY')
    : readEnv(`${this.openAiCompatibleEnvPrefix}_API_KEY`)
  private readonly model = this.provider === 'gemini'
    ? readEnv('GEMINI_MODEL', 'gemini-2.5-flash')
    : this.provider === 'openai'
      ? readEnv('OPENAI_MODEL', 'gpt-4.1-mini')
      : readEnv('DEEPSEEK_MODEL', 'deepseek-chat')
  private readonly baseUrl = this.provider === 'gemini'
    ? readEnv('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com')
    : this.provider === 'openai'
      ? readEnv('OPENAI_BASE_URL', 'https://api.openai.com/v1')
      : readEnv('DEEPSEEK_BASE_URL', 'https://api.deepseek.com')
  private readonly temperature = toNumber(
    this.provider === 'gemini'
      ? readEnv('GEMINI_TEMPERATURE', '0.4')
      : readEnv(`${this.openAiCompatibleEnvPrefix}_TEMPERATURE`, '0.4'),
    0.4
  )
  private readonly maxOutputTokens = withMin(
    toNumber(
      this.provider === 'gemini'
        ? readEnv('GEMINI_MAX_OUTPUT_TOKENS', '8192')
        : readEnv(`${this.openAiCompatibleEnvPrefix}_MAX_OUTPUT_TOKENS`, '8192'),
      8192
    ),
    8192
  )
  private readonly worldMaxOutputTokens = withMin(
    toNumber(
      this.provider === 'gemini'
        ? readEnv('GEMINI_WORLD_MAX_OUTPUT_TOKENS', '16384')
        : readEnv(`${this.openAiCompatibleEnvPrefix}_WORLD_MAX_OUTPUT_TOKENS`, '16384'),
      16384
    ),
    4096
  )
  private readonly narrateStartMaxTokens = withMin(
    toNumber(
      this.provider === 'gemini'
        ? readEnv('GEMINI_NARRATE_START_MAX_TOKENS', '8192')
        : readEnv(`${this.openAiCompatibleEnvPrefix}_NARRATE_START_MAX_TOKENS`, '8192'),
      8192
    ),
    2048
  )
  private readonly narrateTurnMaxTokens = withMin(
    toNumber(
      this.provider === 'gemini'
        ? readEnv('GEMINI_NARRATE_TURN_MAX_TOKENS', '8192')
        : readEnv(`${this.openAiCompatibleEnvPrefix}_NARRATE_TURN_MAX_TOKENS`, '8192'),
      8192
    ),
    2048
  )
  private readonly timeoutMs = withMin(
    toNumber(
      this.provider === 'gemini'
        ? readEnv('GEMINI_TIMEOUT_MS', '90000')
        : readEnv(`${this.openAiCompatibleEnvPrefix}_TIMEOUT_MS`, '90000'),
      90000
    ),
    15000
  )
  private readonly narratorTimeoutMs = withMin(
    toNumber(
      this.provider === 'gemini'
        ? readEnv('GEMINI_NARRATOR_TIMEOUT_MS', '120000')
        : readEnv(`${this.openAiCompatibleEnvPrefix}_NARRATOR_TIMEOUT_MS`, '120000'),
      120000
    ),
    30000
  )
  private readonly narrateStartTemperature = this.temperature
  private readonly narrateTurnTemperature = this.temperature
  private readonly summaryTemperature = this.temperature
  private readonly summaryHistoryTemperature = this.temperature
  private readonly characterSuggestionMaxOutputTokens = withMin(
    toNumber(
      this.provider === 'gemini'
        ? readEnv('GEMINI_CHARACTER_SUGGEST_MAX_OUTPUT_TOKENS', '4096')
        : readEnv(`${this.openAiCompatibleEnvPrefix}_CHARACTER_SUGGEST_MAX_OUTPUT_TOKENS`, '2048'),
      this.provider === 'gemini' ? 4096 : 2048
    ),
    2048
  )
  private readonly characterSuggestionThinkingBudget = withMin(
    toNumber(readEnv('GEMINI_CHARACTER_SUGGEST_THINKING_BUDGET', '0'), 0),
    0
  )
  private readonly geminiEnableExplicitCache = this.provider === 'gemini'
    ? readBool('GEMINI_ENABLE_EXPLICIT_CACHE', false)
    : false
  private readonly geminiCachedContent = this.provider === 'gemini'
    ? normalizeGeminiCachedContentName(readEnv('GEMINI_CACHED_CONTENT'))
    : undefined
  // Reaproveita a temperatura base do provider para descrições visuais.
  private readonly imageDescriptionTemperature = this.temperature
  private readonly normalizedBaseUrl = this.baseUrl.replace(/\/+$/, '')
  // Se o modelo OpenAI aceita temperature customizada. Por padrão detecta pelo
  // nome do modelo (modelos de raciocínio só aceitam o default 1) e pode ser
  // forçado via OPENAI_SUPPORTS_TEMPERATURE ("true"/"false"). Quando false, o
  // parâmetro temperature é omitido da requisição.
  private readonly openAiSupportsCustomTemperature = this.provider === 'openai'
    ? readBool('OPENAI_SUPPORTS_TEMPERATURE', !openAiModelOnlySupportsDefaultTemperature(this.model))
    : true
  private hasWarnedMissingExplicitCacheConfig = false

  private generateTextCallId = 0

  /** Cache: cacheKey → system prompt string. Evita reconstruir ~1800 linhas a cada turno. */
  private readonly narratorPromptCache = new Map<string, string>()
  private static readonly PROMPT_CACHE_MAX = 20

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
    if (this.provider !== 'gemini') {
      return await this.generateOpenAiCompatibleTextDetailed(promptOrContents, options, attempt)
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
    const responseSchema = options.responseSchema
    const temperature = options.temperature ?? this.temperature
    const systemInstruction = options.systemInstruction
    const requestCachedContent = normalizeGeminiCachedContentName(options.cachedContent)
    const configuredCachedContent = this.geminiEnableExplicitCache ? this.geminiCachedContent : undefined
    const cachedContent = requestCachedContent ?? configuredCachedContent
    const cachedContentSource: 'request' | 'env' | undefined = requestCachedContent
      ? 'request'
      : configuredCachedContent
        ? 'env'
        : undefined
    const thinkingBudget = options.thinkingBudget
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    if (
      this.provider === 'gemini'
      && this.geminiEnableExplicitCache
      && !requestCachedContent
      && !this.geminiCachedContent
      && !this.hasWarnedMissingExplicitCacheConfig
    ) {
      this.hasWarnedMissingExplicitCacheConfig = true
      warn(this.logTag, 'GEMINI_ENABLE_EXPLICIT_CACHE=true, mas GEMINI_CACHED_CONTENT não está definido; chamadas seguirão sem cache explícito até configurar o nome do cache ou enviar options.cachedContent')
    }

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
      temperature,
      cachedContent,
      cachedContentSource
    })
    if (cachedContent) {
      log(this.logTag, `${callTag} usando cachedContent=${cachedContent}`)
    }

    const startMs = Date.now()

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(systemInstruction
            ? { systemInstruction: { parts: [{ text: systemInstruction }] } }
            : {}),
          ...(cachedContent ? { cachedContent } : {}),
          contents,
          generationConfig: {
            temperature,
            maxOutputTokens,
            ...(responseMimeType ? { responseMimeType } : {}),
            ...(responseSchema ? { responseSchema } : {}),
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

  private async generateOpenAiCompatibleTextDetailed(
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
    const maxOutputTokens = this.provider === 'deepseek'
      ? clamp(requestedMaxOutputTokens, 1, DEEPSEEK_MAX_TOKENS_LIMIT)
      : withMin(requestedMaxOutputTokens, 1)
    const timeoutMs = options.timeoutMs ?? this.timeoutMs
    const responseMimeType = options.responseMimeType
    const responseSchema = options.responseSchema
    const temperature = options.temperature ?? this.temperature
    const sendTemperature = this.openAiSupportsCustomTemperature
    const systemInstruction = options.systemInstruction
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    // Structured Outputs (response_format: json_schema, strict) só é suportado pela
    // API OpenAI de fato; para outros providers OpenAI-compatíveis (ex.: DeepSeek)
    // cai para o JSON mode genérico. responseSchema só chega aqui quando o chamador
    // já pediu (narrator/summary) e o provider não é 'deepseek' (ver generateNarratorResponse).
    const responseFormat =
      this.provider === 'openai' && responseSchema
        ? buildOpenAiJsonSchemaResponseFormat('structured_response', responseSchema)
        : responseMimeType === 'application/json'
          ? { type: 'json_object' as const }
          : undefined

    if (this.provider === 'deepseek' && maxOutputTokens !== requestedMaxOutputTokens) {
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
      temperature: sendTemperature ? temperature : undefined
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
          // Modelos que só aceitam o temperature padrão (1) rejeitam qualquer
          // valor explícito; nesses casos omitimos o campo para usar o default.
          ...(sendTemperature ? { temperature } : {}),
          ...(this.provider === 'openai'
            ? { max_completion_tokens: maxOutputTokens }
            : { max_tokens: maxOutputTokens }),
          stream: false,
          ...(responseFormat ? { response_format: responseFormat } : {})
        }),
        signal: controller.signal
      })

      const raw = await response.text()
      if (!response.ok) {
        const err = new Error(`${this.providerLabel} HTTP ${response.status}: ${raw.slice(0, 200)}`)
        logLlmError(callTag, err)
        throw err
      }

      const parsed = raw ? (JSON.parse(raw) as OpenAiCompatibleChatCompletionResponse) : {}
      const text = extractOpenAiCompatibleText(parsed)
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

  /** Converte um registro JSON parseado (e potencialmente sujo) em StructuredSummary, com defaults seguros. */
  private buildStructuredSummaryFromRecord(source: Record<string, unknown>, fallback: { name: string; turn: number }): StructuredSummary {
    const toText = (value: unknown): string => sanitizeNarrativeOutput(typeof value === 'string' ? value : '')
    const toOptionalText = (value: unknown): string | undefined => {
      const text = toText(value)
      return text ? text : undefined
    }
    const toInt = (value: unknown, fallbackValue: number): number => {
      const n = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(n) ? Math.trunc(n) : fallbackValue
    }

    const rawLocations = Array.isArray(source.locations) ? source.locations : []
    const locations: SummaryLocationBlock[] = rawLocations
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
      .map((entry) => ({
        name: toText(entry.name) || 'Local desconhecido',
        turnStart: toInt(entry.turnStart, fallback.turn),
        turnEnd: toInt(entry.turnEnd, fallback.turn),
        situation: toText(entry.situation),
        npcs: toOptionalText(entry.npcs),
        tensions: toOptionalText(entry.tensions)
      }))
      .filter((loc) => loc.situation.length > 0)

    const rawCurrent = (source.current && typeof source.current === 'object') ? source.current as Record<string, unknown> : {}
    const current: SummaryCurrentBlock = {
      name: toText(rawCurrent.name) || fallback.name,
      turn: toInt(rawCurrent.turn, fallback.turn),
      situation: toText(rawCurrent.situation),
      npcs: toOptionalText(rawCurrent.npcs),
      goals: toOptionalText(rawCurrent.goals),
      tensions: toOptionalText(rawCurrent.tensions)
    }

    return { locations, current }
  }

  async summarizeHistory(req: SummarizeHistoryRequest): Promise<StructuredSummary> {
    const state = req.currentState
    const npcsAtLocation = state.npcs.filter((npc) => !npc.location || npc.location === state.worldState.activeLocation)
    const hostileNpcs = npcsAtLocation.filter((npc) => npc.disposition === 'hostile')
    const activeFlags = Object.entries(state.worldState.worldFlags)
      .filter(([, value]) => value)
      .map(([key]) => key)

    const combatText = state.combat
      ? `Combate ativo (rodada ${state.combat.round}, ${state.combat.combatants.length} combatentes).`
      : 'Sem combate formal em curso.'
    const threatsText = hostileNpcs.length
      ? hostileNpcs
        .slice(0, 6)
        .map((npc) => `${npc.name}${npc.wounds > 0 ? ` (ferido ${npc.wounds}/${npc.maxWounds})` : ''}`)
        .join(', ')
      : 'Nenhuma ameaça imediata.'
    const forcesText = npcsAtLocation.length
      ? npcsAtLocation
        .slice(0, 8)
        .map((npc) => `${npc.name}${npc.disposition ? ` (${npc.disposition})` : ''}`)
        .join(', ')
      : 'Nenhum NPC relevante visível.'
    const activeFlagsText = activeFlags.length ? activeFlags.join(', ') : 'nenhuma'

    const sysPrompt = [
      'Você é o guardião da memória de continuidade de uma sessão de RPG. Sua saída é JSON estruturado consumido pelo app — nunca mostrado aos jogadores.',
      '',
      '## Formato de Saída',
      'Responda SOMENTE com um objeto JSON válido, sem markdown, seguindo exatamente este formato:',
      '```json',
      '{"locations":[{"name":"...","turnStart":N,"turnEnd":N,"situation":"...","npcs":"...","tensions":"..."}],"current":{"name":"...","turn":N,"situation":"...","npcs":"...","goals":"...","tensions":"..."}}',
      '```',
      '',
      '## Organização dos Fatos',
      'Organize os fatos em blocos por LOCAL, em ordem cronológica. Um item em "locations" por local distinto já visitado (mescle visitas contíguas ao mesmo local; mantenha itens separados se o personagem saiu e voltou). NÃO inclua o local atual em "locations" — ele vai em "current".',
      '',
      '### Campos de cada item de "locations"',
      '- situation: o que ficou diferente aqui — 1 frase. Descreva o estado resultante, não a sequência de ações.',
      '- npcs: "Nome (1 traço, disposição); Nome2 (...)" — omita (string vazia) se nenhum NPC relevante.',
      '- tensions: fios narrativos abertos, mistérios, promessas não cumpridas — omita se nada em aberto.',
      '',
      '### Campo "current" (sempre presente, é o local/turno atual)',
      '- situation: estado atual da cena, ameaças imediatas e descobertas não resolvidas — máx 2 frases.',
      '- npcs: quem está presente e disposição — omita se nenhum.',
      '- goals: metas ainda pendentes do personagem — omita se nenhuma.',
      '- tensions: tensões ativas não resolvidas — omita se nenhuma.',
      '',
      '## O que DESCARTAR (obrigatório)',
      '- Ações mecânicas sem consequência duradoura: abrir porta, se esconder, atirar em alguém, golpear inimigo, rolar atrás de cobertura, recarregar, mover entre cômodos.',
      '- Combates em geral: registre o combate SOMENTE se um NPC relevante morreu, fugiu ou mudou de lado, ou se revelou algo sobre a trama.',
      '- Movimentações rotineiras entre locais sem descoberta.',
      '- Inventário (rastreado separadamente pelo motor).',
      '- Eventos já resolvidos sem consequência em aberto.',
      '',
      '## O que MANTER (obrigatório)',
      '- Descobertas: informação nova, local desbloqueado, objeto de trama encontrado.',
      '- Mudança permanente de NPC: morte, fuga, aliança formada, traição confirmada.',
      '- Revelação de plot ou motivação de facção.',
      '- Objetivos desbloqueados, concluídos ou fracassados.',
      '- Ameaças pendentes que ainda podem retornar.',
      '- Flags ativas com impacto narrativo futuro.',
      '',
      '## Regras de escrita',
      '- Telegráfico e factual — sem narração, atmosfera ou recriação de cenas.',
      '- Cada frase termina com ponto final.',
      '- Se há resumo anterior em JSON, integre seus fatos — mantenha o relevante, descarte o superado, mescle locais repetidos.',
      '- Apenas português do Brasil.'
    ].join('\n')

    const messagesText = req.messages
      .map((m) => `[T${m.turn}] ${m.role === 'narrator' ? 'Narrador' : 'Jogador'}: ${m.text}`)
      .join('\n')

    const prompt = [
      ...(req.previousSummary ? [
        '=== Resumo anterior em JSON (integre e descarte o que foi superado) ===',
        JSON.stringify(req.previousSummary),
        ''
      ] : []),
      '=== Mensagens (ordem cronológica, mais antiga → mais recente) ===',
      messagesText,
      '',
      '=== Estado atual ===',
      `Local: ${state.worldState.activeLocation} | Turno: ${state.meta.turn}`,
      combatText,
      `Ameaças visíveis: ${threatsText}`,
      `NPCs presentes: ${forcesText}`,
      `Flags ativas: ${activeFlagsText}`,
      '',
      'Agrupe em blocos por local e produza a memória atualizada em JSON. Descarte o que foi resolvido. Use o estado atual acima para corrigir contradições e preencher "current".'
    ].join('\n')

    const fallback = { name: state.worldState.activeLocation, turn: state.meta.turn }
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
          temperature: current.temperature,
          responseMimeType: 'application/json',
          ...(this.provider === 'deepseek' ? {} : { responseSchema: SUMMARY_RESPONSE_SCHEMA })
        }, index + 1)

        const parsed = parseJsonObjectDetailed(result.text)
        if (!parsed) {
          lastError = new Error('Resumo histórico sem JSON válido')
          warn('summarizeHistory', `Tentativa ${index + 1} não retornou JSON parseável`)
          continue
        }

        const truncatedJson = result.finishReason === 'MAX_TOKENS' && parsed.source !== 'direct'
        if (truncatedJson) {
          lastError = new Error(`Resumo histórico truncado (finish=${result.finishReason ?? 'unknown'})`)
          warn('summarizeHistory', `Tentativa ${index + 1} truncou o resumo histórico (source=${parsed.source})`)
          continue
        }

        const structured = this.buildStructuredSummaryFromRecord(parsed.value, fallback)
        if (!structured.current.situation && structured.locations.length === 0) {
          lastError = new Error('Resumo histórico vazio')
          warn('summarizeHistory', `Tentativa ${index + 1} retornou resumo estruturalmente vazio`)
          continue
        }

        return structured
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
      'Você é um criador de aventuras.',
      'Objetivo: criar do zero uma história completa a partir de contexto mínimo.',
      '',
      '## Saída Esperada',
      'Um JSON válido com os seguintes campos:',
      '- "name": título curto e evocativo da história (3-8 palavras) — em português do Brasil.',
      '- "nameEn": mesmo título traduzido para inglês.',
      '- "storyDescription": INTRODUÇÃO CURTA estilo contracapa de livro (1-2 parágrafos) — apresenta cenário e o gancho inicial do personagem, SEM revelar conflitos, facções, reviravoltas ou desfechos. É o único texto que o jogador vê — em português do Brasil.',
      '- "storyDescriptionEn": mesmo conteúdo de "storyDescription" traduzido para inglês.',
      '- "storyDetails": 3-6 parágrafos com o conteúdo completo da trama — contexto, conflitos, facções, locais e segredos/reviravoltas planejadas. Uso exclusivo do Mestre/narrador, o jogador nunca lê isto — em português do Brasil.',
      '- "storyDetailsEn": mesmo conteúdo de "storyDetails" traduzido para inglês.',
      '- "storyMissions": array com 2 a 5 missões/ganchos de aventura, cada uma com:',
      '  - "title": título curto da missão — em português do Brasil',
      '  - "titleEn": mesmo título em inglês',
      '  - "description": descrição breve do objetivo (1-2 frases) — em português do Brasil',
      '  - "descriptionEn": mesma descrição em inglês',
      '  - "optional": booleano — true para gancho secundário/opcional, false para missão principal',
      '- "storyCharacters": array com 3 a 7 NPCs relevantes para a narrativa, cada um com:',
      '  - "name": nome do personagem',
      '  - "role": papel na história (ex.: antagonista, mentor, aliado, líder de facção, neutro) — em português do Brasil',
      '  - "roleEn": mesmo papel em inglês (ex.: antagonist, mentor, ally, faction leader, neutral)',
      '  - "description": descrição breve do personagem (1-2 frases) — em português do Brasil',
      '  - "descriptionEn": mesma descrição em inglês',
      '  - "status": situação atual na história (ex.: ativo, foragido, morto, desconhecido) — em português do Brasil',
      '  - "statusEn": mesmo status em inglês (ex.: active, fugitive, dead, unknown)',
      '',
      '## Restrições',
      '- Retorne APENAS o JSON, sem preâmbulo, saudação, comentários ou separadores.',
      '- Comece diretamente com { e termine com }.'
    ].join('\n')

    const worldContext = sanitizeInlineText(req.worldGuideContext).slice(0, 3000)
    const prompt = [
      `Nome/contexto da campanha: ${req.campaignName || 'livre'}.`,
      worldContext
        ? `Cenário do mundo (use como base; mantenha nomes, facções, tom e geografia consistentes com ele): ${worldContext}`
        : 'Cenário do mundo: não informado; invente um cenário novo e distinto e evite clichês genéricos (ex.: não cair em motivos de "twilight"/"crepúsculo").'
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

      let parsed: {
        name?: unknown
        nameEn?: unknown
        storyDescription?: unknown
        storyDescriptionEn?: unknown
        storyDetails?: unknown
        storyDetailsEn?: unknown
        storyMissions?: unknown
        storyCharacters?: unknown
      }
      try {
        parsed = JSON.parse(jsonStr)
      } catch {
        // Fallback: retorna texto gerado como storyDescription sem personagens/missões
        return { storyDescription: sanitizeNarrativeOutput(generated), storyMissions: [], storyCharacters: [] }
      }

      const storyDescription = sanitizeNarrativeOutput(
        typeof parsed.storyDescription === 'string' ? parsed.storyDescription : ''
      )
      const storyDescriptionEn = typeof parsed.storyDescriptionEn === 'string' && parsed.storyDescriptionEn.trim()
        ? sanitizeNarrativeOutput(parsed.storyDescriptionEn)
        : undefined

      const storyDetails = typeof parsed.storyDetails === 'string' && parsed.storyDetails.trim()
        ? sanitizeNarrativeOutput(parsed.storyDetails)
        : undefined
      const storyDetailsEn = typeof parsed.storyDetailsEn === 'string' && parsed.storyDetailsEn.trim()
        ? sanitizeNarrativeOutput(parsed.storyDetailsEn)
        : undefined

      const rawMissions = Array.isArray(parsed.storyMissions) ? parsed.storyMissions : []
      const storyMissions: CampaignMission[] = rawMissions
        .slice(0, 5)
        .filter((m): m is Record<string, unknown> => m !== null && typeof m === 'object')
        .map((m) => ({
          title: typeof m.title === 'string' ? m.title.trim() : '',
          titleEn: typeof m.titleEn === 'string' && m.titleEn.trim() ? m.titleEn.trim() : undefined,
          description: typeof m.description === 'string' ? m.description.trim() : '',
          descriptionEn: typeof m.descriptionEn === 'string' && m.descriptionEn.trim() ? m.descriptionEn.trim() : undefined,
          optional: m.optional === true
        }))
        .filter((m) => m.title.length > 0)

      const rawChars = Array.isArray(parsed.storyCharacters) ? parsed.storyCharacters : []
      const storyCharacters: StoryCharacter[] = rawChars
        .slice(0, 7)
        .filter((c): c is Record<string, unknown> => c !== null && typeof c === 'object')
        .map((c) => ({
          name: typeof c.name === 'string' ? c.name.trim() : '',
          role: typeof c.role === 'string' ? c.role.trim() : 'personagem',
          roleEn: typeof c.roleEn === 'string' && c.roleEn.trim() ? c.roleEn.trim() : undefined,
          description: typeof c.description === 'string' ? c.description.trim() : '',
          descriptionEn: typeof c.descriptionEn === 'string' && c.descriptionEn.trim() ? c.descriptionEn.trim() : undefined,
          status: typeof c.status === 'string' ? c.status.trim() : 'desconhecido',
          statusEn: typeof c.statusEn === 'string' && c.statusEn.trim() ? c.statusEn.trim() : undefined,
        }))
        .filter((c) => c.name.length > 0)

      const name = typeof parsed.name === 'string' && parsed.name.trim() ? parsed.name.trim() : undefined
      const nameEn = typeof parsed.nameEn === 'string' && parsed.nameEn.trim() ? parsed.nameEn.trim() : undefined

      return { storyDescription, storyDescriptionEn, storyDetails, storyDetailsEn, storyMissions, storyCharacters, name, nameEn }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido'
      throw new Error(`Falha ao gerar história com ${this.providerLabel}: ${message}`)
    }
  }

  async generateWorldGuide(req: GenerateWorldGuideRequest): Promise<{ worldGuide: WorldGuide }> {
    const sysPrompt = [
      'Você é um designer de universos para RPG de mesa.',
      '',
      '## Objetivo',
      'Crie um guia canônico estruturado para orientar narradores, campanhas e personagens.',
      'O guia substitui lore em prosa: seja específico, operacional e consistente. Não escreva ensaio, conto, cronologia extensa ou markdown.',
      'Não invente segredos de campanha, conspirações ocultas ou revelações futuras como fatos conhecidos. Se algo for mistério, registre em unknownOrSpoilerFacts.',
      'Use apenas português do Brasil.',
      '',
      '## Formato de Saída',
      'Retorne APENAS um objeto JSON válido com exatamente esta chave raiz: "worldGuide".',
      'O objeto worldGuide DEVE seguir exatamente esta forma:',
      '{"worldGuide":{"llmPersona":{"role":"...","perspective":"...","knowledgeLimits":"..."},"universeRules":{"magicAndPowers":["..."],"technology":["..."],"impossibilities":["..."],"costsAndLimits":["..."]},"glossary":{"terms":[{"term":"...","definition":"...","preferredUsage":"...","avoidTerms":["..."]}],"forbiddenGenericTerms":["..."]},"factionsAndPower":{"groups":[{"name":"...","role":"...","publicFace":"...","powerBase":"...","relationships":["..."]}],"socialTensions":["..."],"speciesAndCultures":["..."]},"knowledgeHorizon":{"currentMoment":"...","knownFacts":["..."],"unknownOrSpoilerFacts":["..."]},"geography":{"immediateSetting":"...","keyLocations":["..."],"sensoryTexture":"..."},"mood":{"tone":"...","emotionalPalette":"...","languageStyle":"...","avoidStyle":"..."}}}'
    ].join('\n')

    const currentGuideText = req.currentGuide ? renderWorldGuideMarkdown(req.currentGuide) : ''
    const tema = [
      `Nome: ${req.name}.`,
      ...(req.description ? [`Descrição: ${req.description}.`] : []),
      ...(currentGuideText ? [`Guia atual (mantenha consistência e refine sem perder dados úteis):\n${currentGuideText}`] : []),
      ...(req.userInstruction?.trim()
        ? [
            `Instruções adicionais do usuário para esta geração (use como direcionamento temático sem quebrar o JSON): ${req.userInstruction.trim()}.`
          ]
        : [])
    ].join('\n')

    const prompt = [
      `Tema: ${tema}`,
      '',
      'Gere o WorldGuide canônico deste universo com os 7 blocos obrigatórios:',
      '1. llmPersona: quem é a voz interna autorizada do universo, qual perspectiva usa e o que ela não sabe.',
      '2. universeRules: o que magia/poderes/tecnologia permitem, o que é impossível e quais custos/limites existem.',
      '3. glossary: termos próprios, jargões locais, substituições preferidas e termos genéricos proibidos.',
      '4. factionsAndPower: facções, raças/espécies/culturas e tensões sociais/políticas visíveis.',
      '5. knowledgeHorizon: momento atual, fatos conhecidos e fatos que NÃO devem ser revelados ainda.',
      '6. geography: cenário imediato, locais-chave e textura sensorial concreta.',
      '7. mood: tom, atmosfera emocional, estilo de linguagem e o que evitar.',
      '',
      'Todos os arrays devem ter conteúdo útil, sem preencher com generalidades como "diversas facções" ou "magia poderosa".',
      'Responda somente o JSON.'
    ].join('\n')

    try {
      const generated = await this.generateText(prompt, {
        maxOutputTokens: this.worldMaxOutputTokens,
        timeoutMs: this.timeoutMs,
        systemInstruction: sysPrompt
      })

      try {
        const parsed = parseJsonObjectDetailed(generated)
        if (parsed) {
          return { worldGuide: sanitizeWorldGuideFromRecord(parsed.value, { name: req.name, description: req.description }) }
        }
      } catch {
        // fall through to error below
      }

      throw new Error('Resposta sem JSON válido de worldGuide')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido'
      throw new Error(`Falha ao gerar guia de universo com ${this.providerLabel}: ${message}`)
    }
  }

  async generateImageDescription(req: GenerateImageDescriptionRequest): Promise<string> {
    const sysPrompt = [
      'Você cria descrições visuais curtas para geração de imagem fotográfica.',
      'Saída esperada: um único parágrafo curto, com 1 ou 2 frases, focado em atmosfera, composição, cenário e detalhes visuais memoráveis.',
      'Se o título remeter a filme, série, jogo, quadrinho ou livro conhecido, inspire-se na estética da capa/pôster oficial da obra: paleta predominante, composição, enquadramento e atmosfera visual — sem reproduzir personagens protegidos, atores reais, rostos reconhecíveis, logos, títulos ou marcas.',
      'Se o título não remeter a nenhuma obra conhecida, descreva uma cena épica e original coerente com o nome.',
      'Entregue apenas a descrição visual final, sem listas, markdown, comentários sobre o pedido ou instruções negativas.'
    ].join('\n')

    let prompt = ''

    if (req.entityType === 'world') {
      prompt = [
        `Título do universo: ${req.title}.`,
        'Se este título remeter a uma obra famosa (filme, série, jogo, quadrinho ou livro), baseie TODA a descrição na estética visual característica dessa obra: paleta de cores, composição, atmosfera, iluminação e estilo visual — sem copiar personagens protegidos, atores reais, logos ou marcas. O tema de referência deve guiar todos os elementos visuais da imagem.',
        'Caso contrário, descreva uma cena épica e original com identidade visual forte, coerente com o nome e o tema do universo, capturando sua essência para que a imagem inteira reflita esse universo.',
      ].join('\n')
    } else if (req.entityType === 'campaign') {
      const storyContext = sanitizeInlineText(req.storyDescription).slice(0, 1200)
      prompt = [
        `Título da campanha: ${req.title}.`,
        ...(storyContext
          ? [`História da campanha (traduza seu clima, cenário, facções e elementos visuais principais para a arte): ${storyContext}`]
          : []),
        'Descreva uma imagem ampla que traduza a atmosfera da campanha como uma arte ilustrada marcante e cinematográfica.'
      ].join('\n')
    } else {
      prompt = [
        `Mundo: ${req.worldName}.`,
        `Campanha: ${req.campaignTitle}.`,
        ...(req.gender?.trim() ? [`Gênero: ${req.gender}.`] : []),
        ...(req.race?.trim() ? [`Raça ou espécie: ${req.race}.`] : []),
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
    const worldName = req.worldName?.trim() ?? ''
    const worldGuideText = renderWorldGuideMarkdown(req.worldGuide)
    const worldStyleGuide = buildWorldGuideStyleGuide(req.worldGuide)
    const storyDescription = req.storyDescription?.trim() ?? ''
    const promptWorldGuide = worldGuideText.length > 6000 ? `${worldGuideText.slice(0, 6000)}...` : worldGuideText
    const promptStoryDescription = storyDescription.length > 2800 ? `${storyDescription.slice(0, 2800)}...` : storyDescription
    const creativeIdentityLocked = Boolean(existing.name?.trim())
    const existingLines: string[] = []
    if (hasExisting) {
      existingLines.push(
        'O jogador já preencheu os campos abaixo — MANTENHA esses valores exatamente como estão e preencha apenas os campos faltantes:'
      )
      if (existing.name) existingLines.push(`  name: "${existing.name}"`)
      if (existing.gender) existingLines.push(`  gender: "${existing.gender}"`)
      if (existing.race) existingLines.push(`  race: "${existing.race}"`)
      if (existing.profession) existingLines.push(`  profession: "${existing.profession}"`)
      if (existing.description) existingLines.push(`  description: "${existing.description}"`)
      if (existing.campaignRole) existingLines.push(`  campaignRole: "${existing.campaignRole}"`)
    }

    const sysPrompt = [
      'Você é um designer de personagens.',
      'Leia o nome do mundo, o lore do universo e a história da aventura. Crie um personagem cujo papel e profissão surjam NATURALMENTE desses dados, sem usar arquétipos pré-definidos do sistema.',
      ...buildUniverseStyleInferenceLines({ forCharacterSuggestion: true, explicitGuide: worldStyleGuide }),
      'Responda APENAS em JSON válido, sem markdown ou comentários.',
      'Sempre retorne as 11 chaves; gender, race, genderPt e racePt podem ser string vazia quando o contexto não permitir inferência.',
      '{"name":"...","gender":"...","race":"...","profession":"...","description":"...","campaignRole":"...","genderPt":"...","racePt":"...","professionPt":"...","descriptionPt":"...","campaignRolePt":"..."}',
      '',
      'Instruções de campo:',
      '  name: nome coerente com o contexto; se o jogador forneceu um nome, preserve exatamente esse valor e trate-o apenas como âncora de identidade',
      '  gender: Masculine, Feminine ou Other apenas quando houver pista contextual; caso contrário, string vazia',
      '  race: raça/espécie apenas quando houver pista contextual; caso contrário, string vazia',
      '  profession: ofício ou papel social derivado exclusivamente do nome do mundo, lore e história; máximo 60 caracteres',
      '  description: 2-3 frases derivadas principalmente da história e do lore, descrevendo aparência física (cabelo, olhos, porte ou cicatriz marcante), roupa ou equipamento coerente com a profissão e traço de personalidade com motivação. Mínimo 80, máximo 280 caracteres.',
      '  campaignRole: o que este personagem faz nesta aventura específica, sua missão, ou como se conecta à trama. Derive de história/lore, seja concreto e não genérico. Máximo 600 caracteres.',
      '  genderPt: tradução para português do Brasil de gender (Masculino, Feminino ou Outro); string vazia se gender estiver vazio',
      '  racePt: tradução para português do Brasil de race/espécie; string vazia se race estiver vazio',
      '  professionPt: tradução para português do Brasil de profession; máximo 60 caracteres',
      '  descriptionPt: tradução para português do Brasil de description; mesmos limites de tamanho (mínimo 80, máximo 280 caracteres)',
      '  campaignRolePt: tradução para português do Brasil de campaignRole; máximo 600 caracteres',
      'Se um nome for fornecido, não invente a descrição pelo som do nome; use o nome apenas para preservar identidade e derive todo o restante da história da aventura e do lore.',
      'Em chamadas repetidas para a mesma trama, varie nome, profissão, função narrativa, motivação, aparência e ponto de entrada na aventura.',
    ].join('\n')

    const buildPrompt = (attempt: number): string => {
      return [
        ...(existingLines.length > 0 ? [...existingLines, ''] : []),
        ...(creativeIdentityLocked ? [] : [buildNameDiversityLine(), '']),
        `Tentativa de variação: ${attempt}.`,
        '',
        ...(worldName ? [`Nome do mundo/universo: ${worldName}.`] : []),
        ...(promptWorldGuide ? [`Guia canônico do universo:\n${promptWorldGuide}`, ''] : []),
        ...(promptStoryDescription ? [`História da aventura: ${promptStoryDescription}.`, ''] : []),
        'Derive profissão e papel apenas do guia canônico do universo.'
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
          temperature: this.temperature,
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
          lastIssues = [
            ...(truncatedJson ? ['truncado'] : []),
            ...firstTryIssues
          ]

          if (!truncatedJson && firstTryIssues.length === 0) {
            return firstTry
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

  async suggestCharacterFromDescription(req: SuggestCharacterFromDescriptionRequest): Promise<SuggestedCharacter> {
    const characterConcept = req.characterConcept?.trim() ?? ''
    const worldName = req.worldName?.trim() ?? ''
    const worldGuideText = renderWorldGuideMarkdown(req.worldGuide)
    const worldStyleGuide = buildWorldGuideStyleGuide(req.worldGuide)
    const campaignThematic = req.campaignThematic?.trim() ?? ''
    const storyDescription = req.storyDescription?.trim() ?? ''
    const promptWorldGuide = worldGuideText.length > 4000 ? `${worldGuideText.slice(0, 4000)}...` : worldGuideText
    const promptStory = storyDescription.length > 2000 ? `${storyDescription.slice(0, 2000)}...` : storyDescription

    const sysPrompt = [
      'Você é um designer de personagens para RPG de mesa.',
      'O jogador escreveu um conceito livre descrevendo o personagem que deseja criar.',
      'Sua tarefa é expandir esse conceito em um perfil completo de personagem que se encaixe no contexto de mundo e campanha.',
      ...buildUniverseStyleInferenceLines({ forCharacterSuggestion: true, explicitGuide: worldStyleGuide }),
      'Responda APENAS em JSON válido, sem markdown ou comentários.',
      'Sempre retorne as 11 chaves; gender, race, genderPt e racePt podem ser string vazia quando não forem mencionados nem inferíveis.',
      '{"name":"...","gender":"...","race":"...","profession":"...","description":"...","campaignRole":"...","genderPt":"...","racePt":"...","professionPt":"...","descriptionPt":"...","campaignRolePt":"..."}',
      '',
      'Instruções de campo:',
      '  name: nome apropriado e coerente com o conceito e o mundo; se o jogador mencionou um nome, use-o',
      '  gender: Masculine, Feminine ou Other apenas quando mencionado ou claramente implícito; caso contrário, string vazia',
      '  race: raça/espécie apenas quando mencionada ou inferível do conceito; caso contrário, string vazia',
      '  profession: ofício ou papel social derivado do conceito do jogador; máximo 60 caracteres',
      '  description: 2-3 frases expandindo o conceito com aparência física (cabelo, olhos, porte ou cicatriz marcante), roupa ou equipamento coerente com a profissão e traço de personalidade com motivação. Mínimo 80, máximo 280 caracteres.',
      '  campaignRole: o que este personagem faz no mundo, sua missão, ou como se conecta ao cenário. Concreto e específico, não genérico. Máximo 600 caracteres.',
      '  genderPt: tradução para português do Brasil de gender (Masculino, Feminino ou Outro); string vazia se gender estiver vazio',
      '  racePt: tradução para português do Brasil de race/espécie; string vazia se race estiver vazio',
      '  professionPt: tradução para português do Brasil de profession; máximo 60 caracteres',
      '  descriptionPt: tradução para português do Brasil de description; mesmos limites de tamanho (mínimo 80, máximo 280 caracteres)',
      '  campaignRolePt: tradução para português do Brasil de campaignRole; máximo 600 caracteres',
    ].join('\n')

    const userPrompt = [
      `Conceito do jogador: ${characterConcept}`,
      '',
      ...(worldName ? [`Mundo/universo: ${worldName}.`] : []),
      ...(campaignThematic ? [`Temática da campanha: ${campaignThematic}.`] : []),
      ...(promptStory ? [`História da aventura: ${promptStory}`] : []),
      ...(promptWorldGuide ? [`Guia canônico do universo:\n${promptWorldGuide}`] : []),
      '',
      buildNameDiversityLine(true),
      'Expanda o conceito do jogador em um perfil completo de personagem seguindo o schema JSON acima.',
    ].join('\n')

    try {
      let lastIssues: string[] = []

      for (let attempt = 1; attempt <= 3; attempt++) {
        const result = await this.generateTextDetailed(userPrompt, {
          maxOutputTokens: this.characterSuggestionMaxOutputTokens,
          timeoutMs: this.timeoutMs,
          responseMimeType: 'application/json',
          temperature: this.temperature,
          systemInstruction: sysPrompt,
          ...(this.provider === 'gemini' ? { thinkingBudget: this.characterSuggestionThinkingBudget } : {})
        }, attempt)

        log('suggestCharacterFromDescription', `LLM raw response (attempt=${attempt}):`, result.text)

        const parsedJson = parseJsonObjectDetailed(result.text)
        const parsed = parsedJson?.value ?? null

        if (parsed) {
          const character = buildSuggestedCharacterFromRecord(parsed)
          const truncated = result.finishReason === 'MAX_TOKENS' && parsedJson?.source !== 'direct'
          const issues = getSuggestedCharacterIssues(character)
          lastIssues = [...(truncated ? ['truncado'] : []), ...issues]

          if (!truncated && issues.length === 0) {
            return character
          }

          warn('suggestCharacterFromDescription', `Tentativa insuficiente (attempt=${attempt}, issues=${lastIssues.join(', ')})`)
        } else {
          lastIssues = ['resposta sem objeto legivel']
          warn('suggestCharacterFromDescription', `Tentativa sem parse legivel (attempt=${attempt})`)
        }
      }

      throw new Error(`Resposta incompleta ou fora do JSON esperado (${lastIssues.join(', ') || 'sem detalhe'})`)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido'
      throw new Error(`Falha ao gerar personagem com ${this.providerLabel}: ${message}`)
    }
  }

  // ─── Narrative Chat Methods ───

  private getCachedNarratorSystemPrompt(opts: {
    world?: { name?: string; description?: string; worldGuide?: WorldGuide }
    campaign?: { name?: string; storyDescription?: string; storyDetails?: string; storyMissions?: CampaignMission[] }
    rulesDigest?: string
    summaryText?: string
    playerSkills?: Record<string, string>
    mode?: NarratorPromptMode
    narrativeStyle?: 'concise' | 'balanced'
    simpleVocabulary?: boolean
  } = {}): string {
    const key = JSON.stringify({
      wn: opts.world?.name,
      wd: opts.world?.description,
      wg: opts.world?.worldGuide,
      cn: opts.campaign?.name,
      cs: opts.campaign?.storyDescription,
      cd: opts.campaign?.storyDetails,
      cm: opts.campaign?.storyMissions,
      rd: opts.rulesDigest,
      st: opts.summaryText,
      ps: opts.playerSkills
        ? Object.fromEntries(Object.entries(opts.playerSkills).sort(([a], [b]) => a.localeCompare(b)))
        : undefined,
      mode: opts.mode,
      ns: opts.narrativeStyle,
      sv: opts.simpleVocabulary,
    })

    const cached = this.narratorPromptCache.get(key)
    if (cached) return cached

    const prompt = this.buildNarratorSystemPrompt(opts)

    if (this.narratorPromptCache.size >= GeminiAdapter.PROMPT_CACHE_MAX) {
      const firstKey = this.narratorPromptCache.keys().next().value
      if (firstKey !== undefined) this.narratorPromptCache.delete(firstKey)
    }
    this.narratorPromptCache.set(key, prompt)
    return prompt
  }

  /**
   * Monta o system prompt do narrador.
   * Inclui regras fixas, formato JSON, dados do mundo E (opcionalmente) rulesDigest,
   * resumo da aventura e perícias do jogador — tudo que é (quase) estático entre turnos.
   */
  private buildNarratorSystemPrompt(opts: {
    world?: { name?: string; description?: string; worldGuide?: WorldGuide }
    campaign?: { name?: string; storyDescription?: string; storyDetails?: string; storyMissions?: CampaignMission[] }
    rulesDigest?: string
    summaryText?: string
    playerSkills?: Record<string, string>
    mode?: NarratorPromptMode
    narrativeStyle?: 'concise' | 'balanced'
    simpleVocabulary?: boolean
  } = {}): string {
    const { world, campaign, rulesDigest, summaryText, playerSkills, mode = 'turn', narrativeStyle, simpleVocabulary } = opts
    const lines = [
      'Você é o Narrador de uma história de RPG. Responda em português do Brasil, sempre na segunda pessoa do singular ("Você entra...", "Você vê...").',
      '',
      '## Hierarquia Canônica — Leia Isto Primeiro',
      'Há duas camadas de contexto neste prompt:',
      '1. **Contexto pré-escrito** (Universo, Campanha): material de fundo — o cenário pretendido e o arco de história planejado. Use-o para tom, vocabulário e coerência do mundo.',
      '2. **Histórico jogado** (Resumo da Aventura + mensagens recentes): o registro autoritativo do que REALMENTE aconteceu durante o jogo. É a única fonte de verdade para fatos do jogo.',
      '**Regra:** quando houver QUALQUER conflito entre o contexto pré-escrito e o histórico jogado, o histórico jogado SEMPRE vence — nunca use Universo ou Campanha para contradizer eventos já estabelecidos.',
      'NUNCA redirecione a história de volta ao arco planejado se o jogador já se desviou dele — a história emergente É a história.',
      '',
      '## Estrutura da Resposta: Segments e Story Hook',
      'A resposta tem DUAS camadas narrativas: segments mostram a consequência imediata da ação atual; options mostram o próximo movimento possível.',
      'Os segments cobrem apenas a consequência imediata da ação — param quando ela fica visível.',
      'Toda opção do jogador deve nascer do estado recém-criado neste turno e permanecer fora dos segments.',
      '',
      '## NPCs em Cena',
      'Qualquer NPC que apareça, intervenha, ataque ou fale neste turno deve ser declarado em npcs[] com newlyIntroduced=true, e um segment do tipo "npc" só deve existir quando houver fala literal em voz alta.',
      '',
      '### Persona do NPC',
      'Ao escrever um segment do tipo "npc" (ou qualquer fala/reação atribuída a ele), baseie tom, vocabulário e escolha de palavras nos campos personality, motivation e speechPattern desse NPC em NPCS PRESENTES (quando preenchidos). Um NPC arrogante fala diferente de um NPC covarde; um NPC com motivação de vingança reage diferente de um leal. Mantenha essa voz consistente turno após turno — não apenas na primeira aparição do NPC.',
      '',
      '## Esquema JSON de Saída',
      'Você DEVE retornar APENAS um JSON válido (sem markdown, sem comentários) com a seguinte estrutura:',
      '```json',
      '{',
      '  "segments": [',
      '    { "type": "narrator", "text": "<narração, descrição de contexto, ou consequência>" },',
      '    { "type": "npc", "npcDisplayName": "<nome amigável do NPC, igual ao usado em npcs[]>", "npcId": "<id hash se o NPC já estiver presente; senão o handle temporário de npcs[]>", "disposition": "hostile|neutral|friendly", "text": "<apenas as palavras literais que o NPC fala em voz alta — INCLUA este segment SOMENTE quando um NPC realmente fala neste turno>" }',
      '  ],',
      '  "options": [',
      '    {',
      '      "text": "<descrição narrativa da opção (rótulo da ação, 1 frase curta)>",',
      '      "actionType": "<tipo mecânico da ação: custom|attack|travel|flag|heal>",',
      '      "actionPayload": { <campos parciais para montar a ação mecânica> },',
      '      "chanceCheck": {',
      '        "reason": "<justificativa de por que esta ação é resolvida de forma puramente narrativa>"',
      '      }',
      '    }',
      '  ],',
      '  "npcs": [',
      '    { "displayName": "<nome amigável exibido ao jogador>", "id": "<copie o hash de NPCS PRESENTES se já estiver presente; omita para NPCs novos>", "disposition": "hostile|neutral|friendly", "newlyIntroduced": true|false, "status": "active|incapacitated|defeated|dead|left", "followsPlayer": true|false, "relation": "conhecido|aliado|amigavel|neutro|desconfiado|hostil|inimigo" }',
      '  ],',
      '  "itemChanges": [',
      '    { "itemId": "<uuid>", "name": "<nome do item>", "quantity": 1, "changeType": "gained|lost|used", "description": "<o que é / o que contém / para que serve — para itens não óbvios; omitir para triviais>", "category": "weapon|armor|consumable|ammunition|money|vehicle|property|quest|misc", "armorValue": <1-4 ou omitir>, "parryBonus": <1-2 ou omitir> }',
      '  ],',
      '  "statusChanges": [',
      '    { "effectId": "<uuid>", "name": "<nome do efeito>", "changeType": "applied|removed", "turnsRemaining": 3, "description": "<descrição>", "targetType": "player|npc", "targetId": "<id do NPC quando targetType=npc, ou null>" }',
      '  ],',
      '  "outcomeOverride": { "mechanicalResult": "success|failure", "narratedOutcome": "success|failure", "justification": "<causa narrativa da inversão>" } | null',
      '}'
,
      '```',
      '',
      '## Regras do Campo chanceCheck',
      '**Obrigatório em toda option.** Preencha apenas "reason" (1 frase justificando por que a ação é resolvida de forma puramente narrativa). Os campos "required" e "successChance" estão desativados — ignore-os.',
      '',
      '## Regras Gerais',
      '',
      '### Segments',
      'Os "segments" carregam a NARRAÇÃO deste turno — a prosa que descreve o que aconteceu como consequência da ação do jogador.',
      '- type="narrator" é o PADRÃO e carrega TODA a prosa/descrição/ação/consequência.',
      '- type="npc" carrega APENAS as palavras literais faladas em voz alta por um NPC — inclua um segment "npc" SOMENTE quando um NPC realmente fala neste turno.',
      '',
      '### Ritmo e Movimento da História',
      '- Se o jogador ficar estagnado por 2+ turnos no mesmo estado, introduza um evento dinâmico inevitável que force mudança. Ações tentadas são consumidas — avance a história, nunca retorne ao status quo.',
      '',
      '### Options',
      'Array obrigatório, sempre 4 opções. O próximo movimento NUNCA é narrado nos segments — apenas aqui.',
      '- 4 opções categoricamente distintas. Adapte quando a cena restringir alguma categoria.',
      '- Só ofereça ações executáveis AGORA. não reutilize menus anteriores. Nunca mencione objetos ou entidades que não apareceram na narração deste turno.',
      '- Travel: em conflito imediato, destine a locais imediatos da cena (não destinos geográficos distantes). Narre deslocamentos por ambiente vazio em elipse — chegue direto ao próximo ponto de interesse.',
      '- Sem ação placebo (ex.: "Observar os arredores"). Sem repetição de ações já tentadas. Itens recém-adquiridos (changeType "gained") já pertencem ao jogador — não ofereça opção de coletá-los.',
      '',
      '### Itens (itemChanges)',
      '- Nomes simples e mundanos — nunca inclua quantidade no campo "name" (use "quantity"). Todo item DEVE ter "category": weapon|armor|consumable|ammunition|money|vehicle|property|quest|misc.',
      '- changeType "gained": apenas quando a cena estabelece a aquisição explicitamente. changeType "lost"/"used": quando a narrativa deste turno descreve a perda/destruição, ou o resultado mecânico indica [item_lost]/[item_used]. ⚠️ Perda narrada sem registro em itemChanges = bug (item permanece no inventário).',
      '- Itens duráveis (weapon, armor, vehicle, etc.) NÃO se gastam com uso — só saem com perda explícita. Só consumable/ammunition saem com "used".',
      '- Itens não óbvios (quest, recipientes, dispositivos, chaves): preencha "description" (1-2 frases: o que é, para que serve). Itens autoexplicativos: omita "description".',
      '- Munição: sempre em unidades individuais (quantity=30, nunca "1 caixa"). Registre "used" somente em ações "attack". Armas à distância sempre têm munição como item separado.',
      '- category "armor" ganho: EXATAMENTE UM campo — "armorValue" (1-4, armadura corporal) OU "parryBonus" (1-2, escudo empunhado). Nunca ambos.',
      '',
      '### Estilo e Restrições Finais',
      '- Não repita a mesma narrativa. Avance a história a cada turno.',
      '- Os textos das opções devem ter no máximo 1 frase curta cada.',
      '- Não adicione campos extras além dos especificados acima.'
    ]

    // ─── NARRATIVE STYLE (defined here, before the context, for maximum weight) ───
    lines.push('')
    if (narrativeStyle === 'concise') {
      lines.push(
        '## Tamanho da Narração: Conciso (Obrigatório)',
        'MÁXIMO 2 frases CURTAS. 1 único parágrafo.',
        'As frases devem ser CURTAS e DIRETAS — sem orações encadeadas por vírgula.',
        'Qualquer resposta com mais de 2 frases viola esta instrução.',
        'ESTILO: simples e factual. Diga o que acontece — sem preâmbulo atmosférico ou de ambientação.',
        'Aberturas PROIBIDAS: descrições de silêncio, som, cheiro, luz ou ar ("O silêncio...", "Um zumbido...", "O ar..."). Comece pelo fato concreto ou pela consequência da ação.',
        'Sem metáforas poéticas e sem personificação de objetos ou ambiente. Nomeie as coisas diretamente.'
      )
    } else if (narrativeStyle === 'balanced') {
      lines.push(
        '## Tamanho da Narração: Equilibrado (Obrigatório)',
        'ENTRE 2 e 4 frases distribuídas em 1 ou 2 parágrafos.',
        'Parágrafo 1: consequência concreta da ação + reação do NPC.',
        'Parágrafo 2: gancho ou tensão para o próximo turno.'
      )
    } else {
      lines.push(
        '## Tamanho da Narração: Padrão (Obrigatório)',
        'MÁXIMO 3 frases CURTAS. 1 único parágrafo.',
        'As frases devem ser CURTAS e DIRETAS — sem orações encadeadas por vírgula.',
        'Qualquer resposta com mais de 3 frases viola esta instrução.'
      )
    }

    // ─── VOCABULÁRIO SIMPLES ───
    if (simpleVocabulary === true) {
      lines.push(
        '',
        '## Vocabulário Simples (Ativo)',
        'Use APENAS palavras simples e comuns. Evite termos arcaicos, poéticos ou complexos.',
        'Prefira: "rosto" em vez de "semblante"; "antigo" em vez de "outrora"; "medo" em vez de "pavor visceral".'
      )
    }

    // ─── REGRA: NARRAÇÃO DE INCAPACITAÇÃO (não se aplica à abertura de sessão — personagem começa ileso) ───
    if (mode !== 'start') {
      lines.push(
        '',
        '## Incapacitação',
        'Se o personagem está Incapacitado (wounds >= maxWounds, ou seja, 4+ ferimentos),',
        'a narrativa DEVE refletir isso explicitamente: descreva o colapso, a escuridão, a luta pela consciência.',
        'As opções devem ser consistentes com a condição (ex.: "Lutar pela sobrevivência", "Perder a consciência", "Pedir ajuda").',
        'NÃO ofereça ações normais de combate, exploração ou diálogo quando o personagem está incapacitado.'
      )
    }

    // Injeta o contexto do universo (lore macro — fixo durante toda a sessão)
    if (world && (world.description || world.worldGuide)) {
      const worldDescriptionForPrompt = mode === 'start'
        ? truncateForPrompt(world.description, 260)
        : world.description
      const worldGuideForPrompt = renderWorldGuideMarkdown(world.worldGuide)

      lines.push(
        '',
        '## Universo',
        'As seções abaixo são a bíblia canônica deste universo.',
        'Mesmo que o texto abaixo esteja em outro idioma, sua resposta (segments, options) DEVE ser sempre em português do Brasil — traduza mentalmente antes de narrar.',
        `Nome: ${world.name ?? 'Sem nome'}`,
        ...(worldDescriptionForPrompt ? [`Descrição: ${worldDescriptionForPrompt}`] : []),
        ...(worldGuideForPrompt ? ['', worldGuideForPrompt] : [])
      )

      lines.push('', ...buildUniverseStyleInferenceLines({
        concise: narrativeStyle === 'concise',
        explicitGuide: buildWorldGuideStyleGuide(world.worldGuide)
      }))
    }

    // Injeta o contexto da campanha (história específica)
    if (campaign && (campaign.storyDescription || campaign.storyDetails)) {
      lines.push(
        '',
        '## Campanha (Arco Planejado — Apenas Contexto de Fundo)',
        'Apenas temática e cor do mundo — não um roteiro (ver Hierarquia Canônica).',
        `Nome: ${campaign.name ?? 'Sem nome'}`,
        ...(campaign.storyDescription ? [`Introdução: ${campaign.storyDescription}`] : [])
      )

      if (campaign.storyDetails) {
        lines.push(
          '',
          '### Detalhes Estratégicos (uso interno do narrador — não revelar diretamente ao jogador)',
          campaign.storyDetails
        )
      }

      if (campaign.storyMissions && campaign.storyMissions.length > 0) {
        lines.push(
          '',
          '### Missões/Ganchos Disponíveis',
          ...campaign.storyMissions.map((m) => `- [${m.optional ? 'Opcional' : 'Principal'}] ${m.title}: ${m.description}`)
        )
      }
    }

    // Inject rules digest (nearly static — only changes if edges/hindrances change)
    if (rulesDigest) {
      lines.push('', rulesDigest)
    }

    // Player skill levels — listed explicitly so the LLM knows which dice the character has trained
    if (playerSkills && Object.keys(playerSkills).length > 0) {
      const skillLines = Object.entries(playerSkills)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, die]) => `${label}: ${die}`)
      lines.push(
        '',
        '## Perícias do Personagem',
        'Estas são as perícias treinadas do personagem com seu dado atual. Use-as ao sugerir opções trait_test — prefira perícias que o personagem realmente treinou.',
        ...skillLines
      )
    }

    // Resumo da aventura até agora
    if (summaryText) {
      lines.push(
        '',
        '## Resumo da Aventura (Cânone Estabelecido)',
        '⚠️ Cânone autoritativo do que já aconteceu — construa a partir daqui; nunca contradiga.',
        summaryText
      )
    }

    if (mode === 'start') {
      lines.push('', '## Regras de Início de Sessão')
      if (!campaign) {
        lines.push(
          '- O personagem acorda SEM MEMÓRIA em local desconhecido — esse é o mistério central. Não exponha histórico, vínculos ou objetivos prévios; profissão, raça e itens são pistas que ele redescobre sobre si mesmo.',
          '- Foque em percepção imediata e concreta. Evite termos analíticos como fato ("cerco biológico", "protocolo de quarentena") — trate como hipótese ("parece", "talvez").'
        )
      } else {
        lines.push(
          '- O personagem mantém memória e identidade completas — SEM amnésia. Ele conhece seu nome, profissão, raça e passado normalmente.',
          '- Abra a cena já em movimento, ancorada no gancho da campanha (Introdução/Missões acima) — o personagem está em cena vivendo o início do enredo, não acordando em local desconhecido.'
        )
      }
      lines.push(
        '- Preencha itemChanges com changeType "gained" para dar o kit inicial (4-8 itens coerentes) narrados como pertences que o personagem já possui ao início da aventura.'
      )
    } else {
      lines.push(
        '',
        '## Regras do Turno Canônico',
        '',
        '### Contagem de NPCs',
        '- CONTAGEM OBRIGATÓRIA: crie uma entrada separada em npcs[] para cada NPC mencionado por número ("dois agentes" → dois displayNames distintos, ex.: "Agente #1", "Agente #2"). Grupos sem número explícito → mínimo 2-3 entradas.',
        '',
        '### Status Effects',
        '- statusChanges "applied": só para efeitos narrativos (veneno, maldição, medo). NUNCA registre Abalado, Ferido, Fadiga — gerenciados pelo motor. Use targetType "npc" + targetId para efeitos em inimigos.',
        '- statusChanges "removed": só para efeitos listados em EFEITOS ATIVOS, usando effectId/nome exatos. Em saltos temporais longos, registre remoções explícitas em vez de confiar em turnsRemaining.',
        '',
        '### Referências e Evidência',
        '- Para actionPayload.targetId, referencie NPCs já listados em NPCS PRESENTES (pelo seu id hash) ou NPCs novos desta narrativa (pelo handle de id temporário ou displayName exato que você registrou em "npcs").',
        '- Se faltar evidência canônica para uma mutação de estado, deixe os campos mutáveis vazios/null.',
        '- Se algum NPC for derrubado, não o inclua em turnos subsequentes. Descreva-o como derrubado, fugindo, ou caindo, mas não o mantenha como alvo de ações futuras.'
      )
    }

    // Instruções estáticas de narração
    lines.push(
      '',
      '## Instruções de Narração',
      '- Você decide sucesso/falha com base nas perícias do personagem (d10/d12 = quase sempre sucesso; d4 em situação difícil = falha plausível). Nunca force roteiro ou ignore as perícias.',
      '- Sucesso: consequência positiva concreta. Raise (d10+ em ação de maestria): benefício extra inesperado. Falha: o que falhou + Fail Forward — algo muda no mundo, nunca estagnação ("nada acontece").',
      '',
    )

    return lines.join('\n')
  }

  private sanitizeNarratorResponse(
    raw: Record<string, unknown>,
    opts: SanitizedNarratorResponseOptions = {}
  ): NarratorTurnResponse {
    const { allowNarrativeFallback = true, presentNpcs = [] } = opts
    const narrativeFallback = typeof raw.narrative === 'string'
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
      // Perícia/atributo não vêm mais em actionPayload — só em diceCheck (via traco).
      delete actionPayload.skill
      delete actionPayload.attribute

      let diceCheck = candidate.diceCheck
        ? { ...candidate.diceCheck, reason: sanitizeInlineText(candidate.diceCheck.reason, '') }
        : null

      // attack sempre exige resolução por chanceCheck
      if (candidate.actionType === 'attack' && diceCheck) {
        const normalizedChance = typeof diceCheck.successChance === 'number' && Number.isFinite(diceCheck.successChance)
          ? Math.min(100, Math.max(0, Math.round(diceCheck.successChance)))
          : null
        diceCheck = {
          ...diceCheck,
          required: true,
          successChance: normalizedChance ?? 50,
          reason: diceCheck.reason.trim() || 'Ataque com desfecho incerto'
        }
      }

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

      // Parse chanceCheck (novo formato — successChance + required + reason)
      let diceCheck: DiceCheck | null = null
      const rawChance = o.chanceCheck && typeof o.chanceCheck === 'object' && !Array.isArray(o.chanceCheck)
        ? o.chanceCheck as Record<string, unknown>
        : null
      if (rawChance) {
        let required = rawChance.required === true
        const successChance = typeof rawChance.successChance === 'number' && Number.isFinite(rawChance.successChance)
          ? Math.min(100, Math.max(0, Math.round(rawChance.successChance)))
          : null
        // Se required=true mas successChance inválido, força required=false
        if (required && typeof successChance !== 'number') {
          required = false
        }
        diceCheck = {
          required,
          successChance: required ? successChance : null,
          reason: sanitizeInlineText(rawChance.reason, '')
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
        diceCheck
      })
    }

    // Pós-processamento: garantir coerência de chanceCheck em todas as opções
    for (const option of options) {
      if (!option.diceCheck) continue

      // Ataque sempre requer chanceCheck válido para evitar inconsistência estrutural.
      if (option.actionType === 'attack') {
        const normalizedChance = typeof option.diceCheck.successChance === 'number' && Number.isFinite(option.diceCheck.successChance)
          ? Math.min(100, Math.max(0, Math.round(option.diceCheck.successChance)))
          : null
        if (!option.diceCheck.required || normalizedChance === null || !option.diceCheck.reason.trim()) {
          warn('sanitizeNarratorResponse', `Ataque com chanceCheck inválido reparado: "${option.text}"`)
        }
        option.diceCheck = {
          required: true,
          successChance: normalizedChance ?? 50,
          reason: option.diceCheck.reason.trim() || 'Ataque com desfecho incerto'
        }
        continue
      }

      // Travel nunca requer chance de sucesso — é ação narrativa automática
      if (option.actionType === 'travel' && option.diceCheck.required) {
        warn('sanitizeNarratorResponse', `Travel com required=true corrigido para false: "${option.text}"`)
        option.diceCheck = { ...option.diceCheck, required: false, successChance: null }
      }

      // Ações triviais não requerem resolução
      if (option.diceCheck.required && (option.actionType === 'custom' || option.actionType === 'chance_check')) {
        const trivial = classifyTrivialAction(option.text)
        if (trivial.trivial) {
          warn('sanitizeNarratorResponse', `Opção trivial com required=true corrigida: "${option.text}"`)
          option.diceCheck = { ...option.diceCheck, required: false, successChance: null, reason: trivial.reason }
          if (option.actionType === 'chance_check') option.actionType = 'custom'
        }
      }
    }

    // Garantir que toda opção tenha diceCheck com reason não-vazio (requisito estrutural)
    for (const option of options) {
      if (!option.diceCheck) {
        option.diceCheck = { required: false, reason: 'Ação narrativa sem resolução' }
      } else if (!option.diceCheck.reason.trim()) {
        option.diceCheck = { ...option.diceCheck, reason: option.diceCheck.required ? 'Ação com resultado incerto' : 'Ação sem custo mecânico' }
      }
    }

    // Parse NPCs.
    // Modelo: o LLM fornece `displayName` (nome amigável exibido ao jogador). O
    // identificador `id` é um hash estável gerado pelo sistema a partir do
    // displayName — exceto quando o NPC já está presente na cena, caso em que
    // preservamos o id existente (continuidade). `name` é mantido como alias de
    // displayName por retrocompatibilidade.
    const presentById = new Map(presentNpcs.map((n) => [n.id, n.id]))
    const presentByName = new Map<string, string>()
    for (const n of presentNpcs) {
      const key = normalizeMentionKey(n.name)
      if (key && !presentByName.has(key)) presentByName.set(key, n.id)
    }

    // Tabelas de remapeamento das referências cruzadas do LLM (id "cru" do LLM
    // ou nome) → id final estável. Usadas para segments, npcAttacks e targetId.
    const rawIdToFinal = new Map<string, string>()
    const nameToFinal = new Map<string, string>()

    const rawNpcs = Array.isArray(raw.npcs) ? raw.npcs : []
    const npcs: NPCMention[] = rawNpcs.map((n: unknown) => {
      const npc = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>
      const status = ['active', 'incapacitated', 'defeated', 'dead', 'left'].includes(npc.status as string)
        ? (npc.status as NPCMention['status'])
        : undefined
      const followsPlayer = typeof npc.followsPlayer === 'boolean' ? npc.followsPlayer : undefined
      const relation = ['conhecido', 'aliado', 'amigavel', 'neutro', 'desconfiado', 'hostil', 'inimigo'].includes(npc.relation as string)
        ? (npc.relation as NPCMention['relation'])
        : undefined
      // Aceita `displayName` (novo) com fallback para `name` (legado).
      const displayName = sanitizeInlineText(
        (typeof npc.displayName === 'string' ? npc.displayName : npc.name) as string,
        'Desconhecido'
      )
      const nameKey = normalizeMentionKey(displayName)
      const rawId = typeof npc.id === 'string' && npc.id.trim() ? npc.id.trim() : undefined

      // Resolve o id final preservando continuidade.
      let finalId: string
      if (rawId && presentById.has(rawId)) {
        finalId = rawId
      } else if (nameKey && presentByName.has(nameKey)) {
        finalId = presentByName.get(nameKey)!
      } else {
        finalId = npcIdFromDisplayName(displayName)
      }

      if (rawId) rawIdToFinal.set(rawId, finalId)
      if (nameKey) nameToFinal.set(nameKey, finalId)

      return {
        id: finalId,
        name: displayName,
        displayName,
        disposition: (['hostile', 'neutral', 'friendly'].includes(npc.disposition as string) ? npc.disposition : 'neutral') as NPCMention['disposition'],
        newlyIntroduced: typeof npc.newlyIntroduced === 'boolean' ? npc.newlyIntroduced : true,
        ...(status ? { status } : {}),
        ...(followsPlayer !== undefined ? { followsPlayer } : {}),
        ...(relation ? { relation } : {})
      }
    })

    const npcById = new Map(npcs.map((npc) => [npc.id, npc]))
    const npcsByName = new Map<string, NPCMention[]>()
    for (const npc of npcs) {
      const key = normalizeMentionKey(npc.displayName)
      npcsByName.set(key, [...(npcsByName.get(key) ?? []), npc])
    }

    /**
     * Remapeia uma referência do LLM (id "cru" ou nome) para o id final estável.
     * Retorna undefined quando não há correspondência conhecida.
     */
    const resolveNpcRef = (ref: string | null | undefined): string | undefined => {
      const trimmed = typeof ref === 'string' ? ref.trim() : ''
      if (!trimmed) return undefined
      if (rawIdToFinal.has(trimmed)) return rawIdToFinal.get(trimmed)
      if (npcById.has(trimmed)) return trimmed
      const byName = nameToFinal.get(normalizeMentionKey(trimmed))
      if (byName) return byName
      if (presentById.has(trimmed)) return trimmed
      return undefined
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
        // Aceita `npcDisplayName` (novo) com fallback para `npcName` (legado).
        const rawNpcName = sanitizeInlineText(
          (typeof source.npcDisplayName === 'string' ? source.npcDisplayName : source.npcName) as string,
          ''
        )
        // Resolve a referência (id cru ou nome) para o id final estável.
        const resolvedId = resolveNpcRef(rawNpcId) ?? resolveNpcRef(rawNpcName)
        let matchedNpc = resolvedId ? npcById.get(resolvedId) : undefined
        const disposition = (['hostile', 'neutral', 'friendly'].includes(source.disposition as string)
          ? source.disposition
          : matchedNpc?.disposition ?? 'neutral') as NPCMention['disposition']

        // Fix C: se o LLM escreveu fala de NPC mas esqueceu de registrá-lo em npcs[],
        // auto-criar o NPCMention para que syncNarratorNpcs possa populá-lo no GameState.
        if (!matchedNpc && (rawNpcId || rawNpcName)) {
          const autoName = rawNpcName || rawNpcId || 'Desconhecido'
          // Gera id estável a partir do nome (preservando id de NPC presente, se houver).
          const autoId = resolveNpcRef(rawNpcId) ?? npcIdFromDisplayName(autoName)
          matchedNpc = { id: autoId, name: autoName, displayName: autoName, disposition, newlyIntroduced: true }
          npcs.push(matchedNpc)
          npcById.set(autoId, matchedNpc)
          const nameKey = normalizeMentionKey(autoName)
          npcsByName.set(nameKey, [...(npcsByName.get(nameKey) ?? []), matchedNpc])
          nameToFinal.set(nameKey, autoId)
          if (rawNpcId) rawIdToFinal.set(rawNpcId, autoId)
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
          npcName: matchedNpc.displayName ?? matchedNpc.name,
          npcDisplayName: matchedNpc.displayName ?? matchedNpc.name,
          disposition: matchedNpc.disposition,
          text
        })
        continue
      }

      pushNarratorSegment(text)
    }

    if (!segments.length && narrativeFallback) {
      pushNarratorSegment(narrativeFallback)
    }

    // Parse item changes
    const VALID_ITEM_CATEGORIES = new Set(['weapon', 'armor', 'consumable', 'ammunition', 'money', 'vehicle', 'property', 'quest', 'misc'])
    const rawItems = Array.isArray(raw.itemChanges) ? raw.itemChanges : []
    const parsedItems: ItemChange[] = rawItems.map((it: unknown) => {
      const item = (it && typeof it === 'object' ? it : {}) as Record<string, unknown>
      const rawCategory = typeof item.category === 'string' ? item.category : undefined
      const isArmorCategory = rawCategory === 'armor'
      const rawArmorValue = typeof item.armorValue === 'number' ? Math.round(item.armorValue) : undefined
      const rawParryBonus = typeof item.parryBonus === 'number' ? Math.round(item.parryBonus) : undefined
      const rawDescription = typeof item.description === 'string' ? sanitizeInlineText(item.description, '').trim() : ''
      return {
        itemId: typeof item.itemId === 'string' ? item.itemId : randomUUID(),
        name: stripQuantityFromName(sanitizeInlineText(item.name, 'Item')),
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        changeType: (['gained', 'lost', 'used'].includes(item.changeType as string) ? item.changeType : 'gained') as ItemChange['changeType'],
        ...(rawDescription ? { description: rawDescription } : {}),
        ...(rawCategory && VALID_ITEM_CATEGORIES.has(rawCategory) ? { category: rawCategory as ItemChange['category'] } : {}),
        ...(isArmorCategory && rawArmorValue !== undefined && rawArmorValue > 0
          ? { armorValue: Math.min(6, Math.max(1, rawArmorValue)) }
          : {}),
        ...(isArmorCategory && rawParryBonus !== undefined && rawParryBonus > 0
          ? { parryBonus: Math.min(4, Math.max(1, rawParryBonus)) }
          : {})
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
      const rawTargetId = typeof status.targetId === 'string' && status.targetId.trim()
        ? status.targetId.trim()
        : null
      // Remapeia referência de NPC (id cru/nome) para o id final estável.
      const targetId = targetType === 'npc' ? (resolveNpcRef(rawTargetId) ?? rawTargetId) : rawTargetId
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

    // Parse npc attacks (desativado: combate agora é narrativo via chanceCheck)
    const npcAttacks: NpcAttackEntry[] = []


    // Fix B: opções de ataque sem targetId válido → downgrade para custom.
    // Antes, remapeia a referência (id cru/nome) para o id final estável.
    for (const option of options) {
      if (option.actionType !== 'attack') continue
      // Robustez extra: alguns modelos ainda enviam "target" em vez de "targetId".
      const targetFromAlias = sanitizeInlineText(option.actionPayload?.target, '')
      const rawTargetId = sanitizeInlineText(option.actionPayload?.targetId, '') || targetFromAlias
      let targetId = resolveNpcRef(rawTargetId)
      if (!targetId) {
        // Fallback: tentar encontrar o nome de um NPC ativo mencionado no texto da opção
        const searchText = `${option.text} ${sanitizeInlineText(option.actionPayload?.input, '')}`.toLowerCase()
        
        // 1. Procurar nos NPCs novos introduzidos
        for (const npc of npcs) {
          if (npc.displayName && searchText.includes(npc.displayName.toLowerCase())) {
            targetId = npc.id
            break
          }
        }
        
        // 2. Procurar nos NPCs já presentes na cena
        if (!targetId) {
          for (const npc of presentNpcs) {
            if (npc.name && searchText.includes(npc.name.toLowerCase())) {
              targetId = npc.id
              break
            }
          }
        }
      }

      if (targetId) {
        // Persiste o id final remapeado no payload para o engine resolver corretamente.
        option.actionPayload = { ...option.actionPayload, targetId }
      } else {
        const rawTargetLabel = rawTargetId || '(ausente)'
        warn('sanitizeNarratorResponse', `Opção de ataque sem targetId válido convertida para custom: "${option.text}" (targetId: ${rawTargetLabel})`)
        option.actionType = 'custom'
        option.actionPayload = { input: option.text }
        if (option.diceCheck) option.diceCheck = { ...option.diceCheck, required: false }
      }
    }

    // Fix: opções "flag" sem "key" válido → tenta aliases comuns que o modelo usa por engano
    // ("flag", "flagName", "name") antes de rebaixar para custom, em vez de invalidar a resposta inteira.
    for (const option of options) {
      if (option.actionType !== 'flag') continue
      const key = sanitizeInlineText(option.actionPayload?.key, '')
        || sanitizeInlineText(option.actionPayload?.flag, '')
        || sanitizeInlineText(option.actionPayload?.flagName, '')
        || sanitizeInlineText(option.actionPayload?.name, '')
      if (key) {
        option.actionPayload = { key }
      } else {
        warn('sanitizeNarratorResponse', `Opção "flag" sem key válida convertida para custom: "${option.text}"`)
        option.actionType = 'custom'
        option.actionPayload = { input: option.text }
        if (option.diceCheck) option.diceCheck = { ...option.diceCheck, required: false }
      }
    }


    // Parse outcome override (inversão justificada de desfecho).
    // Só é mantido quando o desfecho narrado realmente diverge do mecânico
    // E há uma justificativa explícita na ficção. Caso contrário, descartado.
    let outcomeOverride: OutcomeOverride | null = null
    {
      const rawOverride = raw.outcomeOverride
      if (rawOverride && typeof rawOverride === 'object') {
        const ov = rawOverride as Record<string, unknown>
        const mechanicalResult = ov.mechanicalResult === 'success' || ov.mechanicalResult === 'failure'
          ? ov.mechanicalResult
          : null
        const narratedOutcome = ov.narratedOutcome === 'success' || ov.narratedOutcome === 'failure'
          ? ov.narratedOutcome
          : null
        const justification = sanitizeInlineText(ov.justification, '')
        if (mechanicalResult && narratedOutcome && narratedOutcome !== mechanicalResult && justification) {
          outcomeOverride = { mechanicalResult, narratedOutcome, justification }
        } else if (mechanicalResult || narratedOutcome || justification) {
          warn('sanitizeNarratorResponse', 'outcomeOverride descartado: sem divergência mecânico/narrado ou sem justificativa explícita')
        }
      }
    }

    // Observabilidade: só o estilo "balanced" tem mínimo (2–4 frases) — nos
    // estilos conciso/padrão, 1 frase é permitida e não deve gerar alarme.
    if (opts.narrativeStyle === 'balanced') {
      const proseText = segments
        .filter((segment) => segment.type === 'narrator')
        .map((segment) => segment.text)
        .join(' ')
        .trim()
      const sentenceCount = (proseText.match(/[.!?…](?=\s|$)/g) ?? []).length
      if (proseText && sentenceCount < 2) {
        warn('sanitizeNarratorResponse', `Narração curta demais (${sentenceCount || 1} frase) para o estilo balanced: mínimo de 2 frases exigido pelo prompt`)
      }
    }

    return {
      segments,
      options,
      npcs,
      itemChanges,
      statusChanges,
      npcAttacks,
      ...(outcomeOverride ? { outcomeOverride } : {})
    }
  }

  private isNarratorResponseStructurallyValid(response: NarratorTurnResponse): { valid: true } | { valid: false; reason: string } {
    if (!response.segments?.length || !segmentsToText(response.segments).trim()) return { valid: false, reason: 'segments empty' }
    if (response.options.length !== 4) return { valid: false, reason: `options count=${response.options.length}` }

    for (let i = 0; i < response.options.length; i++) {
      const option = response.options[i]
      if (!option.text.trim()) return { valid: false, reason: `option[${i}] text empty` }
      if (!option.diceCheck) return { valid: false, reason: `option[${i}] chanceCheck missing` }
      if (!option.diceCheck.reason.trim()) return { valid: false, reason: `option[${i}] chanceCheck.reason empty` }

      const payload = option.actionPayload ?? {}

      // Se required=true, deve ter successChance entre 0 e 100
      if (option.diceCheck.required) {
        const sc = option.diceCheck.successChance
        if (typeof sc !== 'number' || !Number.isFinite(sc) || sc < 0 || sc > 100) {
          return { valid: false, reason: `option[${i}] chanceCheck.required=true but successChance invalid (${sc})` }
        }
      }

      switch (option.actionType) {
        case 'attack':
          if (!sanitizeInlineText(payload.targetId, '').length) return { valid: false, reason: `option[${i}] attack missing targetId` }
          break
        case 'travel':
          if (!sanitizeInlineText(payload.to, '').length) return { valid: false, reason: `option[${i}] travel missing to` }
          break
        case 'chance_check':
          if (!sanitizeInlineText(payload.input, option.text)) return { valid: false, reason: `option[${i}] chance_check missing input` }
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
      '=== CORREÇÃO OBRIGATÓRIA ===',
      '- A resposta anterior foi rejeitada por estar incompleta, truncada, não-canônica, ou por violar a regra de agência.',
      '- Retorne um JSON completo e autoconsistente.',
      '- Não use entidades fora do contexto estruturado.',
      '- Não omita options, diceCheck, ou actionPayload obrigatórios.',
      '- Em caso de dúvida sobre mutações de estado, deixe npcs, itemChanges e statusChanges vazios/null.',
      '- VERIFICAÇÃO CRÍTICA DE AGÊNCIA: o campo "narrative" NÃO deve descrever o que o jogador faz a seguir.',
      '  Deve terminar na consequência direta da ação atual — o próximo movimento do jogador é escolhido em "options".',
      '  Remova qualquer frase como "você vai até", "você decide", "você entra em", "agora você precisa", "é hora de".'
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
      world?: { name?: string; description?: string; worldGuide?: WorldGuide }
      campaign?: { name?: string; storyDescription?: string }
      rulesDigest?: string
      summaryText?: string
      playerSkills?: Record<string, string>
      mode?: NarratorPromptMode
      narrativeStyle?: 'concise' | 'balanced'
      simpleVocabulary?: boolean
    } = {},
    /** Contexto de runtime usado apenas na sanitização (não afeta o system prompt nem seu cache). */
    sanitizeContext: { presentNpcs?: { id: string; name: string }[] } = {}
  ): Promise<NarratorTurnResponse> {
    const narratorMode = systemPromptOpts.mode ?? 'turn'
    const systemPrompt = this.getCachedNarratorSystemPrompt(systemPromptOpts)
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
          // responseSchema só é interpretado pela API Gemini; o provider DeepSeek ignora.
          ...(this.provider === 'deepseek' ? {} : { responseSchema: NARRATOR_RESPONSE_SCHEMA }),
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
          allowNarrativeFallback: false,
          narrativeStyle: systemPromptOpts.narrativeStyle,
          presentNpcs: sanitizeContext.presentNpcs
        })

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
      'Você é o Narrador de uma história.',
      'O jogador digitou uma ação livre. Sua tarefa é VALIDAR se a ação é possível no contexto atual.',
      'Use o contexto do user prompt como referência canônica.',
      '',
      '## Esquema JSON de Saída',
      'Você DEVE retornar APENAS um JSON válido (sem markdown, sem comentários) com esta estrutura:',
      '```json',
      '{',
      '  "feasible": true|false,',
      '  "feasibilityReason": "<motivo se não for possível, ou vazio>",',
      '  "actionType": "<tipo inferido: custom|attack|travel>",',
      '  "actionPayload": { <campos para montar a ação mecânica> },',
      '  "chanceCheck": {',
      '    "required": false,',
      '    "successChance": null,',
      '    "reason": "<justificativa narrativa de que a ação será resolvida narrativamente>"',
      '  },',
      '  "interpretation": "<breve descrição de como você interpretou a ação>"',
      '}',
      '```',
      '',
      '## Regras de Validação',
      '- Se a ação for narrativamente impossível no contexto (ex.: usar item inexistente, interagir com quem não está presente) → feasible: false.',
      '- A resolução mecânica de rolagens de dados está temporariamente desativada. Para todas as ações válidas que não sejam ataque ou movimentação, use actionType: "custom" e chanceCheck.required: false.',
      '- Para movimento a um local diferente → actionType: "travel", inclua "to" em actionPayload e defina chanceCheck.required: false.',
      '- O campo "interpretation" deve ter 1 frase curta explicando o que o jogador quer fazer.'
    ].join('\n')

    const ctx = req.context
    const recentMessagesLines = req.recentMessages
      .slice(-5)
      .map((m) => m.role === 'narrator'
        ? `- [narrador] ${segmentsToText(m.segments).slice(0, 300)}`
        : `- [jogador] ${(m.playerInput ?? '').slice(0, 300)}`)

    const sceneStateMarkdown = renderSceneStateMarkdown({
      location: ctx.location,
      wounds: ctx.wounds,
      fatigue: ctx.fatigue,
      isShaken: ctx.isShaken,
      bennies: ctx.bennies,
      sceneObjectsCurrent: ctx.sceneObjectsCurrent,
      inventory: ctx.inventory,
      equippedItems: ctx.equippedItems,
      activeStatusEffects: ctx.activeStatusEffects,
      npcsPresent: ctx.npcsPresent,
      defeatedNpcIds: ctx.defeatedNpcIds,
      playerSkills: ctx.playerSkills,
      rulesDigest: ctx.rulesDigest,
      summaryText: ctx.summaryText
    })

    const prompt = [
      'VALIDAÇÃO DE AÇÃO — use o contexto abaixo como referência canônica e retorne APENAS o JSON de resposta.',
      '',
      sceneStateMarkdown,
      '',
      '## Últimas Mensagens',
      recentMessagesLines.length ? recentMessagesLines.join('\n') : '(sem histórico recente)',
      '',
      '## Ação do Jogador (a validar)',
      `"${req.input}"`
    ].join('\n')

    try {
      const attempts = [
        { maxOutputTokens: 1024, temperature: 0.2 },
        { maxOutputTokens: 2048, temperature: 0.15 }
      ] as const

      for (const [index, attempt] of attempts.entries()) {
        // Mesmo schema fechado do narrador (traco como enum de perícias) — a LLM já
        // valida a forma da resposta; parseValidateActionResponse só faz um type-guard
        // mínimo, sem reparo nem inferência (ver comentário da função).
        const generated = await this.generateTextDetailed(prompt, {
          systemInstruction: sysPrompt,
          maxOutputTokens: attempt.maxOutputTokens,
          temperature: attempt.temperature,
          responseMimeType: 'application/json',
          // responseSchema só é interpretado pela API Gemini/OpenAI; o provider DeepSeek ignora.
          ...(this.provider === 'deepseek' ? {} : { responseSchema: VALIDATE_ACTION_RESPONSE_SCHEMA })
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

        const response = parseValidateActionResponse(parsed.value, req.input)
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
    const world = req.world
    const campaign = req.campaign
    const character = req.character

    const worldLines = world
      ? [
          world.name ? `- Nome: ${world.name}` : null,
          world.description ? `- Descrição: ${truncateForPrompt(world.description, 260)}` : null,
          world.worldGuide ? renderWorldGuideMarkdown(world.worldGuide) : null
        ].filter((line): line is string => Boolean(line))
      : []

    const campaignLines = campaign
      ? [
          campaign.name ? `- Nome: ${campaign.name}` : null,
          campaign.storyDescription ? `- Introdução: ${campaign.storyDescription}` : null,
          ...(campaign.storyMissions ?? []).map((m) => `- [${m.optional ? 'Opcional' : 'Principal'}] ${m.title}: ${m.description}`)
        ].filter((line): line is string => Boolean(line))
      : []

    const characterLines = [
      `- Nome: ${character.name}`,
      character.profession ? `- Profissão: ${character.profession}` : null,
      character.race ? `- Raça: ${character.race}` : null,
      character.gender ? `- Gênero: ${character.gender}` : null,
      character.description ? `- Descrição: ${character.description}` : null,
      character.edges.length ? `- Vantagens: ${character.edges.join(', ')}` : null,
      character.hindrances.length ? `- Complicações: ${character.hindrances.map((h) => `${h.name} (${h.severity})`).join(', ')}` : null
    ].filter((line): line is string => Boolean(line))

    const startContextMarkdown = [
      worldLines.length ? `## Universo\n${worldLines.join('\n')}` : null,
      campaignLines.length ? `## Campanha\n${campaignLines.join('\n')}` : null,
      `## Personagem\n${characterLines.join('\n')}`
    ].filter((section): section is string => Boolean(section)).join('\n\n')

    const openingPremiseLines = campaign
      ? [
          'PREMISSA DE ABERTURA (OBRIGATÓRIA): O personagem JÁ CONHECE quem é — mantém memória e identidade completas (nome, profissão, raça, passado). NÃO aplique amnésia.',
          'Abra a cena já em movimento, ancorada no gancho da Campanha acima: o personagem está vivendo o início do enredo (um evento, um encontro, uma chegada, uma missão começando), não acordando em local desconhecido.',
          'Use a Introdução da campanha e, se houver, uma das missões listadas como motivo concreto e imediato para a cena começar.',
          'Apresente um gancho narrativo claro que force o personagem a agir: uma tensão palpável, uma ameaça imediata, ou uma decisão urgente ligada ao enredo da campanha.',
          'Trate profissão, raça, vantagens e itens como conhecimento consciente e já dominado pelo personagem — não como algo a ser descoberto.',
          'Ofereça 4 opções de ação que façam mais sentido para esta cena de abertura — deixe a situação decidir quais ações se encaixam; cada opção deve parecer uma escolha de história, não um botão de menu.',
          'Para CADA opção, avalie se ela exige uma rolagem de dados (diceCheck) conforme a instrução do campo "traco" no system prompt.'
        ]
      : [
          'PREMISSA DE ABERTURA (OBRIGATÓRIA): O personagem ACORDA SEM MEMÓRIA. Ele desperta em um lugar desconhecido e não se lembra de quem é, de como chegou ali, nem de seu passado. Não revele ao jogador o histórico, a missão prévia ou as conexões do personagem — a amnésia é o ponto de partida da história e o mistério a ser desvendado ao longo da aventura.',
          'Abra a cena no exato momento em que o personagem recobra a consciência: descreva as primeiras sensações confusas (a superfície onde está deitado, sons, cheiros, luz), a desorientação e o vazio de memória.',
          'Deixe claro, através da narração e não de forma expositiva, que o personagem não reconhece o ambiente e não consegue recordar seu nome ou sua história. Ele pode ter apenas fragmentos vagos ou nenhuma lembrança.',
          'Não rotule a situação com explicações técnicas ou estratégicas como se fossem conhecimento estabelecido do personagem (ex.: "cerco biológico", "base de contenção", "abrigo em ruínas"). Mostre apenas indícios observáveis e deixe a interpretação em aberto neste primeiro momento.',
          'Trate os dados do personagem (profissão, raça, vantagens, itens) como coisas que ele DESCOBRE aos poucos sobre si mesmo — não como conhecimento consciente que ele já domina. Ele pode estranhar suas próprias roupas, ferramentas ou marcas no corpo sem entender de onde vieram.',
          'Apresente um gancho narrativo claro ligado ao mistério da amnésia: uma tensão palpável, uma ameaça imediata, uma pista intrigante ou uma decisão urgente que force o personagem a agir mesmo sem saber quem é.',
          'Estabeleça pelo menos 1 detalhe específico de worldbuilding (um nome de lugar, uma facção, um costume local, um objeto estranho) que o jogador possa explorar para começar a reconstruir sua identidade.',
          'Ofereça 4 opções de ação que façam mais sentido para esta cena de abertura — deixe a situação decidir quais ações se encaixam; cada opção deve parecer uma escolha de história, não um botão de menu.',
          'Para CADA opção, avalie se ela exige uma rolagem de dados (diceCheck) conforme a instrução do campo "traco" no system prompt.'
        ]

    const userPrompt = [
      'INÍCIO DE SESSÃO — Narre a abertura desta história.',
      '',
      'Use o contexto abaixo como referência canônica da abertura.',
      '',
      startContextMarkdown,
      '',
      ...openingPremiseLines,
      '',
      'ITENS INICIAIS (OBRIGATÓRIO):',
      'Retorne em "itemChanges" de 4 a 8 itens iniciais com changeType "gained" que o personagem já possui no início da aventura.',
      'Escolha itens coerentes com a profissão, raça e cenário do mundo. Exemplos de categoria:',
      '- Arma principal apropriada à profissão (espada, arco, cajado, adaga, pistola, rifle, etc.)',
      '- Se a arma for à distância (arco, besta, pistola, rifle, espingarda, etc.), inclua OBRIGATORIAMENTE a munição correspondente como item separado (flechas, virotes, balas, cartuchos, etc.) com quantidade apropriada ao contexto',
      '- Armadura ou roupa de proteção, se aplicável',
      '- Suprimentos básicos de viagem (bolsa, corda, ferramentas úteis, etc.)',
      '- 1 a 2 itens temáticos/narrativos que conectam o personagem ao mundo (amuleto de família, carta misteriosa, mapa antigo, diário, etc.). Esses itens NÃO ÓBVIOS DEVEM ter o campo "description" preenchido (o que é / o que contém / para que serve), conforme a regra de descrição de itens do system prompt.',
      '- Dinheiro inicial OBRIGATÓRIO: inclua 1 item com categoria "money" e o nome apropriado ao cenário (ex.: "Moedas de Ouro", "Créditos", "Dólares", "Gil", etc.) e "quantity" com a quantia numérica exata coerente com o cenário e o contexto do personagem.',
      '- Para cenários modernos/futuristas: se o personagem tem profissão ou contexto que justifique, inclua um veículo (categoria "vehicle": carro, moto, nave, etc.) ou propriedade (categoria "property": apartamento, base, etc.) como item inicial.',
      campaign
        ? 'Mencione os itens naturalmente dentro da narrativa de abertura — o personagem já sabe que os possui e os usa com naturalidade (equipamento de trabalho, pertences pessoais, provisões de viagem).'
        : 'Mencione os itens naturalmente dentro da narrativa de abertura, de forma coerente com a amnésia: descreva o personagem descobrindo esses pertences consigo ao acordar (revistando os próprios bolsos, encontrando objetos ao seu lado, estranhando as roupas ou o equipamento que veste) sem saber por que os possui.',
      'Use o mesmo formato de itemChanges já definido no system prompt. Cada item DEVE ter o campo "category" corretamente preenchido.'
    ].filter(Boolean).join('\n')

    try {
      return await this.generateNarratorResponse(userPrompt, this.narrateStartMaxTokens, {
        mode: 'start',
        narrativeStyle: 'balanced', // Forçar 'balanced' para garantir abertura rica e imersiva
        simpleVocabulary: req.simpleVocabulary
      })
    } catch (error) {
      logLlmError('narrateStart', error)
      // Fallback mínimo para não bloquear a sessão
      return {
        isFallback: true,
        segments: [{ type: 'narrator', text: `Você chega a um novo lugar. O ar carrega o peso de histórias não contadas. Ao seu redor, a paisagem de ${req.campaign?.name ?? req.world?.name ?? 'este mundo'} se estende até onde a vista alcança. Um caminho se abre à sua frente, e você sente que a aventura está prestes a começar.` }],
        options: [
          { id: randomUUID(), text: 'Explorar o caminho principal', actionType: 'custom', actionPayload: { input: 'Explorar o caminho principal' }, diceCheck: { required: false, reason: 'Caminho seguro e acessível' } },
          { id: randomUUID(), text: 'Observar os arredores com cuidado', actionType: 'chance_check', actionPayload: { input: 'Observar os arredores com cuidado' }, diceCheck: { required: true, successChance: 70, reason: 'Detectar detalhes ocultos no ambiente' } },
          { id: randomUUID(), text: 'Procurar alguém para conversar', actionType: 'custom', actionPayload: { input: 'Procurar alguém para conversar' }, diceCheck: { required: false, reason: 'Ação social simples' } },
          { id: randomUUID(), text: 'Checar seus pertences e seguir em frente', actionType: 'custom', actionPayload: { input: 'Checar pertences e seguir em frente' }, diceCheck: { required: false, reason: 'Ação trivial sem risco' } }
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

    // A ação do turno atual já foi persistida no histórico (appendAndGet) antes
    // desta chamada, então ela chega como a última entrada de req.recentMessages
    // — sem resposta de narrador ainda. Ela será representada de forma completa
    // em "## Ação do Jogador" no currentTurnPrompt logo abaixo; mantê-la também
    // "pelada" aqui duplicaria a mesma ação e confundiria o LLM sobre o que já
    // foi narrado vs. o que ainda precisa ser narrado agora.
    const pendingActionText = req.playerAction.description.trim()
    const lastMsg = req.recentMessages[req.recentMessages.length - 1]
    const isDuplicatePendingAction = Boolean(
      lastMsg
      && lastMsg.role === 'player'
      && typeof lastMsg.playerInput === 'string'
      && lastMsg.playerInput.trim() === pendingActionText
    )
    const historyMessages = isDuplicatePendingAction
      ? req.recentMessages.slice(0, -1)
      : req.recentMessages

    for (const msg of historyMessages) {
      const narratorText = msg.role === 'narrator' ? segmentsToText(msg.segments) : ''
      if (msg.role === 'narrator' && narratorText) {
        contents.push({ role: 'model', text: narratorText })
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

    // ── Contexto Markdown canônico do turno (contexto dinâmico no user prompt) ──
    const situationLabel = req.context.situation === 'combat'
      ? 'COMBATE'
      : req.context.situation === 'dialogo'
        ? 'DIÁLOGO'
        : 'EXPLORAÇÃO'

    const sceneStateMarkdown = renderSceneStateMarkdown({
      location: req.context.location,
      situationLabel,
      wounds: req.context.wounds,
      fatigue: req.context.fatigue,
      isShaken: req.context.isShaken,
      bennies: req.context.bennies,
      sceneObjectsCurrent: req.context.sceneObjectsCurrent,
      inventory: req.context.inventory,
      equippedItems: req.context.equippedItems,
      activeStatusEffects: req.context.activeStatusEffects,
      npcsPresent: req.context.npcsPresent,
      defeatedNpcIds: req.context.defeatedNpcIds,
      npcCatalog: req.context.npcCatalog,
      playerSkills: req.context.playerSkills,
      rulesDigest: req.context.rulesDigest,
      summaryText: req.context.summaryText
    })

    const playerActionLines = [
      `- Tipo: ${req.playerAction.type}`,
      `- Descrição: ${req.playerAction.description}`,
      req.playerAction.playerSpeech ? `- Fala: "${req.playerAction.playerSpeech}"` : null
    ].filter((line): line is string => Boolean(line)).join('\n')

    const mechanicalResultText = req.engineEvents.length
      ? formatEngineEventsForPrompt(req.engineEvents)
      : '(sem eventos mecânicos neste turno)'

    // Reforço das regras mais violadas junto da ação: em prompts longos com
    // histórico crescente, o modelo passa a ignorar regras do meio do system
    // prompt (narrações de 1 frase nos logs) — repetir aqui restaura a adesão.
    const lengthReminder = req.narrativeStyle === 'concise'
      ? 'LEMBRETE DE TAMANHO: máximo 2 frases curtas, em 1 parágrafo.'
      : req.narrativeStyle === 'balanced'
        ? 'LEMBRETE DE TAMANHO: sua narração DEVE ter entre 2 e 4 frases, em 1 ou 2 parágrafos. Uma narração de 1 frase única é INVÁLIDA.'
        : 'LEMBRETE DE TAMANHO: máximo 3 frases curtas, em 1 parágrafo.'
    const optionsAnchoringReminder = 'LEMBRETE DE OPTIONS: as 4 opções devem nascer da consequência narrada NESTE turno e do Resultado Mecânico abaixo. Não use opções genéricas sem vínculo explícito com a cena atual. Todas as opções devem ser executáveis AGORA com o estado atual. As 4 opções devem ser categoricamente distintas entre si (direta/cautelosa/técnica/ousada como guia). Sem passos incrementais em ambiente vazio: avance em elipse até o próximo Ponto de Interesse. OBJETOS NAS OPÇÕES: uma opção só pode mencionar um objeto, estrutura ou detalhe de cenário se ele foi explicitamente descrito na narração DESTE turno — nunca de turnos anteriores, nunca inventado. Se não está no texto narrado agora, não pode aparecer numa opção.'
    const optionsSpatialReminder = req.playerAction.type === 'travel'
      ? 'LEMBRETE DE COERÊNCIA ESPACIAL: como este turno foi de deslocamento (travel), NÃO ofereça interação com objetos fixos da sala anterior (terminal, painel, porta, mobiliário). Use apenas elementos do local atual e inventário.'
      : null

    const currentTurnPrompt = [
      'TURNO DE JOGO — Narre a consequência da ação do jogador.',
      '',
      'Use o contexto abaixo como fonte canônica para continuidade e consistência.',
      'Não contradiga a seção Resultado Mecânico. Não invente entidades fora do contexto.',
      'NPCs já presentes devem reutilizar exatamente o mesmo id/displayName do contexto.',
      lengthReminder,
      optionsAnchoringReminder,
      optionsSpatialReminder,
      '',
      sceneStateMarkdown,
      '',
      '## Ação do Jogador',
      playerActionLines,
      '',
      '## Resultado Mecânico',
      mechanicalResultText
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
          mode: 'turn',
          narrativeStyle: req.narrativeStyle,
          simpleVocabulary: req.simpleVocabulary
        },
        {
          presentNpcs: req.context.npcsPresent.map((n) => ({ id: n.id, name: n.name }))
        }
      )
    } catch (error) {
      logLlmError('narrateTurn', error)
      warn('narrateTurn', `Fallback ativado: ${error instanceof Error ? error.message : String(error)}`)
      return {
        isFallback: true,
        segments: [{ type: 'narrator', text: `Sua ação ecoa pelo ambiente. As consequências ainda não estão claras, mas o mundo ao seu redor reage de formas sutis. O que você fará agora?` }],
        options: [
          { id: randomUUID(), text: 'Investigar o resultado da ação', actionType: 'chance_check', actionPayload: { input: 'Investigar o resultado da ação' }, diceCheck: { required: true, successChance: 65, reason: 'Investigação exige atenção aos detalhes' } },
          { id: randomUUID(), text: 'Avançar com cautela', actionType: 'custom', actionPayload: { input: 'Avançar com cautela' }, diceCheck: { required: false, reason: 'Movimento cauteloso sem ameaça imediata' } },
          { id: randomUUID(), text: 'Observar os arredores', actionType: 'chance_check', actionPayload: { input: 'Observar os arredores' }, diceCheck: { required: true, successChance: 70, reason: 'Detectar ameaças e oportunidades' } },
          { id: randomUUID(), text: 'Descansar por um momento', actionType: 'custom', actionPayload: { input: 'Descansar e recuperar forças' }, diceCheck: { required: false, reason: 'Descanso simples sem perigo' } }
        ],
        npcs: [],
        itemChanges: [],
        statusChanges: []
      }
    }
  }
}
