import { BadRequestException, Body, CanActivate, Controller, ExecutionContext, ForbiddenException, Inject, Injectable, Optional, Post, Req, Res, ServiceUnavailableException, SetMetadata, UnauthorizedException, UploadedFiles, UseGuards, UseInterceptors } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { PublicAccess } from '../../common/access/unified-access.decorators';
import { UnifiedAccessService } from '../../common/access/unified-access.service';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { readAccessCookie, readStrictCookie } from '../../common/access/unified-access.guard';
import { readEnv } from '../../common/config/external-services.config';
import type { LifecyclePaymentUploadDecision, LifecyclePaymentUploadEntry, LifecyclePaymentUploadRequest } from './purchase-lifecycle-payment-upload';
import type { LifecyclePaymentUploadPublicStatus } from './purchase-workflow.store';
import { LifecyclePaymentPerFileOrchestrator, type LifecyclePaymentPerFileStorePort, type LifecyclePaymentPerFileGatewayPort } from './purchase-lifecycle-payment-upload-per-file';
import { lifecyclePaymentUploadSourceFingerprint } from './purchase-lifecycle-payment-upload-gateway';

export const LIFECYCLE_PAYMENT_PER_FILE_STORE = Symbol('LIFECYCLE_PAYMENT_PER_FILE_STORE');
export const LIFECYCLE_PAYMENT_UPLOAD_STORE = Symbol('LIFECYCLE_PAYMENT_UPLOAD_STORE');
export const LIFECYCLE_PAYMENT_UPLOAD_GATEWAY = Symbol('LIFECYCLE_PAYMENT_UPLOAD_GATEWAY');
export const LIFECYCLE_PAYMENT_UPLOAD_READINESS = Symbol('LIFECYCLE_PAYMENT_UPLOAD_READINESS');
const LIFECYCLE_PAYMENT_RECOVERY_HANDLER = Symbol('LIFECYCLE_PAYMENT_RECOVERY_HANDLER');
export interface LifecyclePaymentUploadSelector { approvalBatchId: string; executionRecordId: string; generation: number }
export interface LifecyclePaymentUploadIdentity { accountId: string; authorizationVersion: number; appId: string; openId: string; kind: 'feishu' | 'personnel-password'; origin: string; uploadSourceFingerprint?: string; assertCurrent(): void }
export interface LifecyclePaymentUploadReceivedFile { originalname: string; mimetype: string; size: number; buffer: Buffer }

/** Every mutating method must use the SAME PurchaseWorkflowStore ledger lock and fail closed. */
export interface LifecyclePaymentUploadStorePort {
  reserve(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest): Promise<LifecyclePaymentUploadDecision>;
  begin(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest, entry: LifecyclePaymentUploadEntry, attemptId: string): Promise<LifecyclePaymentUploadEntry>;
  recordConfirmed(entry: LifecyclePaymentUploadEntry, attemptId: string, tokens: string[]): Promise<LifecyclePaymentUploadEntry>;
  markUncertain(entry: LifecyclePaymentUploadEntry, attemptId: string): Promise<void>;
  /** Rechecks session, duties, scope and state inside the lock, then atomically merges and queues refresh. */
  commit(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, request: LifecyclePaymentUploadRequest, entry: LifecyclePaymentUploadEntry): Promise<void>;
  status(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, requestId: string): Promise<{ state: LifecyclePaymentUploadPublicStatus }>;
  cancel(identity: LifecyclePaymentUploadIdentity, selector: LifecyclePaymentUploadSelector, requestId: string): Promise<{ state: 'cancelled' }>;
}
/** No implementation is provided or registered here; unknown remote outcomes must throw. */
export interface LifecyclePaymentUploadGatewayPort { upload(files: readonly LifecyclePaymentUploadReceivedFile[], attemptId: string): Promise<string[]> }
interface PaymentRequest extends Request { lifecyclePaymentIdentity?: LifecyclePaymentUploadIdentity }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const csrf = /^(?:[A-Za-z0-9_-]{43}|[a-f0-9]{40}-\d{10})$/u;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const deny = (): never => { throw new UnauthorizedException('请使用本人有效账号从本站访问'); };
function validSelectorAndId(selector: LifecyclePaymentUploadSelector, requestId: string): boolean {
  return !!selector && typeof selector === 'object' && Object.keys(selector).sort().join(',') === 'approvalBatchId,executionRecordId,generation' &&
    typeof selector.approvalBatchId === 'string' && /^[A-Za-z0-9_-]{8,160}$/u.test(selector.approvalBatchId) && typeof selector.executionRecordId === 'string' && /^[A-Za-z0-9_-]{1,100}$/u.test(selector.executionRecordId) &&
    Number.isSafeInteger(selector.generation) && selector.generation > 0 && typeof requestId === 'string' && UUID.test(requestId);
}

