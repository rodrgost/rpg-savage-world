import { BadRequestException, Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common'
import { z } from 'zod'

import { GameDataService } from './game-data.service.js'
import { CurrentUser } from '../../auth/current-user.decorator.js'

// ─── Shared ────────────────────────────────────────────────────

const StoredImageBody = z
  .object({
    mimeType: z.string().min(1),
    base64: z.string().min(1)
  })
  .strict()

const VisibilityBody = z.enum(['private', 'public']).default('private')

const HindranceBody = z.object({
  name: z.string().min(1),
  severity: z.enum(['minor', 'major'])
})

const HindranceAllocationBody = z.object({
  extraEdges: z.number().int().min(0).default(0),
  extraAttributePoints: z.number().int().min(0).default(0),
  extraSkillPoints: z.number().int().min(0).default(0),
}).default({ extraEdges: 0, extraAttributePoints: 0, extraSkillPoints: 0 })

// ─── Campaign (campanha dentro de um mundo) ───────────────

const StoryCharacterBody = z.object({
  name: z.string().min(1),
  role: z.string().min(1),
  description: z.string().default(''),
  status: z.string().default('desconhecido')
})

const CreateCampaignBody = z.object({
  worldId: z.string().min(1),
  name: z.string().optional(),
  storyDescription: z.string().optional(),
  storyCharacters: z.array(StoryCharacterBody).min(0).max(7).optional(),
  visibility: VisibilityBody.optional(),
  image: StoredImageBody.optional(),
  youtubeUrl: z.string().url().optional().or(z.literal(''))
})

const UpdateCampaignBody = z.object({
  name: z.string().min(1).optional(),
  storyDescription: z.string().optional().default(''),
  storyCharacters: z.array(StoryCharacterBody).min(0).max(7).optional(),
  visibility: VisibilityBody.optional(),
  image: StoredImageBody.optional(),
  youtubeUrl: z.string().url().optional().or(z.literal(''))
})

const IncrementCampaignPreviewBody = z.object({
  worldName: z.string().min(1)
})

const CampaignImagePreviewBody = z
  .object({
    name: z.string().min(1).optional()
  })
  .strict()

// ─── World (universo / cenário) ────────────────────────────────

const CreateWorldBody = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(''),
  lore: z.string().optional().default(''),
  ruleSetId: z.string().optional(),
  visibility: VisibilityBody.optional(),
  image: StoredImageBody.optional()
})

const UpdateWorldBody = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  lore: z.string().optional(),
  ruleSetId: z.string().optional(),
  visibility: VisibilityBody.optional(),
  image: StoredImageBody.optional()
})

const WorldImagePreviewBody = z
  .object({
    name: z.string().min(1)
  })
  .strict()

// ─── (Adventure schemas removed — Campaign schemas defined above) ───

// ─── Character ─────────────────────────────────────────────────

const CreateCharacterBody = z.object({
  campaignId: z.string().min(1),
  name: z.string().min(1),
  gender: z.string().optional().default(''),
  race: z.string().optional().default(''),
  profession: z.string().min(1),
  description: z.string().optional(),
  campaignRole: z.string().optional(),
  visibility: VisibilityBody.optional(),
  attributes: z.record(z.string(), z.number()).default({}),
  skills: z.record(z.string(), z.number()).default({}),
  edges: z.array(z.string()).default([]),
  hindrances: z.array(HindranceBody).default([]),
  hindranceAllocation: HindranceAllocationBody,
  sheetValues: z.record(z.string(), z.unknown()).default({}),
  image: StoredImageBody.optional()
})

const UpdateCharacterBody = z.object({
  name: z.string().min(1),
  gender: z.string().optional().default(''),
  race: z.string().optional().default(''),
  profession: z.string().min(1),
  description: z.string().optional(),
  campaignRole: z.string().optional(),
  visibility: VisibilityBody.optional(),
  attributes: z.record(z.string(), z.number()).default({}),
  skills: z.record(z.string(), z.number()).default({}),
  edges: z.array(z.string()).default([]),
  hindrances: z.array(HindranceBody).default([]),
  hindranceAllocation: HindranceAllocationBody,
  sheetValues: z.record(z.string(), z.unknown()).default({}),
  image: StoredImageBody.optional()
})

const CharacterImagePreviewBody = z
  .object({
    campaignId: z.string().min(1),
    gender: z.string().optional().default(''),
    race: z.string().optional().default(''),
    profession: z.string().min(1),
    additionalDescription: z.string().optional()
  })
  .strict()

