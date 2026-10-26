import { readFileSync } from 'fs';
import { join } from 'path';

import type { ChangeInfo } from '../../shared/api.interface';
import {
  createChangeDrillReportDraftForRecord,
  listChangeDrillReportCandidates,
} from '../../client/src/pages/MonthlySchedule/change-drill-report-state';

const change = (patch: Partial<ChangeInfo> = {}): ChangeInfo => ({
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
  buildings: ['A楼', 'B楼'],
  riskSummary: '风险点',
  isKey: true,
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt: '2026-08-10T08:00:00.000Z',
  ...patch,
});

describe('monthly schedule change drill report', () => {
  it('only lists real high or medium risk changes that have not finished', () => {
    const now = new Date('2026-08-10T00:00:00.000Z');
    const candidates = listChangeDrillReportCandidates(
      [
        change({
          id: 'high',
          bitableRecordId: 'recHigh123456789',
          level: '高',
        }),
        change({
          id: 'medium',
          bitableRecordId: 'recMedium1234567',
          level: '中',
        }),
        change({ id: 'low', bitableRecordId: 'recLow1234567890', level: '低' }),
        change({
          id: 'finished',
          bitableRecordId: 'recFinished123456',
          level: '高',
          actualEndDate: '2026-08-09T18:00:00+08:00',
        }),
        change({
          id: 'change-request-pending-change-drill-report-test',
          bitableRecordId: '',
          level: '高',
        }),
        change({
          id: 'syncing',
          bitableRecordId: 'recSyncing1234567',
          level: '高',
          progress: '调整同步中',
        }),
      ],
      now,
    );

    expect(candidates.map(({ id }) => id)).toEqual(['high', 'medium']);
  });

  it('starts with the selected change and its valid buildings without inventing a report', () => {
    expect(
      createChangeDrillReportDraftForRecord(
        change({ buildings: ['A楼', 'B楼', '未知楼栋'] }),
      ),
    ).toEqual({
      changeRecordId: 'recChange12345678',
      buildings: ['A楼', 'B楼'],
      reportDocuments: [],
    });
  });

  it('nests three change actions under operations while keeping threshold adjustment beside them', () => {
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const operations = page.slice(
      page.indexOf('运维相关'),
      page.indexOf('<ClipboardPlus', page.indexOf('运维相关')),
    );
    expect(operations).toContain('变更相关');
    expect(operations.indexOf('变更申请')).toBeGreaterThan(
      operations.indexOf('变更相关'),
    );
    expect(operations.indexOf('变更调整')).toBeGreaterThan(
      operations.indexOf('变更申请'),
    );
    expect(operations.indexOf('演练提交')).toBeGreaterThan(
      operations.indexOf('变更调整'),
    );
    expect(operations.indexOf('阈值调整')).toBeGreaterThan(
      operations.indexOf('演练提交'),
    );
  });

  it('uses cached changes, staged attachments and an immediate recoverable submit flow', () => {
    const dialogPath = join(
      process.cwd(),
      'client/src/pages/MonthlySchedule/ChangeDrillReportDialog.tsx',
    );
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const dialog = readFileSync(dialogPath, 'utf8');

    expect(dialog).toContain('listChangeDrillReportCandidates(changes)');
    expect(dialog).not.toContain('getYearlyChangeInfo');
    expect(dialog).toContain('CHANGE_REQUEST_BUILDINGS');
    expect(dialog).toContain('ChangeAttachmentField');
    expect(dialog).toContain('stageChangeAttachment');
    expect(dialog).toContain('演练报告');
    expect(page).toContain('<ChangeDrillReportDialog');

    const start = page.indexOf('const handleSubmitChangeDrillReport');
    const end = page.indexOf('const handleSubmitAdditionalMatter', start);
    const handler = page.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(handler.indexOf('flushSync')).toBeLessThan(
      handler.indexOf('await createChangeDrillReport(request)'),
    );
    expect(handler).toContain("toast.loading('演练报告正在后台同步…'");
    expect(handler).toContain(
      'shouldRetainChangeRequestMutationIdAfterError(error)',
    );
    expect(handler).toContain(
      'persistChangeDrillReportRecovery({ request, original })',
    );
    expect(handler).toContain('clearChangeDrillReportRecovery()');
    expect(handler).toContain('setChangeDrillReportOpen(true)');
    expect(handler).not.toContain('getYearlyChangeInfo');

    const hostStart = page.indexOf('<ChangeDrillReportDialog');
    const hostEnd = page.indexOf('<ThresholdAdjustmentDialog', hostStart);
    const host = page.slice(hostStart, hostEnd);
    expect(host).toContain('!changeDrillReportRetryBinding');
    expect(host).toContain('onDraftChange');
    expect(dialog).toContain("retryBinding ? '稍后处理' : '取消'");
    expect(dialog).toContain("retryBinding ? '安全重试' : '提交演练报告'");
    expect(dialog).toContain('deleteChangeAttachment(');
    expect(dialog).toContain('attachmentBusy');
  });

  it('shows drill submission only to the exact roles accepted by the backend', () => {
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(page).toContain('canSubmitChangeDrillReportForRole(role)');
    const drillMenu = page.slice(
      page.indexOf('变更相关'),
      page.indexOf('阈值调整', page.indexOf('变更相关')),
    );
    expect(drillMenu).toContain('canSubmitChangeDrillReport');
  });
});
