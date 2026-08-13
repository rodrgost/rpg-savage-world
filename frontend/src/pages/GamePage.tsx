import { FormEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import {
  executeCustomAction,
  validateCustomAction,
  executeTraitTest,
  executeChanceCheck,
  executeAttack,
  executeSoakRoll,
  executeSpendBenny,
  executeRecoverShaken,
  getSessionView,
  chooseOption,
  resetSession,
  equipArmorItem,
  equipAttackItem,
  equipShieldItem,
  removeInventoryItem,
  unequipArmorItem,
  unequipAttackItem,
  unequipShieldItem,
  updateSessionSettings,
  getWorld,
  getCampaign,
  getCharacter,
  updateKnownNpc
} from '../lib/api'
import type { EnginePhaseData } from '../lib/api'
import type { ActionOption, ChatMessage, DiceCheck, DiceRollDetail, GameState, InventoryItem, Hindrance, KnownNpc, NarratorTurnResponse, NarrativeSegment, NarrativeStyle, RelationalStatus, SessionEvent, SummaryDoc, TraitTestPayload, ValidateActionResponse } from '../types'
import { RELATION_LABELS, RELATION_OPTIONS, relationClass, relationFromDisposition } from '../lib/npcLabels'
import { ATTRIBUTES, SKILLS, EDGES, dieLabel } from '../data/savage-worlds'
import { YouTubeAmbient } from '../components/YouTubeAmbient'

// ─── Helpers ───

function normalizeEscapedText(value: string): string {
  let normalized = value.replace(/\r\n?/g, '\n')

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

    if (next === normalized) break
    normalized = next
  }

  return normalized.normalize('NFC').trim()
}

