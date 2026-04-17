import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { firebaseAuth } from '../infrastructure/firebase.js'
import { IS_PUBLIC_ROUTE } from './public.decorator.js'
import type { AuthenticatedRequest } from './auth.types.js'

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic =
      Reflect.getMetadata(IS_PUBLIC_ROUTE, context.getHandler()) ??
      Reflect.getMetadata(IS_PUBLIC_ROUTE, context.getClass()) ??
      false

    if (isPublic) return true

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const authorization = request.headers.authorization
    const match = authorization?.match(/^Bearer\s+(.+)$/i)

    if (!match) {
      throw new UnauthorizedException('Use Authorization: Bearer <token> para acessar a API.')
    }

    try {
      const decoded = await firebaseAuth.verifyIdToken(match[1])
      const isAnonymous = decoded.firebase?.sign_in_provider === 'anonymous'

      if (isAnonymous) {
        throw new UnauthorizedException('Finalize o login antes de acessar a aplicação.')
      }

      request.user = {
        uid: decoded.uid,
        email: decoded.email,
        isAnonymous,
        token: decoded
      }

      return true
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error
      throw new UnauthorizedException('Token Firebase inválido ou expirado.')
    }
  }
}