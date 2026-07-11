import { Body, Controller, Delete, Get, HttpException, Inject, Param, Patch, Post, Put, Res } from '@nestjs/common'
import type { Response } from 'express'
import { z } from 'zod'
import { SessionService } from './session.service.js'
import { CurrentUser } from '../../auth/current-user.decorator.js'
import { error as logError } from '../../utils/file-logger.js'
import { getNarrationLog } from '../../services/narrationLog.js'

const StartSessionBody = z.object({
  campaignId: z.string().min(1),
  characterId: z.string().min(1),
  narrativeStyle: z.enum(['concise', 'balanced']).optional(),
  simpleVocabulary: z.boolean().optional()
})

const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('travel'), to: z.string().min(1) }),
  z.object({ type: z.literal('flag'), key: z.string().min(1), value: z.boolean() }),
  z.object({
    type: z.literal('trait_test'),
    skill: z.string().min(1).optional(),
    attribute: z.string().min(1).optional(),
    modifier: z.number().int().default(0),
    description: z.string().optional()
  }),
  z.object({
    type: z.literal('attack'),
    skill: z.string().min(1).default('Luta'),
    targetId: z.string().min(1),
    modifier: z.number().int().default(0),
    damageFormula: z.string().optional(),
    ap: z.number().int().default(0)
  }),
  z.object({ type: z.literal('soak_roll') }),
  z.object({ type: z.literal('spend_benny'), purpose: z.enum(['reroll', 'soak', 'unshake']).default('reroll') }),
  z.object({ type: z.literal('recover_shaken') }),
  z.object({ type: z.literal('custom'), input: z.string().min(1) })
])

const ApplyTurnBody = z.object({
  action: ActionSchema,
  displayText: z.string().min(1).optional()
})

const ChooseOptionBody = z.object({
  optionId: z.string().min(1)
})

const EquipItemBody = z.object({
  itemId: z.string().min(1)
})

function flushIfSupported(res: Response): void {
  const maybeFlush = Reflect.get(res as object, 'flush')
  if (typeof maybeFlush === 'function') {
    maybeFlush.call(res)
  }
}

const defaultStreamErrorMessage = 'Erro interno no servidor'

function logStreamError(route: string, sessionId: string, userId: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err)
  logError('session.controller.stream', { route, sessionId, userId, reason })
}

/**
 * Erros esperados (validação de negócio: sessão não encontrada, opção
 * inexistente, permissão etc.) usam as exceptions do Nest (NotFoundException e
 * afins, todas HttpException) com uma mensagem já pensada pra ser lida pelo
 * jogador. Erros inesperados (crash, falha de rede/LLM) continuam com a
 * mensagem genérica, pra não vazar detalhe interno de stack/exception pro
 * cliente.
 */
function resolveStreamErrorMessage(err: unknown): string {
  if (err instanceof HttpException) return err.message
  return defaultStreamErrorMessage
}

function resolveStreamErrorStatus(err: unknown): number {
  if (err instanceof HttpException) return err.getStatus()
  return 500
}

