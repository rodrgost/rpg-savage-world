import { onCall, HttpsError } from 'firebase-functions/v2/https'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'

import { CampaignsRepo } from './repositories/campaigns.repo.js'
import { CharactersRepo } from './repositories/characters.repo.js'
import { SessionsRepo } from './repositories/sessions.repo.js'
import { RuleSetsRepo } from './repositories/ruleSets.repo.js'
import { WorldsRepo } from './repositories/worlds.repo.js'
import { SessionEventRepo } from './repositories/sessionEvent.repo.js'
import { SessionSummaryRepo } from './repositories/sessionSummary.repo.js'
import { SnapshotService } from './services/snapshot.service.js'
import { SummaryService } from './services/summary.service.js'
import { buildLlmContext } from './services/contextBuilder.js'
import { createInitialState } from './domain/defaults/initialState.js'
import type { PlayerAction } from './domain/types/gameState.js'
import { resolveAction } from './engine/resolution/resolveAction.js'

function requireAuth(auth: unknown): asserts auth is { uid: string } {
  if (!auth || typeof (auth as any).uid !== 'string') {
    throw new HttpsError('unauthenticated', 'É necessário estar autenticado.')
  }
}

const CreateCampaignInput = z.object({
  worldId: z.string().min(1),
  thematic: z.string().min(1),
  storyDescription: z.string().optional()
})

export const createCampaign = onCall(async (req) => {
  requireAuth(req.auth)
  const input = CreateCampaignInput.parse(req.data)

  const world = await new WorldsRepo().get(input.worldId)
  if (!world) throw new HttpsError('not-found', 'Mundo não encontrado')
  if (world.ownerId !== req.auth.uid) throw new HttpsError('permission-denied', 'Sem permissão para este mundo')

  const campaignId = randomUUID()
  await new CampaignsRepo().create({
    campaignId,
    worldId: input.worldId,
    ownerId: req.auth.uid,
    thematic: input.thematic,
    storyDescription: input.storyDescription?.trim() ?? ''
  })

  return { campaignId }
})

const UpsertRuleSetInput = z.object({
  ruleSetId: z.string().min(1).optional(),
  name: z.string().min(1),
  system: z.string().min(1).optional(),
  rulesJson: z.record(z.string(), z.any())
})

export const upsertRuleSet = onCall(async (req) => {
  requireAuth(req.auth)
  const input = UpsertRuleSetInput.parse(req.data)
  const ruleSetId = input.ruleSetId ?? randomUUID()
  const system = input.system?.trim() || input.name

  await new RuleSetsRepo().upsert({
    ruleSetId,
    name: input.name,
    system,
    rulesJson: input.rulesJson
  })

  return { ok: true, ruleSetId }
})

export const listRuleSets = onCall(async () => {
  const ruleSets = await new RuleSetsRepo().listAll()
  return { ruleSets }
})

const CreateCharacterInput = z.object({
  campaignId: z.string().min(1),
  name: z.string().min(1),
  attributes: z.record(z.string(), z.number()).default({})
})

export const createCharacter = onCall(async (req) => {
  requireAuth(req.auth)
  const input = CreateCharacterInput.parse(req.data)

  const campaign = await new CampaignsRepo().get(input.campaignId)
  if (!campaign) throw new HttpsError('not-found', 'Campanha não encontrada')
  if (campaign.ownerId !== req.auth.uid) throw new HttpsError('permission-denied', 'Sem permissão para esta campanha')

  const characterId = randomUUID()
  await new CharactersRepo().create({
    characterId,
    campaignId: input.campaignId,
    worldId: campaign.worldId,
    userId: req.auth.uid,
    name: input.name,
    attributes: input.attributes
  })

  return { characterId }
})

const CreateWorldInput = z.object({
  ruleSetId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional().default(''),
  lore: z.string().optional().default('')
})

export const createWorld = onCall(async (req) => {
  requireAuth(req.auth)
  const input = CreateWorldInput.parse(req.data)

  const ruleSet = await new RuleSetsRepo().get(input.ruleSetId)
  if (!ruleSet) throw new HttpsError('not-found', 'Regra/Mod não encontrado')

  const worldId = randomUUID()
  await new WorldsRepo().create({
    worldId,
    ownerId: req.auth.uid,
    ruleSetId: input.ruleSetId,
    name: input.name,
    description: input.description,
    lore: input.lore
  })

  return { worldId }
})

export const listWorlds = onCall(async (req) => {
  requireAuth(req.auth)

  const worlds = await new WorldsRepo().listByOwner({ ownerId: req.auth.uid })
  return { worlds }
})

const DeleteWorldInput = z.object({
  worldId: z.string().min(1)
})

