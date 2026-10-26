import {
  PurchaseWorkflowSubmissionGate,
  clearFinishedSubmission,
  resolveActionButtonState,
  runPurchaseOrderSubmission,
} from '../../client/src/pages/PurchaseInventoryManagement/purchase-workflow-action.logic';

describe('purchase workflow action logic', () => {
  it('keeps a normally disabled action idle without showing a spinner', () => {
    expect(
      resolveActionButtonState({
        disabled: true,
        loading: false,
      }),
    ).toEqual({
      disabled: true,
      showSpinner: false,
    });
  });

  it('disables an action and shows a spinner only while it is loading', () => {
    expect(
      resolveActionButtonState({
        disabled: false,
        loading: true,
      }),
    ).toEqual({
      disabled: true,
      showSpinner: true,
    });
  });

  it('blocks only duplicate submissions for the same record', () => {
    const gate = new PurchaseWorkflowSubmissionGate();

    expect(gate.begin('record-a')).toBe(true);
    expect(gate.begin('record-a')).toBe(false);
    expect(gate.begin('record-b')).toBe(true);

    gate.finish('record-a');
    expect(gate.begin('record-a')).toBe(true);
    expect(gate.begin('record-b')).toBe(false);
  });

  it('clears a finished submission only when it is still the current record', () => {
    expect(clearFinishedSubmission('record-a', 'record-a')).toBeNull();
    expect(clearFinishedSubmission('record-b', 'record-a')).toBe('record-b');
    expect(clearFinishedSubmission(null, 'record-a')).toBeNull();
  });

  it('accepts and closes immediately, then settles a successful submission', async () => {
    const gate = new PurchaseWorkflowSubmissionGate();
    const request = deferred<{ notificationWarnings: string[] }>();
    const events: string[] = [];

    const submission = runPurchaseOrderSubmission({
      gate,
      recordId: 'record-a',
      onAccepted: () => events.push('accepted'),
      onClose: () => events.push('closed'),
      submit: () => {
        events.push('submitted');
        return request.promise;
      },
      onSettled: async (_recordId, outcome) => {
        events.push(`settled:${outcome}`);
        return true;
      },
    });

    expect(events).toEqual(['accepted', 'closed', 'submitted']);

    const result = { notificationWarnings: ['warning'] };
    request.resolve(result);
    await expect(submission).resolves.toEqual({
      result,
      settled: true,
    });
    expect(events).toEqual([
      'accepted',
      'closed',
      'submitted',
      'settled:completed',
    ]);
    expect(gate.begin('record-a')).toBe(true);
  });

  it('does not send a second request while the same record is in flight', async () => {
    const gate = new PurchaseWorkflowSubmissionGate();
    const request = deferred<string>();
    let requestCount = 0;
    const options = {
      gate,
      recordId: 'record-a',
      onAccepted: () => undefined,
      onClose: () => undefined,
      submit: () => {
        requestCount += 1;
        return request.promise;
      },
      onSettled: async () => true,
    };

    const first = runPurchaseOrderSubmission(options);
    await expect(runPurchaseOrderSubmission(options)).resolves.toBeNull();
    expect(requestCount).toBe(1);

    request.resolve('completed');
    await expect(first).resolves.toEqual({
      result: 'completed',
      settled: true,
    });
  });

  it.each(['onAccepted', 'onClose'] as const)(
    'settles as failed and releases the gate when %s throws synchronously',
    async (failingCallback) => {
      const gate = new PurchaseWorkflowSubmissionGate();
      const originalError = new Error(`${failingCallback} failed`);
      const outcomes: string[] = [];
      let submitCount = 0;

      await expect(
        runPurchaseOrderSubmission({
          gate,
          recordId: 'record-a',
          onAccepted: () => {
            if (failingCallback === 'onAccepted') throw originalError;
          },
          onClose: () => {
            if (failingCallback === 'onClose') throw originalError;
          },
          submit: async () => {
            submitCount += 1;
            return 'unexpected';
          },
          onSettled: async (recordId, outcome) => {
            outcomes.push(`${recordId}:${outcome}`);
            return false;
          },
        }),
      ).rejects.toBe(originalError);

      expect(submitCount).toBe(0);
      expect(outcomes).toEqual(['record-a:failed']);
      expect(gate.begin('record-a')).toBe(true);
    },
  );

  it('reports uncertain state without rolling back when completed settlement fails', async () => {
    const gate = new PurchaseWorkflowSubmissionGate();
    const settlementError = new Error('completed settlement failed');
    const outcomes: string[] = [];

    const error = await captureRejection(
      runPurchaseOrderSubmission({
        gate,
        recordId: 'record-a',
        onAccepted: () => undefined,
        onClose: () => undefined,
        submit: async () => 'server accepted',
        onSettled: async (_recordId, outcome) => {
          outcomes.push(outcome);
          throw settlementError;
        },
      }),
    );

    expect(error?.constructor.name).toBe('PurchaseOrderSubmissionStateError');
    expect(error).toMatchObject({
      serverAccepted: true,
      stateUncertain: true,
      recoveryFailed: false,
      operationError: null,
      settlementError,
    });
    expect(outcomes).toEqual(['completed']);
    expect(gate.begin('record-a')).toBe(true);
  });

  it('reports both errors when submission failure recovery also fails', async () => {
    const gate = new PurchaseWorkflowSubmissionGate();
    const requestError = new Error('request failed');
    const settlementError = new Error('failure settlement failed');
    const outcomes: string[] = [];

    const error = await captureRejection(
      runPurchaseOrderSubmission({
        gate,
        recordId: 'record-a',
        onAccepted: () => undefined,
        onClose: () => undefined,
        submit: async () => {
          throw requestError;
        },
        onSettled: async (_recordId, outcome) => {
          outcomes.push(outcome);
          throw settlementError;
        },
      }),
    );

    expect(error?.constructor.name).toBe('PurchaseOrderSubmissionStateError');
    expect(error).toMatchObject({
      serverAccepted: false,
      stateUncertain: true,
      recoveryFailed: true,
      operationError: requestError,
      settlementError,
    });
    expect(outcomes).toEqual(['failed']);
    expect(gate.begin('record-a')).toBe(true);
  });

  it('rethrows the submission error after failed state settles successfully', async () => {
    const gate = new PurchaseWorkflowSubmissionGate();
    const requestError = new Error('request failed');
    const outcomes: string[] = [];

    await expect(
      runPurchaseOrderSubmission({
        gate,
        recordId: 'record-a',
        onAccepted: () => undefined,
        onClose: () => undefined,
        submit: async () => {
          throw requestError;
        },
        onSettled: async (_recordId, outcome) => {
          outcomes.push(outcome);
          return false;
        },
      }),
    ).rejects.toBe(requestError);

    expect(outcomes).toEqual(['failed']);
    expect(gate.begin('record-a')).toBe(true);
  });
});

async function captureRejection(
  promise: Promise<unknown>,
): Promise<Record<string, unknown> & Error> {
  try {
    await promise;
  } catch (error) {
    return error as Record<string, unknown> & Error;
  }
  throw new Error('Expected promise to reject');
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
