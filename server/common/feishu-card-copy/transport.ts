import type { AxiosInstance, AxiosResponse } from 'axios';

export interface PrimaryCardDelivery {
  source: string; messageId: string; card: Record<string, unknown>;
  recipientId: string; recipientType: string; uuid?: string; startedAt: string;
}
export interface CardCopyObserver {
  delivered(event: PrimaryCardDelivery): Promise<void>;
  reserveUpdate(messageId: string): Promise<unknown>;
  cancelUpdate?(operation: unknown): Promise<void>;
  updated(messageId: string, card: Record<string, unknown>, operation?: unknown): Promise<void>;
  isCopyMessage(messageId: string): boolean;
  diagnostic(code: string): void;
}
let observer: CardCopyObserver | undefined;
/** Only the application module or an explicitly configured standalone operation registers an observer. */
export function registerCardCopyObserver(value: CardCopyObserver): () => void {
  if (observer && observer !== value) throw new Error('CARD_COPY_OBSERVER_ALREADY_REGISTERED');
  observer = value;
  return () => { if (observer === value) observer = undefined; };
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function parseCard(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') { if (value.length > 1_000_000) return undefined; try { value = JSON.parse(value); } catch { return undefined; } }
  if (!record(value)) return undefined;
  try { return structuredClone(value); } catch { return undefined; }
}
function messageApi(url: string): URL | undefined {
  try { const value = new URL(url); return value.origin === 'https://open.feishu.cn' && !value.username && !value.password ? value : undefined; } catch { return undefined; }
}
function apiSuccess(response: AxiosResponse<unknown>): boolean { return response.status >= 200 && response.status < 300 && record(response.data) && response.data.code === 0; }
function note(code: string): void { try { observer?.diagnostic(code); } catch { /* Diagnostics cannot change an accepted business result. */ } }
async function releaseUpdateReservation(operation: unknown): Promise<void> {
  if (!operation) return;
  try { await observer?.cancelUpdate?.(operation); } catch { note('CARD_COPY_UPDATE_CANCEL_FAILED'); }
}

export async function observedCardPost(http: Pick<AxiosInstance, 'post'>, source: string, url: string, body: unknown, config: unknown): Promise<AxiosResponse<any>> {
  const target = messageApi(url), payload = record(body) ? body : undefined;
  const card = observer && target?.pathname === '/open-apis/im/v1/messages' && payload?.msg_type === 'interactive' ? parseCard(payload.content) : undefined;
  const startedAt = new Date().toISOString();
  const response = await http.post(url, body, config as never);
  if (observer && card && payload && target && apiSuccess(response)) {
    const id = record(response.data.data) ? response.data.data.message_id : undefined;
    if (typeof id === 'string' && /^om_[A-Za-z0-9_-]+$/.test(id) && typeof payload.receive_id === 'string') {
      try { await observer.delivered({ source, card, messageId: id, recipientId: payload.receive_id,
        recipientType: target.searchParams.get('receive_id_type') || String((config as { params?: { receive_id_type?: string } })?.params?.receive_id_type || 'open_id'),
        ...(typeof payload.uuid === 'string' ? { uuid: payload.uuid } : {}), startedAt }); }
      catch { note('CARD_COPY_ENROLLMENT_FAILED'); }
    }
  }
  return response;
}

export async function observedCardPatch(http: Pick<AxiosInstance, 'patch'>, _source: string, url: string, body: unknown, config: unknown): Promise<AxiosResponse<any>> {
  const target = messageApi(url), id = target?.pathname.match(/^\/open-apis\/im\/v1\/messages\/(om_[A-Za-z0-9_-]+)$/)?.[1];
  const card = observer && id && record(body) ? parseCard(body.content) : undefined;
  let operation: unknown;
  if (observer && card && id) { try { operation = await observer.reserveUpdate(id); } catch { note('CARD_COPY_UPDATE_INTENT_FAILED'); } }
  let response: AxiosResponse<any>;
  try { response = await http.patch(url, body, config as never); }
  catch (error) { await releaseUpdateReservation(operation); throw error; }
  if (observer && card && id && apiSuccess(response) && operation) { try { await observer.updated(id, card, operation); } catch { await releaseUpdateReservation(operation); note('CARD_COPY_UPDATE_CAPTURE_FAILED'); } }
  else await releaseUpdateReservation(operation);
  return response;
}

export async function observeCardUpdate(_source: string, messageId: string | undefined, card: Record<string, unknown>): Promise<void> {
  if (!observer || !messageId || !/^om_[A-Za-z0-9_-]+$/.test(messageId)) return;
  let operation: unknown;
  try { operation = await observer.reserveUpdate(messageId); if (operation) await observer.updated(messageId, card, operation); }
  catch { await releaseUpdateReservation(operation); note('CARD_COPY_CALLBACK_CAPTURE_FAILED'); }
}
/** Token updates carry a private callback capability; only the original message ID is recorded. */
export async function observedCardTokenUpdate(http: Pick<AxiosInstance, 'post'>, _source: string, url: string, body: unknown, config: unknown, messageId?: string): Promise<AxiosResponse<any>> {
  const target = messageApi(url);
  const card = observer && messageId && /^om_[A-Za-z0-9_-]+$/.test(messageId) && target?.pathname === '/open-apis/interactive/v1/card/update' && record(body) ? parseCard(body.card) : undefined;
  let operation: unknown;
  if (observer && card && messageId) { try { operation = await observer.reserveUpdate(messageId); } catch { note('CARD_COPY_UPDATE_INTENT_FAILED'); } }
  let response: AxiosResponse<any>;
  try { response = await http.post(url, body, config as never); }
  catch (error) { await releaseUpdateReservation(operation); throw error; }
  if (observer && card && messageId && operation && apiSuccess(response)) { try { await observer.updated(messageId, card, operation); } catch { await releaseUpdateReservation(operation); note('CARD_COPY_UPDATE_CAPTURE_FAILED'); } }
  else await releaseUpdateReservation(operation);
  return response;
}
export function originalCardMessageId(payload: unknown): string | undefined {
  if (!record(payload)) return undefined;
  const event = record(payload.event) ? payload.event : payload;
  const context = record(event.context) ? event.context : undefined;
  const id = context?.open_message_id || event.open_message_id || event.messageId || event.deliveryMessageId || event.message_id;
  return typeof id === 'string' && /^om_[A-Za-z0-9_-]+$/.test(id) ? id : undefined;
}
export async function observeCardCallbackResult(source: string, payload: unknown, result: unknown): Promise<void> {
  if (!record(result) || !record(result.card)) return;
  const card = result.card.type === 'raw' ? parseCard(result.card.data) : parseCard(result.card);
  if (card) await observeCardUpdate(source, originalCardMessageId(payload), card);
}
export function isReadonlyCopyCallback(payload: unknown): boolean {
  const id = originalCardMessageId(payload);
  if (!id) return false;
  try { return observer?.isCopyMessage(id) === true; } catch { return false; }
}
