import { readMonthlyScheduleFormDeepLink } from '../../client/src/pages/MonthlySchedule/monthly-schedule-form-deep-link';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const monthlySchedulePageSource = readFileSync(
  join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
  'utf8',
);

describe('monthly schedule form deep links', () => {
  it.each([
    ['leave', 'leave'],
    ['overtime', 'overtime'],
  ] as const)('reads the supported form value %s', (value, expected) => {
    expect(
      readMonthlyScheduleFormDeepLink(
        new URLSearchParams(`form=${encodeURIComponent(value)}`),
      ),
    ).toBe(expected);
  });

  it.each(['', 'Leave', 'overtime ', 'change', 'unknown'])(
    'ignores unsupported form value %s',
    (value) => {
      expect(
        readMonthlyScheduleFormDeepLink(
          new URLSearchParams(`form=${encodeURIComponent(value)}`),
        ),
      ).toBeNull();
    },
  );

  it.each([
    ['/monthly-schedule/apply/leave', 'leave'],
    ['/monthly-schedule/apply/overtime', 'overtime'],
  ] as const)('reads the mobile-safe direct path %s', (pathname, expected) => {
    expect(
      readMonthlyScheduleFormDeepLink(new URLSearchParams(), pathname),
    ).toBe(expected);
  });

  it('prefers the dedicated direct path over a stale query parameter', () => {
    expect(
      readMonthlyScheduleFormDeepLink(
        new URLSearchParams('form=overtime'),
        '/monthly-schedule/apply/leave',
      ),
    ).toBe('leave');
  });

  it('opens the leave dialog from the direct form parameter', () => {
    expect(monthlySchedulePageSource).toContain(
      "if (directForm === 'leave')",
    );
    expect(monthlySchedulePageSource).toContain(
      'setLeaveRequestDialogOpen(true)',
    );
  });

  it('registers dedicated mobile-safe form routes', () => {
    const appSource = readFileSync(
      join(process.cwd(), 'client/src/App.tsx'),
      'utf8',
    );
    expect(appSource).toContain(
      'path="/monthly-schedule/apply/leave"',
    );
    expect(appSource).toContain(
      'path="/monthly-schedule/apply/overtime"',
    );
  });

  it('opens the overtime dialog from the direct form parameter', () => {
    expect(monthlySchedulePageSource).toContain(
      "if (directForm === 'overtime')",
    );
    expect(monthlySchedulePageSource).toContain(
      'overtimeRequestDialogRef.current?.open()',
    );
  });

  it('consumes the direct form parameter once without rewriting the shareable URL', () => {
    expect(monthlySchedulePageSource).toContain(
      'monthlyScheduleFormDeepLinkConsumedRef.current',
    );
    expect(monthlySchedulePageSource).not.toContain(
      'clearMonthlyScheduleFormDeepLink',
    );
  });
});
