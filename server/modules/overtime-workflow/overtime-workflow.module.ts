import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { BitableSyncModule } from '../bitable-sync/bitable-sync.module';
import { OvertimeWorkflowController } from './overtime-workflow.controller';
import { OvertimeWorkflowGateway } from './overtime-workflow.gateway';
import { OvertimeWorkflowScheduler } from './overtime-workflow.scheduler';
import { OvertimeWorkflowService } from './overtime-workflow.service';
import { OvertimeWorkflowStore } from './overtime-workflow.store';
import { OvertimePersonnelHandoverAdapter } from './overtime-personnel-handover.adapter';
import { PERSONNEL_PREVIEW_READERS } from '../../common/access/personnel-preview.ports';

@Module({
  imports: [HttpModule, BitableSyncModule],
  controllers: [OvertimeWorkflowController],
  providers: [
    OvertimeWorkflowStore,
    OvertimeWorkflowGateway,
    OvertimeWorkflowService,
    OvertimeWorkflowScheduler,
    OvertimePersonnelHandoverAdapter,
    { provide: PERSONNEL_PREVIEW_READERS.overtime, useExisting: OvertimePersonnelHandoverAdapter },
  ],
  exports: [OvertimeWorkflowService, OvertimeWorkflowStore, OvertimePersonnelHandoverAdapter],
})
export class OvertimeWorkflowModule {}
