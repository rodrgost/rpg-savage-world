import { Body, Controller, Post } from '@nestjs/common'
import { z } from 'zod'
import { AuthService } from './auth.service.js'
import { CurrentUser } from './current-user.decorator.js'

const MergeAnonymousBody = z.object({
  anonymousToken: z.string().min(1)
})

@Controller('/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('/merge-anonymous')
  async mergeAnonymousOwnership(@CurrentUser('uid') currentUserId: string, @Body() body: unknown) {
    const parsed = MergeAnonymousBody.parse(body)
    return await this.authService.mergeAnonymousOwnership({
      currentUserId,
      anonymousIdToken: parsed.anonymousToken
    })
  }
}