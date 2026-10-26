import { Injectable } from '@nestjs/common';
import type { HandoverAdapter, HandoverContext, PendingDuty, TransferReceipt } from '../../../shared/personnel-handover.interface';
import { InventoryPersonnelHandoverAdapter } from '../inventory-outbound-approval/inventory-personnel-handover.adapter';
import { InventoryInboundHandoverAdapter } from './inventory-inbound-handover.adapter';

@Injectable()
export class InventoryFullPersonnelHandoverAdapter implements HandoverAdapter {
  readonly module = 'inventory' as const;
  constructor(private readonly outbound: InventoryPersonnelHandoverAdapter, private readonly inbound: InventoryInboundHandoverAdapter) {}

  async listPending(context: HandoverContext) {
    const [outbound, inbound] = await Promise.all([this.outbound.listPending(context), this.inbound.listPending(context)]);
    return [...outbound, ...inbound];
  }
  preflight(context: HandoverContext, item: PendingDuty, mutationId?: string) {
    return this.forItem(item).preflight(context, item, mutationId);
  }
  acceptTransfer(context: HandoverContext, item: PendingDuty, mutationId: string) {
    return this.forItem(item).acceptTransfer(context, item, mutationId);
  }
  reconcile(context: HandoverContext, receipt: TransferReceipt, options?: {retryFailed?:boolean}) {
    const adapter=receipt.itemKey.includes(':purchase_inbound:') ? this.inbound : this.outbound;
    return options ? adapter.reconcile(context, receipt, options) : adapter.reconcile(context, receipt);
  }
  private forItem(item: PendingDuty): HandoverAdapter { return item.stageKey === 'purchase_inbound' ? this.inbound : this.outbound; }
}