/** Resolves the real session and its unique Feishu identity, rather than trusting selector or ticket fields. */
@Injectable()
export class LifecyclePaymentUploadSessionAccess {
  constructor(private readonly sessions: UnifiedAccessService, private readonly configuration: AccessConfigurationService) {}

  resolve(request: Request): LifecyclePaymentUploadIdentity {
    const configured = readEnv('PUBLIC_BASE_URL', ['FEISHU_PUBLIC_BASE_URL', 'APP_PUBLIC_URL']);
    let expected: string;
    try {
      const parsed = new URL(configured);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error();
      expected = parsed.origin;
    } catch { throw new ForbiddenException('本站访问地址未配置'); }
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || origin !== expected || (request.headers['sec-fetch-site'] !== undefined && request.headers['sec-fetch-site'] !== 'same-origin')) throw new ForbiddenException('请从本站页面提交');
    const rawCookie = request.headers.cookie;
    if (typeof rawCookie !== 'string') return deny();
    const primary = readStrictCookie(rawCookie, '__Host-suda-csrf-token');
    const cookie = primary.present ? primary : readStrictCookie(rawCookie, 'suda-csrf-token');
    const header = request.headers['x-suda-csrf-token'];
    if (typeof header !== 'string' || !cookie.value || !csrf.test(header) || !csrf.test(cookie.value)) throw new ForbiddenException('请求校验失败');
    const h = Buffer.from(header), c = Buffer.from(cookie.value);
    if (h.length !== c.length || !timingSafeEqual(h, c)) throw new ForbiddenException('请求校验失败');
    const sessionCookie = readAccessCookie(rawCookie, this.sessions, Date.now());
    if (sessionCookie.diagnostic || !sessionCookie.value) return deny();
    const token = sessionCookie.value;
    const session = this.sessions.readSessionIdentity(token);
    const principal = session.principal;
    if (!session.expiresAt || !session.principalFingerprint || !principal.accountId || !Number.isSafeInteger(principal.authorizationVersion) || principal.impersonation || principal.requiresPasswordChange) return deny();
    const accountId = principal.accountId, version = principal.authorizationVersion!, appId = readEnv('FEISHU_APP_ID');
    const current = this.configuration.currentPrincipal(accountId, version), snapshot = this.configuration.snapshot();
    if (!current || current.impersonation || current.requiresPasswordChange || current.accountId !== accountId || !/^cli_[A-Za-z0-9_-]{1,124}$/u.test(appId) || snapshot.appId !== appId) return deny();
    const candidates = snapshot.accounts.filter(row => row.id === accountId && row.enabled && !row.deleted && !row.permissionsRevoked && row.personnelActive !== false && !row.reactivationRequired);
    if (candidates.length !== 1) return deny();
    const account = candidates[0]!;
    const linked = account.kind === 'feishu' ? [account] : account.loginMethod === 'personnel-password' && account.siteMember && !account.external && account.personnelIdentity
      ? snapshot.accounts.filter(row => row.kind === 'feishu' && row.siteMember && !row.external && row.personnelIdentity === account.personnelIdentity && row.enabled && !row.deleted && !row.permissionsRevoked && row.personnelActive !== false && !row.reactivationRequired) : [];
    if (linked.length !== 1 || linked[0]!.appId !== appId || !/^ou_[A-Za-z0-9_-]{1,128}$/u.test(linked[0]!.openId || '')) return deny();
    const openId = linked[0]!.openId!, revision = snapshot.revision, initialPrincipal = digest(current), fingerprint = session.principalFingerprint;
    const kind = account.kind === 'feishu' ? 'feishu' as const : 'personnel-password' as const;
    const uploadSourceFingerprint = lifecyclePaymentUploadSourceFingerprint();
    return Object.freeze({ accountId, authorizationVersion: version, appId, openId, kind, origin, uploadSourceFingerprint, assertCurrent: () => {
      const nextSession = this.sessions.readSessionIdentity(token), next = this.configuration.currentPrincipal(accountId, version), nextSnapshot = this.configuration.snapshot();
      if (!nextSession.expiresAt || nextSession.principalFingerprint !== fingerprint || nextSession.principal.accountId !== accountId || nextSession.principal.impersonation || nextSession.principal.requiresPasswordChange ||
        !next || next.impersonation || next.requiresPasswordChange || digest(next) !== initialPrincipal || nextSnapshot.revision !== revision || nextSnapshot.appId !== appId || readEnv('FEISHU_APP_ID') !== appId || lifecyclePaymentUploadSourceFingerprint() !== uploadSourceFingerprint) return deny();
    } });
  }
}

