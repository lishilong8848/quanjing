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

import { BadRequestException } from '@nestjs/common';
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
const clientApiSource = readFileSync(
  join(process.cwd(), 'client/src/api/index.ts'),
  'utf8',
);

interface TrainingControllerHarness {
  trainingDashboardService: {
    getDashboard: jest.Mock;
  };
  getCampusTrainingDashboard(
    month?: unknown,
    forceRefresh?: string,
  ): Promise<unknown>;
}

function createControllerHarness() {
  const trainingDashboardService = {
    getDashboard: jest.fn().mockResolvedValue({ month: '2026-07' }),
  };
  const controller = new BitableSyncController(
    {} as never,
    {} as never,
    {} as never,
    trainingDashboardService as never,
    {} as never,
    {} as never,
  ) as unknown as TrainingControllerHarness;
  return { controller, trainingDashboardService };
}

function getTrainingDashboardRouteBlock(): string {
  const start = controllerSource.indexOf("@Get('campus-training-dashboard')");
  if (start === -1) return '';
  const nextRoute = controllerSource.indexOf(
    "@Get('campus-certificate-dashboard')",
    start,
  );
  return controllerSource.slice(
    start,
    nextRoute === -1 ? controllerSource.length : nextRoute,
  );
}

function getClientFunctionBlock(functionName: string): string {
  const start = clientApiSource.indexOf(
    `export async function ${functionName}(`,
  );
  if (start === -1) return '';
  const nextFunction = clientApiSource.indexOf(
    '\nexport async function ',
    start + 1,
  );
  return clientApiSource.slice(
    start,
    nextFunction === -1 ? clientApiSource.length : nextFunction,
  );
}

describe('campus training dashboard API wiring', () => {
  it('delegates normalized month and refresh flags to TrainingDashboardService', async () => {
    const { controller, trainingDashboardService } = createControllerHarness();

    await controller.getCampusTrainingDashboard('2026-07', '1');
    await controller.getCampusTrainingDashboard(undefined, undefined);
    await controller.getCampusTrainingDashboard('2026-07', 'true');

    expect(trainingDashboardService.getDashboard).toHaveBeenNthCalledWith(
      1,
      '2026-07',
      true,
    );
    expect(trainingDashboardService.getDashboard).toHaveBeenNthCalledWith(
      2,
      undefined,
      false,
    );
    expect(trainingDashboardService.getDashboard).toHaveBeenNthCalledWith(
      3,
      '2026-07',
      true,
    );
  });

  it('accepts only a strict YYYY-MM month and rejects malformed values', async () => {
    const { controller, trainingDashboardService } = createControllerHarness();

    await controller.getCampusTrainingDashboard('2026-01', undefined);
    expect(trainingDashboardService.getDashboard).toHaveBeenCalledWith(
      '2026-01',
      false,
    );

    for (const invalidMonth of ['2026-7', '2026-13', 'x']) {
      await expect(
        controller.getCampusTrainingDashboard(invalidMonth, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(trainingDashboardService.getDashboard).toHaveBeenCalledTimes(1);
  });

  it('rejects non-string months without calling the service', async () => {
    const { controller, trainingDashboardService } = createControllerHarness();

    for (const invalidMonth of [['2026-07'], { value: '2026-07' }]) {
      await expect(
        controller.getCampusTrainingDashboard(invalidMonth, undefined),
      ).rejects.toBeInstanceOf(BadRequestException);
    }

    expect(trainingDashboardService.getDashboard).not.toHaveBeenCalled();
  });

  it('trims optional months, treats whitespace as omitted, and accepts any four-digit year', async () => {
    const { controller, trainingDashboardService } = createControllerHarness();

    await controller.getCampusTrainingDashboard(' 2026-07 ', undefined);
    await controller.getCampusTrainingDashboard('   ', undefined);
    await controller.getCampusTrainingDashboard('2100-01', undefined);

    expect(trainingDashboardService.getDashboard).toHaveBeenNthCalledWith(
      1,
      '2026-07',
      false,
    );
    expect(trainingDashboardService.getDashboard).toHaveBeenNthCalledWith(
      2,
      undefined,
      false,
    );
    expect(trainingDashboardService.getDashboard).toHaveBeenNthCalledWith(
      3,
      '2100-01',
      false,
    );
  });

  it('publishes an authenticated no-store training dashboard GET route', () => {
    const method = getTrainingDashboardRouteBlock();

    expect(method).not.toContain('@GuestReadable()');
    expect(method).toContain("@Get('campus-training-dashboard')");
    expect(method).toContain("@Query('month') month?: unknown");
    expect(method).toContain("@Query('forceRefresh') forceRefresh?: unknown");
    expect(method).toContain("'Cache-Control'");
    expect(method).toContain(
      "'no-store, no-cache, must-revalidate, proxy-revalidate'",
    );
    expect(method).toContain("@Header('Pragma', 'no-cache')");
    expect(method).toContain("@Header('Expires', '0')");
  });

  it('registers and exports TrainingDashboardService from BitableSyncModule', () => {
    expect(moduleSource).toContain(
      "import { TrainingDashboardService } from './training-dashboard.service'",
    );
    expect(moduleSource).toMatch(
      /providers:\s*\[[^\]]*TrainingDashboardService[^\]]*\]/s,
    );
    expect(moduleSource).toMatch(
      /exports:\s*\[[^\]]*TrainingDashboardService[^\]]*\]/s,
    );
  });

  it('exports the typed no-cache client request with month and forceRefresh params', () => {
    const apiFunction = getClientFunctionBlock('getCampusTrainingDashboard');

    expect(clientApiSource).toMatch(
      /import type\s*(?:\{[\s\S]*CampusTrainingDashboardResponse[\s\S]*\}|CampusTrainingDashboardResponse)\s*from\s*['"]@shared\/campus-training-dashboard\.interface['"]/,
    );
    expect(apiFunction).toMatch(
      /getCampusTrainingDashboard\(\s*month\?:\s*string,\s*forceRefresh(?:\?:\s*boolean|\s*=\s*false)/,
    );
    expect(apiFunction).toContain(
      "url: '/api/bitable/campus-training-dashboard'",
    );
    expect(apiFunction).toMatch(/params:[\s\S]*month/);
    expect(apiFunction).toContain("forceRefresh: '1'");
    expect(apiFunction).toContain("'Cache-Control': 'no-cache'");
    expect(apiFunction).toMatch(/timeout:\s*120_?000/);
    expect(apiFunction).toContain('Promise<CampusTrainingDashboardResponse>');
  });
});
