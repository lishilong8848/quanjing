import { createHash } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { projectPurchaseLifecycle } from './purchase-lifecycle-projection';
import { PurchaseLifecycleAttachmentViewService, type PurchaseLifecycleAttachmentPurpose, type PurchaseLifecycleAttachmentSelector, type PurchaseLifecycleAuthenticatedViewer } from './purchase-lifecycle-attachment-view';
import type { PurchaseWorkflowStore } from './purchase-workflow.store';
import type { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import type { PurchaseLifecycleDeliveryAuthorizer } from './purchase-lifecycle-delivery.service';

type Access = Pick<AccessConfigurationService, 'snapshot' | 'currentPrincipal'>;
type Gateway = Pick<PurchaseWorkflowGateway, 'identifyLifecycleAttachment' | 'downloadLifecycleAttachment'>;
type Store = Pick<PurchaseWorkflowStore, 'verifyLifecycleCallback' | 'getLifecycleOutbox'>;
export interface PurchaseLifecycleAttachmentRequest { batchId: string; recordId: string; messageId: string; purpose: PurchaseLifecycleAttachmentPurpose; index: number }
export type PurchaseLifecycleAttachmentCurrentRequest = Omit<PurchaseLifecycleAttachmentRequest, 'messageId'> & { generation: number };
const deny = (): never => { throw new Error('采购附件查看凭据或权限无效'); };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Requires an authenticated, current personal account; shared and impersonated sessions are rejected. */
export class PurchaseLifecycleAttachmentAccessService {
  private readonly view: PurchaseLifecycleAttachmentViewService;
  constructor(private readonly access: Access, private readonly store: Store, private readonly authorizer: PurchaseLifecycleDeliveryAuthorizer,
    gateway: Gateway, key: string, private readonly currentAppId: () => string, clock: () => number = Date.now) {
    this.view = new PurchaseLifecycleAttachmentViewService(key, { assertCanView: selector => this.authorize(selector) }, {
      identify: selector => gateway.identifyLifecycleAttachment(selector),
      download: (selector, internalId) => gateway.downloadLifecycleAttachment(selector, internalId),
    }, clock);
  }

  private viewer(principal: AccessPrincipal): PurchaseLifecycleAuthenticatedViewer {
    if (!principal || principal.impersonation || principal.requiresPasswordChange || !principal.accountId ||
      !Number.isSafeInteger(principal.authorizationVersion)) return deny();
    const accountId = principal.accountId, version = principal.authorizationVersion!, appId = this.currentAppId();
    const initial = this.access.currentPrincipal(accountId, version);
    if (!initial || initial.impersonation || initial.requiresPasswordChange || initial.accountId !== accountId) return deny();
    const principalHash = hash(initial), snapshot = this.access.snapshot();
    if (!/^cli_[A-Za-z0-9_-]+$/.test(appId) || snapshot.appId !== appId) return deny();
    const account = snapshot.accounts.filter(row => row.id === accountId && row.enabled && !row.deleted && !row.permissionsRevoked && row.personnelActive !== false && !row.reactivationRequired);
    if (account.length !== 1) return deny();
    const target = account[0];
    const feishu = target.kind === 'feishu' ? [target] : target.loginMethod === 'personnel-password' && target.siteMember && !target.external && target.personnelIdentity
      ? snapshot.accounts.filter(row => row.kind === 'feishu' && row.siteMember && !row.external && row.personnelIdentity === target.personnelIdentity && row.enabled && !row.deleted && !row.permissionsRevoked && row.personnelActive !== false && !row.reactivationRequired) : [];
    if (feishu.length !== 1 || feishu[0].appId !== appId || !/^ou_[A-Za-z0-9_-]+$/.test(feishu[0].openId || '')) return deny();
    const openId = feishu[0].openId!, revision = snapshot.revision;
    return { appId, openId, assertCurrent: () => {
      const current = this.access.currentPrincipal(accountId, version);
      if (this.currentAppId() !== appId || !current || current.impersonation || current.requiresPasswordChange || hash(current) !== principalHash || this.access.snapshot().revision !== revision) deny();
    } };
  }

  private async authorize(target: PurchaseLifecycleAttachmentSelector): Promise<void> {
    const identity = { appId: target.appId, batchId: target.batchId, recipientOpenId: target.recipientOpenId };
    const grant = await this.authorizer.prepare(identity);
    await grant.verifyLatest();
    await this.store.verifyLifecycleCallback(identity, target.messageId, (batch, replica) => {
      grant.assertCurrent();
      grant.authorizeBatch(batch, replica.appliedRevision);
      const source = grant.project(batch, replica.appliedRevision);
      const projected = projectPurchaseLifecycle(source.items, source.viewer);
      const item = projected.find(row => row.recordId === target.recordId);
      const stage = target.purpose === 'comparison' ? 'application' : target.purpose === 'payment' ? 'ordering' : 'receipt';
      if (!item || !item.stages.some(row => row.stage === stage)) deny();
    });
  }

  async issue(principal: AccessPrincipal, request: PurchaseLifecycleAttachmentRequest): Promise<string> {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).sort().join(',') !== 'batchId,index,messageId,purpose,recordId') return deny();
    const viewer = this.viewer(principal);
    return this.view.issue({ ...request, appId: viewer.appId, recipientOpenId: viewer.openId }, viewer);
  }

  /** Resolve identity and current message server-side; URL generation must match the actual card. */
  async issueCurrent(principal: AccessPrincipal, request: PurchaseLifecycleAttachmentCurrentRequest): Promise<string> {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.keys(request).sort().join(',') !== 'batchId,generation,index,purpose,recordId' ||
      !Number.isSafeInteger(request.generation) || request.generation < 1) return deny();
    const viewer = this.viewer(principal);
    const entry = await this.store.getLifecycleOutbox({ appId: viewer.appId, batchId: request.batchId, recipientOpenId: viewer.openId });
    if (!entry || entry.replica.state !== 'delivered' || entry.replica.generation !== request.generation || !entry.replica.messageId) return deny();
    viewer.assertCurrent();
    return this.view.issue({ batchId: request.batchId, recordId: request.recordId, purpose: request.purpose, index: request.index,
      messageId: entry.replica.messageId, appId: viewer.appId, recipientOpenId: viewer.openId }, viewer);
  }

  async read(principal: AccessPrincipal, ticket: string): Promise<{ data: Buffer; contentType: string; disposition: 'attachment'; noSniff: true }> {
    return this.view.read(ticket, this.viewer(principal));
  }
}
