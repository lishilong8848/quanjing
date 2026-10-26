import { Test } from '@nestjs/testing';
import { HttpModule } from '@nestjs/axios';
import { MonthlyOperationsAssessmentController } from '../../server/modules/bitable-sync/monthly-operations-assessment.controller';
import { MonthlyOperationsAssessmentService } from '../../server/modules/bitable-sync/monthly-operations-assessment.service';
import { MonthlyOperationsMaintenanceController } from '../../server/modules/bitable-sync/monthly-operations-maintenance.controller';
import { MonthlyOperationsMaintenanceService } from '../../server/modules/bitable-sync/monthly-operations-maintenance.service';
import { MonthlyOperationsAlarmsController } from '../../server/modules/bitable-sync/monthly-operations-alarms.controller';
import { MonthlyOperationsAlarmsService } from '../../server/modules/bitable-sync/monthly-operations-alarms.service';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
} from '../../server/common/feishu/bitable-direct-read';
jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  fetchBitableRecords: jest.fn(),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
}));
it('三组新增控制器在 Nest 中可注入，仅暴露白名单读取', async () => {
  jest.mocked(fetchBitableRecords).mockResolvedValue([]);
  jest.mocked(readLatestPersistedBitableRecordSnapshot).mockResolvedValue(null);
  const module = await Test.createTestingModule({
    imports: [HttpModule],
    controllers: [
      MonthlyOperationsAssessmentController,
      MonthlyOperationsMaintenanceController,
      MonthlyOperationsAlarmsController,
    ],
    providers: [
      MonthlyOperationsAssessmentService,
      MonthlyOperationsMaintenanceService,
      MonthlyOperationsAlarmsService,
    ],
  }).compile();
  try {
    expect(
      await module
        .get(MonthlyOperationsAssessmentController)
        .get('risk', '2026-09-01', '2026-09-30'),
    ).toMatchObject({ status: 'empty' });
    expect(
      await module
        .get(MonthlyOperationsMaintenanceController)
        .get('planned', '2026-09-01', '2026-09-30'),
    ).toMatchObject({ status: 'empty' });
    expect(
      await module
        .get(MonthlyOperationsAlarmsController)
        .get('2026-09-01', '2026-09-30'),
    ).toMatchObject({ status: 'empty' });
  } finally {
    await module.close();
  }
});
