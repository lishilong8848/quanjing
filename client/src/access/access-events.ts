export const UNIFIED_ACCESS_INVALIDATED_EVENT =
  'unified-access-invalidated' as const;

type AccessHttpError = {
  config?: { url?: unknown };
  response?: AccessHttpResponse;
};

type AccessHttpResponse = {
  config?: { url?: unknown };
  status?: unknown;
};

type AccessHttpClient = {
  interceptors: {
    response: {
      use: (
        onFulfilled: (response: unknown) => unknown | Promise<never>,
        onRejected: (error: AccessHttpError) => Promise<never>,
      ) => number;
      eject: (interceptorId: number) => void;
    };
  };
};

export function dispatchAccessInvalidated(): void {
  if (typeof globalThis.window?.dispatchEvent !== 'function') return;
  globalThis.window.dispatchEvent(new Event(UNIFIED_ACCESS_INVALIDATED_EVENT));
}

export function installUnifiedAccessResponseInterceptor(
  httpClient: AccessHttpClient,
): () => void {
  const interceptorId = httpClient.interceptors.response.use(
    (response) => {
      const accessResponse = response as AccessHttpResponse;
      if (!isAuthorizationFailure(accessResponse.status)) return response;

      dispatchInvalidationForRequest(accessResponse.config?.url);
      const error = Object.assign(
        new Error(`HTTP ${String(accessResponse.status)}`),
        {
          config: accessResponse.config,
          response: accessResponse,
        },
      );
      return Promise.reject(error);
    },
    (error: AccessHttpError) => {
      if (isAuthorizationFailure(error.response?.status)) {
        dispatchInvalidationForRequest(error.config?.url);
      }
      return Promise.reject(error);
    },
  );

  return () => {
    httpClient.interceptors.response.eject(interceptorId);
  };
}

function isAuthorizationFailure(status: unknown): boolean {
  return status === 401 || status === 403;
}

function dispatchInvalidationForRequest(url: unknown): void {
  const requestUrl = String(url || '');
  if (!isIndependentAuthenticationEndpoint(requestUrl)) {
    dispatchAccessInvalidated();
  }
}

function isIndependentAuthenticationEndpoint(url: string): boolean {
  try {
    const pathname = new URL(url, 'http://local.invalid').pathname;
    return isIndependentAuthenticationPath(pathname);
  } catch {
    return isIndependentAuthenticationPath(url);
  }
}

function isIndependentAuthenticationPath(value: string): boolean {
  const normalized = value.toLowerCase();
  return (
    normalized.includes('/api/access/') ||
    normalized.includes('/api/authnpaas/')
  );
}
