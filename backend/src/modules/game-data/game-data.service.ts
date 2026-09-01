import { Injectable, NotFoundException, ForbiddenException, BadRequestException, ServiceUnavailableException } from '@nestjs/common'
import { randomUUID } from 'node:crypto'

import { CampaignsRepo } from '../../repositories/campaigns.repo.js'
import { WorldsRepo, type Visibility } from '../../repositories/worlds.repo.js'
import { CharactersRepo } from '../../repositories/characters.repo.js'
import { GeminiAdapter } from '../../llm/gemini.adapter.js'
import type { CampaignMission } from '../../llm/narrator.js'
import { GeminiImageGenerator } from '../../llm/gemini-image.generator.js'
import { normalizeToWebp, type StoredImage } from '../../utils/image-normalize.js'
import { isDieType, CHARACTER_CREATION, ATTRIBUTE_KEYS } from '../../domain/savage-worlds/constants.js'
import type { DieType, Hindrance, NpcDefinition, RelationalStatus } from '../../domain/types/gameState.js'
import type { WorldGuide } from '../../domain/types/world-guide.js'
import { renderWorldGuideMarkdown } from '../../domain/types/world-guide.js'
import { KnownNpcsRepo } from '../../repositories/knownNpcs.repo.js'
import { firebaseAuth, firestore } from '../../infrastructure/firebase.js'
import { log, warn } from '../../utils/file-logger.js'

function sanitizeInlineText(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ')
}

function buildWorldImagePrompt(params: { campaignName?: string; visualDescription?: string }): string {
  const campaignName = sanitizeInlineText(params.campaignName)
  const visualDescription = sanitizeInlineText(params.visualDescription)
  const title = campaignName || 'Campanha sem titulo'

  return [
    'Crie uma key art ilustrada.',
    `Ancora de titulo da campanha: "${title}".`,
    ...(visualDescription ? [`Direcao visual: ${visualDescription}.`] : []),
    'Objetivos de composicao: paisagem epica ou vista de assentamento, sensacao clara de escala, profundidade em camadas, clima e narrativa visual guiados pelo proprio cenario.',
    `Integracao de titulo: renderize APENAS o nome exato da campanha "${title}" como tipografia legivel de capa/poster dentro da arte. Mantenha todas as letras dentro da zona segura central de 80%, sem subtitulos, slogans, logos, marcas-d\'agua, UI ou palavras extras.`,
    'Restricoes: sem UI, sem personagens como assunto principal.'
  ].join('\n')
}

function buildUniverseImagePrompt(params: { name: string; visualDescription?: string }): string {
  const worldName = sanitizeInlineText(params.name)
  const visualDescription = sanitizeInlineText(params.visualDescription)

  return [
    'Crie uma key art ilustrada cinematografica.',
    `Ancora de cenario: nome do mundo "${worldName || 'Mundo sem nome'}".`,
    ...(visualDescription ? [`Direcao visual: ${visualDescription}.`] : []),
    'Objetivos de composicao: paisagem epica ou vista de assentamento, sensacao clara de escala, profundidade em camadas, clima e narrativa visual — a imagem INTEIRA deve ser guiada pelo tema e pela estetica deste cenario.',
    'Referencia de capa: se o nome do mundo evocar uma franquia conhecida de filme, serie, jogo, quadrinho ou livro, baseie a imagem INTEIRA — paleta, atmosfera, iluminacao, composicao e estilo visual — na estetica da capa ou poster oficial. A referencia tematica define tudo: color grading, design ambiental, clima e direcao de arte.',
    `Integracao de titulo: renderize APENAS o nome exato "${worldName}" — sem subtitulos, sem slogans, sem palavras extras. Estilize como titulo de capa de livro ou poster de filme: tipografia, posicionamento, tamanho e elementos decorativos devem corresponder a identidade visual e ao tema do cenario. Mantenha TODO o texto do titulo estritamente dentro da zona segura central de 80% da imagem, sem tocar ou ultrapassar qualquer borda.`,
    'Restricoes: sem logos, sem marcas-d\'agua, sem UI, sem rostos em close, sem personagens como assunto principal, sem marcas registradas externas ou avisos de copyright.'
  ].join('\n')
}

