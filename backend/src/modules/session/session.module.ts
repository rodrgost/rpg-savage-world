import { Module } from '@nestjs/common'
import { SessionController } from './session.controller.js'
import { SessionService } from './session.service.js'

@Module({
  controllers: [SessionController],
  providers: [SessionService]
})
export class SessionModule {}