@Injectable()
export class LifecyclePaymentUploadIsolatedService {
  constructor(
    @Optional() @Inject(LIFECYCLE_PAYMENT_UPLOAD_STORE) private readonly store?: LifecyclePaymentUploadStorePort,
    @Optional() @Inject(LIFECYCLE_PAYMENT_UPLOAD_GATEWAY) private readonly gateway?: LifecyclePaymentPerFileGatewayPort,
    @Optional() @Inject(LIFECYCLE_PAYMENT_UPLOAD_READINESS) private readonly readiness?: { isReady(): boolean },
    @Optional() @Inject(LIFECYCLE_PAYMENT_PER_FILE_STORE) private readonly perFileStore?: LifecyclePaymentPerFileStorePort,
  ) {}

  assertAvailable(): void {
    let ready: unknown;
    try { ready = this.readiness?.isReady(); if (ready instanceof Promise) void ready.catch(() => undefined); } catch { /* fail closed */ }
    if (ready !== true || !this.store || !this.gateway ||
      ['status', 'cancel'].some(key => typeof (this.store as unknown as Record<string, unknown>)[key] !== 'function') || !this.perFileStore ||
      ['reserve', 'beginFile', 'confirmFile', 'markFileUncertain', 'commit'].some(key => typeof (this.perFileStore as unknown as Record<string, unknown>)[key] !== 'function') || typeof this.gateway.uploadOne !== 'function') throw new ServiceUnavailableException('付款附件上传尚未接入');
  }

  /** Recovery remains available while admission of new uploads is disabled.
   * The store still verifies ownership, app, card generation and current session. */
  assertRecoveryAvailable(): void {
    if (!this.store || typeof this.store.status !== 'function' || typeof this.store.cancel !== 'function') throw new ServiceUnavailableException('付款附件恢复记录尚未接入');
  }

  async upload(identity: LifecyclePaymentUploadIdentity | undefined, selector: LifecyclePaymentUploadSelector, requestId: string, files: readonly LifecyclePaymentUploadReceivedFile[]): Promise<{ state: 'completed' | 'manual_reconciliation' }> {
    this.assertAvailable();
    if (!identity || typeof identity.assertCurrent !== 'function') return deny();
    if (!validSelectorAndId(selector, requestId)) throw new BadRequestException('付款附件请求无效');
    // Every file has its own durable send fence and confirmed receipt. Do not
    // fall back to the former all-files upload, even when only one file exists.
    return new LifecyclePaymentPerFileOrchestrator(this.perFileStore, this.gateway).upload(identity, selector, requestId, files);
  }

  async status(identity: LifecyclePaymentUploadIdentity | undefined, selector: LifecyclePaymentUploadSelector, requestId: string): Promise<{ state: LifecyclePaymentUploadPublicStatus }> {
    this.assertRecoveryAvailable();
    if (!identity || typeof identity.assertCurrent !== 'function') return deny();
    identity.assertCurrent();
    if (!validSelectorAndId(selector, requestId)) throw new BadRequestException('付款附件请求无效');
    return this.store!.status(identity, selector, requestId);
  }

