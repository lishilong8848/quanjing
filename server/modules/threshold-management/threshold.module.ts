import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import type { ThresholdRecord } from '../../../shared/threshold-management.interface';
import seed from '../../../shared/electrical-thresholds.seed.json';
import hvac from '../../../shared/hvac-thresholds.seed.json';
import { ThresholdController } from './threshold.controller';
import { ThresholdStore } from './threshold.store';
import { ThresholdBitableGateway } from './threshold-bitable.gateway';
import { ThresholdSyncService } from './threshold-sync.service';
import { InventoryOutboundApprovalModule } from '../inventory-outbound-approval/inventory-outbound-approval.module';
import { ThresholdAdjustmentGateway } from './threshold-adjustment.gateway';
import { ThresholdAdjustmentService } from './threshold-adjustment.service';

@Module({
  imports: [HttpModule, InventoryOutboundApprovalModule],
  controllers: [ThresholdController],
  providers: [
    ThresholdBitableGateway,
    ThresholdSyncService,
    ThresholdAdjustmentGateway,
    ThresholdAdjustmentService,
    {
      provide: ThresholdStore,
      useFactory: () =>
        new ThresholdStore(
          process.env.THRESHOLD_LEDGER_PATH ||
            '.runtime/threshold-management/records.json',
          seed.records as ThresholdRecord[],
          [
            {
              key: 'hvac-initial-v1',
              records: hvac.records as ThresholdRecord[],
            },
          ],
          true,
        ),
    },
  ],
  exports: [ThresholdAdjustmentService],
})
export class ThresholdModule {}
