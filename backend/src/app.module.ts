import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'
import { ServeStaticModule } from '@nestjs/serve-static'
import { HealthController } from './health.controller.js'
import { SessionModule } from './modules/session/session.module.js'
import { GameDataModule } from './modules/game-data/game-data.module.js'
import { AuthController } from './auth/auth.controller.js'
import { AuthService } from './auth/auth.service.js'
import { FirebaseAuthGuard } from './auth/firebase-auth.guard.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

@Module({
  imports: [
    SessionModule,
    GameDataModule,
    ServeStaticModule.forRoot({
      rootPath: join(__dirname, '..', '..', 'frontend', 'dist'),
      exclude: ['/health', '/auth/{*path}', '/sessions/{*path}', '/game-data/{*path}']
    })
  ],
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
