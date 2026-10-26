import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';
import { fetchBitableRecords } from '../../server/common/feishu/bitable-direct-read';
jest.mock('../../server/common/feishu/bitable-direct-read',()=>({...jest.requireActual('../../server/common/feishu/bitable-direct-read'),fetchBitableRecords:jest.fn(),getTenantAccessToken:jest.fn(async()=>'synthetic-token'),resolveBitableAppToken:jest.fn(async()=>'syntheticPositionBase')}));
jest.mock('../../server/common/access/external-employee-directory',()=>({readExternalEmployeeCredentials:jest.fn(async()=>[])}));
const previous={...process.env};
afterEach(()=>{process.env={...previous};jest.clearAllMocks();});
function setup(table:'absent'|'empty'|'failed'|'duplicate',position='设施运维示例人员001'){
  process.env.FEISHU_APP_ID='cli_position_directory';
  const fields=['姓名','飞书 open_id','岗位','机楼/专业','离职/异动情况','任职职责','体系岗位'].map(field_name=>({field_name,type:field_name==='离职/异动情况'?7:1}));
  const duties=['职责名称','职责类型','在任人员','楼栋范围','专业范围','启用','任职版本'].map(field_name=>({field_name,type:1}));
  const person={record_id:'recPositionPerson',fields:{姓名:'合成示例人员001',岗位:position,'飞书 open_id':'ou_position_person','机楼/专业':['B楼']}};
  (fetchBitableRecords as jest.Mock).mockImplementation(async(_http,options)=>{
    if(options.tableId==='tblDuties'){if(table==='failed')throw Error('synthetic-read-error');return [];}
    return [person];
  });
  const http={axiosRef:{get:jest.fn(async(url:string)=>({data:{code:0,data:{has_more:false,items:url.endsWith('/tables')?
    table==='absent'?[]:Array.from({length:table==='duplicate'?2:1},(_,i)=>({table_id:i?'tblOther':'tblDuties',name:'01-4 岗位职责与授权'})):
    url.includes('tblDuties')?duties:url.endsWith('/fields')?fields:[]}}}))}};
  return new AccessConfigurationDirectory(http as never);
}
describe('真实配置目录读取主表岗位',()=>{
  it.each(['absent','empty'] as const)('可选额外职责表%s不阻塞主表岗位，不增加网络查询或读取凭据',async table=>{
    const value=await setup(table).read(true),authority=value.personnelAuthority!;
    expect(authority.problems).toEqual([]);expect(authority.source.kind).toBe('personnel_positions');
    expect(authority.duties.map(d=>d.kind).sort()).toEqual(['building_executor','building_supervisor','warehouse_approver']);
    expect(authority.duties.every(d=>d.origin==='personnel_position'&&d.recordId.startsWith('position-'))).toBe(true);
    expect(authority.source.dutyTableId).toBe(table==='absent'?undefined:'tblDuties');
    for(const [,options] of (fetchBitableRecords as jest.Mock).mock.calls)expect(options.fieldNames).not.toEqual(expect.arrayContaining(['密码','身份证号']));
  });
  it.each(['failed','duplicate'] as const)('可选表%s是明确错误，不能作为空源成功启用',async table=>{
    const value=await setup(table).read(true);expect(value.personnelAuthority!.problems.length).toBeGreaterThan(0);
    expect(value.personnelAuthority!.duties).toEqual([]);expect(value.people).toEqual([{name:'合成示例人员001',openId:'ou_position_person'}]);
  });
  it('主表岗位更新后目录指纹和候选变化，普通目录缓存不冒充强制新快照',async()=>{
    const directory=setup('empty'),first=await directory.read(true);
    (fetchBitableRecords as jest.Mock).mockImplementation(async(_http,options)=>options.tableId==='tblDuties'?[]:[{record_id:'recReplacement',fields:{姓名:'接任示例人员001',岗位:'设施运维示例人员001','飞书 open_id':'ou_replacement','机楼/专业':['B楼'],'离职/异动情况':false}}]);
    const second=await directory.read(true);
    expect(second.personnelAuthority!.version).not.toBe(first.personnelAuthority!.version);
    expect(second.personnelAuthority!.duties.map(d=>d.recordId)).toEqual(first.personnelAuthority!.duties.map(d=>d.recordId));
    expect(second.personnelAuthority!.duties[0].personnelIds).not.toEqual(first.personnelAuthority!.duties[0].personnelIds);
  });
});
