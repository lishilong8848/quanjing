import type { ChangeInfo } from '../../shared/api.interface';
import type { ChangeDrillReportCreateRequest } from '../../shared/change-drill-report';
import {
  clearChangeDrillReportRecovery,
  persistChangeDrillReportRecovery,
  readChangeDrillReportRecovery,
  type ChangeDrillReportRetryBinding,
  type ChangeDrillReportRecoveryStorage,
} from '../../client/src/pages/MonthlySchedule/change-drill-report-recovery';

const request: ChangeDrillReportCreateRequest = {
  clientMutationId: 'change-drill-report-123e4567-e89b-42d3-a456-426614174000',
  changeRecordId: 'recChange12345678',
  buildings: ['A楼'],
  reportDocuments: [
    {
      name: '演练报告.pdf',
      type: 'application/pdf',
      size: 1024,
      objectStorage: {
        id: 'storage-report-1',
        filePath: 'change-drill-reports/report.pdf',
        bucketId: 'default-bucket',
        url: 'https://storage.example.test/change-drill-reports/report.pdf',
      },
    },
  ],
};

const original: ChangeInfo = {
  id: 'recChange12345678',
  bitableRecordId: 'recChange12345678',
  title: '中风险变更',
  startDate: '2026-08-11T09:00:00+08:00',
  endDate: '2026-08-11T18:00:00+08:00',
  actualStartDate: null,
  actualEndDate: null,
  plannedDelayStartDate: null,
  plannedDelayEndDate: null,
  level: '中',
  type: '计划性变更',
  progress: '未开始',
  executor: null,
  scheduleStatus: 'not-started',
  buildings: ['A楼'],
  riskSummary: '风险点',
  isKey: true,
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt: '2026-08-10T08:00:00.000Z',
};

describe('change drill report recovery', () => {
  let storage: ChangeDrillReportRecoveryStorage;
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    storage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    };
  });

  it('persists an immutable unknown-result binding across a reload', () => {
    const binding: ChangeDrillReportRetryBinding = { request, original };

    persistChangeDrillReportRecovery(binding, storage);

    expect(readChangeDrillReportRecovery(storage)).toEqual(binding);
  });

  it('rejects corrupt or mismatched recovery data', () => {
    storage.setItem(
      'monthly-schedule.change-drill-report.recovery.v1',
      JSON.stringify({
        request,
        original: { ...original, bitableRecordId: 'recDifferent123456' },
      }),
    );

    expect(readChangeDrillReportRecovery(storage)).toBeNull();
  });

  it('clears recovery only after a known outcome or explicit editable cancel', () => {
    persistChangeDrillReportRecovery({ request, original }, storage);

    clearChangeDrillReportRecovery(storage);

    expect(readChangeDrillReportRecovery(storage)).toBeNull();
  });
});
