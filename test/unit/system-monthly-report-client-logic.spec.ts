import type {
  SystemMonthlyReportRoom,
  SystemMonthlyReportTask,
} from '../../shared/system-monthly-report.interface';
import { SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES } from '../../shared/system-monthly-report.interface';
import {
  buildSystemMonthlyReportPersonalTodos,
  getSystemMonthlyReportSubmissionError,
  getSystemMonthlyReportPrimaryAction,
  getSystemMonthlyReportAuthorizedAction,
  getSystemMonthlyReportTaskPresentation,
  shouldCommitSystemMonthlyReportResponse,
  buildSystemMonthlyReportVersionedFileName,
  validateSystemMonthlyReportUploadFile,
} from '../../client/src/pages/SystemMonthlyReport/system-monthly-report.logic';
import * as systemMonthlyReportLogic from '../../client/src/pages/SystemMonthlyReport/system-monthly-report.logic';
import {
  buildSystemMonthlyReportPackagePeriodOptions,
  buildSystemMonthlyReportOverviewModel,
  buildSystemMonthlyReportStageDrilldownRows,
} from '../../client/src/pages/SystemMonthlyReport/overview.logic';

describe('system monthly report client state rules', () => {
  it.each([
    [
      'initial_pending',
      { kind: 'submit', stage: 'initial', label: '提交初版' },
    ],
    ['initial_review', { kind: 'review', round: 'initial', label: '审核初版' }],
    [
      'recheck_pending',
      {
        kind: 'submit',
        stage: 'recheck',
        label: '提交复审版（初版修改稿）',
      },
    ],
    [
      'recheck_review',
      { kind: 'review', round: 'recheck', label: '审核复审版' },
    ],
    ['final_pending', { kind: 'submit', stage: 'final', label: '提交终版' }],
    ['completed', null],
  ] as const)(
    'maps %s to the only valid primary action',
    (status, expected) => {
      expect(
        getSystemMonthlyReportPrimaryAction({
          status,
        } as SystemMonthlyReportRoom),
      ).toEqual(expected);
    },
  );

  it('only exposes the current action when the projected room capability allows it', () => {
    expect(
      getSystemMonthlyReportAuthorizedAction({
        status: 'initial_pending',
        access: {
          canSubmit: true,
          canDownload: true,
          managed: false,
          reviewRounds: [],
        },
      } as SystemMonthlyReportRoom),
    ).toMatchObject({ kind: 'submit', stage: 'initial' });
    expect(
      getSystemMonthlyReportAuthorizedAction({
        status: 'initial_pending',
        access: {
          canSubmit: false,
          canDownload: true,
          managed: true,
          reviewRounds: [],
        },
      } as SystemMonthlyReportRoom),
    ).toBeNull();
    expect(
      getSystemMonthlyReportAuthorizedAction({
        status: 'recheck_review',
        access: {
          canSubmit: false,
          canDownload: true,
          managed: false,
          reviewRounds: ['recheck'],
        },
      } as SystemMonthlyReportRoom),
    ).toMatchObject({ kind: 'review', round: 'recheck' });
    expect(
      getSystemMonthlyReportAuthorizedAction({
        status: 'recheck_review',
        access: {
          canSubmit: true,
          canDownload: true,
          managed: false,
          reviewRounds: ['initial'],
        },
      } as SystemMonthlyReportRoom),
    ).toBeNull();
  });

  it('builds personal todos only from rooms the current viewer can operate', () => {
    const submitRoom = {
      recordId: 'rec-submit',
      room: '昆山',
      status: 'initial_pending',
      access: {
        canSubmit: true,
        canDownload: true,
        managed: false,
        reviewRounds: [],
      },
    } as SystemMonthlyReportRoom;
    const reviewRoom = {
      recordId: 'rec-review',
      room: '下沙',
      status: 'initial_review',
      access: {
        canSubmit: false,
        canDownload: true,
        managed: false,
        reviewRounds: ['initial'],
      },
    } as SystemMonthlyReportRoom;
    const deniedRoom = {
      recordId: 'rec-denied',
      room: '无权限机房',
      status: 'final_pending',
      access: {
        canSubmit: false,
        canDownload: true,
        managed: true,
        reviewRounds: [],
      },
    } as SystemMonthlyReportRoom;

    expect(
      buildSystemMonthlyReportPersonalTodos([
        submitRoom,
        reviewRoom,
        deniedRoom,
      ]),
    ).toEqual([
      {
        room: submitRoom,
        action: { kind: 'submit', stage: 'initial', label: '提交初版' },
      },
      {
        room: reviewRoom,
        action: { kind: 'review', round: 'initial', label: '审核初版' },
      },
    ]);
  });

  it('accepts report files up to 150 MiB and rejects larger or invalid files locally', () => {
    expect(SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES).toBe(150 * 1024 * 1024);
    expect(
      validateSystemMonthlyReportUploadFile({
        name: '月报.xlsx',
        size: SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES,
      }),
    ).toBe('');
    expect(
      validateSystemMonthlyReportUploadFile({
        name: '月报.xlsx',
        size: SYSTEM_MONTHLY_REPORT_MAX_REPORT_BYTES + 1,
      }),
    ).toBe('月报附件不能超过 150 MB。');
    expect(
      validateSystemMonthlyReportUploadFile({ name: '月报.zip', size: 1024 }),
    ).toBe('月报附件仅支持 XLSX、XLS、PDF 格式。');
    expect(
      validateSystemMonthlyReportUploadFile({ name: '月报.pdf', size: 0 }),
    ).toBe('月报附件内容为空。');
  });

  it('turns a partially failed upload into a specific recoverable business message', () => {
    expect(
      getSystemMonthlyReportSubmissionError({
        status: 'error',
        message: '部分同步失败：飞书失败，COS已完成',
        sync: {
          feishu: {
            status: 'error',
            message: '飞书同步失败：read ECONNRESET',
          },
          cos: { status: 'success', message: 'COS 对象存储已同步' },
        },
      } as SystemMonthlyReportTask),
    ).toBe(
      '附件已安全保存，业务记录同步失败（连接中断）。点击重新提交将只重试失败步骤。',
    );
  });

  it('builds three selectable report versions and only enables the current workflow stage', () => {
    const buildOptions = (systemMonthlyReportLogic as any)
      .buildSystemMonthlyReportSubmissionStageOptions;

    expect(typeof buildOptions).toBe('function');
    expect(
      buildOptions(
        { status: 'initial_pending' } as SystemMonthlyReportRoom,
        true,
      ),
    ).toEqual([
      {
        stage: 'initial',
        label: '初版月报',
        state: 'available',
        canDelete: false,
      },
      {
        stage: 'recheck',
        label: '复审月报',
        state: 'locked',
        canDelete: false,
      },
      { stage: 'final', label: '终版月报', state: 'locked', canDelete: false },
    ]);
    expect(
      buildOptions(
        { status: 'recheck_pending' } as SystemMonthlyReportRoom,
        true,
      ),
    ).toEqual([
      {
        stage: 'initial',
        label: '初版月报',
        state: 'replaceable',
        canDelete: false,
      },
      {
        stage: 'recheck',
        label: '复审月报',
        state: 'available',
        canDelete: false,
      },
      { stage: 'final', label: '终版月报', state: 'locked', canDelete: false },
    ]);
  });

  it('exposes replace and delete actions without reopening a locked earlier version', () => {
    const buildOptions = (systemMonthlyReportLogic as any)
      .buildSystemMonthlyReportSubmissionStageOptions;
    const reviewing = buildOptions(
      { status: 'recheck_review' } as SystemMonthlyReportRoom,
      true,
    );
    expect(reviewing).toEqual([
      expect.objectContaining({
        stage: 'initial',
        state: 'replaceable',
        canDelete: false,
      }),
      expect.objectContaining({
        stage: 'recheck',
        state: 'replaceable',
        canDelete: true,
      }),
      expect.objectContaining({
        stage: 'final',
        state: 'locked',
        canDelete: false,
      }),
    ]);

    const opinionSubmitted = buildOptions(
      { status: 'final_pending' } as SystemMonthlyReportRoom,
      true,
    );
    expect(opinionSubmitted).toEqual([
      expect.objectContaining({
        stage: 'initial',
        state: 'locked',
        canDelete: false,
      }),
      expect.objectContaining({
        stage: 'recheck',
        state: 'replaceable',
        canDelete: false,
      }),
      expect.objectContaining({
        stage: 'final',
        state: 'available',
        canDelete: false,
      }),
    ]);
  });

  it.each([
    ['accepted', '已受理', true, false],
    ['syncing', '处理中', true, false],
    ['success', '已完成', false, true],
    ['error', '处理失败', false, false],
    ['uncertain', '结果待确认', false, false],
  ] as const)(
    'presents %s as a distinct non-blocking state',
    (status, label, busy, terminalSuccess) => {
      expect(
        getSystemMonthlyReportTaskPresentation({
          status,
        } as SystemMonthlyReportTask),
      ).toMatchObject({ label, busy, terminalSuccess });
    },
  );

  it('ignores stale responses from an older request', () => {
    expect(shouldCommitSystemMonthlyReportResponse(4, 3)).toBe(false);
    expect(shouldCommitSystemMonthlyReportResponse(4, 4)).toBe(true);
  });

  it('builds an explicit report-period filename for every submission version', () => {
    expect(
      buildSystemMonthlyReportVersionedFileName(
        '南通-B',
        2026,
        8,
        'initial',
        '原稿.xlsx',
      ),
    ).toBe('南通-B-2026年08月体系月报-初版.xlsx');
    expect(
      buildSystemMonthlyReportVersionedFileName(
        '南通-B',
        2026,
        8,
        'recheck',
        '修改稿.pdf',
      ),
    ).toBe('南通-B-2026年08月体系月报-复审版.pdf');
    expect(
      buildSystemMonthlyReportVersionedFileName(
        '南通-B',
        2026,
        8,
        'final',
        'final.xls',
      ),
    ).toBe('南通-B-2026年08月体系月报-终版.xls');
  });

  it('builds a selected-month model and a six-month trend from one data source', () => {
    const dashboard = {
      period: { year: 2026, month: 7 },
      monthlySnapshots: [
        {
          year: 2026,
          month: 7,
          totalRooms: 9,
          completedRooms: 4,
          stageCompletedRooms: {
            initial_submit: 9,
            initial_review: 9,
            recheck_submit: 8,
            recheck_review: 6,
            final_submit: 4,
          },
        },
        {
          year: 2026,
          month: 6,
          totalRooms: 9,
          completedRooms: 9,
          stageCompletedRooms: {
            initial_submit: 9,
            initial_review: 9,
            recheck_submit: 9,
            recheck_review: 9,
            final_submit: 9,
          },
        },
      ],
      history: [],
      rooms: [],
    } as any;

    const model = buildSystemMonthlyReportOverviewModel(dashboard, '2026-07');
    expect(model.selectedPeriodKey).toBe('2026-07');
    expect(model.stageSeries.map((item) => item.completed)).toEqual([
      9, 9, 8, 6, 4,
    ]);
    expect(model.stageSeries.map((item) => item.completionRate)).toEqual([
      100, 100, 89, 67, 44,
    ]);
    expect(model.trend.at(-1)).toMatchObject({
      periodKey: '2026-07',
      completedRooms: 4,
      completionRate: 44,
    });
  });

  it('builds a stage drilldown with every room status and explicit completion time', () => {
    const rows = buildSystemMonthlyReportStageDrilldownRows(
      {
        rooms: [
          {
            room: '南通-B',
            stages: {
              final_submit: {
                completed: true,
                completedAt: '2026-08-07T05:50:00.000Z',
              },
            },
          },
          {
            room: '南通-C',
            stages: { final_submit: { completed: false, completedAt: null } },
          },
        ],
      } as any,
      'final_submit',
    );
    expect(rows).toEqual([
      {
        room: '南通-B',
        completed: true,
        completedAt: '2026-08-07T05:50:00.000Z',
      },
      { room: '南通-C', completed: false, completedAt: null },
    ]);
  });

  it('builds selectable package months from real monthly snapshots', () => {
    const options = buildSystemMonthlyReportPackagePeriodOptions({
      period: { year: 2026, month: 8 },
      monthlySnapshots: [
        { year: 2026, month: 7, totalRooms: 9, completedRooms: 9 },
        { year: 2026, month: 8, totalRooms: 9, completedRooms: 3 },
        { year: 2026, month: 6, totalRooms: 9, completedRooms: 8 },
      ],
    } as any);

    expect(options).toEqual([
      {
        value: '2026-08',
        label: '2026年8月',
        totalRooms: 9,
        completedRooms: 3,
      },
      {
        value: '2026-07',
        label: '2026年7月',
        totalRooms: 9,
        completedRooms: 9,
      },
      {
        value: '2026-06',
        label: '2026年6月',
        totalRooms: 9,
        completedRooms: 8,
      },
    ]);
  });
});
