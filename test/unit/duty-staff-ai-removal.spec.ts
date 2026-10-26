import { readFileSync } from 'fs';
import { join } from 'path';

describe('removed duty staff AI field', () => {
  it('has no production references', () => {
    const files = [
      'server/modules/duty-schedule/duty-staff-actual-field.ts',
      'server/modules/duty-schedule/duty-schedule.service.ts',
      'server/modules/duty-schedule/duty-schedule.controller.ts',
      'server/modules/duty-schedule/duty-schedule.automation.ts',
      'server/modules/duty-schedule/leave-substitute-audit.ts',
      'server/modules/bitable-sync/bitable-sync.service.ts',
      'client/src/api/index.ts',
      'client/src/pages/DutyStaffRepair/index.tsx',
      'client/src/pages/MonthlySchedule/index.tsx',
    ];
    const source = files
      .map((file) => readFileSync(join(process.cwd(), file), 'utf8'))
      .join('\n');

    expect(source).not.toMatch(/fld2xDxrRH/);
    expect(source).not.toMatch(/值班人员（实际）ai/i);
    expect(source).not.toMatch(/duty-staff-actual-ai/);
    expect(source).not.toMatch(/refreshDutyStaffActualFromRules/);
  });
});
