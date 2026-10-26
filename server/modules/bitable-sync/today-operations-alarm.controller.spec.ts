jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const noOpDecorator =
    () =>
    (..._args: unknown[]) =>
      undefined;
  return {
    ...actual,
    Controller: noOpDecorator,
    Get: noOpDecorator,
    Post: noOpDecorator,
    Query: noOpDecorator,
    Param: noOpDecorator,
    Res: noOpDecorator,
    Header: noOpDecorator,
    Body: noOpDecorator,
    Optional: noOpDecorator,
  };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BitableSyncController } from './bitable-sync.controller';

const controllerSource = readFileSync(
  join(process.cwd(), 'server/modules/bitable-sync/bitable-sync.controller.ts'),
  'utf8',
);
const moduleSource = readFileSync(
  join(process.cwd(), 'server/modules/bitable-sync/bitable-sync.module.ts'),
  'utf8',
);

interface AlarmControllerHarness {
  getTodayOperationsAlarms(
    page?: string,
    pageSize?: string,
    metric?: string,
    building?: string,
    level?: string,
    status?: string,
    processingStatus?: string,
    recoveryStatus?: string,
    q?: string,
    refresh?: string,
  ): Promise<unknown>;
  getCampusOperationsDashboard(
    forceRefresh?: string,
    refresh?: string,
    screenshotDate?: string,
    screenshotShift?: string,
  ): Promise<unknown>;
}

function createControllerHarness() {
  const bitableSyncService = {
    getCampusOperationsDashboard: jest.fn().mockResolvedValue({ old: true }),
  };
  const todayOperationsAlarmService = {
    getDashboard: jest.fn().mockResolvedValue({ summary: {} }),
  };
  const controller = new BitableSyncController(
    bitableSyncService as never,
    {} as never,
    {} as never,
    {} as never,
    todayOperationsAlarmService as never,
    {} as never,
  ) as unknown as AlarmControllerHarness;
  return { controller, bitableSyncService, todayOperationsAlarmService };
}

function getRouteBlock(route: string, nextRoute: string): string {
  const start = controllerSource.indexOf(`@Get('${route}')`);
  if (start === -1) return '';
  const end = controllerSource.indexOf(`@Get('${nextRoute}')`, start);
  return controllerSource.slice(
    start,
    end === -1 ? controllerSource.length : end,
  );
}

describe('today operations alarm API wiring', () => {
  it('delegates alarm filters, paging and refresh to the independent service', async () => {
    const { controller, todayOperationsAlarmService } =
      createControllerHarness();

    await controller.getTodayOperationsAlarms(
      '2',
      '20',
      'expected',
      'A楼',
      '重要',
      '处理中',
      '未处理',
      '未恢复',
      '支撑开关',
      'format',
      '1',
    );

    expect(todayOperationsAlarmService.getDashboard).toHaveBeenCalledWith({
      page: '2',
      pageSize: '20',
      metric: 'expected',
      building: 'A楼',
      level: '重要',
      status: '处理中',
      processingStatus: '未处理',
      recoveryStatus: '未恢复',
      q: '支撑开关',
      tagIssueCode: 'format',
      refresh: '1',
    });
  });

  it('publishes a guest-readable no-store GET route without changing the old route', async () => {
    const alarmRoute = getRouteBlock(
      'today-operations-alarms',
      'today-operations-overview',
    );
    expect(alarmRoute).toContain('@GuestReadable()');
    expect(alarmRoute).toContain("@Get('today-operations-alarms')");
    expect(alarmRoute).toContain("@Query('page') page?: string");
    expect(alarmRoute).toContain("@Query('pageSize') pageSize?: string");
    expect(alarmRoute).toContain("@Query('metric') metric?: string");
    expect(alarmRoute).toContain(
      "@Query('processingStatus') processingStatus?: string",
    );
    expect(alarmRoute).toContain(
      "@Query('recoveryStatus') recoveryStatus?: string",
    );
    expect(alarmRoute).toContain("@Query('refresh') refresh?: string");
    expect(alarmRoute).toContain("'Cache-Control'");
    expect(alarmRoute).toContain(
      "'no-store, no-cache, must-revalidate, proxy-revalidate'",
    );

    const { controller, bitableSyncService } = createControllerHarness();
    await controller.getCampusOperationsDashboard(
      '1',
      undefined,
      '2026-07-20',
      'night',
    );
    expect(
      bitableSyncService.getCampusOperationsDashboard,
    ).toHaveBeenCalledWith(true, '2026-07-20', 'night');
  });

  it('registers and exports the alarm service in BitableSyncModule', () => {
    expect(controllerSource).not.toContain('@Optional()');
    expect(controllerSource).not.toContain(
      'todayOperationsAlarmService?: TodayOperationsAlarmService',
    );
    expect(moduleSource).toContain(
      "import { TodayOperationsAlarmService } from './today-operations-alarm.service'",
    );
    expect(moduleSource).toMatch(
      /providers:\s*\[[^\]]*TodayOperationsAlarmService[^\]]*\]/s,
    );
    expect(moduleSource).toMatch(
      /exports:\s*\[[^\]]*TodayOperationsAlarmService[^\]]*\]/s,
    );
  });
});
