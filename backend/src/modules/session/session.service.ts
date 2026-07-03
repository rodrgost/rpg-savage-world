import { Injectable, NotFoundException } from '@nestjs/common'
import { createInitialState } from '../../domain/defaults/initialState.js'
import type { AttributeName, DieType, GameState, Hindrance, NarrativeStyle, PlayerAction, SWAttributes } from '../../domain/types/gameState.js'
import type { NarratorTurnResponse, ValidateActionResponse, NpcAttackEntry } from '../../domain/types/narrative.js'
import { applyAction, applyNpcAttack } from '../../core/rule-engine.js'
import { SnapshotService } from '../../services/snapshot.service.js'
import { SummaryService } from '../../services/summary.service.js'
import { InventoryService } from '../../services/inventory.service.js'
import { StatusEffectService } from '../../services/statusEffect.service.js'
import { NpcService } from '../../services/npc.service.js'
import {
  buildCanonicalAnchors,
  buildCanonicalPromptSection,
  type CanonicalAnchors,
} from '../../services/canonical-anchors.js'
import { deriveCanonicalFacts, buildCanonicalFactsPromptSection } from '../../services/canonical-facts.js'
import { SessionEventRepo } from '../../repositories/sessionEvent.repo.js'
import { SessionSummaryRepo } from '../../repositories/sessionSummary.repo.js'
import { CanonicalFactRepo } from '../../repositories/canonicalFact.repo.js'
import { ChatMessageRepo, type ChatMessageRow } from '../../repositories/chatMessage.repo.js'
import { buildLlmContext } from '../../services/contextBuilder.js'
import { segmentsToText } from '../../domain/segments.js'
import { firestore, FieldValue } from '../../infrastructure/firebase.js'
import { randomUUID } from 'node:crypto'
import { WorldsRepo } from '../../repositories/worlds.repo.js'
import { CampaignsRepo } from '../../repositories/campaigns.repo.js'
import { CharactersRepo } from '../../repositories/characters.repo.js'
import { difficultyToModifier, findSkillDefinition, isDieType } from '../../domain/savage-worlds/constants.js'
import type { Narrator } from '../../llm/narrator.js'
import { GeminiAdapter } from '../../llm/gemini.adapter.js'
import { log, warn } from '../../utils/file-logger.js'
import { pushNarrationLog } from '../../services/narrationLog.js'

type SessionDocData = Record<string, unknown>
type SessionDocSnapshot = FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
type ReusableSessionCandidate = {
  sessionId: string
  latestTurn: number
  createdAtMillis: number
}

function normalizeNarrativeStyle(value: unknown): NarrativeStyle | undefined {
  if (value === 'concise' || value === 'balanced') return value
  if (value === 'theatrical') return 'balanced'
  return undefined
}

const ATTRIBUTE_ALIAS_TO_KEY: Readonly<Record<string, AttributeName>> = {
  agility: 'agility',
  agilidade: 'agility',
  smarts: 'smarts',
  astucia: 'smarts',
  espírito: 'spirit',
  espirito: 'spirit',
  spirit: 'spirit',
  strength: 'strength',
  forca: 'strength',
  força: 'strength',
  vigor: 'vigor'
}

function normalizeLookupValue(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
}

function normalizeAttributeName(attributeName: string | null | undefined): AttributeName | undefined {
  if (typeof attributeName !== 'string') return undefined
  return ATTRIBUTE_ALIAS_TO_KEY[normalizeLookupValue(attributeName)]
}

function normalizeSkillName(skillName: string | null | undefined): string | undefined {
  if (typeof skillName !== 'string') return undefined

  const trimmed = skillName.trim()
  if (!trimmed) return undefined

  return findSkillDefinition(trimmed)?.label
}

function normalizePlayerAction(action: PlayerAction): PlayerAction {
  switch (action.type) {
    case 'trait_test':
      return {
        ...action,
        skill: normalizeSkillName(action.skill)
      }
    case 'attack':
      return {
        ...action,
        skill: normalizeSkillName(action.skill) ?? 'Luta'
      }
    default:
      return action
  }
}

function sortChatMessages(messages: ChatMessageRow[]): ChatMessageRow[] {
  return [...messages].sort((left, right) => {
    if (left.seq != null && right.seq != null) return left.seq - right.seq
    if (left.turn !== right.turn) return left.turn - right.turn

    const roleOrder = { player: 0, system: 1, narrator: 2 } as const
    return (roleOrder[left.role] ?? 1) - (roleOrder[right.role] ?? 1)
  })
}

function ensureChatMessages(messages: ChatMessageRow[], requiredMessages: ChatMessageRow[]): ChatMessageRow[] {
  const byId = new Map(messages.map((message) => [message.messageId, message]))

  for (const message of requiredMessages) {
    if (!byId.has(message.messageId)) {
      byId.set(message.messageId, message)
    }
  }

  return sortChatMessages([...byId.values()])
}

@Injectable()
export class SessionService {
  private readonly snapshots = new SnapshotService()
  private readonly summaries = new SummaryService()
  private readonly summaryRepo = new SessionSummaryRepo()
  private readonly events = new SessionEventRepo()
  private readonly facts = new CanonicalFactRepo()
  private readonly worlds = new WorldsRepo()
  private readonly campaigns = new CampaignsRepo()
  private readonly characters = new CharactersRepo()
  private readonly chatMessages = new ChatMessageRepo()
  private readonly inventory = new InventoryService()
  private readonly statusEffects = new StatusEffectService()
  private readonly npcService = new NpcService()
  private readonly narrator: Narrator = new GeminiAdapter()

  private async requireOwnedSession(sessionId: string, ownerId: string): Promise<Record<string, unknown>> {
    const sessionSnap = await firestore.collection('sessions').doc(sessionId).get()
    if (!sessionSnap.exists) throw new NotFoundException('Sessão não encontrada')

    const sessionData = sessionSnap.data() as Record<string, unknown>
    if (sessionData.ownerId !== ownerId) throw new NotFoundException('Sem permissão')
    return sessionData
  }

  async requireOwnedSessionPublic(ownerId: string, sessionId: string): Promise<void> {
    await this.requireOwnedSession(sessionId, ownerId)
  }

  private async buildSessionPayload(sessionId: string) {
    const state = await this.snapshots.getLatestState(sessionId)
    if (!state) throw new NotFoundException('Sessão não encontrada')

    const rawStateNarrativeStyle = (state.meta as Record<string, unknown>).narrativeStyle
    const normalizedState = rawStateNarrativeStyle === 'theatrical'
      ? { ...state, meta: { ...state.meta, narrativeStyle: 'balanced' as const } }
      : state

    const [summary, recentMessages, messages, events] = await Promise.all([
      this.summaryRepo.getSummary(sessionId),
      this.summaries.getRecentWindow(sessionId),
      this.chatMessages.listBySession(sessionId),
      this.events.listSince({ sessionId, afterTurn: -1 })
    ])
    const context = buildLlmContext({ state: normalizedState, summary, recentMessages })

    return { state: normalizedState, summary, events, context, messages }
  }

  private buildStrictRulesDigest(baseRulesDigest: string | undefined, anchors: CanonicalAnchors, factsSection?: string | null): string {
    return [baseRulesDigest?.trim(), buildCanonicalPromptSection(anchors), factsSection].filter(Boolean).join('\n\n')
  }

  private createNarrativeNpcStub(
    npc: NarratorTurnResponse['npcs'][number],
    location: string,
    catalog?: import('../../domain/types/gameState.js').NpcDefinition[]
  ): GameState['npcs'][number] {
    if (catalog?.length) {
      const fromCatalog = this.npcService.resolveNpcFromCatalog(catalog, npc, location)
      if (fromCatalog) return fromCatalog
    }
    return this.npcService.buildNpcStub(npc, location)
  }

  private syncNarratorNpcs(params: {
    state: GameState
    npcs: NarratorTurnResponse['npcs']
    sceneLocation: string
    allowCreate: boolean
    npcCatalog?: import('../../domain/types/gameState.js').NpcDefinition[]
  }): GameState {
    const { state, npcs, sceneLocation, allowCreate, npcCatalog } = params
    if (!npcs.length) return state

    const mentionById = new Map(npcs.map((npc) => [npc.id, npc]))
    const knownNpcIds = new Set(state.npcs.map((npc) => npc.id))
    let changed = false

    const mergedNpcs = state.npcs.map((existingNpc) => {
      const mention = mentionById.get(existingNpc.id)
      if (!mention) return existingNpc

      // Não atualiza NPCs que pertencem a outra cena
      if (existingNpc.location && existingNpc.location !== sceneLocation) {
        return existingNpc
      }

      const mentionDisplay = mention.displayName ?? mention.name

      // Verifica se há mudanças em name/displayName, disposition ou status
      const hasChanges =
        existingNpc.name !== mentionDisplay ||
        existingNpc.displayName !== mentionDisplay ||
        existingNpc.disposition !== mention.disposition ||
        (mention.status && existingNpc.status !== mention.status)

      if (!hasChanges) {
        return existingNpc
      }

      changed = true
      return {
        ...existingNpc,
        name: mentionDisplay,
        displayName: mentionDisplay,
        disposition: mention.disposition,
        // Aplica o status se vier da IA (mudanças narrativas)
        ...(mention.status ? { status: mention.status } : {})
      }
    })

    if (allowCreate) {
      for (const npc of npcs) {
        if (knownNpcIds.has(npc.id)) continue
        if ((state.defeatedNpcIds ?? []).includes(npc.id)) continue
        mergedNpcs.push(this.createNarrativeNpcStub(npc, sceneLocation, npcCatalog))
        changed = true
      }
    }

    if (!changed) return state

    return {
      ...state,
      npcs: mergedNpcs
    }
  }

