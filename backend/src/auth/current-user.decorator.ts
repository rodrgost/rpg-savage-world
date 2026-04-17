import { ExecutionContext, createParamDecorator } from '@nestjs/common'
import type { AuthenticatedRequest, AuthenticatedUser } from './auth.types.js'

export const CurrentUser = createParamDecorator(
  (field: keyof AuthenticatedUser | undefined, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const user = request.user
    return field ? user?.[field] : user
  }
)