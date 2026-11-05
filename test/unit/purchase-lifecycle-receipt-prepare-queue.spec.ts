import { acceptReceiptPrepare, finishReceiptPrepare, leaseReceiptPrepare, normalizeReceiptPrepareQueue, type ReceiptPrepareIdentity } from '../../server/modules/purchase-inventory/purchase-lifecycle-receipt-prepare-queue';

const now=1_800_000_000_000;
const identity:ReceiptPrepareIdentity={appId:'cli_test',eventId:'event_one',actorOpenId:'ou_user',chatId:'oc_private',cardMessageId:'om_card',approvalBatchId:'purchase-batch-1',executionRecordId:'rec_one',cardRevision:1,materialType:'receipt_photo',flowVersion:'lifecycle_v1'};
const empty=()=>({version:1,tasks:[]});
describe('签收图片准备任务纯队列',()=>{
  it('受理保存完整身份并幂等重放，同一事件改变内容拒绝',()=>{
    const accepted=acceptReceiptPrepare(empty(),identity,now);expect(accepted.created).toBe(true);expect(accepted.task.identity).toEqual(identity);
    const replay=acceptReceiptPrepare(accepted.queue,identity,now+1);expect(replay.created).toBe(false);expect(replay.task.taskId).toBe(accepted.task.taskId);
    expect(()=>acceptReceiptPrepare(accepted.queue,{...identity,executionRecordId:'rec_other'},now+1)).toThrow();
    expect(()=>acceptReceiptPrepare(accepted.queue,{...identity,chatId:'oc_other'},now+1)).toThrow();
  });
  it('租约到期后可恢复，旧领取凭证不能生成意向',()=>{
    const accepted=acceptReceiptPrepare(empty(),identity,now),first=leaseReceiptPrepare(accepted.queue,accepted.task.taskId,'lease_first',now+1,1000);
    expect(()=>leaseReceiptPrepare(first,accepted.task.taskId,'lease_second',now+500,1000)).toThrow();
    const second=leaseReceiptPrepare(first,accepted.task.taskId,'lease_second',now+1002,1000);
    expect(()=>finishReceiptPrepare(second,accepted.task.taskId,'lease_first',now+1003,{intentId:'intent_1234567890'})).toThrow();
    const complete=finishReceiptPrepare(second,accepted.task.taskId,'lease_second',now+1003,{intentId:'intent_1234567890'});
    expect(complete.tasks[0]).toMatchObject({state:'completed',intentId:'intent_1234567890',attempts:2,refreshPending:true});
  });
  it('私聊无法验证只标记失败并要求原卡反馈，不能伪造意向',()=>{
    const accepted=acceptReceiptPrepare(empty(),identity,now),leased=leaseReceiptPrepare(accepted.queue,accepted.task.taskId,'lease_one',now+1,1000);
    const failed=finishReceiptPrepare(leased,accepted.task.taskId,'lease_one',now+2,{failure:'chat_unverified'});
    expect(failed.tasks[0]).toMatchObject({state:'failed',intentId:'',failure:'chat_unverified',refreshPending:true});
    expect(()=>leaseReceiptPrepare(failed,accepted.task.taskId,'lease_new',now+2000,1000)).toThrow();
  });
  it('损坏身份、租约或持久更新状态必须拒绝',()=>{
    const accepted=acceptReceiptPrepare(empty(),identity,now),leased=leaseReceiptPrepare(accepted.queue,accepted.task.taskId,'lease_one',now+1,1000);
    const damaged=structuredClone(leased);damaged.tasks[0]!.identity.cardRevision=2;expect(()=>normalizeReceiptPrepareQueue(damaged)).toThrow();
    const invalid=structuredClone(leased);invalid.tasks[0]!.leaseUntilMs=0;expect(()=>normalizeReceiptPrepareQueue(invalid)).toThrow();
    expect(()=>finishReceiptPrepare(leased,accepted.task.taskId,'lease_one',now+1001,{intentId:'intent_1234567890'})).toThrow();
  });
});
