import { ConflictException, ForbiddenException } from '@nestjs/common';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import type { BusinessAction, BusinessModule } from '../../shared/business-permissions';
import type { GenerateWeeklyReport, SaveWeeklyMeeting } from '../../shared/weekly-workspace.interface';
import { WeeklyService } from '../../server/modules/meeting-management/weekly.service';
import { mapWeeklyMeeting } from '../../server/modules/meeting-management/meeting.mapper';
import { EmergencyDutyService } from '../../server/modules/duty-schedule/emergency-duty.service';
import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';

jest.mock('@server/database/schema',()=>({appRoomScheduleEnhanced:{id:'id',building:'building',scheduleDate:'scheduleDate'},appSyncConfig:{},appSealingInfo:{}}));
jest.mock('drizzle-orm',()=>({...jest.requireActual('drizzle-orm'),
  eq:(column:string,value:unknown)=>(row:Record<string,unknown>)=>row[column]===value,
  and:(...conditions:((row:Record<string,unknown>)=>boolean)[])=>(row:Record<string,unknown>)=>conditions.every(condition=>condition(row)),
}));
jest.mock('@server/common/config/external-services.config',()=>({...jest.requireActual('@server/common/config/external-services.config'),readEnv:()=>'',getFeishuAuthPayload:()=>({app_id:'cli_synthetic',app_secret:'synthetic-only'})}));
jest.mock('@server/common/feishu/bitable-direct-read',()=>({...jest.requireActual('@server/common/feishu/bitable-direct-read'),invalidateBitableRecordCache:jest.fn()}));

function principal(module:BusinessModule,actions:BusinessAction[],id='synthetic-account-a'):AccessPrincipal {
  return {role:'guest',purchaseBuilding:null,accountId:id,authorizationVersion:1,displayName:'合成权限账号',effectiveAuthorization:{mode:'independent',
    baseline:{nativeRole:null,pages:[],rules:[{id:'synthetic-action-grant',module,actions,effect:'allow',buildings:null,specialties:null}]},
    overrides:{rules:[],allowPages:[],denyPages:[]}}};
}