  async cancel(identity: LifecyclePaymentUploadIdentity | undefined, selector: LifecyclePaymentUploadSelector, requestId: string): Promise<{ state: 'cancelled' }> {
    this.assertRecoveryAvailable();
    if (!identity || typeof identity.assertCurrent !== 'function') return deny();
    identity.assertCurrent();
    if (!validSelectorAndId(selector, requestId)) throw new BadRequestException('付款附件请求无效');
    return this.store!.cancel(identity, selector, requestId);
  }
}

/** This guard runs before multipart buffering. */
@Injectable()
export class LifecyclePaymentUploadSessionGuard implements CanActivate {
  constructor(private readonly access: LifecyclePaymentUploadSessionAccess, private readonly service: LifecyclePaymentUploadIsolatedService) {}
  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler?.();
    // Trust only metadata on the server-selected controller method. A caller's
    // URL, body, headers or query cannot opt an upload into recovery admission.
    if (typeof handler === 'function' && Reflect.getMetadata(LIFECYCLE_PAYMENT_RECOVERY_HANDLER, handler) === true) this.service.assertRecoveryAvailable();
    else this.service.assertAvailable();
    const request = context.switchToHttp().getRequest<PaymentRequest>();
    request.lifecyclePaymentIdentity = this.access.resolve(request);
    return true;
  }
}

/** Deliberately not registered in the application module. */
@Controller('api/purchase-inventory/lifecycle/payment-attachments')
@PublicAccess()
@UseGuards(LifecyclePaymentUploadSessionGuard)
export class LifecyclePaymentUploadIsolatedController {
  constructor(private readonly service: LifecyclePaymentUploadIsolatedService) {}
  @Post()
  @UseInterceptors(FilesInterceptor('files', 5, { limits: { fileSize: 20 * 1024 * 1024, files: 5 } }))
  upload(@Req() request: PaymentRequest, @Body() body: Record<string, unknown>, @UploadedFiles() files: LifecyclePaymentUploadReceivedFile[], @Res({ passthrough: true }) response?: Response) {
    response?.setHeader('Cache-Control', 'no-store');
    response?.setHeader('Referrer-Policy', 'no-referrer');
    if (!body || Object.keys(body).sort().join(',') !== 'approvalBatchId,executionRecordId,generation,requestId' || typeof body.generation !== 'string' || !/^[1-9]\d{0,14}$/u.test(body.generation)) throw new BadRequestException('付款附件请求无效');
    return this.service.upload(request.lifecyclePaymentIdentity, { approvalBatchId: String(body.approvalBatchId), executionRecordId: String(body.executionRecordId), generation: Number(body.generation) }, String(body.requestId), files);
  }

  @Post('status')
  @SetMetadata(LIFECYCLE_PAYMENT_RECOVERY_HANDLER, true)
  status(@Req() request: PaymentRequest, @Body() body: Record<string, unknown>, @Res({ passthrough: true }) response?: Response) {
    response?.setHeader('Cache-Control', 'no-store'); response?.setHeader('Referrer-Policy', 'no-referrer');
    const { selector, requestId } = this.jsonIdentity(body);
    return this.service.status(request.lifecyclePaymentIdentity, selector, requestId);
  }

  @Post('cancel')
  @SetMetadata(LIFECYCLE_PAYMENT_RECOVERY_HANDLER, true)
  cancel(@Req() request: PaymentRequest, @Body() body: Record<string, unknown>, @Res({ passthrough: true }) response?: Response) {
    response?.setHeader('Cache-Control', 'no-store'); response?.setHeader('Referrer-Policy', 'no-referrer');
    const { selector, requestId } = this.jsonIdentity(body);
    return this.service.cancel(request.lifecyclePaymentIdentity, selector, requestId);
  }

  private jsonIdentity(body: Record<string, unknown>): { selector: LifecyclePaymentUploadSelector; requestId: string } {
    if (!body || Object.keys(body).sort().join(',') !== 'approvalBatchId,executionRecordId,generation,requestId' || typeof body.approvalBatchId !== 'string' || typeof body.executionRecordId !== 'string' || typeof body.generation !== 'number' || typeof body.requestId !== 'string') throw new BadRequestException('付款附件请求无效');
    return { selector: { approvalBatchId: body.approvalBatchId, executionRecordId: body.executionRecordId, generation: body.generation }, requestId: body.requestId };
  }
}
