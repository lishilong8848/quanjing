import type { ChangeInfo } from '../../shared/api.interface';
import {
  createChangeSummaryReportMutationId,
  filterChangeSummaryReportPersonOptions,
  isEligibleChangeSummaryRecord,
  listEligibleChangeSummaryRecords,
  CHANGE_SUMMARY_REPORT_PERSON_OPTION_LIMIT,
  resolveChangeSummaryReportCachePresentation,
  type ChangeSummaryReportUuidSource,
} from '../../client/src/pages/MonthlySchedule/change-summary-report-state';

const change = (patch: Partial<ChangeInfo> = {}): ChangeInfo => ({
  id: 'recChange12345678',
  bitableRecordId: 'recChange12345678',
  title: '已结束变更',
  startDate: '2026-08-11T09:00:00+08:00',
  endDate: '2026-08-11T18:00:00+08:00',
  actualStartDate: '2026-08-11T09:05:00+08:00',
  actualEndDate: '2026-08-11T17:55:00+08:00',
  plannedDelayStartDate: null,
  plannedDelayEndDate: null,
  level: '低',
  type: '计划性变更',
  progress: '已结束',
  executor: null,
  submitterName: '示例人员020',
  workflowStatus: '审批通过',
  hasSummaryReport: false,
  buildings: ['A楼'],
  riskSummary: '风险点',
  isKey: false,
  createdAt: '2026-08-10T08:00:00.000Z',
  updatedAt: '2026-08-11T10:00:00.000Z',
  ...patch,
});

