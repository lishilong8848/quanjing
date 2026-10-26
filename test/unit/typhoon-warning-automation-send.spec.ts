import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DutyScheduleAutomationService } from '../../server/modules/duty-schedule/duty-schedule.automation';
import { acquireTyphoonWarningMonitorLease } from '../../server/modules/duty-schedule/typhoon-warning-state-store';

function activeWarning() {
  return {
    code: '200',
    warning: [
      {
        id: 'nantong-typhoon-yellow',
        title: '南通市发布台风黄色预警',
        level: '黄色',
        type: '台风',
        status: '发布',
        pubTime: '2026-07-28T08:00:00.000Z',
        endTime: '2026-07-29T08:00:00.000Z',
      },
    ],
  };
}

describe('DutyScheduleAutomationService typhoon delivery', () => {
  const originalStatePath = process.env.TYPHOON_WARNING_SEND_STATE_PATH;
  let temporaryDirectory = '';
  let statePath = '';

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(
      new Date('2026-07-28T10:00:00.000Z'),
    );
    temporaryDirectory = mkdtempSync(join(tmpdir(), 'typhoon-automation-'));
    statePath = join(temporaryDirectory, 'warning-state.json');
    process.env.TYPHOON_WARNING_SEND_STATE_PATH = statePath;
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalStatePath === undefined) {
      delete process.env.TYPHOON_WARNING_SEND_STATE_PATH;
    } else {
      process.env.TYPHOON_WARNING_SEND_STATE_PATH = originalStatePath;
    }
    if (temporaryDirectory && existsSync(temporaryDirectory)) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('does not capture or send when there is no active typhoon warning', async () => {
    const captureAndSendTyphoonPath = jest.fn();
    const automation = new DutyScheduleAutomationService(
      {} as never,
      {
        getWeatherWarning: jest.fn(async () => ({
          code: '200',
          warning: [],
        })),
      } as never,
      {
        hasCompletedTyphoonPathDelivery: jest.fn(() => false),
        captureAndSendTyphoonPath,
      } as never,
      {} as never,
    );

    await expect(
      automation.monitorTyphoonWarningAndSendPathScreenshot({
        source: 'manual',
      }),
    ).resolves.toMatchObject({
      success: true,
      sent: false,
      reason: 'no-active-typhoon-warning',
    });
    expect(captureAndSendTyphoonPath).not.toHaveBeenCalled();
  });

  it('uses a manual source and stable warning delivery key, then skips the same cadence', async () => {
    const getWeatherWarning = jest.fn(async () => activeWarning());
    const captureAndSendTyphoonPath = jest.fn(async () => ({
      success: true,
      source: 'manual-group',
      message: 'sent',
      sentAt: '2026-07-28T10:00:00.000Z',
      chatId: 'chat-1',
      chatIds: ['chat-1'],
      receiveId: 'chat-1',
      receiveIdType: 'chat_id',
      imageKey: 'image-key',
      screenshotPath: 'typhoon.png',
      alreadySent: false,
    }));
    const automation = new DutyScheduleAutomationService(
      {} as never,
      { getWeatherWarning } as never,
      {
        hasCompletedTyphoonPathDelivery: jest.fn(() => false),
        captureAndSendTyphoonPath,
      } as never,
      {} as never,
    );

    const first = await automation.monitorTyphoonWarningAndSendPathScreenshot({
      source: 'manual',
      expectedWarningKey: 'nantong-typhoon-yellow',
    });
    const second = await automation.monitorTyphoonWarningAndSendPathScreenshot({
      source: 'auto-typhoon-warning',
    });

    expect(first).toMatchObject({
      sent: true,
      source: 'manual',
      forced: false,
      reason: 'never-sent',
    });
    expect(captureAndSendTyphoonPath).toHaveBeenCalledTimes(1);
    expect(captureAndSendTyphoonPath).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'manual-group',
        warningTitle: '南通市发布台风黄色预警',
        warningLevel: '黄色',
        deliveryKey: expect.stringContaining(
          'typhoon-path:warning:nantong-typhoon-yellow:yellow:never-sent',
        ),
      }),
    );
    expect(second).toMatchObject({
      sent: false,
      reason: 'cadence-not-elapsed',
    });
  });

  it('fails closed when the persistent state is corrupt', async () => {
    writeFileSync(statePath, '{broken', 'utf8');
    const captureAndSendTyphoonPath = jest.fn();
    const automation = new DutyScheduleAutomationService(
      {} as never,
      { getWeatherWarning: jest.fn(async () => activeWarning()) } as never,
      { captureAndSendTyphoonPath } as never,
      {} as never,
    );

    await expect(
      automation.monitorTyphoonWarningAndSendPathScreenshot({
        source: 'auto-typhoon-warning',
      }),
    ).resolves.toMatchObject({
      success: false,
      sent: false,
      reason: 'state-read-error',
    });
    expect(captureAndSendTyphoonPath).not.toHaveBeenCalled();
  });

  it('reuses one in-flight force send for the same client mutation id', async () => {
    let finishScreenshot!: (value: {
      success: boolean;
      source: 'manual-group';
      message: string;
      sentAt: string;
      chatId: string;
      chatIds: string[];
      receiveId: string;
      receiveIdType: 'chat_id';
      alreadySent: boolean;
    }) => void;
    const pendingScreenshot = new Promise<Parameters<typeof finishScreenshot>[0]>(
      (resolve) => {
        finishScreenshot = resolve;
      },
    );
    const captureAndSendTyphoonPath = jest.fn(() => pendingScreenshot);
    const automation = new DutyScheduleAutomationService(
      {} as never,
      {
        getWeatherWarning: jest.fn(async () => ({
          code: '200',
          warning: [],
        })),
      } as never,
      {
        hasCompletedTyphoonPathDelivery: jest.fn(() => false),
        captureAndSendTyphoonPath,
      } as never,
      {} as never,
    );

    const first = automation.forceSendTyphoonPathScreenshot({
      clientMutationId: 'same-force-request',
    });
    const second = automation.forceSendTyphoonPathScreenshot({
      clientMutationId: 'same-force-request',
    });
    await Promise.resolve();
    expect(captureAndSendTyphoonPath).toHaveBeenCalledTimes(1);

    finishScreenshot({
      success: true,
      source: 'manual-group',
      message: 'sent',
      sentAt: '2026-07-28T10:00:00.000Z',
      chatId: 'chat-1',
      chatIds: ['chat-1'],
      receiveId: 'chat-1',
      receiveIdType: 'chat_id',
      alreadySent: false,
    });
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ sent: true, forced: true }),
      expect.objectContaining({ sent: true, forced: true }),
    ]);
  });

  it('does not start a force send while another process owns the typhoon delivery lease', async () => {
    const lease = acquireTyphoonWarningMonitorLease();
    expect(lease).not.toBeNull();
    const lockedAt = new Date();
    utimesSync(`${statePath}.lock`, lockedAt, lockedAt);
    const captureAndSendTyphoonPath = jest.fn();
    const automation = new DutyScheduleAutomationService(
      {} as never,
      {} as never,
      { captureAndSendTyphoonPath } as never,
      {} as never,
    );

    try {
      await expect(
        automation.forceSendTyphoonPathScreenshot({
          clientMutationId: 'locked-force-request',
        }),
      ).resolves.toMatchObject({
        success: true,
        sent: false,
        forced: true,
        reason: 'monitor-in-flight',
      });
      expect(captureAndSendTyphoonPath).not.toHaveBeenCalled();
    } finally {
      lease?.release();
    }
  });

  it('reroutes a force request through the warning cadence when a warning becomes active before send', async () => {
    const getWeatherWarning = jest.fn(async () => activeWarning());
    const captureAndSendTyphoonPath = jest.fn(async (options) => ({
      success: true,
      source: options.source,
      message: 'sent',
      sentAt: '2026-07-28T10:00:00.000Z',
      chatId: 'chat-1',
      chatIds: ['chat-1'],
      receiveId: 'chat-1',
      receiveIdType: 'chat_id',
      imageKey: 'image-key',
      screenshotPath: 'typhoon.png',
      alreadySent: false,
    }));
    const automation = new DutyScheduleAutomationService(
      {} as never,
      { getWeatherWarning } as never,
      {
        hasCompletedTyphoonPathDelivery: jest.fn(() => false),
        captureAndSendTyphoonPath,
      } as never,
      {} as never,
    );

    await expect(
      automation.forceSendTyphoonPathScreenshot({
        clientMutationId: 'force-preview-became-warning',
      }),
    ).resolves.toMatchObject({
      success: true,
      sent: true,
      source: 'manual',
      forced: false,
      reason: 'never-sent',
    });
    expect(getWeatherWarning).toHaveBeenCalledWith(true);
    expect(captureAndSendTyphoonPath).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'manual-group',
        warningTitle: '南通市发布台风黄色预警',
        warningLevel: '黄色',
        deliveryKey: expect.stringContaining(
          'typhoon-path:warning:nantong-typhoon-yellow:yellow:never-sent',
        ),
      }),
    );
  });

  it('returns an already-sent force result before rechecking a newly active warning', async () => {
    const getWeatherWarning = jest.fn(async () => activeWarning());
    const captureAndSendTyphoonPath = jest.fn();
    const automation = new DutyScheduleAutomationService(
      {} as never,
      { getWeatherWarning } as never,
      {
        hasCompletedTyphoonPathDelivery: jest.fn(() => true),
        captureAndSendTyphoonPath,
      } as never,
      {} as never,
    );

    await expect(
      automation.forceSendTyphoonPathScreenshot({
        clientMutationId: 'completed-force-request',
      }),
    ).resolves.toMatchObject({
      success: true,
      sent: false,
      source: 'manual-group',
      forced: true,
      reason: 'already-sent',
    });
    expect(getWeatherWarning).not.toHaveBeenCalled();
    expect(captureAndSendTyphoonPath).not.toHaveBeenCalled();
  });
});