function buildCharacterImagePrompt(params: {
  worldName: string
  campaignName?: string
  gender?: string
  race?: string
  profession: string
  additionalDescription?: string
  visualDescription?: string
}): string {
  const worldName = sanitizeInlineText(params.worldName)
  const campaignName = sanitizeInlineText(params.campaignName)
  const gender = sanitizeInlineText(params.gender)
  const race = sanitizeInlineText(params.race)
  const profession = sanitizeInlineText(params.profession)
  const additional = sanitizeInlineText(params.additionalDescription)
  const visualDescription = sanitizeInlineText(params.visualDescription)

  return [
    'Crie uma ilustracao de retrato de personagem de RPG.',
    'Estilo: alta qualidade, enquadramento de busto.',
    'Regras: sem marcas-d\'agua, sem tipografia, seguro para todos os publicos.',
    `Cenario: ${worldName || 'Mundo desconhecido'}${campaignName ? `, ${campaignName}` : ''}.`,
    ...(gender ? [`Genero: ${gender}.`] : []),
    ...(race ? [`Raca/Especie: ${race}.`] : []),
    `Profissao: ${profession || 'Viajante'}.`,
    ...(additional ? [`Detalhes visuais: ${additional}.`] : []),
    ...(visualDescription ? [`Direcao visual: ${visualDescription}.`] : []),
    'Composicao: personagem centralizado, iluminacao quente, totalmente vestido.'
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
  private readonly knownNpcs = new KnownNpcsRepo()
  private readonly narrator = new GeminiAdapter()
  private readonly imageGenerator = new GeminiImageGenerator()

  private async buildVisualDescription(params:
    | { entityType: 'world'; title: string }
    | { entityType: 'campaign'; title: string; storyDescription?: string }
    | {
        entityType: 'character'
        worldName: string
        campaignTitle: string
        gender?: string
        race?: string
        profession: string
        additionalDescription?: string
      }): Promise<string | undefined> {
    try {
      const description = await this.narrator.generateImageDescription(params)
      return description.trim() || undefined
    } catch {
      return undefined
    }
  }

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
    const safeCharacter: Record<string, unknown> = { ...character }
    delete safeCharacter[['character', 'Class'].join('')]

    return {
      ...safeCharacter,
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
    worldGuide?: WorldGuide
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
      worldGuide: params.worldGuide,
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
    worldGuide?: WorldGuide
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
      worldGuide: params.worldGuide,
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

    const visualDescription = await this.buildVisualDescription({ entityType: 'world', title: name })

    const generated = await this.imageGenerator.generateImage({
      prompt: buildUniverseImagePrompt({ name, visualDescription }),
      width: 768,
      height: 432,
      mimeType: 'image/webp'
    })

    const normalized = await this.normalizeWorldImage({ mimeType: generated.mimeType, base64: generated.base64 })
    return { image: normalized }
  }

  async generateWorldGuide(params: { userId: string; worldId: string; userInstruction?: string }) {
    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (world.ownerId !== params.userId) throw new ForbiddenException('Sem permissão para este mundo')

    const result = await this.narrator.generateWorldGuide({
      name: world.name,
      description: world.description,
      currentGuide: world.worldGuide,
      userInstruction: params.userInstruction?.trim() || undefined
    })

    await this.worlds.updateWorldGuide(world.id, result.worldGuide)
    return { worldGuide: result.worldGuide }
  }

  // ─── Campaign (campanha dentro de um mundo) ───

  async createCampaign(params: {
    userId: string
    worldId: string
    name?: string
    storyDescription?: string
    storyDescriptionEn?: string
    storyDetails?: string
    storyDetailsEn?: string
    storyMissions?: CampaignMission[]
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
      name: params.name,
      storyDescription: params.storyDescription?.trim() ?? '',
      storyDescriptionEn: params.storyDescriptionEn?.trim() || undefined,
      storyDetails: params.storyDetails?.trim() || undefined,
      storyDetailsEn: params.storyDetailsEn?.trim() || undefined,
      storyMissions: params.storyMissions,
      image: normalizedImage,
      youtubeUrl: params.youtubeUrl
    })

    return { campaignId }
  }

  async generateCampaignStoryPreview(params: { userId: string; worldName: string; worldId?: string }) {
    let worldGuideContext: string | undefined
    if (params.worldId) {
      const world = await this.worlds.get(params.worldId)
      worldGuideContext = renderWorldGuideMarkdown(world?.worldGuide) || undefined
    }
    const result = await this.narrator.expandAdventureStory({
      campaignName: params.worldName,
      worldGuideContext
    })

    return {
      storyDescription: result.storyDescription,
      storyDescriptionEn: result.storyDescriptionEn,
      storyDetails: result.storyDetails,
      storyDetailsEn: result.storyDetailsEn,
      storyMissions: result.storyMissions,
      storyCharacters: result.storyCharacters,
      name: result.name
    }
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

    // N:M: personagens pertencem ao Mundo, não à campanha — não bloqueiam mais a exclusão.
    // Apenas Playthroughs (sessions) desta campanha bloqueiam.
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
    name?: string
    storyDescription: string
    storyDescriptionEn?: string
    storyDetails?: string
    storyDetailsEn?: string
    storyMissions?: CampaignMission[]
    storyCharacters?: Array<{ name: string; role: string; description: string; status: string }>
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

    // N:M: a visibilidade do personagem é governada pelo Mundo, não pela campanha.
    // Privatizar a campanha não exige mais privatizar personagens.

    const normalizedImage = params.image
      ? await this.normalizeStoredImageByHint({ image: params.image, kind: 'world' })
      : undefined

    await this.campaigns.updateCampaign({
      campaignId: params.campaignId,
      name: params.name?.trim() || undefined,
      storyDescription: params.storyDescription?.trim() ?? '',
      storyDescriptionEn: params.storyDescriptionEn?.trim() || undefined,
      storyDetails: params.storyDetails?.trim() || undefined,
      storyDetailsEn: params.storyDetailsEn?.trim() || undefined,
      storyMissions: params.storyMissions,
      storyCharacters: params.storyCharacters,
      visibility: params.visibility ? normalizeVisibility(params.visibility) : undefined,
      image: normalizedImage,
      youtubeUrl: params.youtubeUrl
    })

    return { ok: true }
  }

  async generateCampaignImagePreview(params: {
    userId: string
    name?: string
    storyDescription?: string
    worldId?: string
  }): Promise<{ image: StoredImage }> {
    const campaignName = params.name?.trim() ?? ''

    let storyContext = params.storyDescription?.trim() || undefined
    if (!storyContext && params.worldId) {
      const world = await this.worlds.get(params.worldId)
      storyContext = renderWorldGuideMarkdown(world?.worldGuide) || undefined
    }

    const visualDescription = await this.buildVisualDescription({ entityType: 'campaign', title: campaignName || 'Unnamed campaign', storyDescription: storyContext })

    const generated = await this.imageGenerator.generateImage({
      prompt: buildWorldImagePrompt({ campaignName, visualDescription }),
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

    const result = await this.narrator.expandAdventureStory({
      campaignName: campaign.name?.trim() || worldName,
      worldGuideContext: renderWorldGuideMarkdown(world?.worldGuide) || undefined
    })

    await this.campaigns.updateStoryDescription(
      campaign.id,
      result.storyDescription,
      result.storyCharacters,
      result.storyDescriptionEn,
      result.storyDetails,
      result.storyDetailsEn,
      result.storyMissions
    )
    return {
      storyDescription: result.storyDescription,
      storyDescriptionEn: result.storyDescriptionEn,
      storyDetails: result.storyDetails,
      storyDetailsEn: result.storyDetailsEn,
      storyMissions: result.storyMissions,
      storyCharacters: result.storyCharacters
    }
  }

  async createCharacter(params: {
    userId: string
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
    hindrances?: unknown[]
    hindranceAllocation?: { extraEdges: number; extraAttributePoints: number; extraSkillPoints: number }
    sheetValues?: Record<string, unknown>
    image?: StoredImage
  }) {
    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (!this.canReadResource({ ownerId: world.ownerId, visibility: world.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para este mundo')
    }

    const visibility = normalizeVisibility(params.visibility)
    if (visibility === 'public' && normalizeVisibility(world.visibility) !== 'public') {
      throw new BadRequestException('Personagens públicos exigem um mundo público.')
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

    const characterId = randomUUID()
    await this.characters.create({
      characterId,
      worldId: params.worldId,
      ownerId: params.userId,
      visibility,
      name: params.name,
      gender: params.gender?.trim() ?? '',
      race: params.race?.trim() ?? '',
      profession: params.profession,
      description: params.description?.trim() ?? '',
      campaignRole: params.campaignRole?.trim() ?? '',
      genderEn: params.genderEn?.trim() || undefined,
      raceEn: params.raceEn?.trim() || undefined,
      professionEn: params.professionEn?.trim() || undefined,
      descriptionEn: params.descriptionEn?.trim() || undefined,
      campaignRoleEn: params.campaignRoleEn?.trim() || undefined,
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
    worldId: string
    gender?: string
    race?: string
    profession: string
    additionalDescription?: string
  }): Promise<{ image: StoredImage }> {
    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (!this.canReadResource({ ownerId: world.ownerId, visibility: world.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para este mundo')
    }

    const worldName = world.name ?? 'Mundo desconhecido'
    const campaignName = ''
    const visualDescription = await this.buildVisualDescription({
      entityType: 'character',
      worldName,
      campaignTitle: campaignName,
      gender: params.gender,
      race: params.race,
      profession: params.profession,
      additionalDescription: params.additionalDescription
    })

    const generated = await this.imageGenerator.generateImage({
      prompt: buildCharacterImagePrompt({
        worldName,
        campaignName,
        gender: params.gender,
        race: params.race,
        profession: params.profession,
        additionalDescription: params.additionalDescription,
        visualDescription
      }),
      width: 512,
      height: 512,
      mimeType: 'image/webp'
    })

    const normalized = await this.normalizeCharacterImage({ mimeType: generated.mimeType, base64: generated.base64 })
    return { image: normalized }
  }

  async listCharacters(params: { userId: string; worldId?: string }) {
    const characters = await this.characters.listAccessible({ userId: params.userId, worldId: params.worldId })
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
    worldId: string
    existingFields?: {
      name?: string
      gender?: string
      race?: string
      profession?: string
      description?: string
      campaignRole?: string
    }
  }) {
    const typedName = params.existingFields?.name?.trim() ?? ''
    const existingFields = typedName ? { name: typedName } : undefined

    log('suggestCharacterFromWorld', 'request received', {
      worldId: params.worldId,
      userId: params.userId,
      existingFields: Object.keys(existingFields ?? {})
    })

    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (!this.canReadResource({ ownerId: world.ownerId, visibility: world.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para este mundo')
    }

    const worldName = world.name?.trim() ?? ''
    if (!world.worldGuide) {
      warn('suggestCharacterFromWorld', `Mundo sem worldGuide para worldId=${params.worldId}`)
      throw new BadRequestException('Este mundo ainda não possui guia para gerar personagem.')
    }
    // N:M: a sugestão usa apenas o lore do Mundo como contexto.
    // storyDescription fica vazio para não duplicar o lore no prompt (Universe lore == Adventure story).
    const storyDescription = ''

    log('suggestCharacterFromWorld', 'context ready', {
      worldId: params.worldId,
      worldName,
      storyLength: storyDescription.length,
      hasWorldGuide: Boolean(world.worldGuide)
    })

    try {
      const suggestion = await this.narrator.suggestCharacterFromWorld({
        worldName,
        storyDescription,
        worldGuide: world.worldGuide,
        existingFields
      })

      const name = (typedName || suggestion.name).trim()
      const gender = (suggestion.gender || '').trim()
      const race = (suggestion.race || '').trim()
      const profession = suggestion.profession.trim()
      const description = suggestion.description.trim()
      const campaignRole = (suggestion.campaignRole || '').trim()

      if (!name || !profession || description.length < 80) {
        throw new Error('O provedor de IA retornou uma sugestão incompleta.')
      }

      log('suggestCharacterFromWorld', 'suggestion ready', {
        worldId: params.worldId,
        hasName: Boolean(name),
        hasProfession: Boolean(profession),
        descriptionLength: description.length,
        campaignRoleLength: campaignRole.length
      })

      return {
        name,
        gender,
        race,
        profession,
        description,
        campaignRole,
        genderPt: suggestion.genderPt,
        racePt: suggestion.racePt,
        professionPt: suggestion.professionPt,
        descriptionPt: suggestion.descriptionPt,
        campaignRolePt: suggestion.campaignRolePt,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido'
      warn('suggestCharacterFromWorld', `Falha ao gerar sugestão por IA para worldId=${params.worldId}: ${message}`)
      throw new ServiceUnavailableException(`Falha ao gerar personagem com IA: ${message}`)
    }
  }

  async suggestCharacterFromDescription(params: {
    userId: string
    worldId: string
    characterConcept: string
  }) {
    if (!params.characterConcept?.trim()) {
      throw new BadRequestException('Informe uma descrição do personagem.')
    }

    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (!this.canReadResource({ ownerId: world.ownerId, visibility: world.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para este mundo')
    }

    const worldName = world.name?.trim() ?? ''
    const campaignName = ''
    const storyDescription = ''

    try {
      const suggestion = await this.narrator.suggestCharacterFromDescription({
        characterConcept: params.characterConcept.trim(),
        worldName,
        worldGuide: world.worldGuide,
        campaignThematic: campaignName,
        storyDescription
      })

      if (!suggestion.name || !suggestion.profession || suggestion.description.length < 80) {
        throw new Error('O provedor de IA retornou uma sugestão incompleta.')
      }

      return {
        name: suggestion.name.trim(),
        gender: (suggestion.gender || '').trim(),
        race: (suggestion.race || '').trim(),
        profession: suggestion.profession.trim(),
        description: suggestion.description.trim(),
        campaignRole: (suggestion.campaignRole || '').trim(),
        genderPt: suggestion.genderPt,
        racePt: suggestion.racePt,
        professionPt: suggestion.professionPt,
        descriptionPt: suggestion.descriptionPt,
        campaignRolePt: suggestion.campaignRolePt,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'erro desconhecido'
      throw new ServiceUnavailableException(`Falha ao gerar personagem com IA: ${message}`)
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
    profession: string
    description?: string
    campaignRole?: string
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
      // Personagem pertence ao Mundo: visibilidade pública exige Mundo público.
      const world = character.worldId ? await this.worlds.get(character.worldId) : null
      if (!world) throw new NotFoundException('Mundo não encontrado')
      if (normalizeVisibility(world.visibility) !== 'public') {
        throw new BadRequestException('Personagens públicos exigem um mundo público.')
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
      profession: params.profession,
      description: params.description?.trim() ?? '',
      campaignRole: params.campaignRole?.trim() ?? '',
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

  // ─── NPC Catalog (catálogo de NPCs do mundo) ───

  // ── Known NPCs (NPCs conhecidos do personagem) ──

  private async requireOwnedCharacter(params: { userId: string; characterId: string }) {
    const character = await this.characters.get(params.characterId)
    if (!character) throw new NotFoundException('Personagem não encontrado')
    if (getCharacterOwnerId(character) !== params.userId) {
      throw new ForbiddenException('Sem permissão para este personagem')
    }
    return character
  }

  async listKnownNpcs(params: { userId: string; characterId: string }) {
    await this.requireOwnedCharacter(params)
    const knownNpcs = await this.knownNpcs.listByCharacter(params.characterId)
    return { knownNpcs }
  }

  async updateKnownNpc(params: {
    userId: string
    characterId: string
    npcId: string
    relationalStatus?: RelationalStatus
    notes?: string
    resetToAuto?: boolean
  }) {
    await this.requireOwnedCharacter(params)
    const knownNpc = await this.knownNpcs.updateManual(params.characterId, params.npcId, {
      relationalStatus: params.relationalStatus,
      notes: params.notes,
      resetToAuto: params.resetToAuto
    })
    if (!knownNpc) throw new NotFoundException('NPC conhecido não encontrado')
    return { ok: true, knownNpc }
  }

  async listWorldNpcs(params: { userId: string; worldId: string }) {
    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (!this.canReadResource({ ownerId: world.ownerId, visibility: world.visibility, userId: params.userId })) {
      throw new ForbiddenException('Sem permissão para este mundo')
    }
    return { npcs: world.npcCatalog ?? [] }
  }

  async upsertWorldNpc(params: { userId: string; worldId: string; npc: NpcDefinition }) {
    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (world.ownerId !== params.userId) throw new ForbiddenException('Sem permissão para este mundo')

    const catalog = [...(world.npcCatalog ?? [])]
    const existingIndex = catalog.findIndex((n) => n.id === params.npc.id)
    if (existingIndex >= 0) {
      catalog[existingIndex] = params.npc
    } else {
      if (catalog.length >= 200) throw new BadRequestException('Limite de 200 NPCs por mundo atingido')
      catalog.push(params.npc)
    }

    await this.worlds.updateNpcCatalog(params.worldId, catalog)
    return { ok: true, npc: params.npc }
  }

  async deleteWorldNpc(params: { userId: string; worldId: string; npcId: string }) {
    const world = await this.worlds.get(params.worldId)
    if (!world) throw new NotFoundException('Mundo não encontrado')
    if (world.ownerId !== params.userId) throw new ForbiddenException('Sem permissão para este mundo')

    const catalog = (world.npcCatalog ?? []).filter((n) => n.id !== params.npcId)
    await this.worlds.updateNpcCatalog(params.worldId, catalog)
    return { ok: true }
  }
}