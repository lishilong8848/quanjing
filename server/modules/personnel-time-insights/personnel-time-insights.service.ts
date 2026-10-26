import { BadRequestException, Injectable } from '@nestjs/common';
import { LeaveWorkflowStore } from '../leave-workflow/leave-workflow.store';
import { OvertimeWorkflowStore } from '../overtime-workflow/overtime-workflow.store';
import {
  assertDateRange,
  buildPersonnelTimeInsights,
} from './personnel-time-insights.model';

@Injectable()
export class PersonnelTimeInsightsService {
  constructor(
    private readonly overtimeStore: OvertimeWorkflowStore,
    private readonly leaveStore: LeaveWorkflowStore,
  ) {}

  async getInsights(from: string, through: string) {
    try {
      assertDateRange(from, through);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : '统计日期范围无效',
      );
    }

    const [overtimeApplications, overtimeConfirmations, leaveApplications] =
      await Promise.all([
        this.overtimeStore.listApplications(),
        this.overtimeStore.listConfirmations(),
        this.leaveStore.listApplications(),
      ]);

    return buildPersonnelTimeInsights({
      from,
      through,
      overtimeApplications,
      overtimeConfirmations,
      leaveApplications,
    });
  }
}
