import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { isAxiosError } from 'axios';
import { getCurrentCsrfToken } from '@/api/csrf-token';

const ROOT = '/api/file-publication';

export interface PublicationGroup {
  id: string;
  name: string;
  kind?: 'person' | 'group';
}

export interface PublicationOptions {
  groups: PublicationGroup[];
  sources: Array<{ label: string; url: string }>;
  canPublish: boolean;
  canArchive?: boolean;
  canReview: boolean;
  canReadPublication?: boolean;
  canManageRecords?: boolean;
  limits?: { maxFiles: number; maxFileBytes: number; maxTotalBytes: number };
}

export type PublicationSubmissionMode = 'release' | 'archive';

export interface PublicationPreview {
  tableName: string;
  sourceUrl: string;
  fields: Array<{ key: string; name: string; value: string; maxLength?: number; required?: true }>;
  code?: string;
  codeFieldKey?: string;
  attachmentField?: { key: string; name: string };
  batchField?: { key: string; name: string };
  schemaVersion?: string;
}

export interface PublicationFile {
  id: string;
  name: string;
  size: number;
}

export interface PublicationBatch {
  id: string;
  title: string;
  code: string;
  groups: PublicationGroup[];
  publisher: string;
  submittedAt: string;
  status: 'syncing' | 'pending' | 'publishing' | 'published' | 'archived' | 'rejected' | 'failed';
  files: PublicationFile[];
  canReview: boolean;
  canDownload: boolean;
  deliveries?: PublicationDelivery[];
  error?: string;
  reason?: string;
}

export interface PublicationDelivery {
  recipientId: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'not_applicable';
  message?: string;
  canRetry?: boolean;
}

interface PublicationHistoryQuery {
  page: number;
  pageSize: number;
  q?: string;
  status?: string;
  from?: string;
  to?: string;
  focus?: string;
}

interface PublicationHistoryPage {
  batches: PublicationBatch[];
  page: number;
  pageSize: number;
  total: number;
}

export type PublicationRecordLink = { text: string; link: string };
export type PublicationRecordValue = string | number | boolean | string[] | PublicationRecordLink | null;
export type PublicationRecordValues = Record<string, PublicationRecordValue>;

export interface PublicationRecordField {
  key: string;
  name: string;
  type: number;
  editable: boolean;
  options?: Array<{ id: string; name: string }>;
}

export interface PublicationRecord {
  id: string;
  version: string;
  values: PublicationRecordValues;
  managed: boolean;
  readonlyFields?: string[];
}

export interface PublicationRecordPage {
  tableName: string;
  sourceUrl: string;
  schemaVersion: string;
  fields: PublicationRecordField[];
  records: PublicationRecord[];
  pageToken?: string;
  total?: number;
  permissions: { create: boolean; update: boolean; delete: boolean };
}

export type PublicationRecordSearch = { keyword: string; fieldKey?: string };

export function createPublicationRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}

function csrfHeaders() {
  const token = getCurrentCsrfToken();
  return token ? { 'X-Suda-Csrf-Token': token } : undefined;
}

export async function loadPublicationOptions(signal?: AbortSignal) {
  const { data } = await axiosForBackend<PublicationOptions>({ url: `${ROOT}/options`, timeout: 15_000, signal });
  return data;
}

export async function loadPublicationHistory(params: PublicationHistoryQuery, signal?: AbortSignal) {
  const { data } = await axiosForBackend<PublicationHistoryPage>({
    url: `${ROOT}/batches`, params, timeout: 15_000, signal,
  });
  return data;
}

export async function loadPublicationBatch(id: string, signal?: AbortSignal) {
  const { data } = await axiosForBackend<PublicationBatch | { batch: PublicationBatch }>({
    url: `${ROOT}/batches/${encodeURIComponent(id)}`, timeout: 15_000, signal,
  });
  return 'batch' in data ? data.batch : data;
}

export async function retryPublicationDeliveries(id: string, recipientIds: string[], requestId: string) {
  await axiosForBackend({
    url: `${ROOT}/batches/${encodeURIComponent(id)}/deliveries/retry`, method: 'POST',
    headers: csrfHeaders(), data: { recipientIds, requestId }, timeout: 25_000,
  });
}

export async function parsePublication(link: string, files: File[], signal?: AbortSignal) {
  const { data } = await axiosForBackend<PublicationPreview>({
    url: `${ROOT}/parse`, method: 'POST', headers: csrfHeaders(), timeout: 25_000, signal,
    data: { link, files: files.map(({ name, size }) => ({ name, size })) },
  });
  return data;
}

