jest.mock(
  '@lark-apaas/client-toolkit/logger',
  () => ({ logger: { error: jest.fn() } }),
  { virtual: true },
);
jest.mock('sonner', () => ({ toast: jest.fn() }));
jest.mock('lucide-react', () => ({}));
jest.mock('@/api', () => ({}), { virtual: true });
jest.mock('@/components/ui/alert-dialog', () => ({}), { virtual: true });
jest.mock('@/components/ui/button', () => ({}), { virtual: true });
jest.mock('@/components/ui/dialog', () => ({}), { virtual: true });

const dialog =
  require('../../client/src/pages/MonthlySchedule/WeatherWarningTestCardDialog') as {
    createWeatherWarningTestPreviewRequestGate: () => {
      start: () => number | null;
      invalidate: () => void;
      isCurrent: (version: number) => boolean;
      finish: (version: number) => void;
    };
    invalidateWeatherWarningTestPreviewForSend: (gate: {
      invalidate: () => void;
    }) => void;
    getWeatherWarningTestPermissionRevocationState: (phase?: string) => {
      phase: string;
      preview: null;
      confirmationOpen: boolean;
      requiresPreviewRefresh: boolean;
    } | null;
    canStartWeatherWarningTestCardSend: (input: {
      confirmationOpen: boolean;
      canSubmit: boolean;
      canSendTestCard: boolean;
      isSending: boolean;
    }) => boolean;
    runConfirmedWeatherWarningTestCardSend: <T>(input: {
      confirmationOpen: boolean;
      canSubmit: boolean;
      canSendTestCard: boolean;
      isSending: boolean;
      request: { clientMutationId: string };
      send: (request: { clientMutationId: string }) => Promise<T>;
    }) => Promise<{ started: boolean; result?: T }>;
    canDismissWeatherWarningTestCardDialog: (
      phase: string,
      reason: 'close' | 'escape' | 'outside',
    ) => boolean;
    shouldDeferWeatherWarningTestPreviewForSend: (phase: string) => boolean;
    isConfirmedWeatherWarningTestCardSend: (
      result: {
        success: boolean;
        sent: boolean;
        clientMutationId: string;
        messageId?: string;
      },
      request: { clientMutationId: string },
    ) => boolean;
    getWeatherWarningTestSendFailureState: (error: unknown) => {
      phase: string;
      requiresPreviewRefresh: boolean;
      preservesPendingMutationId: boolean;
    };
    getWeatherWarningPreviewMetrics: (
      weather: Record<string, string | undefined> | null,
    ) => Array<{ label: string; value: string }>;
  };

const REQUEST = {
  clientMutationId: 'weather-warning-dialog-test-20260805',
};

const SENT_RESULT = {
  success: true,
  sent: true,
  clientMutationId: REQUEST.clientMutationId,
  messageId: 'om_test_message_001',
};

