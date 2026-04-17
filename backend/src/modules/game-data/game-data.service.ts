import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'

import { CampaignsRepo } from '../../repositories/campaigns.repo.js'
import { WorldsRepo, type Visibility } from '../../repositories/worlds.repo.js'
import { CharactersRepo } from '../../repositories/characters.repo.js'
import { GeminiAdapter } from '../../llm/gemini.adapter.js'
import { GeminiImageGenerator } from '../../llm/gemini-image.generator.js'
import { normalizeToWebp, type StoredImage } from '../../utils/image-normalize.js'
import { isDieType, CHARACTER_CREATION, ATTRIBUTE_KEYS } from '../../domain/savage-worlds/constants.js'
import type { DieType, Hindrance } from '../../domain/types/gameState.js'
import { firebaseAuth, firestore } from '../../infrastructure/firebase.js'

const FALLBACK_NAME_POOL = ['Darian', 'Liora', 'Thoran', 'Mirela', 'Aedan', 'Seris', 'Ravena', 'Nayra']
const FALLBACK_CLASS_POOL = ['Guerreiro', 'Arcanista', 'Patrulheiro', 'Ladino', 'Bardo', 'Clérigo']
const FALLBACK_PROFESSION_POOL = ['Batedor', 'Cartógrafo', 'Mercenário', 'Erudito', 'Mensageiro', 'Caçador']

function sanitizeInlineText(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ')
}

function buildWorldImagePrompt(params: { worldName: string; thematic: string }): string {
  const worldName = sanitizeInlineText(params.worldName)
  const thematic = sanitizeInlineText(params.thematic)

  return [
    'Create a illustrated key art.',
    `Setting anchor: world name "${worldName || 'Unnamed world'}".`,
    `Campaign theme: "${thematic || 'generic fantasy'}".`,
    'Composition goals: epic landscape or settlement vista, clear sense of scale, layered depth, memorable landmarks, mood and visual storytelling driven by the setting itself.',
    'Restrictions: no text, no title, no logos, no watermarks, no UI, no typography, no close-up faces, no characters as the main subject.'
  ].join('\n')
}

function buildUniverseImagePrompt(params: { name: string }): string {
  const worldName = sanitizeInlineText(params.name)

  return [
    'Create a cinematic illustrated key art.',
    `Setting anchor: world name "${worldName || 'Unnamed world'}".`,
    'Composition goals: epic landscape or settlement vista, clear sense of scale, layered depth, memorable landmarks, mood and visual storytelling driven by the setting itself.',
    'Restrictions: no text, no title, no logos, no watermarks, no UI, no typography, no close-up faces, no characters as the main subject.'
  ].join('\n')
}

