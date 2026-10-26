import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DutyScreenshotService } from '../../server/modules/duty-schedule/duty-screenshot.service';

describe('DutyScreenshotService automatic archive idempotency', () => {
  let originalStatePath: string | undefined;
  let isolatedStateDirectory: string;

  beforeEach(() => {
    originalStatePath = process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH;
    isolatedStateDirectory = mkdtempSync(
      join(tmpdir(), 'duty-screenshot-test-state-'),
    );
    process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH = join(
      isolatedStateDirectory,
      'delivery-state.json',
    );
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalStatePath === undefined) {
      delete process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH;
    } else {
      process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH = originalStatePath;
    }
    if (existsSync(isolatedStateDirectory)) {
      rmSync(isolatedStateDirectory, { recursive: true, force: true });
    }
  });

  it('uses deterministic attachment names for automatic screenshots', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-20T02:00:00.000Z'));
    const appendScreenshot = jest
      .fn()
      .mockResolvedValueOnce({
        recordId: 'record-1',
        shiftLabel: '白班',
      })
      .mockResolvedValueOnce({
        recordId: 'record-1',
        shiftLabel: '白班',
      });
    const service = new DutyScreenshotService(
      {} as never,
      { appendScreenshot } as never,
    );
    const internals = service as unknown as {
      captureDutyOverview: () => Promise<{ buffer: Buffer; path: string }>;
      captureCampusOperationsDashboard: () => Promise<{
        buffer: Buffer;
        path: string;
      }>;
      getTargetChatIds: () => string[];
      getTenantAccessToken: () => Promise<string>;
      uploadImage: () => Promise<string>;
      sendMessagesToChats: () => Promise<Array<{ chatId: string }>>;
    };

    jest.spyOn(internals, 'captureDutyOverview').mockResolvedValue({
      buffer: Buffer.from('overview'),
      path: 'overview.png',
    });
    jest
      .spyOn(internals, 'captureCampusOperationsDashboard')
      .mockResolvedValue({
        buffer: Buffer.from('campus'),
        path: 'campus.png',
      });
    jest.spyOn(internals, 'getTargetChatIds').mockReturnValue(['chat-1']);
    jest
      .spyOn(internals, 'getTenantAccessToken')
      .mockResolvedValue('tenant-token');
    jest.spyOn(internals, 'uploadImage').mockResolvedValue('image-key');
    const sendMessagesToChats = jest
      .spyOn(internals, 'sendMessagesToChats')
      .mockResolvedValue([
      { chatId: 'chat-1' },
    ]);

    await service.captureAndSendDutyOverview({
      source: 'auto-08:50',
      date: '2026-07-20',
    });

    expect(appendScreenshot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        fileName: 'nantong-duty-overview-2026-07-20-white.png',
      }),
    );
    expect(appendScreenshot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        fileName: 'nantong-campus-operations-2026-07-20-white.png',
      }),
    );
    expect(sendMessagesToChats).toHaveBeenCalledWith(
      'tenant-token',
      ['chat-1'],
      expect.any(Object),
      'image-key',
      'duty-overview:2026-07-20:white',
    );
  });

  it('archives and sends the duty screenshot even when the campus screenshot fails', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-22T02:00:00.000Z'));
    const appendScreenshot = jest.fn().mockResolvedValue({
      recordId: 'record-1',
      shiftLabel: '白班',
    });
    const service = new DutyScreenshotService(
      {} as never,
      { appendScreenshot } as never,
    );
    const internals = service as unknown as {
      captureDutyOverview: () => Promise<{ buffer: Buffer; path: string }>;
      captureCampusOperationsDashboard: () => Promise<{
        buffer: Buffer;
        path: string;
      }>;
      getTargetChatIds: () => string[];
      getTenantAccessToken: () => Promise<string>;
      uploadImage: () => Promise<string>;
      sendMessagesToChats: () => Promise<Array<{ chatId: string }>>;
    };

    jest.spyOn(internals, 'captureDutyOverview').mockResolvedValue({
      buffer: Buffer.from('overview'),
      path: 'overview.png',
    });
    jest
      .spyOn(internals, 'captureCampusOperationsDashboard')
      .mockRejectedValue(new Error('campus capture failed'));
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
        source: 'auto-08:50',
        date: '2026-07-22',
      }),
    ).rejects.toThrow('campus capture failed');

    expect(appendScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'nantong-duty-overview-2026-07-22-white.png',
      }),
    );
    expect(sendMessagesToChats).toHaveBeenCalled();
  });

  it('archives the campus screenshot even when the duty screenshot fails', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-22T02:00:00.000Z'));
    const appendScreenshot = jest.fn().mockResolvedValue({
      recordId: 'record-1',
      shiftLabel: '白班',
    });
    const service = new DutyScreenshotService(
      {} as never,
      { appendScreenshot } as never,
    );
    const internals = service as unknown as {
      captureDutyOverview: () => Promise<{ buffer: Buffer; path: string }>;
      captureCampusOperationsDashboard: () => Promise<{
        buffer: Buffer;
        path: string;
      }>;
      getTargetChatIds: () => string[];
    };

    jest
      .spyOn(internals, 'captureDutyOverview')
      .mockRejectedValue(new Error('duty capture failed'));
    const captureCampusOperationsDashboard = jest
      .spyOn(internals, 'captureCampusOperationsDashboard')
      .mockResolvedValue({
        buffer: Buffer.from('campus'),
        path: 'campus.png',
      });
    jest.spyOn(internals, 'getTargetChatIds').mockReturnValue(['chat-1']);

    await expect(
      service.captureAndSendDutyOverview({
        source: 'auto-08:50',
        date: '2026-07-22',
      }),
    ).rejects.toThrow('duty capture failed');

    expect(captureCampusOperationsDashboard).toHaveBeenCalled();
    expect(appendScreenshot).toHaveBeenCalledWith(
      expect.objectContaining({
        fileName: 'nantong-campus-operations-2026-07-22-white.png',
      }),
    );
  });

  it('does not recapture or reupload a completed duty branch when only campus retry remains', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-22T02:00:00.000Z'));
    const originalStatePath =
      process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH;
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'duty-screenshot-branch-retry-'),
    );
    process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH = join(
      temporaryDirectory,
      'delivery-state.json',
    );

    try {
      const appendScreenshot = jest.fn().mockResolvedValue({
        recordId: 'record-1',
        shiftLabel: '白班',
      });
      const service = new DutyScreenshotService(
        {} as never,
        { appendScreenshot } as never,
      );
      const internals = service as unknown as {
        captureDutyOverview: () => Promise<{
          buffer: Buffer;
          path: string;
        }>;
        captureCampusOperationsDashboard: () => Promise<{
          buffer: Buffer;
          path: string;
        }>;
        getTargetChatIds: () => string[];
        getTenantAccessToken: () => Promise<string>;
        uploadImage: () => Promise<string>;
        sendCardMessage: () => Promise<string>;
        sendImageMessage: () => Promise<string>;
      };

      const captureDutyOverview = jest
        .spyOn(internals, 'captureDutyOverview')
        .mockResolvedValue({
          buffer: Buffer.from('overview'),
          path: 'overview.png',
        });
      jest
        .spyOn(internals, 'captureCampusOperationsDashboard')
        .mockRejectedValueOnce(new Error('campus temporarily unavailable'))
        .mockResolvedValueOnce({
          buffer: Buffer.from('campus'),
          path: 'campus.png',
        });
      jest.spyOn(internals, 'getTargetChatIds').mockReturnValue(['chat-1']);
      const getTenantAccessToken = jest
        .spyOn(internals, 'getTenantAccessToken')
        .mockResolvedValue('tenant-token');
      const uploadImage = jest
        .spyOn(internals, 'uploadImage')
        .mockResolvedValue('image-key');
      const sendCardMessage = jest
        .spyOn(internals, 'sendCardMessage')
        .mockResolvedValue('card-message');
      const sendImageMessage = jest
        .spyOn(internals, 'sendImageMessage')
        .mockResolvedValue('image-message');

      await expect(
        service.captureAndSendDutyOverview({
          source: 'auto-08:50',
          date: '2026-07-22',
        }),
      ).rejects.toThrow('campus temporarily unavailable');

      await expect(
        service.captureAndSendDutyOverview({
          source: 'auto-08:50',
          date: '2026-07-22',
        }),
      ).resolves.toMatchObject({ success: true });

      expect(captureDutyOverview).toHaveBeenCalledTimes(1);
      expect(getTenantAccessToken).toHaveBeenCalledTimes(1);
      expect(uploadImage).toHaveBeenCalledTimes(1);
      expect(sendCardMessage).toHaveBeenCalledTimes(1);
      expect(sendImageMessage).toHaveBeenCalledTimes(1);
      expect(appendScreenshot).toHaveBeenCalledTimes(2);
    } finally {
      if (originalStatePath === undefined) {
        delete process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH;
      } else {
        process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH =
          originalStatePath;
      }
      if (existsSync(temporaryDirectory)) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  });

  it('does not recapture or reappend a completed campus branch when only duty retry remains', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-22T02:00:00.000Z'));
    const originalStatePath =
      process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH;
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'campus-screenshot-branch-retry-'),
    );
    process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH = join(
      temporaryDirectory,
      'delivery-state.json',
    );

    try {
      const appendScreenshot = jest.fn().mockResolvedValue({
        recordId: 'record-1',
        shiftLabel: '白班',
      });
      const service = new DutyScreenshotService(
        {} as never,
        { appendScreenshot } as never,
      );
      const internals = service as unknown as {
        captureDutyOverview: () => Promise<{
          buffer: Buffer;
          path: string;
        }>;
        captureCampusOperationsDashboard: () => Promise<{
          buffer: Buffer;
          path: string;
        }>;
        getTargetChatIds: () => string[];
      };

      jest
        .spyOn(internals, 'captureDutyOverview')
        .mockRejectedValue(new Error('duty temporarily unavailable'));
      const captureCampusOperationsDashboard = jest
        .spyOn(internals, 'captureCampusOperationsDashboard')
        .mockResolvedValue({
          buffer: Buffer.from('campus'),
          path: 'campus.png',
        });
      jest.spyOn(internals, 'getTargetChatIds').mockReturnValue(['chat-1']);

      await expect(
        service.captureAndSendDutyOverview({
          source: 'auto-08:50',
          date: '2026-07-22',
        }),
      ).rejects.toThrow('duty temporarily unavailable');
      await expect(
        service.captureAndSendDutyOverview({
          source: 'auto-08:50',
          date: '2026-07-22',
        }),
      ).rejects.toThrow('duty temporarily unavailable');

      expect(captureCampusOperationsDashboard).toHaveBeenCalledTimes(1);
      expect(appendScreenshot).toHaveBeenCalledTimes(1);
      expect(appendScreenshot).toHaveBeenCalledWith(
        expect.objectContaining({
          fileName: 'nantong-campus-operations-2026-07-22-white.png',
        }),
      );
    } finally {
      if (originalStatePath === undefined) {
        delete process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH;
      } else {
        process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH =
          originalStatePath;
      }
      if (existsSync(temporaryDirectory)) {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    }
  });

  it.each([
    {
      caseName: 'historical date',
      now: '2026-07-22T12:00:00.000Z',
      screenshotDate: '2026-07-21',
    },
    {
      caseName: 'earlier white shift after the night shift has started',
      now: '2026-07-22T13:03:00.000Z',
      screenshotDate: '2026-07-22',
    },
    {
      caseName: 'same-day white shift after its group delivery window',
      now: '2026-07-27T09:37:00.000Z',
      screenshotDate: '2026-07-27',
    },
  ])(
    'archives a $caseName screenshot without sending it to Feishu chats',
    async ({ now, screenshotDate }) => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date(now));
    const appendScreenshot = jest.fn().mockResolvedValue({
      recordId: 'record-1',
      shiftLabel: '白班',
      appended: true,
    });
    const service = new DutyScreenshotService(
      {} as never,
      { appendScreenshot } as never,
    );
    const internals = service as unknown as {
      captureDutyOverview: () => Promise<{ buffer: Buffer; path: string }>;
      captureCampusOperationsDashboard: () => Promise<{
        buffer: Buffer;
        path: string;
      }>;
      getTargetChatIds: () => string[];
      getTenantAccessToken: () => Promise<string>;
      uploadImage: () => Promise<string>;
      sendMessagesToChats: () => Promise<Array<{ chatId: string }>>;
    };

    jest.spyOn(internals, 'captureDutyOverview').mockResolvedValue({
      buffer: Buffer.from('overview'),
      path: 'overview.png',
    });
    jest
      .spyOn(internals, 'captureCampusOperationsDashboard')
      .mockResolvedValue({
        buffer: Buffer.from('campus'),
        path: 'campus.png',
      });
    jest.spyOn(internals, 'getTargetChatIds').mockReturnValue(['chat-1']);
    const getTenantAccessToken = jest
      .spyOn(internals, 'getTenantAccessToken')
      .mockResolvedValue('tenant-token');
    const uploadImage = jest
      .spyOn(internals, 'uploadImage')
      .mockResolvedValue('image-key');
    const sendMessagesToChats = jest
      .spyOn(internals, 'sendMessagesToChats')
      .mockResolvedValue([{ chatId: 'chat-1' }]);

    await expect(
      service.captureAndSendDutyOverview({
        source: 'auto-08:50',
        date: screenshotDate,
      }),
    ).resolves.toMatchObject({ success: true, screenshotDate });

    expect(appendScreenshot).toHaveBeenCalledTimes(2);
    expect(getTenantAccessToken).not.toHaveBeenCalled();
    expect(uploadImage).not.toHaveBeenCalled();
    expect(sendMessagesToChats).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      caseName: 'white shift immediately before 08:50',
      source: 'auto-08:50' as const,
      now: '2026-07-27T00:49:59.999Z',
      expected: false,
    },
    {
      caseName: 'white shift at 08:50',
      source: 'auto-08:50' as const,
      now: '2026-07-27T00:50:00.000Z',
      expected: true,
    },
    {
      caseName: 'white shift one-hour catch-up at 09:50',
      source: 'auto-08:50' as const,
      now: '2026-07-27T01:50:00.000Z',
      expected: true,
    },
    {
      caseName: 'white shift immediately before 10:50',
      source: 'auto-08:50' as const,
      now: '2026-07-27T02:49:59.999Z',
      expected: true,
    },
    {
      caseName: 'white shift at the 10:50 upper boundary',
      source: 'auto-08:50' as const,
      now: '2026-07-27T02:50:00.000Z',
      expected: false,
    },
    {
      caseName: 'night shift immediately before 17:50',
      source: 'auto-17:50' as const,
      now: '2026-07-27T09:49:59.999Z',
      expected: false,
    },
    {
      caseName: 'night shift at 17:50',
      source: 'auto-17:50' as const,
      now: '2026-07-27T09:50:00.000Z',
      expected: true,
    },
    {
      caseName: 'night shift one-hour catch-up at 18:50',
      source: 'auto-17:50' as const,
      now: '2026-07-27T10:50:00.000Z',
      expected: true,
    },
    {
      caseName: 'night shift immediately before 19:50',
      source: 'auto-17:50' as const,
      now: '2026-07-27T11:49:59.999Z',
      expected: true,
    },
    {
      caseName: 'night shift at the 19:50 upper boundary',
      source: 'auto-17:50' as const,
      now: '2026-07-27T11:50:00.000Z',
      expected: false,
    },
  ])(
    'enforces the automatic group delivery window for $caseName',
    ({ source, now, expected }) => {
      const service = new DutyScreenshotService({} as never, {} as never);
      const internals = service as unknown as {
        isAutomaticGroupDeliveryAllowed: (
          source: 'auto-08:50' | 'auto-17:50',
          screenshotDate: string,
          now: Date,
        ) => boolean;
      };

      expect(
        internals.isAutomaticGroupDeliveryAllowed(
          source,
          '2026-07-27',
          new Date(now),
        ),
      ).toBe(expected);
    },
  );

  it('does not resend when the daily report already has the same duty screenshot', async () => {
    jest
      .useFakeTimers()
      .setSystemTime(new Date('2026-07-22T02:00:00.000Z'));
    const appendScreenshot = jest
      .fn()
      .mockResolvedValueOnce({
        recordId: 'record-1',
        shiftLabel: '白班',
        appended: false,
      })
      .mockResolvedValueOnce({
        recordId: 'record-1',
        shiftLabel: '白班',
        appended: true,
      });
    const service = new DutyScreenshotService(
      {} as never,
      { appendScreenshot } as never,
    );
    const internals = service as unknown as {
      captureDutyOverview: () => Promise<{ buffer: Buffer; path: string }>;
      captureCampusOperationsDashboard: () => Promise<{
        buffer: Buffer;
        path: string;
      }>;
      getTargetChatIds: () => string[];
      getTenantAccessToken: () => Promise<string>;
      uploadImage: () => Promise<string>;
      sendMessagesToChats: () => Promise<Array<{ chatId: string }>>;
    };

    jest.spyOn(internals, 'captureDutyOverview').mockResolvedValue({
      buffer: Buffer.from('overview'),
      path: 'overview.png',
    });
    jest
      .spyOn(internals, 'captureCampusOperationsDashboard')
      .mockResolvedValue({
        buffer: Buffer.from('campus'),
        path: 'campus.png',
      });
    jest.spyOn(internals, 'getTargetChatIds').mockReturnValue(['chat-1']);
    const getTenantAccessToken = jest
      .spyOn(internals, 'getTenantAccessToken')
      .mockResolvedValue('tenant-token');
    const uploadImage = jest
      .spyOn(internals, 'uploadImage')
      .mockResolvedValue('image-key');
    const sendMessagesToChats = jest
      .spyOn(internals, 'sendMessagesToChats')
      .mockResolvedValue([{ chatId: 'chat-1' }]);

    await expect(
      service.captureAndSendDutyOverview({
        source: 'auto-08:50',
        date: '2026-07-22',
      }),
    ).resolves.toMatchObject({ success: true, screenshotDate: '2026-07-22' });

    expect(getTenantAccessToken).not.toHaveBeenCalled();
    expect(uploadImage).not.toHaveBeenCalled();
    expect(sendMessagesToChats).not.toHaveBeenCalled();
  });
});
