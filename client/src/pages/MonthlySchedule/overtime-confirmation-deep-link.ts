import type { OvertimeConfirmationDetail } from './overtime-confirmation-state';

const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/u;
const TICKET_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const TICKET_MAX_LENGTH = 2_048;
const INVALID_LINK_MESSAGE = '加班确认链接无效，请从最新飞书卡片重新打开';

export interface OvertimeConfirmationDeepLinkCredentials {
  recordId: string;
  ticket: string;
}

export type OvertimeConfirmationDeepLinkResult =
  | ({ kind: 'ready' } & OvertimeConfirmationDeepLinkCredentials)
  | { kind: 'invalid'; message: string }
  | { kind: 'none' };

interface OvertimeConfirmationBrowser {
  location: { href: string };
  history: {
    state: unknown;
    replaceState(state: unknown, title: string, url: string): void;
  };
}

export type OvertimeConfirmationDetailLoadState =
  | { phase: 'idle'; revision: number }
  | {
      phase: 'loading';
      revision: number;
      credentials: OvertimeConfirmationDeepLinkCredentials;
    }
  | {
      phase: 'ready';
      revision: number;
      credentials: OvertimeConfirmationDeepLinkCredentials;
      detail: OvertimeConfirmationDetail;
    }
  | {
      phase: 'error';
      revision: number;
      credentials: OvertimeConfirmationDeepLinkCredentials;
      message: string;
    };

export function consumeOvertimeConfirmationDeepLink(
  browser: OvertimeConfirmationBrowser,
): OvertimeConfirmationDeepLinkResult {
  let url: URL;
  try {
    url = new URL(browser.location.href);
  } catch {
    return { kind: 'invalid', message: INVALID_LINK_MESSAGE };
  }

  const relatedKeys = ['overtimeConfirmation', 'recordId', 'ticket'] as const;
  const query = url.searchParams;
  const fragment = new URLSearchParams(url.hash.replace(/^#/u, ''));
  const queryHasConfirmationValues = relatedKeys.some((key) => query.has(key));
  const fragmentHasConfirmationValues = relatedKeys.some((key) =>
    fragment.has(key),
  );
  if (!queryHasConfirmationValues && !fragmentHasConfirmationValues) {
    return { kind: 'none' };
  }

  const credentials = queryHasConfirmationValues ? query : fragment;

  const markerValues = credentials.getAll('overtimeConfirmation');
  const recordIdValues = credentials.getAll('recordId');
  const ticketValues = credentials.getAll('ticket');
  for (const key of relatedKeys) {
    query.delete(key);
    fragment.delete(key);
  }
  url.search = query.toString();
  url.hash = fragment.toString();
  browser.history.replaceState(browser.history.state, '', url.toString());

  const recordId = recordIdValues[0]?.trim() || '';
  const ticket = ticketValues[0]?.trim() || '';
  const valid =
    markerValues.length === 1 &&
    markerValues[0] === '1' &&
    queryHasConfirmationValues !== fragmentHasConfirmationValues &&
    recordIdValues.length === 1 &&
    RECORD_ID_PATTERN.test(recordId) &&
    ticketValues.length === 1 &&
    ticket.length <= TICKET_MAX_LENGTH &&
    TICKET_PATTERN.test(ticket);

  return valid
    ? { kind: 'ready', recordId, ticket }
    : { kind: 'invalid', message: INVALID_LINK_MESSAGE };
}

export function createOvertimeConfirmationDetailLoadState(): OvertimeConfirmationDetailLoadState {
  return { phase: 'idle', revision: 0 };
}

export function beginOvertimeConfirmationDetailLoad(
  state: OvertimeConfirmationDetailLoadState,
  credentials: OvertimeConfirmationDeepLinkCredentials,
): OvertimeConfirmationDetailLoadState {
  return {
    phase: 'loading',
    revision: state.revision + 1,
    credentials,
  };
}

export function resolveOvertimeConfirmationDetailLoad(
  state: OvertimeConfirmationDetailLoadState,
  revision: number,
  recordId: string,
  detail: OvertimeConfirmationDetail,
): OvertimeConfirmationDetailLoadState {
  if (
    state.phase !== 'loading' ||
    state.revision !== revision ||
    state.credentials.recordId !== recordId ||
    detail.recordId !== recordId
  ) {
    return state;
  }
  return {
    phase: 'ready',
    revision,
    credentials: state.credentials,
    detail,
  };
}

export function rejectOvertimeConfirmationDetailLoad(
  state: OvertimeConfirmationDetailLoadState,
  revision: number,
  recordId: string,
  message: string,
): OvertimeConfirmationDetailLoadState {
  if (
    state.phase !== 'loading' ||
    state.revision !== revision ||
    state.credentials.recordId !== recordId
  ) {
    return state;
  }
  return {
    phase: 'error',
    revision,
    credentials: state.credentials,
    message,
  };
}

export function closeOvertimeConfirmationDetailLoad(
  state: OvertimeConfirmationDetailLoadState,
): OvertimeConfirmationDetailLoadState {
  return { phase: 'idle', revision: state.revision + 1 };
}
