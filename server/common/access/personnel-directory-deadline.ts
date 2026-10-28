import { GatewayTimeoutException } from '@nestjs/common';

/** Limits one display request's wait without cancelling the shared directory read. */
export async function withPersonnelDirectoryDeadline<T>(
  promise: Promise<T>,
  timeoutMs = 50_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new GatewayTimeoutException('人员资料读取超时，请重试')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
