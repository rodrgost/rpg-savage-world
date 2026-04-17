import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { AppModule } from './app.module.js'
import { env } from './config/env.js'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule)

  app.useBodyParser('json', { limit: '5mb' })
  app.useBodyParser('urlencoded', { limit: '5mb', extended: true })

  app.enableCors({
    origin: [/^http:\/\/localhost:\d+$/],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization']
  })
  await app.listen(env.port)
}

await bootstrap()
