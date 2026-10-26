import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type {
  InventoryOutboundApprovalDecision,
  InventoryOutboundApprovalSnapshot,
} from './inventory-outbound-approval.types';

export interface InventoryOutboundApprovalBusinessFinalizer {
  recoverUnregisteredOutbound(recordId: string): Promise<void>;

  finalizeApprovedOutbound(
    snapshot: InventoryOutboundApprovalSnapshot,
    decision: InventoryOutboundApprovalDecision,
  ): Promise<unknown>;
}

@Injectable()
export class InventoryOutboundApprovalFinalizerRegistry {
  private delegate?: InventoryOutboundApprovalBusinessFinalizer;

  register(delegate: InventoryOutboundApprovalBusinessFinalizer): void {
    this.delegate = delegate;
  }

  async recoverUnregisteredOutbound(recordId: string): Promise<void> {
    if (!this.delegate) {
      throw new ServiceUnavailableException(
        '出库申请恢复服务尚未就绪，请稍后重试',
      );
    }
    await this.delegate.recoverUnregisteredOutbound(recordId);
  }

  async finalizeApprovedOutbound(
    snapshot: InventoryOutboundApprovalSnapshot,
    decision: InventoryOutboundApprovalDecision,
  ): Promise<void> {
    if (!this.delegate) {
      throw new ServiceUnavailableException(
        '出库正式确认服务尚未就绪，请稍后重试',
      );
    }
    await this.delegate.finalizeApprovedOutbound(snapshot, decision);
  }
}
