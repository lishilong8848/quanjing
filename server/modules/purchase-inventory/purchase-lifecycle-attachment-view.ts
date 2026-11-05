import { createHmac, timingSafeEqual } from 'node:crypto';

export type PurchaseLifecycleAttachmentPurpose = 'comparison' | 'payment' | 'receipt' | 'invoice';
export interface PurchaseLifecycleAttachmentSelector {
  appId: string;
  batchId: string;
  recordId: string;
  recipientOpenId: string;
  messageId: string;
  purpose: PurchaseLifecycleAttachmentPurpose;
  index: number;
}

/** Must use current server identity, duty, record scope and delivered message binding. */
export interface PurchaseLifecycleAttachmentAuthority {
  assertCanView(selector: PurchaseLifecycleAttachmentSelector): Promise<void>;
}

/** Internal trusted gateway; attachment identifiers must never be returned to the client. */
export interface PurchaseLifecycleAttachmentSource {
  identify(selector: PurchaseLifecycleAttachmentSelector): Promise<string>;
  download(selector: PurchaseLifecycleAttachmentSelector, internalId: string): Promise<{ data: Buffer; contentType: string }>;
}

/** The endpoint must obtain this identity from its authenticated server-side session. */
export interface PurchaseLifecycleAuthenticatedViewer { appId: string; openId: string; assertCurrent(): void; }

type Payload = PurchaseLifecycleAttachmentSelector & { issuedAt: number; attachmentBinding: string; version: 1 };
const TTL_MS = 10 * 60_000;
const MAX_BYTES = 20 * 1024 * 1024;
const PURPOSES = ['comparison', 'payment', 'receipt', 'invoice'];
const CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'application/pdf', 'application/octet-stream']);
const invalid = (): never => { throw new Error('采购附件查看凭据或权限无效'); };

function selector(value: PurchaseLifecycleAttachmentSelector): PurchaseLifecycleAttachmentSelector {
  if (!value || !/^cli_[A-Za-z0-9_-]{1,124}$/.test(value.appId) || !/^[A-Za-z0-9_-]{8,160}$/.test(value.batchId) ||
    !/^[A-Za-z0-9_-]{1,100}$/.test(value.recordId) || !/^ou_[A-Za-z0-9_-]{1,128}$/.test(value.recipientOpenId) ||
    !/^om_[A-Za-z0-9_-]{1,124}$/.test(value.messageId) || !PURPOSES.includes(value.purpose) ||
    !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= 20) return invalid();
  return { appId: value.appId, batchId: value.batchId, recordId: value.recordId, recipientOpenId: value.recipientOpenId,
    messageId: value.messageId, purpose: value.purpose, index: value.index };
}

function secret(value: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) return invalid();
  return value;
}
function sign(key: string, value: string): string { return createHmac('sha256', key).update(value).digest('base64url'); }
function equal(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function binding(key: string, target: PurchaseLifecycleAttachmentSelector, internalId: string): string {
  if (typeof internalId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(internalId)) return invalid();
  return sign(key, JSON.stringify(['purchase-lifecycle-attachment-v1', target.appId, target.batchId, target.recordId, target.purpose, internalId]));
}
function checkViewer(viewer: PurchaseLifecycleAuthenticatedViewer, target: PurchaseLifecycleAttachmentSelector): void {
  if (!viewer || viewer.appId !== target.appId || viewer.openId !== target.recipientOpenId || typeof viewer.assertCurrent !== 'function') return invalid();
  const result: unknown = viewer.assertCurrent();
  if (result instanceof Promise) void result.catch(() => undefined);
  if (result !== undefined) return invalid();
}
function validTime(value: number): boolean { return Number.isSafeInteger(value) && value > 0; }

/** Standalone design only: no route or production use is registered here. */
export class PurchaseLifecycleAttachmentViewService {
  private readonly key: string;
  constructor(key: string, private readonly authority: PurchaseLifecycleAttachmentAuthority, private readonly source: PurchaseLifecycleAttachmentSource, private readonly clock: () => number = Date.now) {
    this.key = secret(key);
  }

  private async authorize(target: PurchaseLifecycleAttachmentSelector): Promise<void> {
    try { await this.authority.assertCanView(target); } catch { invalid(); }
  }
  private async identify(target: PurchaseLifecycleAttachmentSelector): Promise<string> {
    try { return await this.source.identify(target); } catch { return invalid(); }
  }
  private async download(target: PurchaseLifecycleAttachmentSelector, internalId: string): Promise<{ data: Buffer; contentType: string }> {
    try { return await this.source.download(target, internalId); } catch { return invalid(); }
  }

  async issue(input: PurchaseLifecycleAttachmentSelector, viewer: PurchaseLifecycleAuthenticatedViewer): Promise<string> {
    const target = selector(input);
    checkViewer(viewer, target);
    await this.authorize(target);
    const internalId = await this.identify(target);
    const attachmentBinding = binding(this.key, target, internalId);
    await this.authorize(target);
    checkViewer(viewer, target);
    const issuedAt = this.clock();
    if (!validTime(issuedAt)) return invalid();
    const payload: Payload = { ...target, issuedAt, attachmentBinding, version: 1 };
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${encoded}.${sign(this.key, encoded)}`;
  }

  async read(ticket: string, viewer: PurchaseLifecycleAuthenticatedViewer): Promise<{ data: Buffer; contentType: string; disposition: 'attachment'; noSniff: true }> {
    if (typeof ticket !== 'string' || ticket.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)) return invalid();
    const [encoded, signature] = ticket.split('.');
    if (!equal(signature, sign(this.key, encoded))) return invalid();
    let payload: unknown;
    try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { return invalid(); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalid();
    const row = payload as Record<string, unknown>;
    const keys = ['appId', 'attachmentBinding', 'batchId', 'index', 'issuedAt', 'messageId', 'purpose', 'recipientOpenId', 'recordId', 'version'];
    if (Object.keys(row).sort().join(',') !== keys.sort().join(',') || row.version !== 1 || typeof row.attachmentBinding !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(row.attachmentBinding) ||
      typeof row.issuedAt !== 'number' || !validTime(row.issuedAt)) return invalid();
    const target = selector(row as unknown as PurchaseLifecycleAttachmentSelector);
    const now = this.clock();
    if (!validTime(now) || now < row.issuedAt || now - row.issuedAt > TTL_MS) return invalid();
    checkViewer(viewer, target);
    await this.authorize(target);
    const internalId = await this.identify(target);
    if (!equal(row.attachmentBinding, binding(this.key, target, internalId))) return invalid();
    const file = await this.download(target, internalId);
    if (!file || !Buffer.isBuffer(file.data) || !file.data.length || file.data.length > MAX_BYTES || typeof file.contentType !== 'string' || !CONTENT_TYPES.has(file.contentType)) return invalid();
    await this.authorize(target);
    checkViewer(viewer, target);
    const verifiedNow = this.clock();
    if (!validTime(verifiedNow) || verifiedNow < row.issuedAt || verifiedNow - row.issuedAt > TTL_MS ||
      !equal(row.attachmentBinding, binding(this.key, target, await this.identify(target)))) return invalid();
    return { data: file.data, contentType: file.contentType, disposition: 'attachment', noSniff: true };
  }
}
