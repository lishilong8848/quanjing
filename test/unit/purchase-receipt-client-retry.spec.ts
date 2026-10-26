import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const helperPath = resolve('client/src/api/purchase-receipt-retry.ts');

describe('purchase receipt client retry', () => {
  it('retries one transport interruption and returns the accepted task', async () => {
    expect(existsSync(helperPath)).toBe(true);
    if (!existsSync(helperPath)) return;
    const { retryPurchaseReceiptAcceptance } = jest.requireActual(helperPath) as {
      retryPurchaseReceiptAcceptance: <T>(
        operation: () => Promise<T>,
        retryDelayMs?: number,
      ) => Promise<T>;
    };
    const operation = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ERR_NETWORK' })
      .mockResolvedValue({ pending: true, taskId: 'task-1' });

    await expect(
      retryPurchaseReceiptAcceptance(operation, 0),
    ).resolves.toEqual({ pending: true, taskId: 'task-1' });
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry an HTTP validation response', async () => {
    expect(existsSync(helperPath)).toBe(true);
    if (!existsSync(helperPath)) return;
    const { retryPurchaseReceiptAcceptance } = jest.requireActual(helperPath) as {
      retryPurchaseReceiptAcceptance: <T>(
        operation: () => Promise<T>,
        retryDelayMs?: number,
      ) => Promise<T>;
    };
    const error = { response: { status: 400 } };
    const operation = jest.fn().mockRejectedValue(error);

    await expect(retryPurchaseReceiptAcceptance(operation, 0)).rejects.toBe(
      error,
    );
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('recovers after two consecutive transport interruptions', async () => {
    expect(existsSync(helperPath)).toBe(true);
    if (!existsSync(helperPath)) return;
    const { retryPurchaseReceiptAcceptance } = jest.requireActual(helperPath) as {
      retryPurchaseReceiptAcceptance: <T>(
        operation: () => Promise<T>,
        retryDelayMs?: number,
      ) => Promise<T>;
    };
    const operation = jest
      .fn()
      .mockRejectedValueOnce({ code: 'ERR_NETWORK' })
      .mockRejectedValueOnce({ code: 'ECONNABORTED' })
      .mockResolvedValue({ pending: true, taskId: 'task-recovered' });

    await expect(
      retryPurchaseReceiptAcceptance(operation, 0),
    ).resolves.toMatchObject({ taskId: 'task-recovered' });
    expect(operation).toHaveBeenCalledTimes(3);
  });
});
