import { constructionFetch } from '../../client/src/api/construction-fetch';

describe('constructionFetch', () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;

  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, 'window', {
      value: originalWindow,
      configurable: true,
    });
  });

  it('does not navigate when an error response contains x-login-url', async () => {
    const location = {
      origin: 'https://127.0.0.1:3001',
      pathname: '/construction-management',
      href: 'https://127.0.0.1:3001/construction-management',
    };
    Object.defineProperty(globalThis, 'window', {
      value: {
        csrfToken: 'csrf-token',
        location,
      },
      configurable: true,
    });
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: '未登录或登录已失效' }), {
        status: 401,
        headers: {
          'content-type': 'application/json',
          'x-login-url': 'http://127.0.0.1:3001/construction-management',
        },
      }),
    );
    globalThis.fetch = fetchMock;

    await expect(
      constructionFetch(
        '/api/duty-schedules/construction-management/followups',
        {
          method: 'POST',
          body: new FormData(),
        },
      ),
    ).rejects.toThrow('未登录或登录已失效');

    expect(location.href).toBe(
      'https://127.0.0.1:3001/construction-management',
    );
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/duty-schedules/construction-management/followups',
      expect.objectContaining({
        credentials: 'include',
        method: 'POST',
      }),
    );
  });

  it('rejects non-json pages instead of returning them as API data', async () => {
    Object.defineProperty(globalThis, 'window', {
      value: {
        location: {
          origin: 'https://127.0.0.1:3001',
          pathname: '/construction-management',
        },
      },
      configurable: true,
    });
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response('<html><body>login</body></html>', {
        status: 200,
        headers: {
          'content-type': 'text/html',
        },
      }),
    );

    await expect(
      constructionFetch('/api/duty-schedules/construction-management'),
    ).rejects.toThrow('施工管理接口返回异常');
  });

  it('uses wrapped API error messages from construction endpoints', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            code: 'BAD_REQUEST',
            message: '挂牌与隔离是否合规不支持：是',
          },
        }),
        {
          status: 400,
          headers: {
            'content-type': 'application/json',
          },
        },
      ),
    );

    await expect(
      constructionFetch(
        '/api/duty-schedules/construction-management/followups',
        {
          method: 'POST',
          body: new FormData(),
        },
      ),
    ).rejects.toThrow('挂牌与隔离是否合规不支持：是');
  });

  it('normalizes low-level fetch failures into an actionable construction message', async () => {
    globalThis.fetch = jest
      .fn()
      .mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(
      constructionFetch(
        '/api/duty-schedules/construction-management/followups',
        {
          method: 'POST',
          body: new FormData(),
        },
      ),
    ).rejects.toThrow('施工管理接口连接失败，请检查服务是否正常运行后重试');
  });

  it('keeps the internal timeout active when an external signal is also provided', async () => {
    jest.useFakeTimers();
    const externalController = new AbortController();
    globalThis.fetch = createAbortableFetchMock();

    const request = constructionFetch(
      '/api/duty-schedules/construction-management/followups',
      {
        signal: externalController.signal,
        timeout: 100,
      },
    );

    expect(jest.getTimerCount()).toBe(1);
    jest.advanceTimersByTime(100);

    await expect(request).rejects.toThrow(
      '施工管理接口请求超时，请稍后重试或减少单次上传文件数量',
    );
    expect(externalController.signal.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves external cancellation and reports it separately from a timeout', async () => {
    jest.useFakeTimers();
    const externalController = new AbortController();
    globalThis.fetch = createAbortableFetchMock();

    const request = constructionFetch(
      '/api/duty-schedules/construction-management/followups',
      {
        signal: externalController.signal,
        timeout: 100,
      },
    );

    externalController.abort();

    await expect(request).rejects.toThrow('施工管理接口请求已取消');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('reports external cancellation without an internal timeout as cancellation', async () => {
    const externalController = new AbortController();
    globalThis.fetch = createAbortableFetchMock();

    const request = constructionFetch(
      '/api/duty-schedules/construction-management/followups',
      {
        signal: externalController.signal,
      },
    );

    externalController.abort();

    await expect(request).rejects.toThrow('施工管理接口请求已取消');
  });

  it('reports a pre-aborted external signal without an internal timeout as cancellation', async () => {
    const externalController = new AbortController();
    externalController.abort();
    globalThis.fetch = createAbortableFetchMock();

    await expect(
      constructionFetch(
        '/api/duty-schedules/construction-management/followups',
        {
          signal: externalController.signal,
        },
      ),
    ).rejects.toThrow('施工管理接口请求已取消');
  });

  it('removes the external abort listener and timeout after a completed request', async () => {
    jest.useFakeTimers();
    const externalController = new AbortController();
    const addEventListenerSpy = jest.spyOn(
      externalController.signal,
      'addEventListener',
    );
    const removeEventListenerSpy = jest.spyOn(
      externalController.signal,
      'removeEventListener',
    );
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
        },
      }),
    );

    await expect(
      constructionFetch('/api/duty-schedules/construction-management', {
        signal: externalController.signal,
        timeout: 100,
      }),
    ).resolves.toEqual({ success: true });

    expect(addEventListenerSpy).toHaveBeenCalledTimes(1);
    expect(removeEventListenerSpy).toHaveBeenCalledWith(
      'abort',
      addEventListenerSpy.mock.calls[0][1],
    );
    expect(jest.getTimerCount()).toBe(0);
  });

  it('combines timeout and external cancellation without AbortSignal.any', async () => {
    jest.useFakeTimers();
    const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
    Object.defineProperty(AbortSignal, 'any', {
      value: undefined,
      configurable: true,
    });

    try {
      const externalController = new AbortController();
      globalThis.fetch = createAbortableFetchMock();

      const request = constructionFetch(
        '/api/duty-schedules/construction-management/followups',
        {
          signal: externalController.signal,
          timeout: 100,
        },
      );
      jest.advanceTimersByTime(100);

      await expect(request).rejects.toThrow(
        '施工管理接口请求超时，请稍后重试或减少单次上传文件数量',
      );
    } finally {
      if (anyDescriptor) {
        Object.defineProperty(AbortSignal, 'any', anyDescriptor);
      } else {
        delete (AbortSignal as typeof AbortSignal & { any?: unknown }).any;
      }
    }
  });
});

function createAbortableFetchMock(): jest.MockedFunction<typeof fetch> {
  return jest.fn((_input, init) => {
    const signal = init?.signal;

    return new Promise<Response>((_resolve, reject) => {
      const rejectWithAbort = () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      };

      if (signal?.aborted) {
        rejectWithAbort();
        return;
      }
      signal?.addEventListener('abort', rejectWithAbort, { once: true });
    });
  });
}