describe('MonthlySchedule weather warning test-card dialog behavior', () => {
  it('invalidates an in-flight preview and clears sendable state when permission is revoked', () => {
    const gate = dialog.createWeatherWarningTestPreviewRequestGate();
    const inFlightVersion = gate.start();

    expect(inFlightVersion).not.toBeNull();
    expect(gate.isCurrent(inFlightVersion!)).toBe(true);

    gate.invalidate();

    expect(gate.isCurrent(inFlightVersion!)).toBe(false);
    expect(
      dialog.getWeatherWarningTestPermissionRevocationState(),
    ).toMatchObject({
      phase: 'error',
      preview: null,
      confirmationOpen: false,
      requiresPreviewRefresh: true,
    });

    const nextVersion = gate.start();
    expect(nextVersion).not.toBe(inFlightVersion);
    expect(gate.isCurrent(nextVersion!)).toBe(true);
  });

  it('keeps the irreversible send locked if permission changes while a send is already pending', () => {
    expect(
      dialog.getWeatherWarningTestPermissionRevocationState('sending'),
    ).toBeNull();
    expect(dialog.shouldDeferWeatherWarningTestPreviewForSend('sending')).toBe(
      true,
    );
    expect(dialog.shouldDeferWeatherWarningTestPreviewForSend('ready')).toBe(
      false,
    );
  });

  it('opens and cancels without POST, then starts exactly one POST only after confirmation', async () => {
    const send = jest.fn().mockResolvedValue(SENT_RESULT);

    const opened = await dialog.runConfirmedWeatherWarningTestCardSend({
      confirmationOpen: false,
      canSubmit: true,
      canSendTestCard: true,
      isSending: false,
      request: REQUEST,
      send,
    });
    const cancelled = await dialog.runConfirmedWeatherWarningTestCardSend({
      confirmationOpen: false,
      canSubmit: true,
      canSendTestCard: true,
      isSending: false,
      request: REQUEST,
      send,
    });

    expect(opened).toEqual({ started: false });
    expect(cancelled).toEqual({ started: false });
    expect(send).not.toHaveBeenCalled();

    const confirmed = await dialog.runConfirmedWeatherWarningTestCardSend({
      confirmationOpen: true,
      canSubmit: true,
      canSendTestCard: true,
      isSending: false,
      request: REQUEST,
      send,
    });

    expect(confirmed).toEqual({ started: true, result: SENT_RESULT });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(REQUEST);
  });

  it('blocks close, escape, outside dismissal, and a repeated send while sending', () => {
    for (const reason of ['close', 'escape', 'outside'] as const) {
      expect(
        dialog.canDismissWeatherWarningTestCardDialog('sending', reason),
      ).toBe(false);
    }
    expect(
      dialog.canStartWeatherWarningTestCardSend({
        confirmationOpen: true,
        canSubmit: true,
        canSendTestCard: true,
        isSending: true,
      }),
    ).toBe(false);
  });

  it('invalidates a preview already in flight as soon as sending begins', () => {
    const gate = dialog.createWeatherWarningTestPreviewRequestGate();
    const inFlightVersion = gate.start();

    dialog.invalidateWeatherWarningTestPreviewForSend(gate);

    expect(gate.isCurrent(inFlightVersion!)).toBe(false);
  });

  it('accepts success only when the matching mutation has a nonblank message id', () => {
    expect(
      dialog.isConfirmedWeatherWarningTestCardSend(SENT_RESULT, REQUEST),
    ).toBe(true);
    expect(
      dialog.isConfirmedWeatherWarningTestCardSend(
        { ...SENT_RESULT, messageId: '   ' },
        REQUEST,
      ),
    ).toBe(false);
    expect(
      dialog.isConfirmedWeatherWarningTestCardSend(
        { ...SENT_RESULT, clientMutationId: 'weather-warning-other-request' },
        REQUEST,
      ),
    ).toBe(false);
    expect(
      dialog.isConfirmedWeatherWarningTestCardSend(
        { ...SENT_RESULT, sent: false },
        REQUEST,
      ),
    ).toBe(false);
  });

  it('retains the pending mutation id for uncertain errors but requires a refresh after a 4xx rejection', () => {
    expect(
      dialog.getWeatherWarningTestSendFailureState({
        code: 'ERR_NETWORK',
        message: 'network unavailable',
      }),
    ).toEqual({
      phase: 'uncertain',
      requiresPreviewRefresh: false,
      preservesPendingMutationId: true,
    });
    expect(
      dialog.getWeatherWarningTestSendFailureState({
        response: { status: 403 },
      }),
    ).toEqual({
      phase: 'error',
      requiresPreviewRefresh: true,
      preservesPendingMutationId: true,
    });
  });

  it('derives concise current-weather metrics for the preview', () => {
    expect(
      dialog.getWeatherWarningPreviewMetrics({
        temperature: '31°C',
        feelsLike: '34°C',
        humidity: '75%',
        windDirection: '东风',
        windScale: '3级',
        observedAt: '2026-08-05T10:00:00+08:00',
      }),
    ).toEqual([
      { label: '温度', value: '31°C' },
      { label: '体感温度', value: '34°C' },
      { label: '相对湿度', value: '75%' },
      { label: '风向风力', value: '东风 · 3级' },
      { label: '观测时间', value: '2026-08-05T10:00:00+08:00' },
    ]);
  });
});
