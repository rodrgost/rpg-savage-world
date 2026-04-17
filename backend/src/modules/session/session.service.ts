import { Injectable, NotFoundException } from '@nestjs/common'
import { createInitialState } from '../../domain/defaults/initialState.js'
import type { DieType, GameState, Hindrance, PlayerAction, SWAttributes } from '../../domain/types/gameState.js'
import type { NarratorTurnResponse } from '../../domain/types/narrative.js'
import { applyAction } from '../../core/rule-engine.js'
import { SnapshotService } from '../../services/snapshot.service.js'
import { SummaryService } from '../../services/summary.service.js'
import { InventoryService } from '../../services/inventory.service.js'
import { StatusEffectService } from '../../services/statusEffect.service.js'
import { SessionEventRepo } from '../../repositories/sessionEvent.repo.js'
import { SessionSummaryRepo } from '../../repositories/sessionSummary.repo.js'
import { ChatMessageRepo, type ChatMessageRow } from '../../repositories/chatMessage.repo.js'
import { buildLlmContext } from '../../services/contextBuilder.js'
import { firestore, FieldValue } from '../../infrastructure/firebase.js'
import { randomUUID } from 'node:crypto'
import { WorldsRepo } from '../../repositories/worlds.repo.js'
import { CampaignsRepo } from '../../repositories/campaigns.repo.js'
import { CharactersRepo } from '../../repositories/characters.repo.js'
import { isDieType } from '../../domain/savage-worlds/constants.js'
import type { Narrator } from '../../llm/narrator.js'
import { GeminiAdapter } from '../../llm/gemini.adapter.js'
import { log, warn } from '../../utils/file-logger.js'

