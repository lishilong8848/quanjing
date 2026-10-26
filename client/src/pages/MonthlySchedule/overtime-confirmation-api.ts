import type {
  OvertimeConfirmationAcceptedResponse,
  OvertimeConfirmationDetailResponse,
  OvertimeConfirmationSubmitPayload,
} from '@shared/api.interface';

import { getCurrentCsrfToken } from '../../api/csrf-token';

const REQUEST_TIMEOUT_MS = 15_000;

interface OvertimeConfirmationHttpResponse {
  status: number;
  data: unknown;
}

export async function getOvertimeConfirmationDetail(
  recordId: string,
  ticket: string,
  signal?: AbortSignal,
): Promise<OvertimeConfirmationDetailResponse> {
  return requestOvertimeConfirmation<OvertimeConfirmationDetailResponse>(
    recordId,
    {
      method: 'GET',
      headers: { 'X-Overtime-Confirmation-Ticket': ticket },
    },
    signal,
  );
}

export async function submitOvertimeConfirmation(
  recordId: string,
  ticket: string,
  idempotencyKey: string,
  payload: OvertimeConfirmationSubmitPayload,
): Promise<OvertimeConfirmationAcceptedResponse> {
  const csrfToken = getCurrentCsrfToken();
  return requestOvertimeConfirmation<OvertimeConfirmationAcceptedResponse>(
    recordId,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Overtime-Confirmation-Ticket': ticket,
        'X-Idempotency-Key': idempotencyKey,
        ...(csrfToken ? { 'X-Suda-Csrf-Token': csrfToken } : {}),
      },
      body: JSON.stringify(payload),
    },
  );
}

async function requestOvertimeConfirmation<T>(
  recordId: string,
  init: RequestInit,
  externalSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortFromExternal();
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `/api/overtime-workflow/confirm/${encodeURIComponent(recordId)}`,
      {
        ...init,
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
      },
    );
    const data = await parseResponseBody(response);
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        response: {
          status: response.status,
          data,
        } satisfies OvertimeConfirmationHttpResponse,
      });
    }
    return data as T;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

