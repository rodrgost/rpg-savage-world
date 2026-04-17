import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { HealthController } from './health.controller.js'
import { SessionModule } from './modules/session/session.module.js'
import { GameDataModule } from './modules/game-data/game-data.module.js'
import { AuthController } from './auth/auth.controller.js'
import { AuthService } from './auth/auth.service.js'
import { FirebaseAuthGuard } from './auth/firebase-auth.guard.js'

@Module({
  imports: [SessionModule, GameDataModule],
  controllers: [HealthController, AuthController],
  providers: [
    AuthService,
    {
      provide: APP_GUARD,
      useClass: FirebaseAuthGuard
    }
  ]
})
export class AppModule {}