describe('monthly schedule change summary report state', () => {
  it('accepts a formal finished record for the exact selected submitter', () => {
    expect(isEligibleChangeSummaryRecord(change(), '示例人员020')).toBe(true);
    expect(isEligibleChangeSummaryRecord(change(), '马进')).toBe(false);
    expect(isEligibleChangeSummaryRecord(change(), '示例人员0202')).toBe(false);
  });

  it('compares submitter names after NFKC normalization and trimming', () => {
    expect(
      isEligibleChangeSummaryRecord(
        change({ submitterName: ' ＭＡ-01 ' }),
        'MA-01',
      ),
    ).toBe(true);
  });

  it.each(['loading', 'error'] as const)(
    'keeps existing cached options usable while background state is %s',
    (status) => {
      expect(resolveChangeSummaryReportCachePresentation(status, 12)).toEqual({
        hasUsableData: true,
        blocking: false,
        refreshing: status === 'loading',
        refreshFailed: status === 'error',
      });
    },
  );

  it('keeps cached submitter options selectable after refresh failure', () => {
    const cachedSubmitters = ['示例人员020', '彭怀响'];

    expect(
      resolveChangeSummaryReportCachePresentation(
        'error',
        cachedSubmitters.length,
      ),
    ).toEqual({
      hasUsableData: true,
      blocking: false,
      refreshing: false,
      refreshFailed: true,
    });
    expect(
      filterChangeSummaryReportPersonOptions(cachedSubmitters, ''),
    ).toEqual(['示例人员020', '彭怀响']);
  });

  it('blocks only an initial load that has no cached options', () => {
    expect(resolveChangeSummaryReportCachePresentation('loading', 0)).toEqual({
      hasUsableData: false,
      blocking: true,
      refreshing: false,
      refreshFailed: false,
    });
  });

  it('normalizes, searches and caps person options before rendering', () => {
    const options = [
      ' ＭＡ-01 ',
      'MA-01',
      ...Array.from(
        { length: CHANGE_SUMMARY_REPORT_PERSON_OPTION_LIMIT + 20 },
        (_, index) => `人员-${String(index).padStart(3, '0')}`,
      ),
    ];

    expect(filterChangeSummaryReportPersonOptions(options, 'ma')).toEqual([
      'MA-01',
    ]);
    expect(filterChangeSummaryReportPersonOptions(options, '')).toHaveLength(
      CHANGE_SUMMARY_REPORT_PERSON_OPTION_LIMIT,
    );
  });

  it('normalizes progress but does not broaden the finished status', () => {
    expect(
      isEligibleChangeSummaryRecord(
        change({ progress: '  已 结束  ' }),
        '示例人员020',
      ),
    ).toBe(true);
    expect(
      isEligibleChangeSummaryRecord(change({ progress: '已完成' }), '示例人员020'),
    ).toBe(false);
    expect(
      isEligibleChangeSummaryRecord(change({ progress: null }), '示例人员020'),
    ).toBe(false);
  });

  it('rejects pending, local and malformed record identities', () => {
    expect(
      isEligibleChangeSummaryRecord(
        change({
          id: 'change-request-pending-123',
          bitableRecordId: 'recFormal12345678',
        }),
        '示例人员020',
      ),
    ).toBe(false);
    expect(
      isEligibleChangeSummaryRecord(
        change({ id: 'local-1', bitableRecordId: 'local-1' }),
        '示例人员020',
      ),
    ).toBe(false);
    expect(
      isEligibleChangeSummaryRecord(
        change({ bitableRecordId: 'rec-short' }),
        '示例人员020',
      ),
    ).toBe(false);
  });

  it('requires a non-empty level other than 超低', () => {
    expect(
      isEligibleChangeSummaryRecord(change({ level: '高' }), '示例人员020'),
    ).toBe(true);
    expect(
      isEligibleChangeSummaryRecord(change({ level: ' 超低 ' }), '示例人员020'),
    ).toBe(false);
    expect(
      isEligibleChangeSummaryRecord(change({ level: '   ' }), '示例人员020'),
    ).toBe(false);
    expect(
      isEligibleChangeSummaryRecord(change({ level: null }), '示例人员020'),
    ).toBe(false);
  });

  it('rejects returned workflows and records that already have a summary', () => {
    for (const workflowStatus of ['已退回修改', '流程驳回', '审批通过后退回']) {
      expect(
        isEligibleChangeSummaryRecord(change({ workflowStatus }), '示例人员020'),
      ).toBe(false);
    }
    expect(
      isEligibleChangeSummaryRecord(
        change({ workflowStatus: null, hasSummaryReport: undefined }),
        '示例人员020',
      ),
    ).toBe(true);
    expect(
      isEligibleChangeSummaryRecord(
        change({ hasSummaryReport: true }),
        '示例人员020',
      ),
    ).toBe(false);
  });

  it('uses the inclusive 2026-06-01 Asia/Shanghai start boundary', () => {
    expect(
      isEligibleChangeSummaryRecord(
        change({ startDate: '2026-06-01T00:00:00+08:00' }),
        '示例人员020',
      ),
    ).toBe(true);
    expect(
      isEligibleChangeSummaryRecord(
        change({ startDate: '2026-05-31T23:59:59+08:00' }),
        '示例人员020',
      ),
    ).toBe(false);
    expect(
      isEligibleChangeSummaryRecord(
        change({ startDate: '2026-05-31T16:00:00.000Z' }),
        '示例人员020',
      ),
    ).toBe(true);
    expect(
      isEligibleChangeSummaryRecord(
        change({ startDate: '2026-06-01T00:00:00' }),
        '示例人员020',
      ),
    ).toBe(true);
    expect(
      isEligibleChangeSummaryRecord(change({ startDate: 'invalid' }), '示例人员020'),
    ).toBe(false);
  });

  it.each([
    '2026-06-31T00:00:00+08:00',
    '2026-06-01T24:00:00+08:00',
    '2026-02-29T00:00:00Z',
    '2026-06-01T00:00:00+14:01',
    '2026-06-01T00:00:00+08:60',
  ])('rejects the invalid explicit ISO start date %s', (startDate) => {
    expect(isEligibleChangeSummaryRecord(change({ startDate }), '示例人员020')).toBe(
      false,
    );
  });

  it('accepts strict Z, colonless offset and millisecond timestamps', () => {
    for (const startDate of [
      '2026-05-31T16:00:00Z',
      '2026-06-01T00:00:00+0800',
      '2026-06-01T00:00:00.123+08:00',
    ]) {
      expect(
        isEligibleChangeSummaryRecord(change({ startDate }), '示例人员020'),
      ).toBe(true);
    }
  });

  it('filters for the submitter and sorts eligible records by start time descending', () => {
    const oldest = change({
      id: 'recOldest12345678',
      bitableRecordId: 'recOldest12345678',
      startDate: '2026-06-01T00:00:00+08:00',
    });
    const newest = change({
      id: 'recNewest12345678',
      bitableRecordId: 'recNewest12345678',
      startDate: '2026-08-12T09:00:00+08:00',
    });
    const middle = change({
      id: 'recMiddle12345678',
      bitableRecordId: 'recMiddle12345678',
      startDate: '2026-07-01T09:00:00+08:00',
    });
    const otherSubmitter = change({
      id: 'recOther123456789',
      bitableRecordId: 'recOther123456789',
      submitterName: '示例人员004',
    });
    const input = [oldest, newest, otherSubmitter, middle];

    expect(
      listEligibleChangeSummaryRecords(input, '示例人员020').map(({ id }) => id),
    ).toEqual(['recNewest12345678', 'recMiddle12345678', 'recOldest12345678']);
    expect(input).toEqual([oldest, newest, otherSubmitter, middle]);
  });

  it('creates a canonical prefixed v4 mutation id from an injectable UUID source', () => {
    const randomUUID = jest.fn(() => '123e4567-e89b-42d3-a456-426614174000');

    expect(createChangeSummaryReportMutationId(randomUUID)).toBe(
      'change-summary-report-123e4567-e89b-42d3-a456-426614174000',
    );
    expect(randomUUID).toHaveBeenCalledTimes(1);
    expect(createChangeSummaryReportMutationId()).toMatch(
      /^change-summary-report-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(() =>
      createChangeSummaryReportMutationId(() => 'not-a-v4-uuid'),
    ).toThrow('无法生成有效的变更总结请求标识');
  });

  it('falls back to injected cryptographic bytes without touching global crypto', () => {
    const getRandomValues = jest.fn((bytes: Uint8Array) => {
      bytes.set([
        0x12, 0x3e, 0x45, 0x67, 0xe8, 0x9b, 0x02, 0xd3, 0x24, 0x56, 0x42, 0x66,
        0x14, 0x17, 0x40, 0x00,
      ]);
    });

    expect(createChangeSummaryReportMutationId({ getRandomValues })).toBe(
      'change-summary-report-123e4567-e89b-42d3-a456-426614174000',
    );
    expect(getRandomValues).toHaveBeenCalledTimes(1);
  });

  it('fails explicitly when no secure UUID source exists', () => {
    const noSecureSource: ChangeSummaryReportUuidSource = {};

    expect(() => createChangeSummaryReportMutationId(noSecureSource)).toThrow(
      '当前环境不支持安全生成变更总结请求标识',
    );
  });
});