type SessionDocData = Record<string, unknown>
type SessionDocSnapshot = FirebaseFirestore.QueryDocumentSnapshot<FirebaseFirestore.DocumentData>
type ReusableSessionCandidate = {
  sessionId: string
  latestTurn: number
  createdAtMillis: number
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
  private readonly worlds = new WorldsRepo()
  private readonly campaigns = new CampaignsRepo()
  private readonly characters = new CharactersRepo()
  private readonly chatMessages = new ChatMessageRepo()
  private readonly inventory = new InventoryService()
  private readonly statusEffects = new StatusEffectService()
  private readonly narrator: Narrator = new GeminiAdapter()

  private async requireOwnedSession(sessionId: string, ownerId: string): Promise<Record<string, unknown>> {
    const sessionSnap = await firestore.collection('sessions').doc(sessionId).get()
    if (!sessionSnap.exists) throw new NotFoundException('Sessão não encontrada')

    const sessionData = sessionSnap.data() as Record<string, unknown>
    if (sessionData.ownerId !== ownerId) throw new NotFoundException('Sem permissão')
    return sessionData
  }

  private async buildSessionPayload(sessionId: string) {
    const state = await this.snapshots.getLatestState(sessionId)
    if (!state) throw new NotFoundException('Sessão não encontrada')

    const summary = await this.summaryRepo.getSummary(sessionId)
    const recentMessages = await this.chatMessages.getRecent(sessionId, 20)
    const messages = await this.chatMessages.listBySession(sessionId)
    const events = await this.events.listSince({ sessionId, afterTurn: -1 })
    const context = buildLlmContext({ state, summary, recentMessages })

    return { state, summary, events, context, messages }
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

  async createSession(params: { ownerId: string; campaignId: string; characterId: string }) {
    const campaign = await this.campaigns.get(params.campaignId)
    if (!campaign) throw new NotFoundException('Campanha não encontrada')
    if (campaign.ownerId !== params.ownerId && campaign.visibility !== 'public') {
      throw new NotFoundException('Sem permissão para esta campanha')
    }

    const character = await this.characters.get(params.characterId)
    if (!character) throw new NotFoundException('Character não encontrado')
    const characterOwnerId = typeof character.ownerId === 'string' && character.ownerId.trim()
      ? character.ownerId
      : character.userId
    if (characterOwnerId !== params.ownerId) throw new NotFoundException('Sem permissão para este character')
    if (character.campaignId !== params.campaignId) throw new NotFoundException('Character não pertence a esta campanha')

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
        createdAt: FieldValue.serverTimestamp()
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
      character: {
        characterId: params.characterId,
        attributes: swAttributes,
        skills,
        edges,
        hindrances,
        armor
      }
    })

    // ── Chamar LLM para narrativa inicial ──
    const narratorResponse = await this.narrator.narrateStart({
      world: world
        ? { name: world.name, description: world.description, lore: world.lore }
        : undefined,
      campaign: {
        thematic: campaign.thematic ?? '',
        storyDescription: campaign.storyDescription ?? '',
        name: campaign.name
      },
      character: {
        name: character.name ?? 'Aventureiro',
        characterClass: character.characterClass,
        profession: character.profession,
        race: character.race,
        gender: character.gender,
        description: character.description,
        edges,
        hindrances: hindrances.map((h) => ({ name: h.name, severity: h.severity }))
      }
    })

    // Aplicar itens e status narrativos ao estado
    state = this.inventory.applyItemChanges(state, narratorResponse.itemChanges)
    state = this.statusEffects.applyStatusChanges(state, narratorResponse.statusChanges)

    // Aplicar mudança de localização se houver
    if (narratorResponse.locationChange) {
      state = {
        ...state,
        worldState: {
          ...state.worldState,
          activeLocation: narratorResponse.locationChange
        }
      }
    }

    await this.snapshots.saveTurnState(state)

    await this.summaryRepo.upsertSummary({
      sessionId,
      lastTurnIncluded: 0,
      summaryText: '',
      historySummaryText: '',
      keyEvents: []
    })

    // Salvar mensagem do narrador no chat
    await this.chatMessages.append({
      sessionId,
      turn: 0,
      role: 'narrator',
      narrative: narratorResponse.narrative,
      options: narratorResponse.options,
      npcs: narratorResponse.npcs,
      itemChanges: narratorResponse.itemChanges,
      statusChanges: narratorResponse.statusChanges
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

    // ── Apagar subcollections ──
    const subcollections = ['messages', 'snapshots', 'events', '_meta']
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
      character: {
        characterId,
        attributes: swAttributes,
        skills,
        edges,
        hindrances,
        armor
      }
    })

    // ── Chamar LLM para nova narrativa inicial ──
    const narratorResponse = await this.narrator.narrateStart({
      world: world
        ? { name: world.name, description: world.description, lore: world.lore }
        : undefined,
      campaign: campaign
        ? {
            thematic: campaign.thematic ?? '',
            storyDescription: campaign.storyDescription ?? '',
            name: campaign.name
          }
        : { thematic: '', storyDescription: '' },
      character: {
        name: character.name ?? 'Aventureiro',
        characterClass: character.characterClass,
        profession: character.profession,
        race: character.race,
        gender: character.gender,
        description: character.description,
        edges,
        hindrances: hindrances.map((h) => ({ name: h.name, severity: h.severity }))
      }
    })

    state = this.inventory.applyItemChanges(state, narratorResponse.itemChanges)
    state = this.statusEffects.applyStatusChanges(state, narratorResponse.statusChanges)

    if (narratorResponse.locationChange) {
      state = {
        ...state,
        worldState: {
          ...state.worldState,
          activeLocation: narratorResponse.locationChange
        }
      }
    }

    await this.snapshots.saveTurnState(state)

    await this.summaryRepo.upsertSummary({
      sessionId: params.sessionId,
      lastTurnIncluded: 0,
      summaryText: '',
      historySummaryText: '',
      keyEvents: []
    })

    await this.chatMessages.append({
      sessionId: params.sessionId,
      turn: 0,
      role: 'narrator',
      narrative: narratorResponse.narrative,
      options: narratorResponse.options,
      npcs: narratorResponse.npcs,
      itemChanges: narratorResponse.itemChanges,
      statusChanges: narratorResponse.statusChanges
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
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const current = await this.snapshots.getLatestState(params.sessionId)
    if (!current) throw new NotFoundException('Sessão não encontrada')

    const summary = await this.summaryRepo.getSummary(params.sessionId)
    const recentMessages = await this.chatMessages.getRecent(params.sessionId, 10)
    const context = buildLlmContext({ state: current, summary, recentMessages })

    return await this.narrator.validateAction({
      input: params.input,
      context: {
        summaryText: context.summaryText,
        location: context.stateBrief.location,
        wounds: context.stateBrief.wounds,
        fatigue: context.stateBrief.fatigue,
        isShaken: context.stateBrief.isShaken,
        bennies: context.stateBrief.bennies,
        npcsPresent: context.stateBrief.npcsPresent,
        inventory: context.stateBrief.inventory,
        activeStatusEffects: context.stateBrief.activeStatusEffects,
        playerSkills: context.stateBrief.playerSkills,
        rulesDigest: context.rulesDigest
      },
      recentMessages: context.recentMessages
    })
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
    await this.requireOwnedSession(params.sessionId, params.ownerId)
    const current = await this.snapshots.getLatestState(params.sessionId)
    if (!current) throw new NotFoundException('Sessão não encontrada')

    // 1. Aplicar mecânicas do rule-engine
    const result = applyAction(current, params.action)

    for (const ev of result.emittedEvents) {
      await this.events.append({
        sessionId: params.sessionId,
        turn: result.nextState.meta.turn,
        type: ev.type,
        payload: ev.payload
      })
    }

    // 2. Salvar mensagem do jogador
    const actionDescription = params.displayText || this.describeAction(params.action)
    const playerMessage = await this.chatMessages.appendAndGet({
      sessionId: params.sessionId,
      turn: result.nextState.meta.turn,
      role: 'player',
      playerInput: actionDescription
    })

    // 2.5 Salvar resultados de dados como mensagem de sistema (persistente no chat)
    const diceEvents = result.emittedEvents.filter(
      (e) => e.type === 'trait_test' || e.type === 'attack_hit' || e.type === 'attack_miss' || e.type === 'soak_roll' || e.type === 'recover_shaken'
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
      onEngineComplete({
        state: result.nextState,
        messages: intermediateMessages,
        diceEvents: diceEvents.map((e) => ({ type: e.type, payload: e.payload }))
      })
    }

    // 3. Buscar contexto para a LLM
    const summary = await this.summaryRepo.getSummary(params.sessionId)
    const recentMessages = await this.chatMessages.getRecent(params.sessionId, 10)
    const context = buildLlmContext({ state: result.nextState, summary, recentMessages })

    // 3.5 Buscar dados da campanha e do mundo para injetar no systemInstruction
    const campaignDoc = result.nextState.meta.campaignId
      ? await this.campaigns.get(result.nextState.meta.campaignId)
      : null
    const worldDoc = result.nextState.meta.worldId
      ? await this.worlds.get(result.nextState.meta.worldId)
      : (campaignDoc ? await this.worlds.get(campaignDoc.worldId) : null)

    // 4. Chamar LLM para narrativa do turno
    let narratorResponse = await this.narrator.narrateTurn({
      playerAction: {
        type: params.action.type,
        description: actionDescription
      },
      engineEvents: result.emittedEvents,
      world: worldDoc
        ? { name: worldDoc.name, description: worldDoc.description, lore: worldDoc.lore }
        : undefined,
      campaign: campaignDoc
        ? { name: campaignDoc.name, thematic: campaignDoc.thematic, storyDescription: campaignDoc.storyDescription }
        : undefined,
      context: {
        summaryText: context.summaryText,
        location: context.stateBrief.location,
        wounds: context.stateBrief.wounds,
        fatigue: context.stateBrief.fatigue,
        isShaken: context.stateBrief.isShaken,
        bennies: context.stateBrief.bennies,
        npcsPresent: context.stateBrief.npcsPresent,
        inventory: context.stateBrief.inventory,
        activeStatusEffects: context.stateBrief.activeStatusEffects,
        playerSkills: context.stateBrief.playerSkills,
        rulesDigest: context.rulesDigest
      },
      recentMessages: context.recentMessages
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
    finalState = this.statusEffects.applyStatusChanges(finalState, narratorResponse.statusChanges)
    finalState = this.statusEffects.tickEffects(finalState)

    if (narratorResponse.locationChange) {
      finalState = {
        ...finalState,
        worldState: {
          ...finalState.worldState,
          activeLocation: narratorResponse.locationChange
        }
      }
    }

    // 6. Salvar estado final e mensagem do narrador
    await this.snapshots.saveTurnState(finalState)
    await this.summaries.maybeUpdateSummary({ state: finalState })

    await this.chatMessages.append({
      sessionId: params.sessionId,
      turn: finalState.meta.turn,
      role: 'narrator',
      narrative: narratorResponse.narrative,
      options: narratorResponse.options,
      npcs: narratorResponse.npcs,
      itemChanges: narratorResponse.itemChanges,
      statusChanges: narratorResponse.statusChanges
    })

    // 7. Resumir histórico se acumulou >= 20 mensagens
    await this.summaries.maybeSummarizeHistory({
      sessionId: params.sessionId,
      currentLocation: finalState.worldState.activeLocation
    })

    const payload = await this.buildSessionPayload(params.sessionId)
    return { ...payload, narratorResponse }
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

  private buildActionFromOption(option: { actionType: string; actionPayload: Record<string, unknown>; text: string; diceCheck?: { required: boolean; skill?: string | null; attribute?: string | null; modifier?: number; tn?: number; reason?: string } | null }): PlayerAction {
    const payload = option.actionPayload ?? {}
    const dc = option.diceCheck

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
      log('buildActionFromOption', `Promoting "${option.actionType}" → trait_test via diceCheck (skill=${skill}, attr=${attribute}, mod=${dc.modifier ?? 0}, reason=${dc.reason})`)
      return {
        type: 'trait_test',
        skill,
        attribute,
        modifier: dc.modifier ?? 0,
        description: option.text
      }
    }

    switch (option.actionType) {
      case 'trait_test':
        return {
          type: 'trait_test',
          skill: dc?.skill ?? (typeof payload.skill === 'string' ? payload.skill : undefined),
          attribute: dc?.attribute ?? (typeof payload.attribute === 'string' ? payload.attribute : undefined),
          modifier: dc?.modifier ?? (typeof payload.modifier === 'number' ? payload.modifier : 0),
          description: option.text
        }
      case 'attack':
        return {
          type: 'attack',
          skill: dc?.skill ?? (typeof payload.skill === 'string' ? payload.skill : 'Lutar'),
          targetId: typeof payload.targetId === 'string' ? payload.targetId : 'unknown',
          modifier: dc?.modifier ?? (typeof payload.modifier === 'number' ? payload.modifier : 0),
          damageFormula: typeof payload.damageFormula === 'string' ? payload.damageFormula : undefined,
          ap: typeof payload.ap === 'number' ? payload.ap : 0
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
      if (inventoryNames.has(nameKey)) {
        warn('deduplicateItemChanges', `Item já no inventário, ignorando gained: "${c.name}"`)
        return false
      }
      if (recentGainedNames.has(nameKey)) {
        warn('deduplicateItemChanges', `Item já concedido recentemente, ignorando: "${c.name}"`)
        return false
      }
      return true
    })
  }

  /**
   * Remove (ou decrementa) um item do inventário do jogador.
   * Salva o snapshot atualizado.
   */
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
        return `Teste de ${action.skill ?? action.attribute ?? 'perícia'}${action.description ? ` — ${action.description}` : ''}`
      case 'attack':
        return `Ataque contra ${action.targetId} usando ${action.skill ?? 'Lutar'}`
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
      default:
        return 'Ação desconhecida'
    }
  }
}
