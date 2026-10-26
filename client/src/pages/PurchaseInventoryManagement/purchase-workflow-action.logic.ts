export interface ActionButtonStateInput {
  disabled: boolean;
  loading: boolean;
}

export interface ActionButtonState {
  disabled: boolean;
  showSpinner: boolean;
}

export function resolveActionButtonState({
  disabled,
  loading,
}: ActionButtonStateInput): ActionButtonState {
  return {
    disabled: disabled || loading,
    showSpinner: loading,
  };
}

export class PurchaseWorkflowSubmissionGate {
  private readonly inFlightRecordIds = new Set<string>();

  begin(recordId: string): boolean {
    if (this.inFlightRecordIds.has(recordId)) return false;
    this.inFlightRecordIds.add(recordId);
    return true;
  }

  finish(recordId: string): void {
    this.inFlightRecordIds.delete(recordId);
  }
}

export function clearFinishedSubmission(
  currentRecordId: string | null,
  finishedRecordId: string,
): string | null {
  return currentRecordId === finishedRecordId ? null : currentRecordId;
}

export interface PurchaseOrderSubmissionOptions<TResult, TSettled> {
  gate: PurchaseWorkflowSubmissionGate;
  recordId: string;
  onAccepted: () => void;
  onClose: () => void;
  submit: () => Promise<TResult>;
  onSettled: (
    recordId: string,
    outcome: 'completed' | 'failed',
  ) => Promise<TSettled>;
}

export interface PurchaseOrderSubmissionResult<TResult, TSettled> {
  result: TResult;
  settled: TSettled;
}

export class PurchaseOrderSubmissionStateError extends Error {
  readonly stateUncertain = true;
  readonly recoveryFailed: boolean;

  constructor(
    readonly serverAccepted: boolean,
    readonly operationError: unknown | null,
    readonly settlementError: unknown,
  ) {
    super(
      serverAccepted
        ? 'Purchase order was accepted but completed state settlement failed'
        : 'Purchase order failed and state recovery also failed',
    );
    this.name = 'PurchaseOrderSubmissionStateError';
    this.recoveryFailed = !serverAccepted;
  }
}

export async function runPurchaseOrderSubmission<TResult, TSettled>(
  options: PurchaseOrderSubmissionOptions<TResult, TSettled>,
): Promise<PurchaseOrderSubmissionResult<TResult, TSettled> | null> {
  if (!options.gate.begin(options.recordId)) return null;

  try {
    let result: TResult;
    try {
      options.onAccepted();
      options.onClose();
      result = await options.submit();
    } catch (operationError) {
      try {
        await options.onSettled(options.recordId, 'failed');
      } catch (settlementError) {
        throw new PurchaseOrderSubmissionStateError(
          false,
          operationError,
          settlementError,
        );
      }
      throw operationError;
    }

    try {
      const settled = await options.onSettled(options.recordId, 'completed');
      return { result, settled };
    } catch (settlementError) {
      throw new PurchaseOrderSubmissionStateError(
        true,
        null,
        settlementError,
      );
    }
  } finally {
    options.gate.finish(options.recordId);
  }
}