export const deleteWorld = onCall(async (req) => {
  requireAuth(req.auth)
  const input = DeleteWorldInput.parse(req.data)

  const world = await new WorldsRepo().get(input.worldId)
  if (!world) throw new HttpsError('not-found', 'Mundo não encontrado')
  if (world.ownerId !== req.auth.uid) throw new HttpsError('permission-denied', 'Sem permissão para este mundo')

  await new WorldsRepo().delete(input.worldId)
  return { ok: true }
})

// ─── Campaigns (list / delete) ──────────────────────────────────

const ListCampaignsInput = z
  .object({
    worldId: z.string().min(1).optional()
  })
  .default({})

export const listCampaigns = onCall(async (req) => {
  requireAuth(req.auth)
  const input = ListCampaignsInput.parse(req.data ?? {})

  const campaigns = await new CampaignsRepo().listByOwner({ ownerId: req.auth.uid, worldId: input.worldId })
  return { campaigns }
})

const DeleteCampaignInput = z.object({
  campaignId: z.string().min(1)
})

export const deleteCampaign = onCall(async (req) => {
  requireAuth(req.auth)
  const input = DeleteCampaignInput.parse(req.data)

  const campaign = await new CampaignsRepo().get(input.campaignId)
  if (!campaign) throw new HttpsError('not-found', 'Campanha não encontrada')
  if (campaign.ownerId !== req.auth.uid) throw new HttpsError('permission-denied', 'Sem permissão para esta campanha')

  await new CampaignsRepo().delete(input.campaignId)
  return { ok: true }
})

// ─── Sessions ──────────────────────────────────

const StartSessionInput = z.object({
  characterId: z.string().min(1),
  campaignId: z.string().min(1)
})

export const startSession = onCall(async (req) => {
  requireAuth(req.auth)
  const input = StartSessionInput.parse(req.data)

  const campaign = await new CampaignsRepo().get(input.campaignId)
  if (!campaign) throw new HttpsError('not-found', 'Campanha não encontrada')
  if (campaign.ownerId !== req.auth.uid) throw new HttpsError('permission-denied', 'Sem permissão para esta campanha')

  const character = await new CharactersRepo().get(input.characterId)
  if (!character) throw new HttpsError('not-found', 'Character não encontrado')
  if (character.userId !== req.auth.uid) throw new HttpsError('permission-denied', 'Sem permissão para este character')
  if (character.campaignId !== input.campaignId) throw new HttpsError('failed-precondition', 'Character não pertence a esta campanha')

  const sessionId = randomUUID()
  await new SessionsRepo().create({
    sessionId,
    campaignId: input.campaignId,
    ownerId: req.auth.uid,
    characterId: input.characterId,
    worldId: campaign.worldId
  })

  const initial = createInitialState({
    sessionId,
    campaignId: input.campaignId,
    characterId: input.characterId,
    worldId: campaign.worldId
  })

  // Merge atributos do character (dinâmicos)
  initial.player.attributes = { ...initial.player.attributes, ...character.attributes }

  const snapshots = new SnapshotService()
  await snapshots.saveTurnState(initial)

  await new SessionSummaryRepo().upsertSummary({ sessionId, lastTurnIncluded: 0, summaryText: '', keyEvents: [] })

  return { sessionId, state: initial }
})

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('travel'), to: z.string().min(1) }),
  z.object({ type: z.literal('flag'), key: z.string().min(1), value: z.boolean() }),
  z.object({ type: z.literal('damage'), amount: z.number().int().min(0) }),
  z.object({ type: z.literal('custom'), input: z.string().min(1) })
])

const ExecuteActionInput = z.object({
  sessionId: z.string().min(1),
  action: ActionSchema
})

export const executeAction = onCall(async (req) => {
  requireAuth(req.auth)
  const input = ExecuteActionInput.parse(req.data)

  const session = await new SessionsRepo().get(input.sessionId)
  if (!session) throw new HttpsError('not-found', 'Sessão não encontrada')
  if (session.ownerId !== req.auth.uid) throw new HttpsError('permission-denied', 'Sem permissão para esta sessão')

  const snapshots = new SnapshotService()
  const current = await snapshots.getLatestState(input.sessionId)
  if (!current) throw new HttpsError('not-found', 'Sessão não encontrada')

  const result = resolveAction(current, input.action as PlayerAction)

  const eventRepo = new SessionEventRepo()
  for (const ev of result.emittedEvents) {
    await eventRepo.append({
      sessionId: input.sessionId,
      turn: result.nextState.meta.turn,
      type: ev.type,
      payload: ev.payload
    })
  }

  await snapshots.saveTurnState(result.nextState)

  const summarySvc = new SummaryService()
  await summarySvc.maybeUpdateSummary({ state: result.nextState })

  const summary = await new SessionSummaryRepo().getSummary(input.sessionId)
  const context = buildLlmContext({ state: result.nextState, summary })

  return {
    state: result.nextState,
    emittedEvents: result.emittedEvents,
    summary,
    context
  }
})