  private hydrateSceneNpcsFromRecentNarration(state: GameState, recentMessages: ChatMessageRow[]): GameState {
    const activeLocation = state.worldState.activeLocation
    // Acumula NPCs apenas das mensagens da cena atual (mensagens legadas sem location são incluídas para retrocompatibilidade)
    const accumulatedNpcs = new Map<string, NarratorTurnResponse['npcs'][number]>()
    for (const message of recentMessages) {
      if (message.role === 'narrator' && Array.isArray(message.npcs)) {
        if (!message.location || message.location === activeLocation) {
          for (const npc of message.npcs) {
            accumulatedNpcs.set(npc.id, npc)
          }
        }
      }
    }

    if (!accumulatedNpcs.size) return state

    const npcs = [...accumulatedNpcs.values()]
    log(
      'hydrateSceneNpcs',
      `Sincronizando ${npcs.length} NPC(s) das mensagens recentes em ${state.worldState.activeLocation}`
    )

    return this.syncNarratorNpcs({
      state,
      npcs,
      sceneLocation: state.worldState.activeLocation,
      allowCreate: true
    })
  }

  /**
   * Deduplica as opções já validadas do LLM e limita a no máximo 4.
   *
   * NÃO gera opções sintéticas de preenchimento: se o LLM devolver menos de 4
   * opções válidas, a lista fica intencionalmente incompleta. É preferível
   * apresentar menos opções reais e coerentes do que fabricar ações genéricas
   * (ex.: "enfrentar" um inimigo já derrotado, "observar os arredores"), que
   * confundem o jogador e quebram a continuidade da cena.
   */
  private completeValidatedOptions(
    options: NarratorTurnResponse['options']
  ): NarratorTurnResponse['options'] {
    const completed: NarratorTurnResponse['options'] = []
    const seen = new Set<string>()

    for (const option of options) {
      if (completed.length >= 4) break

      const signature = [
        option.actionType,
        option.text.trim().toLowerCase(),
        JSON.stringify(option.actionPayload ?? {})
      ].join('|')

      if (seen.has(signature)) continue
      seen.add(signature)
      completed.push(option)
    }

    return completed
  }

  private validateNarratorOption(
    option: NarratorTurnResponse['options'][number],
    state: GameState,
    mode: 'start' | 'turn',
    pendingItemRefs: Set<string>,
    canonicalAnchors?: CanonicalAnchors
  ): NarratorTurnResponse['options'][number] | null {
    // NPCs derrotados/mortos/incapacitados (ou em defeatedNpcIds) não são alvos
    // válidos, mesmo que ainda constem na cena neste turno. Excluí-los aqui impede
    // que uma opção de ataque do LLM contra um inimigo já abatido passe na validação
    // (e que o redirecionamento de alvo hostil abaixo escolha um caído).
    const NPC_DOWN_STATUSES = new Set(['dead', 'defeated', 'incapacitated'])
    const isNpcDown = (npc: GameState['npcs'][number]): boolean =>
      (state.defeatedNpcIds ?? []).includes(npc.id) ||
      (npc.status != null && NPC_DOWN_STATUSES.has(npc.status))

    const sceneNpcIds = new Set(
      state.npcs
        .filter(
          (npc) =>
            (!npc.location || npc.location === state.worldState.activeLocation) && !isNpcDown(npc)
        )
        .map((npc) => npc.id)
    )

    const actionPayload = { ...(option.actionPayload ?? {}) }
    const requiredItems = (option.requiredItems ?? []).filter(Boolean)
    let feasible = option.feasible
    let feasibilityReason = option.feasibilityReason ?? null
    const diceCheck = option.diceCheck
      ? {
          ...option.diceCheck,
          skill: normalizeSkillName(option.diceCheck.skill) ?? null,
          attribute: normalizeAttributeName(option.diceCheck.attribute) ?? null,
          // App é dono dos números: TN sempre 4; modificador derivado da dificuldade.
          tn: 4,
          modifier: difficultyToModifier(option.diceCheck.difficulty)
        }
      : null

    if (typeof actionPayload.skill === 'string') {
      const normalizedSkill = normalizeSkillName(actionPayload.skill)
      if (!normalizedSkill) {
        warn('validateNarratorOption', `Descartando opção com perícia inválida: "${actionPayload.skill}"`)
        return null
      }
      actionPayload.skill = normalizedSkill
    }

    if (typeof actionPayload.attribute === 'string') {
      const normalizedAttribute = normalizeAttributeName(actionPayload.attribute)
      if (!normalizedAttribute) {
        warn('validateNarratorOption', `Descartando opção com atributo inválido: "${actionPayload.attribute}"`)
        return null
      }
      actionPayload.attribute = normalizedAttribute
    }

    const missingRequiredItems = requiredItems.filter((itemRef) => {
      const lookupKey = normalizeLookupValue(itemRef)
      return !this.inventory.hasItem(state, itemRef) && !pendingItemRefs.has(lookupKey)
    })
    if (missingRequiredItems.length) {
      feasible = false
      const missingRef = missingRequiredItems[0]
      const resolvedName =
        state.player.inventory?.find(
          (i) => i.id === missingRef || i.name.toLowerCase() === missingRef.toLowerCase()
        )?.name ?? missingRef
      feasibilityReason = feasibilityReason ?? `Item necessário ausente: ${resolvedName}.`
    }

    switch (option.actionType) {
      case 'attack': {
        const resolvedTargetId = typeof actionPayload.targetId === 'string' ? actionPayload.targetId.trim() : ''
        if (!resolvedTargetId || !sceneNpcIds.has(resolvedTargetId)) {
          // Tenta redirecionar para qualquer NPC hostil que esteja na cena,
          // incluindo os recém-introduzidos pela narrativa deste turno.
          const hostileSceneNpcId = [...sceneNpcIds].find((id) => {
            const npc = state.npcs.find((n) => n.id === id)
            return npc?.disposition === 'hostile'
          })
          if (hostileSceneNpcId) {
            warn('validateNarratorOption', `Corrigindo ataque: targetId "${resolvedTargetId || 'vazio'}" → "${hostileSceneNpcId}"`)
            actionPayload.targetId = hostileSceneNpcId
          } else {
            warn('validateNarratorOption', `Descartando ataque com alvo fora da cena: "${resolvedTargetId || 'vazio'}"`)
            return null
          }
        }

        const attackSkill = normalizeSkillName(
          (typeof actionPayload.skill === 'string' ? actionPayload.skill : undefined) ?? diceCheck?.skill
        ) ?? 'Luta'
        actionPayload.skill = attackSkill
        if (diceCheck) {
          diceCheck.skill = attackSkill
          diceCheck.attribute = null
        }
        break
      }
      case 'trait_test': {
        const skill = normalizeSkillName(
          (typeof actionPayload.skill === 'string' ? actionPayload.skill : undefined) ?? diceCheck?.skill
        )
        const attribute = normalizeAttributeName(
          (typeof actionPayload.attribute === 'string' ? actionPayload.attribute : undefined) ?? diceCheck?.attribute
        )

        if (!skill && !attribute) {
          warn('validateNarratorOption', `Descartando trait_test sem perícia ou atributo válido: "${option.text}"`)
          return null
        }

        if (skill) {
          actionPayload.skill = skill
        } else {
          delete actionPayload.skill
        }

        if (attribute) {
          actionPayload.attribute = attribute
        } else {
          delete actionPayload.attribute
        }

        if (diceCheck) {
          diceCheck.skill = skill ?? null
          diceCheck.attribute = attribute ?? null
        }
        break
      }
      case 'travel': {
        const destination = typeof actionPayload.to === 'string' ? actionPayload.to.trim() : ''
        if (!destination || normalizeLookupValue(destination) === 'desconhecido') {
          warn('validateNarratorOption', `Descartando travel sem destino válido: "${option.text}"`)
          return null
        }
        if (normalizeLookupValue(destination) === normalizeLookupValue(state.worldState.activeLocation)) {
          warn('validateNarratorOption', `Descartando travel com destino igual ao local atual: "${destination}"`)
          return null
        }
        actionPayload.to = destination
        break
      }
      case 'custom': {
        const input = typeof actionPayload.input === 'string' ? actionPayload.input.trim() : option.text.trim()
        if (!input) return null
        actionPayload.input = input
        break
      }
      case 'flag': {
        const key = typeof actionPayload.key === 'string' ? actionPayload.key.trim() : ''
        if (!key) return null
        actionPayload.key = key
        break
      }
      default:
        break
    }

    if (mode === 'turn' && option.actionType === 'attack' && !sceneNpcIds.has(String(actionPayload.targetId ?? ''))) {
      return null
    }

    return {
      ...option,
      actionPayload,
      requiredItems,
      feasible,
      feasibilityReason,
      diceCheck
    }
  }

