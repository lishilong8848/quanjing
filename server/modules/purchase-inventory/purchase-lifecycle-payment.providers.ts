import type { Provider } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { readEnv } from '../../common/config/external-services.config';
import { PurchaseWorkflowStore } from './purchase-workflow.store';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import { PurchaseLifecycleGatewayRecordSource } from './purchase-lifecycle-gateway-record-source';
import { PurchaseLifecycleServerAuthorizer } from './purchase-lifecycle-delivery-authorizer';
import { LifecyclePaymentUploadStoreAdapter } from './purchase-lifecycle-payment-upload-store-adapter';
import { LifecyclePaymentPerFileStoreAdapter } from './purchase-lifecycle-payment-per-file-store-adapter';
import { LifecyclePaymentPerFileGatewayAdapter,lifecyclePaymentUploadSourceFingerprint } from './purchase-lifecycle-payment-upload-gateway';
import {
  LIFECYCLE_PAYMENT_PER_FILE_STORE, LIFECYCLE_PAYMENT_UPLOAD_GATEWAY, LIFECYCLE_PAYMENT_UPLOAD_READINESS, LIFECYCLE_PAYMENT_UPLOAD_STORE,
  LifecyclePaymentUploadIsolatedController, LifecyclePaymentUploadIsolatedService, LifecyclePaymentUploadSessionAccess, LifecyclePaymentUploadSessionGuard,
} from './purchase-lifecycle-payment-upload-isolated';

/** Supplied by the single lifecycle runtime owner. No environment flag alone
 * enables uploads, and absence must not prevent the application from booting. */
export const PURCHASE_LIFECYCLE_PROCESSING_PORT = Symbol('PURCHASE_LIFECYCLE_PROCESSING_PORT');
export interface PurchaseLifecycleProcessingPort { isProcessing(): boolean }
export const PURCHASE_LIFECYCLE_PAYMENT_RECORD_SOURCE = Symbol('PURCHASE_LIFECYCLE_PAYMENT_RECORD_SOURCE');
export const PURCHASE_LIFECYCLE_PAYMENT_AUTHORIZER = Symbol('PURCHASE_LIFECYCLE_PAYMENT_AUTHORIZER');
const currentAppId = () => readEnv('FEISHU_APP_ID');

/** Construction only. None of these factories reads remote data or starts a worker. */
export const PURCHASE_LIFECYCLE_PAYMENT_PROVIDERS: Provider[] = [
  { provide: PURCHASE_LIFECYCLE_PAYMENT_RECORD_SOURCE, inject: [PurchaseWorkflowStore, PurchaseWorkflowGateway],
    useFactory: (store: PurchaseWorkflowStore, gateway: PurchaseWorkflowGateway) => new PurchaseLifecycleGatewayRecordSource(store, gateway, currentAppId,Date.now,()=>store.verifyLifecycleReceiptImageSource(currentAppId(),lifecyclePaymentUploadSourceFingerprint()),lifecyclePaymentUploadSourceFingerprint) },
  { provide: PURCHASE_LIFECYCLE_PAYMENT_AUTHORIZER, inject: [AccessConfigurationService, PURCHASE_LIFECYCLE_PAYMENT_RECORD_SOURCE],
    useFactory: (access: AccessConfigurationService, source: PurchaseLifecycleGatewayRecordSource) => new PurchaseLifecycleServerAuthorizer(access, source, () => ({ ...process.env, FEISHU_APP_ID: currentAppId() }), currentAppId) },
  { provide: LIFECYCLE_PAYMENT_UPLOAD_STORE, inject: [PurchaseWorkflowStore, PURCHASE_LIFECYCLE_PAYMENT_AUTHORIZER, PurchaseWorkflowGateway],
    useFactory: (store: PurchaseWorkflowStore, authority: PurchaseLifecycleServerAuthorizer, gateway: PurchaseWorkflowGateway) => new LifecyclePaymentUploadStoreAdapter(store, authority, gateway) },
  { provide: LIFECYCLE_PAYMENT_PER_FILE_STORE, inject: [PurchaseWorkflowStore, PURCHASE_LIFECYCLE_PAYMENT_AUTHORIZER, PurchaseWorkflowGateway],
    useFactory: (store: PurchaseWorkflowStore, authority: PurchaseLifecycleServerAuthorizer, gateway: PurchaseWorkflowGateway) => new LifecyclePaymentPerFileStoreAdapter(store, authority, gateway) },
  { provide: LIFECYCLE_PAYMENT_UPLOAD_GATEWAY, inject: [HttpService,PurchaseWorkflowStore], useFactory: (http: HttpService,store:PurchaseWorkflowStore) => new LifecyclePaymentPerFileGatewayAdapter(http,undefined,undefined,(appId,fingerprint)=>store.verifyLifecycleReceiptImageSource(appId,fingerprint)) },
  { provide: LIFECYCLE_PAYMENT_UPLOAD_READINESS, inject: [{ token: PURCHASE_LIFECYCLE_PROCESSING_PORT, optional: true }],
    useFactory: (processing?: PurchaseLifecycleProcessingPort) => ({ isReady(): boolean {
      try {
        const result: unknown = processing?.isProcessing();
        if (result instanceof Promise) void result.catch(() => undefined);
        return result === true;
      } catch { return false; }
    } }) },
  LifecyclePaymentUploadSessionAccess, LifecyclePaymentUploadIsolatedService, LifecyclePaymentUploadSessionGuard,
];
export const PURCHASE_LIFECYCLE_PAYMENT_CONTROLLERS = [LifecyclePaymentUploadIsolatedController];
