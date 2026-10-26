import { dispatchAccessInvalidated } from '../access/access-events';
import { getCurrentCsrfToken } from './csrf-token';

type ConstructionFetchParams = Record<
  string,
  string | number | boolean | null | undefined
>;

export type ConstructionFetchOptions = {
  method?: string;
  params?: ConstructionFetchParams;
  body?: BodyInit | null;
  headers?: HeadersInit;
  timeout?: number;
  signal?: AbortSignal;
};

export async function constructionFetch<T>(
  path: string,
  options: ConstructionFetchOptions = {},
): Promise<T> {
  const controller = options.timeout ? new AbortController() : null;
  let abortSource: 'external' | 'timeout' | null = null;
  const abortFromExternalSignal = () => {
    if (abortSource) return;
    abortSource = 'external';
    controller?.abort();
  };
  let externalAbortListenerAttached = false;

  if (options.signal) {
    if (options.signal.aborted) {
      abortFromExternalSignal();
    } else {
      options.signal.addEventListener('abort', abortFromExternalSignal, {
        once: true,
      });
      externalAbortListenerAttached = true;
    }
  }

  const timeoutId =
    controller && options.timeout
      ? globalThis.setTimeout(() => {
          if (abortSource) return;
          abortSource = 'timeout';
          controller.abort();
        }, options.timeout)
      : null;

  try {
    const response = await globalThis.fetch(
      buildConstructionUrl(path, options.params),
      {
        method: options.method || 'GET',
        body: options.body,
        credentials: 'include',
        headers: buildConstructionHeaders(options.body, options.headers),
        signal: controller?.signal || options.signal,
      },
    );
    const data = await readConstructionResponse(response);

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        dispatchAccessInvalidated();
      }
      throw new Error(
        getConstructionResponseMessage(data) ||
          `施工管理接口请求失败（${response.status}）`,
      );
    }
    if (!isConstructionJsonData(data)) {
      throw new Error('施工管理接口返回异常');
    }

    return data as T;
  } catch (error) {
    throw normalizeConstructionFetchError(error, abortSource);
  } finally {
    if (timeoutId !== null) globalThis.clearTimeout(timeoutId);
    if (externalAbortListenerAttached && options.signal) {
      options.signal.removeEventListener('abort', abortFromExternalSignal);
    }
  }
}

function normalizeConstructionFetchError(
  error: unknown,
  abortSource: 'external' | 'timeout' | null,
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const name =
    error && typeof error === 'object'
      ? String((error as { name?: unknown }).name || '')
      : '';

  if (name === 'AbortError') {
    if (abortSource === 'external') {
      return new Error('施工管理接口请求已取消');
    }
    return new Error('施工管理接口请求超时，请稍后重试或减少单次上传文件数量');
  }
  if (error instanceof TypeError && isLowLevelFetchFailureMessage(message)) {
    return new Error('施工管理接口连接失败，请检查服务是否正常运行后重试');
  }
  return error instanceof Error ? error : new Error(message);
}

function isLowLevelFetchFailureMessage(message: string): boolean {
  return /failed to fetch|fetch failed|networkerror|load failed/i.test(message);
}

function buildConstructionUrl(
  path: string,
  params?: ConstructionFetchParams,
): string {
  const basePath = normalizeBasePath(process.env.CLIENT_BASE_PATH || '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(
    /^https?:\/\//i.test(path) ? path : `${basePath}${normalizedPath}`,
    getWindowOrigin(),
  );

  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== null && value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  });

  return url.origin === getWindowOrigin()
    ? `${url.pathname}${url.search}`
    : url.toString();
}

function buildConstructionHeaders(
  body?: BodyInit | null,
  input?: HeadersInit,
): Headers {
  const headers = new Headers(input);
  const csrfToken = getCurrentCsrfToken();

  if (csrfToken) {
    headers.set('X-Suda-Csrf-Token', csrfToken);
  } else headers.delete('X-Suda-Csrf-Token');
  if (body && !(body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return headers;
}

async function readConstructionResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json') || looksLikeJson(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function getConstructionResponseMessage(data: unknown): string {
  const directMessage = normalizeConstructionMessage(data);
  if (directMessage) return directMessage;

  if (!isConstructionRecord(data)) return '';

  const wrappedMessage = normalizeConstructionMessage(data.error);
  if (wrappedMessage) return wrappedMessage;

  if (isConstructionRecord(data.error)) {
    return normalizeConstructionDetails(data.error.details);
  }

  return '';
}

function isConstructionJsonData(data: unknown): boolean {
  return isConstructionRecord(data);
}

function normalizeConstructionMessage(data: unknown): string {
  if (typeof data === 'string') return data.trim();
  if (Array.isArray(data)) {
    return data.map(normalizeConstructionMessage).filter(Boolean).join('；');
  }
  if (isConstructionRecord(data)) {
    return normalizeConstructionMessage(data.message);
  }
  return '';
}

function normalizeConstructionDetails(data: unknown): string {
  if (typeof data !== 'string') return '';

  const trimmed = data.trim();
  if (!trimmed) return '';
  if (!looksLikeJson(trimmed)) return trimmed;

  try {
    return normalizeConstructionMessage(JSON.parse(trimmed));
  } catch {
    return '';
  }
}

function isConstructionRecord(data: unknown): data is Record<string, unknown> {
  return Boolean(data) && typeof data === 'object' && !Array.isArray(data);
}

function looksLikeJson(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function normalizeBasePath(value: string): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '';
}

function getWindowOrigin(): string {
  return globalThis.window?.location?.origin || 'http://localhost';
}