  private validateNarratorItemChanges(
    changes: NarratorTurnResponse['itemChanges'],
    state: GameState,
    mode: 'start' | 'turn',
    action?: PlayerAction
  ): NarratorTurnResponse['itemChanges'] {
    return changes.filter((change) => {
      if (change.quantity <= 0) return false

      if (mode === 'start') {
        return change.changeType === 'gained'
      }

      if (change.changeType === 'used' && change.category === 'ammunition' && action?.type !== 'attack') {
        warn('validateNarratorItemChanges', `Descartando consumo de munição indevido fora de ataque: "${change.name}"`)
        return false
      }

      if (change.changeType !== 'gained' && !this.inventory.hasItem(state, change.itemId) && !this.inventory.hasItem(state, change.name)) {
        warn('validateNarratorItemChanges', `Descartando mudança de item ausente do inventário: "${change.name}"`)
        return false
      }

      return true
    })
  }

  private validateNarratorStatusChanges(
    changes: NarratorTurnResponse['statusChanges'],
    state: GameState,
    mode: 'start' | 'turn',
    action?: PlayerAction
  ): NarratorTurnResponse['statusChanges'] {
    if (mode === 'start') {
      return changes.filter((change) => Boolean(change.name.trim()))
    }

    return changes.filter((change) => {
      const matchesEffect = (effects: Array<{ id: string; name: string }> | undefined) => (
        (effects ?? []).some(
          (effect) => effect.id === change.effectId || normalizeLookupValue(effect.name) === normalizeLookupValue(change.name)
        )
      )
      const targetId = typeof change.targetId === 'string' ? change.targetId.trim() : ''
      const npcTargetIds = new Set<string>()
      if (targetId) npcTargetIds.add(targetId)
      if (!targetId && change.targetType !== 'player' && action?.type === 'attack') npcTargetIds.add(action.targetId.trim())

      const matchesPlayer = change.targetType !== 'npc' && matchesEffect(state.player.statusEffects)
      const matchesNpc = change.targetType !== 'player' && [...npcTargetIds].some((id) => {
        const npc = state.npcs.find((candidate) => candidate.id === id)
          ?? state.combat?.combatants.find((candidate) => candidate.id === id)
        return matchesEffect(npc?.statusEffects)
      })
      const matchesExisting = matchesPlayer || matchesNpc

      if (!matchesExisting) {
        const targetLabel = change.targetType === 'npc'
          ? `npc:${targetId || 'sem-id'}`
          : change.targetType ?? 'player-or-any'
        warn('validateNarratorStatusChanges', `Descartando status sem âncora canônica (${targetLabel}): "${change.name}"`)
        return false
      }

      return true
    })
  }

  private validateNarrativeSegments(params: {
    segments: NarratorTurnResponse['segments']
    state: GameState
    sceneNpcIds: Set<string>
  }): NonNullable<NarratorTurnResponse['segments']> {
    const fallback: NonNullable<NarratorTurnResponse['segments']> = [{ type: 'narrator' as const, text: 'A história continua...' }]
    if (!params.segments?.length) return fallback

    const sceneNpcs = params.state.npcs.filter((npc) => params.sceneNpcIds.has(npc.id))
    const npcById = new Map(sceneNpcs.map((npc) => [npc.id, npc]))
    const npcsByName = new Map<string, typeof sceneNpcs>()
    for (const npc of sceneNpcs) {
      const key = normalizeLookupValue(npc.name)
      npcsByName.set(key, [...(npcsByName.get(key) ?? []), npc])
    }

    const segments: NonNullable<NarratorTurnResponse['segments']> = []
    const pushNarratorSegment = (text: string) => {
      const previous = segments[segments.length - 1]
      if (previous?.type === 'narrator') {
        previous.text = `${previous.text}\n\n${text}`
        return
      }

      segments.push({ type: 'narrator', text })
    }

    for (const segment of params.segments) {
      const text = segment.text.trim()
      if (!text) continue

      if (segment.type === 'narrator') {
        pushNarratorSegment(text)
        continue
      }

      const namedMatches = segment.npcName ? npcsByName.get(normalizeLookupValue(segment.npcName)) ?? [] : []
      const canonicalNpc = segment.npcId
        ? npcById.get(segment.npcId) ?? (namedMatches.length === 1 ? namedMatches[0] : undefined)
        : namedMatches.length === 1
          ? namedMatches[0]
          : undefined

      if (!canonicalNpc) {
        warn('validateNarrativeSegments', `Convertendo fala de NPC inválido para narrador: "${segment.npcName}"`)
        pushNarratorSegment(text)
        continue
      }

      segments.push({
        type: 'npc',
        npcId: canonicalNpc.id,
        npcName: canonicalNpc.name,
        disposition: canonicalNpc.disposition ?? segment.disposition ?? 'neutral',
        text
      })
    }

    return segments.length ? segments : fallback
  }

  private validateNarratorResponse(params: {
    response: NarratorTurnResponse
    state: GameState
    mode: 'start' | 'turn'
    action?: PlayerAction
    engineEvents?: Array<{ type: string; payload: Record<string, unknown> }>
    recentMessages?: ChatMessageRow[]
    summaryText?: string
  }): NarratorTurnResponse {
    const { response, state, mode, action, engineEvents, recentMessages, summaryText } = params
    if (response.isFallback) {
      warn('validateNarratorResponse', `[isFallback] LLM falhou no modo "${mode}" — conteúdo genérico retornado ao jogador`)
    }
    const canonicalNarrativeState = this.syncNarratorNpcs({
      state,
      npcs: response.npcs,
      sceneLocation: state.worldState.activeLocation,
      allowCreate: true
    })
    const canonicalAnchors = buildCanonicalAnchors({
      state: canonicalNarrativeState,
      recentMessages,
      summaryText,
      currentNarrative: segmentsToText(response.segments)
    })
    const itemChanges = this.validateNarratorItemChanges(response.itemChanges, state, mode, action)
    const pendingItemRefs = new Set(
      itemChanges.flatMap((change) => [change.itemId, change.name]).map((value) => normalizeLookupValue(value))
    )
    const options = this.completeValidatedOptions(
      response.options
        .map((option) => this.validateNarratorOption(option, canonicalNarrativeState, mode, pendingItemRefs, canonicalAnchors))
        .filter((option): option is NarratorTurnResponse['options'][number] => option !== null)
    )
    const sceneNpcIds = new Set(
      canonicalNarrativeState.npcs
        .filter((npc) => !npc.location || npc.location === canonicalNarrativeState.worldState.activeLocation)
        .map((npc) => npc.id)
    )
    const npcs = response.npcs.filter((npc) => sceneNpcIds.has(npc.id))
    const segments = this.validateNarrativeSegments({
      segments: response.segments,
      state: canonicalNarrativeState,
      sceneNpcIds
    })

    return {
      ...response,
      segments,
      options,
      npcs,
      itemChanges,
      statusChanges: this.validateNarratorStatusChanges(response.statusChanges, canonicalNarrativeState, mode, action)
    }
  }

  private buildResumeKey(params: { ownerId: string; campaignId: string; characterId: string }): string {
    return [params.ownerId, params.campaignId, params.characterId].map((value) => value.trim()).join(':')
  }

  private async listSessionDocsByResumeKey(resumeKey: string): Promise<SessionDocSnapshot[]> {
    const qs = await firestore.collection('sessions').where('resumeKey', '==', resumeKey).get()
    return qs.docs
  }

  private async listLegacySessionDocs(params: { ownerId: string; campaignId: string; characterId: string }): Promise<SessionDocSnapshot[]> {
    const qs = await firestore.collection('sessions').where('ownerId', '==', params.ownerId).get()
    return qs.docs.filter((doc) => {
      const data = doc.data() as SessionDocData
      return data.campaignId === params.campaignId && data.characterId === params.characterId
    })
  }

  private resolveCreatedAtMillis(createdAt: unknown): number {
    if (createdAt instanceof Date) return createdAt.getTime()
    if (createdAt && typeof createdAt === 'object') {
      const timestampLike = createdAt as { toMillis?: unknown; _seconds?: unknown }
      if (typeof timestampLike.toMillis === 'function') {
        return timestampLike.toMillis()
      }
      if (typeof timestampLike._seconds === 'number') {
        return timestampLike._seconds * 1000
      }
    }
    return 0
  }

