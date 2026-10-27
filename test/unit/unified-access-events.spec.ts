import {
  installUnifiedAccessResponseInterceptor,
  UNIFIED_ACCESS_INVALIDATED_EVENT,
} from '../../client/src/access/access-events';

type FulfilledHandler = (response: unknown) => unknown;
type RejectedHandler = (error: unknown) => Promise<never>;

describe('unified access response interceptor', () => {
  let onFulfilled: FulfilledHandler;
  let onRejected: RejectedHandler;
  let dispatchEvent: jest.Mock;
  let originalWindow: typeof globalThis.window | undefined;

  beforeEach(() => {
    originalWindow = globalThis.window;
    dispatchEvent = jest.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { dispatchEvent },
    });

    installUnifiedAccessResponseInterceptor({
      interceptors: {
        response: {
          use: jest.fn((fulfilled, rejected) => {
            onFulfilled = fulfilled;
            onRejected = rejected as RejectedHandler;
            return 7;
          }),
          eject: jest.fn(),
        },
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
  });

  it.each([401, 403])(
    'turns a toolkit-fulfilled %s response back into a rejection',
    async (status) => {
      const response = {
        status,
        config: { url: '/api/contract-management/dashboard' },
        data: { success: false },
      };

      await expect(onFulfilled(response)).rejects.toMatchObject({ response });
      expect(dispatchEvent).toHaveBeenCalledTimes(1);
      expect(dispatchEvent.mock.calls[0][0]).toMatchObject({
        type: UNIFIED_ACCESS_INVALIDATED_EVENT,
      });
    },
  );

  it('passes a successful response through unchanged', () => {
    const response = { status: 200, data: { ok: true } };

    expect(onFulfilled(response)).toBe(response);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('keeps rejecting native authorization errors', async () => {
    const error = {
      config: { url: '/api/contract-management/dashboard' },
      response: { status: 403 },
    };

    await expect(onRejected(error)).rejects.toBe(error);
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });

  it.each([
    '/api/authnpaas/lark-user-id',
    'https://www.sm.sjhl.online:3001/api/authnpaas/lark-user-id?source=shell',
  ])(
    'does not invalidate unified access for a platform identity 403 from %s',
    async (url) => {
      const response = {
        status: 403,
        config: { url },
        data: { success: false },
      };

      await expect(onFulfilled(response)).rejects.toMatchObject({ response });
      expect(dispatchEvent).not.toHaveBeenCalled();

      const error = { config: { url }, response: { status: 403 } };
      await expect(onRejected(error)).rejects.toBe(error);
      expect(dispatchEvent).not.toHaveBeenCalled();
    },
  );
});
