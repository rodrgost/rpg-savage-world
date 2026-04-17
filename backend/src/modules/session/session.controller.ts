import { Body, Controller, Delete, Get, Inject, Param, Post, Res } from '@nestjs/common'
import type { Response } from 'express'
import { z } from 'zod'
import { SessionService } from './session.service.js'
import { CurrentUser } from '../../auth/current-user.decorator.js'

const StartSessionBody = z.object({
  campaignId: z.string().min(1),
  characterId: z.string().min(1)
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
    skill: z.string().min(1).default('Lutar'),
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
  action: ActionSchema
})

const ChooseOptionBody = z.object({
  optionId: z.string().min(1)
})

@Controller('/sessions')
export class SessionController {
  constructor(@Inject(SessionService) private readonly sessions: SessionService) {}

  @Post('/start')
  async create(@CurrentUser('uid') userId: string, @Body() body: unknown) {
    const parsed = StartSessionBody.parse(body)
    return await this.sessions.createSession({
      ownerId: userId,
      campaignId: parsed.campaignId,
      characterId: parsed.characterId
    })
  }

  @Get('/:sessionId')
  async get(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string) {
    return await this.sessions.getSession({ ownerId: userId, sessionId })
  }

  @Get('/:sessionId/events')
  async events(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string) {
    return await this.sessions.getEvents({ ownerId: userId, sessionId })
  }

  @Get('/:sessionId/messages')
  async messages(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string) {
    return await this.sessions.getMessages({ ownerId: userId, sessionId })
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
    return await this.sessions.applyTurn({ ownerId: userId, sessionId, action: parsed.action })
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

    try {
      const result = await this.sessions.applyTurnStreamed(
        { ownerId: userId, sessionId, action: parsed.action },
        (engineData) => {
          res.write(JSON.stringify({ phase: 'engine', ...engineData }) + '\n')
          if (typeof (res as any).flush === 'function') (res as any).flush()
        }
      )
      res.write(JSON.stringify({ phase: 'narration', ...result }) + '\n')
      res.end()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro interno'
      if (!res.headersSent) {
        res.status(500).json({ message })
      } else {
        res.write(JSON.stringify({ phase: 'error', message }) + '\n')
        res.end()
      }
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

    try {
      const result = await this.sessions.chooseOptionStreamed(
        { ownerId: userId, sessionId, optionId: parsed.optionId },
        (engineData) => {
          res.write(JSON.stringify({ phase: 'engine', ...engineData }) + '\n')
          if (typeof (res as any).flush === 'function') (res as any).flush()
        }
      )
      res.write(JSON.stringify({ phase: 'narration', ...result }) + '\n')
      res.end()
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Erro interno'
      if (!res.headersSent) {
        res.status(500).json({ message })
      } else {
        res.write(JSON.stringify({ phase: 'error', message }) + '\n')
        res.end()
      }
    }
  }

  @Delete('/:sessionId/inventory/:itemId')
  async removeInventoryItem(
    @CurrentUser('uid') userId: string,
    @Param('sessionId') sessionId: string,
    @Param('itemId') itemId: string
  ) {
    const state = await this.sessions.removeInventoryItem({ ownerId: userId, sessionId, itemId })
    return { ok: true, inventory: state.player.inventory }
  }

  @Post('/:sessionId/reset')
  async reset(@CurrentUser('uid') userId: string, @Param('sessionId') sessionId: string) {
    return await this.sessions.resetSession({ sessionId, ownerId: userId })
  }
}