  private async pickBestReusableSession(sessionDocs: SessionDocSnapshot[], reason: string): Promise<ReusableSessionCandidate | null> {
    if (!sessionDocs.length) return null

    const candidates = (
      await Promise.all(
        sessionDocs.map(async (doc) => {
          const data = doc.data() as SessionDocData
          const sessionId = typeof data.sessionId === 'string' && data.sessionId.trim() ? data.sessionId : doc.id
          const latestSnapshot = await this.snapshots.getLatestSnapshot(sessionId)

          if (!latestSnapshot) {
            warn('createSession', `Ignorando sessão sem snapshot reutilizável: ${sessionId}`)
            return null
          }

          return {
            sessionId,
            latestTurn: latestSnapshot.turn,
            createdAtMillis: this.resolveCreatedAtMillis(data.createdAt)
          }
        })
      )
    ).filter((candidate): candidate is ReusableSessionCandidate => candidate !== null)

    if (!candidates.length) return null

    candidates.sort((left, right) => {
      if (right.latestTurn !== left.latestTurn) return right.latestTurn - left.latestTurn
      if (right.createdAtMillis !== left.createdAtMillis) return right.createdAtMillis - left.createdAtMillis
      return left.sessionId.localeCompare(right.sessionId)
    })

    if (candidates.length > 1) {
      const chosen = candidates[0]
      warn(
        'createSession',
        `Encontradas ${candidates.length} sessões reutilizáveis para ${reason}; escolhida ${chosen.sessionId} (turn=${chosen.latestTurn})`
      )
    }

    return candidates[0]
  }

  private async ensureResumeKey(sessionId: string, resumeKey: string): Promise<void> {
    await firestore.collection('sessions').doc(sessionId).set({ resumeKey }, { merge: true })
  }

  private async findReusableSessionId(params: { ownerId: string; campaignId: string; characterId: string }): Promise<string | null> {
    const resumeKey = this.buildResumeKey(params)

    const keyedCandidate = await this.pickBestReusableSession(
      await this.listSessionDocsByResumeKey(resumeKey),
      `resumeKey=${resumeKey}`
    )
    if (keyedCandidate) {
      await this.ensureResumeKey(keyedCandidate.sessionId, resumeKey)
      return keyedCandidate.sessionId
    }

    const legacyCandidate = await this.pickBestReusableSession(
      await this.listLegacySessionDocs(params),
      `ownerId=${params.ownerId}, campaignId=${params.campaignId}, characterId=${params.characterId}`
    )
    if (!legacyCandidate) return null

    await this.ensureResumeKey(legacyCandidate.sessionId, resumeKey)
    return legacyCandidate.sessionId
  }

  /**
   * Playthroughs (sessões) ativos do usuário — alimenta a aba "jogos ativos".
   * Um mesmo personagem pode aparecer em várias linhas (campanhas diferentes).
   * Obs.: sessões legadas sem `status` não aparecem até receberem backfill.
   */
  async listActivePlaythroughs(params: { ownerId: string }): Promise<Array<{
    sessionId: string
    campaignId: string
    characterId: string
    worldId?: string
    status: string
    updatedAtMillis: number
  }>> {
    const qs = await firestore
      .collection('sessions')
      .where('ownerId', '==', params.ownerId)
      .where('status', '==', 'ativo')
      .get()

    const toMillis = (value: unknown): number =>
      typeof value === 'object' && value !== null && '_seconds' in value
        ? Number((value as { _seconds: number })._seconds) * 1000
        : 0

    return qs.docs
      .map((doc) => {
        const data = doc.data() as Record<string, unknown>
        return {
          sessionId: doc.id,
          campaignId: String(data.campaignId ?? ''),
          characterId: String(data.characterId ?? ''),
          worldId: typeof data.worldId === 'string' ? data.worldId : undefined,
          status: String(data.status ?? 'ativo'),
          updatedAtMillis: toMillis(data.updatedAt ?? data.createdAt)
        }
      })
      .sort((a, b) => b.updatedAtMillis - a.updatedAtMillis)
  }

  async createSession(params: { ownerId: string; campaignId: string; characterId: string; narrativeStyle?: NarrativeStyle; simpleVocabulary?: boolean }) {
    const [campaign, character] = await Promise.all([
      this.campaigns.get(params.campaignId),
      this.characters.get(params.characterId)
    ])
    if (!campaign) throw new NotFoundException('Campanha não encontrada')
    if (campaign.ownerId !== params.ownerId && campaign.visibility !== 'public') {
      throw new NotFoundException('Sem permissão para esta campanha')
    }
    if (!character) throw new NotFoundException('Character não encontrado')
    const characterOwnerId = typeof character.ownerId === 'string' && character.ownerId.trim()
      ? character.ownerId
      : character.userId
    if (characterOwnerId !== params.ownerId) throw new NotFoundException('Sem permissão para este character')
    // Personagem agora pertence ao Mundo (não à Campanha). Invariante: mesmo mundo.
    // Personagens legados sem worldId são tolerados (serão backfillados).
    if (character.worldId && character.worldId !== campaign.worldId) {
      throw new NotFoundException('Personagem pertence a outro mundo')
    }

    const resumeKey = this.buildResumeKey(params)
    const reusableSessionId = await this.findReusableSessionId(params)
    if (reusableSessionId) {
      log('createSession', `Retomando sessão existente ${reusableSessionId} para ${resumeKey}`)
      const payload = await this.buildSessionPayload(reusableSessionId)
      return { sessionId: reusableSessionId, ...payload }
    }

    const world = await this.worlds.get(campaign.worldId)

    const sessionId = randomUUID()

    await firestore
      .collection('sessions')
      .doc(sessionId)
      .set({
        sessionId,
        ownerId: params.ownerId,
        campaignId: params.campaignId,
        characterId: params.characterId,
        worldId: campaign.worldId,
        resumeKey,
        ...(params.narrativeStyle ? { narrativeStyle: params.narrativeStyle } : {}),
        ...(params.simpleVocabulary !== undefined ? { simpleVocabulary: params.simpleVocabulary } : {}),
        status: 'ativo',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      })

    // Parse character attributes as DieType
    const rawAttrs = (character.attributes ?? {}) as Record<string, unknown>
    const swAttributes: Partial<SWAttributes> = {}
    for (const key of ['agility', 'smarts', 'spirit', 'strength', 'vigor'] as const) {
      const value = Number(rawAttrs[key])
      if (isDieType(value)) swAttributes[key] = value
    }

    // Parse skills
    const rawSkills = (character.skills ?? {}) as Record<string, unknown>
    const skills: Record<string, DieType> = {}
    for (const [key, val] of Object.entries(rawSkills)) {
      const numVal = Number(val)
      if (isDieType(numVal)) skills[key] = numVal
    }

    // Parse edges and hindrances
    const edges: string[] = Array.isArray(character.edges)
      ? character.edges.filter((e: unknown) => typeof e === 'string')
      : []
    const hindrances: Hindrance[] = Array.isArray(character.hindrances)
      ? character.hindrances.filter(
          (h: unknown) =>
            typeof h === 'object' && h !== null && typeof (h as Record<string, unknown>).name === 'string'
        ) as Hindrance[]
      : []

    const armor = typeof character.armor === 'number' ? character.armor : 0

    let state = createInitialState({
      sessionId,
      campaignId: params.campaignId,
      worldId: campaign.worldId,
      narrativeStyle: params.narrativeStyle,
      simpleVocabulary: params.simpleVocabulary,
      character: {
        characterId: params.characterId,
        name: character.name ?? '',
        attributes: swAttributes,
        skills,
        edges,
        hindrances,
        armor
      }
    })

    // ── Chamar LLM para narrativa inicial ──
    const narratorResponse = this.validateNarratorResponse({
      response: await this.narrator.narrateStart({
        world: world
          ? {
              name: world.name,
              description: world.description,
              lore: world.lorePtBrief ?? world.lore ?? world.loreEn,
              narrativeStyleGuide: world.narrativeStyleGuide
            }
          : undefined,
        campaign: {
          storyDescription: campaign.storyDescription ?? campaign.storyDescriptionEn ?? '',
          name: campaign.name
        },
        character: {
          name: character.name ?? 'Aventureiro',
          profession: character.profession ?? character.professionEn,
          race: character.race ?? character.raceEn,
          gender: character.gender ?? character.genderEn,
          description: character.description ?? character.descriptionEn,
          edges,
          hindrances: hindrances.map((h) => ({ name: h.name, severity: h.severity }))
        },
        simpleVocabulary: params.simpleVocabulary
      }),
      state,
      mode: 'start'
    })

    // Aplicar itens e status narrativos ao estado
    state = this.inventory.applyItemChanges(state, narratorResponse.itemChanges)
    state = this.statusEffects.applyStatusChanges(state, narratorResponse.statusChanges)

    state = this.syncNarratorNpcs({
      state,
      npcs: narratorResponse.npcs,
      sceneLocation: state.worldState.activeLocation,
      allowCreate: true,
      npcCatalog: world?.npcCatalog
    })

    await this.snapshots.saveTurnState(state)

    await this.summaryRepo.upsertSummary({
      sessionId,
      lastTurnIncluded: 0,
      summaryText: '',
      keyEvents: []
    })

    // Salvar mensagem do narrador no chat
    await this.chatMessages.append({
      sessionId,
      turn: 0,
      role: 'narrator',
      segments: narratorResponse.segments,
      options: narratorResponse.options,
      npcs: narratorResponse.npcs,
      itemChanges: narratorResponse.itemChanges,
      statusChanges: narratorResponse.statusChanges,
      location: state.worldState.activeLocation
    })

    const payload = await this.buildSessionPayload(sessionId)
    return { sessionId, ...payload, narratorResponse }
  }