function normalizeInlineText(value: string): string {
  return normalizeEscapedText(value)
    .replace(/\s*\n+\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Trata o texto digitado pelo jogador antes de enviar/exibir:
 * - garante espaço após o hífen de fala ("-olá" -> "- olá", "ataco -vai" -> "ataco - vai");
 * - capitaliza a primeira letra do texto, da fala (após "- ") e de cada nova frase.
 * Não altera palavras hifenizadas (ex.: "guarda-costas"), pois exige espaço antes do hífen.
 */
function formatPlayerInput(value: string): string {
  let text = value.trim()
  if (!text) return text

  // Espaço após hífen inicial de fala
  text = text.replace(/^-(?=\S)/, '- ')
  // Espaço após hífen separador (ação - fala) quando houver espaço antes
  text = text.replace(/(\s)-(?=\S)/g, '$1- ')

  // Capitalizar início do texto, início da fala (após "- ") e após pontuação final
  text = text.replace(
    /(^-\s+|[.!?…]["')\]]?\s+|\s-\s+|^)(\p{Ll})/gu,
    (_match, prefix: string, letter: string) => prefix + letter.toUpperCase()
  )

  return text
}

function splitNarrativeParagraphs(narrative?: string): string[] {
  if (!narrative) return []

  return normalizeEscapedText(narrative)
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

function mergeConsecutiveNarratorSegments(segments: NarrativeSegment[]): NarrativeSegment[] {
  const merged: NarrativeSegment[] = []

  for (const segment of segments) {
    const previous = merged[merged.length - 1]
    if (segment.type === 'narrator' && previous?.type === 'narrator') {
      previous.text = `${previous.text}\n\n${segment.text}`
      continue
    }

    merged.push({ ...segment })
  }

  return merged
}

function getNarrativeSegments(message: ChatMessage): NarrativeSegment[] {
  const segments = (message.segments ?? [])
    .map((segment) => ({ ...segment, text: normalizeEscapedText(segment.text) }))
    .filter((segment) => segment.text.length > 0)

  if (segments.length > 0) return mergeConsecutiveNarratorSegments(segments)

  const fallbackText = normalizeEscapedText(message.narrative ?? '')
  return fallbackText ? mergeConsecutiveNarratorSegments([{ type: 'narrator', text: fallbackText }]) : []
}

function joinNarrativeSegments(segments: NarrativeSegment[]): string {
  return segments.map((segment) => segment.text).join('\n\n')
}

function sliceNarrativeSegments(segments: NarrativeSegment[], maxChars: number): NarrativeSegment[] {
  let remaining = maxChars
  const visible: NarrativeSegment[] = []

  for (const segment of segments) {
    if (remaining <= 0) break

    const text = segment.text.slice(0, remaining)
    if (text.trim()) visible.push({ ...segment, text })

    remaining -= segment.text.length
    if (remaining > 0) remaining -= 2
  }

  return visible
}

function trimIncompleteSummaryText(text?: string): string {
  if (!text) return ''

  const normalized = normalizeEscapedText(text)
  if (/[.!?…]["')\]]?\s*$/u.test(normalized)) return normalized

  const matches = [...normalized.matchAll(/[.!?…]["')\]]?(?=\s|$)/gu)]
  if (!matches.length) return normalized

  const last = matches[matches.length - 1]
  const index = last.index ?? 0
  return normalized.slice(0, index + last[0].length).trim()
}

function normalizeLookupKey(value: string): string {
  return normalizeInlineText(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

/** Traduz chaves canônicas de atributo (inglês) para labels PT-BR */
const ATTR_LABEL_MAP: Record<string, string> = Object.fromEntries(
  ATTRIBUTES.map((a) => [a.key, a.label])
)

function normalizeActionPayload(actionPayload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(actionPayload).map(([key, value]) => [key, typeof value === 'string' ? normalizeInlineText(value) : value])
  )
}
function normalizeValidationResponse(validation: ValidateActionResponse): ValidateActionResponse {
  const actionPayload = normalizeActionPayload(validation.actionPayload ?? {})

  return {
    ...validation,
    interpretation: normalizeInlineText(validation.interpretation),
    feasibilityReason: validation.feasibilityReason ? normalizeInlineText(validation.feasibilityReason) : validation.feasibilityReason,
    actionPayload
  }
}

function normalizeOption(option: ActionOption): ActionOption {
  const actionPayload = normalizeActionPayload(option.actionPayload ?? {})

  return {
    ...option,
    text: normalizeInlineText(option.text),
    actionPayload
  }
}

function normalizeOptions(options?: ActionOption[]): ActionOption[] {
  if (!options?.length) return []
  return options
    .map((option) => normalizeOption(option))
    .filter((option) => Boolean(option.text))
}

/** Ordena mensagens: por seq (se disponível), senão por turn+role */
function sortMessages(msgs: ChatMessage[]): ChatMessage[] {
  return [...msgs].sort((a, b) => {
    // Se ambas têm seq, usa seq (ordem dada pelo backend)
    if (a.seq != null && b.seq != null) return a.seq - b.seq
    // Fallback: ordena por turn, desempata player antes de narrator
    if (a.turn !== b.turn) return a.turn - b.turn
    const roleOrder = { player: 0, system: 1, narrator: 2 } as const
    return (roleOrder[a.role] ?? 1) - (roleOrder[b.role] ?? 1)
  })
}

const LOCAL_ONLY_MESSAGE_PREFIXES = ['optimistic-', 'engine-transient-', 'narrator-'] as const

function isLocalOnlyMessage(message: ChatMessage): boolean {
  return typeof message.messageId === 'string' && LOCAL_ONLY_MESSAGE_PREFIXES.some((prefix) => message.messageId.startsWith(prefix))
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)

  return `{${entries.join(',')}}`
}

function buildMessageSignature(message: ChatMessage): string {
  if (message.engineEvents?.length) {
    const eventsKey = message.engineEvents
      .map((event) => `${event.type}:${stableStringify(event.payload)}`)
      .join('|')
    return `system-engine:${message.turn}:${eventsKey}`
  }

  if (message.role === 'player') {
    return `player:${message.turn}:${normalizeInlineText(message.playerInput ?? '')}`
  }

  if (message.role === 'narrator') {
    return `narrator:${message.turn}:${normalizeEscapedText(message.narrative ?? '')}`
  }

  return `system-summary:${message.turn}:${normalizeEscapedText(message.narrative ?? '')}`
}

function getEngineMessageSignature(message: ChatMessage): string | null {
  return message.engineEvents?.length ? buildMessageSignature(message) : null
}

function messageScore(message: ChatMessage): number {
  let score = 0

  if (!isLocalOnlyMessage(message)) score += 10
  if (message.seq != null) score += 4
  if (message.engineEvents?.length) score += 3
  if (message.options?.length) score += 2
  if (message.narrative?.trim()) score += 2
  if (message.playerInput?.trim()) score += 1

  return score
}

function combineMessages(primary: ChatMessage, secondary: ChatMessage): ChatMessage {
  return {
    ...secondary,
    ...primary,
    messageId: primary.messageId ?? secondary.messageId,
    seq: primary.seq ?? secondary.seq,
    narrative: primary.narrative ?? secondary.narrative,
    playerInput: primary.playerInput ?? secondary.playerInput,
    options: primary.options ?? secondary.options,
    npcs: primary.npcs ?? secondary.npcs,
    itemChanges: primary.itemChanges ?? secondary.itemChanges,
    statusChanges: primary.statusChanges ?? secondary.statusChanges,
    engineEvents: primary.engineEvents ?? secondary.engineEvents,
  }
}

function choosePreferredMessage(existing: ChatMessage, incoming: ChatMessage): ChatMessage {
  if (messageScore(incoming) > messageScore(existing)) {
    return combineMessages(incoming, existing)
  }

  return combineMessages(existing, incoming)
}

function mergeChatMessages(...groups: ChatMessage[][]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>()
  const bySignature = new Map<string, ChatMessage>()

  for (const group of groups) {
    for (const message of group) {
      if (!message) continue

      const signature = buildMessageSignature(message)
      const existingById = message.messageId ? byId.get(message.messageId) : undefined
      if (existingById) {
        const merged = choosePreferredMessage(existingById, message)
        byId.set(merged.messageId, merged)
        bySignature.set(signature, merged)
        continue
      }

      const existingBySignature = bySignature.get(signature)
      if (existingBySignature) {
        const merged = choosePreferredMessage(existingBySignature, message)
        if (existingBySignature.messageId) byId.delete(existingBySignature.messageId)
        if (merged.messageId) byId.set(merged.messageId, merged)
        bySignature.set(signature, merged)
        continue
      }

      if (message.messageId) {
        byId.set(message.messageId, message)
      }
      bySignature.set(signature, message)
    }
  }

  return [...bySignature.values()]
}

function buildTransientEngineMessage(data: EnginePhaseData, fallbackSessionId: string): ChatMessage | null {
  if (!data.diceEvents?.length) return null

  const turn = data.state?.meta.turn ?? 0
  const sessionId = data.state?.meta.sessionId ?? fallbackSessionId
  const transientKey = data.diceEvents.map((event) => `${event.type}:${stableStringify(event.payload)}`).join('|')

  return {
    messageId: `engine-transient-${turn}-${transientKey}`,
    sessionId,
    turn,
    role: 'system',
    engineEvents: data.diceEvents,
  }
}

function formatState(state: GameState): string {
  const p = state.player
  return [
    `Turno ${state.meta.turn}`,
    `Cap ${state.meta.chapter}`,
    `Local: ${state.worldState.activeLocation}`,
    `Ferimentos: ${p.wounds}/${p.maxWounds}`,
    p.isShaken ? 'ABALADO' : '',
    `Bennies: ${p.bennies}`,
    `Aparar: ${p.parry}`,
    `Resist: ${p.toughness}`
  ].filter(Boolean).join(' | ')
}

// ─── Components ───

const NarrativeBubble = memo(function NarrativeBubble({ message, isNew, charsPerTick = 3, playerName, playerImage, npcs = [], knownNpcs = [], cumulativeTokens }: {
  message: ChatMessage
  isNew?: boolean
  charsPerTick?: number
  playerName?: string
  playerImage?: { mimeType: string; base64: string } | null
  npcs?: NonNullable<GameState['npcs']>
  knownNpcs?: KnownNpc[]
  cumulativeTokens?: number
}) {
  const segments = getNarrativeSegments(message)
  const fullText = joinNarrativeSegments(segments)
  const [displayedText, setDisplayedText] = useState(isNew && charsPerTick > 0 ? '' : fullText)
  const displayedSegments = sliceNarrativeSegments(segments, fullText.length === 0 ? 0 : displayedText.length)

  useEffect(() => {
    if (!isNew || charsPerTick <= 0) {
      setDisplayedText(fullText)
      return
    }
    setDisplayedText('')
    let index = 0
    const TICK_MS = 20
    const id = setInterval(() => {
      index += charsPerTick
      if (index >= fullText.length) {
        setDisplayedText(fullText)
        clearInterval(id)
      } else {
        setDisplayedText(fullText.slice(0, index))
      }
    }, TICK_MS)
    return () => clearInterval(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.messageId, isNew, charsPerTick])

  if (message.role === 'player') {
    const raw = message.playerInput ?? ''
    const isSpeechOnly = raw.startsWith('- ')
    const dashIdx = !isSpeechOnly ? raw.indexOf(' - ') : -1
    const isCombined = dashIdx !== -1
    const actionText = isCombined ? raw.slice(0, dashIdx) : null
    const speechText = isSpeechOnly
      ? raw.slice(2).trim()
      : isCombined
        ? raw.slice(dashIdx + 3).trim()
        : null
    const hasSpeech = isSpeechOnly || isCombined
    return (
      <div className={`msg player${hasSpeech ? ' player-speech' : ''}`}>
        <div className="player-content">
          <div className="player-text">
            <strong>{playerName ?? 'Você'}</strong>
            {actionText && <p>{actionText}</p>}
            {speechText && <p className="speech-text">"{speechText}"</p>}
            {!hasSpeech && <p>{raw}</p>}
          </div>
          {playerImage && (
            <img
              className="player-avatar"
              src={`data:${playerImage.mimeType};base64,${playerImage.base64}`}
              alt={playerName ?? 'Jogador'}
            />
          )}
        </div>
      </div>
    )
  }

  if (message.role === 'system') {
    // Engine events (dice rolls) persisted as system messages
    if (message.engineEvents && message.engineEvents.length > 0) {
      return (
        <div className="dice-events-block">
          {message.engineEvents.map((ev, idx) => (
            <DiceResultCard
              key={`${message.messageId}-ev-${idx}`}
              event={{ id: `${message.messageId}-${idx}`, turn: message.turn, type: ev.type, payload: ev.payload }}
            />
          ))}
        </div>
      )
    }

    // Summary messages
    return (
      <div className="msg system-summary">
        <div className="summary-header">
          <span className="summary-icon">📜</span>
          <strong>Resumo da história até aqui</strong>
        </div>
        <div className="summary-text">
          {splitNarrativeParagraphs(trimIncompleteSummaryText(message.narrative)).map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="msg narrator">
      <div className="narrative-segments">
        {displayedSegments.map((segment, segmentIndex) => (
          segment.type === 'npc' ? (
            <div key={`${message.messageId}-segment-${segmentIndex}`} className={`narrative-segment npc-dialogue npc-dialogue--${segment.disposition}`}>
              <strong className="npc-dialogue-label">{segment.npcDisplayName ?? segment.npcName}</strong>
              <div className="narrative-text npc-dialogue-text">
                {splitNarrativeParagraphs(segment.text).map((paragraph, i) => (
                  <p key={i}>{paragraph}</p>
                ))}
              </div>
            </div>
          ) : (
            <div key={`${message.messageId}-segment-${segmentIndex}`} className="narrative-segment narrator-segment">
              <strong className="narrator-label">
                📖 Narrador
                {/* acumulado de tokens até esta msg — mesma heurística do backend (~4 chars/token) */}
                {cumulativeTokens !== undefined && (
                  <span className="narrator-token-badge">~{cumulativeTokens < 1000 ? `${cumulativeTokens}t` : `${(cumulativeTokens / 1000).toFixed(1)}kt`}</span>
                )}
              </strong>
              <div className="narrative-text">
                {splitNarrativeParagraphs(segment.text).map((paragraph, i) => (
                  <p key={i}>{paragraph}</p>
                ))}
              </div>
            </div>
          )
        ))}
      </div>

      {/* NPCs na cena com status detalhado */}
      {(() => {
        if (!message.npcs || message.npcs.length === 0) return null

        // NPCs que têm falas nesta mensagem não exibem card
        const spokennpcKeys = new Set(
          segments
            .filter((s): s is Extract<typeof s, { type: 'npc' }> => s.type === 'npc')
            .flatMap(s => [s.npcId, s.npcName, s.npcDisplayName].filter(Boolean) as string[])
        )

        const visibleNpcs = message.npcs.filter(
          m => !spokennpcKeys.has(m.id) && !spokennpcKeys.has(m.name) && !(m.displayName && spokennpcKeys.has(m.displayName))
        )

        if (visibleNpcs.length === 0) return null

        return (
          <div className="npcs-in-scene-compact">
            {visibleNpcs.map((npcMention) => {
              const npcState = npcs.find((n) => n.id === npcMention.id)
              const status = npcMention.status ?? npcState?.status
              const isEnemy = npcMention.disposition === 'hostile'

              const statusClass = status === 'incapacitated' || status === 'defeated' || status === 'dead' || status === 'left'
                ? 'npc-compact-inactive'
                : ''

              const wounds = npcState?.wounds ?? null
              const maxWounds = npcState?.maxWounds ?? null

              // Relação com o personagem: registro durável → menção do turno → derivada da disposition
              const relation = knownNpcs.find((k) => k.npcId === npcMention.id)?.relationalStatus
                ?? npcMention.relation
                ?? relationFromDisposition(npcMention.disposition)

              return (
                <div key={npcMention.id} className={`npc-compact ${npcMention.disposition} ${statusClass}`}>
                  <div className="npc-compact-header">
                    <span className="npc-compact-name">{npcMention.displayName ?? npcMention.name}</span>
                    <span className={`npc-relation-badge ${relationClass(relation)}`}>{RELATION_LABELS[relation]}</span>
                    {(npcState?.followsPlayer || npcMention.followsPlayer) && <span className="known-npc-in-scene">acompanha</span>}
                  </div>
                  <div className="npc-compact-stats">
                    {isEnemy && wounds !== null && maxWounds !== null && (
                      <span>Ferimentos: {wounds}/{maxWounds}</span>
                    )}
                    {isEnemy && npcState?.toughness != null && <span>Resistência: {npcState.toughness}</span>}
                    {isEnemy && npcState?.parry != null && <span>Aparar: {npcState.parry}</span>}
                    {npcState?.isShaken && <span className="shaken-indicator">Abalado</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* Itens ganhos/perdidos */}
      {message.itemChanges && message.itemChanges.length > 0 && (
        <div className="item-changes">
          {message.itemChanges.map((change) => (
            <span
              key={change.itemId}
              className={`item-change ${change.changeType}`}
              title={change.description || undefined}
            >
              {change.changeType === 'gained' ? '+' : '-'} {change.name} (x{change.quantity})
            </span>
          ))}
        </div>
      )}

      {/* Descrições de itens não óbvios recém-ganhos */}
      {message.itemChanges && message.itemChanges.some((c) => c.changeType === 'gained' && c.description) && (
        <div className="item-change-descriptions">
          {message.itemChanges
            .filter((c) => c.changeType === 'gained' && c.description)
            .map((c) => (
              <p key={c.itemId} className="item-change-desc">
                <span className="item-change-desc-name">{c.name}:</span> {c.description}
              </p>
            ))}
        </div>
      )}

      {/* Status changes */}
      {message.statusChanges && message.statusChanges.length > 0 && (
        <div className="status-changes">
          {message.statusChanges.map((change) => {
            const npcName = change.targetType === 'npc'
              ? npcs.find((npc) => npc.id === change.targetId)?.name
              : null
            const targetLabel = change.targetType === 'npc'
              ? ` em ${npcName ?? 'inimigo'}`
              : change.targetType === 'player'
                ? ' em você'
                : ''

            return (
              <span
                key={`${change.effectId}-${change.targetType ?? 'player'}-${change.targetId ?? ''}`}
                className={`status-change ${change.changeType}`}
              >
                {change.changeType === 'applied' ? '▲' : '▼'} {change.name}{targetLabel}
                {typeof change.turnsRemaining === 'number' ? ` (${change.turnsRemaining}t)` : ''}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
})

function ActionOptions({
  options,
  onChoose,
  disabled
}: {
  options: ActionOption[]
  onChoose: (optionId: string) => void
  disabled: boolean
}) {
  if (!options.length) return null

  const gridClass =
    options.length === 1 ? 'options-grid--single' :
    options.length === 2 ? 'options-grid--double' :
    'options-grid--quad'

  return (
    <div className="action-options">
      <p className="action-options-title">O que farás?</p>
      <div className={`options-grid ${gridClass}`}>
        {options.map((option, idx) => {
          const dc = option.diceCheck
          const hasDice = dc?.required === true
          return (
            <button
              key={option.id}
              style={{ animationDelay: `${idx * 55}ms` }}
              className={`option-btn ${hasDice ? 'has-dice-check' : ''}`}
              onClick={() => onChoose(option.id)}
              disabled={disabled}
              title={hasDice && dc?.reason ? dc.reason : option.text}
            >
              <span className="option-text">
                {hasDice && <span className="dice-check-badge">🎲</span>}
                {option.text}
              </span>
              {option.playerSpeech && (
                <span className="option-speech">"{option.playerSpeech}"</span>
              )}
              {hasDice && dc && (
                <span className="dice-check-info">
                  <span className="dice-check-label">Chance:</span>{' '}
                  <span className="dice-check-value">
                    {typeof dc.successChance === 'number' ? `${dc.successChance}%` : 'Incerta'}
                  </span>
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function InventoryPanel({ items }: { items: InventoryItem[] }) {
  if (!items.length) return null

  const bigAssets = items.filter((item) => item.category === 'vehicle' || item.category === 'property')
  const backpackItems = items.filter((item) => item.category !== 'vehicle' && item.category !== 'property')

  return (
    <>
      {backpackItems.length > 0 && (
        <div className="inventory-panel">
          <h4>Mochila</h4>
          <ul className="inventory-list">
            {backpackItems.map((item) => (
              <li key={item.id} className="inventory-item" title={item.description}>
                <span className="item-name">{item.name}</span>
                {item.quantity > 1 && <span className="item-qty">x{item.quantity}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {bigAssets.length > 0 && (
        <div className="inventory-panel">
          <h4>Bens &amp; Veículos</h4>
          <ul className="inventory-list">
            {bigAssets.map((item) => (
              <li key={item.id} className="inventory-item" title={item.description}>
                <span className="item-name">{item.name}</span>
                {item.quantity > 1 && <span className="item-qty">x{item.quantity}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function StatusEffectsPanel({ effects }: { effects: GameState['player']['statusEffects'] }) {
  if (!effects.length) return null

  return (
    <div className="status-effects-panel">
      <h4>Efeitos Ativos</h4>
      <div className="effects-list">
        {effects.map((effect) => (
          <span key={effect.id} className="effect-tag">
            {effect.name}
            {effect.turnsRemaining !== undefined && ` (${effect.turnsRemaining}t)`}
          </span>
        ))}
      </div>
    </div>
  )
}

function NpcStatusEffectsPanel({ npcs }: { npcs: NonNullable<GameState['npcs']> }) {
  const affectedNpcs = npcs.filter((npc) => (npc.statusEffects ?? []).length > 0)
  if (!affectedNpcs.length) return null

  return (
    <div className="status-effects-panel">
      <h4>Inimigos afetados</h4>
      <div className="effects-list">
        {affectedNpcs.flatMap((npc) => (npc.statusEffects ?? []).map((effect) => (
          <span key={`${npc.id}-${effect.id}`} className="effect-tag" title={npc.name}>
            {npc.name}: {effect.name}
            {effect.turnsRemaining !== undefined && ` (${effect.turnsRemaining}t)`}
          </span>
        )))}
      </div>
    </div>
  )
}

// ─── Dice Check Confirm Modal ───

function DiceCheckConfirmModal({
  option,
  onConfirm,
  onCancel
}: {
  option: ActionOption
  onConfirm: (optionId: string) => void
  onCancel: () => void
}) {
  const dc = option.diceCheck
  if (!dc) return null

  const successChance = typeof dc.successChance === 'number' ? dc.successChance : null

  return (
    <div className="dice-confirm-overlay" onClick={onCancel}>
      <div className="dice-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="dice-confirm-title">🎲 Resolução por Chance</h3>
        <p className="dice-confirm-action">{option.text}</p>

        <div className="dice-confirm-details">
          {successChance !== null && (
            <div className="dice-detail-row">
              <span className="dice-detail-label">Chance de Sucesso</span>
              <span className="dice-detail-value dice-die-value">{successChance}%</span>
            </div>
          )}
        </div>

        {dc.reason && (
          <p className="dice-confirm-reason">{dc.reason}</p>
        )}

        <div className="dice-confirm-buttons">
          <button className="btn-dice-cancel" onClick={onCancel} type="button">
            ← Voltar
          </button>
          <button className="btn-dice-confirm" onClick={() => onConfirm(option.id)} type="button">
            🎲 Confirmar Ação
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Dice Result Card (inline no chat) ───

type AttackHitPayload = {
  targetName: string
  skill: string
  attackRoll: number
  targetParry: number
  attackRaises: number
  damageTotal: number
  raiseBonusDamage?: number
  targetToughness: number
  woundsInflicted: number
  targetWounds: number
  targetShaken: boolean
  targetIncapacitated: boolean
  traitRoll: DiceRollDetail
  wildRoll: DiceRollDetail | null
  damageRolls: DiceRollDetail[]
}

type AttackMissPayload = {
  targetName: string
  skill: string
  attackRoll: number
  targetParry: number
  traitRoll: DiceRollDetail
  wildRoll: DiceRollDetail | null
}

type NpcAttackHitPayload = {
  npcId: string
  npcName: string
  skillDie: number
  attackRoll: number
  targetParry: number
  attackRaises: number
  damageTotal: number
  raiseBonusDamage: number
  playerToughness: number
  woundsInflicted: number
  playerShaken: boolean
  playerWounds: number
  playerIncapacitated: boolean
  traitRoll: DiceRollDetail
  wildRoll: DiceRollDetail | null
  damageRolls: DiceRollDetail[]
}

type NpcAttackMissPayload = {
  npcId: string
  npcName: string
  skillDie: number
  attackRoll: number
  targetParry: number
  traitRoll: DiceRollDetail
  wildRoll: DiceRollDetail | null
}

function AttackResultCard({ event }: { event: SessionEvent }) {
  const isHit = event.type === 'attack_hit'
  const p = event.payload as unknown as AttackHitPayload & AttackMissPayload
  const traitRoll = p.traitRoll
  const wildRoll = p.wildRoll

  return (
    <div className={`dice-result-card ${isHit ? 'dice-success' : 'dice-failure'}`}>
      <div className="dice-result-header">
        <span className="dice-result-icon">{isHit ? '⚔️' : '❌'}</span>
        <span className="dice-result-title">{p.skill} → {p.targetName}</span>
        {isHit ? (
          <span className="dice-result-badge success">
            {p.attackRaises > 0
              ? `Acertou +${p.attackRaises} ampliaç${p.attackRaises > 1 ? 'ões' : 'ão'}`
              : 'Acertou'}
          </span>
        ) : (
          <span className="dice-result-badge failure">Errou</span>
        )}
      </div>

      {/* Rolagem de ataque */}
      <div className="dice-result-rolls">
        {traitRoll && (
          <div className="dice-roll-group">
            <span className="dice-roll-label">Ataque d{traitRoll.sides}</span>
            <div className="dice-roll-values">
              {traitRoll.rolls?.map((r: number, i: number) => (
                <span key={i} className={`dice-value ${traitRoll.aced ? 'aced' : ''}`}>
                  {r}{traitRoll.aced && i < traitRoll.rolls.length - 1 ? '🔥' : ''}
                </span>
              )) ?? <span className="dice-value">{traitRoll.total}</span>}
              <span className="dice-roll-total">= {traitRoll.total}</span>
            </div>
          </div>
        )}
        {wildRoll && (
          <div className="dice-roll-group">
            <span className="dice-roll-label">Wild d6</span>
            <div className="dice-roll-values">
              {wildRoll.rolls?.map((r: number, i: number) => (
                <span key={i} className={`dice-value ${wildRoll.aced ? 'aced' : ''}`}>
                  {r}{wildRoll.aced && i < wildRoll.rolls.length - 1 ? '🔥' : ''}
                </span>
              )) ?? <span className="dice-value">{wildRoll.total}</span>}
              <span className="dice-roll-total">= {wildRoll.total}</span>
            </div>
          </div>
        )}
      </div>
      <div className="dice-result-summary">
        <span className="dice-final">Ataque: <strong>{p.attackRoll}</strong></span>
        <span className="dice-tn">Aparar: {p.targetParry}</span>
      </div>

      {/* Dano (apenas em acerto) */}
      {isHit && (
        <>
          <div className="dice-result-rolls attack-damage-rolls">
            {p.damageRolls?.map((dr, i) => {
              const diceLabel = dr.label === 'str'
                ? `Força d${dr.sides}`
                : dr.label === 'bonus'
                  ? `Bônus d${dr.sides}`
                  : `Arma d${dr.sides}`
              return (
                <div key={i} className="dice-roll-group">
                  <span className="dice-roll-label">{diceLabel}</span>
                  <div className="dice-roll-values">
                    {dr.rolls.map((r: number, j: number) => (
                      <span key={j} className={`dice-value ${dr.aced ? 'aced' : ''}`}>
                        {r}{dr.aced && j < dr.rolls.length - 1 ? '🔥' : ''}
                      </span>
                    ))}
                    <span className="dice-roll-total">= {dr.total}</span>
                  </div>
                </div>
              )
            })}
            {(p.raiseBonusDamage ?? 0) > 0 && (
              <div className="dice-roll-group">
                <span className="dice-roll-label">Ampliação d6</span>
                <div className="dice-roll-values">
                  <span className="dice-value">{p.raiseBonusDamage}</span>
                </div>
              </div>
            )}
          </div>
          <div className="dice-result-summary">
            <span className="dice-final">Dano: <strong>{p.damageTotal}</strong></span>
            <span className="dice-tn">Resistência: {p.targetToughness}</span>
            {p.targetIncapacitated ? (
              <span className="attack-result-status incapacitated">Incapacitado</span>
            ) : p.woundsInflicted > 0 ? (
              <span className="attack-result-status wounded">{p.woundsInflicted} ferimento{p.woundsInflicted > 1 ? 's' : ''} — total: {p.targetWounds ?? p.woundsInflicted}</span>
            ) : p.targetShaken ? (
              <span className="attack-result-status shaken">Abalado</span>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}

function NpcAttackResultCard({ event }: { event: SessionEvent }) {
  const isHit = event.type === 'npc_attack_hit'
  const p = event.payload as unknown as NpcAttackHitPayload & NpcAttackMissPayload
  const traitRoll = p.traitRoll
  const wildRoll = p.wildRoll

  return (
    <div className={`dice-result-card ${isHit ? 'dice-failure' : 'dice-success'}`}>
      <div className="dice-result-header">
        <span className="dice-result-icon">{isHit ? '🗡️' : '🛡️'}</span>
        <span className="dice-result-title">{p.npcName} ataca você</span>
        {isHit ? (
          <span className="dice-result-badge failure">
            {p.attackRaises > 0
              ? `Acertou +${p.attackRaises} ampliaç${p.attackRaises > 1 ? 'ões' : 'ão'}`
              : 'Acertou'}
          </span>
        ) : (
          <span className="dice-result-badge success">Errou</span>
        )}
      </div>

      <div className="dice-result-rolls">
        {traitRoll && (
          <div className="dice-roll-group">
            <span className="dice-roll-label">Ataque d{traitRoll.sides}</span>
            <div className="dice-roll-values">
              {traitRoll.rolls?.map((r: number, i: number) => (
                <span key={i} className={`dice-value ${traitRoll.aced ? 'aced' : ''}`}>
                  {r}{traitRoll.aced && i < traitRoll.rolls.length - 1 ? '🔥' : ''}
                </span>
              )) ?? <span className="dice-value">{traitRoll.total}</span>}
              <span className="dice-roll-total">= {traitRoll.total}</span>
            </div>
          </div>
        )}
        {wildRoll && (
          <div className="dice-roll-group">
            <span className="dice-roll-label">Wild d6</span>
            <div className="dice-roll-values">
              {wildRoll.rolls?.map((r: number, i: number) => (
                <span key={i} className={`dice-value ${wildRoll.aced ? 'aced' : ''}`}>
                  {r}{wildRoll.aced && i < wildRoll.rolls.length - 1 ? '🔥' : ''}
                </span>
              )) ?? <span className="dice-value">{wildRoll.total}</span>}
              <span className="dice-roll-total">= {wildRoll.total}</span>
            </div>
          </div>
        )}
      </div>

      <div className="dice-result-summary">
        <span className="dice-final">Ataque: <strong>{p.attackRoll}</strong></span>
        <span className="dice-tn">Aparar: {p.targetParry}</span>
      </div>

      {isHit && (
        <>
          <div className="dice-result-rolls attack-damage-rolls">
            {p.damageRolls?.map((dr, i) => {
              const diceLabel = dr.label === 'str'
                ? `Força d${dr.sides}`
                : dr.label === 'bonus'
                  ? `Bônus d${dr.sides}`
                  : `Arma d${dr.sides}`
              return (
                <div key={i} className="dice-roll-group">
                  <span className="dice-roll-label">{diceLabel}</span>
                  <div className="dice-roll-values">
                    {dr.rolls.map((r: number, j: number) => (
                      <span key={j} className={`dice-value ${dr.aced ? 'aced' : ''}`}>
                        {r}{dr.aced && j < dr.rolls.length - 1 ? '🔥' : ''}
                      </span>
                    ))}
                    <span className="dice-roll-total">= {dr.total}</span>
                  </div>
                </div>
              )
            })}
            {(p.raiseBonusDamage ?? 0) > 0 && (
              <div className="dice-roll-group">
                <span className="dice-roll-label">Ampliação d6</span>
                <div className="dice-roll-values">
                  <span className="dice-value">{p.raiseBonusDamage}</span>
                </div>
              </div>
            )}
          </div>
          <div className="dice-result-summary">
            <span className="dice-final">Dano: <strong>{p.damageTotal}</strong></span>
            <span className="dice-tn">Resistência: {p.playerToughness}</span>
            {p.playerIncapacitated ? (
              <span className="attack-result-status incapacitated">Você está incapacitado — ferimentos: {p.playerWounds}</span>
            ) : p.woundsInflicted > 0 ? (
              <span className="attack-result-status wounded">{p.woundsInflicted} ferimento{p.woundsInflicted > 1 ? 's' : ''} sofrido{p.woundsInflicted > 1 ? 's' : ''} — total: {p.playerWounds}</span>
            ) : p.playerShaken ? (
              <span className="attack-result-status shaken">Abalado</span>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}

type SoakRollPayload = {
  vigorDie: number
  traitRoll: DiceRollDetail
  wildRoll: DiceRollDetail | null
  finalTotal: number
  isSuccess: boolean
  woundsSoaked: number
  remainingWounds: number
  remainingBennies: number
  shakenRemoved: boolean
}

function SoakRollCard({ event }: { event: SessionEvent }) {
  const p = event.payload as unknown as SoakRollPayload
  const traitRoll = p.traitRoll
  const wildRoll = p.wildRoll

  return (
    <div className={`dice-result-card ${p.isSuccess ? 'dice-success' : 'dice-failure'}`}>
      <div className="dice-result-header">
        <span className="dice-result-icon">🛡️</span>
        <span className="dice-result-title">Absorção de Dano</span>
        <span className={`dice-result-badge ${p.isSuccess ? 'success' : 'failure'}`}>
          {p.isSuccess
            ? `Absorveu ${p.woundsSoaked} ferimento${p.woundsSoaked !== 1 ? 's' : ''}`
            : 'Falhou'}
        </span>
      </div>

      <div className="dice-result-rolls">
        {traitRoll && (
          <div className="dice-roll-group">
            <span className="dice-roll-label">Vigor d{p.vigorDie}</span>
            <div className="dice-roll-values">
              {traitRoll.rolls?.map((r: number, i: number) => (
                <span key={i} className={`dice-value ${traitRoll.aced ? 'aced' : ''}`}>
                  {r}{traitRoll.aced && i < traitRoll.rolls.length - 1 ? '🔥' : ''}
                </span>
              )) ?? <span className="dice-value">{traitRoll.total}</span>}
              <span className="dice-roll-total">= {traitRoll.total}</span>
            </div>
          </div>
        )}
        {wildRoll && (
          <div className="dice-roll-group">
            <span className="dice-roll-label">Wild d6</span>
            <div className="dice-roll-values">
              {wildRoll.rolls?.map((r: number, i: number) => (
                <span key={i} className={`dice-value ${wildRoll.aced ? 'aced' : ''}`}>
                  {r}{wildRoll.aced && i < wildRoll.rolls.length - 1 ? '🔥' : ''}
                </span>
              )) ?? <span className="dice-value">{wildRoll.total}</span>}
              <span className="dice-roll-total">= {wildRoll.total}</span>
            </div>
          </div>
        )}
      </div>

      <div className="dice-result-summary">
        <span className="dice-final">Total: <strong>{p.finalTotal}</strong></span>
        <span className="dice-tn">TN: 4</span>
        {p.isSuccess && p.shakenRemoved && (
          <span className="attack-result-status shaken">Abalado removido</span>
        )}
        <span className="dice-mod">Bennies: {p.remainingBennies}</span>
        {!p.isSuccess && (
          <span className="attack-result-status wounded">Ferimentos restantes: {p.remainingWounds}</span>
        )}
      </div>
    </div>
  )
}

type NpcSoakRollPayload = {
  npcId: string
  npcName: string
  vigorDie: number
  modifier: number
  traitRoll: DiceRollDetail
  wildRoll: DiceRollDetail | null
  finalTotal: number
  isSuccess: boolean
  woundsSoaked: number
  remainingWounds: number
  remainingBennies: number
}

function NpcSoakRollCard({ event }: { event: SessionEvent }) {
  const p = event.payload as unknown as NpcSoakRollPayload
  const traitRoll = p.traitRoll
  const wildRoll = p.wildRoll

  return (
    <div className={`dice-result-card ${p.isSuccess ? 'dice-success' : 'dice-failure'}`}>
      <div className="dice-result-header">
        <span className="dice-result-icon">🛡️</span>
        <span className="dice-result-title">{p.npcName} — Absorção</span>
        <span className={`dice-result-badge ${p.isSuccess ? 'success' : 'failure'}`}>
          {p.isSuccess
            ? `Absorveu ${p.woundsSoaked} ferimento${p.woundsSoaked !== 1 ? 's' : ''}`
            : 'Falhou'}
        </span>
      </div>

      <div className="dice-result-rolls">
        {traitRoll && (
          <div className="dice-roll-group">
            <span className="dice-roll-label">Vigor d{p.vigorDie}</span>
            <div className="dice-roll-values">
              {traitRoll.rolls?.map((r: number, i: number) => (
                <span key={i} className={`dice-value ${traitRoll.aced ? 'aced' : ''}`}>
                  {r}{traitRoll.aced && i < traitRoll.rolls.length - 1 ? '🔥' : ''}
                </span>
              )) ?? <span className="dice-value">{traitRoll.total}</span>}
              <span className="dice-roll-total">= {traitRoll.total}</span>
            </div>
          </div>
        )}
        {wildRoll && (
          <div className="dice-roll-group">
            <span className="dice-roll-label">Wild d6</span>
            <div className="dice-roll-values">
              {wildRoll.rolls?.map((r: number, i: number) => (
                <span key={i} className={`dice-value ${wildRoll.aced ? 'aced' : ''}`}>
                  {r}{wildRoll.aced && i < wildRoll.rolls.length - 1 ? '🔥' : ''}
                </span>
              )) ?? <span className="dice-value">{wildRoll.total}</span>}
              <span className="dice-roll-total">= {wildRoll.total}</span>
            </div>
          </div>
        )}
      </div>

      <div className="dice-result-summary">
        <span className="dice-final">Total: <strong>{p.finalTotal}</strong></span>
        <span className="dice-tn">TN: 4</span>
        <span className="dice-mod">Bennies: {p.remainingBennies}</span>
        {p.isSuccess
          ? <span className="attack-result-status shaken">Ferimentos restantes: {p.remainingWounds}</span>
          : <span className="attack-result-status wounded">Ferimentos restantes: {p.remainingWounds}</span>
        }
      </div>
    </div>
  )
}

type RecoverShakenPayload = {
  spiritDie: number
  traitRoll: DiceRollDetail
  wildRoll: DiceRollDetail | null
  finalTotal: number
  recovered: boolean
  withRaise?: boolean
}

function RecoverShakenCard({ event }: { event: SessionEvent }) {
  const p = event.payload as unknown as RecoverShakenPayload
  const traitRoll = p.traitRoll
  const wildRoll = p.wildRoll

  return (
    <div className={`dice-result-card ${p.recovered ? 'dice-success' : 'dice-failure'}`}>
      <div className="dice-result-header">
        <span className="dice-result-icon">✊</span>
        <span className="dice-result-title">Recuperar Abalado</span>
        <span className={`dice-result-badge ${p.recovered ? 'success' : 'failure'}`}>
          {p.recovered
            ? p.withRaise ? 'Recuperado com Ampliação' : 'Recuperado'
            : 'Permanece Abalado'}
        </span>
      </div>

      <div className="dice-result-rolls">
        {traitRoll && (
          <div className="dice-roll-group">
            <span className="dice-roll-label">Espírito d{p.spiritDie}</span>
            <div className="dice-roll-values">
              {traitRoll.rolls?.map((r: number, i: number) => (
                <span key={i} className={`dice-value ${traitRoll.aced ? 'aced' : ''}`}>
                  {r}{traitRoll.aced && i < traitRoll.rolls.length - 1 ? '🔥' : ''}
                </span>
              )) ?? <span className="dice-value">{traitRoll.total}</span>}
              <span className="dice-roll-total">= {traitRoll.total}</span>
            </div>
          </div>
        )}
        {wildRoll && (
          <div className="dice-roll-group">
            <span className="dice-roll-label">Wild d6</span>
            <div className="dice-roll-values">
              {wildRoll.rolls?.map((r: number, i: number) => (
                <span key={i} className={`dice-value ${wildRoll.aced ? 'aced' : ''}`}>
                  {r}{wildRoll.aced && i < wildRoll.rolls.length - 1 ? '🔥' : ''}
                </span>
              )) ?? <span className="dice-value">{wildRoll.total}</span>}
              <span className="dice-roll-total">= {wildRoll.total}</span>
            </div>
          </div>
        )}
      </div>

      <div className="dice-result-summary">
        <span className="dice-final">Total: <strong>{p.finalTotal}</strong></span>
        <span className="dice-tn">TN: 4</span>
      </div>
    </div>
  )
}

type ChanceCheckResultPayload = {
  description: string
  success: boolean
  chance: number
  roll: number
  reason: string
}

function ChanceCheckResultCard({ event }: { event: SessionEvent }) {
  const p = event.payload as unknown as ChanceCheckResultPayload

  return (
    <div className={`dice-result-card ${p.success ? 'dice-success' : 'dice-failure'}`}>
      <div className="dice-result-header">
        <span className="dice-result-icon">{p.success ? '🎲' : '❌'}</span>
        <span className="dice-result-title">{p.description || 'Teste de Chance'}</span>
        <span className={`dice-result-badge ${p.success ? 'success' : 'failure'}`}>
          {p.success ? 'Sucesso' : 'Falha'}
        </span>
      </div>

      <div className="dice-result-rolls">
        <div className="dice-roll-group">
          <span className="dice-roll-label">Resultado d100</span>
          <div className="dice-roll-values">
            <span className="dice-value">{Math.round(p.roll)}</span>
            <span className="dice-roll-total">vs Limiar {p.chance}%</span>
          </div>
        </div>
      </div>

      <div className="dice-result-summary">
        <span className="dice-final">Chance: <strong>{p.chance}%</strong></span>
        <span className="dice-tn">Rolado: {Math.round(p.roll)}</span>
      </div>

      {p.reason && (
        <p className="dice-confirm-reason" style={{ marginTop: '8px', fontSize: '0.85rem', opacity: 0.8 }}>{p.reason}</p>
      )}
    </div>
  )
}

function DiceResultCard({ event }: { event: SessionEvent }) {
  if (event.type === 'chance_check_result') {
    return <ChanceCheckResultCard event={event} />
  }
  if (event.type === 'attack_hit' || event.type === 'attack_miss') {
    return <AttackResultCard event={event} />
  }
  if (event.type === 'npc_attack_hit' || event.type === 'npc_attack_miss') {
    return <NpcAttackResultCard event={event} />
  }
  if (event.type === 'soak_roll') {
    return <SoakRollCard event={event} />
  }
  if (event.type === 'npc_soak_roll') {
    return <NpcSoakRollCard event={event} />
  }
  if (event.type === 'recover_shaken' || event.type === 'recover_shaken_failed') {
    return <RecoverShakenCard event={event} />
  }
  if (event.type !== 'trait_test') return null

  const p = event.payload as unknown as TraitTestPayload
  const rawTrait = p.trait?.trim() ?? ''
  const traitName = (ATTR_LABEL_MAP[rawTrait] ?? rawTrait) || 'Teste'
  const traitRoll = p.traitRoll
  const wildRoll = p.wildRoll
  const modifier = p.modifier ?? 0
  const targetNumber = p.targetNumber ?? 4
  const bestRoll = Math.max(traitRoll?.total ?? Number.NEGATIVE_INFINITY, wildRoll?.total ?? Number.NEGATIVE_INFINITY)
  const derivedFinalTotal = bestRoll === Number.NEGATIVE_INFINITY ? modifier : bestRoll + modifier
  const finalTotal = typeof p.finalTotal === 'number' ? p.finalTotal : derivedFinalTotal
  const isSuccess = typeof p.isSuccess === 'boolean' ? p.isSuccess : finalTotal >= targetNumber
  const raises = typeof p.raises === 'number'
    ? p.raises
    : isSuccess
      ? Math.max(0, Math.floor((finalTotal - targetNumber) / 4))
      : 0

  return (
    <div className={`dice-result-card ${isSuccess ? 'dice-success' : 'dice-failure'}`}>
      <div className="dice-result-header">
        <span className="dice-result-icon">{isSuccess ? '✅' : '❌'}</span>
        <span className="dice-result-title">
          Teste de {traitName}
        </span>
        <span className={`dice-result-badge ${isSuccess ? 'success' : 'failure'}`}>
          {isSuccess ? (raises > 0 ? `Sucesso +${raises} ampliaç${raises > 1 ? 'ões' : 'ão'}` : 'Sucesso') : 'Falha'}
        </span>
      </div>

      <div className="dice-result-rolls">
        <div className="dice-roll-group">
          <span className="dice-roll-label">Trait (Traço) d{traitRoll?.sides ?? p.dieSides}</span>
          <div className="dice-roll-values">
            {traitRoll?.rolls?.map((r: number, i: number) => (
              <span key={i} className={`dice-value ${traitRoll.aced ? 'aced' : ''}`}>
                {r}{traitRoll.aced && i < traitRoll.rolls.length - 1 ? '🔥' : ''}
              </span>
            )) ?? <span className="dice-value">{traitRoll?.total ?? '?'}</span>}
            <span className="dice-roll-total">= {traitRoll?.total ?? '?'}</span>
          </div>
        </div>

        <div className="dice-roll-group">
          <span className="dice-roll-label">Wild Die (Dado Selvagem) d6</span>
          <div className="dice-roll-values">
            {wildRoll?.rolls?.map((r: number, i: number) => (
              <span key={i} className={`dice-value ${wildRoll.aced ? 'aced' : ''}`}>
                {r}{wildRoll.aced && i < wildRoll.rolls.length - 1 ? '🔥' : ''}
              </span>
            )) ?? <span className="dice-value">{wildRoll?.total ?? '?'}</span>}
            <span className="dice-roll-total">= {wildRoll?.total ?? '?'}</span>
          </div>
        </div>
      </div>

      <div className="dice-result-summary">
        {modifier !== 0 && (
          <span className="dice-mod">Mod: {modifier > 0 ? '+' : ''}{modifier}</span>
        )}
        <span className="dice-final">Total: <strong>{finalTotal}</strong></span>
        <span className="dice-tn">TN: {targetNumber}</span>
      </div>

      {p.description && (
        <p className="dice-result-desc">{p.description}</p>
      )}
    </div>
  )
}

// ─── Character Sidebar ───

type SidebarTab = 'status' | 'inventory' | 'known' | 'narration'

const SIDEBAR_TABS: { key: SidebarTab; label: string; icon: string }[] = [
  { key: 'status', label: 'Status', icon: '❤️' },
  { key: 'inventory', label: 'Mochila', icon: '🎒' },
  { key: 'known', label: 'Conhecidos', icon: '👥' },
  { key: 'narration', label: 'Narração', icon: '🎭' },
]

function CharacterSidebar({
  state,
  open,
  activeTab,
  onTabChange,
  onClose,
  onReset,
  resetting,
  onRemoveItem,
  onEquipAttack,
  onUnequipAttack,
  onEquipArmor,
  onUnequipArmor,
  onEquipShield,
  onUnequipShield,
  narrativeStyle,
  simpleVocabulary,
  onNarrativeStyleChange,
  onSimpleVocabularyChange,
  savingNarration,
  knownNpcs = [],
  onUpdateKnownNpc,
}: {
  state: GameState | null
  open: boolean
  activeTab: SidebarTab
  onTabChange: (tab: SidebarTab) => void
  onClose: () => void
  onReset: () => void
  resetting: boolean
  onRemoveItem?: (itemId: string) => void
  onEquipAttack?: (itemId: string) => Promise<void>
  onUnequipAttack?: () => Promise<void>
  onEquipArmor?: (itemId: string) => Promise<void>
  onUnequipArmor?: () => Promise<void>
  onEquipShield?: (itemId: string) => Promise<void>
  onUnequipShield?: () => Promise<void>
  narrativeStyle?: NarrativeStyle
  simpleVocabulary?: boolean
  onNarrativeStyleChange: (style: NarrativeStyle) => void
  onSimpleVocabularyChange: (simple: boolean) => void
  savingNarration: boolean
  knownNpcs?: KnownNpc[]
  onUpdateKnownNpc?: (npcId: string, patch: { relationalStatus?: Exclude<RelationalStatus, 'desconhecido'>; notes?: string; resetToAuto?: boolean }) => Promise<void>
}) {
  const [confirmReset, setConfirmReset] = useState(false)

  if (!open) return null
  const p = state?.player

  return (
    <>
      <div className="sidebar-overlay" onClick={onClose} />
      <aside className="character-sidebar">
        <div className="sidebar-header">
          <h3>{p?.name ?? 'Personagem'}</h3>
          <button className="sidebar-close" onClick={onClose} type="button" aria-label="Fechar">✕</button>
        </div>

        {/* Mini-abas */}
        <nav className="sidebar-tabs">
          {SIDEBAR_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              className={`sidebar-tab${activeTab === t.key ? ' active' : ''}`}
              onClick={() => onTabChange(t.key)}
              title={t.label}
            >
              <span className="tab-icon">{t.icon}</span>
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>

        {/* Conteúdo da aba */}
        <div className="sidebar-content">
          {activeTab === 'narration' ? (
            <SidebarNarration
              narrativeStyle={narrativeStyle}
              simpleVocabulary={simpleVocabulary}
              onStyleChange={onNarrativeStyleChange}
              onVocabChange={onSimpleVocabularyChange}
              saving={savingNarration}
            />
          ) : !p ? (
            <p className="muted">Carregando...</p>
          ) : (
            <>
              {activeTab === 'status' && (
                <SidebarOverview
                  player={p}
                  location={state?.worldState.activeLocation ?? '?'}
                  turn={state?.meta.turn ?? 0}
                  chapter={state?.meta.chapter ?? 0}
                />
              )}
              {activeTab === 'inventory' && (
                <SidebarInventory
                  items={p.inventory}
                  onRemove={onRemoveItem}
                  equippedAttackItemId={p.equippedAttackItemId}
                  equippedArmorItemId={p.equippedArmorItemId}
                  equippedShieldItemId={p.equippedShieldItemId}
                  onEquipAttack={onEquipAttack}
                  onUnequipAttack={onUnequipAttack}
                  onEquipArmor={onEquipArmor}
                  onUnequipArmor={onUnequipArmor}
                  onEquipShield={onEquipShield}
                  onUnequipShield={onUnequipShield}
                />
              )}
              {activeTab === 'known' && (
                <SidebarKnownNpcs
                  knownNpcs={knownNpcs}
                  activeLocation={state?.worldState.activeLocation}
                  sceneNpcIds={new Set((state?.npcs ?? []).filter((npc) => npc.status !== 'left').map((npc) => npc.id))}
                  onUpdate={onUpdateKnownNpc}
                />
              )}
            </>
          )}
        </div>

        {/* Botão de reiniciar história */}
        <div className="sidebar-footer">
          {confirmReset ? (
            <div className="sidebar-confirm-reset">
              <p className="sidebar-confirm-text">Todo o progresso será perdido. Tem certeza?</p>
              <div className="sidebar-confirm-actions">
                <button
                  type="button"
                  className="btn-confirm-cancel"
                  onClick={() => setConfirmReset(false)}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="btn-confirm-danger"
                  disabled={resetting}
                  onClick={() => { setConfirmReset(false); onReset() }}
                >
                  {resetting ? '↻ Reiniciando...' : 'Sim, reiniciar'}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              className="btn-reset-story"
              disabled={resetting}
              onClick={() => setConfirmReset(true)}
            >
              {resetting ? '↻ Reiniciando...' : '🔄 Reiniciar História'}
            </button>
          )}
        </div>
      </aside>
    </>
  )
}

const NARRATIVE_STYLES: { key: NarrativeStyle; label: string; icon: string; desc: string }[] = [
  { key: 'concise', label: 'Conciso', icon: '⚡', desc: 'Até 3 frases. Direto ao ponto, sem floreios.' },
  { key: 'balanced', label: 'Equilibrado', icon: '⚖️', desc: '4–6 frases. Ação e atmosfera balanceadas.' },
]

function SidebarNarration({
  narrativeStyle,
  simpleVocabulary,
  onStyleChange,
  onVocabChange,
  saving,
}: {
  narrativeStyle: NarrativeStyle | undefined
  simpleVocabulary: boolean | undefined
  onStyleChange: (style: NarrativeStyle) => void
  onVocabChange: (simple: boolean) => void
  saving: boolean
}) {
  const current = narrativeStyle ?? 'concise'
  return (
    <div className="sidebar-narration">
      <p className="narration-hint">Define o estilo e ritmo das narrações do mestre. A mudança vale a partir do próximo turno.</p>

      <div className="narration-style-list">
        {NARRATIVE_STYLES.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`narration-style-card${current === s.key ? ' active' : ''}`}
            onClick={() => onStyleChange(s.key)}
            disabled={saving}
          >
            <span className="narration-style-icon">{s.icon}</span>
            <div className="narration-style-text">
              <span className="narration-style-label">{s.label}</span>
              <span className="narration-style-desc">{s.desc}</span>
            </div>
            {current === s.key && <span className="narration-style-check">✓</span>}
          </button>
        ))}
      </div>

      <label className="narration-vocab-toggle">
        <input
          type="checkbox"
          checked={simpleVocabulary ?? true}
          onChange={(e) => onVocabChange(e.target.checked)}
          disabled={saving}
        />
        <span className="narration-vocab-text">
          <strong>Vocabulário simples</strong>
          <span className="narration-vocab-hint">Palavras comuns, frases curtas e diretas.</span>
        </span>
      </label>

      {saving && <p className="narration-saving">Salvando...</p>}
    </div>
  )
}

function SidebarOverview({ player, location, turn, chapter }: {
  player: GameState['player']
  location: string
  turn: number
  chapter: number
}) {
  return (
    <div className="sidebar-overview">
      <SidebarStatus player={player} location={location} turn={turn} chapter={chapter} />

      <h4 className="sidebar-section-header">Atributos</h4>
      <SidebarAttributes player={player} />

      <h4 className="sidebar-section-header">Perícias</h4>
      <SidebarSkills player={player} />

      <h4 className="sidebar-section-header">Vantagens &amp; Complicações</h4>
      <SidebarEdges edges={player.edges} hindrances={player.hindrances} />

      <h4 className="sidebar-section-header">Efeitos Ativos</h4>
      <SidebarEffects effects={player.statusEffects} />
    </div>
  )
}

function SidebarStatus({ player: p, location, turn, chapter }: {
  player: GameState['player']
  location: string
  turn: number
  chapter: number
}) {
  return (
    <div className="sidebar-status">
      <div className="status-grid">
        <div className="stat-card">
          <span className="stat-value">{p.wounds}/{p.maxWounds}</span>
          <span className="stat-label">Ferimentos</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{p.fatigue}</span>
          <span className="stat-label">Fadiga</span>
        </div>
        <div className="stat-card accent">
          <span className="stat-value">{p.bennies}</span>
          <span className="stat-label">Bennies</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{p.parry}</span>
          <span className="stat-label">Aparar</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{p.toughness}{p.armor ? `(${p.armor})` : ''}</span>
          <span className="stat-label">Resistência</span>
        </div>
        <div className="stat-card">
          <span className="stat-value">{p.pace}</span>
          <span className="stat-label">Deslocamento</span>
        </div>
      </div>

      {p.isShaken && <div className="status-badge shaken">ABALADO</div>}

      <div className="status-info">
        <div><strong>Local:</strong> {location}</div>
        <div><strong>Turno:</strong> {turn} &middot; <strong>Cap:</strong> {chapter}</div>
      </div>
    </div>
  )
}

function SidebarAttributes({ player: p }: { player: GameState['player'] }) {
  return (
    <div className="sidebar-attr-list">
      {ATTRIBUTES.map((a) => (
        <div key={a.key} className="sidebar-attr-row">
          <span className="attr-name">{a.label}</span>
          <span className="attr-die">{dieLabel(p.attributes[a.key] ?? 4)}</span>
        </div>
      ))}
    </div>
  )
}

function SidebarSkills({ player: p }: { player: GameState['player'] }) {
  const entries = Object.entries(p.skills)
  if (!entries.length) return <p className="muted">Nenhuma perícia</p>

  // Agrupar por atributo vinculado
  const grouped = new Map<string, { key: string; label: string; die: number }[]>()
  for (const [key, die] of entries) {
    const def = SKILLS.find((s) => s.key === key)
    const attr = def?.linkedAttribute ?? 'other'
    if (!grouped.has(attr)) grouped.set(attr, [])
    grouped.get(attr)!.push({ key, label: def?.label ?? key, die })
  }

  const attrLabel = (k: string) => ATTRIBUTES.find((a) => a.key === k)?.label ?? k

  return (
    <div className="sidebar-skills">
      {[...grouped.entries()].map(([attr, skills]) => (
        <div key={attr} className="skill-group">
          <h5 className="skill-group-header">{attrLabel(attr)}</h5>
          {skills.map((s) => (
            <div key={s.key} className="sidebar-skill-row">
              <span className="skill-name">{s.label}</span>
              <span className="skill-die">{dieLabel(s.die)}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function SidebarInventory({
  items,
  onRemove,
  equippedAttackItemId,
  equippedArmorItemId,
  equippedShieldItemId,
  onEquipAttack,
  onUnequipAttack,
  onEquipArmor,
  onUnequipArmor,
  onEquipShield,
  onUnequipShield,
}: {
  items: InventoryItem[]
  onRemove?: (itemId: string) => void
  equippedAttackItemId?: string
  equippedArmorItemId?: string
  equippedShieldItemId?: string
  onEquipAttack?: (itemId: string) => Promise<void>
  onUnequipAttack?: () => Promise<void>
  onEquipArmor?: (itemId: string) => Promise<void>
  onUnequipArmor?: () => Promise<void>
  onEquipShield?: (itemId: string) => Promise<void>
  onUnequipShield?: () => Promise<void>
}) {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  if (!items.length) return <p className="muted">Mochila vazia</p>

  return (
    <div className="sidebar-inventory">
      {items.map((item) => {
        // Espelha a lógica do backend (isShieldItem em constants.ts): prioriza
        // os campos definidos pela narrativa na criação do item; para itens
        // antigos sem esses campos, cai no heurístico por nome.
        const isShield = item.category === 'armor' && (
          typeof item.parryBonus === 'number'
            ? item.parryBonus > 0
            : typeof item.armorValue === 'number'
              ? false
              : /escudo/i.test(item.name)
        )
        const isArmor = item.category === 'armor' && !isShield
        const isWeapon = item.category === 'weapon'
        const isEquippable = isWeapon || isArmor || isShield

        const isEquipped = isWeapon
          ? item.id === equippedAttackItemId
          : isShield
            ? item.id === equippedShieldItemId
            : isArmor
              ? item.id === equippedArmorItemId
              : false

        const equipHandler = isWeapon ? onEquipAttack : isShield ? onEquipShield : isArmor ? onEquipArmor : undefined
        const unequipHandler = isWeapon ? onUnequipAttack : isShield ? onUnequipShield : isArmor ? onUnequipArmor : undefined
        const equipLabel = isWeapon ? 'Equipar como arma' : isShield ? 'Equipar escudo' : 'Equipar armadura'

        return (
          <div key={item.id} className={`sidebar-inv-item${isEquipped ? ' equipped' : ''}`}>
            <div className="inv-item-header">
              <span className="inv-item-name">
                {item.name}
                {isEquipped && <span className="inv-equipped-badge">Equipado</span>}
              </span>
              <span className="inv-item-header-right">
                {item.quantity > 1 && <span className="inv-item-qty">x{item.quantity}</span>}
                {onRemove && (
                  confirmId === item.id ? (
                    <span className="inv-item-confirm">
                      <button type="button" className="inv-confirm-yes" onClick={() => { setConfirmId(null); onRemove(item.id) }}>Descartar</button>
                      <button type="button" className="inv-confirm-no" onClick={() => setConfirmId(null)}>✕</button>
                    </span>
                  ) : (
                    <button type="button" className="inv-item-remove" title="Descartar item" onClick={() => setConfirmId(item.id)}>🗑️</button>
                  )
                )}
              </span>
            </div>
            {confirmId === item.id && (
              <p className="inv-confirm-text">Descartar "{item.name}"?</p>
            )}
            {item.description && <p className="inv-item-desc">{item.description}</p>}
            {(item.tags && item.tags.length > 0) || (isArmor && item.armorValue) || (isShield && item.parryBonus) ? (
              <div className="inv-item-tags">
                {isArmor && item.armorValue ? <span className="inv-tag inv-tag-stat">+{item.armorValue} Resistência</span> : null}
                {isShield && item.parryBonus ? <span className="inv-tag inv-tag-stat">+{item.parryBonus} Aparar</span> : null}
                {item.tags?.map((t) => <span key={t} className="inv-tag">{t}</span>)}
              </div>
            ) : null}
            {isEquippable && (
              <div className="inv-item-equip-row">
                {isEquipped ? (
                  <button
                    type="button"
                    className="btn-unequip"
                    disabled={!unequipHandler}
                    onClick={() => void unequipHandler?.()}
                  >
                    Desequipar
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn-equip"
                    disabled={!equipHandler}
                    onClick={() => void equipHandler?.(item.id)}
                  >
                    {equipLabel}
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function SidebarEdges({ edges, hindrances }: { edges: string[]; hindrances: Hindrance[] }) {
  const hasEdges = edges.length > 0
  const hasHindrances = hindrances.length > 0
  if (!hasEdges && !hasHindrances) return <p className="muted">Nenhuma vantagem ou complicação</p>

  return (
    <div className="sidebar-edges">
      {hasEdges && (
        <>
          <h5 className="edges-header">Vantagens</h5>
          <div className="edges-list">
            {edges.map((e) => {
              const def = EDGES.find((ed) => ed.key === e)
              return (
                <div key={e} className="edge-item">
                  <span className="edge-name">{def?.label ?? e}</span>
                  {def?.category && <span className="edge-cat">{def.category}</span>}
                </div>
              )
            })}
          </div>
        </>
      )}
      {hasHindrances && (
        <>
          <h5 className="edges-header hindrances">Complicações</h5>
          <div className="edges-list">
            {hindrances.map((h) => (
              <div key={h.name} className={`edge-item hindrance ${h.severity}`}>
                <span className="edge-name">{h.name}</span>
                <span className="edge-severity">{h.severity === 'major' ? 'Maior' : 'Menor'}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

function SidebarEffects({ effects }: { effects: Array<{ id: string; name: string; turnsRemaining?: number }> }) {
  if (!effects.length) return <p className="muted">Nenhum efeito ativo</p>

  return (
    <div className="sidebar-effects">
      {effects.map((eff) => (
        <div key={eff.id} className="sidebar-effect-row">
          <span className="effect-name">{eff.name}</span>
          {eff.turnsRemaining !== undefined && (
            <span className="effect-turns">{eff.turnsRemaining}t restantes</span>
          )}
        </div>
      ))}
    </div>
  )
}

function SidebarKnownNpcs({ knownNpcs, activeLocation, sceneNpcIds, onUpdate }: {
  knownNpcs: KnownNpc[]
  activeLocation?: string
  sceneNpcIds: Set<string>
  onUpdate?: (npcId: string, patch: { relationalStatus?: Exclude<RelationalStatus, 'desconhecido'>; notes?: string; resetToAuto?: boolean }) => Promise<void>
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [notesDraft, setNotesDraft] = useState('')
  const [saving, setSaving] = useState(false)

  if (!knownNpcs.length) {
    return <p className="muted">Seu personagem ainda não conhece nenhum NPC.</p>
  }

  const toggleExpanded = (npc: KnownNpc) => {
    if (expandedId === npc.npcId) {
      setExpandedId(null)
      return
    }
    setExpandedId(npc.npcId)
    setNotesDraft(npc.notes ?? '')
  }

  const applyUpdate = async (npcId: string, patch: { relationalStatus?: Exclude<RelationalStatus, 'desconhecido'>; notes?: string; resetToAuto?: boolean }) => {
    if (!onUpdate || saving) return
    setSaving(true)
    try {
      await onUpdate(npcId, patch)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="known-npcs-panel">
      {knownNpcs.map((npc) => {
        const isDown = npc.conditionStatus === 'defeated' || npc.conditionStatus === 'dead' || npc.conditionStatus === 'incapacitated' || npc.conditionStatus === 'left'
        const inScene = sceneNpcIds.has(npc.npcId) && (!npc.lastKnownLocation || npc.lastKnownLocation === activeLocation)
        const expanded = expandedId === npc.npcId

        return (
          <div key={npc.npcId} className={`known-npc-row${isDown ? ' known-npc-down' : ''}`}>
            <button type="button" className="known-npc-summary" onClick={() => toggleExpanded(npc)}>
              <span className="known-npc-name">{npc.name}</span>
              <span className={`npc-relation-badge ${relationClass(npc.relationalStatus)}`}>
                {RELATION_LABELS[npc.relationalStatus]}
              </span>
              {inScene && <span className="known-npc-in-scene">na cena</span>}
            </button>
            <div className="known-npc-meta">
              {npc.followsPlayer && <span className="known-npc-in-scene">acompanha jogador</span>}
              {npc.lastKnownLocation && <span className="known-npc-location">📍 {npc.lastKnownLocation}</span>}
            </div>
            {expanded && (
              <div className="known-npc-edit">
                <label className="known-npc-edit-label">
                  Relação
                  <select
                    value={npc.relationalStatus === 'desconhecido' ? 'conhecido' : npc.relationalStatus}
                    disabled={saving || !onUpdate}
                    onChange={(e) => void applyUpdate(npc.npcId, { relationalStatus: e.target.value as Exclude<RelationalStatus, 'desconhecido'> })}
                  >
                    {RELATION_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <label className="known-npc-edit-label">
                  Notas
                  <textarea
                    value={notesDraft}
                    maxLength={500}
                    rows={2}
                    placeholder="Anotações sobre este NPC..."
                    disabled={saving || !onUpdate}
                    onChange={(e) => setNotesDraft(e.target.value)}
                    onBlur={() => {
                      if (notesDraft !== (npc.notes ?? '')) void applyUpdate(npc.npcId, { notes: notesDraft })
                    }}
                  />
                </label>
                {npc.relationSource === 'manual' && (
                  <button
                    type="button"
                    className="known-npc-reset-auto"
                    disabled={saving || !onUpdate}
                    onClick={() => void applyUpdate(npc.npcId, { resetToAuto: true })}
                  >
                    ↺ Voltar para automático
                  </button>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Main Page ───

export function GamePage() {
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()

  const [state, setState] = useState<GameState | null>(null)
  const [summary, setSummary] = useState<SummaryDoc | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [currentOptions, setCurrentOptions] = useState<ActionOption[]>([])
  const [input, setInput] = useState('')
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [loading, setLoading] = useState(false)
  const [latestNarratorId, setLatestNarratorId] = useState<string | null>(null)
  const [error, setError] = useState('')

  /* Quick-action state */
  const [selectedSkill, setSelectedSkill] = useState('')
  const [selectedAttribute, setSelectedAttribute] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [showManualComposer, setShowManualComposer] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('status')
  const [resetting, setResetting] = useState(false)
  const [youtubeUrl, setYoutubeUrl] = useState<string | null>(null)
  const [worldInfo, setWorldInfo] = useState<{ campaignName: string; worldName: string } | null>(null)
  const [pendingDiceOption, setPendingDiceOption] = useState<ActionOption | null>(null)
  const [pendingValidation, setPendingValidation] = useState<{ input: string; validation: ValidateActionResponse } | null>(null)
  const [validating, setValidating] = useState(false)
  const [playerImage, setPlayerImage] = useState<{ mimeType: string; base64: string } | null>(null)
  const [playerName, setPlayerName] = useState<string | null>(null)
  const [typewriterSpeed, setTypewriterSpeed] = useState<number>(3)
  const [narrativeStyle, setNarrativeStyle] = useState<NarrativeStyle | undefined>(undefined)
  const [simpleVocabulary, setSimpleVocabulary] = useState<boolean | undefined>(undefined)
  const [savingNarration, setSavingNarration] = useState(false)
  const [knownNpcs, setKnownNpcs] = useState<KnownNpc[]>([])

  const chatEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  const pendingEngineMessagesRef = useRef<Map<string, ChatMessage>>(new Map())
  const streamAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    return () => { streamAbortRef.current?.abort() }
  }, [])

  // Auto-expande a área de escrita conforme o texto, crescendo para cima (sem scroll vertical)
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [input])

  useEffect(() => {
    if (!showManualComposer) {
      setMention(null)
      return
    }

    const el = inputRef.current
    if (!el) return
    requestAnimationFrame(() => {
      el.focus()
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    })
  }, [showManualComposer])

  type MentionNpc = NonNullable<GameState['npcs']>[number]

  function detectMention(value: string, caret: number): { start: number; query: string } | null {
    const upToCaret = value.slice(0, caret)
    const at = upToCaret.lastIndexOf('@')
    if (at === -1) return null
    const prev = at > 0 ? upToCaret[at - 1] : ' '
    if (!/\s/.test(prev)) return null
    const query = upToCaret.slice(at + 1)
    if (/\s/.test(query)) return null
    return { start: at, query }
  }

  const mentionMatches = useMemo<MentionNpc[]>(() => {
    if (!mention) return []
    const list = (state?.npcs ?? []).filter((n) => (!n.location || n.location === state?.worldState.activeLocation) && n.status !== 'left')
    const q = mention.query.trim().toLowerCase()
    const visible = list.filter((n) => {
      const status = n.status ?? 'active'
      return status !== 'dead' && status !== 'left'
    })
    if (!q) return visible
    return visible.filter((n) => (n.displayName ?? n.name).toLowerCase().includes(q))
  }, [mention, state?.npcs])

  useEffect(() => {
    if (mentionIndex > mentionMatches.length - 1) setMentionIndex(0)
  }, [mentionMatches.length, mentionIndex])

  function selectMention(npc: MentionNpc) {
    if (!mention) return
    const el = inputRef.current
    const caret = el?.selectionStart ?? input.length
    const label = npc.displayName ?? npc.name
    const before = input.slice(0, mention.start)
    const after = input.slice(caret)
    const insert = `@${label} `
    const newValue = before + insert + after
    setInput(newValue)
    setMention(null)
    setMentionIndex(0)
    const newCaret = before.length + insert.length
    requestAnimationFrame(() => {
      if (el) {
        el.focus()
        el.setSelectionRange(newCaret, newCaret)
      }
    })
  }

  function getStreamController(): AbortSignal {
    streamAbortRef.current?.abort()
    const controller = new AbortController()
    streamAbortRef.current = controller
    return controller.signal
  }

  const sessionSummaryText = trimIncompleteSummaryText(summary?.summaryText)
  const displayMessages = useMemo(() => {
    const hasPersistedSummaryMessage = messages.some(
      (m) => m.role === 'system' && Boolean(m.narrative?.trim()) && !(m.engineEvents?.length)
    )
    return sessionSummaryText && !hasPersistedSummaryMessage
      ? [{
          messageId: `session-summary-${sessionId || state?.meta.sessionId || 'session'}`,
          sessionId: sessionId || state?.meta.sessionId || '',
          turn: -1,
          seq: -1,
          role: 'system' as const,
          narrative: sessionSummaryText
        }, ...messages]
      : messages
  }, [messages, sessionSummaryText, sessionId, state?.meta.sessionId])

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [displayMessages])

  function commitMessages(nextMessages: ChatMessage[]) {
    const sorted = sortMessages(nextMessages)

    if (pendingEngineMessagesRef.current.size > 0) {
      const nextPending = new Map(pendingEngineMessagesRef.current)

      for (const message of sorted) {
        if (isLocalOnlyMessage(message)) continue

        const signature = getEngineMessageSignature(message)
        if (!signature) continue

        nextPending.delete(signature)
      }

      pendingEngineMessagesRef.current = nextPending
    }

    messagesRef.current = sorted
    setMessages(sorted)
    return sorted
  }

  function reconcilePendingEngineMessages(...groups: ChatMessage[][]) {
    const nextPending = new Map(pendingEngineMessagesRef.current)

    for (const group of groups) {
      for (const message of group) {
        if (!message) continue

        const signature = getEngineMessageSignature(message)
        if (!signature) continue

        if (isLocalOnlyMessage(message)) {
          const existing = nextPending.get(signature)
          nextPending.set(signature, existing ? choosePreferredMessage(existing, message) : message)
          continue
        }

        nextPending.delete(signature)
      }
    }

    pendingEngineMessagesRef.current = nextPending
    return [...nextPending.values()]
  }

  function mergeAndCommitMessages(...groups: ChatMessage[][]) {
    return commitMessages(mergeChatMessages(...groups))
  }

  // Load session on mount
  useEffect(() => {
    if (!sessionId) return

    getSessionView(sessionId)
      .then((payload) => {
        setState(payload.state)
        setSummary(payload.summary ?? null)
        setKnownNpcs(payload.knownNpcs ?? [])
        setNarrativeStyle(payload.state?.meta?.narrativeStyle)
        setSimpleVocabulary(payload.state?.meta?.simpleVocabulary)
        pendingEngineMessagesRef.current.clear()
        // Fetch character image for avatar
        const characterId = payload.state?.player?.characterId
        if (characterId) {
          getCharacter(characterId)
            .then((char) => {
              setPlayerImage(char.image ?? null)
              setPlayerName(char.name ?? null)
            })
            .catch(() => { /* avatar é opcional */ })
        }
        const hydratedMessages = commitMessages(payload.messages ?? [])
        // Extract options from last narrator message
        const lastNarrator = [...hydratedMessages].reverse().find(
          (m) => m.role === 'narrator' && m.options?.length
        )
        if (lastNarrator?.options) {
          setCurrentOptions(normalizeOptions(lastNarrator.options))
        }
        // Fetch campaign to get youtubeUrl and header info
        const campaignId = payload.state?.meta?.campaignId
        if (campaignId) {
          getCampaign(campaignId)
            .then((campaign) => {
              setYoutubeUrl(campaign.youtubeUrl ?? null)
              // Fetch world for universe name
              if (campaign.worldId) {
                getWorld(campaign.worldId)
                  .then((world) => {
                    setWorldInfo({ campaignName: campaign.name ?? '', worldName: world.name })
                  })
                  .catch(() => {
                    setWorldInfo({ campaignName: campaign.name ?? '', worldName: '' })
                  })
              } else {
                setWorldInfo({ campaignName: campaign.name ?? '', worldName: '' })
              }
            })
            .catch(() => { /* ignore */ })
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Falha ao carregar sessão'))
  }, [sessionId])

  function handlePayload(result: {
    state: GameState
    summary?: SummaryDoc | null
    messages?: ChatMessage[]
    narratorResponse?: NarratorTurnResponse
    events?: Array<{ id: string; turn: number; type: string; payload: Record<string, unknown> }>
    knownNpcs?: KnownNpc[]
  }, options?: { replaceMessages?: boolean }) {
    setState(result.state)
    setSummary(result.summary ?? null)
    if (result.knownNpcs) setKnownNpcs(result.knownNpcs)

    let msgs = result.messages ?? []
    const normalizedNarratorOptions = normalizeOptions(result.narratorResponse?.options)

    // Construir mensagem do narrador (fallback se Firestore ainda não propagou)
    let narratorMsg: ChatMessage | null = null
    if (result.narratorResponse?.segments?.length) {
      const nr = result.narratorResponse
      const existingMsg = msgs.find(
        (m) => m.role === 'narrator' && m.turn === result.state.meta.turn
      )
      if (!existingMsg) {
        narratorMsg = {
          messageId: `narrator-${Date.now()}`,
          sessionId: result.state.meta.sessionId,
          turn: result.state.meta.turn,
          role: 'narrator',
          segments: nr.segments,
          options: normalizedNarratorOptions,
          npcs: nr.npcs,
          itemChanges: nr.itemChanges,
          statusChanges: nr.statusChanges
        }
        setLatestNarratorId(narratorMsg.messageId)
      } else {
        // Mensagem já veio do Firestore — ainda precisa disparar a animação
        setLatestNarratorId(existingMsg.messageId)
      }
    }

    // ── Fluxo final: narrativa completa já chegou ──
    if (narratorMsg) {
      msgs = [...msgs, narratorMsg]
    }
    const pendingEngineMessages = options?.replaceMessages
      ? []
      : reconcilePendingEngineMessages(msgs)
    if (options?.replaceMessages) {
      pendingEngineMessagesRef.current.clear()
    }
    console.debug('[GamePage.handlePayload]', {
      turn: result.state.meta.turn,
      replaceMessages: Boolean(options?.replaceMessages),
      incomingMessages: msgs.length,
      pendingEngineMessages: pendingEngineMessages.length,
      hasNarratorResponse: Boolean(result.narratorResponse?.segments?.length)
    })
    const committedMessages = options?.replaceMessages
      ? commitMessages(msgs)
      : mergeAndCommitMessages(messagesRef.current, msgs, pendingEngineMessages)

    if (result.narratorResponse) {
      setCurrentOptions(normalizedNarratorOptions)
      if (result.narratorResponse.isFallback) {
        setError('A IA não respondeu com contexto nesta rodada — tente outra ação.')
      }
    } else {
      const lastNarrator = [...committedMessages].reverse().find(
        (m) => m.role === 'narrator' && m.options?.length
      )
      setCurrentOptions(normalizeOptions(lastNarrator?.options))
    }
    setLoading(false)
  }

  /**
   * Callback chamado pela fase "engine" do streaming NDJSON.
   * Mostra os resultados de dados imediatamente, ANTES do LLM terminar.
   */
  function handleEnginePhase(data: EnginePhaseData) {
    // Atualiza o state intermediário (com dados aplicados)
    if (data.state) {
      setState(data.state)
    }

    const transientEngineMessage = buildTransientEngineMessage(data, sessionId)
    const incomingMessages = data.messages ?? []
    const pendingEngineMessages = reconcilePendingEngineMessages(
      incomingMessages,
      transientEngineMessage ? [transientEngineMessage] : []
    )

    console.debug('[GamePage.handleEnginePhase]', {
      turn: data.state?.meta.turn,
      incomingMessages: incomingMessages.length,
      diceEvents: data.diceEvents?.length ?? 0,
      hasTransientEngineMessage: Boolean(transientEngineMessage),
      pendingEngineMessages: pendingEngineMessages.length
    })

    if (incomingMessages.length || pendingEngineMessages.length) {
      mergeAndCommitMessages(
        messagesRef.current,
        incomingMessages,
        pendingEngineMessages
      )
    }
  }

  /** Insere uma mensagem otimista do jogador no chat local (antes da resposta do backend) */
  function pushOptimisticPlayerMessage(text: string) {
    const optimistic: ChatMessage = {
      messageId: `optimistic-${Date.now()}`,
      sessionId,
      turn: (state?.meta.turn ?? 0) + 1,
      role: 'player',
      playerInput: text
    }
    mergeAndCommitMessages(messagesRef.current, [optimistic])
  }

  async function handleChooseOption(optionId: string) {
    if (!sessionId) return
    const chosen = currentOptions.find((o) => o.id === optionId)

    // Limpar o campo de texto manual
    setInput('')

    // Se a opção tem dice check required, abrir modal de confirmação (exceto para ataques que rolam direto)
    if (chosen?.diceCheck?.required && chosen.actionType !== 'attack') {
      setPendingDiceOption(chosen)
      return
    }

    await executeChooseOption(optionId, chosen?.text)
  }

  async function handleConfirmDiceRoll(optionId: string) {
    const chosen = pendingDiceOption
    setPendingDiceOption(null)
    await executeChooseOption(optionId, chosen?.text)
  }

  function handleCancelDiceRoll() {
    setPendingDiceOption(null)
  }

  async function executeChooseOption(optionId: string, displayText?: string) {
    setError('')
    setLoading(true)
    setCurrentOptions([])
    if (displayText) pushOptimisticPlayerMessage(displayText)
    const signal = getStreamController()
    try {
      const result = await chooseOption(sessionId, optionId, handleEnginePhase, signal)
      handlePayload(result)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Falha ao executar opção')
      setLoading(false)
    }
  }

  async function handleCustomSubmit(e?: FormEvent) {
    e?.preventDefault()
    const text = formatPlayerInput(input)
    if (!sessionId || !text) return
    setError('')
    setPendingValidation(null)

    // Fala direta: input começando com "-" é interpretado como diálogo do personagem
    if (text.startsWith('- ') || text === '-') {
      await executeValidatedAction(text)
      return
    }

    setValidating(true)
    try {
      const validation = await validateCustomAction(sessionId, text)
      if (!validation.feasible) {
        setError(validation.feasibilityReason || 'Ação não é possível no contexto atual.')
        setValidating(false)
        return
      }
      if (validation.diceCheck?.required) {
        setPendingValidation({ input: text, validation: normalizeValidationResponse(validation) })
        setValidating(false)
        return
      }
      // Ação viável sem teste de dados — executar diretamente, mas passar validation para roteamento por actionType
      setValidating(false)
      await executeValidatedAction(text, validation)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao validar ação')
      setValidating(false)
    }
  }

  async function executeValidatedAction(text: string, validation?: ValidateActionResponse) {
    setLoading(true)
    setCurrentOptions([])
    setInput('')
    setPendingValidation(null)
    pushOptimisticPlayerMessage(text)
    const signal = getStreamController()
    try {
      let result
      const dc = validation?.diceCheck
      if (dc?.required) {
        // Rolar o d100 de chance check no frontend e enviar para o backend
        const successChance = typeof dc.successChance === 'number' ? dc.successChance : 50
        const roll = Math.random() * 100
        const success = roll < successChance

        result = await executeChanceCheck(
          {
            sessionId,
            success,
            chance: successChance,
            roll,
            reason: dc.reason ?? '',
            description: text,
            displayText: text
          },
          handleEnginePhase,
          signal
        )
      } else {
        result = await executeCustomAction(sessionId, text, handleEnginePhase, signal)
      }
      handlePayload(result)
      setShowManualComposer(false)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Falha ao enviar ação')
      setLoading(false)
    }
  }

  function handleConfirmValidatedAction() {
    if (!pendingValidation) return
    const text = pendingValidation.input
    const validation = pendingValidation.validation
    setPendingValidation(null)
    executeValidatedAction(text, validation)
  }

  function handleCancelValidation() {
    setPendingValidation(null)
  }

  async function handleTraitTest() {
    if (!sessionId) return
    const skill = selectedSkill || undefined
    const attribute = selectedAttribute || undefined
    if (!skill && !attribute) {
      setError('Selecione uma perícia ou atributo')
      return
    }
    setError('')
    setLoading(true)
    setCurrentOptions([])
    pushOptimisticPlayerMessage(`Teste de ${ATTR_LABEL_MAP[skill ?? ''] ?? skill ?? ATTR_LABEL_MAP[attribute ?? ''] ?? attribute}`)
    const signal = getStreamController()
    try {
      const result = await executeTraitTest({ sessionId, skill, attribute }, handleEnginePhase, signal)
      handlePayload(result)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Falha')
      setLoading(false)
    }
  }

  async function handleSoak() {
    if (!sessionId) return
    setError('')
    setLoading(true)
    pushOptimisticPlayerMessage('Rolagem de absorção')
    const signal = getStreamController()
    try {
      const result = await executeSoakRoll(sessionId, handleEnginePhase, signal)
      handlePayload(result)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Falha')
      setLoading(false)
    }
  }

  async function handleSpendBenny(purpose: 'reroll' | 'soak' | 'unshake') {
    if (!sessionId) return
    setError('')
    setLoading(true)
    pushOptimisticPlayerMessage(`Usar Benny: ${purpose}`)
    const signal = getStreamController()
    try {
      const result = await executeSpendBenny(sessionId, purpose, handleEnginePhase, signal)
      handlePayload(result)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Falha')
      setLoading(false)
    }
  }

  async function handleRecoverShaken() {
    if (!sessionId) return
    setError('')
    setLoading(true)
    pushOptimisticPlayerMessage('Recuperar de abalado')
    const signal = getStreamController()
    try {
      const result = await executeRecoverShaken(sessionId, handleEnginePhase, signal)
      handlePayload(result)
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') return
      setError(err instanceof Error ? err.message : 'Falha')
      setLoading(false)
    }
  }

  async function handleReset() {
    if (!sessionId) return
    setResetting(true)
    setError('')
    try {
      const result = await resetSession(sessionId)
      pendingEngineMessagesRef.current.clear()
      handlePayload(result, { replaceMessages: true })
      setSidebarOpen(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao reiniciar')
    } finally {
      setResetting(false)
    }
  }

  async function handleEquipAttack(itemId: string) {
    if (!sessionId) return
    try {
      const result = await equipAttackItem(sessionId, itemId)
      setState(result.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao equipar ataque')
    }
  }

  async function handleUnequipAttack() {
    if (!sessionId) return
    try {
      const result = await unequipAttackItem(sessionId)
      setState(result.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao desequipar ataque')
    }
  }

  async function handleEquipArmor(itemId: string) {
    if (!sessionId) return
    try {
      const result = await equipArmorItem(sessionId, itemId)
      setState(result.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao equipar armadura')
    }
  }

  async function handleUnequipArmor() {
    if (!sessionId) return
    try {
      const result = await unequipArmorItem(sessionId)
      setState(result.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao desequipar armadura')
    }
  }

  async function handleEquipShield(itemId: string) {
    if (!sessionId) return
    try {
      const result = await equipShieldItem(sessionId, itemId)
      setState(result.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao equipar escudo')
    }
  }

  async function handleUnequipShield() {
    if (!sessionId) return
    try {
      const result = await unequipShieldItem(sessionId)
      setState(result.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao desequipar escudo')
    }
  }

  async function handleRemoveItem(itemId: string) {
    if (!sessionId) return
    try {
      const result = await removeInventoryItem(sessionId, itemId)
      setState(result.state)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao remover item')
    }
  }

  async function handleUpdateKnownNpc(
    npcId: string,
    patch: { relationalStatus?: Exclude<RelationalStatus, 'desconhecido'>; notes?: string; resetToAuto?: boolean }
  ) {
    const characterId = state?.player.characterId
    if (!characterId) return
    try {
      const updated = await updateKnownNpc(characterId, npcId, patch)
      setKnownNpcs((prev) => prev.map((npc) => (npc.npcId === npcId ? updated : npc)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao atualizar NPC conhecido')
    }
  }

  async function handleNarrativeStyleChange(style: NarrativeStyle) {
    if (!sessionId || savingNarration) return
    setNarrativeStyle(style)
    setSavingNarration(true)
    try {
      await updateSessionSettings(sessionId, { narrativeStyle: style })
    } catch {
      // revert on failure
      setNarrativeStyle(narrativeStyle)
    } finally {
      setSavingNarration(false)
    }
  }

  async function handleSimpleVocabularyChange(simple: boolean) {
    if (!sessionId || savingNarration) return
    setSimpleVocabulary(simple)
    setSavingNarration(true)
    try {
      await updateSessionSettings(sessionId, { simpleVocabulary: simple })
    } catch {
      setSimpleVocabulary(simpleVocabulary)
    } finally {
      setSavingNarration(false)
    }
  }

  const bennies = state?.player.bennies ?? 0
  const isShaken = state?.player.isShaken ?? false
  const inventory = state?.player.inventory ?? []
  const weaponItems = inventory.filter((item) => item.category === 'weapon' && item.quantity > 0)
  const equippedAttackItemId = state?.player.equippedAttackItemId
  const equippedWeaponName = weaponItems.find((item) => item.id === equippedAttackItemId)?.name
  const statusEffects = state?.player.statusEffects ?? []
  const npcEffects = (state?.npcs ?? []).filter((n) => (!n.location || n.location === state?.worldState.activeLocation) && n.status !== 'left')

  function openInventorySidebar() {
    setSidebarTab('inventory')
    setSidebarOpen(true)
  }

  function toggleManualComposer() {
    setShowManualComposer((prev) => !prev)
  }

  return (
    <section className="page-game">
      {/* ── YouTube Ambient ── */}
      {youtubeUrl && <YouTubeAmbient youtubeUrl={youtubeUrl} />}

      {/* ── HUD: status + ações numa única barra ── */}
      <div className="game-hud">
        <button
          type="button"
          className="game-back-btn"
          onClick={() => navigate(-1)}
          title="Voltar"
        >
          ← Voltar
        </button>

        {state && (
          <>
            <div className="subheader-status">
              <span title="Ferimentos"><span className="hud-icon">❤️</span><span className="hud-label">Vida</span> {state.player.wounds}/{state.player.maxWounds}</span>
              {bennies > 0 ? (
                <button
                  type="button"
                  className="hud-benny-btn"
                  onClick={() => handleSpendBenny('reroll')}
                  disabled={loading}
                  title="Gastar Benny para re-rolar"
                >
                  <span className="hud-icon">🎲</span><span className="hud-label">Bennies</span> {state.player.bennies}
                </button>
              ) : (
                <span title="Bennies disponíveis"><span className="hud-icon">🎲</span><span className="hud-label">Bennies</span> {state.player.bennies}</span>
              )}
              <span title="Aparar (defesa corpo a corpo)"><span className="hud-icon">🛡️</span><span className="hud-label">Aparar</span> {state.player.parry}</span>
              <span title="Resistência (absorção de dano)"><span className="hud-icon">💪</span><span className="hud-label">Resist.</span> {state.player.toughness}</span>
              {state.player.isShaken && <span className="shaken-badge">ABALADO</span>}
              <span className="location-tag" title="Localização atual"><span className="hud-icon">📍</span>{state.worldState.activeLocation}</span>
            </div>

            <div className="subheader-actions hud-actions-row">
              <button
                type="button"
                className="subheader-btn pill-ficha"
                onClick={() => {
                  if (sidebarOpen) {
                    setSidebarOpen(false)
                    return
                  }
                  setSidebarTab('status')
                  setSidebarOpen(true)
                }}
                title="Ficha do Personagem"
              >
                📋 {state.player.name ?? 'Ficha'}
              </button>
              <button
                type="button"
                className="subheader-btn pill-actions"
                onClick={() => setShowAdvanced(!showAdvanced)}
                title="Ações avançadas"
              >
                ⚔️ Ações
              </button>
              <select
                className="subheader-btn pill-speed"
                value={typewriterSpeed}
                onChange={(e) => setTypewriterSpeed(Number(e.target.value))}
                title="Velocidade do narrador"
              >
                <option value={0}>⚡ Instantâneo</option>
                <option value={1}>🐢 Lento</option>
                <option value={3}>💬 Normal</option>
                <option value={6}>🚀 Rápido</option>
              </select>
            </div>
          </>
        )}
      </div>

      {/* ── Sidebar do Personagem (fixa à direita) ── */}
      <CharacterSidebar
        state={state}
        open={sidebarOpen}
        activeTab={sidebarTab}
        onTabChange={setSidebarTab}
        onClose={() => setSidebarOpen(false)}
        onReset={handleReset}
        resetting={resetting}
        onRemoveItem={handleRemoveItem}
        onEquipAttack={handleEquipAttack}
        onUnequipAttack={handleUnequipAttack}
        onEquipArmor={handleEquipArmor}
        onUnequipArmor={handleUnequipArmor}
        onEquipShield={handleEquipShield}
        onUnequipShield={handleUnequipShield}
        narrativeStyle={narrativeStyle}
        simpleVocabulary={simpleVocabulary}
        onNarrativeStyleChange={handleNarrativeStyleChange}
        onSimpleVocabularyChange={handleSimpleVocabularyChange}
        savingNarration={savingNarration}
        knownNpcs={knownNpcs}
        onUpdateKnownNpc={handleUpdateKnownNpc}
      />

      {/* ── Chat Narrativo ── */}
      <div className="chat-panel">
        {(statusEffects.length > 0 || npcEffects.some((npc) => (npc.statusEffects ?? []).length > 0)) && (
          <div className="state-brief">
            <StatusEffectsPanel effects={statusEffects} />
            <NpcStatusEffectsPanel npcs={npcEffects} />
          </div>
        )}
        <div className="chat-log">
          {displayMessages.length === 0 && !loading && (
            <div className="chat-empty">
              <span className="chat-empty-icon">🎲</span>
              <p className="chat-empty-text">A história ainda não começou. Escolha uma ação ou descreva o que seu personagem faz.</p>
            </div>
          )}
          {(() => {
            let cumulativeTokens = 0
            return displayMessages.map((msg, i) => {
              const msgText = msg.role === 'player'
                ? (msg.playerInput ?? '')
                : (msg.segments ?? []).map((s) => s.text ?? '').join(' ')
              cumulativeTokens += Math.ceil(msgText.length / 4)
              const prev = displayMessages[i - 1]
              const showSeparator = prev && msg.turn > 0 && prev.turn > 0 && msg.turn !== prev.turn
              return (
                <div key={msg.messageId ?? `msg-${i}`}>
                  {showSeparator && (
                    <div className="turn-separator">
                      <span className="turn-separator-label">Turno {msg.turn} · Cap. {state?.meta.chapter ?? 1}</span>
                    </div>
                  )}
                  <NarrativeBubble message={msg} isNew={msg.messageId === latestNarratorId} charsPerTick={typewriterSpeed} playerName={playerName ?? state?.player.name} playerImage={playerImage} npcs={state?.npcs ?? []} knownNpcs={knownNpcs} cumulativeTokens={msg.role === 'narrator' ? cumulativeTokens : undefined} />
                </div>
              )
            })
          })()}
          {loading && (
            <div className="msg narrator loading">
              <strong>📖 Narrador</strong>
              <div className="typing-dots">
                <span /><span /><span />
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* ── Opções de Ação (4 botões) ── */}
        {!loading && (
          <ActionOptions
            options={currentOptions}
            onChoose={handleChooseOption}
            disabled={loading}
          />
        )}

        <div className="manual-quick-actions" role="group" aria-label="Ações manuais e inventário">
          <button
            type="button"
            className={`subheader-btn pill-actions manual-toggle-btn${showManualComposer ? ' active' : ''}`}
            aria-expanded={showManualComposer}
            onClick={toggleManualComposer}
            disabled={loading || validating || !sessionId}
            title="Abrir ação manual"
          >
            {showManualComposer ? '✍️ Fechar ação manual' : '✍️ Ação manual'}
          </button>
          <button
            type="button"
            className="subheader-btn pill-ficha manual-items-btn"
            onClick={openInventorySidebar}
            disabled={!sessionId}
            title="Abrir mochila"
          >
            🎒 Ver meus itens
          </button>
          <div className="weapon-quick-actions" aria-label="Troca rápida de arma">
            {weaponItems.length > 0 ? (
              weaponItems.map((item) => {
                const isEquipped = item.id === equippedAttackItemId
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`weapon-quick-btn${isEquipped ? ' equipped' : ''}`}
                    onClick={() => handleEquipAttack(item.id)}
                    disabled={loading || !sessionId || isEquipped}
                    title={isEquipped ? `${item.name} equipada` : `Equipar ${item.name}`}
                  >
                    ⚔️ {item.name}
                  </button>
                )
              })
            ) : (
              <span className="weapon-quick-empty">Sem armas no inventário</span>
            )}
          </div>
          {equippedWeaponName && (
            <span className="weapon-equipped-label" title="Arma equipada no momento">
              Equipada: {equippedWeaponName}
            </span>
          )}
        </div>
      </div>

      {/* ── Dice Check Confirm Modal ── */}
      {pendingDiceOption && (
        <DiceCheckConfirmModal
          option={pendingDiceOption}
          onConfirm={handleConfirmDiceRoll}
          onCancel={handleCancelDiceRoll}
        />
      )}

      {/* ── Ações Avançadas (colapsável, inline sem card) ── */}
      {showAdvanced && (
        <div className="advanced-actions">
          <div className="action-row">
            <select
              value={selectedSkill}
              onChange={(e) => {
                setSelectedSkill(e.target.value)
                setSelectedAttribute('')
                setInput('')
              }}
            >
              <option value="">-- Perícia --</option>
              {SKILLS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <select
              value={selectedAttribute}
              onChange={(e) => {
                setSelectedAttribute(e.target.value)
                setSelectedSkill('')
                setInput('')
              }}
            >
              <option value="">-- Atributo --</option>
              {ATTRIBUTES.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </select>
            <button
              disabled={loading || (!selectedSkill && !selectedAttribute)}
              onClick={handleTraitTest}
              type="button"
            >
              Rolar Teste
            </button>
          </div>
          <div className="action-row">
            <button disabled={loading || bennies <= 0} onClick={() => handleSpendBenny('reroll')} type="button">
              Benny: Re-rolar ({bennies})
            </button>
            <button disabled={loading || bennies <= 0} onClick={() => handleSpendBenny('soak')} type="button">
              Benny: Absorver
            </button>
            <button
              disabled={loading || bennies <= 0 || !isShaken}
              onClick={() => handleSpendBenny('unshake')}
              type="button"
            >
              Benny: Recuperar Abalado
            </button>
            <button disabled={loading} onClick={handleSoak} type="button">
              Rolagem de Absorção
            </button>
            {isShaken && (
              <button disabled={loading} onClick={handleRecoverShaken} type="button">
                Recuperar (Espírito)
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Validação de ação pendente (dice check) ── */}
      {pendingValidation && (
        <div className="dice-confirm-overlay" onClick={handleCancelValidation}>
          <div className="dice-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="dice-confirm-title">🎲 Resolução por Chance</h3>
            <p className="dice-confirm-action">{pendingValidation.validation.interpretation}</p>

            {pendingValidation.validation.diceCheck && (
              <div className="dice-confirm-details">
                {typeof pendingValidation.validation.diceCheck.successChance === 'number' && (
                  <div className="dice-detail-row">
                    <span className="dice-detail-label">Chance de Sucesso</span>
                    <span className="dice-detail-value dice-die-value">
                      {pendingValidation.validation.diceCheck.successChance}%
                    </span>
                  </div>
                )}
                {pendingValidation.validation.diceCheck.reason && (
                  <p className="dice-confirm-reason">{pendingValidation.validation.diceCheck.reason}</p>
                )}
              </div>
            )}

            <div className="dice-confirm-buttons">
              <button className="btn-dice-cancel" onClick={handleCancelValidation} type="button">
                ← Voltar
              </button>
              <button className="btn-dice-confirm" onClick={handleConfirmValidatedAction} type="button">
                🎲 Confirmar e Executar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Chat livre ── */}
      {showManualComposer && (
        <form className="form-grid" onSubmit={handleCustomSubmit}>
          <div className="input-row">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => {
                const value = e.target.value
                setInput(value)
                const caret = e.target.selectionStart ?? value.length
                setMention(detectMention(value, caret))
              }}
              onKeyDown={(e) => {
                if (mention && mentionMatches.length > 0) {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault()
                    setMentionIndex((i) => (i + 1) % mentionMatches.length)
                    return
                  }
                  if (e.key === 'ArrowUp') {
                    e.preventDefault()
                    setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    selectMention(mentionMatches[mentionIndex])
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setMention(null)
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  handleCustomSubmit()
                }
              }}
              onBlur={() => setTimeout(() => setMention(null), 120)}
              placeholder="Descreva sua ação... (@ menciona NPCs, Enter envia, Shift+Enter nova linha)"
              rows={1}
            />
            {mention && mentionMatches.length > 0 && (
              <ul className="npc-mention-dropdown" role="listbox">
                {mentionMatches.map((npc, i) => (
                  <li
                    key={npc.id}
                    role="option"
                    aria-selected={i === mentionIndex}
                    className={`npc-mention-item ${npc.disposition ?? 'neutral'} ${i === mentionIndex ? 'active' : ''}`}
                    onMouseDown={(ev) => {
                      ev.preventDefault()
                      selectMention(npc)
                    }}
                    onMouseEnter={() => setMentionIndex(i)}
                  >
                    <span className="npc-mention-dot" />
                    <span className="npc-mention-name">{npc.displayName ?? npc.name}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="input-actions">
              <button disabled={loading || validating || !sessionId || !input.trim()} type="submit">
                {validating ? 'Validando...' : loading ? '...' : 'Enviar'}
              </button>
            </div>
          </div>
        </form>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
