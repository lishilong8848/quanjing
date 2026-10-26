import { DutyScreenshotService } from '../../server/modules/duty-schedule/duty-screenshot.service';
import {
  verifyCampusOperationsScreenshotAccessToken,
  verifyMonthlyScheduleScreenshotAccessToken,
} from '../../server/modules/duty-schedule/monthly-schedule-screenshot-access';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('DutyScreenshotService', () => {
  it('sends a manual duty overview screenshot without waiting for campus screenshots or daily report writes', async () => {
    const dailyReportBitableService = {
      appendScreenshot: jest.fn().mockResolvedValue({
        recordId: 'daily-report-record',
        shiftLabel: '白班',
      }),
    };
    const service = new DutyScreenshotService(
      {} as never,
      dailyReportBitableService as never,
    );
    const internals = service as unknown as {
      captureDutyOverview: (
        date: string,
        source: 'manual',
      ) => Promise<{
        buffer: Buffer;
        path: string;
      }>;
      captureCampusOperationsDashboard: () => Promise<{
        buffer: Buffer;
        path: string;
      }>;
      getTargetChatIds: () => string[];
      getTenantAccessToken: () => Promise<string>;
      uploadImage: (token: string, image: Buffer) => Promise<string>;
      sendMessagesToChats: (
        token: string,
        chatIds: string[],
        card: Record<string, unknown>,
        imageKey: string,
      ) => Promise<Array<{ chatId: string }>>;
    };

    const screenshot = {
      buffer: Buffer.from('overview-image'),
      path: 'screenshots/overview.png',
    };
    jest.spyOn(internals, 'captureDutyOverview').mockResolvedValue(screenshot);
    const captureCampusOperationsDashboard = jest
      .spyOn(internals, 'captureCampusOperationsDashboard')
      .mockResolvedValue({
        buffer: Buffer.from('campus-image'),
        path: 'screenshots/campus.png',
      });
    jest.spyOn(internals, 'getTargetChatIds').mockReturnValue(['chat-1']);
    jest
      .spyOn(internals, 'getTenantAccessToken')
      .mockResolvedValue('tenant-token');
    jest.spyOn(internals, 'uploadImage').mockResolvedValue('image-key');
    const sendMessagesToChats = jest
      .spyOn(internals, 'sendMessagesToChats')
      .mockResolvedValue([{ chatId: 'chat-1' }]);

    await expect(
      service.captureAndSendDutyOverview({
        source: 'manual',
        date: '2026-07-17',
      }),
    ).resolves.toMatchObject({
      success: true,
      source: 'manual',
      screenshotDate: '2026-07-17',
      imageKey: 'image-key',
      screenshotPath: 'screenshots/overview.png',
    });

    expect(sendMessagesToChats).toHaveBeenCalledWith(
      'tenant-token',
      ['chat-1'],
      expect.any(Object),
      'image-key',
    );
    expect(captureCampusOperationsDashboard).not.toHaveBeenCalled();
    expect(dailyReportBitableService.appendScreenshot).not.toHaveBeenCalled();
  });

  it('waits for the screenshot-ready marker instead of waiting for a network-idle state', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-screenshot.service.ts',
      ),
      'utf8',
    );
    const captureElementSource = source.slice(
      source.indexOf('private async captureElementScreenshot'),
      source.indexOf('private async waitForScreenshotTarget'),
    );

    expect(captureElementSource).toContain('waitForScreenshotTarget');
    expect(captureElementSource).not.toContain('waitForTimeout(1_200)');
    expect(captureElementSource).not.toContain(
      "waitForLoadState('networkidle'",
    );
  });

  it('requires the screenshot-ready marker to remain continuously visible before capture', async () => {
    const service = new DutyScreenshotService({} as never, {} as never);
    const internals = service as unknown as {
      waitForStableScreenshotTarget: (
        page: unknown,
        readySelector: string,
        timeoutMs: number,
        stableMs: number,
        pollMs: number,
      ) => Promise<unknown>;
    };
    const readyStates = [true, true, false, true, true, true];
    let currentTime = 0;
    const target = {
      evaluate: jest
        .fn()
        .mockImplementation(async () => readyStates.shift() ?? true),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const page = {
      $: jest.fn().mockResolvedValue(target),
      waitForTimeout: jest.fn().mockImplementation(async (delay: number) => {
        currentTime += delay;
      }),
    };
    const dateNow = jest
      .spyOn(Date, 'now')
      .mockImplementation(() => currentTime);

    try {
      await internals.waitForStableScreenshotTarget(
        page,
        '[data-screenshot-ready="true"]',
        1_000,
        200,
        100,
      );

      expect(target.evaluate).toHaveBeenCalledTimes(6);
      expect(page.waitForTimeout).toHaveBeenCalledTimes(5);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('discards a screenshot when its ready target is invalidated during capture', async () => {
    const service = new DutyScreenshotService({} as never, {} as never);
    const firstTarget = {
      screenshot: jest.fn().mockResolvedValue(Buffer.from('stale-image')),
      evaluate: jest.fn().mockResolvedValue(false),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const secondTarget = {
      screenshot: jest.fn().mockResolvedValue(Buffer.from('ready-image')),
      evaluate: jest.fn().mockResolvedValue(true),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    const internals = service as unknown as {
      waitForScreenshotTarget: jest.Mock;
      captureVerifiedScreenshotTarget: (
        page: unknown,
        options: {
          readySelector: string;
          selector: string;
          fallbackSelector: string;
          kind: 'duty-overview';
        },
      ) => Promise<Buffer>;
    };
    jest
      .spyOn(internals, 'waitForScreenshotTarget')
      .mockResolvedValueOnce({
        target: firstTarget,
        selector: '[data-screenshot-ready="true"]',
      })
      .mockResolvedValueOnce({
        target: secondTarget,
        selector: '[data-screenshot-ready="true"]',
      });

    const buffer = await internals.captureVerifiedScreenshotTarget(
      {},
      {
        readySelector: '[data-screenshot-ready="true"]',
        selector: '[data-screenshot-target="duty-overview"]',
        fallbackSelector: '[data-screenshot-target="duty-overview"]',
        kind: 'duty-overview',
      },
    );

    expect(buffer.toString()).toBe('ready-image');
    expect(firstTarget.screenshot).toHaveBeenCalledTimes(1);
    expect(firstTarget.dispose).toHaveBeenCalledTimes(1);
    expect(secondTarget.screenshot).toHaveBeenCalledTimes(1);
  });

  it('opens the monthly schedule route with screenshot query parameters', () => {
    const service = new DutyScreenshotService({} as never, {} as never);
    const internals = service as unknown as {
      buildScreenshotPageUrl: (screenshotDate: string) => string;
    };

    const url = new URL(internals.buildScreenshotPageUrl('2026-07-17'));

    expect(url.pathname).toBe('/monthly-schedule');
    expect(url.searchParams.get('screenshot')).toBe('1');
    expect(url.searchParams.get('screenshotDate')).toBe('2026-07-17');
    const token = url.searchParams.get('screenshotToken') || '';
    expect(
      verifyMonthlyScheduleScreenshotAccessToken('2026-07-17', token),
    ).toBe(true);
    expect(
      verifyCampusOperationsScreenshotAccessToken(
        '2026-07-17',
        'white',
        token,
      ),
    ).toBe(false);
  });

  it('uses the configured local screenshot server for the campus dashboard by default', () => {
    const originalDutyUrl = process.env.DUTY_SCREENSHOT_PAGE_URL;
    const originalCampusUrl =
      process.env.DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL;
    process.env.DUTY_SCREENSHOT_PAGE_URL =
      'https://localhost:3443/monthly-schedule';
    delete process.env.DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL;

    try {
      const service = new DutyScreenshotService({} as never, {} as never);
      const internals = service as unknown as {
        buildCampusOperationsScreenshotPageUrl: (
          screenshotDate: string,
          shift?: 'white' | 'night',
        ) => string;
      };

      const url = new URL(
        internals.buildCampusOperationsScreenshotPageUrl(
          '2026-07-22',
          'white',
        ),
      );

      expect(url.origin).toBe('https://localhost:3443');
      expect(url.pathname).toBe('/campus-operations-dashboard');
      expect(url.searchParams.get('screenshot')).toBe('1');
      expect(url.searchParams.get('screenshotDate')).toBe('2026-07-22');
      expect(url.searchParams.get('screenshotShift')).toBe('white');
      const token = url.searchParams.get('screenshotToken') || '';
      expect(
        verifyCampusOperationsScreenshotAccessToken(
          '2026-07-22',
          'white',
          token,
        ),
      ).toBe(true);
      expect(
        verifyCampusOperationsScreenshotAccessToken(
          '2026-07-22',
          'night',
          token,
        ),
      ).toBe(false);
      expect(
        verifyMonthlyScheduleScreenshotAccessToken('2026-07-22', token),
      ).toBe(false);
    } finally {
      restoreEnvironment('DUTY_SCREENSHOT_PAGE_URL', originalDutyUrl);
      restoreEnvironment(
        'DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL',
        originalCampusUrl,
      );
    }
  });

  it('preserves the configured client base path for the campus screenshot route', () => {
    const originalDutyUrl = process.env.DUTY_SCREENSHOT_PAGE_URL;
    const originalCampusUrl =
      process.env.DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL;
    process.env.DUTY_SCREENSHOT_PAGE_URL =
      'https://localhost:3443/nantong/monthly-schedule';
    delete process.env.DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL;

    try {
      const service = new DutyScreenshotService({} as never, {} as never);
      const internals = service as unknown as {
        buildCampusOperationsScreenshotPageUrl: (
          screenshotDate: string,
          shift?: 'white' | 'night',
        ) => string;
      };

      const url = new URL(
        internals.buildCampusOperationsScreenshotPageUrl(
          '2026-07-22',
          'night',
        ),
      );

      expect(url.pathname).toBe(
        '/nantong/campus-operations-dashboard',
      );
      expect(url.searchParams.get('screenshotShift')).toBe('night');
    } finally {
      restoreEnvironment('DUTY_SCREENSHOT_PAGE_URL', originalDutyUrl);
      restoreEnvironment(
        'DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL',
        originalCampusUrl,
      );
    }
  });

  it('adds CLIENT_BASE_PATH to origin-only duty and campus screenshot URLs', () => {
    const originalDutyUrl = process.env.DUTY_SCREENSHOT_PAGE_URL;
    const originalCampusUrl =
      process.env.DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL;
    const originalClientBasePath = process.env.CLIENT_BASE_PATH;
    process.env.DUTY_SCREENSHOT_PAGE_URL = 'https://localhost:3443';
    delete process.env.DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL;
    process.env.CLIENT_BASE_PATH = '/nantong/';

    try {
      const service = new DutyScreenshotService({} as never, {} as never);
      const internals = service as unknown as {
        buildScreenshotPageUrl: (screenshotDate: string) => string;
        buildCampusOperationsScreenshotPageUrl: (
          screenshotDate: string,
          shift?: 'white' | 'night',
        ) => string;
      };

      expect(
        new URL(internals.buildScreenshotPageUrl('2026-07-22')).pathname,
      ).toBe('/nantong/monthly-schedule');
      expect(
        new URL(
          internals.buildCampusOperationsScreenshotPageUrl('2026-07-22'),
        ).pathname,
      ).toBe('/nantong/campus-operations-dashboard');

      process.env.DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL =
        'https://localhost:3443';
      expect(
        new URL(
          internals.buildCampusOperationsScreenshotPageUrl('2026-07-22'),
        ).pathname,
      ).toBe('/nantong/campus-operations-dashboard');
    } finally {
      restoreEnvironment('DUTY_SCREENSHOT_PAGE_URL', originalDutyUrl);
      restoreEnvironment(
        'DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL',
        originalCampusUrl,
      );
      restoreEnvironment('CLIENT_BASE_PATH', originalClientBasePath);
    }
  });

  it('does not duplicate an existing CLIENT_BASE_PATH in screenshot URLs', () => {
    const originalDutyUrl = process.env.DUTY_SCREENSHOT_PAGE_URL;
    const originalCampusUrl =
      process.env.DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL;
    const originalClientBasePath = process.env.CLIENT_BASE_PATH;
    process.env.DUTY_SCREENSHOT_PAGE_URL =
      'https://localhost:3443/nantong/monthly-schedule';
    process.env.DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL =
      'https://localhost:3443/nantong/campus-operations-dashboard';
    process.env.CLIENT_BASE_PATH = '/nantong';

    try {
      const service = new DutyScreenshotService({} as never, {} as never);
      const internals = service as unknown as {
        buildScreenshotPageUrl: (screenshotDate: string) => string;
        buildCampusOperationsScreenshotPageUrl: (
          screenshotDate: string,
        ) => string;
      };

      expect(
        new URL(internals.buildScreenshotPageUrl('2026-07-22')).pathname,
      ).toBe('/nantong/monthly-schedule');
      expect(
        new URL(
          internals.buildCampusOperationsScreenshotPageUrl('2026-07-22'),
        ).pathname,
      ).toBe('/nantong/campus-operations-dashboard');
    } finally {
      restoreEnvironment('DUTY_SCREENSHOT_PAGE_URL', originalDutyUrl);
      restoreEnvironment(
        'DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL',
        originalCampusUrl,
      );
      restoreEnvironment('CLIENT_BASE_PATH', originalClientBasePath);
    }
  });

  it.each(['0.0.0.0', '::'])(
    'uses localhost for the wildcard screenshot server host %s',
    (serverHost) => {
      const originalValues = {
        dutyUrl: process.env.DUTY_SCREENSHOT_PAGE_URL,
        screenshotUrl: process.env.SCREENSHOT_PAGE_URL,
        campusUrl: process.env.DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL,
        campusAlias: process.env.CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL,
        publicBaseUrl: process.env.PUBLIC_BASE_URL,
        frameworkDomain: process.env.FORCE_FRAMEWORK_DOMAIN_MAIN,
        serverHost: process.env.SERVER_HOST,
        serverPort: process.env.SERVER_PORT,
        clientBasePath: process.env.CLIENT_BASE_PATH,
        nodeEnv: process.env.NODE_ENV,
        httpsKeyPath: process.env.HTTPS_KEY_PATH,
        httpsCertPath: process.env.HTTPS_CERT_PATH,
      };
      delete process.env.DUTY_SCREENSHOT_PAGE_URL;
      delete process.env.SCREENSHOT_PAGE_URL;
      delete process.env.DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL;
      delete process.env.CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL;
      delete process.env.PUBLIC_BASE_URL;
      delete process.env.FORCE_FRAMEWORK_DOMAIN_MAIN;
      delete process.env.HTTPS_KEY_PATH;
      delete process.env.HTTPS_CERT_PATH;
      process.env.SERVER_HOST = serverHost;
      process.env.SERVER_PORT = '3999';
      process.env.CLIENT_BASE_PATH = '/nantong';
      process.env.NODE_ENV = 'production';

      try {
        const service = new DutyScreenshotService({} as never, {} as never);
        const internals = service as unknown as {
          buildScreenshotPageUrl: (screenshotDate: string) => string;
          buildCampusOperationsScreenshotPageUrl: (
            screenshotDate: string,
          ) => string;
        };
        const dutyUrl = new URL(
          internals.buildScreenshotPageUrl('2026-07-22'),
        );
        const campusUrl = new URL(
          internals.buildCampusOperationsScreenshotPageUrl('2026-07-22'),
        );

        expect(dutyUrl.hostname).toBe('localhost');
        expect(dutyUrl.pathname).toBe('/nantong/monthly-schedule');
        expect(campusUrl.hostname).toBe('localhost');
        expect(campusUrl.pathname).toBe(
          '/nantong/campus-operations-dashboard',
        );
      } finally {
        restoreEnvironment(
          'DUTY_SCREENSHOT_PAGE_URL',
          originalValues.dutyUrl,
        );
        restoreEnvironment(
          'SCREENSHOT_PAGE_URL',
          originalValues.screenshotUrl,
        );
        restoreEnvironment(
          'DUTY_CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL',
          originalValues.campusUrl,
        );
        restoreEnvironment(
          'CAMPUS_OPERATIONS_SCREENSHOT_PAGE_URL',
          originalValues.campusAlias,
        );
        restoreEnvironment('PUBLIC_BASE_URL', originalValues.publicBaseUrl);
        restoreEnvironment(
          'FORCE_FRAMEWORK_DOMAIN_MAIN',
          originalValues.frameworkDomain,
        );
        restoreEnvironment('SERVER_HOST', originalValues.serverHost);
        restoreEnvironment('SERVER_PORT', originalValues.serverPort);
        restoreEnvironment(
          'CLIENT_BASE_PATH',
          originalValues.clientBasePath,
        );
        restoreEnvironment('NODE_ENV', originalValues.nodeEnv);
        restoreEnvironment('HTTPS_KEY_PATH', originalValues.httpsKeyPath);
        restoreEnvironment('HTTPS_CERT_PATH', originalValues.httpsCertPath);
      }
    },
  );

  it('does not fall back to an unready campus dashboard frame', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'server/modules/duty-schedule/duty-screenshot.service.ts',
      ),
      'utf8',
    );
    const campusCaptureSource = source.slice(
      source.indexOf('private async captureCampusOperationsDashboard'),
      source.indexOf('private async captureTyphoonPath'),
    );

    expect(campusCaptureSource).toContain(
      'fallbackSelector: CAMPUS_OPERATIONS_SCREENSHOT_TARGET_SELECTOR',
    );
    expect(campusCaptureSource).not.toContain(
      'fallbackSelector: CAMPUS_OPERATIONS_SCREENSHOT_FALLBACK_SELECTOR',
    );
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
