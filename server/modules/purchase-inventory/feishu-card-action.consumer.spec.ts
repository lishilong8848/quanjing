import { ServiceUnavailableException } from '@nestjs/common';
import {
  FeishuCardActionConsumer,
  FeishuCardActionHealthController,
  isFeishuCardActionConsumerEnabled,
} from './feishu-card-action.consumer';

describe('FeishuCardActionConsumer lifecycle and health', () => {
  const originalConsumerRole = process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED;
  const originalConsumerProfile =
    process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE;
  let router: {
    isAnyEnabled: jest.Mock;
    handle: jest.Mock;
    handleMessage: jest.Mock;
  };
  let transport: {
    connect: jest.Mock;
    close: jest.Mock;
    isReady: jest.Mock;
  };

  beforeEach(() => {
    delete process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE;
    process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED = 'true';
    router = {
      isAnyEnabled: jest.fn(() => true),
      handle: jest.fn().mockResolvedValue({
        toast: { type: 'info', content: 'ok' },
      }),
      handleMessage: jest.fn().mockResolvedValue(undefined),
    };
    transport = {
      connect: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
      isReady: jest.fn(() => true),
    };
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalConsumerRole === undefined) {
      delete process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED;
    } else {
      process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED = originalConsumerRole;
    }
    if (originalConsumerProfile === undefined) {
      delete process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE;
    } else {
      process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = originalConsumerProfile;
    }
  });

  it.each(['production', 'local-test'])(
    'enables the %s profile even when the legacy switch is false',
    (profile) => {
      process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = profile;
      process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED = 'false';

      expect(isFeishuCardActionConsumerEnabled()).toBe(true);
    },
  );

  it('keeps the disabled profile off even when the legacy switch is true', () => {
    process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = 'disabled';
    process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED = 'true';

    expect(isFeishuCardActionConsumerEnabled()).toBe(false);
  });

  it('rejects an invalid profile instead of using the legacy switch', () => {
    process.env.FEISHU_CARD_ACTION_CONSUMER_PROFILE = 'invalid';

    expect(() => isFeishuCardActionConsumerEnabled()).toThrow(
      /production.*local-test.*disabled/u,
    );
  });

  it('opens exactly one shared connection and closes it on shutdown', async () => {
    const consumer = new FeishuCardActionConsumer(
      router as never,
      transport as never,
    );

    await consumer.onApplicationBootstrap();
    await consumer.onApplicationBootstrap();

    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.connect).toHaveBeenCalledWith(
      expect.any(Function),
      expect.any(Function),
      expect.any(Function),
    );
    await consumer.onModuleDestroy();
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it('does not connect when every supported workflow is disabled', async () => {
    router.isAnyEnabled.mockReturnValue(false);
    const consumer = new FeishuCardActionConsumer(
      router as never,
      transport as never,
    );

    await consumer.onApplicationBootstrap();

    expect(transport.connect).not.toHaveBeenCalled();
  });

  it('does not connect when this runtime is not the designated callback consumer', async () => {
    process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED = 'false';
    const consumer = new FeishuCardActionConsumer(
      router as never,
      transport as never,
    );

    await consumer.onApplicationBootstrap();

    expect(router.isAnyEnabled).not.toHaveBeenCalled();
    expect(transport.connect).not.toHaveBeenCalled();
  });

  it('defaults the callback consumer role to disabled', async () => {
    delete process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED;
    const consumer = new FeishuCardActionConsumer(
      router as never,
      transport as never,
    );

    await consumer.onApplicationBootstrap();

    expect(transport.connect).not.toHaveBeenCalled();
  });

  it('reports only the current transport state as healthy', () => {
    const controller = new FeishuCardActionHealthController(
      router as never,
      transport as never,
    );

    expect(controller.health()).toEqual({ enabled: true, ready: true });

    transport.isReady.mockReturnValue(false);
    expect(() => controller.health()).toThrow(ServiceUnavailableException);
  });

  it('reports the callback as disabled when this runtime is not the consumer', () => {
    process.env.FEISHU_CARD_ACTION_CONSUMER_ENABLED = 'false';
    const controller = new FeishuCardActionHealthController(
      router as never,
      transport as never,
    );

    expect(controller.health()).toEqual({ enabled: false, ready: false });
    expect(router.isAnyEnabled).not.toHaveBeenCalled();
    expect(transport.isReady).not.toHaveBeenCalled();
  });

  it('schedules a fresh connection after a terminal transport failure', async () => {
    jest.useFakeTimers();
    let terminalFailure: ((error: Error) => void) | undefined;
    transport.connect.mockImplementation(
      async (_handler: unknown, onTerminalFailure: (error: Error) => void) => {
        terminalFailure = onTerminalFailure;
      },
    );
    const consumer = new FeishuCardActionConsumer(
      router as never,
      transport as never,
    );
    await consumer.onApplicationBootstrap();

    terminalFailure?.(new Error('connection exhausted'));
    await jest.advanceTimersByTimeAsync(5_000);

    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(transport.connect).toHaveBeenCalledTimes(2);
    await consumer.onModuleDestroy();
  });

  it('still reconnects after a terminal failure when closing the old client fails', async () => {
    jest.useFakeTimers();
    let terminalFailure: ((error: Error) => void) | undefined;
    transport.connect.mockImplementation(
      async (_handler: unknown, onTerminalFailure: (error: Error) => void) => {
        terminalFailure = onTerminalFailure;
      },
    );
    transport.close.mockRejectedValueOnce(new Error('close failed'));
    const consumer = new FeishuCardActionConsumer(
      router as never,
      transport as never,
    );
    await consumer.onApplicationBootstrap();

    terminalFailure?.(new Error('connection exhausted'));
    await jest.advanceTimersByTimeAsync(5_000);

    expect(transport.connect).toHaveBeenCalledTimes(2);
    await consumer.onModuleDestroy();
  });
});