function buildCharacterImagePrompt(params: {
  worldName: string
  thematic: string
  gender?: string
  race?: string
  profession: string
  characterClass: string
  additionalDescription?: string
}): string {
  const worldName = sanitizeInlineText(params.worldName)
  const thematic = sanitizeInlineText(params.thematic)
  const gender = sanitizeInlineText(params.gender)
  const race = sanitizeInlineText(params.race)
  const profession = sanitizeInlineText(params.profession)
  const characterClass = sanitizeInlineText(params.characterClass)
  const additional = sanitizeInlineText(params.additionalDescription)

  return [
    'Create a RPG character portrait illustration.',
    'Style: high quality, portrait bust shot.',
    'Rules: no text, no logos, no watermarks, no typography, safe for all audiences.',
    `Setting: ${worldName || 'Unknown world'}, ${thematic || 'generic fantasy'}.`,
    ...(gender ? [`Gender: ${gender}.`] : []),
    ...(race ? [`Race/Species: ${race}.`] : []),
    `Class: ${characterClass || 'Adventurer'}.`,
    `Profession: ${profession || 'Traveler'}.`,
    ...(additional ? [`Visual details: ${additional}.`] : []),
    'Composition: centered character, warm lighting, friendly expression, fully clothed, no weapons pointed at viewer.'
  ].join('\n')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function validateSWAttributes(attributes: Record<string, number>, extraAttributePoints = 0): Record<string, DieType> {
  const validated: Record<string, DieType> = {}
  let stepsUsed = 0
  for (const key of ATTRIBUTE_KEYS) {
    const raw = attributes[key]
    const value = typeof raw === 'number' && isDieType(raw) ? raw : 4
    validated[key] = value as DieType
    stepsUsed += (value - 4) / 2
  }
  const totalAllowed = CHARACTER_CREATION.attributePoints + extraAttributePoints
  if (stepsUsed > totalAllowed) {
    throw new BadRequestException(
      `Distribuição de atributos excede ${totalAllowed} pontos (usou ${stepsUsed}).`
    )
  }
  return validated
}

function validateSWSkills(skills: Record<string, number>, extraSkillPoints = 0): Record<string, DieType> {
  const validated: Record<string, DieType> = {}
  let stepsUsed = 0
  for (const [name, raw] of Object.entries(skills)) {
    if (typeof raw !== 'number' || !isDieType(raw)) continue
    validated[name] = raw as DieType
    stepsUsed += raw === 4 ? 1 : 1 + (raw - 4) / 2
  }
  const totalAllowed = CHARACTER_CREATION.skillPoints + extraSkillPoints
  if (stepsUsed > totalAllowed) {
    throw new BadRequestException(
      `Distribuição de perícias excede ${totalAllowed} pontos (usou ${stepsUsed}).`
    )
  }
  return validated
}

function validateHindrances(hindrances: unknown[]): Hindrance[] {
  const validated = hindrances
    .filter((h): h is { name: string; severity: string } =>
      isRecord(h) && typeof (h as any).name === 'string' && typeof (h as any).severity === 'string'
    )
    .map(h => ({
      name: h.name.trim(),
      severity: (h.severity === 'major' ? 'major' : 'minor') as 'minor' | 'major',
    }))

  const majorCount = validated.filter(h => h.severity === 'major').length
  const minorCount = validated.filter(h => h.severity === 'minor').length

  if (majorCount > CHARACTER_CREATION.maxMajorHindrances) {
    throw new BadRequestException(
      `Máximo ${CHARACTER_CREATION.maxMajorHindrances} Complicação Maior (enviou ${majorCount}).`
    )
  }
  if (minorCount > CHARACTER_CREATION.maxMinorHindrances) {
    throw new BadRequestException(
      `Máximo ${CHARACTER_CREATION.maxMinorHindrances} Complicações Menores (enviou ${minorCount}).`
    )
  }

  return validated
}

type HindranceAllocation = {
  extraEdges: number
  extraAttributePoints: number
  extraSkillPoints: number
}

function validateHindranceAllocation(
  hindrances: Hindrance[],
  allocation: HindranceAllocation
): HindranceAllocation {
  // Calcula pontos gerados pelas complicações (max 4 por regra SW)
  let hindrancePoints = 0
  for (const h of hindrances) {
    hindrancePoints += h.severity === 'major' ? 2 : 1
  }
  hindrancePoints = Math.min(hindrancePoints, CHARACTER_CREATION.maxHindrancePoints)

  // Calcula pontos gastos na alocação
  const spent = allocation.extraEdges * 2 + allocation.extraAttributePoints * 2 + allocation.extraSkillPoints * 1

  if (spent > hindrancePoints) {
    throw new BadRequestException(
      `Alocação de pontos de complicações excede o disponível (${hindrancePoints} pts disponíveis, ${spent} pts gastos).`
    )
  }

  return allocation
}

function pickRandom<T>(items: T[], fallback: T): T {
  if (!items.length) return fallback
  const index = Math.floor(Math.random() * items.length)
  return items[index] ?? fallback
}

function sanitizeSheetValues(values: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!values) return {}

  const sanitized: Record<string, unknown> = {}

  for (const [key, rawValue] of Object.entries(values)) {
    const normalizedKey = key.trim()
    if (!normalizedKey) continue

    if (typeof rawValue === 'string') {
      sanitized[normalizedKey] = rawValue.trim().slice(0, 5000)
      continue
    }

    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      sanitized[normalizedKey] = rawValue
      continue
    }

    if (typeof rawValue === 'boolean') {
      sanitized[normalizedKey] = rawValue
      continue
    }

    if (Array.isArray(rawValue)) {
      const normalizedArray = rawValue
        .map((item) => (typeof item === 'string' ? item.trim().slice(0, 500) : item))
        .filter(
          (item) =>
            typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)) || typeof item === 'boolean'
        )
      sanitized[normalizedKey] = normalizedArray.slice(0, 300)
    }
  }

  return sanitized
}

function normalizeVisibility(value: unknown): Visibility {
  return value === 'public' ? 'public' : 'private'
}

