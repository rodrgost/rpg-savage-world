import { FormEvent, useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'

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
  getWorld,
  getCampaign
} from '../lib/api'
import type { EnginePhaseData } from '../lib/api'
import type { ActionOption, ChatMessage, DiceCheck, DiceRollDetail, GameState, InventoryItem, Hindrance, NarratorTurnResponse, SessionEvent, SummaryDoc, TraitTestPayload, ValidateActionResponse } from '../types'
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

const SKILL_ALIAS_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['luta', 'lutar'],
  ['tiro', 'atirar'],
  ['conducao', 'dirigir', 'pilotar'],
  ['montaria', 'cavalgar'],
  ['medicina', 'curar'],
  ['percepcao', 'notar'],
  ['reparos', 'reparar'],
  ['pesquisa', 'investigar'],
  ['ciencia', 'ciencias'],
  ['jogatina', 'apostar'],
  ['intimidacao', 'intimidar'],
  ['atuacao', 'desempenho'],
  ['persuasao', 'persuadir'],
  ['foco', 'psionismo'],
  ['magias', 'conjurar'],
  ['navegacao', 'navegar'],
  ['ladinagem', 'roubar']
] as const

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
  const normalizedLeft = normalizeLookupKey(left)
  const normalizedRight = normalizeLookupKey(right)

  if (normalizedLeft === normalizedRight) return true

  return SKILL_ALIAS_GROUPS.some((group) => group.includes(normalizedLeft) && group.includes(normalizedRight))
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

function NarrativeBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'player') {
    return (
      <div className="msg player">
        <strong>Você</strong>
        <p>{message.playerInput}</p>
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
      <strong>Narrador</strong>
      <div className="narrative-text">
        {splitNarrativeParagraphs(message.narrative).map((paragraph, i) => (
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

  return (
    <div className="action-options">
      <h4>O que deseja fazer?</h4>
      <div className="options-grid">
        {options.map((option) => {
          const dc = option.diceCheck
          const hasDice = dc?.required === true
          const trait = resolveDiceCheckTrait(dc, option.actionPayload)
          return (
            <button
              key={option.id}
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
            {p.damageRolls?.map((dr, i) => (
              <div key={i} className="dice-roll-group">
                <span className="dice-roll-label">Dano d{dr.sides}</span>
                <div className="dice-roll-values">
                  {dr.rolls.map((r: number, j: number) => (
                    <span key={j} className={`dice-value ${dr.aced ? 'aced' : ''}`}>
                      {r}{dr.aced && j < dr.rolls.length - 1 ? '🔥' : ''}
                    </span>
                  ))}
                  <span className="dice-roll-total">= {dr.total}</span>
                </div>
              </div>
            ))}
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

function DiceResultCard({ event }: { event: SessionEvent }) {
  if (event.type === 'attack_hit' || event.type === 'attack_miss') {
    return <AttackResultCard event={event} />
  }
  if (event.type !== 'trait_test') return null

  const p = event.payload as unknown as TraitTestPayload
  const traitName = p.trait?.trim() || 'Teste'
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

type SidebarTab = 'status' | 'attributes' | 'skills' | 'inventory' | 'edges' | 'effects'

const SIDEBAR_TABS: { key: SidebarTab; label: string; icon: string }[] = [
  { key: 'status', label: 'Status', icon: '❤️' },
  { key: 'attributes', label: 'Atributos', icon: '🎯' },
  { key: 'skills', label: 'Perícias', icon: '📖' },
  { key: 'inventory', label: 'Mochila', icon: '🎒' },
  { key: 'edges', label: 'Vantagens', icon: '⭐' },
  { key: 'effects', label: 'Efeitos', icon: '✨' },
]

function CharacterSidebar({
  state,
  open,
  onClose,
  onReset,
  resetting,
  onRemoveItem,
}: {
  state: GameState | null
  open: boolean
  onClose: () => void
  onReset: () => void
  resetting: boolean
  onRemoveItem?: (itemId: string) => void
}) {
  const [tab, setTab] = useState<SidebarTab>('status')

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
          {!p ? (
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
          <button
            type="button"
            className="btn-reset-story"
            disabled={resetting}
            onClick={() => {
              if (window.confirm('Tem certeza? Todo o progresso da história será perdido e uma nova aventura começará.')) {
                onReset()
              }
            }}
          >
            {resetting ? '↻ Reiniciando...' : '🔄 Reiniciar História'}
          </button>
        </div>
      </aside>
    </>
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
                <button
                  type="button"
                  className="inv-item-remove"
                  title="Descartar item"
                  onClick={() => {
                    if (window.confirm(`Descartar "${item.name}"?`)) onRemove(item.id)
                  }}
                >
                  🗑️
                </button>
              )}
            </span>
          </div>
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

  const [state, setState] = useState<GameState | null>(null)
  const [summary, setSummary] = useState<SummaryDoc | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [currentOptions, setCurrentOptions] = useState<ActionOption[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
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
        pendingEngineMessagesRef.current.clear()
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
      const alreadyPresent = msgs.some(
        (m) => m.role === 'narrator' && m.narrative === nr.narrative
      )
      if (!alreadyPresent) {
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

  async function handleCustomSubmit(e: FormEvent) {
    e.preventDefault()
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
    pushOptimisticPlayerMessage(`Teste de ${skill ?? attribute}`)
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

  const bennies = state?.player.bennies ?? 0
  const isShaken = state?.player.isShaken ?? false
  const inventory = state?.player.inventory ?? []
  const statusEffects = state?.player.statusEffects ?? []

  return (
    <section className="page-game">
      {/* ── YouTube Ambient ── */}
      {youtubeUrl && <YouTubeAmbient youtubeUrl={youtubeUrl} />}

      {/* ── Header do Jogo ── */}
      <div className="game-header">
        <h2>{worldInfo ? `${worldInfo.thematic} — ${worldInfo.campaignName}` : 'Carregando...'}</h2>
      </div>

      {/* ── Sub-header sticky: status + atalhos ── */}
      {state && (
        <div className="game-subheader">
          <div className="subheader-status">
            <span>❤️ {state.player.wounds}/{state.player.maxWounds}</span>
            <span>🎲 {state.player.bennies}</span>
            <span>🛡️ {state.player.parry}</span>
            <span>💪 {state.player.toughness}</span>
            {state.player.isShaken && <span className="shaken-badge">ABALADO</span>}
            <span className="location-tag">📍 {state.worldState.activeLocation}</span>
          </div>
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
        </div>
      )}

      {/* ── Sidebar do Personagem (fixa à direita) ── */}
      <CharacterSidebar
        state={state}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onReset={handleReset}
        resetting={resetting}
        onRemoveItem={handleRemoveItem}
      />

      {/* ── Chat Narrativo ── */}
      <div className="chat-panel">
        <div className="chat-log">
          {displayMessages.map((msg, i) => (
            <NarrativeBubble key={msg.messageId ?? `msg-${i}`} message={msg} />
          ))}
          {loading && (
            <div className="msg narrator loading">
              <strong>Narrador</strong>
              <p className="typing-indicator">Narrando...</p>
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
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Descreva sua ação..."
          />
          <button disabled={loading || validating || !sessionId || !input.trim()} type="submit">
            {validating ? 'Validando...' : loading ? '...' : 'Enviar'}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </form>
    </section>
  )
}
