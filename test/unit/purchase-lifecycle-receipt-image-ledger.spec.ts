import { createLifecycleReceiptImageVerifier, extractVerifiedLifecycleReceiptImage, matchVerifiedLifecycleReceiptImage, type LifecycleReceiptImageIntent, type VerifiedLifecycleReceiptImage } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-image-binding';
import { assertReceiptImageLease, bindReceiptImage, findReceiptImageReplay, leaseReceiptImageTask, normalizeReceiptImageLedger, recordReceiptImageReplay, transitionReceiptImageTask, type ReceiptImageLedger } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-image-ledger';

const now=1_800_000_000_000;
const event:VerifiedLifecycleReceiptImage={appId:'cli_test',eventId:'event_1',actorOpenId:'ou_user',chatId:'oc_chat',imageMessageId:'om_image',imageKey:'img_one',messageCreatedAtMs:now-1000,senderType:'user',chatType:'p2p',messageType:'image'};
const intent:LifecycleReceiptImageIntent={id:'intent_1234567890',appId:'cli_test',actorOpenId:'ou_user',chatId:'oc_chat',approvalBatchId:'purchase-batch-1',executionRecordId:'rec_one',cardMessageId:'om_card',cardRevision:1,materialType:'receipt_photo',flowVersion:'lifecycle_v1',createdAtMs:now-2000,expiresAtMs:now+10000};
const empty=():ReceiptImageLedger=>({version:1,intents:[{...intent,state:'open',taskId:''}],events:[],tasks:[]});
const snapshot=async(value=event)=>createLifecycleReceiptImageVerifier(async()=>value).verify({},'cli_test');
const binding=async(value=event)=>matchVerifiedLifecycleReceiptImage(await snapshot(value),'cli_test',[intent],now);
describe('签收图片隔离账本模型',()=>{
  it('绑定唯一意向和任务，精确重放与同消息新事件返回原任务',async()=>{
    const first=bindReceiptImage(empty(),await binding(),'task_123');expect(first.created).toBe(true);
    const retry=bindReceiptImage(first.ledger,await binding(),'task_ignored');expect(retry.created).toBe(false);expect(retry.task.taskId).toBe('task_123');
    const alias=bindReceiptImage(retry.ledger,await binding({...event,eventId:'event_2'}),'task_ignored');expect(alias.created).toBe(false);expect(alias.ledger.events).toHaveLength(2);
    const keys=extractVerifiedLifecycleReceiptImage(await snapshot({...event,eventId:'event_2'}),'cli_test');expect(findReceiptImageReplay(alias.ledger,keys)?.taskId).toBe('task_123');
  });
  it('过期后仍可凭可信消息记录新事件别名，且该别名不可复用到其他内容',async()=>{
    const first=bindReceiptImage(empty(),await binding(),'task_123');
    const later=await snapshot({...event,eventId:'event_later'}),keys=extractVerifiedLifecycleReceiptImage(later,'cli_test');
    expect(()=>matchVerifiedLifecycleReceiptImage(later,'cli_test',[intent],intent.expiresAtMs+1)).toThrow();
    const replay=recordReceiptImageReplay(first.ledger,keys)!;expect(replay.task.taskId).toBe('task_123');expect(replay.ledger.events).toHaveLength(2);
    const changed=extractVerifiedLifecycleReceiptImage(await snapshot({...event,eventId:'event_later',imageMessageId:'om_other'}),'cli_test');
    expect(()=>recordReceiptImageReplay(replay.ledger,changed)).toThrow();
  });
  it('事件或消息键相同但内容被修改时拒绝',async()=>{
    const first=bindReceiptImage(empty(),await binding(),'task_123');
    const altered=await binding({...event,imageKey:'img_other'});
    expect(()=>bindReceiptImage(first.ledger,altered,'task_other')).toThrow();
    const otherMessage=await binding({...event,imageMessageId:'om_other'});
    expect(()=>bindReceiptImage(first.ledger,otherMessage,'task_other')).toThrow();
  });
  it('上传未知时不能伪造成可重传或已上传，引用缺失和重复键必须拒绝',async()=>{
    const first=bindReceiptImage(empty(),await binding(),'task_123');
    const dispatch=structuredClone(first.ledger);dispatch.tasks[0]!.state='dispatching';dispatch.tasks[0]!.dispatchStartedAtMs=now;expect(normalizeReceiptImageLedger(dispatch).tasks[0]!.state).toBe('dispatching');
    const manual=structuredClone(dispatch);manual.tasks[0]!.state='manual_reconciliation';expect(normalizeReceiptImageLedger(manual).tasks[0]!.fileToken).toBe('');
    const fake=structuredClone(manual);fake.tasks[0]!.fileToken='token_forged';expect(()=>normalizeReceiptImageLedger(fake)).toThrow();
    const reset=structuredClone(manual);reset.tasks[0]!.state='ready';expect(()=>normalizeReceiptImageLedger(reset)).toThrow();
    const missing=structuredClone(first.ledger);missing.events=[];expect(()=>normalizeReceiptImageLedger(missing)).toThrow();
    const duplicate=structuredClone(first.ledger);duplicate.events.push({...duplicate.events[0]!});expect(()=>normalizeReceiptImageLedger(duplicate)).toThrow();
  });
  it('发送围栏后仅允许确认或待核对，确认后只能完成且幂等',async()=>{
    const first=bindReceiptImage(empty(),await binding(),'task_123');
    const dispatched=transitionReceiptImageTask(first.ledger,'task_123','dispatch');
    expect(()=>transitionReceiptImageTask(dispatched,'task_123','dispatch')).toThrow();
    const manual=transitionReceiptImageTask(dispatched,'task_123','uncertain');
    expect(()=>transitionReceiptImageTask(manual,'task_123','dispatch')).toThrow();
    expect(()=>transitionReceiptImageTask(manual,'task_123','uploaded','guessed_token')).toThrow();
    const uploaded=transitionReceiptImageTask(dispatched,'task_123','uploaded','token_ok');
    expect(transitionReceiptImageTask(uploaded,'task_123','uploaded','token_ok')).toEqual(uploaded);
    expect(()=>transitionReceiptImageTask(uploaded,'task_123','uploaded','another_token')).toThrow();
    const done=transitionReceiptImageTask(uploaded,'task_123','complete');
    expect(done.intents[0]!.state).toBe('completed');expect(transitionReceiptImageTask(done,'task_123','complete')).toEqual(done);
  });
  it('持久租约要求起止时间和新凭证，重启读取后拒绝回到起点之前或过期',async()=>{
    const first=bindReceiptImage(empty(),await binding(),'task_123'),a='123e4567-e89b-42d3-a456-426614174000',b='123e4567-e89b-42d3-a456-426614174001';
    const leased=leaseReceiptImageTask(first.ledger,'task_123',a,now,60000);
    const restarted=JSON.parse(JSON.stringify(leased.ledger));
    expect(assertReceiptImageLease(restarted,'task_123',a,now).leaseStartedAtMs).toBe(now);
    expect(()=>assertReceiptImageLease(restarted,'task_123',a,now-1)).toThrow();
    expect(()=>assertReceiptImageLease(restarted,'task_123',a,now+60000)).toThrow();
    expect(()=>leaseReceiptImageTask(restarted,'task_123',b,now-1,60000)).toThrow();
    expect(()=>leaseReceiptImageTask(restarted,'task_123',b,now+1,60000)).toThrow();
    expect(()=>leaseReceiptImageTask(restarted,'task_123',a,now+60000,60000)).toThrow();
    const second=leaseReceiptImageTask(restarted,'task_123',b,now+60000,60000);
    expect(()=>assertReceiptImageLease(second.ledger,'task_123',a,now+60001)).toThrow();
    expect(assertReceiptImageLease(second.ledger,'task_123',b,now+60001).leaseUntilMs).toBe(now+120000);
  });
  it('锁内按最新快照只能认领一次；未知发送的续租不得回到 ready',async()=>{
    const first=bindReceiptImage(empty(),await binding(),'task_123'),a='123e4567-e89b-42d3-a456-426614174000',b='123e4567-e89b-42d3-a456-426614174001';
    const acquired=leaseReceiptImageTask(first.ledger,'task_123',a,now,1000);
    expect(()=>leaseReceiptImageTask(acquired.ledger,'task_123',b,now,1000)).toThrow();
    const dispatched=transitionReceiptImageTask(acquired.ledger,'task_123','dispatch','',now);
    const recovered=leaseReceiptImageTask(JSON.parse(JSON.stringify(dispatched)),'task_123',b,now+1000,1000);
    expect(recovered.task.state).toBe('dispatching');expect(()=>transitionReceiptImageTask(recovered.ledger,'task_123','dispatch','',now+1001)).toThrow();
  });
  it('拒绝空凭证残留时间、颠倒时间或超长租约',async()=>{
    const first=bindReceiptImage(empty(),await binding(),'task_123'),bad=structuredClone(first.ledger);
    bad.tasks[0]!.leaseStartedAtMs=now;expect(()=>normalizeReceiptImageLedger(bad)).toThrow();
    bad.tasks[0]!.leaseToken='123e4567-e89b-42d3-a456-426614174000';bad.tasks[0]!.leaseUntilMs=now;expect(()=>normalizeReceiptImageLedger(bad)).toThrow();
    bad.tasks[0]!.leaseUntilMs=now+600001;expect(()=>normalizeReceiptImageLedger(bad)).toThrow();
  });
});