  async getSession(params: { ownerId: string; sessionId: string }) {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    return await this.buildSessionPayload(params.sessionId)
  }

  async getEvents(params: { ownerId: string; sessionId: string }) {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const events = await this.events.listSince({ sessionId: params.sessionId, afterTurn: -1 })
    return { events }
  }

  async getMessages(params: { ownerId: string; sessionId: string }) {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const messages = await this.chatMessages.listBySession(params.sessionId)
    return { messages }
  }

  async rebuildHistorySummary(params: { ownerId: string; sessionId: string }) {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const current = await this.snapshots.getLatestState(params.sessionId)
    if (!current) throw new NotFoundException('Sessão não encontrada')

    await this.summaries.rebuildSummary({ state: current })

    return await this.buildSessionPayload(params.sessionId)
  }

  /**
   * Reinicia a sessão: apaga todo o histórico (mensagens, eventos, snapshots, resumo)
   * e recria o estado inicial + narrativa da LLM.
   */
  async resetSession(params: { sessionId: string; ownerId: string }) {
    const sessionDoc = firestore.collection('sessions').doc(params.sessionId)
    const sessionData = await this.requireOwnedSession(params.sessionId, params.ownerId)

    const worldId = sessionData.worldId as string | undefined
    const campaignId = sessionData.campaignId as string
    const characterId = sessionData.characterId as string
    const narrativeStyle = normalizeNarrativeStyle(sessionData.narrativeStyle)
    const simpleVocabulary = typeof sessionData.simpleVocabulary === 'boolean' ? sessionData.simpleVocabulary : undefined

    // ── Apagar subcollections ──
    const subcollections = ['messages', 'archivedMessages', 'snapshots', 'events', 'facts', '_meta']
    for (const sub of subcollections) {
      const colRef = sessionDoc.collection(sub)
      const docs = await colRef.listDocuments()
      const batch = firestore.batch()
      for (const doc of docs) batch.delete(doc)
      if (docs.length) await batch.commit()
    }

    // ── Recriar estado do zero ──
    const campaign = campaignId ? await this.campaigns.get(campaignId) : null
    const world = worldId ? await this.worlds.get(worldId) : null
    if (!campaign && !world) throw new NotFoundException('Campanha/Mundo não encontrado')

    const character = await this.characters.get(characterId)
    if (!character) throw new NotFoundException('Personagem não encontrado')

    const rawAttrs = (character.attributes ?? {}) as Record<string, unknown>
    const swAttributes: Partial<SWAttributes> = {}
    for (const key of ['agility', 'smarts', 'spirit', 'strength', 'vigor'] as const) {
      const value = Number(rawAttrs[key])
      if (isDieType(value)) swAttributes[key] = value
    }

    const rawSkills = (character.skills ?? {}) as Record<string, unknown>
    const skills: Record<string, DieType> = {}
    for (const [key, val] of Object.entries(rawSkills)) {
      const numVal = Number(val)
      if (isDieType(numVal)) skills[key] = numVal
    }

    const edges: string[] = Array.isArray(character.edges)
      ? character.edges.filter((e: unknown) => typeof e === 'string')
      : []
    const hindrances: Hindrance[] = Array.isArray(character.hindrances)
      ? character.hindrances.filter(
          (h: unknown) =>
            typeof h === 'object' && h !== null && typeof (h as Record<string, unknown>).name === 'string'
        ) as Hindrance[]
      : []

    const armor = typeof character.armor === 'number' ? character.armor : 0

    let state = createInitialState({
      sessionId: params.sessionId,
      campaignId: campaignId ?? '',
      worldId: worldId,
      narrativeStyle,
      simpleVocabulary,
      character: {
        characterId,
        name: character.name ?? '',
        attributes: swAttributes,
        skills,
        edges,
        hindrances,
        armor
      }
    })

    // ── Chamar LLM para nova narrativa inicial ──
    const narratorResponse = this.validateNarratorResponse({
      response: await this.narrator.narrateStart({
        world: world
          ? {
              name: world.name,
              description: world.description,
              lore: world.lorePtBrief ?? world.lore ?? world.loreEn,
              narrativeStyleGuide: world.narrativeStyleGuide
            }
          : undefined,
        campaign: campaign
          ? {
              storyDescription: campaign.storyDescription ?? campaign.storyDescriptionEn ?? '',
              name: campaign.name
            }
          : { storyDescription: '' },
        character: {
          name: character.name ?? 'Aventureiro',
          profession: character.profession ?? character.professionEn,
          race: character.race ?? character.raceEn,
          gender: character.gender ?? character.genderEn,
          description: character.description ?? character.descriptionEn,
          edges,
          hindrances: hindrances.map((h) => ({ name: h.name, severity: h.severity }))
        },
        simpleVocabulary
      }),
      state,
      mode: 'start'
    })

    state = this.inventory.applyItemChanges(state, narratorResponse.itemChanges)
    state = this.statusEffects.applyStatusChanges(state, narratorResponse.statusChanges)

    state = this.syncNarratorNpcs({
      state,
      npcs: narratorResponse.npcs,
      sceneLocation: state.worldState.activeLocation,
      allowCreate: true,
      npcCatalog: world?.npcCatalog
    })

    await this.snapshots.saveTurnState(state)

    await this.summaryRepo.upsertSummary({
      sessionId: params.sessionId,
      lastTurnIncluded: 0,
      summaryText: '',
      keyEvents: []
    })

    await this.chatMessages.append({
      sessionId: params.sessionId,
      turn: 0,
      role: 'narrator',
      segments: narratorResponse.segments,
      options: narratorResponse.options,
      npcs: narratorResponse.npcs,
      itemChanges: narratorResponse.itemChanges,
      statusChanges: narratorResponse.statusChanges,
      location: state.worldState.activeLocation
    })

    const payload = await this.buildSessionPayload(params.sessionId)
    return { ...payload, narratorResponse }
  }

  async applyTurn(params: { ownerId: string; sessionId: string; action: PlayerAction; displayText?: string }) {
    const result = await this.applyTurnStreamed(params)
    return result
  }

  /**
   * Valida uma ação custom digitada pelo jogador antes de executá-la.
   * Retorna se é viável, se precisa de teste de dados, e a interpretação da ação.
   */
  async validateCustomAction(params: { ownerId: string; sessionId: string; input: string }) {
    const sessionData = await this.requireOwnedSession(params.sessionId, params.ownerId)
    const current = await this.snapshots.getLatestState(params.sessionId)
    if (!current) throw new NotFoundException('Sessão não encontrada')

    const sessionWorldId = typeof sessionData.worldId === 'string' && sessionData.worldId
      ? sessionData.worldId
      : current.meta.worldId
    const [summary, recentMessages, sessionWorld, canonicalFacts] = await Promise.all([
      this.summaryRepo.getSummary(params.sessionId),
      this.summaries.getRecentWindow(params.sessionId),
      sessionWorldId ? this.worlds.get(sessionWorldId) : Promise.resolve(null),
      this.facts.listBySession(params.sessionId)
    ])
    const currentWithSceneNpcs = this.hydrateSceneNpcsFromRecentNarration(current, recentMessages)
    const context = buildLlmContext({ state: currentWithSceneNpcs, summary, recentMessages, npcCatalog: sessionWorld?.npcCatalog })
    const canonicalAnchors = buildCanonicalAnchors({
      state: currentWithSceneNpcs,
      recentMessages,
      summaryText: context.summaryText
    })

    const validation = await this.narrator.validateAction({
      input: params.input,
      context: {
        summaryText: context.summaryText,
        location: context.stateBrief.location,
        wounds: context.stateBrief.wounds,
        fatigue: context.stateBrief.fatigue,
        isShaken: context.stateBrief.isShaken,
        bennies: context.stateBrief.bennies,
        npcsPresent: context.stateBrief.npcsPresent,
        defeatedNpcIds: context.stateBrief.defeatedNpcIds,
        inventory: context.stateBrief.inventory,
        activeStatusEffects: context.stateBrief.activeStatusEffects,
        playerSkills: context.stateBrief.playerSkills,
        rulesDigest: this.buildStrictRulesDigest(context.rulesDigest, canonicalAnchors, buildCanonicalFactsPromptSection(canonicalFacts))
      },
      recentMessages: context.recentMessages
    })

    // App é dono dos números: converte a dificuldade declarada pelo LLM em
    // modificador fixo e força TN 4, independentemente do que o modelo retornou.
    if (validation.diceCheck) {
      validation.diceCheck.modifier = difficultyToModifier(validation.diceCheck.difficulty)
      validation.diceCheck.tn = 4
    }

    return validation
  }

