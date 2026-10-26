import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { dirname, join, resolve } from 'node:path';
import { InventoryOutboundApprovalGateway } from './inventory-outbound-approval.gateway';
import { InventoryOutboundApprovalFinalizerRegistry } from './inventory-outbound-approval.finalizer';
import { InventoryOutboundApprovalScheduler } from './inventory-outbound-approval.scheduler';
import { InventoryOutboundApprovalService } from './inventory-outbound-approval.service';
import {
  INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH,
  InventoryOutboundApprovalStore,
} from './inventory-outbound-approval.store';
import { InventoryWarehouseRoleDirectory } from './inventory-warehouse-role-directory';
import { InventoryPersonnelHandoverAdapter } from './inventory-personnel-handover.adapter';
import { INVENTORY_BATCH_CARD_LEDGER_PATH, InventoryBatchCardService } from './inventory-batch-card.service';

const INVENTORY_OUTBOUND_APPROVAL_LEDGER_FILE_NAME =
  'inventory-outbound-approval-ledger.json';
const PRODUCTION_SHARED_STATE_DIRECTORY = 'nantong-schedule-state';

export interface InventoryOutboundApprovalLedgerPathOptions {
  configuredPath?: string;
  cwd?: string;
  nodeEnv?: string;
}

export function resolveInventoryOutboundApprovalLedgerPath(
  options: InventoryOutboundApprovalLedgerPathOptions = {},
): string {
  const cwd = resolve(options.cwd || process.cwd());
  const configuredPath =
    options.configuredPath?.trim() ||
    process.env.INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH?.trim();
  if (configuredPath) {
    return resolve(cwd, configuredPath);
  }

  const nodeEnv = options.nodeEnv || process.env.NODE_ENV;
  const stateDirectory =
    nodeEnv === 'production'
      ? join(dirname(cwd), PRODUCTION_SHARED_STATE_DIRECTORY)
      : join(cwd, '.runtime');
  return join(stateDirectory, INVENTORY_OUTBOUND_APPROVAL_LEDGER_FILE_NAME);
}

const inventoryOutboundApprovalLedgerPathProvider = {
  provide: INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH,
  useFactory: () => resolveInventoryOutboundApprovalLedgerPath(),
};
const inventoryBatchCardLedgerPathProvider = {
  provide: INVENTORY_BATCH_CARD_LEDGER_PATH,
  useFactory: () => join(dirname(resolveInventoryOutboundApprovalLedgerPath()), 'inventory-batch-cards.json'),
};

@Module({
  imports: [HttpModule],
  providers: [
    inventoryOutboundApprovalLedgerPathProvider,
    InventoryOutboundApprovalStore,
    inventoryBatchCardLedgerPathProvider,
    InventoryBatchCardService,
    InventoryOutboundApprovalGateway,
    InventoryOutboundApprovalFinalizerRegistry,
    InventoryWarehouseRoleDirectory,
    InventoryOutboundApprovalService,
    InventoryPersonnelHandoverAdapter,
    InventoryOutboundApprovalScheduler,
  ],
  exports: [
    InventoryPersonnelHandoverAdapter,
    InventoryOutboundApprovalService,
    InventoryOutboundApprovalStore,
    InventoryBatchCardService,
    InventoryWarehouseRoleDirectory,
    InventoryOutboundApprovalGateway,
    InventoryOutboundApprovalFinalizerRegistry,
  ],
})
export class InventoryOutboundApprovalModule {}
