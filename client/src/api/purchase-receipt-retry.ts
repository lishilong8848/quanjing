const DEFAULT_RETRY_DELAY_MS = 400;
const MAX_ATTEMPTS = 3;

export async function retryPurchaseReceiptAcceptance<T>(
  operation: () => Promise<T>,
  retryDelayMs = DEFAULT_RETRY_DELAY_MS,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransportInterruption(error) || attempt === MAX_ATTEMPTS) {
        throw error;
      }
      const delayMs = retryDelayMs * 2 ** (attempt - 1);
      if (delayMs > 0) await wait(delayMs);
    }
  }
  throw new Error('签收受理请求未执行');
}

function isTransportInterruption(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    code?: string;
    response?: unknown;
  };
  return (
    candidate.response === undefined &&
    ['ERR_NETWORK', 'ECONNABORTED', 'ETIMEDOUT'].includes(candidate.code || '')
  );
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}