function getCharacterOwnerId(character: { ownerId?: string; userId?: string }): string {
  const ownerId = typeof character.ownerId === 'string' && character.ownerId.trim()
    ? character.ownerId
    : character.userId
  return (ownerId ?? '').trim()
}

type OwnerProfile = {
  uid: string
  displayName: string
  photoUrl?: string
}

function getProviderFallbackProfile(user: { providerData?: Array<{ displayName?: string | null; photoURL?: string | null }> }): {
  displayName?: string
  photoUrl?: string
} {
  for (const provider of user.providerData ?? []) {
    const displayName = provider.displayName?.trim() || undefined
    const photoUrl = provider.photoURL || undefined
    if (displayName || photoUrl) {
      return { displayName, photoUrl }
    }
  }

  return {}
}

@Injectable()
export class GameDataService {
  private readonly campaigns = new CampaignsRepo()
  private readonly worlds = new WorldsRepo()
  private readonly characters = new CharactersRepo()
  private readonly narrator = new GeminiAdapter()
  private readonly imageGenerator = new GeminiImageGenerator()

  private async normalizeWorldImage(image: StoredImage): Promise<StoredImage> {
    return await normalizeToWebp(image, { width: 512, height: 288, quality: 70 })
  }

  private async normalizeCharacterImage(image: StoredImage): Promise<StoredImage> {
    return await normalizeToWebp(image, { width: 384, height: 384, quality: 70 })
  }

  private async normalizeStoredImageByHint(params: { image: StoredImage; kind: 'world' | 'character' }): Promise<StoredImage> {
    return params.kind === 'world'
      ? await this.normalizeWorldImage(params.image)
      : await this.normalizeCharacterImage(params.image)
  }

  private canReadResource(params: { ownerId: string; visibility?: unknown; userId: string }): boolean {
    return params.ownerId === params.userId || normalizeVisibility(params.visibility) === 'public'
  }

  private buildOwnerFallback(ownerId: string): OwnerProfile {
    const safeOwnerId = ownerId.trim()
    return {
      uid: safeOwnerId,
      displayName: safeOwnerId ? `Jogador ${safeOwnerId.slice(0, 8)}` : 'Jogador'
    }
  }

  private async loadOwnerProfiles(ownerIds: string[]): Promise<Map<string, OwnerProfile>> {
    const uniqueOwnerIds = Array.from(new Set(ownerIds.map((ownerId) => ownerId.trim()).filter(Boolean)))
    const profiles = new Map<string, OwnerProfile>()

    for (let index = 0; index < uniqueOwnerIds.length; index += 100) {
      const chunk = uniqueOwnerIds.slice(index, index + 100)

      try {
        const result = await firebaseAuth.getUsers(chunk.map((uid) => ({ uid })))

        for (const user of result.users) {
          const providerProfile = getProviderFallbackProfile(user)
          profiles.set(user.uid, {
            uid: user.uid,
            displayName: user.displayName?.trim() || providerProfile.displayName || this.buildOwnerFallback(user.uid).displayName,
            photoUrl: user.photoURL ?? providerProfile.photoUrl
          })
        }

        for (const missingUser of result.notFound) {
          if ('uid' in missingUser && typeof missingUser.uid === 'string' && missingUser.uid.trim()) {
            profiles.set(missingUser.uid, this.buildOwnerFallback(missingUser.uid))
          }
        }
      } catch {
        for (const ownerId of chunk) {
          if (!profiles.has(ownerId)) {
            profiles.set(ownerId, this.buildOwnerFallback(ownerId))
          }
        }
      }
    }

    for (const ownerId of uniqueOwnerIds) {
      if (!profiles.has(ownerId)) {
        profiles.set(ownerId, this.buildOwnerFallback(ownerId))
      }
    }

    return profiles
  }

  private serializeWorld<T extends { ownerId: string; visibility?: unknown }>(world: T, ownerProfile?: OwnerProfile) {
    return {
      ...world,
      visibility: normalizeVisibility(world.visibility),
      ownerProfile: ownerProfile ?? this.buildOwnerFallback(world.ownerId)
    }
  }

  private serializeCampaign<T extends { ownerId: string; visibility?: unknown }>(campaign: T, ownerProfile?: OwnerProfile) {
    return {
      ...campaign,
      visibility: normalizeVisibility(campaign.visibility),
      ownerProfile: ownerProfile ?? this.buildOwnerFallback(campaign.ownerId)
    }
  }

