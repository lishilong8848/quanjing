export const EMPLOYEE_ONBOARDING_DIRECT_PATH = '/employee-onboarding';

export function isEmployeeOnboardingDirectPath(pathname: string): boolean {
  return (
    String(pathname || '/')
      .toLowerCase()
      .replace(/\/+$/g, '') === EMPLOYEE_ONBOARDING_DIRECT_PATH
  );
}
