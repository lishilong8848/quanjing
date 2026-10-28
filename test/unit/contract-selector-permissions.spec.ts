import { ForbiddenException } from '@nestjs/common';
import { ContractEditService } from '../../server/modules/contract-management/contract-edit.service';
import { ContractPaymentFollowUpService } from '../../server/modules/contract-management/contract-payment-follow-up.service';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { BusinessAction } from '../../shared/business-permissions';
import type { BitableRecordItem } from '../../server/common/feishu/bitable-direct-read';

const principal=(actions:BusinessAction[],building:'A楼'|'B楼'='A楼'):AccessPrincipal=>({role:'guest',purchaseBuilding:null,accountId:'synthetic-selector',authorizationVersion:1,
  permissionContext:{module:'contracts',action:'read'},effectiveAuthorization:{mode:'independent',baseline:{nativeRole:null,pages:[],rules:[{id:'selector-actions',module:'contracts',actions,effect:'allow',buildings:[building],specialties:['电气']}]},overrides:{rules:[],allowPages:[],denyPages:[]}}});
const record=(building='A楼'):BitableRecordItem=>({record_id:'recSyntheticContract',fields:{合同编号:'SYNTHETIC',合同名称:'合成合同',专业类别:'电气',楼栋:building}});

describe('contract selector endpoints authorize their actual record for relevant operations',()=>{
  it('edit options accept update-only and reject create-only or an unrelated building',async()=>{
    const gateway={getRecord:jest.fn().mockResolvedValue(record())};
    const creation={getOptions:jest.fn().mockResolvedValue({fields:[],suppliers:[],people:[]})};
    const service=new ContractEditService(gateway as never,creation as never,{} as never);
    await expect(service.getOptions('recSyntheticContract',principal(['update']))).resolves.toMatchObject({contract:{recordId:'recSyntheticContract'}});
    await expect(service.getOptions('recSyntheticContract',principal(['create']))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.getOptions('recSyntheticContract',principal(['update'],'B楼'))).rejects.toBeInstanceOf(ForbiddenException);
    expect(gateway.getRecord).toHaveBeenCalledTimes(3);
  });
  it.each(['read','create','update','confirm'] as const)('payment selectors accept %s on that contract without requiring list-read permission',async action=>{
    const gateway={getRecord:jest.fn().mockResolvedValue(record())};
    const service=new ContractPaymentFollowUpService(gateway as never,{} as never,{} as never,{} as never,{} as never);
    Object.assign(service,{loadDisplayRecordsSnapshot:jest.fn().mockResolvedValue({paymentRecords:[],organizationRecords:[]})});
    await expect(service.getOptions('recSyntheticContract',principal([action]))).resolves.toMatchObject({contract:{recordId:'recSyntheticContract'}});
    expect(gateway.getRecord).toHaveBeenCalledTimes(1);
  });
  it('cached payment options do not bypass another principal or a changed record scope',async()=>{
    const gateway={getRecord:jest.fn().mockResolvedValue(record())};
    const service=new ContractPaymentFollowUpService(gateway as never,{} as never,{} as never,{} as never,{} as never);
    const lists=jest.fn().mockResolvedValue({paymentRecords:[],organizationRecords:[]});Object.assign(service,{loadDisplayRecordsSnapshot:lists});
    await service.getOptions('recSyntheticContract',principal(['confirm']));
    await expect(service.getOptions('recSyntheticContract',principal(['confirm'],'B楼'))).rejects.toBeInstanceOf(ForbiddenException);
    gateway.getRecord.mockResolvedValue(record('B楼'));
    await expect(service.getOptions('recSyntheticContract',principal(['confirm']))).rejects.toBeInstanceOf(ForbiddenException);
    expect(lists).toHaveBeenCalledTimes(1);expect(gateway.getRecord).toHaveBeenCalledTimes(3);
  });
  it('failed current-record reads never fall back to previously cached options',async()=>{
    const gateway={getRecord:jest.fn().mockResolvedValue(record())};
    const service=new ContractPaymentFollowUpService(gateway as never,{} as never,{} as never,{} as never,{} as never);
    Object.assign(service,{loadDisplayRecordsSnapshot:jest.fn().mockResolvedValue({paymentRecords:[],organizationRecords:[]})});
    await service.getOptions('recSyntheticContract',principal(['create']));gateway.getRecord.mockRejectedValue(new Error('synthetic unavailable'));
    await expect(service.getOptions('recSyntheticContract',principal(['create']))).rejects.toThrow('synthetic unavailable');
  });
  it('a missing current record cannot reuse previously cached options',async()=>{
    const gateway={getRecord:jest.fn().mockResolvedValue(record())};
    const service=new ContractPaymentFollowUpService(gateway as never,{} as never,{} as never,{} as never,{} as never);
    Object.assign(service,{loadDisplayRecordsSnapshot:jest.fn().mockResolvedValue({paymentRecords:[],organizationRecords:[]})});
    await service.getOptions('recSyntheticContract',principal(['create']));gateway.getRecord.mockResolvedValue(undefined);
    await expect(service.getOptions('recSyntheticContract',principal(['create']))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
