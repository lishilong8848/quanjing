/** A session read is safe to retry; authentication and business writes are not. */
export function isTransientSessionReadError(error: unknown): boolean {
  const failure = error as { code?: string; response?: { status?: number } } | null;
  const status = failure?.response?.status;
  return status !== 401 && status !== 403 && (
    failure?.code === 'ERR_NETWORK' || failure?.code === 'ECONNABORTED' ||
    failure?.code === 'ETIMEDOUT' ||
    (typeof status === 'number' && status >= 500 && status < 600)
  );
}

/** Retry once after a short pause, provided the same identity is still current. */
export async function readSessionWithTransientRetry<T>(
  read: () => Promise<T>,
  mayRetry: () => boolean,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!isTransientSessionReadError(error) || signal.aborted || !mayRetry()) throw error;
    await new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        resolve();
      };
      signal.addEventListener('abort', finish, { once: true });
      if (signal.aborted) finish();
      else timer = setTimeout(finish, 1_500);
    });
    if (signal.aborted || !mayRetry()) throw error;
    return read();
  }
}
