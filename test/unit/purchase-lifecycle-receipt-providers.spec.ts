import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { HttpService } from '@nestjs/axios';
import { AccessConfigurationService } from '../../server/common/access/access-configuration.service';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { PurchaseLifecycleCardTransport } from '../../server/modules/purchase-inventory/purchase-lifecycle-card-transport';
import { PurchaseLifecycleReceiptImageRuntime } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-image-runtime';
import { PurchaseLifecycleReceiptPrepareRuntime } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-prepare-runtime';
import { PURCHASE_LIFECYCLE_RECEIPT_PROVIDERS } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt.providers';
import { PURCHASE_LIFECYCLE_RECEIPT_PREPARE_RUNTIME } from '../../server/modules/purchase-inventory/purchase-manager-approval.service';

it('resolves production receipt providers over one transport and remains inactive until composition starts it',async()=>{
  const http={axiosRef:{get:jest.fn(),post:jest.fn()}},store={bindLifecycleReceiptImageSource:jest.fn()};
  const module=await Test.createTestingModule({providers:[...PURCHASE_LIFECYCLE_RECEIPT_PROVIDERS,
    {provide:AccessConfigurationService,useValue:{}},{provide:PurchaseWorkflowStore,useValue:store},{provide:HttpService,useValue:http},
  ]}).compile();
  try{await module.init();const image=module.get(PurchaseLifecycleReceiptImageRuntime),prepare=module.get(PurchaseLifecycleReceiptPrepareRuntime),transport=module.get(PurchaseLifecycleCardTransport);
    expect(module.get(PURCHASE_LIFECYCLE_RECEIPT_PREPARE_RUNTIME)).toBe(prepare);
    expect((prepare as any).verifier).toBe(image.privateChatVerifier);expect((image as any).ingress).toBe(transport);
    expect(transport.isReady()).toBe(false);expect(image.isReady()).toBe(false);
    expect(store.bindLifecycleReceiptImageSource).not.toHaveBeenCalled();expect(http.axiosRef.post).not.toHaveBeenCalled();expect(http.axiosRef.get).not.toHaveBeenCalled();
  }finally{await module.close();}
});
