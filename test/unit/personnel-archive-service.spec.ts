import { createHash } from 'node:crypto';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { PersonnelArchiveService } from '../../server/common/access/personnel-archive.service';
import type { PersonnelArchiveDirectory } from '../../server/common/access/personnel-archive.gateway';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';

describe('personal archive stable self identity and privacy', () => {
  const appId='cli_archive_test',appToken='bascnArchiveSynthetic',tableId='tblArchiveTest',recordId='recArchiveTest';
  const localId='local-external-'+createHash('sha256').update(JSON.stringify([appId,appToken,tableId,recordId])).digest('hex');
  const feishuId='feishu-'+feishuIdentityFingerprint(appId,'ou_archive_test');
  const principal=():AccessPrincipal=>({accountId:localId,authorizationVersion:1,displayName:'合成人员',role:'guest',purchaseBuilding:null});
  let configuration:any,gateway:any,service:PersonnelArchiveService,accounts:Record<string,any>,directory:PersonnelArchiveDirectory;
  beforeEach(()=>{
    accounts={ [localId]:{id:localId,kind:'local',name:'合成人员',role:'guest',version:1,building:null,enabled:true,deleted:false,loginMethod:'personnel-password',personnelAppId:appId,personnelActive:true,personnelIdentity:localId},
      [feishuId]:{id:feishuId,kind:'feishu',name:'合成人员',role:'guest',version:1,building:null,enabled:true,deleted:false,appId,personnelIdentity:localId},
      'local-admin-all':{id:'local-admin-all',kind:'local',name:'合成管理员',role:'admin',version:1,building:null,enabled:true,deleted:false},
    };
    configuration={ currentPrincipal:jest.fn((id,version)=>{const a=accounts[id];return a&&a.version===version&&a.enabled&&!a.deleted&&!a.reactivationRequired?{accountId:a.id,authorizationVersion:a.version,displayName:a.name,role:a.role,purchaseBuilding:null}:undefined;}),
      getPersonnelCredentialAccount:jest.fn(id=>accounts[id]?{...accounts[id]}:null) };
    directory={appId,appToken,tableId,snapshotAt:'2026-10-29T01:00:00.000Z',records:[{record_id:recordId,last_modified_time:1793235600000,fields:{姓名:'合成人员',员工姓名:[{id:'ou_archive_test',name:'合成人员'}],'离职/异动情况':false,
      员工工号:'NT-SYNTHETIC',联系方式:'13800000000',照片:[{file_token:'boxSyntheticPhoto',url:'https://untrusted.invalid/private'}],
      身份证号:'11010519491231002X',密码:'MUST_NOT_LEAK',passwordHash:'HASH_MUST_NOT_LEAK',入职日期:'2026-01-01',岗位:'测试岗位',公司名称:'测试单位',学历:'本科',毕业院校:'测试学校',所学专业:'测试专业',MBTI:'INTJ',高压电工证:'有效',培训课程总数:3,培训已完成课程:2,
    }}]};
    gateway={read:jest.fn(async()=>directory),photo:jest.fn(async()=>({contentType:'image/png',buffer:Buffer.from([137,80,78,71,13,10,26,10])}))};
    service=new PersonnelArchiveService(configuration,gateway);
  });
  it('returns current local identity full mapped archive, masked ID and a self-only photo URL',async()=>{
    const result=await service.read(principal());
    expect(result).toMatchObject({status:'ready',snapshotAt:directory.snapshotAt,profile:{name:'合成人员',employeeNo:'NT-SYNTHETIC',phone:'13800000000',photoUrl:'/api/access/personal/archive/photo',education:'本科',school:'测试学校',company:'测试单位',mbti:'INTJ',training:{completedCourses:2,totalCourses:3}}});
    expect(result.profile!.idCardMasked).toBe('110105********002X');
    expect(result.profile!.certificates).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/MUST_NOT_LEAK|HASH_MUST_NOT_LEAK|boxSyntheticPhoto|ou_archive_test|recArchiveTest|11010519491231002X|untrusted\.invalid|qualityAssessment/);
    expect(result.profile!.employmentHistory.every(item=>/^history-\d+$/.test(item.id))).toBe(true);
  });
  it('resolves a Feishu identity by the actual application OpenID and its local binding',async()=>{
    expect((await service.read({...principal(),accountId:feishuId})).profile?.employeeNo).toBe('NT-SYNTHETIC');
    accounts[feishuId].personnelIdentity='local-external-'+'f'.repeat(64);
    await expect(service.read({...principal(),accountId:feishuId})).rejects.toThrow('关联已变化');
  });
  it('does not match another employee by identical name',async()=>{
    directory.records=[{record_id:'recSomeoneElse',fields:{姓名:'合成人员',员工姓名:[{id:'ou_someone_else'}],'离职/异动情况':false}}];
    await expect(service.read(principal())).rejects.toThrow('未唯一匹配');
    await expect(service.read({...principal(),accountId:feishuId})).rejects.toThrow('未唯一匹配');
  });
  it('rejects duplicate identity records or conflicting OpenIDs instead of choosing one',async()=>{
    directory.records.push(structuredClone(directory.records[0]));
    await expect(service.read(principal())).rejects.toThrow('未唯一匹配');
    directory.records=[directory.records[0]];directory.records[0].fields!['飞书 open_id']='ou_conflicting';
    await expect(service.read({...principal(),accountId:feishuId})).rejects.toThrow('未唯一匹配');
  });
  it('does not require the organization-wide profile permission to read oneself',async()=>{
    expect((await service.read(principal())).status).toBe('ready');
    expect(principal().role).toBe('guest');
  });
  it('returns unbound for a real shared account without reading personnel source',async()=>{
    const result=await service.read({accountId:'local-admin-all',authorizationVersion:1,role:'admin',purchaseBuilding:null,displayName:'合成管理员'});
    expect(result).toEqual({status:'unbound',profile:null,snapshotAt:null});
    expect(gateway.read).not.toHaveBeenCalled();
  });
  it('returns unbound only for an unlinked Feishu account with no matching source identity',async()=>{
    delete accounts[feishuId].personnelIdentity;directory.records=[];
    expect((await service.read({...principal(),accountId:feishuId})).status).toBe('unbound');
    accounts[feishuId].personnelIdentity=localId;
    await expect(service.read({...principal(),accountId:feishuId})).rejects.toThrow('未唯一匹配');
  });
  it.each(['inactive','unknown'])('rejects an %s personnel source without changing account state',async state=>{
    directory.records[0].fields!['离职/异动情况']=state==='inactive'?true:'未确认';
    await expect(service.read(principal())).rejects.toThrow('在职状态');
    expect(accounts[localId].enabled).toBe(true);
  });
  it.each(['disabled','deleted','reactivation','initial-password'])('does not expose archive for %s',async state=>{
    const p=principal();
    if(state==='disabled')accounts[localId].enabled=false;
    if(state==='deleted')accounts[localId].deleted=true;
    if(state==='reactivation')accounts[localId].reactivationRequired=true;
    if(state==='initial-password')p.requiresPasswordChange=true;
    await expect(service.read(p)).rejects.toThrow('登录状态');expect(gateway.read).not.toHaveBeenCalled();
  });
  it('does not downgrade source errors to unbound or absence',async()=>{
    gateway.read.mockRejectedValue(new Error('Synthetic unavailable'));
    await expect(service.read(principal())).rejects.toThrow('Synthetic unavailable');
  });
  it('rechecks authorization after an awaited source read',async()=>{
    let complete!:(value:PersonnelArchiveDirectory)=>void;
    gateway.read.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const pending=service.read(principal());accounts[localId].version++;complete(directory);
    await expect(pending).rejects.toThrow('登录状态');
  });
  it('rechecks authorization after photo download and never accepts caller-selected record IDs',async()=>{
    let complete!:(value:unknown)=>void;
    gateway.photo.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const pending=service.photo(principal());await Promise.resolve();await Promise.resolve();await Promise.resolve();
    accounts[localId].enabled=false;complete({contentType:'image/png',buffer:Buffer.from('synthetic')});
    await expect(pending).rejects.toThrow('登录状态');
    expect(gateway.photo.mock.calls[0][1].record_id).toBe(recordId);
  });
  it('allows a still-valid administrator impersonation to view the target read-only',async()=>{
    const p={...principal(),impersonation:{actorAccountId:'local-admin-all',actorName:'合成管理员',targetName:'合成人员',expiresAt:Date.now()+60000}};
    expect((await service.read(p)).profile?.name).toBe('合成人员');
    accounts['local-admin-all'].enabled=false;
    await expect(service.read(p)).rejects.toThrow('代登录状态');
  });
  it('rejects an impersonation owner changed during an awaited source read',async()=>{
    let complete!:(value:PersonnelArchiveDirectory)=>void;gateway.read.mockImplementation(()=>new Promise(resolve=>{complete=resolve;}));
    const pending=service.read({...principal(),impersonation:{actorAccountId:'local-admin-all',actorName:'合成管理员',targetName:'合成人员',expiresAt:Date.now()+60000}});
    accounts['local-admin-all'].version++;complete(directory);
    await expect(pending).rejects.toThrow('代登录状态');
  });
  it('rejects a changed app source or display identity',async()=>{
    directory.appId='cli_other';await expect(service.read(principal())).rejects.toThrow('数据源');
    directory.appId=appId;directory.records[0].fields!.姓名='另一个姓名';await expect(service.read(principal())).rejects.toThrow('登录姓名');
  });
  it('returns no photo when the source only contains an arbitrary URL',async()=>{
    directory.records[0].fields!.照片=[{url:'http://127.0.0.1/secret'}];
    expect((await service.read(principal())).profile?.photoUrl).toBeNull();
  });
});
