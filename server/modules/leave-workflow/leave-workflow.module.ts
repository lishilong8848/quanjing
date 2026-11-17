import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { BitableSyncModule } from '../bitable-sync/bitable-sync.module';
import { LeaveWorkflowGateway } from './leave-workflow.gateway';
import { LeaveWorkflowDetailGateway } from './leave-workflow.detail-gateway';
import { LeaveWorkflowScheduler } from './leave-workflow.scheduler';
import { LeaveWorkflowService } from './leave-workflow.service';
import { LeaveWorkflowStore } from './leave-workflow.store';
import { LeavePersonnelHandoverAdapter } from './leave-personnel-handover.adapter';
import { PERSONNEL_PREVIEW_READERS } from '../../common/access/personnel-preview.ports';
import { OvertimeWorkflowModule } from '../overtime-workflow/overtime-workflow.module';
import { LeaveSubstituteOvertimeService } from './leave-substitute-overtime.service';

@Module({
  imports: [HttpModule, BitableSyncModule, OvertimeWorkflowModule],
  providers: [
    LeaveWorkflowStore,
    LeaveWorkflowGateway,
    LeaveWorkflowDetailGateway,
    LeaveWorkflowService,
    LeaveSubstituteOvertimeService,
    LeaveWorkflowScheduler,
    LeavePersonnelHandoverAdapter,
    { provide: PERSONNEL_PREVIEW_READERS.leave, useExisting: LeavePersonnelHandoverAdapter },
  ],
  exports: [LeaveWorkflowService, LeaveWorkflowStore, LeavePersonnelHandoverAdapter],
})
export class LeaveWorkflowModule {}
