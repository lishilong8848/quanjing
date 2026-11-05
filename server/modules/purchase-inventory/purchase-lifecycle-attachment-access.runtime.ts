import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { readEnv } from '../../common/config/external-services.config';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import { PurchaseWorkflowStore } from './purchase-workflow.store';
import { PurchaseLifecycleGatewayRecordSource } from './purchase-lifecycle-gateway-record-source';
import { PurchaseLifecycleServerAuthorizer } from './purchase-lifecycle-delivery-authorizer';
import { PurchaseLifecycleAttachmentAccessService, type PurchaseLifecycleAttachmentRequest, type PurchaseLifecycleAttachmentCurrentRequest } from './purchase-lifecycle-attachment-access.service';
import { lifecyclePaymentUploadSourceFingerprint } from './purchase-lifecycle-payment-upload-gateway';

/** Lazy construction leaves existing functionality unaffected when the new feature is unconfigured. */
@Injectable()
export class PurchaseLifecycleAttachmentAccessRuntime {
  constructor(private readonly access: AccessConfigurationService, private readonly store: PurchaseWorkflowStore, private readonly gateway: PurchaseWorkflowGateway) {}

  private service(): PurchaseLifecycleAttachmentAccessService {
    const sourceKey = readEnv('FEISHU_PURCHASE_CARD_ATTACHMENT_SECRET', ['FEISHU_APP_SECRET']);
    if (Buffer.byteLength(sourceKey, 'utf8') < 16) throw new ServiceUnavailableException('采购附件查看暂不可用');
    const key = createHmac('sha256', sourceKey).update('purchase-lifecycle-attachment-view-v1').digest('hex');
    const appId = () => readEnv('FEISHU_APP_ID');
    const source = new PurchaseLifecycleGatewayRecordSource(this.store, this.gateway, appId, Date.now,
      () => this.store.verifyLifecycleReceiptImageSource(appId(), lifecyclePaymentUploadSourceFingerprint()));
    const authorizer = new PurchaseLifecycleServerAuthorizer(this.access, source);
    return new PurchaseLifecycleAttachmentAccessService(this.access, this.store, authorizer, this.gateway, key, appId);
  }

  issue(principal: AccessPrincipal, request: PurchaseLifecycleAttachmentRequest): Promise<string> { return this.service().issue(principal, request); }
  issueCurrent(principal: AccessPrincipal, request: PurchaseLifecycleAttachmentCurrentRequest): Promise<string> { return this.service().issueCurrent(principal, request); }
  read(principal: AccessPrincipal, ticket: string) { return this.service().read(principal, ticket); }
}
