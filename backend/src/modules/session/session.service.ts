import { Injectable, NotFoundException } from '@nestjs/common'
import { createInitialState } from '../../domain/defaults/initialState.js'
import type { AttributeName, DieType, GameState, Hindrance, NarrativeStyle, PlayerAction, SWAttributes } from '../../domain/types/gameState.js'
import type { NarratorTurnResponse, ValidateActionResponse, NpcAttackEntry, InventoryItem } from '../../domain/types/narrative.js'
import { applyAction, applyNpcAttack } from '../../core/rule-engine.js'
import { SnapshotService } from '../../services/snapshot.service.js'
import { SummaryService } from '../../services/summary.service.js'
import { InventoryService } from '../../services/inventory.service.js'
import { StatusEffectService } from '../../services/statusEffect.service.js'
import { NpcService } from '../../services/npc.service.js'
import { NpcRelationsService } from '../../services/npcRelations.service.js'
import { KnownNpcsRepo } from '../../repositories/knownNpcs.repo.js'
import {
  buildCanonicalAnchors,
  buildCanonicalPromptSection,
  extractSceneObjectsFromText,
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
import {
  calcParry,
  calcToughness,
  difficultyToModifier,
  findSkillDefinition,
  findWeaponDefinition,
  isDieType,
  isShieldItem,
  resolveArmorValue,
  resolveShieldParryBonus,
  resolveSkillDie
} from '../../domain/savage-worlds/constants.js'
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

function hasConcreteOptionAnchor(text: string, anchors?: CanonicalAnchors): boolean {
  if (!anchors) return false
  const normalizedText = normalizeLookupValue(text)
  if (!normalizedText) return false

  const anchorCandidates = [
    anchors.currentLocation,
    ...anchors.presentNpcNames,
    ...anchors.inventoryItemNames,
    ...anchors.sceneObjectsCurrent,
  ]

  return anchorCandidates
    .map((entry) => normalizeLookupValue(entry))
    .filter((entry) => entry.length >= 3)
    .some((entry) => normalizedText.includes(entry))
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
        skill: normalizeSkillName(action.skill)
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
  private readonly npcRelations = new NpcRelationsService()
  private readonly knownNpcs = new KnownNpcsRepo()
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

  private getInventoryItemById(state: GameState, itemId: string): InventoryItem | undefined {
    return (state.player.inventory ?? []).find((item) => item.id === itemId)
  }

  private recomputePlayerCombatStatsFromEquipment(state: GameState): GameState {
    const armorItem = state.player.equippedArmorItemId
      ? this.getInventoryItemById(state, state.player.equippedArmorItemId)
      : undefined
    const shieldItem = state.player.equippedShieldItemId
      ? this.getInventoryItemById(state, state.player.equippedShieldItemId)
      : undefined

    const armorValue = resolveArmorValue(armorItem)
    const parryBonusFromShield = resolveShieldParryBonus(shieldItem)
    const fightingDie = resolveSkillDie(state.player.skills, 'Luta') ?? 0
    const baseParry = calcParry(fightingDie as DieType | 0, state.player.edges)
    const parry = baseParry + parryBonusFromShield
    const toughness = calcToughness(state.player.attributes.vigor, armorValue, state.player.edges, state.player.hindrances)

    return {
      ...state,
      player: {
        ...state.player,
        armor: armorValue,
        parry,
        toughness
      }
    }
  }

  private sanitizeEquippedItemSlots(state: GameState): GameState {
    const inventoryIds = new Set((state.player.inventory ?? []).map((item) => item.id))
    const equippedArmorItem = state.player.equippedArmorItemId
      ? this.getInventoryItemById(state, state.player.equippedArmorItemId)
      : undefined
    const equippedShieldItem = state.player.equippedShieldItemId
      ? this.getInventoryItemById(state, state.player.equippedShieldItemId)
      : undefined

    const equippedAttackItemId = state.player.equippedAttackItemId && inventoryIds.has(state.player.equippedAttackItemId)
      ? state.player.equippedAttackItemId
      : undefined
    const equippedArmorItemId = state.player.equippedArmorItemId
      && inventoryIds.has(state.player.equippedArmorItemId)
      && equippedArmorItem
      && equippedArmorItem.category === 'armor'
      && !isShieldItem(equippedArmorItem)
      ? state.player.equippedArmorItemId
      : undefined
    const equippedShieldItemId = state.player.equippedShieldItemId
      && inventoryIds.has(state.player.equippedShieldItemId)
      && equippedShieldItem
      && equippedShieldItem.category === 'armor'
      && isShieldItem(equippedShieldItem)
      ? state.player.equippedShieldItemId
      : undefined

    if (
      equippedAttackItemId === state.player.equippedAttackItemId
      && equippedArmorItemId === state.player.equippedArmorItemId
      && equippedShieldItemId === state.player.equippedShieldItemId
    ) {
      return state
    }

    return {
      ...state,
      player: {
        ...state.player,
        equippedAttackItemId,
        equippedArmorItemId,
        equippedShieldItemId
      }
    }
  }

  private persistAndReturn(state: GameState): Promise<GameState> {
    return this.snapshots.saveTurnState(state).then(() => state)
  }

  async equipAttackItem(params: { ownerId: string; sessionId: string; itemId: string }): Promise<GameState> {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const state = await this.snapshots.getLatestState(params.sessionId)
    if (!state) throw new NotFoundException('Sessão não encontrada')

    const item = this.getInventoryItemById(state, params.itemId)
    if (!item) throw new NotFoundException('Item não encontrado no inventário')

    const nextState = {
      ...state,
      player: {
        ...state.player,
        equippedAttackItemId: item.id
      }
    }

    return await this.persistAndReturn(nextState)
  }

  async equipArmorItem(params: { ownerId: string; sessionId: string; itemId: string }): Promise<GameState> {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const state = await this.snapshots.getLatestState(params.sessionId)
    if (!state) throw new NotFoundException('Sessão não encontrada')

    const item = this.getInventoryItemById(state, params.itemId)
    if (!item) throw new NotFoundException('Item não encontrado no inventário')
    if (item.category !== 'armor' || isShieldItem(item)) {
      throw new NotFoundException('Item não pode ser equipado como armadura')
    }

    const nextState = this.recomputePlayerCombatStatsFromEquipment({
      ...state,
      player: {
        ...state.player,
        equippedArmorItemId: item.id
      }
    })

    return await this.persistAndReturn(nextState)
  }

  async equipShieldItem(params: { ownerId: string; sessionId: string; itemId: string }): Promise<GameState> {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const state = await this.snapshots.getLatestState(params.sessionId)
    if (!state) throw new NotFoundException('Sessão não encontrada')

    const item = this.getInventoryItemById(state, params.itemId)
    if (!item) throw new NotFoundException('Item não encontrado no inventário')
    if (item.category !== 'armor' || !isShieldItem(item)) {
      throw new NotFoundException('Item não pode ser equipado como escudo')
    }

    const nextState = this.recomputePlayerCombatStatsFromEquipment({
      ...state,
      player: {
        ...state.player,
        equippedShieldItemId: item.id
      }
    })

    return await this.persistAndReturn(nextState)
  }

  async unequipAttackItem(params: { ownerId: string; sessionId: string }): Promise<GameState> {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const state = await this.snapshots.getLatestState(params.sessionId)
    if (!state) throw new NotFoundException('Sessão não encontrada')

    const nextState = {
      ...state,
      player: {
        ...state.player,
        equippedAttackItemId: undefined
      }
    }

    return await this.persistAndReturn(nextState)
  }

  async unequipArmorItem(params: { ownerId: string; sessionId: string }): Promise<GameState> {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const state = await this.snapshots.getLatestState(params.sessionId)
    if (!state) throw new NotFoundException('Sessão não encontrada')

    const nextState = this.recomputePlayerCombatStatsFromEquipment({
      ...state,
      player: {
        ...state.player,
        equippedArmorItemId: undefined
      }
    })

    return await this.persistAndReturn(nextState)
  }

  async unequipShieldItem(params: { ownerId: string; sessionId: string }): Promise<GameState> {
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const state = await this.snapshots.getLatestState(params.sessionId)
    if (!state) throw new NotFoundException('Sessão não encontrada')

    const nextState = this.recomputePlayerCombatStatsFromEquipment({
      ...state,
      player: {
        ...state.player,
        equippedShieldItemId: undefined
      }
    })

    return await this.persistAndReturn(nextState)
  }

  private async buildSessionPayload(sessionId: string) {
    const state = await this.snapshots.getLatestState(sessionId)
    if (!state) throw new NotFoundException('Sessão não encontrada')

    const rawStateNarrativeStyle = (state.meta as Record<string, unknown>).narrativeStyle
    const normalizedNarrativeState = rawStateNarrativeStyle === 'theatrical'
      ? { ...state, meta: { ...state.meta, narrativeStyle: 'balanced' as const } }
      : state
    const normalizedState = this.recomputePlayerCombatStatsFromEquipment(
      this.sanitizeEquippedItemSlots(normalizedNarrativeState)
    )

    const [summary, recentMessages, messages, events, knownNpcs] = await Promise.all([
      this.summaryRepo.getSummary(sessionId),
      this.summaries.getRecentWindow(sessionId),
      this.chatMessages.listBySession(sessionId),
      this.events.listSince({ sessionId, afterTurn: -1 }),
      this.knownNpcs.listByCharacter(normalizedState.player.characterId).catch((error) => {
        warn('buildSessionPayload', `Falha ao carregar NPCs conhecidos: ${String(error)}`)
        return []
      })
    ])
    const context = buildLlmContext({ state: normalizedState, summary, recentMessages })

    return { state: normalizedState, summary, events, context, messages, knownNpcs }
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

    const DOWN_STATUSES = new Set<NonNullable<GameState['npcs'][number]['status']>>(['dead', 'defeated', 'incapacitated'])

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
      const currentStatus = existingNpc.status ?? 'active'
      const requestedStatus = mention.status
      const defeatedByEngine = (state.defeatedNpcIds ?? []).includes(existingNpc.id)

      let nextStatus = currentStatus
      if (requestedStatus) {
        const isResurrectionAttempt =
          (currentStatus === 'dead' && requestedStatus !== 'dead')
          || (defeatedByEngine && !DOWN_STATUSES.has(requestedStatus))

        if (isResurrectionAttempt) {
          warn('syncNarratorNpcs', `Transição de status bloqueada para ${existingNpc.id}: ${currentStatus} -> ${requestedStatus}`)
        } else {
          nextStatus = requestedStatus
        }
      }

      const nextFollowsPlayer = typeof mention.followsPlayer === 'boolean'
        ? mention.followsPlayer
        : existingNpc.followsPlayer

      // Verifica se há mudanças em name/displayName, disposition, status ou followsPlayer
      const hasChanges =
        existingNpc.name !== mentionDisplay ||
        existingNpc.displayName !== mentionDisplay ||
        existingNpc.disposition !== mention.disposition ||
        existingNpc.status !== nextStatus ||
        existingNpc.followsPlayer !== nextFollowsPlayer

      if (!hasChanges) {
        return existingNpc
      }

      changed = true
      return {
        ...existingNpc,
        name: mentionDisplay,
        displayName: mentionDisplay,
        disposition: mention.disposition,
        status: nextStatus,
        followsPlayer: nextFollowsPlayer
      }
    })

    if (allowCreate) {
      for (const npc of npcs) {
        if (knownNpcIds.has(npc.id)) continue
        if ((state.defeatedNpcIds ?? []).includes(npc.id)) {
          warn('syncNarratorNpcs', `Criação bloqueada para NPC derrotado: ${npc.id}`)
          continue
        }
        if (npc.status === 'left') continue

        const created = this.createNarrativeNpcStub(npc, sceneLocation, npcCatalog)
        if (npc.status) created.status = npc.status
        if (typeof npc.followsPlayer === 'boolean') created.followsPlayer = npc.followsPlayer

        mergedNpcs.push(created)
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
    // Acumula NPCs apenas das mensagens da cena atual.
    // Modo conservador: mensagens legadas sem location são ignoradas para evitar
    // vazamento de contexto entre salas após travel.
    const accumulatedNpcs = new Map<string, NarratorTurnResponse['npcs'][number]>()
    let legacyMessagesIgnored = 0
    for (const message of recentMessages) {
      if (message.role === 'narrator' && Array.isArray(message.npcs)) {
        if (!message.location) {
          legacyMessagesIgnored += 1
          continue
        }
        if (message.location === activeLocation) {
          for (const npc of message.npcs) {
            accumulatedNpcs.set(npc.id, npc)
          }
        }
      }
    }

    if (legacyMessagesIgnored > 0) {
      warn(
        'hydrateSceneNpcs',
        `Ignorando ${legacyMessagesIgnored} mensagem(ns) legada(s) sem location para evitar bleed entre cenas`
      )
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
    canonicalAnchors?: CanonicalAnchors,
    action?: PlayerAction
  ): NarratorTurnResponse['options'][number] | null {
    // NPCs derrotados/mortos/incapacitados/fora de cena (left) não são alvos
    // válidos, mesmo que ainda constem na cena neste turno. Excluí-los aqui impede
    // que uma opção de ataque do LLM contra um inimigo já abatido passe na validação
    // (e que o redirecionamento de alvo hostil abaixo escolha um caído).
    const NPC_DOWN_STATUSES = new Set(['dead', 'defeated', 'incapacitated', 'left'])
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
    const diceCheck = option.diceCheck
      ? {
          required: false, // Forçado a false pois rolagens de dados estão desativadas
          successChance: null, // Forçado a null pois rolagens de dados estão desativadas
          reason: option.diceCheck.reason
        }
      : null

    // Perícia/atributo não vêm mais em actionPayload — só em diceCheck (traco já
    // resolvido pelo adapter). Sem checagem redundante de string aqui.
    //
    // Não há mais checagem de itens necessários aqui: pela regra de prompt
    // "AGÊNCIA REAL", o narrador só deve oferecer opções já executáveis — uma opção
    // que dependa de item ausente deve ser substituída na origem, nunca oferecida.

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

        // attack sempre exige resolução
        if (diceCheck) diceCheck.required = true
        break
      }
      case 'trait_test':
      case 'chance_check': {
        // Esses tipos são resolvidos via chanceCheck.successChance pelo buildActionFromOption
        // Sem mudança necessária aqui
        break
      }
      case 'travel': {
        const destination = typeof actionPayload.to === 'string' ? actionPayload.to.trim() : ''
        if (destination && normalizeLookupValue(destination) === normalizeLookupValue(state.worldState.activeLocation)) {
          warn('validateNarratorOption', `Convertendo travel com destino igual ao local atual para custom: "${destination}"`)
          option.actionType = 'custom'
          delete actionPayload.to
          actionPayload.input = option.text.trim()
          if (diceCheck) { diceCheck.required = false; diceCheck.successChance = null }
          break
        }
        if (destination) {
          actionPayload.to = destination
        }
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
        // LLM por vezes gera keys com acento ("porta_fechada_no_cômodo") — slugificar
        // garante identificadores snake_case estáveis para lookup posterior.
        actionPayload.key = key
          .normalize('NFD')
          .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, '_')
          .replace(/^_+|_+$/g, '')
        if (!actionPayload.key) return null
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
      diceCheck
    }
  }

  private validateNarratorItemChanges(
    changes: NarratorTurnResponse['itemChanges'],
    state: GameState,
    mode: 'start' | 'turn',
    action?: PlayerAction
  ): NarratorTurnResponse['itemChanges'] {
    // Categorias empilháveis podem receber "gained" de um item homônimo já
    // possuído (achar mais balas/moedas); duráveis e itens únicos não.
    const STACKABLE_CATEGORIES = new Set(['money', 'ammunition', 'consumable'])

    return changes.filter((change) => {
      if (change.quantity <= 0) return false

      if (mode === 'start') {
        return change.changeType === 'gained'
      }

      if (change.changeType === 'used' && change.category === 'ammunition' && action?.type !== 'attack') {
        warn('validateNarratorItemChanges', `Descartando consumo de munição indevido fora de ataque: "${change.name}"`)
        return false
      }

      if (change.changeType === 'gained') {
        const nameKey = normalizeLookupValue(change.name)
        const existingByName = state.player.inventory?.find((item) => normalizeLookupValue(item.name) === nameKey)
        if (existingByName && !STACKABLE_CATEGORIES.has(change.category ?? existingByName.category ?? '')) {
          warn('validateNarratorItemChanges', `Descartando "gained" duplicado de item já no inventário: "${change.name}"`)
          return false
        }

        // LLM por vezes recicla um itemId de turno anterior para um item diferente;
        // manter a colisão sobrescreveria/mesclaria o item errado no inventário.
        const existingById = state.player.inventory?.find((item) => item.id === change.itemId)
        if (existingById && normalizeLookupValue(existingById.name) !== nameKey) {
          warn('validateNarratorItemChanges', `itemId reciclado pela LLM em "${change.name}" (colidia com "${existingById.name}"): id regenerado`)
          change.itemId = randomUUID()
        }
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
    const options = this.completeValidatedOptions(
      response.options
        .map((option) => this.validateNarratorOption(option, canonicalNarrativeState, mode, canonicalAnchors, action))
        .filter((option): option is NarratorTurnResponse['options'][number] => option !== null)
    )
    const sceneNpcIds = new Set(
      canonicalNarrativeState.npcs
        .filter((npc) => !npc.location || npc.location === canonicalNarrativeState.worldState.activeLocation)
        .filter((npc) => npc.status !== 'left')
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

  async createSession(params: { ownerId: string; campaignId?: string; characterId: string; narrativeStyle?: NarrativeStyle; simpleVocabulary?: boolean }) {
    const [campaign, character] = await Promise.all([
      params.campaignId ? this.campaigns.get(params.campaignId) : Promise.resolve(null),
      this.characters.get(params.characterId)
    ])
    // Campanha é opcional: é possível iniciar um jogo sem selecionar uma campanha.
    if (params.campaignId && !campaign) throw new NotFoundException('Campanha não encontrada')
    if (campaign && campaign.ownerId !== params.ownerId && campaign.visibility !== 'public') {
      throw new NotFoundException('Sem permissão para esta campanha')
    }
    if (!character) throw new NotFoundException('Character não encontrado')
    const characterOwnerId = typeof character.ownerId === 'string' && character.ownerId.trim()
      ? character.ownerId
      : character.userId
    if (characterOwnerId !== params.ownerId) throw new NotFoundException('Sem permissão para este character')
    // Personagem agora pertence ao Mundo (não à Campanha). Invariante: mesmo mundo.
    // Personagens legados sem worldId são tolerados (serão backfillados).
    if (campaign && character.worldId && character.worldId !== campaign.worldId) {
      throw new NotFoundException('Personagem pertence a outro mundo')
    }

    // Sem campanha, o mundo vem do próprio personagem (pode ser inexistente em fichas legadas).
    const campaignId = params.campaignId ?? ''
    const worldId = campaign?.worldId ?? character.worldId
    const resumeParams = { ownerId: params.ownerId, campaignId, characterId: params.characterId }

    const resumeKey = this.buildResumeKey(resumeParams)
    const reusableSessionId = await this.findReusableSessionId(resumeParams)
    if (reusableSessionId) {
      log('createSession', `Retomando sessão existente ${reusableSessionId} para ${resumeKey}`)
      await this.characters.setLastPlayedAt(params.characterId)
      const payload = await this.buildSessionPayload(reusableSessionId)
      return { sessionId: reusableSessionId, ...payload }
    }

    const world = worldId ? await this.worlds.get(worldId) : null

    const sessionId = randomUUID()

    await firestore
      .collection('sessions')
      .doc(sessionId)
      .set({
        sessionId,
        ownerId: params.ownerId,
        campaignId,
        characterId: params.characterId,
        ...(worldId ? { worldId } : {}),
        resumeKey,
        ...(params.narrativeStyle ? { narrativeStyle: params.narrativeStyle } : {}),
        ...(params.simpleVocabulary !== undefined ? { simpleVocabulary: params.simpleVocabulary } : {}),
        status: 'ativo',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
      })

    await this.characters.setLastPlayedAt(params.characterId)

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
      campaignId,
      worldId,
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
              worldGuide: world.worldGuide
            }
          : undefined,
        campaign: campaign
          ? {
              storyDescription: campaign.storyDescription ?? campaign.storyDescriptionEn ?? '',
              name: campaign.name
            }
          : undefined,
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
    state = this.recomputePlayerCombatStatsFromEquipment(
      this.sanitizeEquippedItemSlots(this.inventory.applyItemChanges(state, narratorResponse.itemChanges))
    )
    state = this.statusEffects.applyStatusChanges(state, narratorResponse.statusChanges)

    state = this.syncNarratorNpcs({
      state,
      npcs: narratorResponse.npcs,
      sceneLocation: state.worldState.activeLocation,
      allowCreate: true,
      npcCatalog: world?.npcCatalog
    })

    await this.snapshots.saveTurnState(state)

    await this.npcRelations.syncFromTurn({
      characterId: params.characterId,
      sessionId,
      state,
      mentions: narratorResponse.npcs
    })

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

    // ── Apagar NPCs conhecidos do personagem ──
    await this.npcRelations.deleteAllKnownNpcs(characterId)

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
              worldGuide: world.worldGuide
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

    state = this.recomputePlayerCombatStatsFromEquipment(
      this.sanitizeEquippedItemSlots(this.inventory.applyItemChanges(state, narratorResponse.itemChanges))
    )
    state = this.statusEffects.applyStatusChanges(state, narratorResponse.statusChanges)

    state = this.syncNarratorNpcs({
      state,
      npcs: narratorResponse.npcs,
      sceneLocation: state.worldState.activeLocation,
      allowCreate: true,
      npcCatalog: world?.npcCatalog
    })

    await this.snapshots.saveTurnState(state)

    await this.npcRelations.syncFromTurn({
      characterId,
      sessionId: params.sessionId,
      state,
      mentions: narratorResponse.npcs
    })

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
        sceneObjectsCurrent: context.stateBrief.sceneObjectsCurrent,
        inventory: context.stateBrief.inventory,
        equippedItems: context.stateBrief.equippedItems,
        activeStatusEffects: context.stateBrief.activeStatusEffects,
        playerSkills: context.stateBrief.playerSkills,
        rulesDigest: this.buildStrictRulesDigest(context.rulesDigest, canonicalAnchors, buildCanonicalFactsPromptSection(canonicalFacts))
      },
      recentMessages: context.recentMessages
    })

    // Forçar desativação de rolagens/testes de ação
    if (validation.diceCheck) {
      validation.diceCheck.required = false
      validation.diceCheck.successChance = null
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
      playerInput: actionDescription,
      location: result.nextState.worldState.activeLocation
    })

    const diceEvents = result.emittedEvents.filter(
      (e) => e.type === 'chance_check_result' || e.type === 'trait_test' || e.type === 'attack_hit' || e.type === 'attack_miss' || e.type === 'soak_roll' || e.type === 'recover_shaken' || e.type === 'recover_shaken_failed' || e.type === 'heal_success' || e.type === 'heal_failure'
    )

    let systemMessage: ChatMessageRow | null = null
    if (diceEvents.length > 0) {
      systemMessage = await this.chatMessages.appendAndGet({
        sessionId: params.sessionId,
        turn: result.nextState.meta.turn,
        role: 'system',
        engineEvents: diceEvents.map((e) => ({ type: e.type, payload: e.payload })),
        location: result.nextState.worldState.activeLocation
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
              worldGuide: worldDoc.worldGuide
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
          sceneObjectsCurrent: context.stateBrief.sceneObjectsCurrent,
          inventory: context.stateBrief.inventory,
          equippedItems: context.stateBrief.equippedItems,
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
    finalState = this.recomputePlayerCombatStatsFromEquipment(
      this.sanitizeEquippedItemSlots(this.inventory.applyItemChanges(finalState, dedupedItemChanges))
    )
    finalState = this.statusEffects.applyStatusChanges(finalState, narratorResponse.statusChanges, { action: normalizedAction })
    finalState = this.statusEffects.tickEffects(finalState)
    finalState = this.statusEffects.applyNarrativeRecovery(finalState, {
      actionText: actionDescription,
      narrative: segmentsToText(narratorResponse.segments)
    })
    finalState = this.syncNarratorNpcs({
      state: finalState,
      npcs: narratorResponse.npcs,
      sceneLocation: finalState.worldState.activeLocation,
      allowCreate: true,
      npcCatalog: worldDoc?.npcCatalog
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
        (n) =>
          n.id === entry.npcId
          && (!n.location || n.location === finalState.worldState.activeLocation)
          && n.status !== 'left'
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
        sceneNpc.status === 'dead' ||
        sceneNpc.status === 'left'
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
        engineEvents: npcAttackEvents.map((e) => ({ type: e.type, payload: e.payload as Record<string, unknown> })),
        location: finalState.worldState.activeLocation
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
        diceCheck: o.diceCheck ? {
          successChance: o.diceCheck.successChance ?? undefined,
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

    await this.npcRelations.syncFromTurn({
      characterId: finalState.player.characterId,
      sessionId: params.sessionId,
      state: finalState,
      mentions: narratorResponse.npcs
    })

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

    // Montar o PlayerAction a partir da opção
    const action = this.buildActionFromOption(option)
    return { action, displayText: option.text }
  }

  private buildActionFromOption(option: { actionType: string; actionPayload: Record<string, unknown>; text: string; diceCheck?: { required: boolean; successChance?: number | null; reason?: string } | null }): PlayerAction {
    const payload = option.actionPayload ?? {}
    const dc = option.diceCheck

    // Se a ação requer resolução por chance (chance_check ou qualquer ação com required=true)
    // DESATIVADO: Rolagens de dados automáticas estão desativadas. O LLM decide de forma narrativa.
    /*
    if (dc?.required) {
      const successChance = typeof dc.successChance === 'number' ? dc.successChance : 50
      const roll = Math.random() * 100
      const success = roll < successChance
      log('buildActionFromOption', `chance_check: successChance=${successChance}% roll=${roll.toFixed(1)} → ${success ? 'SUCESSO' : 'FALHA'} (reason=${dc.reason})`)
      return {
        type: 'chance_check',
        success,
        chance: successChance,
        roll,
        reason: dc.reason ?? '',
        description: option.text
      }
    }
    */


    switch (option.actionType) {
      case 'chance_check':
      case 'trait_test':
        // Sem required=true: trata como ação narrativa livre
        return { type: 'custom', input: typeof payload.input === 'string' ? payload.input : option.text }
      case 'attack':
        return {
          type: 'attack',
          skill: 'Luta',
          targetId: typeof payload.targetId === 'string' ? payload.targetId : 'unknown',
          modifier: 0
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
          modifier: 0
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
    const updated = this.recomputePlayerCombatStatsFromEquipment(this.sanitizeEquippedItemSlots(this.inventory.applyItemChanges(state, [
      { itemId: params.itemId, name: item.name, quantity: qty, changeType: 'lost' }
    ])))

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
        const skillLabel = normalizeSkillName(action.skill)
        return skillLabel
          ? `Ataque contra ${action.targetId} usando ${skillLabel}${calledShotLabel}`
          : `Ataque contra ${action.targetId} (sem perícia de combate informada)${calledShotLabel}`
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
