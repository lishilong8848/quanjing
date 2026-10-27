import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { LeaveWorkflowStore } from '../../server/modules/leave-workflow/leave-workflow.store';
import { LeaveWorkflowService, buildShiftAssignmentSummary } from '../../server/modules/leave-workflow/leave-workflow.service';
import { buildLeaveSubstituteAdjustmentCard } from '../../server/modules/leave-workflow/leave-workflow.card';
import { parseLeaveLongConnectionCardAction } from '../../server/modules/leave-workflow/leave-workflow.callback';
import { FeishuCardActionRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { currentHotfixActivation } from '../../server/common/hotfix-runtime-activation';
import { applicant, backup, fixture, primary, replacement, schedules } from './fixtures/leave-two-level';

describe('leave callback concurrency and recovery', () => {
  let directory: string;
  let store: LeaveWorkflowStore;
  let service: LeaveWorkflowService;
  let rows: typeof schedules;
  let gateway: { patchInteractiveCard: jest.Mock };
  let sync: any;
  let detail: any;
  let previousAppId: string | undefined;
  const data = () => fixture();
  const viewInput = () => ({ recordId: data().application.recordId, actorOpenId: 'ou_supervisor', messageId: 'om_test_two_level', stageKey: 'supervisor', stageVersion: 1, view: 'substitute_review', shiftSelections: [{ shiftKey: data().selection.shiftKey, substitutePersonRecordId: primary.personRecordId }] });
  beforeEach(async () => {
    previousAppId = process.env.FEISHU_APP_ID; process.env.FEISHU_APP_ID = 'cli_two_level_synthetic';
    directory = await mkdtemp(join(tmpdir(), 'leave-two-level-service-owned-'));
    store = new LeaveWorkflowStore(join(directory, 'ledger.json'));
    await store.acceptApplication({ ...data().application, snapshot: { ...data().application.snapshot, applicantNotificationOpenIds: [] } });
    await store.patchApplication(data().application.recordId, { approvalPlan: data().plan });
    await store.setPendingStage(data().application.recordId, { key: 'supervisor', version: 1, approverOpenIds: ['ou_supervisor'] });
    await store.recordStageCardDelivery(data().application.recordId, { recipientOpenId: 'ou_supervisor', messageId: 'om_test_two_level', businessKey: `leave:${data().application.recordId}:stage:supervisor:1:ou_supervisor` });
    rows = structuredClone(schedules);
    const personnel = [applicant, primary, backup, replacement].map(person => ({ ...person, recordId: person.personRecordId, buildings: ['C'], employeeNo: null, systemPosition: '', supervisorNames: [] }));
    sync = { getCachedLeaveRequestImpactSchedules: jest.fn().mockImplementation(async () => rows), getCachedActivePersonnelDirectory: jest.fn().mockResolvedValue({ personnel, selectablePersonnel: personnel, managers: [], snapshot: { fetchedAt: Date.now(), expiresAt: Date.now() + 60_000, stale: false }, quality: {} }), syncApprovedLeaveScheduleSnapshot: jest.fn().mockResolvedValue({ nonDutyRecords: 1, scheduleRecords: 1 }) };
    gateway = { patchInteractiveCard: jest.fn().mockResolvedValue(undefined) };
    detail = { assertOriginalPostFieldReady: jest.fn().mockResolvedValue(undefined), ensurePendingRows: jest.fn().mockResolvedValue(undefined), upsertCurrentAssignments: jest.fn().mockResolvedValue(undefined) };
    service = new LeaveWorkflowService(store, gateway as never, sync, detail, { canUseFeishuBusinessIdentity: () => true } as never);
  });
  afterEach(async () => {
    if (previousAppId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = previousAppId;
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('leave-two-level-service-owned-')) throw Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  });

  const observations: object[] = [];
  afterAll(async () => { if (process.env.LEAVE_STABILITY_OUTPUT) await writeFile(process.env.LEAVE_STABILITY_OUTPUT, JSON.stringify(observations, null, 2)); });
  async function makeRouter(realBackground = false, tasks: Promise<any>[] = []) {
    const activation = currentHotfixActivation(); activation.completeBootstrap(); await activation.refresh();
    const unused = { isEnabled: () => false } as never;
    if (realBackground) {
      const run = service.runPendingTasks.bind(service);
      jest.spyOn(service, 'runPendingTasks').mockImplementation(now => { const p = run(now, 1); tasks.push(p); return p; });
    } else jest.spyOn(service, 'runPendingTasks').mockResolvedValue({ processed: 0, failed: 0 });
    return new FeishuCardActionRouter(unused, service, unused, unused, unused, unused, unused, undefined, { canUseFeishuBusinessIdentity: () => true } as never);
  }
  function payload(recordId = data().application.recordId, messageId = 'om_test_two_level', eventId = 'evt_stability', actor = 'ou_supervisor', selection = data().selection) {
    return { event_type: 'card.action.trigger', event_id: eventId, operator: { open_id: actor }, context: { open_message_id: messageId }, action: { tag: 'button', name: `leave_approve_submit:${recordId}:supervisor:1:g1:r1`, form_value: {
      [`leave_shift_substitute_${Buffer.from(selection.shiftKey).toString('base64url')}`]: primary.personRecordId,
      [`leave_shift_backfill_${Buffer.from(JSON.stringify([selection.shiftKey, primary.personRecordId, selection.originalPostSignature])).toString('base64url')}`]: backup.personRecordId,
    } } };
  }
  it('stability: coalesces 30 same-action clicks, persists once and survives reopening', async () => {
    const router = await makeRouter(); const start = performance.now();
    const responses = await Promise.all(Array.from({length:30},(_,i)=>router.handle(payload(undefined,undefined,`evt_repeat_${i}`))));
    expect(responses.every(r=>r.card?.type==='raw')).toBe(true);
    expect(sync.getCachedActivePersonnelDirectory).toHaveBeenCalledTimes(1);
    const ledger = JSON.parse(await readFile(join(directory,'ledger.json'),'utf8'));
    expect(ledger.actions).toHaveLength(1);
    expect(ledger.tasks.filter((t:any)=>t.kind==='apply_stage_action')).toHaveLength(1);
    expect(ledger.tasks.filter((t:any)=>t.kind==='sync_stage_action_cards')).toHaveLength(1);
    const reopened = new LeaveWorkflowStore(join(directory,'ledger.json'));
    expect(await reopened.getStageAction(data().application.recordId,'supervisor',1)).not.toBeNull();
    observations.push({case:'30 duplicate clicks',ms:performance.now()-start,actions:ledger.actions.length,rawCards:responses.filter(r=>r.card?.type==='raw').length});
  });
  it('stability: concurrent authorized approvers share exactly one decision', async () => {
    const id=data().application.recordId;
    await store.setPendingStage(id,{key:'supervisor',version:1,approverOpenIds:['ou_supervisor','ou_supervisor_2']});
    await store.recordStageCardDelivery(id,{recipientOpenId:'ou_supervisor_2',messageId:'om_second',businessKey:`leave:${id}:stage:supervisor:1:ou_supervisor_2`});
    const router=await makeRouter();
    const responses=await Promise.all([router.handle(payload()),router.handle(payload(id,'om_second','evt_second','ou_supervisor_2'))]);
    expect(responses.every(r=>r.card?.type==='raw')).toBe(true);
    expect(responses.filter(r=>r.toast.type==='info')).toHaveLength(1);
    const ledger=JSON.parse(await readFile(join(directory,'ledger.json'),'utf8'));
    expect(ledger.actions).toHaveLength(1);
    observations.push({case:'2 authorized approvers',actions:ledger.actions.length,acceptedResponses:responses.filter(r=>r.toast.type==='info').length});
  });
  it('stability: failed atomic save reports failure and retry accepts exactly once', async () => {
    const router=await makeRouter(), fs=require('node:fs/promises');
    const original=await readFile(join(directory,'ledger.json'),'utf8');
    const rename=jest.spyOn(fs,'rename').mockRejectedValue(Object.assign(new Error('synthetic write denied'),{code:'EACCES'}));
    let failed;
    try { failed=await router.handle(payload()); } finally { rename.mockRestore(); }
    expect(failed.toast.type).toBe('error'); expect(failed.card).toBeUndefined();
    expect(await readFile(join(directory,'ledger.json'),'utf8')).toBe(original);
    const recovered=await router.handle(payload(undefined,undefined,'evt_retry_after_io'));
    expect(recovered.card?.type).toBe('raw');
    const ledger=JSON.parse(await readFile(join(directory,'ledger.json'),'utf8'));
    expect(ledger.actions).toHaveLength(1);
    observations.push({case:'atomic save failure and retry',failureToast:failed.toast.type,retryRawCard:recovered.card?.type==='raw',actions:ledger.actions.length});
  });
  it('stability: real background bookkeeping progresses during 40 queued business writes', async () => {
    const file=join(directory,'ledger.json'), ledger=JSON.parse(await readFile(file,'utf8')); ledger.tasks=[];await writeFile(file,JSON.stringify(ledger));
    await store.enqueueTask({recordId:data().application.recordId,businessKey:'stability-background',kind:'sync_leave_shift_details'});
    const task=(await store.takeNextTask())!;
    let release!:()=>void;const gate=new Promise<void>(resolve=>release=resolve);
    const active=(store as any).enqueue(()=>gate,false); await new Promise<void>(resolve=>setImmediate(resolve));
    const order:string[]=[];
    const background=store.completeTask(task.key,task.claimToken).then(()=>order.push('background'));
    const writes=Array.from({length:40},(_,i)=>store.patchApplication(data().application.recordId,{lastError:`iteration-${i}`}).then(()=>order.push(`write-${i}`)));
    release(); await Promise.all([active,background,...writes]);
    expect(order.indexOf('background')).toBeLessThanOrEqual(4);
    expect((await store.getApplication(data().application.recordId))?.lastError).toBe('iteration-39');
    expect((await store.listTasks()).find(t=>t.key===task.key)?.status).toBe('completed');
    observations.push({case:'40 business writes with background completion',backgroundPosition:order.indexOf('background'),lastWritePreserved:true,taskCompleted:true});
  });
  it.each([{count:4,conflict:true},{count:4,conflict:false},{count:8,conflict:false},{count:16,conflict:false},{count:8,conflict:false,background:true},{count:16,conflict:false,background:true}])('stability: $count simultaneous approvals, candidate conflict=$conflict, background=$background, cold 10MB ledger',async ({count,conflict,background=false})=>{
    const file=join(directory,'ledger.json'),ledger=JSON.parse(await readFile(file,'utf8')),base=ledger.applications[0];
    const datasets=Array.from({length:count},(_,i)=>{
      const day=`2026-11-${String(i+1).padStart(2,'0')}`;
      const source=JSON.stringify({...data(),roster:schedules});
      const set=JSON.parse(conflict?source:source.replaceAll('2026-10-16',day).replaceAll('rec_schedule_d',`rec_schedule_d_${i}`).replaceAll('rec_schedule_c',`rec_schedule_c_${i}`));
      set.selection.originalPostSignature=require('../../server/modules/leave-workflow/leave-two-level-substitution').originalPostSignature(set.originalGroups);
      return set;
    });
    rows=conflict?structuredClone(schedules):datasets.flatMap(set=>set.roster);
    const people=Array.from({length:160},(_,i)=>({personRecordId:`rec_load_person_${i}`,name:`TEST_${i}`,openId:`ou_load_${i}`,position:'运维值班员',buildings:['C楼']}));
    ledger.applications=Array.from({length:237},(_,i)=>({...base,key:`leave:rec_load_${i}`,recordId:`rec_load_${i}`,clientMutationId:`load_${i}`,snapshot:i<count?datasets[i].application.snapshot:{...base.snapshot,substituteCandidates:people,candidateSets:[{shiftKey:data().selection.shiftKey,candidates:people}]},stageCards:[{...base.stageCards[0],messageId:`om_load_${i}`,businessKey:`leave:rec_load_${i}:stage:supervisor:1:ou_supervisor`}]}));
    ledger.tasks=Array.from({length:1543},(_,i)=>({key:`load_task_${i}`,businessKey:`load_task_${i}`,recordId:'rec_load_0',kind:'route_application',payload:{},status:'completed',attempts:1,createdAt:base.createdAt,updatedAt:base.updatedAt,nextAttemptAt:base.createdAt,leaseUntil:'',claimToken:'',completedAt:base.updatedAt,lastError:''}));
    const text=JSON.stringify(ledger);expect(Buffer.byteLength(text)).toBeGreaterThan(9_000_000);await writeFile(file,text);
    store=new LeaveWorkflowStore(file);service=new LeaveWorkflowService(store,gateway as never,sync,detail,{canUseFeishuBusinessIdentity:()=>true} as never);
    const cloud = new Map<string,object>();
    Object.assign(gateway, {updateLeaveRecord:jest.fn(async(id:string,fields:object)=>cloud.set(id,{...cloud.get(id),...fields})),readLeaveRecord:jest.fn(async(id:string)=>({record_id:id,fields:cloud.get(id)||{}}))});
    const tasks:Promise<any>[]=[];
    const router=await makeRouter(background,tasks), pending:Promise<any>[]=[];
    const accept=service.acceptApprovalAction.bind(service);
    jest.spyOn(service,'acceptApprovalAction').mockImplementation(input=>{const p=accept(input);pending.push(p);return p;});
    const start=performance.now();
    const responses=await Promise.all(Array.from({length:count},(_,i)=>router.handle(payload(`rec_load_${i}`,`om_load_${i}`,`evt_load_${i}`,'ou_supervisor',datasets[i].selection)).then(response=>({response,ms:performance.now()-start}))));
    const finished=await Promise.allSettled(pending);
    const workers=await Promise.allSettled(tasks);
    const persisted=JSON.parse(await readFile(file,'utf8'));
    const warningCount=responses.filter(r=>r.response.toast.content.includes('处理时间较长')).length;
    observations.push({case:`${count} concurrent approvals`,conflict,background,workerFailures:workers.filter((r:any)=>r.status==='rejected'||r.value.failed>0).length,cardPatches:gateway.patchInteractiveCard.mock.calls.length,ledgerBytes:Buffer.byteLength(text),timesMs:responses.map(r=>r.ms),maxMs:Math.max(...responses.map(r=>r.ms)),warningCount,rawCardCount:responses.filter(r=>r.response.card?.type==='raw').length,durableActions:persisted.actions.length,acceptanceFailures:finished.filter(r=>r.status==='rejected').length,failureMessages:finished.filter(r=>r.status==='rejected').map((r:any)=>String(r.reason?.message)),allSettledMs:performance.now()-start});
    expect(persisted.actions).toHaveLength(conflict?1:count);expect(finished.filter(r=>r.status==='rejected')).toHaveLength(conflict?count-1:0);
    if(conflict) expect(finished.filter(r=>r.status==='rejected').every((r:any)=>r.reason.message.includes('已被其他请假安排占用'))).toBe(true);
    expect(workers.filter((r:any)=>r.status==='rejected'||r.value.failed>0)).toHaveLength(0);
    if(background) expect(gateway.patchInteractiveCard.mock.calls.length).toBeGreaterThan(0);
    expect(warningCount).toBe(0);
  },30000);
});
