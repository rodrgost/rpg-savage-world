import { Module } from '@nestjs/common'

import { GameDataController } from './game-data.controller.js'
import { GameDataService } from './game-data.service.js'

@Module({
  controllers: [GameDataController],
  providers: [GameDataService]
})
export class GameDataModule {}