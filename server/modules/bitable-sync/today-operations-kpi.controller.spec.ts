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
    Query: noOpDecorator,
    Header: noOpDecorator,
  };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TodayOperationsKpiController } from './today-operations-kpi.controller';

const controllerSource = readFileSync(
  join(
    process.cwd(),
    'server/modules/bitable-sync/today-operations-kpi.controller.ts',
  ),
  'utf8',
);
const moduleSource = readFileSync(
  join(process.cwd(), 'server/modules/bitable-sync/bitable-sync.module.ts'),
  'utf8',
);

describe('today operations top KPI API wiring', () => {
  it('delegates normal and explicit refresh requests', async () => {
    const service = {
      getKpis: jest.fn().mockResolvedValue({ sourceStatus: 'fresh' }),
    };
    const controller = Reflect.construct(TodayOperationsKpiController, [
      service,
    ]) as {
      getTodayOperationsKpis(refresh?: string): Promise<unknown>;
    };

    await controller.getTodayOperationsKpis();
    await controller.getTodayOperationsKpis('1');
    await controller.getTodayOperationsKpis('true');

    expect(service.getKpis).toHaveBeenNthCalledWith(1, false);
    expect(service.getKpis).toHaveBeenNthCalledWith(2, true);
    expect(service.getKpis).toHaveBeenNthCalledWith(3, true);
  });

  it('publishes a guest-readable no-store route and registers the controller and service', () => {
    expect(controllerSource).toMatch(
      /@GuestReadable\(\)\s*@Get\('today-operations-kpis'\)/,
    );
    expect(controllerSource).toContain("@Get('today-operations-kpis')");
    expect(controllerSource).toContain("@Query('refresh') refresh?: string");
    expect(controllerSource).toContain(
      "'no-store, no-cache, must-revalidate, proxy-revalidate'",
    );
    expect(moduleSource).toContain('TodayOperationsKpiController');
    expect(moduleSource).toContain('TodayOperationsKpiService');
  });
});
