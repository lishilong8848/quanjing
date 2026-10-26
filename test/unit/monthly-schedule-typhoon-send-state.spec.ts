import {
  clearPendingTyphoonPathMutationId,
  createTyphoonPathSubmissionGate,
  getTyphoonPathConfirmationMode,
  isTyphoonPathSendResultUncertain,
  readPendingTyphoonPathMutationId,
  savePendingTyphoonPathMutationId,
} from '../../client/src/pages/MonthlySchedule/typhoon-path-send';

describe('MonthlySchedule typhoon path send state', () => {
  it('locks synchronously before React state commits and allows a later retry', () => {
    const gate = createTyphoonPathSubmissionGate();

    expect(gate.tryStart()).toBe(true);
    expect(gate.tryStart()).toBe(false);
    gate.finish();
    expect(gate.tryStart()).toBe(true);
  });

  it('requires a force confirmation only when there is no active warning', () => {
    expect(getTyphoonPathConfirmationMode({
      hasActiveWarning: true,
      canSend: true,
    })).toBe('warning-send');
    expect(getTyphoonPathConfirmationMode({
      hasActiveWarning: false,
      canSend: false,
    })).toBe('force-send');
  });

  it('classifies transport failures as uncertain but keeps definite 4xx rejections separate', () => {
    expect(isTyphoonPathSendResultUncertain({
      code: 'ECONNABORTED',
      message: 'timeout of 180000ms exceeded',
    })).toBe(true);
    expect(isTyphoonPathSendResultUncertain({
      code: 'ERR_NETWORK',
      message: 'network unavailable',
    })).toBe(true);
    expect(isTyphoonPathSendResultUncertain({
      response: { status: 504 },
    })).toBe(true);
    expect(isTyphoonPathSendResultUncertain({
      response: { status: 400 },
    })).toBe(false);
  });

  it('persists an uncertain operation id until a confirmed response clears it', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };

    savePendingTyphoonPathMutationId('force-request-20260728', storage);
    expect(readPendingTyphoonPathMutationId(storage))
      .toBe('force-request-20260728');

    clearPendingTyphoonPathMutationId(storage);
    expect(readPendingTyphoonPathMutationId(storage)).toBe('');
  });
});
