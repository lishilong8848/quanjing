import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EquipmentLifecycleModule } from './equipment-lifecycle.module';

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
    const names = (key: string): string[] => Reflect.getMetadata(key, EquipmentLifecycleModule).map((entry: { name: string }) => entry.name).sort();
    expect(names('controllers')).toEqual(['EquipmentLedgerController', 'EquipmentLifecycleController']);
    expect(names('providers')).toEqual(['EquipmentHistoryService', 'EquipmentLedgerService', 'EquipmentLifecycleService', 'EquipmentRepairSourceService']);
    expect(names('exports')).toEqual(['EquipmentLifecycleService']);
    expect(Reflect.getMetadata('imports', EquipmentLifecycleModule)).toHaveLength(1);
    expect(moduleSource).toContain('HttpModule.register');
  });
});