  private serializeCharacter<T extends { ownerId?: string; userId?: string; visibility?: unknown }>(character: T, ownerProfile?: OwnerProfile) {
    const ownerId = getCharacterOwnerId(character)

    return {
      ...character,
      ownerId,
      userId: ownerId,
      visibility: normalizeVisibility(character.visibility),
      ownerProfile: ownerProfile ?? this.buildOwnerFallback(ownerId)
    }
  }

  // ─── World (universo/setting) ───

  async createWorld(params: {
    userId: string
    name: string
    description: string
    lore?: string
    ruleSetId?: string
    visibility?: Visibility
    image?: StoredImage
  }) {
    const normalizedImage = params.image
      ? await this.normalizeStoredImageByHint({ image: params.image, kind: 'world' })
      : undefined

    const worldId = randomUUID()
    await this.worlds.create({
      worldId,
      ownerId: params.userId,
      visibility: normalizeVisibility(params.visibility),
      ruleSetId: params.ruleSetId ?? 'savage-worlds',
      name: params.name,
      description: params.description?.trim() ?? '',
      lore: params.lore?.trim() ?? '',
      image: normalizedImage
    })

    return { worldId }
  }

  async listWorlds(params: { userId: string }) {
    const worlds = await this.worlds.listAccessible({ userId: params.userId })
    const ownerProfiles = await this.loadOwnerProfiles(worlds.map((world) => world.ownerId))
    return { worlds: worlds.map((world) => this.serializeWorld(world, ownerProfiles.get(world.ownerId))) }
  }

