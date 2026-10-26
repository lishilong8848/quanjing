import 'reflect-metadata';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PersonnelPreviewService } from '../../server/common/access/personnel-preview.service';
import { PERSONNEL_PREVIEW_READERS } from '../../server/common/access/personnel-preview.ports';
import type { AuthorityPerson, AuthorityDuty, PersonnelAuthoritySnapshot } from '../../shared/personnel-authority.interface';
import type { AccessConfigurationResponse, ManagedAccount } from '../../shared/access-configuration.interface';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';

const appId = 'cli_preview_fixture';
const oldPerson: AuthorityPerson = { id:'local-external-'+ 'a'.repeat(64),recordId:'recOld',name:'前任甲',openId:'ou_old',active:false,type:'employee',position:'C楼示例人员001',systemPosition:'',buildings:['C楼'],specialties:[],permissionTags:[],dutyRecordIds:['recDuty'] };
const newPerson: AuthorityPerson = { ...oldPerson,id:'local-external-'+ 'b'.repeat(64),recordId:'recNew',name:'接任乙',openId:'ou_new',active:true,dutyRecordIds:[] };
const duty: AuthorityDuty = { recordId:'recDuty',name:'C楼请休假审批',kind:'leave_supervisor',personnelIds:[newPerson.id],buildings:['C楼'],specialties:null,enabled:true,startsAt:0,endsAt:null,parentDutyIds:[],version:1 };
function account(person: AuthorityPerson, overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return { id:'feishu-'+feishuIdentityFingerprint(appId,person.openId!),kind:'feishu',name:person.name,role:'site_member',building:null,enabled:true,deleted:false,version:1,source:'configuration',appId,identityHash:feishuIdentityFingerprint(appId,person.openId!),...overrides };
}
function fixture() {
  const authority: PersonnelAuthoritySnapshot = { mode:'shadow',version:'c'.repeat(64),snapshotAt:Date.now(),source:{appId,appToken:'fixture',tableId:'tblPeople'},people:[oldPerson,newPerson],duties:[duty],problems:[],issues:[] };
  const state: AccessConfigurationResponse = { revision:3,appId,accounts:[account(oldPerson,{role:'building_admin',building:'C楼',enabled:false,permissionsRevoked:true}),account(newPerson)],cardRules:[],audit:[] };
  const archive = { accountId:state.accounts[0].id,name:oldPerson.name,appId,capturedAt:'2026-10-14T00:00:00.000Z',configurationRevision:2,template:{role:'building_admin',building:'C楼',sourceVersion:1,pagePaths:['/monthly-schedule']} };
  const config = { snapshot:jest.fn(()=>structuredClone(state)), enrichedSnapshot:jest.fn(()=>structuredClone(state)), permissionArchives:jest.fn(()=>[structuredClone(archive)]) };
  const directory = { read:jest.fn(async()=>({appId,people:[],personnelAuthority:structuredClone(authority)})) };
  const reader = {module:'leave',listPending:jest.fn(async()=>[]),acceptTransfer:jest.fn(()=>{throw new Error('writes forbidden');}),reconcile:jest.fn()};
  const moduleRef = {get:jest.fn((token:unknown)=>{if(token===PERSONNEL_PREVIEW_READERS.leave)return reader;throw new Error('not registered');})};
  const service = new PersonnelPreviewService(config as never,directory as never,moduleRef as never);
  const request = {fromPersonId:oldPerson.id,toPersonId:newPerson.id,dutyRecordIds:[duty.recordId],expectedDirectoryVersion:authority.version,expectedConfigurationRevision:state.revision};
  return {authority,state,config,directory,reader,moduleRef,service,request,archive};
}
describe('Stage2 read-only personnel preview',()=>{
  it('稳定记录关联两种登录账号，不用同名合并或泄露密码',()=>{
    const f=fixture();f.state.accounts.push({...account(oldPerson),id:oldPerson.id,kind:'local',loginMethod:'personnel-password',personnelIdentity:oldPerson.id,personnelAppId:appId});
    f.state.accounts.push({...account(newPerson),id:'foreign',appId:'cli_other',name:oldPerson.name});
    const result=f.service.overview({appId,people:[],personnelAuthority:f.authority} as never,f.state);
    expect(result.people[0].accounts.map(a=>a.id)).toEqual([f.state.accounts[0].id,oldPerson.id]);
    expect(JSON.stringify(result)).not.toMatch(/passwordHash|身份证|appToken/);
  });
  it('收权前的存档可预览完整页面权限，预览不调用任何转办方法',async()=>{
    const f=fixture();const result=await f.service.preview(f.request);
    expect(result.permissions[0].sourceArchiveAt).toBe(f.archive.capturedAt);
    expect(result.permissions[0].source.role).toBe('building_admin');
    expect(result.permissions[0].after.pagePaths).toContain('/monthly-schedule');
    expect(result.readOnly).toBe(true);expect(result.checks.find(c=>c.module==='contracts')?.status).toBe('not_selected');
    expect(f.reader.listPending).toHaveBeenCalledTimes(1);expect(f.reader.acceptTransfer).not.toHaveBeenCalled();expect(f.reader.reconcile).not.toHaveBeenCalled();
  });
  it('配置或人员旧版本必须拒绝，不能生成貌似当前的预览',async()=>{
    const f=fixture();await expect(f.service.preview({...f.request,expectedConfigurationRevision:2})).rejects.toBeInstanceOf(ConflictException);
    await expect(f.service.preview({...f.request,expectedDirectoryVersion:'d'.repeat(64)})).rejects.toBeInstanceOf(ConflictException);
    expect(f.reader.listPending).not.toHaveBeenCalled();
  });
  it('无关职责、同一人员和未知字段拒绝',async()=>{
    const f=fixture();await expect(f.service.preview({...f.request,dutyRecordIds:['recUnknown']})).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.service.preview({...f.request,toPersonId:oldPerson.id})).rejects.toBeInstanceOf(BadRequestException);
    await expect(f.service.preview({...f.request,confirm:true} as never)).rejects.toBeInstanceOf(BadRequestException);
  });
  it('读取失败是未核对，不能把失败变成待办零条或全模块成功',async()=>{
    const f=fixture();f.reader.listPending.mockRejectedValueOnce(new Error('private upstream response'));
    const result=await f.service.preview(f.request);const check=result.checks.find(c=>c.module==='leave');
    expect(check?.status).toBe('unavailable');expect(check?.count).toBeUndefined();expect(result.conflicts.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('private upstream response');
  });
  it('缺少职责表仍能预览权限，但清楚标记职责未核对',async()=>{
    const f=fixture();f.authority.duties=[];f.authority.problems=['职责表尚未配置'];
    const result=await f.service.preview({...f.request,dutyRecordIds:[]});
    expect(result.permissions).toHaveLength(1);expect(result.warnings).toContain('未选择岗位职责，仅预览页面和业务权限');
    expect(result.conflicts).toContain('职责表尚未配置');expect(f.reader.listPending).not.toHaveBeenCalled();
  });
  it('合同职责通过同一只读端口核对，缺失端口不能当作零待办',async()=>{
    const f=fixture();f.authority.duties[0].kind='contract_action';f.authority.duties[0].buildings=null;
    const missing=await f.service.preview(f.request);expect(missing.checks.find(row=>row.module==='contracts')?.status).toBe('unavailable');
    const read=jest.fn(async()=>[]);f.moduleRef.get.mockImplementation((token:unknown)=>{if(token===(PERSONNEL_PREVIEW_READERS as Record<string,symbol>).contracts)return {module:'contracts',listPending:read} as never;throw Error('not registered');});
    const result=await f.service.preview(f.request);expect(result.checks.find(row=>row.module==='contracts')).toMatchObject({status:'checked',count:0});expect(read).toHaveBeenCalledTimes(1);
  });
});
