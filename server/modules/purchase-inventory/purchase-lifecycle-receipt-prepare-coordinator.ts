import type { LifecyclePrivateChatIdentity, LifecyclePrivateChatProof } from './purchase-lifecycle-private-chat-verifier';

/** All fields come from a verified card callback, never from form values alone. */
export type LifecycleReceiptPrepareInput = LifecyclePrivateChatIdentity & Readonly<{
  eventId:string; approvalBatchId:string; executionRecordId:string; cardRevision:number;
  materialType:'receipt_photo'|'invoice';
}>;
export type LifecycleReceiptPrepareLease = Readonly<{ taskId:string; leaseToken:string; input:LifecycleReceiptPrepareInput }>;
export interface LifecycleReceiptPrepareStore {
  /** Atomically binds event to actor/message/revision and checks current authorization. */
  accept(input:LifecycleReceiptPrepareInput, authorize:()=>void):Promise<{taskId:string;accepted:boolean}>;
  claim(taskId:string):Promise<LifecycleReceiptPrepareLease|null>;
  /** Under the same lock, check the lease, callback identity, current authorization,
   * private-chat proof, competing intents, create the intent and enqueue card refresh. */
  complete(lease:LifecycleReceiptPrepareLease, verifyPrivateChat:()=>void, authorize:()=>void):Promise<void>;
  /** Failure must keep task state and queue an explicit failure view, not an upload prompt. */
  fail(lease:LifecycleReceiptPrepareLease):Promise<void>;
}
export interface LifecycleReceiptPrivateChatVerifier {
  verify(identity:LifecyclePrivateChatIdentity):Promise<LifecyclePrivateChatProof>;
  assertProof(proof:LifecyclePrivateChatProof,identity:LifecyclePrivateChatIdentity):void;
}

/** Isolated coordinator. The live provider remains disabled until the durable
 * store and authenticated Feishu transport satisfy these ports. */
export class PurchaseLifecycleReceiptPrepareCoordinator {
  constructor(private readonly store:LifecycleReceiptPrepareStore | undefined,
    private readonly verifier:LifecycleReceiptPrivateChatVerifier | undefined,
    private readonly authorize:(input:LifecycleReceiptPrepareInput)=>void) {}

  async accept(input:LifecycleReceiptPrepareInput):Promise<{taskId:string;accepted:boolean}> {
    if (!this.store || !this.verifier || typeof this.authorize !== 'function') throw new Error('采购签收附件尚未就绪');
    const copy=structuredClone(input);
    return this.store.accept(copy,()=>this.authorize(copy));
  }

  async process(taskId:string):Promise<'busy'|'ready'|'failed'> {
    if (!this.store || !this.verifier || typeof this.authorize !== 'function') throw new Error('采购签收附件尚未就绪');
    const lease=await this.store.claim(taskId);
    if (!lease) return 'busy';
    if (lease.taskId!==taskId || !lease.leaseToken) throw new Error('签收附件准备任务租约无效');
    const identity:LifecyclePrivateChatIdentity={appId:lease.input.appId,actorOpenId:lease.input.actorOpenId,cardMessageId:lease.input.cardMessageId,chatId:lease.input.chatId};
    try {
      const proof=await this.verifier.verify(identity);
      await this.store.complete(lease,()=>this.verifier!.assertProof(proof,identity),()=>this.authorize(lease.input));
      return 'ready';
    } catch {
      // Do not claim an intent was created when the proof, authorization or
      // durable commit failed. The store enforces the lease and recovery policy.
      await this.store.fail(lease);
      return 'failed';
    }
  }
}