describe('record-dependent create/update authorization',()=>{
  describe('weekly real service and durable store',()=>{
    let root:string,owner:string,service:WeeklyService,saved:Record<string,string|undefined>;
    let gateway:{people:jest.Mock;record:jest.Mock;update:jest.Mock},detail:jest.Mock,tick:jest.SpyInstance;
    const save=(text=''):SaveWeeklyMeeting=>({clientMutationId:`weekly-save-${randomUUID()}`,expectedVersion:0,expectedText:text,
      meeting:{targetRecordId:'recSyntheticWeekly',kind:'ali',plannedDate:'2026-10-07',actualDate:'2026-10-07',status:'held',note:'',todos:[]}});
    const generate=(createOnly:boolean):GenerateWeeklyReport=>({clientMutationId:`weekly-report-${randomUUID()}`,targetRecordId:createOnly?'new':'recSyntheticWeekly',startDate:'2026-10-01',endDate:'2026-10-07',expectedDocumentUrl:null,confirmedNoTodos:true,createOnly});
    beforeEach(()=>{
      saved=Object.fromEntries(['WEEKLY_WORKSPACE_DIR','NANTONG_WEEKLY_EDITOR_OPEN_IDS'].map(key=>[key,process.env[key]]));
      root=mkdtempSync(join(realpathSync(tmpdir()),'nt-record-permissions-'));owner=randomUUID();writeFileSync(join(root,'.owner'),owner,{flag:'wx'});
      process.env.WEEKLY_WORKSPACE_DIR=root;process.env.NANTONG_WEEKLY_EDITOR_OPEN_IDS='ou_syntheticeditor123';
      gateway={people:jest.fn().mockResolvedValue([]),record:jest.fn().mockResolvedValue({日期:'2026-10-07'}),update:jest.fn()};
      detail=jest.fn().mockResolvedValue({meeting:mapWeeklyMeeting({record_id:'recSyntheticWeekly',fields:{日期:'2026-10-07'}})});
      service=new WeeklyService(gateway as never,{status:()=>({ready:true}),requestCheck:jest.fn()} as never,{detail} as never);
      // This test accepts intents; the unrelated background engine is deliberately not run.
      tick=jest.spyOn(service as unknown as {tick():Promise<void>},'tick').mockResolvedValue(undefined);
    });
    afterEach(async()=>{
      await new Promise<void>(resolve=>setImmediate(resolve));service.onModuleDestroy();tick.mockRestore();
      for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
      if(resolve(dirname(root)).toLowerCase()!==resolve(realpathSync(tmpdir())).toLowerCase()||readFileSync(join(root,'.owner'),'utf8')!==owner)throw new Error('fixture ownership mismatch');
      rmSync(root,{recursive:true,force:false});
    });
    it.each(['','已有远端待办'])('create-only cannot edit an existing remote record with local tracking absent: %s',async text=>{
      detail.mockResolvedValue({meeting:mapWeeklyMeeting({record_id:'recSyntheticWeekly',fields:{日期:'2026-10-07',阿里会议待办:text}})});
      expect(service.store.list().meetings).toHaveLength(0);
      await expect(service.save(save(text),'synthetic-account-a',principal('meetings',['create']))).rejects.toBeInstanceOf(ForbiddenException);
      expect(detail).toHaveBeenCalledWith('recSyntheticWeekly',false);expect(service.store.list().jobs).toHaveLength(0);expect(gateway.update).not.toHaveBeenCalled();
    });
    it('update-only may edit the existing remote record without manufacturing a create permission',async()=>{
      await expect(service.save(save(),'synthetic-account-a',principal('meetings',['update']))).resolves.toMatchObject({kind:'meeting',status:'accepted'});
      expect(service.store.list().jobs).toHaveLength(1);expect(gateway.update).not.toHaveBeenCalled();
    });
    it.each([{createOnly:true,granted:'update' as const},{createOnly:false,granted:'create' as const}])('report creation/existing generation requires the actual operation: %j',async row=>{
      await expect(service.generate(generate(row.createOnly),'synthetic-account-a',principal('meetings',[row.granted]))).rejects.toBeInstanceOf(ForbiddenException);
      expect(service.store.list().jobs).toHaveLength(0);
    });
    it('another account cannot reuse a durable accepted request id',async()=>{
      const request=save();await service.save(request,'synthetic-account-a',principal('meetings',['update']));
      const before=readFileSync(join(root,'ledger.json'));
      await expect(service.save(request,'synthetic-account-b',principal('meetings',['update'],'synthetic-account-b'))).rejects.toBeInstanceOf(ConflictException);
      expect(readFileSync(join(root,'ledger.json'))).toEqual(before);expect(service.store.list().jobs).toHaveLength(1);
    });
  });

  describe('emergency duty real upsert branch and identity-bound replay',()=>{
    const date='2026-10-28';
    function fixture(records:Record<string,unknown>[]){
      const post=jest.fn(async(_url:string,body:{fields:Record<string,unknown>})=>({data:{code:0,data:{record:{record_id:'recSyntheticCreated',fields:body.fields}}}}));
      const put=jest.fn(async(_url:string,body:{fields:Record<string,unknown>})=>({data:{code:0,data:{record:{record_id:'recSyntheticExisting',fields:body.fields}}}}));
      const service=new EmergencyDutyService({axiosRef:{post,put}} as never,{} as never);
      const remote=jest.fn().mockResolvedValue(records);
      // Replace only I/O boundaries; request validation, real lookup/classification and replay remain real.
      Object.assign(service,{getAppToken:jest.fn().mockResolvedValue('syntheticApp'),getTenantAccessToken:jest.fn().mockResolvedValue('synthetic-token'),fetchRemoteSnapshot:remote,
        resolveSelectedPersonnel:jest.fn().mockResolvedValue({people:[{key:'synthetic-person',name:'合成值班员',role:'运维'}],openIds:['ou_synthetic_person']}),
        confirmAcceptedWrite:jest.fn().mockResolvedValue('synced'),confirmPersistedRecord:jest.fn().mockResolvedValue('synced')});
      return {service,post,put,remote};
    }
    const request=()=>({date,personKeys:['synthetic-person'],clientMutationId:`synthetic-emergency-${randomUUID()}`});
    it.each([{exists:true,granted:'create' as const},{exists:false,granted:'update' as const}])('uses the fetched remote existence before selecting permission: %j',async row=>{
      const f=fixture(row.exists?[{record_id:'recSyntheticExisting',fields:{排班日期:date,值班人员:[]}}]:[]);
      await expect(f.service.upsertSchedule(request(),principal('schedule_assignments',[row.granted]))).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.remote).toHaveBeenCalledTimes(1);expect(f.post).not.toHaveBeenCalled();expect(f.put).not.toHaveBeenCalled();
      f.service.onModuleDestroy();
    });
    it('a completed mutation from another account cannot be returned or written again',async()=>{
      const f=fixture([]),body=request();await expect(f.service.upsertSchedule(body,principal('schedule_assignments',['create']))).resolves.toMatchObject({syncStatus:'synced'});
      await expect(f.service.upsertSchedule(body,principal('schedule_assignments',['create'],'synthetic-account-b'))).rejects.toBeInstanceOf(ConflictException);
      expect(f.post).toHaveBeenCalledTimes(1);expect(f.put).not.toHaveBeenCalled();expect(f.remote).toHaveBeenCalledTimes(1);f.service.onModuleDestroy();
    });
    it('another account cannot attach to an in-flight mutation with the same id',async()=>{
      const f=fixture([]),body=request();let enter!:()=>void,release!:(rows:Record<string,unknown>[])=>void;
      const entered=new Promise<void>(resolve=>{enter=resolve;}),blocked=new Promise<Record<string,unknown>[]>(resolve=>{release=resolve;});
      f.remote.mockImplementation(async()=>{enter();return blocked;});
      const first=f.service.upsertSchedule(body,principal('schedule_assignments',['create']));
      try {
        await Promise.race([entered,first.then(()=>{throw new Error('mutation completed before the read barrier');})]);
        await expect(f.service.upsertSchedule(body,principal('schedule_assignments',['create'],'synthetic-account-b'))).rejects.toBeInstanceOf(ConflictException);
        expect(f.post).not.toHaveBeenCalled();
      } finally {release([]);await first;f.service.onModuleDestroy();}
      expect(f.post).toHaveBeenCalledTimes(1);expect(f.remote).toHaveBeenCalledTimes(1);
    });
  });

  describe('batch scheduling real service with a transactional database port',()=>{
    type Row={id:number;building:string;scheduleDate:string;dutyStaffActual:string[];recordId?:string};
    function fixture(initial:Row[]){
      let rows=structuredClone(initial),commits=0,insertAttempts=0,updateAttempts=0;
      const db={transaction:jest.fn(async(operation:(transaction:unknown)=>Promise<unknown>)=>{
        const draft=structuredClone(rows);let predicate:(row:Row)=>boolean=()=>true;
        const transaction={
          select:()=>({from:()=>({where:(where:(row:Row)=>boolean)=>({limit:async(limit:number)=>draft.filter(where).slice(0,limit)})})}),
          insert:()=>({values:(values:Omit<Row,'id'>)=>({returning:async()=>{insertAttempts++;const row={...values,id:draft.length+1};draft.push(row);return [row];}})}),
          update:()=>({set:(values:Partial<Row>)=>({where:(where:(row:Row)=>boolean)=>{predicate=where;return {returning:async()=>{updateAttempts++;const row=draft.find(predicate)!;Object.assign(row,values);return [row];}};}})}),
        };
        const result=await operation(transaction);rows=draft;commits++;return result;
      })};
      // Avoid initializing unrelated notification integrations; execute the real method itself.
      const service=Object.create(DutyScheduleService.prototype) as DutyScheduleService;
      Object.assign(service,{db,logger:{debug:jest.fn(),error:jest.fn()}});
      return {service,db,state:()=>({rows:structuredClone(rows),commits,insertAttempts,updateAttempts})};
    }
    it.each([{exists:true,granted:'create' as const},{exists:false,granted:'update' as const}])('existing/new DB rows enforce distinct permissions: %j',async row=>{
      const initial=row.exists?[{id:1,building:'app_a_building',scheduleDate:'2026-10-28',dutyStaffActual:['old']}]:[];
      const f=fixture(initial);await expect(f.service.batchUpsertDutySchedules([{buildingId:'A',dutyDate:'2026-10-28',staffId:'synthetic-staff'}],principal('schedule_assignments',[row.granted]))).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.state()).toEqual({rows:initial,commits:0,insertAttempts:0,updateAttempts:0});
    });
    it('a denied later item rolls back an earlier permitted insert in the same transaction',async()=>{
      const initial=[{id:1,building:'app_b_building',scheduleDate:'2026-10-28',dutyStaffActual:['old']}],f=fixture(initial);
      await expect(f.service.batchUpsertDutySchedules([{buildingId:'A',dutyDate:'2026-10-28',staffId:'new-a'},{buildingId:'B',dutyDate:'2026-10-28',staffId:'new-b'}],principal('schedule_assignments',['create']))).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.db.transaction).toHaveBeenCalledTimes(1);expect(f.state()).toEqual({rows:initial,commits:0,insertAttempts:1,updateAttempts:0});
    });
    it('a second account rechecks the now-existing DB record instead of reusing an earlier create result',async()=>{
      const f=fixture([]),request=[{buildingId:'A',dutyDate:'2026-10-28',staffId:'synthetic-staff'}];
      await expect(f.service.batchUpsertDutySchedules(request,principal('schedule_assignments',['create']))).resolves.toEqual({success:true});
      const before=f.state();
      await expect(f.service.batchUpsertDutySchedules(request,principal('schedule_assignments',['create'],'synthetic-account-b'))).rejects.toBeInstanceOf(ForbiddenException);
      expect(f.state()).toEqual(before);expect(f.db.transaction).toHaveBeenCalledTimes(2);
    });
  });
});