@Controller('/sessions')
export class SessionController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  @Post('/start')
  async create(@CurrentUser('uid') userId: string, @Body() body: unknown) {
    const parsed = StartSessionBody.parse(body)
    return await this.sessions.createSession({
      ownerId: userId,
      campaignId: parsed.campaignId,
      characterId: parsed.characterId,
      narrativeStyle: parsed.narrativeStyle,
      simpleVocabulary: parsed.simpleVocabulary
    })
  }

  /** Playthroughs ativos do usuário — aba "jogos ativos". Rota estática antes de /:sessionId. */
  @Get('/active')
  async listActive(@CurrentUser('uid') userId: string) {
    return { playthroughs: await this.sessions.listActivePlaythroughs({ ownerId: userId }) }
  }

  @Get('/:sessionId')
  async get(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string) {
    return await this.sessions.getSession({ ownerId: userId, sessionId })
  }

  @Get('/:sessionId/narration-log')
  async narrationLog(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string) {
    await this.sessions.requireOwnedSessionPublic(userId, sessionId)
    return { entries: await getNarrationLog(sessionId) }
  }

  @Get('/:sessionId/events')
  async events(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string) {
    return await this.sessions.getEvents({ ownerId: userId, sessionId })
  }

  @Get('/:sessionId/messages')
  async messages(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string) {
    return await this.sessions.getMessages({ ownerId: userId, sessionId })
  }

  @Post('/:sessionId/rebuild-history-summary')
  async rebuildHistorySummary(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string) {
    return await this.sessions.rebuildHistorySummary({ ownerId: userId, sessionId })
  }

  @Post('/:sessionId/validate-action')
  async validateAction(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown
  ) {
    const parsed = z.object({ input: z.string().min(1) }).parse(body)
    return await this.sessions.validateCustomAction({ ownerId: userId, sessionId, input: parsed.input })
  }

  @Post('/:sessionId/actions')
  async applyTurn(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string, @Body() body: unknown) {
    const parsed = ApplyTurnBody.parse(body)
    return await this.sessions.applyTurn({ ownerId: userId, sessionId, action: parsed.action, displayText: parsed.displayText })
  }

  @Post('/:sessionId/actions/stream')
  async applyTurnStream(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Res() res: Response
  ) {
    const parsed = ApplyTurnBody.parse(body)
    res.setHeader('Content-Type', 'application/x-ndjson')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write('\n')
    }, 10_000)

    try {
      const result = await this.sessions.applyTurnStreamed(
        { ownerId: userId, sessionId, action: parsed.action, displayText: parsed.displayText },
        (engineData) => {
          res.write(JSON.stringify({ phase: 'engine', ...engineData }) + '\n')
          flushIfSupported(res)
        }
      )
      res.write(JSON.stringify({ phase: 'narration', ...result }) + '\n')
      res.end()
    } catch (err) {
      logStreamError('actions/stream', sessionId, userId, err)
      const message = resolveStreamErrorMessage(err)
      const status = resolveStreamErrorStatus(err)
      if (!res.headersSent) {
        res.status(status).json({ message })
      } else {
        res.write(JSON.stringify({ phase: 'error', message }) + '\n')
        res.end()
      }
    } finally {
      clearInterval(heartbeat)
    }
  }

  @Post('/:sessionId/choose')
  async chooseOption(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string, @Body() body: unknown) {
    const parsed = ChooseOptionBody.parse(body)
    return await this.sessions.chooseOption({ ownerId: userId, sessionId, optionId: parsed.optionId })
  }

  @Post('/:sessionId/choose/stream')
  async chooseOptionStream(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Res() res: Response
  ) {
    const parsed = ChooseOptionBody.parse(body)
    res.setHeader('Content-Type', 'application/x-ndjson')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write('\n')
    }, 10_000)

    try {
      const result = await this.sessions.chooseOptionStreamed(
        { ownerId: userId, sessionId, optionId: parsed.optionId },
        (engineData) => {
          res.write(JSON.stringify({ phase: 'engine', ...engineData }) + '\n')
          flushIfSupported(res)
        }
      )
      res.write(JSON.stringify({ phase: 'narration', ...result }) + '\n')
      res.end()
    } catch (err) {
      logStreamError('choose/stream', sessionId, userId, err)
      const message = resolveStreamErrorMessage(err)
      const status = resolveStreamErrorStatus(err)
      if (!res.headersSent) {
        res.status(status).json({ message })
      } else {
        res.write(JSON.stringify({ phase: 'error', message }) + '\n')
        res.end()
      }
    } finally {
      clearInterval(heartbeat)
    }
  }

  @Patch('/:sessionId/settings')
  async updateSettings(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown
  ) {
    const parsed = z.object({
      narrativeStyle: z.enum(['concise', 'balanced']).optional(),
      simpleVocabulary: z.boolean().optional()
    }).parse(body)
    return await this.sessions.updateSessionSettings({ ownerId: userId, sessionId, ...parsed })
  }

  @Delete('/:sessionId/inventory/:itemId')
  async removeInventoryItem(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string,
    @Param('itemId') itemId: string
  ) {
    const state = await this.sessions.removeInventoryItem({ ownerId: userId, sessionId, itemId })
    return { ok: true, state, inventory: state.player.inventory }
  }

  @Put('/:sessionId/equipment/attack')
  async equipAttackItem(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown
  ) {
    const parsed = EquipItemBody.parse(body)
    const state = await this.sessions.equipAttackItem({ ownerId: userId, sessionId, itemId: parsed.itemId })
    return { ok: true, state, inventory: state.player.inventory }
  }

  @Delete('/:sessionId/equipment/attack')
  async unequipAttackItem(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string
  ) {
    const state = await this.sessions.unequipAttackItem({ ownerId: userId, sessionId })
    return { ok: true, state, inventory: state.player.inventory }
  }

  @Put('/:sessionId/equipment/armor')
  async equipArmorItem(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown
  ) {
    const parsed = EquipItemBody.parse(body)
    const state = await this.sessions.equipArmorItem({ ownerId: userId, sessionId, itemId: parsed.itemId })
    return { ok: true, state, inventory: state.player.inventory }
  }

  @Delete('/:sessionId/equipment/armor')
  async unequipArmorItem(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string
  ) {
    const state = await this.sessions.unequipArmorItem({ ownerId: userId, sessionId })
    return { ok: true, state, inventory: state.player.inventory }
  }

  @Put('/:sessionId/equipment/shield')
  async equipShieldItem(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown
  ) {
    const parsed = EquipItemBody.parse(body)
    const state = await this.sessions.equipShieldItem({ ownerId: userId, sessionId, itemId: parsed.itemId })
    return { ok: true, state, inventory: state.player.inventory }
  }

  @Delete('/:sessionId/equipment/shield')
  async unequipShieldItem(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string
  ) {
    const state = await this.sessions.unequipShieldItem({ ownerId: userId, sessionId })
    return { ok: true, state, inventory: state.player.inventory }
  }

  @Post('/:sessionId/reset')
  async reset(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string) {
    return await this.sessions.resetSession({ sessionId, ownerId: userId })
  }
}
