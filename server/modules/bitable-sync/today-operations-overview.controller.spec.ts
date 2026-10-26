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

interface OverviewControllerHarness {
  getTodayOperationsOverview(refresh?: string): Promise<unknown>;
}

function createControllerHarness() {
  const todayOperationsOverviewService = {
    getOverview: jest.fn().mockResolvedValue({ sourceStatus: 'fresh' }),
  };
  const controller = Reflect.construct(BitableSyncController, [
    {},
    {},
    {},
    {},
    {},
    todayOperationsOverviewService,
  ]) as OverviewControllerHarness;
  return { controller, todayOperationsOverviewService };
}

describe('today operations overview API wiring', () => {
  it('delegates the independent overview request and refresh flag', async () => {
    const { controller, todayOperationsOverviewService } =
      createControllerHarness();

    await controller.getTodayOperationsOverview('true');
    await controller.getTodayOperationsOverview('1');
    await controller.getTodayOperationsOverview();

    expect(todayOperationsOverviewService.getOverview).toHaveBeenNthCalledWith(
      1,
      true,
    );
    expect(todayOperationsOverviewService.getOverview).toHaveBeenNthCalledWith(
      2,
      true,
    );
    expect(todayOperationsOverviewService.getOverview).toHaveBeenNthCalledWith(
      3,
      false,
    );
  });

  it('publishes a guest-readable no-store GET route', () => {
    const start = controllerSource.indexOf("@Get('today-operations-overview')");
    const nextRoute = controllerSource.indexOf('\n  @Get(', start + 1);
    const routeBlock = controllerSource.slice(
      start,
      nextRoute === -1 ? controllerSource.length : nextRoute,
    );

    expect(start).toBeGreaterThanOrEqual(0);
    expect(controllerSource).toMatch(
      /@GuestReadable\(\)\s*@Get\('today-operations-overview'\)/,
    );
    expect(routeBlock).toContain("@Query('refresh') refresh?: string");
    expect(routeBlock).toContain("'Cache-Control'");
    expect(routeBlock).toContain(
      "'no-store, no-cache, must-revalidate, proxy-revalidate'",
    );
  });

  it('registers and exports the overview service in BitableSyncModule', () => {
    expect(moduleSource).toContain(
      "import { TodayOperationsOverviewService } from './today-operations-overview.service'",
    );
    expect(moduleSource).toMatch(
      /providers:\s*\[[^\]]*TodayOperationsOverviewService[^\]]*\]/s,
    );
    expect(moduleSource).toMatch(
      /exports:\s*\[[^\]]*TodayOperationsOverviewService[^\]]*\]/s,
    );
  });
});
