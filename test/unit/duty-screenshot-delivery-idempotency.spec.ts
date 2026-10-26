import {
  existsSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DutyScreenshotService } from '../../server/modules/duty-schedule/duty-screenshot.service';

type Receiver = {
  id: string;
  type: 'chat_id';
};

type DeliveryInternals = {
  captureTyphoonPath: (
    source: 'manual-test' | 'manual-group' | 'auto-typhoon-warning',
  ) => Promise<{ buffer: Buffer; path: string }>;
  getTenantAccessToken: () => Promise<string>;
  uploadImage: (
    token: string,
    buffer: Buffer,
    filename: string,
  ) => Promise<string>;
  sendCardMessage: (
    token: string,
    receiveId: string,
    card: Record<string, unknown>,
    receiveIdType: 'chat_id',
    uuid?: string,
  ) => Promise<string | undefined>;
  sendImageMessage: (
    token: string,
    receiveId: string,
    imageKey: string,
    receiveIdType: 'chat_id',
    uuid?: string,
  ) => Promise<string | undefined>;
  sendMessagesToReceivers: (
    token: string,
    receivers: Receiver[],
    card: Record<string, unknown>,
    imageKey: string,
    deliveryKey?: string,
  ) => Promise<Array<{
    receiveId: string;
    textMessageId?: string;
    imageMessageId?: string;
  }>>;
};

describe('DutyScreenshotService automatic message delivery idempotency', () => {
  const originalStatePath =
    process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH;
  let temporaryDirectory = '';

  beforeEach(() => {
    temporaryDirectory = mkdtempSync(
      join(tmpdir(), 'duty-screenshot-delivery-'),
    );
    process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH = join(
      temporaryDirectory,
      'delivery-state.json',
    );
  });

  afterEach(() => {
    if (originalStatePath === undefined) {
      delete process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH;
    } else {
      process.env.DUTY_SCREENSHOT_DELIVERY_STATE_PATH =
        originalStatePath;
    }
    if (temporaryDirectory && existsSync(temporaryDirectory)) {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('persists each successful card and image and retries only the failed image', async () => {
    const receivers: Receiver[] = [
      { id: 'chat-1', type: 'chat_id' },
      { id: 'chat-2', type: 'chat_id' },
    ];
    const deliveryKey = 'duty-overview:2026-07-20:white';
    const firstService = new DutyScreenshotService(
      {} as never,
      {} as never,
    );
    const firstInternals =
      firstService as unknown as DeliveryInternals;
    const firstCard = jest
      .spyOn(firstInternals, 'sendCardMessage')
      .mockImplementation(async (_token, receiveId) => `card-${receiveId}`);
    const firstImage = jest
      .spyOn(firstInternals, 'sendImageMessage')
      .mockImplementation(async (_token, receiveId) => {
        if (receiveId === 'chat-2') {
          throw new Error('temporary image failure');
        }
        return `image-${receiveId}`;
      });

    await expect(
      firstInternals.sendMessagesToReceivers(
        'tenant-token',
        receivers,
        { elements: [] },
        'image-key',
        deliveryKey,
      ),
    ).rejects.toThrow('temporary image failure');

    expect(firstCard).toHaveBeenCalledTimes(2);
    expect(firstImage).toHaveBeenCalledTimes(2);
    const failedImageUuid = firstImage.mock.calls[1][4];
    expect(failedImageUuid).toEqual(expect.any(String));
    expect(failedImageUuid!.length).toBeLessThanOrEqual(50);

    const retryService = new DutyScreenshotService(
      {} as never,
      {} as never,
    );
    const retryInternals =
      retryService as unknown as DeliveryInternals;
    const retryCard = jest
      .spyOn(retryInternals, 'sendCardMessage')
      .mockResolvedValue('unexpected-card');
    const retryImage = jest
      .spyOn(retryInternals, 'sendImageMessage')
      .mockResolvedValue('image-chat-2');

    await expect(
      retryInternals.sendMessagesToReceivers(
        'tenant-token',
        receivers,
        { elements: [] },
        'image-key',
        deliveryKey,
      ),
    ).resolves.toHaveLength(2);

    expect(retryCard).not.toHaveBeenCalled();
    expect(retryImage).toHaveBeenCalledTimes(1);
    expect(retryImage).toHaveBeenCalledWith(
      'tenant-token',
      'chat-2',
      'image-key',
      'chat_id',
      failedImageUuid,
    );
  });

  it('passes the stable uuid in both Feishu message request bodies', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 0, data: { message_id: 'card-message' } },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { message_id: 'image-message' } },
      });
    const service = new DutyScreenshotService(
      { axiosRef: { post } } as never,
      {} as never,
    );
    const internals = service as unknown as DeliveryInternals;

    await internals.sendCardMessage(
      'tenant-token',
      'chat-1',
      { elements: [] },
      'chat_id',
      'stable-card-uuid',
    );
    await internals.sendImageMessage(
      'tenant-token',
      'chat-1',
      'image-key',
      'chat_id',
      'stable-image-uuid',
    );

    expect(post.mock.calls[0][1]).toMatchObject({
      uuid: 'stable-card-uuid',
    });
    expect(post.mock.calls[1][1]).toMatchObject({
      uuid: 'stable-image-uuid',
    });
  });

  it('skips capture and Feishu delivery when the same typhoon delivery key is already complete', async () => {
    const service = new DutyScreenshotService(
      {} as never,
      {} as never,
    );
    const internals = service as unknown as DeliveryInternals;
    const capture = jest
      .spyOn(internals, 'captureTyphoonPath')
      .mockResolvedValue({
        buffer: Buffer.from('typhoon-image'),
        path: 'typhoon-path.png',
      });
    jest
      .spyOn(internals, 'getTenantAccessToken')
      .mockResolvedValue('tenant-token');
    const upload = jest
      .spyOn(internals, 'uploadImage')
      .mockResolvedValue('image-key');
    const sendCard = jest
      .spyOn(internals, 'sendCardMessage')
      .mockResolvedValue('card-message');
    const sendImage = jest
      .spyOn(internals, 'sendImageMessage')
      .mockResolvedValue('image-message');
    const options = {
      source: 'manual-test',
      receiveId: 'open-user-1',
      receiveIdType: 'open_id',
      deliveryKey: 'typhoon-path:force:stable-request',
    } as never;

    await expect(service.captureAndSendTyphoonPath(options)).resolves.toMatchObject({
      success: true,
      alreadySent: false,
    });
    await expect(service.captureAndSendTyphoonPath(options)).resolves.toMatchObject({
      success: true,
      alreadySent: true,
    });

    expect(capture).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(sendCard).toHaveBeenCalledTimes(1);
    expect(sendImage).toHaveBeenCalledTimes(1);
  });
});
