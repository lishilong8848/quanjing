import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const pageSource = readFileSync(
  join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
  'utf8',
);

function occurrences(source: string, pattern: RegExp): number {
  return source.match(pattern)?.length ?? 0;
}

describe('monthly schedule employee onboarding entry', () => {
  it('imports and mounts one lazy onboarding host with one typed ref', () => {
    expect(pageSource).toContain(
      "import {\n  NewEmployeeOnboardingDialogHost,\n  type NewEmployeeOnboardingDialogHandle,\n} from './NewEmployeeOnboardingDialogHost';",
    );
    expect(
      occurrences(pageSource, /const employeeOnboardingDialogRef\s*=/g),
    ).toBe(1);
    expect(pageSource).toMatch(
      /useRef<NewEmployeeOnboardingDialogHandle>\(null\)/,
    );
    expect(occurrences(pageSource, /const commonToolsTriggerRef\s*=/g)).toBe(1);
    expect(pageSource).toMatch(/useRef<HTMLButtonElement>\(null\)/);
    expect(occurrences(pageSource, /ref=\{commonToolsTriggerRef\}/g)).toBe(1);
    expect(occurrences(pageSource, /<NewEmployeeOnboardingDialogHost\b/g)).toBe(
      1,
    );
    expect(pageSource).toMatch(
      /<OvertimeRequestDialogHost[\s\S]*?<NewEmployeeOnboardingDialogHost\s+ref=\{employeeOnboardingDialogRef\}\s*\/>[\s\S]*?<OvertimeConfirmationDeepLinkHost/,
    );
  });

  it('places guest-available onboarding and MBTI entries before admin tools', () => {
    expect(pageSource).toContain(
      "const canUseSelfServiceTools = canManageMonthlySchedule || role === 'guest';",
    );

    const personnelMenuStart = pageSource.indexOf('人员相关');
    const personnelMenuEnd = pageSource.indexOf(
      '</DropdownMenuSubContent>',
      personnelMenuStart,
    );
    const personnelMenuSource = pageSource.slice(
      personnelMenuStart,
      personnelMenuEnd,
    );
    const overtimeIndex = personnelMenuSource.indexOf('加班申请');
    const onboardingIndex = personnelMenuSource.indexOf('新员工入职');
    const mbtiIndex = personnelMenuSource.indexOf('MBTI 测试');
    const adminBlockIndex = personnelMenuSource.indexOf(
      '{canManageMonthlySchedule && (',
    );
    const selfServiceGateIndex = pageSource.lastIndexOf(
      '{canUseSelfServiceTools && (',
      personnelMenuStart,
    );

    expect(personnelMenuStart).toBeGreaterThanOrEqual(0);
    expect(personnelMenuEnd).toBeGreaterThan(personnelMenuStart);
    expect(selfServiceGateIndex).toBeGreaterThanOrEqual(0);
    expect(overtimeIndex).toBeGreaterThanOrEqual(0);
    expect(onboardingIndex).toBeGreaterThan(overtimeIndex);
    expect(mbtiIndex).toBeGreaterThan(onboardingIndex);
    expect(adminBlockIndex).toBeGreaterThan(mbtiIndex);
    const betweenOvertimeAndOnboarding = personnelMenuSource.slice(
      overtimeIndex,
      onboardingIndex,
    );
    expect(betweenOvertimeAndOnboarding).not.toContain(
      'canManageMonthlySchedule',
    );
    expect(
      occurrences(betweenOvertimeAndOnboarding, /<DropdownMenuItem\b/g),
    ).toBe(1);
    expect(
      occurrences(personnelMenuSource.slice(onboardingIndex, adminBlockIndex), /<DropdownMenuItem\b/g),
    ).toBe(1);
  });

  it('opens the host from a UserPlus menu item with the stable common-tools trigger', () => {
    const onboardingLabelIndex = pageSource.indexOf('新员工入职');
    const entryStart = pageSource.lastIndexOf(
      '<DropdownMenuItem',
      onboardingLabelIndex,
    );
    const entryEnd = pageSource.indexOf(
      '</DropdownMenuItem>',
      onboardingLabelIndex,
    );
    const entrySource = pageSource.slice(entryStart, entryEnd);

    expect(onboardingLabelIndex).toBeGreaterThanOrEqual(0);
    expect(entryStart).toBeGreaterThanOrEqual(0);
    expect(entryEnd).toBeGreaterThan(onboardingLabelIndex);
    expect(entrySource).toMatch(
      /onSelect=\{\(\) =>\s*employeeOnboardingDialogRef\.current\?\.open\(\s*commonToolsTriggerRef\.current,?\s*\)\s*\}/,
    );
    const commonToolsLabelIndex = pageSource.indexOf('常用工具');
    const commonToolsTriggerStart = pageSource.lastIndexOf(
      '<Button',
      commonToolsLabelIndex,
    );
    const commonToolsTriggerEnd = pageSource.indexOf(
      '</Button>',
      commonToolsLabelIndex,
    );
    const commonToolsTriggerSource = pageSource.slice(
      commonToolsTriggerStart,
      commonToolsTriggerEnd,
    );
    expect(commonToolsTriggerStart).toBeGreaterThanOrEqual(0);
    expect(commonToolsTriggerEnd).toBeGreaterThan(commonToolsLabelIndex);
    expect(commonToolsTriggerSource).toContain('ref={commonToolsTriggerRef}');
    expect(entrySource).toContain('<UserPlus className="h-3.5 w-3.5" />');
    expect(entrySource).not.toContain('requestLogin');
    expect(pageSource).not.toContain('requestLogin');
  });
});
