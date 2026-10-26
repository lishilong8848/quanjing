import { HttpModule } from '@nestjs/axios';
import { Module } from '@nestjs/common';
import { ContractManagementController } from './contract-management.controller';
import { ContractManagementService } from './contract-management.service';
import { ContractAttachmentStorageService } from './contract-attachment-storage.service';
import { ContractExpiryDispositionGateway } from './contract-expiry-disposition.gateway';
import { ContractExpiryDispositionService } from './contract-expiry-disposition.service';
import { ContractWorkflowGateway } from './contract-workflow.gateway';
import { ContractWorkflowScheduler } from './contract-workflow.scheduler';
import { ContractWorkflowService } from './contract-workflow.service';
import { ContractWorkflowStore } from './contract-workflow.store';
import { ContractCreationGateway } from './contract-creation.gateway';
import { ContractCreationService } from './contract-creation.service';
import { ContractPaymentFollowUpService } from './contract-payment-follow-up.service';
import { ContractEditService } from './contract-edit.service';
import { ContractPersonnelHandoverAdapter } from './contract-personnel-handover.adapter';
import { PERSONNEL_PREVIEW_READERS } from '../../common/access/personnel-preview.ports';

@Module({
  imports: [HttpModule.register({ timeout: 60_000, maxRedirects: 5 })],
  controllers: [ContractManagementController],
  providers: [
    ContractManagementService,
    ContractAttachmentStorageService,
    ContractExpiryDispositionGateway,
    ContractExpiryDispositionService,
    ContractWorkflowGateway,
    ContractWorkflowScheduler,
    ContractWorkflowService,
    ContractWorkflowStore,
    ContractCreationGateway,
    ContractCreationService,
    ContractPaymentFollowUpService,
    ContractEditService,
    ContractPersonnelHandoverAdapter,
    { provide: PERSONNEL_PREVIEW_READERS.contracts, useExisting: ContractPersonnelHandoverAdapter },
  ],
})
export class ContractManagementModule {}
