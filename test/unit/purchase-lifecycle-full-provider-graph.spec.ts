import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { PurchaseInventoryModule } from '../../server/modules/purchase-inventory/purchase-inventory.module';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { PurchaseLifecycleComposition } from '../../server/modules/purchase-inventory/purchase-lifecycle-composition';
import { PurchaseLifecycleCardTransport } from '../../server/modules/purchase-inventory/purchase-lifecycle-card-transport';
import { PurchaseLifecycleReceiptImageRuntime } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-image-runtime';
import { FEISHU_CARD_ACTION_TRANSPORT } from '../../server/modules/overtime-workflow/overtime-workflow.card-action.consumer';
jest.mock('../../server/common/config/external-services.config',()=>({...jest.requireActual('../../server/common/config/external-services.config'),readEnv:(key:string)=>({FEISHU_APP_ID:'cli_graph',FEISHU_PURCHASE_INVENTORY_APP_TOKEN:'base_graph',FEISHU_PURCHASE_EXECUTION_TABLE_ID:'tbl_graph'}[key]||'')}));
it('resolves every actual purchase provider without hidden lifecycle mocks or starting external services',async()=>{
  const refuse=jest.fn(()=>{throw Error('network forbidden');});
  const external=new Set(['OvertimeWorkflowService','LeaveWorkflowService','TodayOperationsAnomalyService','InventoryOutboundApprovalService','ThresholdAdjustmentService','TodayOperationsFollowUpCardService','FeishuCardReadonlyCopyService']);
  const builder=Test.createTestingModule({providers:[...Reflect.getMetadata('providers',PurchaseInventoryModule),{provide:HttpService,useValue:{axiosRef:{get:refuse,post:refuse,put:refuse}}},{provide:AccessConfigurationService,useValue:{}},{provide:UnifiedAccessService,useValue:{}}],controllers:Reflect.getMetadata('controllers',PurchaseInventoryModule)}).useMocker(token=>{
    if(typeof token==='function'&&external.has(token.name))return {};
    throw Error(`Unexpected missing production dependency: ${typeof token==='function'?token.name:String(token)}`);
  });
  const compiled=await builder.compile();
  expect(compiled.get(PurchaseLifecycleComposition)).toBeInstanceOf(PurchaseLifecycleComposition);
  expect(compiled.get(FEISHU_CARD_ACTION_TRANSPORT)).toBe(compiled.get(PurchaseLifecycleCardTransport));
  expect(compiled.get(PurchaseLifecycleReceiptImageRuntime).isReady()).toBe(false);
  expect(refuse).not.toHaveBeenCalled();
  // compile only: do not invoke unrelated legacy startup/shutdown filesystem hooks.
});
