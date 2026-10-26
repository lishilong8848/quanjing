import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { EquipmentPatrolExecutionController } from './equipment-patrol-execution.controller';
import { EquipmentPatrolExecutionService } from './equipment-patrol-execution.service';

@Module({
  imports: [HttpModule.register({ timeout: 60_000, maxRedirects: 5 })],
  controllers: [EquipmentPatrolExecutionController],
  providers: [EquipmentPatrolExecutionService],
})
export class EquipmentPatrolExecutionModule {}
