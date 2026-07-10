import { getAuthenticatedIdToken } from './firebase'
import type { Campaign, Character, ChatMessage, GameState, Hindrance, NarratorTurnResponse, OwnerProfile, SessionEvent, StoryCharacter, SummaryDoc, Visibility, World } from '../types'

type StoredImage = {
  mimeType: string
  base64: string
}

type SessionPayload = {
  state: GameState
  summary: SummaryDoc | null
  context: unknown
  events: Array<{ id: string; turn: number; type: string; payload: Record<string, unknown> }>
  messages: ChatMessage[]
  narratorResponse?: NarratorTurnResponse
}

class ApiStreamError extends Error {}

function normalizeEnvValue(value: unknown): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.replace(/^"(.*)"$/, '$1')
}

function getErrorMessage(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const record = data as Record<string, unknown>
  if (typeof record.message === 'string') {
    return record.message
  }
  return null
}

// Em produção (Railway), VITE_BACKEND_URL não é definida → string vazia → URLs relativas (same-origin).
// Em dev local, VITE_BACKEND_URL=http://localhost:3100 vem do .env da raiz.
const backendBaseUrl = normalizeEnvValue(import.meta.env.VITE_BACKEND_URL)

async function buildAuthHeaders(initHeaders?: HeadersInit): Promise<Headers> {
  const idToken = await getAuthenticatedIdToken()
  const headers = new Headers(initHeaders)
  headers.set('Content-Type', 'application/json')
  headers.set('Authorization', `Bearer ${idToken}`)
  return headers
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await buildAuthHeaders(init?.headers)

  const response = await fetch(`${backendBaseUrl}${path}`, {
    ...init,
    headers
  })

  const raw = await response.text()
  const data = raw ? (JSON.parse(raw) as unknown) : null

  if (!response.ok) {
    const message = getErrorMessage(data) || raw || `Erro HTTP ${response.status}`
    throw new Error(message)
  }

  return data as T
}

/**
 * Faz uma chamada NDJSON streamed: lê linhas JSON conforme chegam.
 * Chama `onPhase` para cada linha parseada.
 * Retorna a última linha (que deve ser o payload final com narração).
 */
