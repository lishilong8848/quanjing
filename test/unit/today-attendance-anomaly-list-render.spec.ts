import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TodayAttendanceSnapshot } from '../../shared/today-attendance.interface';

jest.mock(
  '@/components/ui/button',
  () => ({
    Button: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement('button', props, children),
  }),
  { virtual: true },
);
jest.mock(
  '@/components/ui/badge',
  () => ({
    Badge: ({
      children,
      ...props
    }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement('span', props, children),
  }),
  { virtual: true },
);
jest.mock(
  '@/lib/utils',
  () => ({
    cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  }),
  { virtual: true },
);
jest.mock(
  '../../client/src/components/attendance/AttendanceCorrectionEvidenceDialog',
  () => ({ AttendanceCorrectionEvidenceDialog: () => null }),
);
jest.mock(
  '../../client/src/components/attendance/AttendanceHistoryDialogButton',
  () => ({ AttendanceHistoryDialogButton: () => null }),
);

import { TodayAttendanceAnomalyList } from '../../client/src/components/attendance/TodayAttendanceAnomalyList';

describe('TodayAttendanceAnomalyList rendering', () => {
  const runningSnapshot = (attemptCount = 1, maxAttempts = 1): TodayAttendanceSnapshot => ({ date: '2026-10-30', displayScope: 'today', fetchedAt: '2026-10-30 10:15', sourceStatus: 'running',
    runStatus: { state: 'running', scheduledAt: '2026-10-30 09:30', attemptCount, maxAttempts }, checkedTasks: ['morning-off-duty-check'],
    summary: { expected: 62, normal: 58, anomaly: 4, excluded: 0 }, entries: [] });
  it.each(['submitting', 'accepted'] as const)('labels the current manual %s check without showing a misleading 1/1 retry', manualSyncState => {
    const html = renderToStaticMarkup(React.createElement(TodayAttendanceAnomalyList, { snapshot: runningSnapshot(), state: 'ready', retry: () => undefined, manualSyncState }));
    expect(html).toContain('正在核验本次手动同步'); expect(html).not.toContain('正在补跑'); expect(html).not.toContain('当前第');
  });
  it('distinguishes a first scheduled check from a genuine retry', () => {
    const render = (attempt: number) => renderToStaticMarkup(React.createElement(TodayAttendanceAnomalyList, { snapshot: runningSnapshot(attempt, 6), state: 'ready', retry: () => undefined }));
    expect(render(1)).toContain('考勤终检正在核验'); expect(render(1)).not.toContain('正在补跑'); expect(render(2)).toContain('考勤终检正在补跑');
  });
  it('shows a completed manual check separately from pending external archive and correction updates', () => {
    const running = runningSnapshot();
    const snapshot: TodayAttendanceSnapshot = { ...running, sourceStatus: 'fresh', runStatus: { ...running.runStatus!, state: 'completed', archiveSyncState: 'syncing', correctionSyncState: 'syncing' } };
    const html = renderToStaticMarkup(React.createElement(TodayAttendanceAnomalyList, { snapshot, state: 'ready', retry: () => undefined, manualSyncState: 'success' }));
    expect(html).toContain('本次手动同步已完成'); expect(html).toContain('归档或补卡资料仍在后台更新'); expect(html).not.toContain('正在核验本次手动同步'); expect(html).not.toContain('当前第');
  });
  it('pending observation offers only a read refresh and keeps manual resubmission disabled', () => {
    const html = renderToStaticMarkup(React.createElement(TodayAttendanceAnomalyList, { snapshot: runningSnapshot(), state: 'ready', retry: () => undefined, canManualSync: true, manualSync: () => undefined, manualSyncState: 'pending' }));
    expect(html).toContain('本次手动核验结果尚未确认'); expect(html).toContain('刷新结果'); expect(html).not.toContain('当前第');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="手动同步今日考勤"/);
  });
  it.each(['idle', 'loading', 'error'] as const)(
    'does not show a successful attendance header without a snapshot (%s)',
    (state) => {
      const html = renderToStaticMarkup(
        React.createElement(TodayAttendanceAnomalyList, {
          snapshot: null,
          state,
          retry: () => undefined,
        }),
      );
      expect(html).not.toContain('border-emerald');
      expect(html).not.toContain('lucide-circle-check');
      expect(html).not.toContain('考勤正常');
      expect(html).toContain(
        state === 'error' ? '考勤数据暂不可用' : '考勤数据加载中',
      );
    },
  );
  it.each(['loading', 'error'] as const)(
    'keeps retained results stable during background %s',
    (state) => {
      const html = renderToStaticMarkup(
        React.createElement(TodayAttendanceAnomalyList, {
          snapshot: {
            date: '2026-09-30',
            displayScope: 'today',
            fetchedAt: '2026-09-30 09:30',
            sourceStatus: 'fresh',
            checkedTasks: ['morning-off-duty-check'],
            summary: { expected: 1, normal: 0, anomaly: 1, excluded: 0 },
            entries: [
              {
                key: 'test',
                name: '测试员工',
                building: '110站',
                shiftLabel: '白班',
                direction: 'OnDuty',
                expectedAt: '2026-09-30 09:00',
                status: 'anomaly',
                reason: '迟到',
              },
            ],
          },
          state,
          retry: () => undefined,
        }),
      );
      expect(html).toContain('测试员工');
      expect(html).not.toContain('刷新失败，当前显示上次状态');
      expect(html).not.toContain('考勤状态更新中…');
      expect(html).toContain(
        state === 'error'
          ? '刷新未完成，显示上次结果；点击重试'
          : '正在刷新考勤结果',
      );
    },
  );
  it('shows retained anomalies when correction approval sync fails after attendance was saved', () => {
    const snapshot: TodayAttendanceSnapshot = {
      date: '2026-09-17',
      displayScope: 'today',
      fetchedAt: '2026-09-17 09:30',
      sourceStatus: 'failed',
      runStatus: {
        state: 'failed',
        scheduledAt: '2026-09-17 09:30',
        failureReason: '钉钉补卡审批查询失败',
        finalFailure: true,
      },
      checkedTasks: ['morning-off-duty-check'],
      summary: { expected: 66, normal: 65, anomaly: 1, excluded: 0 },
      entries: [
        {
          key: 'example-off-duty',
          name: '示例员工',
          building: 'E楼',
          shiftLabel: '夜班',
          direction: 'OffDuty',
          expectedAt: '2026-09-17 09:00',
          status: 'anomaly',
          reason: '未打卡',
        },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(TodayAttendanceAnomalyList, {
        snapshot,
        state: 'ready',
        retry: () => undefined,
      }),
    );

    expect(html).toContain('今日考勤异常 1 人');
    expect(html).toContain('示例员工');
    expect(html).toContain('未打卡');
    expect(html).toContain('补卡审批');
  });

  it('keeps correction sync faults off the attendance page', () => {
    const snapshot: TodayAttendanceSnapshot = {
      date: '2026-09-17',
      displayScope: 'today',
      fetchedAt: '2026-09-17 09:30',
      sourceStatus: 'fresh',
      runStatus: {
        state: 'completed',
        scheduledAt: '2026-09-17 09:30',
        correctionSyncFailureReason: '钉钉补卡审批查询失败',
      },
      checkedTasks: ['morning-off-duty-check'],
      summary: { expected: 65, normal: 65, anomaly: 0, excluded: 0 },
      entries: [],
    };

    const html = renderToStaticMarkup(
      React.createElement(TodayAttendanceAnomalyList, {
        snapshot,
        state: 'ready',
        retry: () => undefined,
      }),
    );

    expect(html).not.toContain('补卡审批查询失败');
    expect(html).not.toContain('补卡状态待核验');
    expect(html).toContain('今日考勤正常');
  });

  it('keeps Feishu archive retries off the attendance page while preserving anomalies', () => {
    const snapshot: TodayAttendanceSnapshot = {
      date: '2026-09-20',
      displayScope: 'today',
      fetchedAt: '2026-09-20 09:30',
      sourceStatus: 'fresh',
      runStatus: {
        state: 'completed',
        scheduledAt: '2026-09-20 09:30',
        archiveSyncFailureReason: '飞书考勤多维表同步失败',
      },
      checkedTasks: ['morning-off-duty-check'],
      summary: { expected: 1, normal: 0, anomaly: 1, excluded: 0 },
      entries: [
        {
          key: 'e-fu-off-duty',
          name: '付锦涛',
          building: 'E楼',
          shiftLabel: '白班',
          direction: 'OffDuty',
          expectedAt: '2026-09-20 09:00',
          status: 'anomaly',
          reason: '未打卡',
        },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(TodayAttendanceAnomalyList, {
        snapshot,
        state: 'ready',
        retry: () => undefined,
      }),
    );

    expect(html).not.toContain('打卡结果已更新');
    expect(html).not.toContain('飞书多维表归档仍在后台重试');
    expect(html).toContain('付锦涛');
    expect(html).not.toContain('考勤终检本轮执行失败');
  });

  it('does not expose a newly queued Feishu archive on the attendance page', () => {
    const snapshot: TodayAttendanceSnapshot = {
      date: '2026-09-20',
      displayScope: 'today',
      fetchedAt: '2026-09-20 09:30',
      sourceStatus: 'fresh',
      runStatus: {
        state: 'completed',
        scheduledAt: '2026-09-20 09:30',
        ...({ archiveSyncState: 'syncing' } as object),
      },
      checkedTasks: ['morning-off-duty-check'],
      summary: { expected: 1, normal: 1, anomaly: 0, excluded: 0 },
      entries: [],
    };

    const html = renderToStaticMarkup(
      React.createElement(TodayAttendanceAnomalyList, {
        snapshot,
        state: 'ready',
        retry: () => undefined,
      }),
    );

    expect(html).not.toContain('飞书多维表归档正在后台同步');
    expect(html).not.toContain('飞书多维表归档仍在后台重试');
    expect(html).not.toContain('补卡状态待核验');
  });

  it('does not present a retained morning result as a failed evening result', () => {
    const snapshot: TodayAttendanceSnapshot = {
      date: '2026-09-17',
      displayScope: 'today',
      fetchedAt: '2026-09-17 09:30',
      sourceStatus: 'failed',
      runStatus: {
        state: 'failed',
        scheduledAt: '2026-09-17 18:35',
        failureReason: '钉钉考勤数据拉取失败',
        finalFailure: true,
      },
      checkedTasks: ['morning-off-duty-check'],
      summary: { expected: 1, normal: 0, anomaly: 1, excluded: 0 },
      entries: [
        {
          key: 'morning-only',
          name: '早间异常员工',
          building: 'C楼',
          shiftLabel: '白班',
          direction: 'OnDuty',
          expectedAt: '2026-09-17 09:00',
          status: 'anomaly',
          reason: '未打卡',
        },
      ],
    };
    const html = renderToStaticMarkup(
      React.createElement(TodayAttendanceAnomalyList, {
        snapshot,
        state: 'ready',
        retry: () => undefined,
      }),
    );

    expect(html).toContain('18:35 考勤终检失败');
    expect(html).not.toContain('早间异常员工');
  });

  it('renders an admin correction badge as an evidence viewer button', () => {
    const snapshot: TodayAttendanceSnapshot = {
      date: '2026-09-18',
      displayScope: 'previous-day',
      fetchedAt: '2026-09-19 00:30',
      sourceStatus: 'fresh',
      checkedTasks: [],
      summary: { expected: 1, normal: 0, anomaly: 1, excluded: 0 },
      entries: [
        {
          key: 'h-han-off',
          name: '韩珂岩',
          building: 'H楼',
          shiftLabel: '白班',
          direction: 'OffDuty',
          expectedAt: '2026-09-18 18:00:00',
          status: 'anomaly',
          reason: '补卡举证未核验',
        },
      ],
    };

    const html = renderToStaticMarkup(
      React.createElement(TodayAttendanceAnomalyList, {
        snapshot,
        state: 'ready',
        retry: () => undefined,
        canViewCorrectionEvidence: true,
      }),
    );

    expect(html).toContain('补卡后正常');
    expect(html).not.toContain('举证待核验');
    expect(html).toContain('aria-label="查看韩珂岩下班补卡举证"');
    expect(html).toContain('<button');
  });
});
