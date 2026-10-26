export interface InventoryOutboundBrowserLock {
  readonly name: string;
}

export interface InventoryOutboundBrowserLockRequestOptions {
  mode: 'exclusive';
  ifAvailable?: boolean;
}

export interface InventoryOutboundBrowserLockManager {
  request<T>(
    name: string,
    options: InventoryOutboundBrowserLockRequestOptions,
    callback: (lock: InventoryOutboundBrowserLock | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

export type InventoryOutboundBrowserLockAttempt<T> =
  | { acquired: false; reason: 'unavailable' | 'contended' | 'failed' }
  | { acquired: true; value: T };

export function getInventoryOutboundBrowserLockManager(): InventoryOutboundBrowserLockManager | null {
  if (typeof navigator === 'undefined') return null;
  const candidate = (navigator as Navigator & { locks?: unknown }).locks;
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof (candidate as { request?: unknown }).request !== 'function'
  ) {
    return null;
  }
  return candidate as InventoryOutboundBrowserLockManager;
}

export async function runWithInventoryOutboundBrowserLock<T>(
  name: string,
  options: InventoryOutboundBrowserLockRequestOptions,
  callback: () => T | PromiseLike<T>,
): Promise<InventoryOutboundBrowserLockAttempt<T>> {
  const manager = getInventoryOutboundBrowserLockManager();
  if (!manager) return { acquired: false, reason: 'unavailable' };

  try {
    return await manager.request(name, options, async (lock) => {
      if (!lock) return { acquired: false, reason: 'contended' } as const;
      return { acquired: true, value: await callback() } as const;
    });
  } catch {
    return { acquired: false, reason: 'failed' };
  }
}