  async getWorld(params: { userId: string; worldId: string }) {
    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (!this.canReadResource({ ownerId: world.ownerId, visibility: world.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para este mundo')
    }
    const ownerProfiles = await this.loadOwnerProfiles([world.ownerId])
    return { world: this.serializeWorld(world, ownerProfiles.get(world.ownerId)) }
  }

  async deleteWorld(params: { userId: string; worldId: string }) {
    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (world.ownerId !== params.userId) throw new ForbiddenException('Sem permissão para este mundo')

    const linkedCampaigns = await this.campaigns.listByWorld(params.worldId)
    if (linkedCampaigns.length > 0) {
      throw new BadRequestException('Exclua as campanhas vinculadas antes de remover este mundo.')
    }

    await this.worlds.delete(params.worldId)
    return { ok: true }
  }

  async updateWorld(params: {
    userId: string
    worldId: string
    name?: string
    description?: string
    lore?: string
    ruleSetId?: string
    visibility?: Visibility
    image?: StoredImage
  }) {
    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (world.ownerId !== params.userId) throw new ForbiddenException('Sem permissão para este mundo')

    if (params.visibility === 'private') {
      const linkedCampaigns = await this.campaigns.listByWorld(params.worldId)
      const hasPublicCampaigns = linkedCampaigns.some((campaign) => normalizeVisibility(campaign.visibility) === 'public')

      if (hasPublicCampaigns) {
        throw new BadRequestException('Este mundo possui campanhas públicas. Torne essas campanhas privadas antes de privatizar o mundo.')
      }
    }

    const normalizedImage = params.image
      ? await this.normalizeStoredImageByHint({ image: params.image, kind: 'world' })
      : undefined

    await this.worlds.updateWorld({
      worldId: params.worldId,
      name: params.name,
      description: params.description?.trim(),
      lore: params.lore?.trim(),
      ruleSetId: params.ruleSetId,
      visibility: params.visibility ? normalizeVisibility(params.visibility) : undefined,
      image: normalizedImage
    })

    return { ok: true }
  }

  async generateWorldImagePreview(params: { userId: string; name: string }): Promise<{ image: StoredImage }> {
    if (!params.userId?.trim()) throw new ForbiddenException('Usuário não autenticado')
    const name = params.name?.trim() ?? ''
    if (!name) throw new BadRequestException('Nome do universo é obrigatório')

    const generated = await this.imageGenerator.generateImage({
      prompt: buildUniverseImagePrompt({ name }),
      width: 768,
      height: 432,
      mimeType: 'image/webp'
    })

    const normalized = await this.normalizeWorldImage({ mimeType: generated.mimeType, base64: generated.base64 })
    return { image: normalized }
  }

  async generateWorldLore(params: { userId: string; worldId: string }) {
    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (world.ownerId !== params.userId) throw new ForbiddenException('Sem permissão para este mundo')

    const lore = await this.narrator.expandWorldLore({
      name: world.name,
      description: world.description,
      currentLore: world.lore
    })

    await this.worlds.updateLore(world.id, lore)
    return { lore }
  }

  // ─── Campaign (campanha dentro de um mundo) ───

  async createCampaign(params: {
    userId: string
    worldId: string
    thematic: string
    storyDescription?: string
    visibility?: Visibility
    image?: StoredImage
    youtubeUrl?: string
  }) {
    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (!this.canReadResource({ ownerId: world.ownerId, visibility: world.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para este mundo')
    }

    const visibility = normalizeVisibility(params.visibility)
    if (visibility === 'public' && normalizeVisibility(world.visibility) !== 'public') {
      throw new BadRequestException('Campanhas públicas exigem um mundo público.')
    }

    const normalizedImage = params.image
      ? await this.normalizeStoredImageByHint({ image: params.image, kind: 'world' })
      : undefined

    const campaignId = randomUUID()
    await this.campaigns.create({
      campaignId,
      worldId: params.worldId,
      ownerId: params.userId,
      visibility,
      thematic: params.thematic,
      storyDescription: params.storyDescription?.trim() ?? '',
      image: normalizedImage,
      youtubeUrl: params.youtubeUrl
    })

    return { campaignId }
  }

  async generateCampaignStoryPreview(params: { worldName: string; thematic: string; currentDescription?: string }) {
    const storyDescription = await this.narrator.expandAdventureStory({
      campaignName: params.worldName,
      thematic: params.thematic,
      currentDescription: params.currentDescription
    })

    return { storyDescription }
  }

  async listCampaigns(params: { userId: string; worldId?: string }) {
    const campaigns = await this.campaigns.listAccessible({ userId: params.userId, worldId: params.worldId })
    const ownerProfiles = await this.loadOwnerProfiles(campaigns.map((campaign) => campaign.ownerId))
    return { campaigns: campaigns.map((campaign) => this.serializeCampaign(campaign, ownerProfiles.get(campaign.ownerId))) }
  }

  async getCampaign(params: { userId: string; campaignId: string }) {
    const campaign = await this.campaigns.get(params.campaignId)
    if (!campaign) throw new NotFoundException('Campanha não encontrada')
    if (!this.canReadResource({ ownerId: campaign.ownerId, visibility: campaign.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para esta campanha')
    }
    const ownerProfiles = await this.loadOwnerProfiles([campaign.ownerId])
    return { campaign: this.serializeCampaign(campaign, ownerProfiles.get(campaign.ownerId)) }
  }

  async deleteCampaign(params: { userId: string; campaignId: string }) {
    const campaign = await this.campaigns.get(params.campaignId)
    if (!campaign) throw new NotFoundException('Campanha não encontrada')
    if (campaign.ownerId !== params.userId) throw new ForbiddenException('Sem permissão para esta campanha')

    const linkedCharacters = await this.characters.listByCampaign(params.campaignId)
    if (linkedCharacters.length > 0) {
      throw new BadRequestException('Exclua os personagens vinculados antes de remover esta campanha.')
    }

    const sessionSnapshot = await firestore.collection('sessions').where('campaignId', '==', params.campaignId).limit(1).get()
    if (!sessionSnapshot.empty) {
      throw new BadRequestException('Existem sessões vinculadas a esta campanha. Remova-as antes de excluir a campanha.')
    }

    await this.campaigns.delete(params.campaignId)
    return { ok: true }
  }

  async updateCampaign(params: {
    userId: string
    campaignId: string
    thematic: string
    storyDescription: string
    visibility?: Visibility
    image?: StoredImage
    youtubeUrl?: string
  }) {
    const campaign = await this.campaigns.get(params.campaignId)
    if (!campaign) throw new NotFoundException('Campanha não encontrada')
    if (campaign.ownerId !== params.userId) throw new ForbiddenException('Sem permissão para esta campanha')

    const nextVisibility = params.visibility ? normalizeVisibility(params.visibility) : normalizeVisibility(campaign.visibility)

    if (nextVisibility === 'public') {
      const world = await this.worlds.get(campaign.worldId)
      if (!world) throw new NotFoundException('Mundo não encontrado')
      if (normalizeVisibility(world.visibility) !== 'public') {
        throw new BadRequestException('Campanhas públicas exigem um mundo público.')
      }
    }

    if (params.visibility === 'private') {
      const linkedCharacters = await this.characters.listByCampaign(params.campaignId)
      const hasPublicCharacters = linkedCharacters.some((character) => normalizeVisibility(character.visibility) === 'public')

      if (hasPublicCharacters) {
        throw new BadRequestException('Esta campanha possui personagens públicos. Torne esses personagens privados antes de privatizar a campanha.')
      }
    }

    const normalizedImage = params.image
      ? await this.normalizeStoredImageByHint({ image: params.image, kind: 'world' })
      : undefined

    await this.campaigns.updateCampaign({
      campaignId: params.campaignId,
      thematic: params.thematic,
      storyDescription: params.storyDescription?.trim() ?? '',
      visibility: params.visibility ? normalizeVisibility(params.visibility) : undefined,
      image: normalizedImage,
      youtubeUrl: params.youtubeUrl
    })

    return { ok: true }
  }

  async generateCampaignImagePreview(params: {
    userId: string
    campaignId?: string
    worldName?: string
    thematic: string
  }): Promise<{ image: StoredImage }> {
    const thematic = params.thematic?.trim() ?? ''
    if (!thematic) throw new BadRequestException('Temática é obrigatória')

    let worldName = params.worldName?.trim() ?? ''

    if (!worldName && params.campaignId) {
      const campaign = await this.campaigns.get(params.campaignId)
      if (!campaign) throw new NotFoundException('Campanha não encontrada')
      if (!this.canReadResource({ ownerId: campaign.ownerId, visibility: campaign.visibility, userId: params.userId })) {
        throw new ForbiddenException('Sem permissão para esta campanha')
      }

      const world = await this.worlds.get(campaign.worldId)
      if (world) worldName = world.name
    }

    const generated = await this.imageGenerator.generateImage({
      prompt: buildWorldImagePrompt({ worldName, thematic }),
      width: 768,
      height: 432,
      mimeType: 'image/webp'
    })

    const normalized = await this.normalizeWorldImage({ mimeType: generated.mimeType, base64: generated.base64 })
    return { image: normalized }
  }

  async incrementCampaignStory(params: { userId: string; campaignId: string }) {
    const campaign = await this.campaigns.get(params.campaignId)
    if (!campaign) throw new NotFoundException('Campanha não encontrada')
    if (campaign.ownerId !== params.userId) throw new ForbiddenException('Sem permissão para esta campanha')

    const world = await this.worlds.get(campaign.worldId)
    const worldName = world?.name ?? 'Mundo desconhecido'

    const thematic = campaign.thematic?.trim() || campaign.name?.trim() || 'Campanha sem temática definida'
    const storyDescription = await this.narrator.expandAdventureStory({
      campaignName: worldName,
      thematic,
      currentDescription: campaign.storyDescription
    })

    await this.campaigns.updateStoryDescription(campaign.id, storyDescription)
    return { storyDescription }
  }

  async createCharacter(params: {
    userId: string
    campaignId: string
    name: string
    gender?: string
    race?: string
    characterClass: string
    profession: string
    description?: string
    visibility?: Visibility
    attributes: Record<string, number>
    skills?: Record<string, number>
    edges?: string[]
    hindrances?: unknown[]
    hindranceAllocation?: { extraEdges: number; extraAttributePoints: number; extraSkillPoints: number }
    sheetValues?: Record<string, unknown>
    image?: StoredImage
  }) {
    const campaign = await this.campaigns.get(params.campaignId)
    if (!campaign) throw new NotFoundException('Campanha não encontrada')
    if (!this.canReadResource({ ownerId: campaign.ownerId, visibility: campaign.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para esta campanha')
    }

    const visibility = normalizeVisibility(params.visibility)
    if (visibility === 'public' && normalizeVisibility(campaign.visibility) !== 'public') {
      throw new BadRequestException('Personagens públicos exigem uma campanha pública.')
    }

    const world = await this.worlds.get(campaign.worldId)

    const normalizedHindrances = validateHindrances(params.hindrances ?? [])
    const allocation = params.hindranceAllocation ?? { extraEdges: 0, extraAttributePoints: 0, extraSkillPoints: 0 }
    validateHindranceAllocation(normalizedHindrances, allocation)

    const normalizedAttributes = validateSWAttributes(params.attributes, allocation.extraAttributePoints)
    const normalizedSkills = validateSWSkills(params.skills ?? {}, allocation.extraSkillPoints)
    const normalizedEdges = (params.edges ?? []).map(e => String(e).trim()).filter(Boolean)

    const normalizedImage = params.image
      ? await this.normalizeStoredImageByHint({ image: params.image, kind: 'character' })
      : undefined
    const normalizedSheetValues = sanitizeSheetValues(params.sheetValues)

    const characterId = randomUUID()
    await this.characters.create({
      characterId,
      campaignId: params.campaignId,
      worldId: campaign.worldId,
      ownerId: params.userId,
      visibility,
      name: params.name,
      gender: params.gender?.trim() ?? '',
      race: params.race?.trim() ?? '',
      characterClass: params.characterClass,
      profession: params.profession,
      description: params.description?.trim() ?? '',
      attributes: normalizedAttributes,
      skills: normalizedSkills,
      edges: normalizedEdges,
      hindrances: normalizedHindrances,
      sheetValues: normalizedSheetValues,
      hindranceAllocation: allocation,
      image: normalizedImage
    })

    return { characterId }
  }

  async generateCharacterImagePreview(params: {
    userId: string
    campaignId: string
    gender?: string
    race?: string
    profession: string
    characterClass: string
    additionalDescription?: string
  }): Promise<{ image: StoredImage }> {
    const campaign = await this.campaigns.get(params.campaignId)
    if (!campaign) throw new NotFoundException('Campanha não encontrada')
    if (!this.canReadResource({ ownerId: campaign.ownerId, visibility: campaign.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para esta campanha')
    }

    const world = await this.worlds.get(campaign.worldId)
    const worldName = world?.name ?? 'Mundo desconhecido'

    const generated = await this.imageGenerator.generateImage({
      prompt: buildCharacterImagePrompt({
        worldName,
        thematic: campaign.thematic ?? campaign.name ?? '',
        gender: params.gender,
        race: params.race,
        profession: params.profession,
        characterClass: params.characterClass,
        additionalDescription: params.additionalDescription
      }),
      width: 512,
      height: 512,
      mimeType: 'image/webp'
    })

    const normalized = await this.normalizeCharacterImage({ mimeType: generated.mimeType, base64: generated.base64 })
    return { image: normalized }
  }

  async listCharacters(params: { userId: string; campaignId?: string }) {
    const characters = await this.characters.listAccessible({ userId: params.userId, campaignId: params.campaignId })
    const ownerProfiles = await this.loadOwnerProfiles(characters.map((character) => getCharacterOwnerId(character)))
    return {
      characters: characters.map((character) => {
        const ownerId = getCharacterOwnerId(character)
        return this.serializeCharacter(character, ownerProfiles.get(ownerId))
      })
    }
  }

  async getCharacter(params: { userId: string; characterId: string }) {
    const character = await this.characters.get(params.characterId)
    if (!character) throw new NotFoundException('Personagem não encontrado')

    const ownerId = getCharacterOwnerId(character)
    if (!this.canReadResource({ ownerId, visibility: character.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para este personagem')
    }

    const ownerProfiles = await this.loadOwnerProfiles([ownerId])
    return { character: this.serializeCharacter(character, ownerProfiles.get(ownerId)) }
  }

  async suggestCharacterFromWorld(params: {
    userId: string
    campaignId: string
    existingFields?: {
      name?: string
      gender?: string
      race?: string
      characterClass?: string
      profession?: string
      description?: string
    }
  }) {
    const campaign = await this.campaigns.get(params.campaignId)
    if (!campaign) throw new NotFoundException('Campanha não encontrada')
    if (!this.canReadResource({ ownerId: campaign.ownerId, visibility: campaign.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para esta campanha')
    }

    const storyDescription = campaign.storyDescription?.trim()
    if (!storyDescription) {
      throw new BadRequestException('Esta campanha ainda não possui história para gerar personagem.')
    }

    const thematic = campaign.thematic?.trim() || campaign.name?.trim() || 'Campanha sem temática definida'

    // Enrich with world lore if available
    const world = await this.worlds.get(campaign.worldId)
    const worldLore = world?.lore?.trim() ?? ''

    const fallbackName = pickRandom(FALLBACK_NAME_POOL, 'Darian')
    const fallbackClass = pickRandom(FALLBACK_CLASS_POOL, 'Guerreiro')
    const professionOptions = FALLBACK_PROFESSION_POOL.filter(
      (item) => item.localeCompare(fallbackClass, 'pt-BR', { sensitivity: 'base' }) !== 0
    )
    const fallbackProfession = pickRandom(professionOptions, 'Mercenário')
    const fallback = {
      name: fallbackName,
      gender: '',
      race: 'Humano',
      characterClass: fallbackClass,
      profession: fallbackProfession,
      description: `${fallbackName} é ${fallbackProfession.toLowerCase()} com perfil ${fallbackClass.toLowerCase()}, moldado pela temática ${thematic.toLowerCase()}.`
    }

    try {
      const suggestion = await this.narrator.suggestCharacterFromWorld({
        thematic,
        storyDescription,
        worldLore,
        existingFields: params.existingFields
      })

      const name = suggestion.name.trim() || fallback.name
      const gender = suggestion.gender?.trim() || fallback.gender
      const race = suggestion.race?.trim() || fallback.race
      const characterClass = suggestion.characterClass.trim() || fallback.characterClass
      const profession = suggestion.profession.trim() || fallback.profession
      const description = suggestion.description.trim() || fallback.description

      return {
        name,
        gender,
        race,
        characterClass,
        profession,
        description
      }
    } catch {
      return fallback
    }
  }

  async deleteCharacter(params: { userId: string; characterId: string }) {
    const character = await this.characters.get(params.characterId)
    if (!character) throw new NotFoundException('Personagem não encontrado')
    if (getCharacterOwnerId(character) !== params.userId) throw new ForbiddenException('Sem permissão para este personagem')

    await this.characters.delete(params.characterId)
    return { ok: true }
  }

  async updateCharacter(params: {
    userId: string
    characterId: string
    name: string
    gender?: string
    race?: string
    characterClass: string
    profession: string
    description?: string
    visibility?: Visibility
    attributes: Record<string, number>
    skills?: Record<string, number>
    edges?: string[]
    hindrances?: unknown[]
    hindranceAllocation?: { extraEdges: number; extraAttributePoints: number; extraSkillPoints: number }
    sheetValues?: Record<string, unknown>
    image?: StoredImage
  }) {
    const character = await this.characters.get(params.characterId)
    if (!character) throw new NotFoundException('Personagem não encontrado')
    if (getCharacterOwnerId(character) !== params.userId) throw new ForbiddenException('Sem permissão para este personagem')

    const nextVisibility = params.visibility ? normalizeVisibility(params.visibility) : normalizeVisibility(character.visibility)
    if (nextVisibility === 'public') {
      const campaign = await this.campaigns.get(character.campaignId)
      if (!campaign) throw new NotFoundException('Campanha não encontrada')
      if (normalizeVisibility(campaign.visibility) !== 'public') {
        throw new BadRequestException('Personagens públicos exigem uma campanha pública.')
      }
    }

    const normalizedHindrances = validateHindrances(params.hindrances ?? [])
    const allocation = params.hindranceAllocation ?? { extraEdges: 0, extraAttributePoints: 0, extraSkillPoints: 0 }
    validateHindranceAllocation(normalizedHindrances, allocation)

    const normalizedAttributes = validateSWAttributes(params.attributes, allocation.extraAttributePoints)
    const normalizedSkills = validateSWSkills(params.skills ?? {}, allocation.extraSkillPoints)
    const normalizedEdges = (params.edges ?? []).map(e => String(e).trim()).filter(Boolean)

    const normalizedImage = params.image
      ? await this.normalizeStoredImageByHint({ image: params.image, kind: 'character' })
      : undefined
    const normalizedSheetValues = sanitizeSheetValues(params.sheetValues)

    await this.characters.update({
      characterId: params.characterId,
      name: params.name,
      gender: params.gender?.trim() ?? '',
      race: params.race?.trim() ?? '',
      characterClass: params.characterClass,
      profession: params.profession,
      description: params.description?.trim() ?? '',
      visibility: params.visibility ? normalizeVisibility(params.visibility) : undefined,
      attributes: normalizedAttributes,
      skills: normalizedSkills,
      edges: normalizedEdges,
      hindrances: normalizedHindrances,
      sheetValues: normalizedSheetValues,
      hindranceAllocation: allocation,
      image: normalizedImage
    })

    return { ok: true }
  }
}