export async function loadPublicationRecords(
  link: string, pageToken: string | undefined, signal: AbortSignal, search?: PublicationRecordSearch,
) {
  const { data } = await axiosForBackend<PublicationRecordPage>({
    url: `${ROOT}/records/query`, method: 'POST', headers: csrfHeaders(), timeout: 30_000, signal,
    data: { link, ...(pageToken ? { pageToken } : {}), ...(search ? { search } : {}) },
  });
  return data;
}

export type PublicationRecordMutation = { link: string; requestId: string } & (
  | { kind: 'create'; schemaVersion: string; values: PublicationRecordValues }
  | { kind: 'update'; record: PublicationRecord; values: PublicationRecordValues }
  | { kind: 'delete'; record: PublicationRecord }
);

export type PublicationRecordMutationResult = { record: PublicationRecord } | { deleted: true; id: string };

export async function mutatePublicationRecord(mutation: PublicationRecordMutation) {
  const { link, requestId } = mutation;
  const recordPath = mutation.kind === 'create' ? '' : `/${encodeURIComponent(mutation.record.id)}`;
  const { data } = await axiosForBackend<PublicationRecordMutationResult>({
    url: `${ROOT}/records${recordPath}${mutation.kind === 'delete' ? '/delete' : ''}`,
    method: mutation.kind === 'update' ? 'PATCH' : 'POST', headers: csrfHeaders(), timeout: 65_000,
    data: {
      link, requestId,
      ...(mutation.kind === 'create' ? { schemaVersion: mutation.schemaVersion } : { version: mutation.record.version }),
      ...(mutation.kind === 'delete' ? {} : { values: mutation.values }),
    },
  });
  return data;
}

export async function submitPublication(
  requestId: string, link: string, groupIds: string[], metadata: Record<string, string>,
  files: File[], recipientInputs: string[] = [], schemaVersion?: string,
  mode: PublicationSubmissionMode = 'release',
) {
  const body = new FormData();
  body.set('requestId', requestId);
  body.set('link', link);
  body.set('groupIds', JSON.stringify(mode === 'archive' ? [] : groupIds));
  body.set('metadata', JSON.stringify(metadata));
  if (mode === 'archive') body.set('mode', mode);
  else if (recipientInputs.length) body.set('recipientInputs', JSON.stringify(recipientInputs));
  if (schemaVersion) body.set('schemaVersion', schemaVersion);
  for (const file of files) body.append('files', file);
  await axiosForBackend({ url: `${ROOT}/batches`, method: 'POST', headers: csrfHeaders(), data: body, timeout: 120_000 });
}

export async function reviewPublication(id: string, decision: 'approve' | 'reject', reason?: string) {
  await axiosForBackend({
    url: `${ROOT}/batches/${encodeURIComponent(id)}/review`, method: 'POST',
    headers: csrfHeaders(), data: { decision, ...(reason ? { reason } : {}) }, timeout: 30_000,
  });
}

export async function downloadPublicationFile(batchId: string, file: PublicationFile, signal: AbortSignal) {
  const { data } = await axiosForBackend<Blob>({
    url: `${ROOT}/batches/${encodeURIComponent(batchId)}/files/${encodeURIComponent(file.id)}`,
    responseType: 'blob', timeout: 120_000, signal,
  });
  if (signal.aborted) return;
  const href = URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = file.name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export function publicationError(error: unknown, fallback: string): string {
  const message: unknown = isAxiosError(error) ? error.response?.data?.message : undefined;
  if (typeof message === 'string' && message.trim()) return message;
  if (Array.isArray(message)) {
    const messages = message.filter((entry): entry is string => typeof entry === 'string' && !!entry.trim());
    if (messages.length) return messages.join('；');
  }
  return fallback;
}

export function publicationResultUncertain(error: unknown): boolean {
  const status = isAxiosError(error) ? error.response?.status : undefined;
  return status == null || status >= 500;
}

export function publicationVersionConflict(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 409;
}

export function publicationSchemaChanged(error: unknown): boolean {
  return isAxiosError(error) && error.response?.status === 400 &&
    error.response.data?.code === 'PUBLICATION_SCHEMA_CHANGED';
}

export async function lookupPublicationSubmission(requestId: string, signal?: AbortSignal) {
  const { data } = await axiosForBackend<{ batch: PublicationBatch | null }>({
    url: `${ROOT}/submissions/${encodeURIComponent(requestId)}`, timeout: 15_000, signal,
  });
  return data.batch;
}