  /**
   * Versão streamed do applyTurn.
   * Recebe um callback opcional `onEngineComplete` que é chamado logo após
   * a rolagem de dados e persistência das system messages, ANTES de chamar o LLM.
   * Isso permite ao controller enviar o resultado dos dados imediatamente ao frontend.
   */
  async applyTurnStreamed(
    params: { ownerId: string; sessionId: string; action: PlayerAction; displayText?: string },
    onEngineComplete?: (data: { state: import('../../domain/types/gameState.js').GameState; messages: ChatMessageRow[]; diceEvents: Array<{ type: string; payload: unknown }> }) => void
  ) {
    const sessionData = await this.requireOwnedSession(params.sessionId, params.ownerId)
    const sessionNarrativeStyle = normalizeNarrativeStyle(sessionData.narrativeStyle)
    const sessionSimpleVocabulary = typeof sessionData.simpleVocabulary === 'boolean' ? sessionData.simpleVocabulary : undefined
    const current = await this.snapshots.getLatestState(params.sessionId)
    if (!current) throw new NotFoundException('Sessão não encontrada')
    const recentMessagesBeforeTurn = await this.summaries.getRecentWindow(params.sessionId)
    const currentWithSceneNpcs = this.hydrateSceneNpcsFromRecentNarration(current, recentMessagesBeforeTurn)

    // 1. Aplicar mecânicas do rule-engine
    const normalizedAction = normalizePlayerAction(params.action)
    const result = applyAction(currentWithSceneNpcs, normalizedAction)

    for (const ev of result.emittedEvents) {
      await this.events.append({
        sessionId: params.sessionId,
        turn: result.nextState.meta.turn,
        type: ev.type,
        payload: ev.payload
      })
    }

    // 2. Salvar mensagem do jogador
    const rawInput = normalizedAction.type === 'custom' ? normalizedAction.input : undefined
    const isSpeechOnly = typeof rawInput === 'string' && rawInput.startsWith('- ')
    const combinedSepIdx = !isSpeechOnly && typeof rawInput === 'string' ? rawInput.indexOf(' - ') : -1
    const isCombined = combinedSepIdx !== -1
    const speechText = isSpeechOnly
      ? rawInput!.slice(2).trim()
      : isCombined
        ? rawInput!.slice(combinedSepIdx + 3).trim()
        : undefined
    const actionDescription = params.displayText || this.describeAction(normalizedAction)
    const playerMessage = await this.chatMessages.appendAndGet({
      sessionId: params.sessionId,
      turn: result.nextState.meta.turn,
      role: 'player',
      playerInput: actionDescription
    })

    // 2.5 Salvar resultados de dados como mensagem de sistema (persistente no chat)
    const diceEvents = result.emittedEvents.filter(
      (e) => e.type === 'trait_test' || e.type === 'attack_hit' || e.type === 'attack_miss' || e.type === 'soak_roll' || e.type === 'recover_shaken' || e.type === 'recover_shaken_failed' || e.type === 'heal_success' || e.type === 'heal_failure'
    )
    let systemMessage: ChatMessageRow | null = null
    if (diceEvents.length > 0) {
      systemMessage = await this.chatMessages.appendAndGet({
        sessionId: params.sessionId,
        turn: result.nextState.meta.turn,
        role: 'system',
        engineEvents: diceEvents.map((e) => ({ type: e.type, payload: e.payload }))
      })
    }

    // ── Emitir resultado do engine imediatamente (antes do LLM) ──
    if (onEngineComplete && diceEvents.length > 0) {
      const intermediateMessages = ensureChatMessages(
        await this.chatMessages.listBySession(params.sessionId),
        systemMessage ? [playerMessage, systemMessage] : [playerMessage]
      )
      log(
        'session-stream',
        `engine turn=${result.nextState.meta.turn} diceEvents=${diceEvents.length} messages=${intermediateMessages.length} action=${params.action.type}`
      )
      onEngineComplete({
        state: result.nextState,
        messages: intermediateMessages,
        diceEvents: diceEvents.map((e) => ({ type: e.type, payload: e.payload }))
      })
    }

    // 3. Buscar contexto, campanha e mundo para a LLM (em paralelo para reduzir latência)
    const worldIdDirect = result.nextState.meta.worldId || null
    const [summary, recentMessages, campaignDoc, worldDocDirect, canonicalFacts] = await Promise.all([
      this.summaryRepo.getSummary(params.sessionId),
      this.summaries.getRecentWindow(params.sessionId),
      result.nextState.meta.campaignId
        ? this.campaigns.get(result.nextState.meta.campaignId)
        : Promise.resolve(null),
      worldIdDirect ? this.worlds.get(worldIdDirect) : Promise.resolve(null),
      this.facts.listBySession(params.sessionId)
    ])
    const worldDoc = worldDocDirect ?? (campaignDoc?.worldId ? await this.worlds.get(campaignDoc.worldId) : null)
    const context = buildLlmContext({ state: result.nextState, summary, recentMessages, npcCatalog: worldDoc?.npcCatalog })
    const canonicalAnchors = buildCanonicalAnchors({
      state: result.nextState,
      recentMessages,
      summaryText: context.summaryText
    })

    // 4. Chamar LLM para narrativa do turno
    const llmStart = Date.now()
    let narratorResponse = this.validateNarratorResponse({
      response: await this.narrator.narrateTurn({
        playerAction: {
          type: normalizedAction.type,
          description: actionDescription,
          ...(speechText ? { playerSpeech: speechText } : {})
        },
        engineEvents: result.emittedEvents,
        world: worldDoc
          ? {
              name: worldDoc.name,
              description: worldDoc.description,
              lore: worldDoc.lorePtBrief ?? worldDoc.lore ?? worldDoc.loreEn,
              narrativeStyleGuide: worldDoc.narrativeStyleGuide
            }
          : undefined,
        campaign: campaignDoc
          ? { name: campaignDoc.name, storyDescription: campaignDoc.storyDescription ?? campaignDoc.storyDescriptionEn }
          : undefined,
        context: {
          summaryText: context.summaryText,
          location: context.stateBrief.location,
          wounds: context.stateBrief.wounds,
          fatigue: context.stateBrief.fatigue,
          isShaken: context.stateBrief.isShaken,
          bennies: context.stateBrief.bennies,
          npcsPresent: context.stateBrief.npcsPresent,
          defeatedNpcIds: context.stateBrief.defeatedNpcIds,
          inventory: context.stateBrief.inventory,
          activeStatusEffects: context.stateBrief.activeStatusEffects,
          playerSkills: context.stateBrief.playerSkills,
          rulesDigest: this.buildStrictRulesDigest(context.rulesDigest, canonicalAnchors, buildCanonicalFactsPromptSection(canonicalFacts)),
          situation: context.stateBrief.situation,
          npcCatalog: context.stateBrief.npcCatalog
        },
        recentMessages: context.recentMessages,
        narrativeStyle: sessionNarrativeStyle ?? result.nextState.meta.narrativeStyle ?? 'concise',
        simpleVocabulary: sessionSimpleVocabulary ?? result.nextState.meta.simpleVocabulary ?? true
      }),
      state: result.nextState,
      mode: 'turn',
      action: normalizedAction,
      engineEvents: result.emittedEvents,
      recentMessages,
      summaryText: context.summaryText
    })

    // 5. Aplicar mudanças narrativas ao estado (dedup contra inventário atual e mensagens recentes)
    let finalState = result.nextState
    const dedupedItemChanges = this.deduplicateItemChanges(
      narratorResponse.itemChanges,
      finalState.player.inventory ?? [],
      recentMessages
    )
    narratorResponse = { ...narratorResponse, itemChanges: dedupedItemChanges }
    finalState = this.inventory.applyItemChanges(finalState, dedupedItemChanges)
    finalState = this.statusEffects.applyStatusChanges(finalState, narratorResponse.statusChanges, { action: normalizedAction })
    finalState = this.statusEffects.tickEffects(finalState)
    finalState = this.statusEffects.applyNarrativeRecovery(finalState, {
      actionText: actionDescription,
      narrative: segmentsToText(narratorResponse.segments)
    })

    // 5.4. Persistir derrotas declaradas pela narrativa.
    // Quando a IA marca um NPC com status defeated/dead/incapacitated (ações que NÃO passam
    // pelo rule-engine, ex.: repelir com artefato), removemos o NPC da cena e o registramos
    // em defeatedNpcIds — espelhando o comportamento do engine para ataques mecânicos.
    // IMPORTANTE: nunca "ressuscitamos" um NPC aqui; status 'active' vindo da IA é ignorado,
    // impedindo que a narrativa traga de volta um inimigo já derrotado.
    const npcNameById = new Map<string, string>()
    for (const npc of finalState.npcs) npcNameById.set(npc.id, npc.displayName ?? npc.name)
    for (const npc of narratorResponse.npcs) npcNameById.set(npc.id, npc.displayName ?? npc.name)

    const NARRATIVE_DOWN_STATUSES = new Set(['defeated', 'dead', 'incapacitated'])
    const narrativeDownIds = new Set(
      narratorResponse.npcs
        .filter((n) => n.status && NARRATIVE_DOWN_STATUSES.has(n.status))
        .map((n) => n.id)
    )
    if (narrativeDownIds.size > 0) {
      const mergedDefeated = new Set(finalState.defeatedNpcIds ?? [])
      for (const id of narrativeDownIds) mergedDefeated.add(id)
      finalState = {
        ...finalState,
        npcs: finalState.npcs.filter((n) => !narrativeDownIds.has(n.id)),
        defeatedNpcIds: [...mergedDefeated]
      }
    }

    // 5.45. Registrar fatos canônicos derivados deste turno (mortes de NPC, inversão de
    // desfecho, itens de missão) — ledger append-only, nunca resumido nem apagado.
    const newCanonicalFacts = deriveCanonicalFacts({
      stateBeforeTurn: current,
      finalState,
      narratorResponse,
      npcNameById
    })
    if (newCanonicalFacts.length) {
      await this.facts.appendBatch(params.sessionId, newCanonicalFacts)
    }

    // 5.5. Processar ataques de NPCs contra o jogador
    // No Savage Worlds cada personagem age no seu próprio turno de iniciativa.
    // Quando o jogador ataca (seja via action 'attack' ou outro tipo que resulte em ataque),
    // o NPC já recebeu dano neste turno — processar npcAttacks simultaneamente resultaria 
    // no jogador sofrendo dano no mesmo turno em que atacou, o que é incorreto mecanicamente.
    // Verifica tanto o tipo da ação quanto os eventos emitidos para capturar todos os casos de ataque.
    const hasPlayerAttack = normalizedAction.type === 'attack' 
      || result.emittedEvents.some(ev => ev.type === 'attack_hit' || ev.type === 'attack_miss')
    // Ataques de NPC são autoridade EXCLUSIVA do narrador (LLM): só ocorrem quando o LLM
    // os declara explicitamente em "npcAttacks". Não há mais auto-geração de ataques quando
    // a lista vem vazia — um NPC hostil presente na cena não ataca por conta própria.
    const pendingNpcAttacks: NpcAttackEntry[] = hasPlayerAttack ? [] : (narratorResponse.npcAttacks ?? [])
    const npcAttackEvents: Array<{ type: string; payload: unknown }> = []
    for (const entry of pendingNpcAttacks) {
      // Validar: NPC deve estar na cena, ser diferente do jogador, e skillDie deve ser DieType válido
      const sceneNpc = finalState.npcs.find(
        (n) => n.id === entry.npcId && (!n.location || n.location === finalState.worldState.activeLocation)
      )
      if (!sceneNpc) {
        warn('applyNpcAttack', `NPC "${entry.npcId}" não encontrado na cena — ataque ignorado`)
        continue
      }
      // Impedir que um NPC derrotado/incapacitado/morto ataque o jogador.
      // Mesma regra do gerador automático de ataques: um inimigo fora de combate não age.
      if (
        (finalState.defeatedNpcIds ?? []).includes(entry.npcId) ||
        sceneNpc.status === 'incapacitated' ||
        sceneNpc.status === 'defeated' ||
        sceneNpc.status === 'dead'
      ) {
        warn('applyNpcAttack', `NPC "${entry.npcId}" derrotado/incapacitado — ataque ignorado`)
        continue
      }
      // Garantir que o atacante não seja o próprio jogador (prevenção extra)
      if (entry.npcId === finalState.player.characterId) {
        warn('applyNpcAttack', `Ataque do próprio jogador ignorado — jogador não pode atacar a si mesmo`)
        continue
      }
      if (!isDieType(entry.skillDie) || !entry.damageFormula?.trim()) {
        warn('applyNpcAttack', `Ataque de NPC "${entry.npcId}" com skillDie/damageFormula inválido — ignorado`)
        continue
      }
      const npcAttackResult = applyNpcAttack(finalState, entry)
      finalState = npcAttackResult.nextState
      for (const ev of npcAttackResult.emittedEvents) {
        npcAttackEvents.push({ type: ev.type, payload: ev.payload })
        await this.events.append({
          sessionId: params.sessionId,
          turn: finalState.meta.turn,
          type: ev.type,
          payload: ev.payload as Record<string, unknown>
        })
      }
    }

    // Salvar eventos de ataques de NPC como system message
    if (npcAttackEvents.length > 0) {
      await this.chatMessages.appendAndGet({
        sessionId: params.sessionId,
        turn: finalState.meta.turn,
        role: 'system',
        engineEvents: npcAttackEvents.map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> }))
      })
    }

    // 5.9 Registrar log de narração (fire-and-forget — não bloqueia o retorno do turno)
    pushNarrationLog({
      sessionId: params.sessionId,
      timestamp: Date.now(),
      turn: finalState.meta.turn,
      durationMs: Date.now() - llmStart,
      playerAction: { type: normalizedAction.type, description: actionDescription },
      engineEvents: result.emittedEvents.map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> })),
      narrative: segmentsToText(narratorResponse.segments),
      options: narratorResponse.options.map((o) => ({
        id: o.id,
        text: o.text,
        playerSpeech: o.playerSpeech ?? undefined,
        actionType: o.actionType,
        feasible: o.feasible,
        diceCheck: o.diceCheck ? {
          skill: o.diceCheck.skill ?? undefined,
          attribute: o.diceCheck.attribute ?? undefined,
          tn: o.diceCheck.tn ?? undefined,
          required: o.diceCheck.required
        } : null
      })),
      npcs: narratorResponse.npcs.map((n) => ({ id: n.id, name: n.name, action: n.status ?? n.disposition })),
      itemChanges: narratorResponse.itemChanges.map((c) => ({
        name: c.name,
        changeType: c.changeType,
        quantity: typeof (c as Record<string, unknown>).quantity === 'number'
          ? (c as Record<string, unknown>).quantity as number
          : undefined
      })),
      statusChanges: narratorResponse.statusChanges.map((c) => ({
        name: (c as Record<string, unknown>).name as string ?? '',
        changeType: (c as Record<string, unknown>).changeType as string ?? '',
        effectId: (c as Record<string, unknown>).effectId as string | undefined
      })),
      npcAttackEvents: npcAttackEvents.map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> })),
      isFallback: narratorResponse.isFallback ?? false
    }).catch(() => { /* log falhou silenciosamente — não afeta o turno */ })

    // 6. Salvar estado final e mensagem do narrador
    await this.snapshots.saveTurnState(finalState)

    await this.chatMessages.append({
      sessionId: params.sessionId,
      turn: finalState.meta.turn,
      role: 'narrator',
      segments: narratorResponse.segments,
      options: narratorResponse.options,
      npcs: narratorResponse.npcs,
      itemChanges: narratorResponse.itemChanges,
      statusChanges: narratorResponse.statusChanges,
      location: finalState.worldState.activeLocation
    })

    // 7. Compactar histórico de mensagens antigas se necessário
    await this.summaries.manageSummaryAfterTurn({ state: finalState, stateBeforeTurn: result.nextState })

    const payload = await this.buildSessionPayload(params.sessionId)
    log(
      'session-stream',
      `narration turn=${finalState.meta.turn} payloadMessages=${payload.messages.length} ensuredMessages=${systemMessage ? 2 : 1} action=${params.action.type}`
    )
    return {
      ...payload,
      messages: ensureChatMessages(
        payload.messages,
        systemMessage ? [playerMessage, systemMessage] : [playerMessage]
      ),
      narratorResponse
    }
  }

  /**
   * Ação por opção: o jogador escolhe uma das 4 opções retornadas pela LLM.
   * Resolve para o PlayerAction correspondente e aplica o turno.
   */
  async chooseOption(params: { ownerId: string; sessionId: string; optionId: string }) {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const { action, displayText } = await this.resolveOption(params)
    return await this.applyTurn({
      ownerId: params.ownerId,
      sessionId: params.sessionId,
      action,
      displayText
    })
  }

  /**
   * Versão streamed do chooseOption — envia resultado de dados antes do LLM.
   */
  async chooseOptionStreamed(
    params: { ownerId: string; sessionId: string; optionId: string },
    onEngineComplete?: (data: { state: import('../../domain/types/gameState.js').GameState; messages: ChatMessageRow[]; diceEvents: Array<{ type: string; payload: unknown }> }) => void
  ) {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const { action, displayText } = await this.resolveOption(params)
    return await this.applyTurnStreamed(
      { ownerId: params.ownerId, sessionId: params.sessionId, action, displayText },
      onEngineComplete
    )
  }

  private async resolveOption(params: { sessionId: string; optionId: string }) {
    // Buscar última mensagem do narrador para encontrar a opção
    const recentMessages = await this.chatMessages.getRecent(params.sessionId, 5)
    const lastNarrator = [...recentMessages].reverse().find((m) => m.role === 'narrator' && m.options?.length)

    if (!lastNarrator?.options) {
      throw new NotFoundException('Nenhuma opção disponível')
    }

    const option = lastNarrator.options.find((o) => o.id === params.optionId)
    if (!option) {
      throw new NotFoundException('Opção não encontrada')
    }

    if (!option.feasible) {
      throw new NotFoundException(option.feasibilityReason ?? 'Esta opção não é viável no momento')
    }

    // Montar o PlayerAction a partir da opção
    const action = this.buildActionFromOption(option)
    return { action, displayText: option.text }
  }

  private buildActionFromOption(option: { actionType: string; actionPayload: Record<string, unknown>; text: string; diceCheck?: { required: boolean; skill?: string | null; attribute?: string | null; difficulty?: string | null; modifier?: number; tn?: number; reason?: string } | null }): PlayerAction {
    const payload = option.actionPayload ?? {}
    const dc = option.diceCheck

    // Modificador situacional é APP-COMPUTED a partir da dificuldade declarada
    // pelo LLM. Os modificadores mecânicos (ferimento/Edge/Hindrance) são somados
    // depois pelo rule-engine. Damage/AP também são resolvidos pelo motor.
    const appModifier = difficultyToModifier(dc?.difficulty)

    // Se a LLM indicou que a opção requer teste de dados E o actionType não é
    // attack/trait_test (que já passam pelo rule-engine), promover para trait_test
    if (
      dc?.required &&
      option.actionType !== 'trait_test' &&
      option.actionType !== 'attack'
    ) {
      // Fallback para 'spirit' se LLM não especificou skill/attribute
      const skill = dc.skill ?? undefined
      const attribute = dc.attribute ?? (skill ? undefined : 'spirit')
      log('buildActionFromOption', `Promoting "${option.actionType}" → trait_test via diceCheck (skill=${skill}, attr=${attribute}, difficulty=${dc.difficulty ?? 'normal'}, mod=${appModifier}, reason=${dc.reason})`)
      return {
        type: 'trait_test',
        skill: normalizeSkillName(skill),
        attribute,
        modifier: appModifier,
        description: option.text
      }
    }

    switch (option.actionType) {
      case 'trait_test':
        // Defesa em profundidade: se o LLM ou sanitizer marcou required=false, tratar como ação narrativa
        if (dc?.required === false) {
          return { type: 'custom', input: option.text }
        }
        return {
          type: 'trait_test',
          skill: normalizeSkillName(dc?.skill ?? (typeof payload.skill === 'string' ? payload.skill : undefined)),
          attribute: dc?.attribute ?? (typeof payload.attribute === 'string' ? payload.attribute : undefined),
          modifier: appModifier,
          description: option.text
        }
      case 'attack':
        // damageFormula/ap NÃO vêm mais do LLM — o rule-engine resolve a arma equipada.
        return {
          type: 'attack',
          skill: normalizeSkillName(dc?.skill ?? (typeof payload.skill === 'string' ? payload.skill : 'Luta')) ?? 'Luta',
          targetId: typeof payload.targetId === 'string' ? payload.targetId : 'unknown',
          modifier: appModifier
        }
      case 'travel':
        return {
          type: 'travel',
          to: typeof payload.to === 'string' ? payload.to : 'desconhecido'
        }
      case 'flag':
        return {
          type: 'flag',
          key: typeof payload.key === 'string' ? payload.key : 'unknown',
          value: typeof payload.value === 'boolean' ? payload.value : true
        }
      case 'recover_shaken':
        return { type: 'recover_shaken' }
      case 'soak_roll':
        return { type: 'soak_roll' }
      case 'heal':
        return {
          type: 'heal',
          targetId: typeof payload.targetId === 'string' ? payload.targetId : undefined,
          modifier: appModifier
        }
      default:
        return {
          type: 'custom',
          input: typeof payload.input === 'string' ? payload.input : option.text
        }
    }
  }

  /**
   * Remove itemChanges duplicados:
   * 1. Itens "gained" que o jogador já possui no inventário
   * 2. Itens "gained" que já apareceram em mensagens recentes do narrador
   */
  private deduplicateItemChanges(
    changes: import('../../domain/types/narrative.js').ItemChange[],
    currentInventory: import('../../domain/types/narrative.js').InventoryItem[],
    recentMessages: ChatMessageRow[]
  ): import('../../domain/types/narrative.js').ItemChange[] {
    if (!changes.length) return changes

    // Nomes (lowercase) de itens já no inventário
    const inventoryNames = new Set(
      currentInventory.map((i) => i.name.toLowerCase().trim())
    )

    // Nomes (lowercase) de itens gained nas últimas N mensagens do narrador
    const recentGainedNames = new Set<string>()
    for (const msg of recentMessages) {
      if (msg.role === 'narrator' && Array.isArray(msg.itemChanges)) {
        for (const ic of msg.itemChanges) {
          if (ic.changeType === 'gained') {
            recentGainedNames.add((ic.name ?? '').toLowerCase().trim())
          }
        }
      }
    }

    return changes.filter((c) => {
      if (c.changeType !== 'gained') return true // lost/used sempre passam
      const nameKey = c.name.toLowerCase().trim()
      // Categorias não-empilháveis: um por personagem, não podem ser ganhas mais de uma vez
      const nonStackableCategories = new Set(['weapon', 'armor', 'vehicle', 'property'])
      if (inventoryNames.has(nameKey) && nonStackableCategories.has(c.category ?? '')) {
        warn('deduplicateItemChanges', `Item já no inventário, ignorando gained: "${c.name}"`)
        return false
      }
      // Apenas bloqueia re-concessão de itens não-empilháveis de mensagens recentes.
      // Itens empilháveis (dinheiro, munição, consumíveis) podem ser ganhos novamente.
      if (recentGainedNames.has(nameKey) && nonStackableCategories.has(c.category ?? '')) {
        warn('deduplicateItemChanges', `Item não-empilhável já concedido recentemente, ignorando: "${c.name}"`)
        return false
      }
      return true
    })
  }

  /**
   * Remove (ou decrementa) um item do inventário do jogador.
   * Salva o snapshot atualizado.
   */
  async updateSessionSettings(params: {
    ownerId: string
    sessionId: string
    narrativeStyle?: NarrativeStyle
    simpleVocabulary?: boolean
  }): Promise<{ ok: boolean }> {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const update: Record<string, unknown> = {}
    if (params.narrativeStyle !== undefined) update.narrativeStyle = params.narrativeStyle
    if (params.simpleVocabulary !== undefined) update.simpleVocabulary = params.simpleVocabulary
    if (Object.keys(update).length > 0) {
      await firestore.collection('sessions').doc(params.sessionId).set(update, { merge: true })
    }
    return { ok: true }
  }

  async removeInventoryItem(params: { ownerId: string; sessionId: string; itemId: string; quantity?: number }): Promise<GameState> {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const state = await this.snapshots.getLatestState(params.sessionId)
    if (!state) throw new NotFoundException('Sessão não encontrada')

    const item = (state.player.inventory ?? []).find((i) => i.id === params.itemId)
    if (!item) throw new NotFoundException('Item não encontrado no inventário')

    const qty = params.quantity ?? item.quantity // remove tudo por padrão
    const updated = this.inventory.applyItemChanges(state, [
      { itemId: params.itemId, name: item.name, quantity: qty, changeType: 'lost' }
    ])

    await this.snapshots.saveTurnState(updated)
    return updated
  }

  private describeAction(action: PlayerAction): string {
    switch (action.type) {
      case 'custom':
        return action.input
      case 'trait_test':
        return `Teste de ${normalizeSkillName(action.skill) ?? action.attribute ?? 'perícia'}${action.description ? ` — ${action.description}` : ''}`
      case 'attack': {
        const calledShotLabel = action.calledShot ? ` (tiro certeiro: ${action.calledShot})` : ''
        return `Ataque contra ${action.targetId} usando ${normalizeSkillName(action.skill) ?? 'Luta'}${calledShotLabel}`
      }
      case 'travel':
        return `Viajar para ${action.to}`
      case 'flag':
        return `Definir flag: ${action.key} = ${action.value}`
      case 'soak_roll':
        return 'Rolagem de absorção'
      case 'spend_benny':
        return `Usar Benny: ${action.purpose}`
      case 'recover_shaken':
        return 'Tentar recuperar de abalado'
      case 'heal':
        return action.targetId ? `Curar ferimentos de ${action.targetId}` : 'Curar ferimentos'
      case 'apply_fatigue':
        return `Aplicar fadiga: ${action.reason ?? 'esforço'}`
      case 'recover_fatigue':
        return 'Recuperar fadiga'
      default:
        return 'Ação desconhecida'
    }
  }
}
