import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const controllerSource = readFileSync(
  join(
    process.cwd(),
    'server/modules/equipment-lifecycle/equipment-lifecycle.controller.ts',
  ),
  'utf8',
);
const moduleSource = readFileSync(
  join(
    process.cwd(),
    'server/modules/equipment-lifecycle/equipment-lifecycle.module.ts',
  ),
  'utf8',
);

describe('EquipmentLifecycleController', () => {
  test('publishes a no-store dashboard route', () => {
    expect(controllerSource).toContain(
      "@Controller('api/equipment-lifecycle')",
    );
    expect(controllerSource).toContain("@Get('dashboard')");
    expect(controllerSource).toContain(
      "'no-store, no-cache, must-revalidate, proxy-revalidate'",
    );
  });

  test('accepts both refresh query conventions', () => {
    expect(controllerSource).toContain("@Query('refresh') refresh?: string");
    expect(controllerSource).toContain(
      "@Query('forceRefresh') forceRefresh?: string",
    );
    expect(controllerSource).toContain(
      'isForceRefresh(refresh) || isForceRefresh(forceRefresh)',
    );
    expect(controllerSource).toContain("value === '1'");
    expect(controllerSource).toContain("value?.toLowerCase() === 'true'");
  });

  test('registers the controller and service in a bounded module', () => {
    expect(moduleSource).toContain(
      'controllers: [EquipmentLifecycleController]',
    );
    expect(moduleSource).toContain('providers: [EquipmentLifecycleService]');
    expect(moduleSource).toContain('HttpModule.register');
  });
});
