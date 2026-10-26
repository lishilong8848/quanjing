import { Module } from '@nestjs/common';
import { LeaveWorkflowModule } from '../leave-workflow/leave-workflow.module';
import { OvertimeWorkflowModule } from '../overtime-workflow/overtime-workflow.module';
import { PersonnelTimeInsightsController } from './personnel-time-insights.controller';
import { PersonnelTimeInsightsService } from './personnel-time-insights.service';

@Module({
  imports: [OvertimeWorkflowModule, LeaveWorkflowModule],
  controllers: [PersonnelTimeInsightsController],
  providers: [PersonnelTimeInsightsService],
})
export class PersonnelTimeInsightsModule {}
