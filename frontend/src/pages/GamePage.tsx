import { FormEvent, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'

import {
  executeCustomAction,
  validateCustomAction,
  executeTraitTest,
  executeAttack,
  executeSoakRoll,
  executeSpendBenny,
  executeRecoverShaken,
  getSessionView,
  chooseOption,
  resetSession,
  removeInventoryItem,
  updateSessionSettings,
  getWorld,
  getCampaign,
  getCharacter
} from '../lib/api'
import type { EnginePhaseData } from '../lib/api'
import type { ActionOption, ChatMessage, DiceCheck, DiceRollDetail, GameState, InventoryItem, Hindrance, NarratorTurnResponse, NarrativeStyle, SessionEvent, SummaryDoc, TraitTestPayload, ValidateActionResponse } from '../types'
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

function splitNarrativeParagraphs(narrative?: string): string[] {
  if (!narrative) return []

  return normalizeEscapedText(narrative)
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
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

function resolveDiceCheckTrait(
  diceCheck: DiceCheck | null | undefined,
  actionPayload: Record<string, unknown>
): { skill: string | null; attribute: string | null; label: string } {
  const payloadSkill = typeof actionPayload.skill === 'string' ? normalizeInlineText(actionPayload.skill) : null
  const payloadAttribute = typeof actionPayload.attribute === 'string' ? normalizeInlineText(actionPayload.attribute) : null
  const skill = diceCheck?.skill ? normalizeInlineText(diceCheck.skill) : payloadSkill
  const attribute = diceCheck?.attribute ? normalizeInlineText(diceCheck.attribute) : payloadAttribute

  return {
    skill,
    attribute,
    label: skill ?? attribute ?? '?'
  }
}

function areEquivalentSkills(left: string, right: string): boolean {
  return normalizeLookupKey(left) === normalizeLookupKey(right)
}

function resolvePlayerTraitDie(
  playerState: GameState['player'] | null,
  trait: { skill: string | null; attribute: string | null }
): number | null {
  if (!playerState) return null

  if (trait.skill) {
    const traitSkill = trait.skill
    const direct = playerState.skills[traitSkill]
    if (direct != null) return direct

    const matchedSkill = Object.entries(playerState.skills).find(([storedSkill]) => areEquivalentSkills(storedSkill, traitSkill))
    if (matchedSkill) return matchedSkill[1]
  }

  if (trait.attribute) {
    const direct = playerState.attributes[trait.attribute]
    if (direct != null) return direct

    const normalizedAttribute = normalizeLookupKey(trait.attribute)
    const matchedAttribute = ATTRIBUTES.find((attribute) => {
      return normalizeLookupKey(attribute.key) === normalizedAttribute || normalizeLookupKey(attribute.label) === normalizedAttribute
    })

    if (matchedAttribute && playerState.attributes[matchedAttribute.key] != null) {
      return playerState.attributes[matchedAttribute.key]
    }
  }

  return null
}

function normalizeValidationResponse(validation: ValidateActionResponse): ValidateActionResponse {
  const actionPayload = normalizeActionPayload(validation.actionPayload ?? {})
  const resolvedTrait = resolveDiceCheckTrait(validation.diceCheck, actionPayload)

  return {
    ...validation,
    interpretation: normalizeInlineText(validation.interpretation),
    feasibilityReason: validation.feasibilityReason ? normalizeInlineText(validation.feasibilityReason) : validation.feasibilityReason,
    actionPayload,
    diceCheck: validation.diceCheck
      ? {
          ...validation.diceCheck,
          skill: resolvedTrait.skill,
          attribute: resolvedTrait.attribute,
          reason: normalizeInlineText(validation.diceCheck.reason ?? '')
        }
      : validation.diceCheck
  }
}

function normalizeOption(option: ActionOption): ActionOption {
  const actionPayload = normalizeActionPayload(option.actionPayload ?? {})
  const resolvedTrait = resolveDiceCheckTrait(option.diceCheck, actionPayload)

  return {
    ...option,
    text: normalizeInlineText(option.text),
    actionPayload,
    feasibilityReason: option.feasibilityReason ? normalizeInlineText(option.feasibilityReason) : option.feasibilityReason,
    diceCheck: option.diceCheck
      ? {
          ...option.diceCheck,
          skill: resolvedTrait.skill,
          attribute: resolvedTrait.attribute,
          reason: normalizeInlineText(option.diceCheck.reason ?? '')
        }
      : option.diceCheck
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

function NarrativeBubble({ message, isNew, charsPerTick = 3, playerName, playerImage }: {
  message: ChatMessage
  isNew?: boolean
  charsPerTick?: number
  playerName?: string
  playerImage?: { mimeType: string; base64: string } | null
}) {
  const fullText = message.narrative ?? ''
  const [displayedText, setDisplayedText] = useState(isNew && charsPerTick > 0 ? '' : fullText)

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
    return (
      <div className="msg player">
        <div className="player-content">
          <div className="player-text">
            <strong>{playerName ?? 'Você'}</strong>
            <p>{message.playerInput}</p>
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
      <strong>📖 Narrador</strong>
      <div className="narrative-text">
        {splitNarrativeParagraphs(displayedText).map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>

      {/* NPCs mencionados */}
      {message.npcs && message.npcs.length > 0 && (
        <div className="npcs-mentioned">
          {message.npcs.map((npc) => (
            <span
              key={npc.id}
              className={`npc-tag ${npc.disposition}`}
              title={`${npc.disposition}${npc.newlyIntroduced ? ' (novo)' : ''}`}
            >
              {npc.name}
            </span>
          ))}
        </div>
      )}

      {/* Itens ganhos/perdidos */}
      {message.itemChanges && message.itemChanges.length > 0 && (
        <div className="item-changes">
          {message.itemChanges.map((change) => (
            <span
              key={change.itemId}
              className={`item-change ${change.changeType}`}
            >
              {change.changeType === 'gained' ? '+' : '-'} {change.name} (x{change.quantity})
            </span>
          ))}
        </div>
      )}

      {/* Status changes */}
      {message.statusChanges && message.statusChanges.length > 0 && (
        <div className="status-changes">
          {message.statusChanges.map((change) => (
            <span
              key={change.effectId}
              className={`status-change ${change.changeType}`}
            >
              {change.changeType === 'applied' ? '▲' : '▼'} {change.name}
              {change.turnsRemaining !== undefined ? ` (${change.turnsRemaining}t)` : ''}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

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
          const trait = resolveDiceCheckTrait(dc, option.actionPayload)
          return (
            <button
              key={option.id}
              style={{ animationDelay: `${idx * 55}ms` }}
              className={`option-btn ${!option.feasible ? 'infeasible' : ''} ${hasDice ? 'has-dice-check' : ''}`}
              onClick={() => onChoose(option.id)}
              disabled={disabled || !option.feasible}
              title={hasDice && dc?.reason ? dc.reason : option.feasible ? option.text : option.feasibilityReason ?? 'Não disponível'}
            >
              <span className="option-text">
                {hasDice && <span className="dice-check-badge">🎲</span>}
                {option.text}
              </span>
              {hasDice && dc && (
                <span className="dice-check-info">
                  Teste: {trait.label}
                  {dc.modifier ? ` (${dc.modifier > 0 ? '+' : ''}${dc.modifier})` : ''}
                  {' · TN '}{dc.tn ?? 4}
                </span>
              )}
              {!option.feasible && option.feasibilityReason && (
                <span className="option-reason">{option.feasibilityReason}</span>
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

function StatusEffectsPanel({ effects }: { effects: Array<{ id: string; name: string; turnsRemaining?: number }> }) {
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

// ─── Dice Check Confirm Modal ───

function DiceCheckConfirmModal({
  option,
  playerState,
  onConfirm,
  onCancel
}: {
  option: ActionOption
  playerState: GameState['player'] | null
  onConfirm: (optionId: string) => void
  onCancel: () => void
}) {
  const dc = option.diceCheck
  if (!dc) return null

  const trait = resolveDiceCheckTrait(dc, option.actionPayload)
  const traitName = trait.label
  const playerDie = resolvePlayerTraitDie(playerState, trait)

  const tn = dc.tn ?? 4
  const mod = dc.modifier ?? 0

  return (
    <div className="dice-confirm-overlay" onClick={onCancel}>
      <div className="dice-confirm-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="dice-confirm-title">🎲 Teste Necessário</h3>
        <p className="dice-confirm-action">{option.text}</p>

        <div className="dice-confirm-details">
          <div className="dice-detail-row">
            <span className="dice-detail-label">Trait (Traço)</span>
            <span className="dice-detail-value">{traitName}</span>
          </div>
          {playerDie != null && (
            <div className="dice-detail-row">
              <span className="dice-detail-label">Seu dado</span>
              <span className="dice-detail-value dice-die-value">{dieLabel(playerDie)} + Wild Die (Dado Selvagem)</span>
            </div>
          )}
          <div className="dice-detail-row">
            <span className="dice-detail-label">Modificador</span>
            <span className={`dice-detail-value ${mod < 0 ? 'mod-negative' : mod > 0 ? 'mod-positive' : ''}`}>
              {mod === 0 ? '0' : `${mod > 0 ? '+' : ''}${mod}`}
            </span>
          </div>
          <div className="dice-detail-row">
            <span className="dice-detail-label">TN (alvo)</span>
            <span className="dice-detail-value">{tn}</span>
          </div>
        </div>

        {dc.reason && (
          <p className="dice-confirm-reason">{dc.reason}</p>
        )}

        <div className="dice-confirm-buttons">
          <button className="btn-dice-cancel" onClick={onCancel} type="button">
            ← Voltar
          </button>
          <button className="btn-dice-confirm" onClick={() => onConfirm(option.id)} type="button">
            🎲 Rolar Teste
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
  targetToughness: number
  woundsInflicted: number
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
          </div>
          <div className="dice-result-summary">
            <span className="dice-final">Dano: <strong>{p.damageTotal}</strong></span>
            <span className="dice-tn">Resistência: {p.targetToughness}</span>
            {p.targetIncapacitated ? (
              <span className="attack-result-status incapacitated">💀 Incapacitado</span>
            ) : p.woundsInflicted > 0 ? (
              <span className="attack-result-status wounded">🩸 {p.woundsInflicted} ferimento{p.woundsInflicted > 1 ? 's' : ''}</span>
            ) : p.targetShaken ? (
              <span className="attack-result-status shaken">🟡 Abalado</span>
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
          <span className="attack-result-status shaken">✅ Abalado removido</span>
        )}
        <span className="dice-mod">Bennies: {p.remainingBennies}</span>
        {!p.isSuccess && (
          <span className="attack-result-status wounded">🩸 Ferimentos restantes: {p.remainingWounds}</span>
        )}
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

function DiceResultCard({ event }: { event: SessionEvent }) {
  if (event.type === 'attack_hit' || event.type === 'attack_miss') {
    return <AttackResultCard event={event} />
  }
  if (event.type === 'soak_roll') {
    return <SoakRollCard event={event} />
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

type SidebarTab = 'status' | 'attributes' | 'skills' | 'inventory' | 'edges' | 'effects' | 'narration'

const SIDEBAR_TABS: { key: SidebarTab; label: string; icon: string }[] = [
  { key: 'status', label: 'Status', icon: '❤️' },
  { key: 'attributes', label: 'Atributos', icon: '🎯' },
  { key: 'skills', label: 'Perícias', icon: '📖' },
  { key: 'inventory', label: 'Mochila', icon: '🎒' },
  { key: 'edges', label: 'Vantagens', icon: '⭐' },
  { key: 'effects', label: 'Efeitos', icon: '✨' },
  { key: 'narration', label: 'Narração', icon: '🎭' },
]

function CharacterSidebar({
  state,
  open,
  onClose,
  onReset,
  resetting,
  onRemoveItem,
  narrativeStyle,
  simpleVocabulary,
  onNarrativeStyleChange,
  onSimpleVocabularyChange,
  savingNarration,
}: {
  state: GameState | null
  open: boolean
  onClose: () => void
  onReset: () => void
  resetting: boolean
  onRemoveItem?: (itemId: string) => void
  narrativeStyle?: NarrativeStyle
  simpleVocabulary?: boolean
  onNarrativeStyleChange: (style: NarrativeStyle) => void
  onSimpleVocabularyChange: (simple: boolean) => void
  savingNarration: boolean
}) {
  const [tab, setTab] = useState<SidebarTab>('status')
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
              className={`sidebar-tab${tab === t.key ? ' active' : ''}`}
              onClick={() => setTab(t.key)}
              title={t.label}
            >
              <span className="tab-icon">{t.icon}</span>
              <span className="tab-label">{t.label}</span>
            </button>
          ))}
        </nav>

        {/* Conteúdo da aba */}
        <div className="sidebar-content">
          {tab === 'narration' ? (
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
              {tab === 'status' && <SidebarStatus player={p} location={state?.worldState.activeLocation ?? '?'} turn={state?.meta.turn ?? 0} chapter={state?.meta.chapter ?? 0} />}
              {tab === 'attributes' && <SidebarAttributes player={p} />}
              {tab === 'skills' && <SidebarSkills player={p} />}
              {tab === 'inventory' && <SidebarInventory items={p.inventory} onRemove={onRemoveItem} />}
              {tab === 'edges' && <SidebarEdges edges={p.edges} hindrances={p.hindrances} />}
              {tab === 'effects' && <SidebarEffects effects={p.statusEffects} />}
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
  { key: 'concise', label: 'Conciso', icon: '⚡', desc: '2–4 frases. Direto ao ponto, sem floreios.' },
  { key: 'balanced', label: 'Equilibrado', icon: '⚖️', desc: '4–7 frases. Ação e atmosfera balanceadas.' },
  { key: 'theatrical', label: 'Teatral', icon: '🎭', desc: '6–10 frases. Narração cinematográfica e imersiva.' },
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
  const current = narrativeStyle ?? 'balanced'
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
          checked={simpleVocabulary ?? false}
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

function SidebarInventory({ items, onRemove }: { items: InventoryItem[]; onRemove?: (itemId: string) => void }) {
  const [confirmId, setConfirmId] = useState<string | null>(null)
  if (!items.length) return <p className="muted">Mochila vazia</p>

  return (
    <div className="sidebar-inventory">
      {items.map((item) => (
        <div key={item.id} className="sidebar-inv-item">
          <div className="inv-item-header">
            <span className="inv-item-name">{item.name}</span>
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
          {item.tags && item.tags.length > 0 && (
            <div className="inv-item-tags">
              {item.tags.map((t) => <span key={t} className="inv-tag">{t}</span>)}
            </div>
          )}
        </div>
      ))}
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

// ─── Main Page ───

export function GamePage() {
  const { sessionId = '' } = useParams()
  const navigate = useNavigate()

  const [state, setState] = useState<GameState | null>(null)
  const [summary, setSummary] = useState<SummaryDoc | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [currentOptions, setCurrentOptions] = useState<ActionOption[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [latestNarratorId, setLatestNarratorId] = useState<string | null>(null)
  const [error, setError] = useState('')

  /* Quick-action state */
  const [selectedSkill, setSelectedSkill] = useState('')
  const [selectedAttribute, setSelectedAttribute] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [youtubeUrl, setYoutubeUrl] = useState<string | null>(null)
  const [worldInfo, setWorldInfo] = useState<{ campaignName: string; thematic: string } | null>(null)
  const [pendingDiceOption, setPendingDiceOption] = useState<ActionOption | null>(null)
  const [pendingValidation, setPendingValidation] = useState<{ input: string; validation: ValidateActionResponse } | null>(null)
  const [validating, setValidating] = useState(false)
  const [playerImage, setPlayerImage] = useState<{ mimeType: string; base64: string } | null>(null)
  const [playerName, setPlayerName] = useState<string | null>(null)
  const [typewriterSpeed, setTypewriterSpeed] = useState<number>(3)
  const [narrativeStyle, setNarrativeStyle] = useState<NarrativeStyle | undefined>(undefined)
  const [simpleVocabulary, setSimpleVocabulary] = useState<boolean | undefined>(undefined)
  const [savingNarration, setSavingNarration] = useState(false)

  const chatEndRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<ChatMessage[]>([])
  const pendingEngineMessagesRef = useRef<Map<string, ChatMessage>>(new Map())
  const sessionSummaryText = trimIncompleteSummaryText(summary?.summaryText)
  const hasPersistedSummaryMessage = messages.some(
    (message) => message.role === 'system' && Boolean(message.narrative?.trim()) && !(message.engineEvents?.length)
  )
  const displayMessages = sessionSummaryText && !hasPersistedSummaryMessage
    ? [{
        messageId: `session-summary-${sessionId || state?.meta.sessionId || 'session'}`,
        sessionId: sessionId || state?.meta.sessionId || '',
        turn: -1,
        seq: -1,
        role: 'system' as const,
        narrative: sessionSummaryText
      }, ...messages]
    : messages

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
                    setWorldInfo({ campaignName: world.name, thematic: campaign.thematic ?? '' })
                  })
                  .catch(() => {
                    setWorldInfo({ campaignName: '', thematic: campaign.thematic ?? '' })
                  })
              } else {
                setWorldInfo({ campaignName: '', thematic: campaign.thematic ?? '' })
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
  }, options?: { replaceMessages?: boolean }) {
    setState(result.state)
    setSummary(result.summary ?? null)

    let msgs = result.messages ?? []
    const normalizedNarratorOptions = normalizeOptions(result.narratorResponse?.options)

    // Construir mensagem do narrador (fallback se Firestore ainda não propagou)
    let narratorMsg: ChatMessage | null = null
    if (result.narratorResponse?.narrative) {
      const nr = result.narratorResponse
      const existingMsg = msgs.find(
        (m) => m.role === 'narrator' && m.narrative === nr.narrative
      )
      if (!existingMsg) {
        narratorMsg = {
          messageId: `narrator-${Date.now()}`,
          sessionId: result.state.meta.sessionId,
          turn: result.state.meta.turn,
          role: 'narrator',
          narrative: nr.narrative,
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
      hasNarratorResponse: Boolean(result.narratorResponse?.narrative)
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

    // Se a opção tem dice check required, abrir modal de confirmação
    if (chosen?.diceCheck?.required) {
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
    try {
      const result = await chooseOption(sessionId, optionId, handleEnginePhase)
      handlePayload(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao executar opção')
      setLoading(false)
    }
  }

  async function handleCustomSubmit(e?: FormEvent) {
    e?.preventDefault()
    if (!sessionId || !input.trim()) return
    const text = input.trim()
    setError('')
    setValidating(true)
    setPendingValidation(null)
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
    try {
      let result
      // Se a validação indicou trait_test ou diceCheck com skill/attribute, enviar como trait_test
      const dc = validation?.diceCheck
      const isAttack = validation?.actionType === 'attack'
      const combatSkill = isAttack ? (dc?.skill ?? 'Luta') : null
      if (dc?.required && (dc.skill || dc.attribute)) {
        result = await executeTraitTest(
          {
            sessionId,
            skill: dc.skill ?? undefined,
            attribute: dc.attribute ?? undefined,
            modifier: dc.modifier ?? 0,
            description: text
          },
          handleEnginePhase
        )
      } else if (isAttack && combatSkill) {
        // Ataque livre sem dice check required explícito — rolar a perícia de combate
        result = await executeTraitTest(
          {
            sessionId,
            skill: combatSkill,
            modifier: dc?.modifier ?? 0,
            description: text
          },
          handleEnginePhase
        )
      } else {
        result = await executeCustomAction(sessionId, text, handleEnginePhase)
      }
      handlePayload(result)
    } catch (err) {
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
    try {
      const result = await executeTraitTest({ sessionId, skill, attribute }, handleEnginePhase)
      handlePayload(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
      setLoading(false)
    }
  }

  async function handleSoak() {
    if (!sessionId) return
    setError('')
    setLoading(true)
    pushOptimisticPlayerMessage('Rolagem de absorção')
    try {
      const result = await executeSoakRoll(sessionId, handleEnginePhase)
      handlePayload(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
      setLoading(false)
    }
  }

  async function handleSpendBenny(purpose: 'reroll' | 'soak' | 'unshake') {
    if (!sessionId) return
    setError('')
    setLoading(true)
    pushOptimisticPlayerMessage(`Usar Benny: ${purpose}`)
    try {
      const result = await executeSpendBenny(sessionId, purpose, handleEnginePhase)
      handlePayload(result)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha')
      setLoading(false)
    }
  }

  async function handleRecoverShaken() {
    if (!sessionId) return
    setError('')
    setLoading(true)
    pushOptimisticPlayerMessage('Recuperar de abalado')
    try {
      const result = await executeRecoverShaken(sessionId, handleEnginePhase)
      handlePayload(result)
    } catch (err) {
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

  async function handleRemoveItem(itemId: string) {
    if (!sessionId) return
    try {
      const result = await removeInventoryItem(sessionId, itemId)
      setState((prev) => prev ? {
        ...prev,
        player: { ...prev.player, inventory: result.inventory }
      } : prev)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao remover item')
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
  const statusEffects = state?.player.statusEffects ?? []

  return (
    <section className="page-game">
      {/* ── YouTube Ambient ── */}
      {youtubeUrl && <YouTubeAmbient youtubeUrl={youtubeUrl} />}

      {/* ── HUD: título + status + ações numa única barra ── */}
      <div className="game-hud">
        <button
          type="button"
          className="game-back-btn"
          onClick={() => navigate(-1)}
          title="Voltar"
        >
          ← Voltar
        </button>
        <span className="hud-divider" />
        <span className="game-hud-title">
          {worldInfo ? `${worldInfo.thematic} — ${worldInfo.campaignName}` : 'Carregando...'}
        </span>

        {state && (
          <>
            <span className="hud-divider" />
            <div className="subheader-status">
              <span title="Ferimentos"><span className="hud-icon">❤️</span><span className="hud-label">Vida</span> {state.player.wounds}/{state.player.maxWounds}</span>
              <span title="Bennies disponíveis"><span className="hud-icon">🎲</span><span className="hud-label">Bennies</span> {state.player.bennies}</span>
              <span title="Aparar (defesa corpo a corpo)"><span className="hud-icon">🛡️</span><span className="hud-label">Aparar</span> {state.player.parry}</span>
              <span title="Resistência (absorção de dano)"><span className="hud-icon">💪</span><span className="hud-label">Resist.</span> {state.player.toughness}</span>
              {state.player.isShaken && <span className="shaken-badge">ABALADO</span>}
              <span className="location-tag" title="Localização atual"><span className="hud-icon">📍</span>{state.worldState.activeLocation}</span>
            </div>
            <span className="hud-spacer" />
            <div className="subheader-actions">
              <button
                type="button"
                className="subheader-btn"
                onClick={() => setSidebarOpen(!sidebarOpen)}
                title="Ficha do Personagem"
              >
                📋 {state.player.name ?? 'Ficha'}
              </button>
              <button
                type="button"
                className="subheader-btn"
                onClick={() => setShowAdvanced(!showAdvanced)}
                title="Ações avançadas"
              >
                ⚔️ Ações
              </button>
              <select
                className="subheader-btn"
                value={typewriterSpeed}
                onChange={(e) => setTypewriterSpeed(Number(e.target.value))}
                title="Velocidade do narrador"
              >
                <option value={0}>⚡ Instantâneo</option>
                <option value={1}>🐢 Lento</option>
                <option value={3}>💬 Normal</option>
                <option value={6}>🚀 Rápido</option>
              </select>
              {bennies > 0 && (
                <button
                  type="button"
                  className="subheader-btn accent"
                  onClick={() => handleSpendBenny('reroll')}
                  disabled={loading}
                  title="Gastar Benny para re-rolar"
                >
                  🎲 Benny
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Sidebar do Personagem (fixa à direita) ── */}
      <CharacterSidebar
        state={state}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onReset={handleReset}
        resetting={resetting}
        onRemoveItem={handleRemoveItem}
        narrativeStyle={narrativeStyle}
        simpleVocabulary={simpleVocabulary}
        onNarrativeStyleChange={handleNarrativeStyleChange}
        onSimpleVocabularyChange={handleSimpleVocabularyChange}
        savingNarration={savingNarration}
      />

      {/* ── Chat Narrativo ── */}
      <div className="chat-panel">
        <div className="chat-log">
          {displayMessages.length === 0 && !loading && (
            <div className="chat-empty">
              <span className="chat-empty-icon">🎲</span>
              <p className="chat-empty-text">A história ainda não começou. Escolha uma ação ou descreva o que seu personagem faz.</p>
            </div>
          )}
          {displayMessages.map((msg, i) => {
            const prev = displayMessages[i - 1]
            const showSeparator = prev && msg.turn > 0 && prev.turn > 0 && msg.turn !== prev.turn
            return (
              <div key={msg.messageId ?? `msg-${i}`}>
                {showSeparator && (
                  <div className="turn-separator">
                    <span className="turn-separator-label">Turno {msg.turn} · Cap. {state?.meta.chapter ?? 1}</span>
                  </div>
                )}
                <NarrativeBubble message={msg} isNew={msg.messageId === latestNarratorId} charsPerTick={typewriterSpeed} playerName={playerName ?? state?.player.name} playerImage={playerImage} />
              </div>
            )
          })}
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
      </div>

      {/* ── Dice Check Confirm Modal ── */}
      {pendingDiceOption && (
        <DiceCheckConfirmModal
          option={pendingDiceOption}
          playerState={state?.player ?? null}
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
            <h3 className="dice-confirm-title">🎲 Teste Necessário</h3>
            <p className="dice-confirm-action">{pendingValidation.validation.interpretation}</p>

            {pendingValidation.validation.diceCheck && (
              <div className="dice-confirm-details">
                <div className="dice-detail-row">
                  <span className="dice-detail-label">Teste</span>
                  <span className="dice-detail-value">
                    {resolveDiceCheckTrait(
                      pendingValidation.validation.diceCheck,
                      pendingValidation.validation.actionPayload
                    ).label}
                  </span>
                </div>
                {(() => {
                  const trait = resolveDiceCheckTrait(
                    pendingValidation.validation.diceCheck,
                    pendingValidation.validation.actionPayload
                  )
                  const playerDie = resolvePlayerTraitDie(state?.player ?? null, trait)
                  return playerDie != null ? (
                    <div className="dice-detail-row">
                      <span className="dice-detail-label">Seu dado</span>
                      <span className="dice-detail-value dice-die-value">{dieLabel(playerDie)} + Wild Die</span>
                    </div>
                  ) : null
                })()}
                <div className="dice-detail-row">
                  <span className="dice-detail-label">Modificador</span>
                  <span className="dice-detail-value">
                    {(pendingValidation.validation.diceCheck.modifier ?? 0) === 0
                      ? '0'
                      : `${(pendingValidation.validation.diceCheck.modifier ?? 0) > 0 ? '+' : ''}${pendingValidation.validation.diceCheck.modifier}`}
                  </span>
                </div>
                <div className="dice-detail-row">
                  <span className="dice-detail-label">TN (alvo)</span>
                  <span className="dice-detail-value">{pendingValidation.validation.diceCheck.tn ?? 4}</span>
                </div>
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
                🎲 Rolar e Executar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Chat livre ── */}
      <form className="form-grid" onSubmit={handleCustomSubmit}>
        <div className="input-row">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleCustomSubmit()
              }
            }}
            placeholder="Descreva sua ação... (Enter para enviar, Shift+Enter para nova linha)"
            rows={2}
          />
          <div className="input-actions">
            <button disabled={loading || validating || !sessionId || !input.trim()} type="submit">
              {validating ? 'Validando...' : loading ? '...' : 'Enviar'}
            </button>
            <button
              type="button"
              className="scroll-top-btn"
              onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
              title="Ir ao topo da página"
            >
              ↑
            </button>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  )
}
