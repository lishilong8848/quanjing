jest.mock(
  '@server/common/config/external-services.config',
  () => ({ readEnv: jest.fn(() => '') }),
  { virtual: true },
);

import {
  createCampusOperationsScreenshotAccessToken,
  createMonthlyScheduleScreenshotAccessToken,
  verifyCampusOperationsScreenshotAccessToken,
  verifyMonthlyScheduleScreenshotAccessToken,
  verifyScreenshotAccessRequest,
} from '../../server/modules/duty-schedule/monthly-schedule-screenshot-access';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('monthly schedule screenshot access control', () => {
  it('requires a signed token bound to the screenshot date and expiry', () => {
    const screenshotDate = '2026-07-02';
    const token = createMonthlyScheduleScreenshotAccessToken(
      screenshotDate,
      1782950000000,
    );

    expect(
      verifyMonthlyScheduleScreenshotAccessToken(
        screenshotDate,
        token,
        1782950001000,
      ),
    ).toBe(true);
    expect(
      verifyMonthlyScheduleScreenshotAccessToken(
        screenshotDate,
        '',
        1782950001000,
      ),
    ).toBe(false);
    expect(
      verifyMonthlyScheduleScreenshotAccessToken(
        '2026-07-03',
        token,
        1782950001000,
      ),
    ).toBe(false);
    expect(
      verifyMonthlyScheduleScreenshotAccessToken(
        screenshotDate,
        token,
        1782950900000,
      ),
    ).toBe(false);
  });

  it('isolates monthly and campus tokens by audience', () => {
    const screenshotDate = '2026-07-22';
    const now = 1784685600000;
    const monthlyToken = createMonthlyScheduleScreenshotAccessToken(
      screenshotDate,
      now,
    );
    const campusToken = createCampusOperationsScreenshotAccessToken(
      screenshotDate,
      'white',
      now,
    );

    expect(
      verifyMonthlyScheduleScreenshotAccessToken(
        screenshotDate,
        campusToken,
        now + 1000,
      ),
    ).toBe(false);
    expect(
      verifyCampusOperationsScreenshotAccessToken(
        screenshotDate,
        'white',
        monthlyToken,
        now + 1000,
      ),
    ).toBe(false);
  });

  it('binds campus tokens to date, shift, and audience', () => {
    const screenshotDate = '2026-07-22';
    const now = 1784685600000;
    const token = createCampusOperationsScreenshotAccessToken(
      screenshotDate,
      'white',
      now,
    );

    expect(
      verifyCampusOperationsScreenshotAccessToken(
        screenshotDate,
        'white',
        token,
        now + 1000,
      ),
    ).toBe(true);
    expect(
      verifyCampusOperationsScreenshotAccessToken(
        screenshotDate,
        'night',
        token,
        now + 1000,
      ),
    ).toBe(false);
    expect(
      verifyCampusOperationsScreenshotAccessToken(
        '2026-07-23',
        'white',
        token,
        now + 1000,
      ),
    ).toBe(false);
  });

  it('requires the screenshot-check request to declare its audience and campus shift', () => {
    const screenshotDate = '2026-07-22';
    const now = 1784685600000;
    const token = createCampusOperationsScreenshotAccessToken(
      screenshotDate,
      'white',
      now,
    );

    expect(
      verifyScreenshotAccessRequest(
        {
          audience: 'campus-operations',
          screenshotDate,
          screenshotShift: 'white',
          token,
        },
        now + 1000,
      ),
    ).toBe(true);
    expect(
      verifyScreenshotAccessRequest(
        { screenshotDate, screenshotShift: 'white', token },
        now + 1000,
      ),
    ).toBe(false);
    expect(
      verifyScreenshotAccessRequest(
        {
          audience: 'campus-operations',
          screenshotDate,
          token,
        },
        now + 1000,
      ),
    ).toBe(false);
  });

  it('rejects tokens whose expiry is beyond the allowed lifetime', () => {
    const screenshotDate = '2026-07-22';
    const now = 1784685600000;
    const tokenIssuedOneHourLater = createCampusOperationsScreenshotAccessToken(
      screenshotDate,
      'white',
      now + 60 * 60 * 1000,
    );

    expect(
      verifyCampusOperationsScreenshotAccessToken(
        screenshotDate,
        'white',
        tokenIssuedOneHourLater,
        now,
      ),
    ).toBe(false);
  });

  it('fails closed in production when no screenshot signing secret is configured', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() =>
        createMonthlyScheduleScreenshotAccessToken('2026-07-22'),
      ).toThrow('截图访问签名密钥');
    } finally {
      if (originalNodeEnv === undefined) {
        delete process.env.NODE_ENV;
      } else {
        process.env.NODE_ENV = originalNodeEnv;
      }
    }
  });

  it('does not ship the retired public fallback signing secret', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/monthly-schedule-screenshot-access.ts',
      ),
      'utf8',
    );
    expect(source).not.toContain(
      "'local-development-monthly-schedule-screenshot'",
    );
  });
});