async function apiStreamRequest<T>(
  path: string,
  body: unknown,
  onPhase: (data: Record<string, unknown>) => void,
  signal?: AbortSignal
): Promise<T> {
  const headers = await buildAuthHeaders()

  const response = await fetch(`${backendBaseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  })

  if (!response.ok) {
    const raw = await response.text()
    let message = `Erro HTTP ${response.status}`
    try {
      const parsed = JSON.parse(raw)
      message = getErrorMessage(parsed) ?? message
    } catch { /* ignore */ }
    throw new Error(message)
  }

  if (!response.body) throw new Error('Resposta sem stream — corpo da resposta é nulo')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastResult: T | null = null

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const data = JSON.parse(line) as Record<string, unknown>
        if (data.phase === 'engine' || data.phase === 'narration' || data.phase === 'error') {
          console.debug('[apiStreamRequest]', {
            path,
            phase: data.phase,
            turn: (data.state as { meta?: { turn?: number } } | undefined)?.meta?.turn,
            messages: Array.isArray(data.messages) ? data.messages.length : 0,
            diceEvents: Array.isArray(data.diceEvents) ? data.diceEvents.length : 0,
            hasNarratorResponse: Boolean(data.narratorResponse)
          })
        }
        if (data.phase === 'error') {
          throw new ApiStreamError(getErrorMessage(data) ?? 'Erro no servidor')
        }
        onPhase(data)
        lastResult = data as T
      } catch (e) {
        if (e instanceof ApiStreamError) throw e
        console.warn('[apiStreamRequest] Failed to parse NDJSON line:', line)
      }
    }
  }

  // Process remaining buffer
  if (buffer.trim()) {
    try {
      const data = JSON.parse(buffer) as Record<string, unknown>
      if (data.phase === 'engine' || data.phase === 'narration' || data.phase === 'error') {
        console.debug('[apiStreamRequest]', {
          path,
          phase: data.phase,
          turn: (data.state as { meta?: { turn?: number } } | undefined)?.meta?.turn,
          messages: Array.isArray(data.messages) ? data.messages.length : 0,
          diceEvents: Array.isArray(data.diceEvents) ? data.diceEvents.length : 0,
          hasNarratorResponse: Boolean(data.narratorResponse)
        })
      }
      if (data.phase === 'error') {
        throw new ApiStreamError(getErrorMessage(data) ?? 'Erro no servidor')
      }
      onPhase(data)
      lastResult = data as T
    } catch (e) {
      if (e instanceof ApiStreamError) throw e
    }
  }

  if (!lastResult) throw new Error('Nenhuma resposta do servidor')
  return lastResult
}

function normalizeVisibility(value: unknown): Visibility {
  return value === 'public' ? 'public' : 'private'
}

function mapStoredImage(image?: { mimeType?: string; base64?: string }) {
  return image?.mimeType && image?.base64
    ? { mimeType: image.mimeType, base64: image.base64 }
    : undefined
}

function mapOwnerProfile(profile?: { uid?: string; displayName?: string; photoUrl?: string }): OwnerProfile | undefined {
  if (!profile?.uid) return undefined

  return {
    uid: profile.uid,
    displayName: profile.displayName?.trim() || `Jogador ${profile.uid.slice(0, 8)}`,
    photoUrl: profile.photoUrl || undefined
  }
}

function mapWorldRecord(item: {
  id: string
  ownerId?: string
  ownerProfile?: { uid?: string; displayName?: string; photoUrl?: string }
  visibility?: Visibility
  name?: string
  description?: string
  lore?: string
  narrativeStyleGuide?: string
  ruleSetId?: string
  image?: { mimeType?: string; base64?: string }
}): World {
  return {
    id: item.id,
    ownerId: item.ownerId ?? '',
    ownerProfile: mapOwnerProfile(item.ownerProfile),
    visibility: normalizeVisibility(item.visibility),
    name: item.name ?? '',
    description: item.description ?? '',
    lore: item.lore ?? '',
    narrativeStyleGuide: item.narrativeStyleGuide ?? '',
    ruleSetId: item.ruleSetId ?? 'savage-worlds',
    image: mapStoredImage(item.image)
  }
}

function mapCampaignRecord(item: {
  id: string
  worldId: string
  ownerId?: string
  ownerProfile?: { uid?: string; displayName?: string; photoUrl?: string }
  visibility?: Visibility
  name?: string
  storyDescription?: string
  storyDescriptionEn?: string
  storyCharacters?: Array<{ name?: string; role?: string; description?: string; status?: string }>
  image?: { mimeType?: string; base64?: string }
  youtubeUrl?: string
}): Campaign {
  return {
    id: item.id,
    worldId: item.worldId,
    ownerId: item.ownerId ?? '',
    ownerProfile: mapOwnerProfile(item.ownerProfile),
    visibility: normalizeVisibility(item.visibility),
    name: item.name,
    storyDescription: item.storyDescription ?? '',
    storyDescriptionEn: item.storyDescriptionEn || undefined,
    storyCharacters: Array.isArray(item.storyCharacters)
      ? item.storyCharacters.map((c) => ({
          name: c.name ?? '',
          role: c.role ?? '',
          description: c.description ?? '',
          status: c.status ?? ''
        }))
      : undefined,
    image: mapStoredImage(item.image),
    youtubeUrl: item.youtubeUrl || undefined
  }
}

function mapCharacterRecord(item: {
  id: string
  campaignId: string
  worldId?: string
  ownerId?: string
  userId?: string
  ownerProfile?: { uid?: string; displayName?: string; photoUrl?: string }
  visibility?: Visibility
  name: string
  gender?: string
  race?: string
  profession?: string
  description?: string
  campaignRole?: string
  attributes: Record<string, number>
  skills?: Record<string, number>
  edges?: string[]
  hindrances?: Hindrance[]
  hindranceAllocation?: { extraEdges: number; extraAttributePoints: number; extraSkillPoints: number }
  sheetValues?: Record<string, unknown>
  image?: { mimeType?: string; base64?: string }
}): Character {
  const ownerId = item.ownerId ?? item.userId ?? ''

  return {
    id: item.id,
    campaignId: item.campaignId,
    worldId: item.worldId,
    ownerId,
    ownerProfile: mapOwnerProfile(item.ownerProfile),
    visibility: normalizeVisibility(item.visibility),
    name: item.name,
    gender: item.gender,
    race: item.race,
    profession: item.profession,
    description: item.description,
    campaignRole: item.campaignRole,
    attributes: item.attributes ?? {},
    skills: item.skills,
    edges: item.edges,
    hindrances: item.hindrances,
    hindranceAllocation: item.hindranceAllocation,
    sheetValues: item.sheetValues,
    image: mapStoredImage(item.image)
  }
}

export async function mergeAnonymousOwnership(anonymousToken: string): Promise<{
  ok: true
  merged: boolean
  sourceUserId: string
  targetUserId: string
  counts: {
    worlds: number
    campaigns: number
    characters: number
    sessions: number
  }
}> {
  return await apiRequest('/auth/merge-anonymous', {
    method: 'POST',
    body: JSON.stringify({ anonymousToken })
  })
}

// ─── Campaigns ────────────────────────────────────────

export async function createCampaign(params: {
  worldId: string
  name?: string
  storyDescription?: string
  visibility?: Visibility
  image?: StoredImage
  youtubeUrl?: string
}): Promise<string> {
  const response = await apiRequest<{ campaignId: string }>('/campaigns', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  return response.campaignId
}

export async function listCampaigns(worldId?: string): Promise<Campaign[]> {
  const query = worldId ? `?worldId=${encodeURIComponent(worldId)}` : ''
  const response = await apiRequest<{
    campaigns: Array<{
      id: string
      worldId: string
      ownerId?: string
      ownerProfile?: { uid?: string; displayName?: string; photoUrl?: string }
      visibility?: Visibility
      name?: string
      storyDescription?: string
      storyDescriptionEn?: string
      storyCharacters?: Array<{ name?: string; role?: string; description?: string; status?: string }>
      image?: { mimeType?: string; base64?: string }
      youtubeUrl?: string
    }>
  }>(`/campaigns${query}`)

  return response.campaigns.map(mapCampaignRecord)
}

export async function getCampaign(campaignId: string): Promise<Campaign> {
  const response = await apiRequest<{
    campaign: {
      id: string
      worldId: string
      ownerId?: string
      ownerProfile?: { uid?: string; displayName?: string; photoUrl?: string }
      visibility?: Visibility
      name?: string
      storyDescription?: string
      storyDescriptionEn?: string
      storyCharacters?: Array<{ name?: string; role?: string; description?: string; status?: string }>
      image?: { mimeType?: string; base64?: string }
      youtubeUrl?: string
    }
  }>(`/campaigns/${encodeURIComponent(campaignId)}`)

  return mapCampaignRecord(response.campaign)
}

export async function updateCampaign(
  campaignId: string,
  params: { name?: string; storyDescription?: string; storyCharacters?: StoryCharacter[]; visibility?: Visibility; image?: StoredImage; youtubeUrl?: string }
): Promise<void> {
  await apiRequest<{ ok: true }>(`/campaigns/${encodeURIComponent(campaignId)}`, {
    method: 'PUT',
    body: JSON.stringify(params)
  })
}

export async function deleteCampaign(campaignId: string): Promise<void> {
  await apiRequest<{ ok: true }>(`/campaigns/${encodeURIComponent(campaignId)}`, {
    method: 'DELETE'
  })
}

export async function incrementCampaignStoryPreview(params: {
  worldName: string
  worldId?: string
}): Promise<{ storyDescription: string; storyDescriptionEn?: string; storyCharacters: StoryCharacter[]; name?: string }> {
  const response = await apiRequest<{ storyDescription: string; storyDescriptionEn?: string; storyCharacters?: StoryCharacter[]; name?: string }>('/campaigns/increment-preview', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  return {
    storyDescription: response.storyDescription,
    storyDescriptionEn: response.storyDescriptionEn,
    storyCharacters: response.storyCharacters ?? [],
    name: response.name
  }
}

export async function incrementCampaignStory(campaignId: string): Promise<{ storyDescription: string; storyCharacters: StoryCharacter[] }> {
  const response = await apiRequest<{ storyDescription: string; storyCharacters?: StoryCharacter[] }>(`/campaigns/${encodeURIComponent(campaignId)}/increment`, {
    method: 'POST'
  })
  return { storyDescription: response.storyDescription, storyCharacters: response.storyCharacters ?? [] }
}

export async function generateCampaignImagePreview(params: {
  name?: string
  storyDescription?: string
  worldId?: string
}): Promise<StoredImage> {
  const response = await apiRequest<{ image: StoredImage }>('/campaigns/image-preview', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  return response.image
}

export async function createWorld(params: {
  name: string
  lore?: string
  narrativeStyleGuide?: string
  ruleSetId?: string
  visibility?: Visibility
  image?: StoredImage
}): Promise<string> {
  const response = await apiRequest<{ worldId: string }>('/worlds', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  return response.worldId
}

export async function listWorlds(): Promise<World[]> {
  const response = await apiRequest<{
    worlds: Array<{
      id: string
      ownerId?: string
      ownerProfile?: { uid?: string; displayName?: string; photoUrl?: string }
      visibility?: Visibility
      name: string
      description?: string
      lore?: string
      narrativeStyleGuide?: string
      ruleSetId?: string
      image?: { mimeType?: string; base64?: string }
    }>
  }>(`/worlds`)

  return response.worlds.map(mapWorldRecord)
}

export async function getWorld(worldId: string): Promise<World> {
  const response = await apiRequest<{
    world: {
      id: string
      ownerId?: string
      ownerProfile?: { uid?: string; displayName?: string; photoUrl?: string }
      visibility?: Visibility
      name: string
      description?: string
      lore?: string
      narrativeStyleGuide?: string
      ruleSetId?: string
      image?: { mimeType?: string; base64?: string }
    }
  }>(`/worlds/${encodeURIComponent(worldId)}`)

  return mapWorldRecord(response.world)
}

export async function updateWorld(
  worldId: string,
  params: { name?: string; description?: string; lore?: string; narrativeStyleGuide?: string; ruleSetId?: string; visibility?: Visibility; image?: StoredImage }
): Promise<void> {
  await apiRequest<{ ok: true }>(`/worlds/${encodeURIComponent(worldId)}`, {
    method: 'PUT',
    body: JSON.stringify(params)
  })
}

export async function deleteWorld(worldId: string): Promise<void> {
  await apiRequest<{ ok: true }>(`/worlds/${encodeURIComponent(worldId)}`, {
    method: 'DELETE'
  })
}

export async function generateWorldLore(worldId: string): Promise<{ lore: string; narrativeStyleGuide?: string }> {
  const response = await apiRequest<{ lore: string; narrativeStyleGuide?: string }>(`/worlds/${encodeURIComponent(worldId)}/generate-lore`, {
    method: 'POST'
  })
  return response
}

export async function generateWorldImagePreview(params: { name: string }): Promise<StoredImage> {
  const response = await apiRequest<{ image: StoredImage }>('/worlds/image-preview', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  return response.image
}

export async function createCharacter(params: {
  worldId: string
  name: string
  gender?: string
  race?: string
  profession: string
  description?: string
  campaignRole?: string
  genderEn?: string
  raceEn?: string
  professionEn?: string
  descriptionEn?: string
  campaignRoleEn?: string
  visibility?: Visibility
  attributes: Record<string, number>
  skills?: Record<string, number>
  edges?: string[]
  hindrances?: Hindrance[]
  hindranceAllocation?: { extraEdges: number; extraAttributePoints: number; extraSkillPoints: number }
  sheetValues?: Record<string, unknown>
  image?: StoredImage
}): Promise<string> {
  const response = await apiRequest<{ characterId: string }>('/characters', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  return response.characterId
}

export async function generateCharacterFromWorldStory(params: {
  worldId: string
  existingFields?: {
    name?: string
    gender?: string
    race?: string
    profession?: string
    description?: string
    campaignRole?: string
  }
}): Promise<{
  name: string
  gender: string
  race: string
  profession: string
  description: string
  campaignRole: string
  genderPt?: string
  racePt?: string
  professionPt?: string
  descriptionPt?: string
  campaignRolePt?: string
}> {
  return await apiRequest('/characters/suggest-from-world', {
    method: 'POST',
    body: JSON.stringify(params)
  })
}

export async function generateCharacterFromDescription(params: {
  worldId: string
  characterConcept: string
}): Promise<{
  name: string
  gender: string
  race: string
  profession: string
  description: string
  campaignRole: string
  genderPt?: string
  racePt?: string
  professionPt?: string
  descriptionPt?: string
  campaignRolePt?: string
}> {
  return await apiRequest('/characters/suggest-from-description', {
    method: 'POST',
    body: JSON.stringify(params)
  })
}

export async function generateCharacterImagePreview(params: {
  worldId: string
  gender?: string
  race?: string
  profession: string
  additionalDescription?: string
}): Promise<StoredImage> {
  const response = await apiRequest<{ image: StoredImage }>('/characters/image-preview', {
    method: 'POST',
    body: JSON.stringify(params)
  })
  return response.image
}

export async function listCharacters(worldId?: string): Promise<Character[]> {
  const query = worldId ? `?worldId=${encodeURIComponent(worldId)}` : ''
  const response = await apiRequest<{ characters: Array<{
    id: string
    campaignId: string
    worldId?: string
    ownerId?: string
    userId?: string
    ownerProfile?: { uid?: string; displayName?: string; photoUrl?: string }
    visibility?: Visibility
    name: string
    gender?: string
    race?: string
    profession?: string
    description?: string
    campaignRole?: string
    attributes: Record<string, number>
    skills?: Record<string, number>
    edges?: string[]
    hindrances?: Hindrance[]
    hindranceAllocation?: { extraEdges: number; extraAttributePoints: number; extraSkillPoints: number }
    sheetValues?: Record<string, unknown>
    image?: { mimeType?: string; base64?: string }
  }> }>(`/characters${query}`)
  return response.characters.map(mapCharacterRecord)
}

export async function getCharacter(characterId: string): Promise<Character> {
  const response = await apiRequest<{ character: {
    id: string
    campaignId: string
    worldId?: string
    ownerId?: string
    userId?: string
    ownerProfile?: { uid?: string; displayName?: string; photoUrl?: string }
    visibility?: Visibility
    name: string
    gender?: string
    race?: string
    profession?: string
    description?: string
    campaignRole?: string
    attributes: Record<string, number>
    skills?: Record<string, number>
    edges?: string[]
    hindrances?: Hindrance[]
    hindranceAllocation?: { extraEdges: number; extraAttributePoints: number; extraSkillPoints: number }
    sheetValues?: Record<string, unknown>
    image?: { mimeType?: string; base64?: string }
  } }>(`/characters/${encodeURIComponent(characterId)}`)

  return mapCharacterRecord(response.character)
}

export async function deleteCharacter(characterId: string): Promise<void> {
  await apiRequest<{ ok: true }>(`/characters/${encodeURIComponent(characterId)}`, {
    method: 'DELETE'
  })
}

export async function updateCharacter(
  characterId: string,
  params: {
    name: string
    gender?: string
    race?: string
    profession: string
    description?: string
    campaignRole?: string
    visibility?: Visibility
    attributes: Record<string, number>
    skills?: Record<string, number>
    edges?: string[]
    hindrances?: Hindrance[]
    hindranceAllocation?: { extraEdges: number; extraAttributePoints: number; extraSkillPoints: number }
    sheetValues?: Record<string, unknown>
    image?: StoredImage
  }
): Promise<void> {
  await apiRequest<{ ok: true }>(`/characters/${encodeURIComponent(characterId)}`, {
    method: 'PUT',
    body: JSON.stringify(params)
  })
}

export async function startSession(params: {
  characterId: string
  campaignId: string
}): Promise<{ sessionId: string; state: GameState; messages: ChatMessage[]; narratorResponse?: NarratorTurnResponse }> {
  return await apiRequest<{ sessionId: string; state: GameState; messages: ChatMessage[]; narratorResponse?: NarratorTurnResponse }>('/sessions/start', {
    method: 'POST',
    body: JSON.stringify(params)
  })
}

export type ActivePlaythrough = {
  sessionId: string
  campaignId: string
  characterId: string
  worldId?: string
  status: string
  updatedAtMillis: number
}

/** Playthroughs ativos do usuário (aba "jogos ativos"). */
export async function listActivePlaythroughs(): Promise<ActivePlaythrough[]> {
  const response = await apiRequest<{ playthroughs: ActivePlaythrough[] }>('/sessions/active')
  return response.playthroughs
}

export type EnginePhaseData = {
  phase: 'engine'
  state: GameState
  messages: ChatMessage[]
  diceEvents: Array<{ type: string; payload: Record<string, unknown> }>
}

export async function validateCustomAction(
  sessionId: string,
  input: string
): Promise<import('../types').ValidateActionResponse> {
  return await apiRequest('/sessions/' + encodeURIComponent(sessionId) + '/validate-action', {
    method: 'POST',
    body: JSON.stringify({ input })
  })
}

export async function rebuildHistorySummary(sessionId: string): Promise<SessionPayload> {
  return await apiRequest('/sessions/' + encodeURIComponent(sessionId) + '/rebuild-history-summary', {
    method: 'POST'
  })
}

export async function executeCustomAction(
  sessionId: string,
  input: string,
  onEnginePhase?: (data: EnginePhaseData) => void,
  signal?: AbortSignal
): Promise<SessionPayload> {
  const body = { action: { type: 'custom', input } }
  if (onEnginePhase) {
    return await apiStreamRequest<SessionPayload>(
      '/sessions/' + encodeURIComponent(sessionId) + '/actions/stream',
      body,
      (data) => { if (data.phase === 'engine') onEnginePhase(data as unknown as EnginePhaseData) },
      signal
    )
  }
  return await apiRequest('/sessions/' + encodeURIComponent(sessionId) + '/actions', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export async function executeTraitTest(
  params: {
    sessionId: string
    skill?: string
    attribute?: string
    modifier?: number
    description?: string
    displayText?: string
  },
  onEnginePhase?: (data: EnginePhaseData) => void,
  signal?: AbortSignal
): Promise<SessionPayload> {
  const body = {
    action: {
      type: 'trait_test',
      ...(params.skill ? { skill: params.skill } : {}),
      ...(params.attribute ? { attribute: params.attribute } : {}),
      modifier: params.modifier ?? 0,
      description: params.description
    },
    ...(params.displayText ? { displayText: params.displayText } : {})
  }
  if (onEnginePhase) {
    return await apiStreamRequest<SessionPayload>(
      '/sessions/' + encodeURIComponent(params.sessionId) + '/actions/stream',
      body,
      (data) => { if (data.phase === 'engine') onEnginePhase(data as unknown as EnginePhaseData) },
      signal
    )
  }
  return await apiRequest('/sessions/' + encodeURIComponent(params.sessionId) + '/actions', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export async function executeAttack(
  params: {
    sessionId: string
    skill?: string
    targetId: string
    modifier?: number
    damageFormula?: string
    ap?: number
  },
  onEnginePhase?: (data: EnginePhaseData) => void,
  signal?: AbortSignal
): Promise<SessionPayload> {
  const body = {
    action: {
      type: 'attack',
      skill: params.skill ?? 'Luta',
      targetId: params.targetId,
      modifier: params.modifier ?? 0,
      ...(params.damageFormula ? { damageFormula: params.damageFormula } : {}),
      ap: params.ap ?? 0
    }
  }
  if (onEnginePhase) {
    return await apiStreamRequest<SessionPayload>(
      '/sessions/' + encodeURIComponent(params.sessionId) + '/actions/stream',
      body,
      (data) => { if (data.phase === 'engine') onEnginePhase(data as unknown as EnginePhaseData) },
      signal
    )
  }
  return await apiRequest('/sessions/' + encodeURIComponent(params.sessionId) + '/actions', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export async function executeSoakRoll(
  sessionId: string,
  onEnginePhase?: (data: EnginePhaseData) => void,
  signal?: AbortSignal
): Promise<SessionPayload> {
  const body = { action: { type: 'soak_roll' } }
  if (onEnginePhase) {
    return await apiStreamRequest<SessionPayload>(
      '/sessions/' + encodeURIComponent(sessionId) + '/actions/stream',
      body,
      (data) => { if (data.phase === 'engine') onEnginePhase(data as unknown as EnginePhaseData) },
      signal
    )
  }
  return await apiRequest('/sessions/' + encodeURIComponent(sessionId) + '/actions', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export async function executeSpendBenny(
  sessionId: string,
  purpose: 'reroll' | 'soak' | 'unshake' = 'reroll',
  onEnginePhase?: (data: EnginePhaseData) => void,
  signal?: AbortSignal
): Promise<SessionPayload> {
  const body = { action: { type: 'spend_benny', purpose } }
  if (onEnginePhase) {
    return await apiStreamRequest<SessionPayload>(
      '/sessions/' + encodeURIComponent(sessionId) + '/actions/stream',
      body,
      (data) => { if (data.phase === 'engine') onEnginePhase(data as unknown as EnginePhaseData) },
      signal
    )
  }
  return await apiRequest('/sessions/' + encodeURIComponent(sessionId) + '/actions', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export async function executeRecoverShaken(
  sessionId: string,
  onEnginePhase?: (data: EnginePhaseData) => void,
  signal?: AbortSignal
): Promise<SessionPayload> {
  const body = { action: { type: 'recover_shaken' } }
  if (onEnginePhase) {
    return await apiStreamRequest<SessionPayload>(
      '/sessions/' + encodeURIComponent(sessionId) + '/actions/stream',
      body,
      (data) => { if (data.phase === 'engine') onEnginePhase(data as unknown as EnginePhaseData) },
      signal
    )
  }
  return await apiRequest('/sessions/' + encodeURIComponent(sessionId) + '/actions', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

async function getSessionPayload(sessionId: string): Promise<SessionPayload> {
  return await apiRequest<SessionPayload>('/sessions/' + encodeURIComponent(sessionId))
}

export async function getSessionView(sessionId: string): Promise<SessionPayload> {
  return await getSessionPayload(sessionId)
}

export async function getLatestSnapshotState(sessionId: string): Promise<GameState | null> {
  const payload = await getSessionPayload(sessionId)
  return payload.state ?? null
}

export async function getSessionEvents(sessionId: string): Promise<SessionEvent[]> {
  const response = await apiRequest<{ events: Array<{ id: string; turn: number; type: string; payload: Record<string, unknown> }> }>(
    '/sessions/' + encodeURIComponent(sessionId) + '/events'
  )

  return response.events.map((item) => ({
    id: item.id,
    turn: Number(item.turn ?? 0),
    type: String(item.type ?? ''),
    payload: (item.payload as Record<string, unknown>) ?? {}
  }))
}

export async function getSessionSummary(sessionId: string): Promise<SummaryDoc | null> {
  const payload = await getSessionPayload(sessionId)
  return payload.summary ?? null
}

export async function chooseOption(
  sessionId: string,
  optionId: string,
  onEnginePhase?: (data: EnginePhaseData) => void,
  signal?: AbortSignal
): Promise<SessionPayload> {
  const body = { optionId }
  if (onEnginePhase) {
    return await apiStreamRequest<SessionPayload>(
      '/sessions/' + encodeURIComponent(sessionId) + '/choose/stream',
      body,
      (data) => { if (data.phase === 'engine') onEnginePhase(data as unknown as EnginePhaseData) },
      signal
    )
  }
  return await apiRequest('/sessions/' + encodeURIComponent(sessionId) + '/choose', {
    method: 'POST',
    body: JSON.stringify(body)
  })
}

export async function updateSessionSettings(
  sessionId: string,
  settings: { narrativeStyle?: 'concise' | 'balanced'; simpleVocabulary?: boolean }
): Promise<{ ok: boolean }> {
  return await apiRequest('/sessions/' + encodeURIComponent(sessionId) + '/settings', {
    method: 'PATCH',
    body: JSON.stringify(settings)
  })
}

export async function resetSession(sessionId: string): Promise<SessionPayload> {
  return await apiRequest('/sessions/' + encodeURIComponent(sessionId) + '/reset', {
    method: 'POST'
  })
}

export async function removeInventoryItem(
  sessionId: string,
  itemId: string
): Promise<{ ok: boolean; inventory: import('../types').InventoryItem[] }> {
  return await apiRequest('/sessions/' + encodeURIComponent(sessionId) + '/inventory/' + encodeURIComponent(itemId), {
    method: 'DELETE'
  })
}

export async function getMessages(sessionId: string): Promise<ChatMessage[]> {
  const response = await apiRequest<{ messages: ChatMessage[] }>(
    '/sessions/' + encodeURIComponent(sessionId) + '/messages'
  )
  return response.messages
}

export type NarrationLogEntry = {
  id: string
  sessionId: string
  timestamp: number
  turn: number
  durationMs: number
  playerAction: { type: string; description: string }
  engineEvents: Array<{ type: string; payload: Record<string, unknown> }>
  narrative: string
  options: Array<{
    id: string
    text: string
    playerSpeech?: string | null
    actionType: string
    diceCheck?: { skill?: string; attribute?: string; tn?: number; required?: boolean } | null
  }>
  npcs: Array<{ id: string; name: string; action: string }>
  itemChanges: Array<{ name: string; changeType: string; quantity?: number }>
  statusChanges: Array<{ name: string; changeType: string; effectId?: string }>
  npcAttackEvents: Array<{ type: string; payload: Record<string, unknown> }>
  isFallback: boolean
}

export async function getNarrationLog(sessionId: string): Promise<NarrationLogEntry[]> {
  const response = await apiRequest<{ entries: NarrationLogEntry[] }>(
    '/sessions/' + encodeURIComponent(sessionId) + '/narration-log'
  )
  return response.entries
}
