import { InventoryStocktakeService } from '../../server/modules/inventory-management/inventory-stocktake.service';
import { InventoryStocktakeController } from '../../server/modules/inventory-management/inventory-stocktake.controller';

describe('stocktake personnel authority', () => {
  const people = {searchApplicants: jest.fn()};
  const service = new InventoryStocktakeService({} as any, {} as any, people as any);
  beforeEach(() => jest.resetAllMocks());
  it('allows a C building warehouse operator to search all active personnel without purchase authority', async () => {
    const rows = [{recordId:'rec1',openId:'ou1',name:'朱春华',building:'C楼'}, {recordId:'rec2',openId:'ou2',name:'另楼人员',building:'A楼'}];
    people.searchApplicants.mockResolvedValue(rows);
    await expect(service.searchPeople('朱', 30, {role:'inventory_admin',purchaseBuilding:'C楼'} as any)).resolves.toEqual(rows);
    expect(people.searchApplicants).toHaveBeenCalledWith({query:'朱',limit:30},false);
  });
  it.each(['read', 'update', 'confirm'])('accepts only stocktake %s permission without filtering candidate specialty or building', async action => {
    const rows = [{name:'朱春华',building:'C楼',specialty:'暖通'}, {name:'其他',building:'A楼',specialty:'电气'}];
    people.searchApplicants.mockResolvedValue(rows);
    const principal = {role:'guest', permissionContext:{module:'stocktake',action}, personalRules:[{id:'stocktake-only',module:'stocktake',effect:'allow',actions:[action],buildings:['C楼'],specialties:['消防']}]};
    await expect(service.searchPeople('朱',30,principal as any)).resolves.toEqual(rows);
    expect(people.searchApplicants).toHaveBeenCalledWith({query:'朱',limit:30},false);
  });
  it('propagates directory failure instead of claiming no employees match', async () => {
    people.searchApplicants.mockRejectedValue(new Error('人员源读取失败'));
    await expect(service.searchPeople('朱',30,{role:'admin'} as any)).rejects.toThrow('人员源读取失败');
  });
  it('rejects users without stocktake authority before reading personnel', () => {
    expect(() => service.searchPeople('朱',30,{role:'guest'} as any)).toThrow('无库存盘点权限');
    expect(people.searchApplicants).not.toHaveBeenCalled();
  });
  it('uses the impersonated subject supplied by the access guard, not administrator identity', async () => {
    const principal = {role:'inventory_admin',purchaseBuilding:'C楼',accountId:'subject'};
    const stub = {searchPeople:jest.fn().mockResolvedValue([])};
    const controller = new InventoryStocktakeController(stub as any,{} as any);
    await controller.searchPeople({accessPrincipal:principal,accessPrincipalFingerprint:'impersonated'} as any,'朱','30');
    expect(stub.searchPeople).toHaveBeenCalledWith('朱',30,principal);
  });
});
