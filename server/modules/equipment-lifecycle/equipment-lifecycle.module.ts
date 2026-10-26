import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { EquipmentLifecycleController } from './equipment-lifecycle.controller';
import { EquipmentLifecycleService } from './equipment-lifecycle.service';
import { EquipmentLedgerService } from './equipment-ledger.service';
import { EquipmentLedgerController } from './equipment-ledger.controller';
import { EquipmentHistoryService } from './equipment-history.service';
import { EquipmentRepairSourceService } from './equipment-repair-source.service';

@Module({
  imports: [HttpModule.register({ timeout: 60_000, maxRedirects: 5 })],
  controllers: [EquipmentLifecycleController, EquipmentLedgerController],
  providers: [
    EquipmentLifecycleService,
    EquipmentLedgerService,
    EquipmentRepairSourceService,
    EquipmentHistoryService,
  ],
  exports: [EquipmentLifecycleService],
})
export class EquipmentLifecycleModule {}
