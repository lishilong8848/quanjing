import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EMPLOYEE_ONBOARDING_DIRECT_PATH,
  isEmployeeOnboardingDirectPath,
} from '../../client/src/navigation/employee-onboarding-route';

describe('employee onboarding direct entry', () => {
  it('dispatches only the exact standalone registration route', () => {
    expect(EMPLOYEE_ONBOARDING_DIRECT_PATH).toBe('/employee-onboarding');
    expect(isEmployeeOnboardingDirectPath('/employee-onboarding')).toBe(true);
    expect(isEmployeeOnboardingDirectPath('/EMPLOYEE-ONBOARDING///')).toBe(
      true,
    );
    expect(isEmployeeOnboardingDirectPath('/employee-onboarding-extra')).toBe(
      false,
    );
    expect(isEmployeeOnboardingDirectPath('/employee-onboarding/other')).toBe(
      false,
    );
    expect(isEmployeeOnboardingDirectPath('/monthly-schedule')).toBe(false);
    expect(isEmployeeOnboardingDirectPath('')).toBe(false);
  });

  it('loads the form entry before the main application and retains its submission coordinator', () => {
    const entry = readFileSync(
      join(process.cwd(), 'client/src/index.tsx'),
      'utf8',
    );
    expect(entry).toContain("import('./pages/EmployeeOnboarding')");
    const page = readFileSync(
      join(process.cwd(), 'client/src/pages/EmployeeOnboarding/index.tsx'),
      'utf8',
    );
    expect(page).toContain('NewEmployeeOnboardingDialog');
    expect(page).toContain('onSubmissionStateChange={setSubmission}');
    expect(page).not.toContain('createEmployeeOnboarding');
    expect(page).not.toContain('MonthlySchedule />');
  });
});
