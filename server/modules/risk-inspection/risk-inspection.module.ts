import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { RiskInspectionController } from './risk-inspection.controller';
import { RiskInspectionService } from './risk-inspection.service';
import { QualityFollowUpTaskStore } from './quality-follow-up-task.store';

@Module({
  imports: [HttpModule.register({ timeout: 60_000, maxRedirects: 5 })],
  controllers: [RiskInspectionController],
  providers: [RiskInspectionService, QualityFollowUpTaskStore],
  exports: [RiskInspectionService],
})
export class RiskInspectionModule {}
