import { PersonnelBaselineDirectory } from '../../server/common/access/personnel-baseline.directory';
import { InventoryWarehouseRoleDirectory } from '../../server/modules/inventory-outbound-approval/inventory-warehouse-role-directory';
import type { ConfigurationDirectorySnapshot } from '../../server/common/access/access-configuration.directory';
import type { ConfigurationState } from '../../server/common/access/access-configuration.store';
import * as bitable from '../../server/common/feishu/bitable-direct-read';

const appId='cli_baseline_directory_synthetic';
const state:ConfigurationState={schemaVersion:1,revision:0,legacySessionsRevoked:false,accounts:{},cardRules:{},audit:[],mutations:{}};
const snapshot=():ConfigurationDirectorySnapshot=>({appId,people:[],employees:[],snapshotAt:Date.now(),personnelComplete:true,personnelAuthority:{mode:'shadow',version:'a'.repeat(64),snapshotAt:Date.now(),source:{appId,appToken:'syntheticBase',tableId:'tblPeople',dutyTableId:'tblDuties'},people:[],problems:[],issues:[],duties:[{recordId:'recDuty',name:'库房审批',kind:'warehouse_approver',personnelIds:[],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1}]}});
describe('首次基线实际旧目录入口与范围',()=>{
  let previous:string|undefined;
  beforeEach(()=>{previous=process.env.FEISHU_APP_ID;process.env.FEISHU_APP_ID=appId;});
  afterEach(()=>{jest.restoreAllMocks();if(previous===undefined)delete process.env.FEISHU_APP_ID;else process.env.FEISHU_APP_ID=previous;});
  it('源为空不调用旧库房来源；已填源按实际楼栋调用原解析入口',async()=>{
    const legacy=jest.spyOn(InventoryWarehouseRoleDirectory.prototype,'resolveApprovers').mockResolvedValue([{openId:'ou_holder',name:'合成负责人'}]);
    const service=new PersonnelBaselineDirectory({} as never),empty=snapshot();empty.personnelAuthority!.duties=[];expect(await service.read(empty,state)).toEqual({});expect(legacy).not.toHaveBeenCalled();
    expect(await service.read(snapshot(),state)).toMatchObject({recDuty:{source:'原库房审批配置',members:[{openId:'ou_holder'}]}});expect(legacy).toHaveBeenCalledWith('C楼',true);
  });
  it('多楼栋的实际原负责人不同必须阻断，不取并集冒充原范围',async()=>{
    jest.spyOn(InventoryWarehouseRoleDirectory.prototype,'resolveApprovers').mockImplementation(async building=>[{openId:building==='C楼'?'ou_c':'ou_d',name:'同名人员'}]);
    const directory=snapshot();directory.personnelAuthority!.duties[0].buildings=['C楼','D楼'];
    expect((await new PersonnelBaselineDirectory({} as never).read(directory,state)).recDuty).toMatchObject({members:[],problem:expect.stringMatching(/不一致/)});
  });
  it('旧源错误是可见阻断，不返回成功空人或泄漏底层请求细节',async()=>{
    jest.spyOn(InventoryWarehouseRoleDirectory.prototype,'resolveApprovers').mockRejectedValue(new Error('synthetic-private-request-detail'));
    const result=await new PersonnelBaselineDirectory({} as never).read(snapshot(),state);expect(result.recDuty.problem).toMatch(/读取失败/);expect(JSON.stringify(result)).not.toContain('synthetic-private-request-detail');
  });
  it('同次核对1000条重复范围只读取一次同一旧岗位，不随记录数请求外部',async()=>{
    const legacy=jest.spyOn(InventoryWarehouseRoleDirectory.prototype,'resolveApprovers').mockResolvedValue([{openId:'ou_holder',name:'合成负责人'}]);
    const directory=snapshot(),first=directory.personnelAuthority!.duties[0];directory.personnelAuthority!.duties=Array.from({length:1000},(_,index)=>({...first,recordId:`recRepeated${index}`}));
    const result=await new PersonnelBaselineDirectory({} as never).read(directory,state);expect(Object.keys(result)).toHaveLength(1000);expect(legacy).toHaveBeenCalledTimes(1);
  });
  it('七栋审批和知会共用一次新鲜表读取，下一次核对必须重新取源',async()=>{
    const previousEnv={...process.env};jest.useFakeTimers();
    process.env.FEISHU_WAREHOUSE_MANAGER_APP_TOKEN='syntheticBase';process.env.FEISHU_WAREHOUSE_MANAGER_TABLE_ID='tbl83761b9d761e00b1f2';
    const buildings=['A楼','B楼','C楼','D楼','E楼','H楼','110站'];
    jest.spyOn(bitable,'resolveBitableAppToken').mockResolvedValue('syntheticBase');
    const read=jest.spyOn(bitable,'fetchBitableRecords').mockImplementation(async(_http,options)=>{
      expect(options).toMatchObject({forceRefresh:true,allowStale:false,strict:true});
      await new Promise(resolve=>setTimeout(resolve,1200));
      return buildings.map((building,index)=>({record_id:`recWarehouse${index}`,fields:{楼栋:building,库房示例人员019员:[{id:`ou_approver${index}`,name:`审批${index}`}],库房管理人:[{id:`ou_notify${index}`,name:`知会${index}`} ]}}));
    });
    const directory=snapshot(),first=directory.personnelAuthority!.duties[0];
    directory.personnelAuthority!.duties=buildings.flatMap((building,index)=>(['warehouse_approver','warehouse_notify'] as const).map(kind=>({...first,recordId:`rec${kind}${index}`,kind,buildings:[building]})));
    const service=new PersonnelBaselineDirectory({} as never),start=Date.now();
    try{
      const pending=service.read(directory,state);await jest.runAllTimersAsync();const result=await pending;
      expect(read).toHaveBeenCalledTimes(1);expect(Date.now()-start).toBe(1200);
      for(let index=0;index<buildings.length;index++){
        expect(result[`recwarehouse_approver${index}`]).toMatchObject({members:[{openId:`ou_approver${index}`}]});
        expect(result[`recwarehouse_notify${index}`]).toMatchObject({members:[{openId:`ou_notify${index}`}]});
      }
      const next=service.read(directory,state);await jest.runAllTimersAsync();await next;expect(read).toHaveBeenCalledTimes(2);
      read.mockRejectedValueOnce(new Error('synthetic-read-failure'));
      const failed=await service.read(directory,state);expect(Object.values(failed).every(row=>!!row.problem&&!row.members.length)).toBe(true);expect(read).toHaveBeenCalledTimes(3);
      const retried=service.read(directory,state);await jest.runAllTimersAsync();expect((await retried).recwarehouse_approver0.problem).toBeUndefined();expect(read).toHaveBeenCalledTimes(4);
    }finally{jest.useRealTimers();process.env=previousEnv;}
  });
  it('独立岗位限量并行读取，错误只阻断对应岗位',async()=>{
    jest.useFakeTimers();let active=0,peak=0;
    const legacy=jest.spyOn(InventoryWarehouseRoleDirectory.prototype,'resolveApprovers').mockImplementation(async building=>{
      active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,100));active--;
      if(building==='D楼')throw Error('synthetic-failure');return [{openId:`ou_${building}`,name:building}];
    });
    const directory=snapshot(),first=directory.personnelAuthority!.duties[0];directory.personnelAuthority!.duties=['A楼','B楼','C楼','D楼','E楼','H楼','110站'].map((building,index)=>({...first,recordId:`recParallel${index}`,buildings:[building]}));
    try{const pending=new PersonnelBaselineDirectory({} as never).read(directory,state);await jest.runAllTimersAsync();const result=await pending;
      expect(peak).toBe(4);expect(active).toBe(0);expect(legacy).toHaveBeenCalledTimes(7);expect(result.recParallel3.problem).toMatch(/读取失败/);expect(result.recParallel0.members[0].name).toBe('A楼');
    }finally{jest.useRealTimers();}
  });
});