const CharacterSuggestionBody = z
  .object({
    campaignId: z.string().min(1),
    existingFields: z.object({
      name: z.string().optional(),
      gender: z.string().optional(),
      race: z.string().optional(),
      profession: z.string().optional(),
      description: z.string().optional(),
      campaignRole: z.string().optional(),
    }).optional()
  })
  .strict()

const CharacterFromDescriptionBody = z
  .object({
    campaignId: z.string().min(1),
    characterConcept: z.string().min(10).max(1000)
  })
  .strict()
// ─── NPC Catalog (catálogo de NPCs do mundo) ───────────────

const NpcDefinitionBody = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  isWildCard: z.boolean().default(false),
  dispositionDefault: z.enum(['hostile', 'neutral', 'friendly']),
  toughness: z.number().int().min(1).max(30),
  parry: z.number().int().min(1).max(30),
  armor: z.number().int().min(0).max(20).optional(),
  pace: z.number().int().min(1).max(20).optional(),
  maxWounds: z.number().int().min(1).max(10).optional(),
  bennies: z.number().int().min(0).max(10).optional(),
  skills: z.record(z.string(), z.number().int()).optional(),
  attributes: z.object({
    agility: z.number().int().optional(),
    smarts: z.number().int().optional(),
    spirit: z.number().int().optional(),
    strength: z.number().int().optional(),
    vigor: z.number().int().optional()
  }).optional(),
  tags: z.array(z.string()).optional()
})
// ─── Controller ────────────────────────────────────────────────

@Controller()
export class GameDataController {
  constructor(@Inject(GameDataService) private readonly gameData: GameDataService) {}

  // ── Campaigns ────────────────────────────────

  @Post('/campaigns')
  async createCampaign(@CurrentUser('uid') userId: string, @Body() body: unknown) {
    const parsed = CreateCampaignBody.parse(body)
    return await this.gameData.createCampaign({ userId, ...parsed })
  }

  @Get('/campaigns')
  async listCampaigns(
    @CurrentUser('uid') userId: string,
    @Query('worldId') worldId: string | undefined
  ) {
    return await this.gameData.listCampaigns({ userId, worldId })
  }

  @Get('/campaigns/:campaignId')
  async getCampaign(@CurrentUser('uid') userId: string, @Param('campaignId') campaignId: string) {
    return await this.gameData.getCampaign({ userId, campaignId })
  }

  @Put('/campaigns/:campaignId')
  async updateCampaign(
    @CurrentUser('uid') userId: string,
    @Param('campaignId') campaignId: string,
    @Body() body: unknown
  ) {
    const parsed = UpdateCampaignBody.parse(body)
    return await this.gameData.updateCampaign({ userId, campaignId, ...parsed })
  }

  @Delete('/campaigns/:campaignId')
  async deleteCampaign(@CurrentUser('uid') userId: string, @Param('campaignId') campaignId: string) {
    return await this.gameData.deleteCampaign({ userId, campaignId })
  }

  @Post('/campaigns/increment-preview')
  async incrementCampaignPreview(@CurrentUser('uid') userId: string, @Body() body: unknown) {
    const parsed = IncrementCampaignPreviewBody.parse(body)
    return await this.gameData.generateCampaignStoryPreview({ userId, ...parsed })
  }

  @Post('/campaigns/:campaignId/increment')
  async incrementCampaign(@CurrentUser('uid') userId: string, @Param('campaignId') campaignId: string) {
    return await this.gameData.incrementCampaignStory({ userId, campaignId })
  }

  @Post('/campaigns/image-preview')
  async campaignImagePreview(@CurrentUser('uid') userId: string, @Body() body: unknown) {
    const parsed = CampaignImagePreviewBody.parse(body)
    return await this.gameData.generateCampaignImagePreview({ userId, ...parsed })
  }

  // ── Worlds (universo / cenário) ──────────────

  @Post('/worlds')
  async createWorld(@CurrentUser('uid') userId: string, @Body() body: unknown) {
    const parsed = CreateWorldBody.parse(body)
    return await this.gameData.createWorld({ userId, ...parsed })
  }

  @Get('/worlds')
  async listWorlds(@CurrentUser('uid') userId: string) {
    return await this.gameData.listWorlds({ userId })
  }

  @Get('/worlds/:worldId')
  async getWorld(@CurrentUser('uid') userId: string, @Param('worldId') worldId: string) {
    return await this.gameData.getWorld({ userId, worldId })
  }

  @Put('/worlds/:worldId')
  async updateWorld(
    @CurrentUser('uid') userId: string,
    @Param('worldId') worldId: string,
    @Body() body: unknown
  ) {
    const parsed = UpdateWorldBody.parse(body)
    return await this.gameData.updateWorld({ userId, worldId, ...parsed })
  }

  @Post('/worlds/image-preview')
  async worldImagePreview(@CurrentUser('uid') userId: string, @Body() body: unknown) {
    const parsed = WorldImagePreviewBody.parse(body)
    return await this.gameData.generateWorldImagePreview({ userId, ...parsed })
  }

  @Delete('/worlds/:worldId')
  async deleteWorld(@CurrentUser('uid') userId: string, @Param('worldId') worldId: string) {
    return await this.gameData.deleteWorld({ userId, worldId })
  }

  @Post('/worlds/:worldId/generate-lore')
  async generateWorldLore(@CurrentUser('uid') userId: string, @Param('worldId') worldId: string) {
    return await this.gameData.generateWorldLore({ userId, worldId })
  }

  // ── Characters ───────────────────────────────

  @Post('/characters')
  async createCharacter(@CurrentUser('uid') userId: string, @Body() body: unknown) {
    const parsed = CreateCharacterBody.parse(body)
    return await this.gameData.createCharacter({ userId, ...parsed })
  }

  @Get('/characters')
  async listCharacters(
    @CurrentUser('uid') userId: string,
    @Query('campaignId') campaignId: string | undefined
  ) {
    return await this.gameData.listCharacters({ userId, campaignId })
  }

  @Get('/characters/:characterId')
  async getCharacter(@CurrentUser('uid') userId: string, @Param('characterId') characterId: string) {
    return await this.gameData.getCharacter({ userId, characterId })
  }

  @Put('/characters/:characterId')
  async updateCharacter(
    @CurrentUser('uid') userId: string,
    @Param('characterId') characterId: string,
    @Body() body: unknown
  ) {
    const parsed = UpdateCharacterBody.parse(body)
    return await this.gameData.updateCharacter({ userId, characterId, ...parsed })
  }

  @Delete('/characters/:characterId')
  async deleteCharacter(@CurrentUser('uid') userId: string, @Param('characterId') characterId: string) {
    return await this.gameData.deleteCharacter({ userId, characterId })
  }

  @Post('/characters/image-preview')
  async characterImagePreview(@CurrentUser('uid') userId: string, @Body() body: unknown) {
    const parsed = CharacterImagePreviewBody.parse(body)
    return await this.gameData.generateCharacterImagePreview({ userId, ...parsed })
  }

  @Post('/characters/suggest-from-world')
  async suggestCharacterFromWorld(@CurrentUser('uid') userId: string, @Body() body: unknown) {
    const parsed = CharacterSuggestionBody.parse(body)
    return await this.gameData.suggestCharacterFromWorld({ userId, ...parsed })
  }

  @Post('/characters/suggest-from-description')
  async suggestCharacterFromDescription(@CurrentUser('uid') userId: string, @Body() body: unknown) {
    const parsed = CharacterFromDescriptionBody.parse(body)
    return await this.gameData.suggestCharacterFromDescription({ userId, ...parsed })
  }

  // ── NPC Catalog ────────────────────────────

  @Get('/worlds/:worldId/npcs')
  async listWorldNpcs(@CurrentUser('uid') userId: string, @Param('worldId') worldId: string) {
    return await this.gameData.listWorldNpcs({ userId, worldId })
  }

  @Post('/worlds/:worldId/npcs')
  async createWorldNpc(
    @CurrentUser('uid') userId: string,
    @Param('worldId') worldId: string,
    @Body() body: unknown
  ) {
    const npc = NpcDefinitionBody.parse(body)
    return await this.gameData.upsertWorldNpc({ userId, worldId, npc: npc as import('../../domain/types/gameState.js').NpcDefinition })
  }

  @Put('/worlds/:worldId/npcs/:npcId')
  async updateWorldNpc(
    @CurrentUser('uid') userId: string,
    @Param('worldId') worldId: string,
    @Param('npcId') npcId: string,
    @Body() body: unknown
  ) {
    const npc = NpcDefinitionBody.parse(body)
    if (npc.id !== npcId) throw new BadRequestException('npcId no path deve corresponder ao id no body')
    return await this.gameData.upsertWorldNpc({ userId, worldId, npc: npc as import('../../domain/types/gameState.js').NpcDefinition })
  }

  @Delete('/worlds/:worldId/npcs/:npcId')
  async deleteWorldNpc(
    @CurrentUser('uid') userId: string,
    @Param('worldId') worldId: string,
    @Param('npcId') npcId: string
  ) {
    return await this.gameData.deleteWorldNpc({ userId, worldId, npcId })
  }
}