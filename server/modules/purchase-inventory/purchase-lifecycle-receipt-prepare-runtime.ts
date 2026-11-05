import { PurchaseLifecycleReceiptPrepareCoordinator, type LifecycleReceiptPrepareInput, type LifecycleReceiptPrepareLease, type LifecycleReceiptPrepareStore, type LifecycleReceiptPrivateChatVerifier } from './purchase-lifecycle-receipt-prepare-coordinator';
import type { PurchaseManagerApprovalBatchEntry, PurchaseManagerApprovalBatchItemEntry } from './purchase-workflow.store';
import { cancelHotfixInitialization, currentHotfixActivation, runHotfixInitialization } from '../../common/hotfix-runtime-activation';

type Authority=(batch:PurchaseManagerApprovalBatchEntry,item:PurchaseManagerApprovalBatchItemEntry)=>void;
/** This port must use the existing purchase ledger lock for every mutation. */
export interface LifecycleReceiptPrepareRuntimeStore {
  acceptLifecycleReceiptPrepare(input:LifecycleReceiptPrepareInput,authorize:Authority):Promise<{taskId:string;status:'pending'|'ready'|'failed'}>;
  claimLifecycleReceiptPrepare(taskId:string):Promise<LifecycleReceiptPrepareLease|null>;
  completeLifecycleReceiptPrepare(lease:LifecycleReceiptPrepareLease,verifyPrivateChat:()=>void,authorize:Authority):Promise<void>;
  failLifecycleReceiptPrepare(lease:LifecycleReceiptPrepareLease):Promise<void>;
  listRecoverableLifecycleReceiptPrepare(afterTaskId:string,limit:number):Promise<string[]>;
}

/** Isolated runtime, deliberately not registered as a production provider. */
export class PurchaseLifecycleReceiptPrepareRuntime {
  private timer:ReturnType<typeof setTimeout>|undefined;
  private enabled=false;
  private generation=0;
  private cursor='';
  private scanning=false;
  private destroyed=false;
  private readonly inFlight=new Map<string,Promise<unknown>>();
  constructor(private readonly store:LifecycleReceiptPrepareRuntimeStore,private readonly verifier:LifecycleReceiptPrivateChatVerifier,
    private readonly currentAuthority:(input:LifecycleReceiptPrepareInput,batch:PurchaseManagerApprovalBatchEntry,item:PurchaseManagerApprovalBatchItemEntry)=>void,
    private readonly options:{enabled?:boolean;intervalMs?:number}={}) {}
  onModuleInit():Promise<void> { return runHotfixInitialization(this,()=>{if(!this.destroyed && this.options.enabled===true)this.startRecovery(this.options.intervalMs);}); }
  async onModuleDestroy():Promise<void> { this.destroyed=true;this.stopRecovery();await cancelHotfixInitialization(this); }
  private canProcess():boolean { return !this.destroyed && currentHotfixActivation().isAcceptingNewWork(); }
  private assertActivation():void { if(!this.canProcess())throw new Error('系统更新中，签收附件暂缓处理'); }
  async accept(input:LifecycleReceiptPrepareInput,authorize:Authority):Promise<{taskId:string;status:'pending'|'ready'|'failed'}> {
    this.assertActivation();
    if (!this.store || !this.verifier || typeof this.currentAuthority!=='function' || typeof authorize!=='function') throw new Error('采购签收附件尚未就绪');
    return this.store.acceptLifecycleReceiptPrepare(input,(batch,item)=>{this.assertActivation();authorize(batch,item);});
  }
  schedule(taskId:string):void {
    if (!/^receipt-prepare-[a-f0-9]{64}$/.test(taskId)) throw new Error('签收附件准备任务无效');
    if (!this.canProcess() || this.inFlight.has(taskId)) return;
    const pending=new Promise<void>(resolve=>setImmediate(resolve)).then(()=>this.process(taskId)).catch(()=>undefined).finally(()=>{this.inFlight.delete(taskId);});
    this.inFlight.set(taskId,pending);
  }
  private async process(taskId:string):Promise<void> {
    this.assertActivation();
    let authorizationInput:LifecycleReceiptPrepareInput|undefined;
    const adapter:LifecycleReceiptPrepareStore={
      accept:async()=>{throw new Error('不支持从后台重复创建准备任务');},
      claim:async id=>{const lease=await this.store.claimLifecycleReceiptPrepare(id);authorizationInput=lease?.input;return lease;},
      complete:(lease,verify,authorize)=>this.store.completeLifecycleReceiptPrepare(lease,verify,(batch,item)=>{this.assertActivation();authorize();this.currentAuthority(lease.input,batch,item);}),
      // A release pause is not a business failure. Leave the durable lease for
      // recovery instead of turning an accepted request into a failed card.
      fail:lease=>this.canProcess()?this.store.failLifecycleReceiptPrepare(lease):Promise.resolve(),
    };
    const coordinator=new PurchaseLifecycleReceiptPrepareCoordinator(adapter,this.verifier,()=>{if(!authorizationInput)throw new Error('签收附件准备身份缺失');});
    await coordinator.process(taskId);
  }
  startRecovery(intervalMs=60_000):void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs<1000 || intervalMs>3_600_000) throw new Error('签收附件恢复间隔无效');
    if(this.enabled)return;this.enabled=true;const generation=++this.generation;
    const tick=()=>{this.timer=undefined;if(!this.enabled||this.generation!==generation)return;
      void this.recoverOnce(()=>this.enabled && this.generation===generation).catch(()=>undefined).finally(()=>{if(this.enabled&&this.generation===generation){this.timer=setTimeout(tick,intervalMs);this.timer.unref?.();}});};
    this.timer=setTimeout(tick,0);this.timer.unref?.();
  }
  stopRecovery():void {this.enabled=false;this.generation++;if(this.timer)clearTimeout(this.timer);this.timer=undefined;}
  async recoverOnce(shouldContinue:()=>boolean=()=>true):Promise<void> {
    if(this.scanning||!this.canProcess())return;this.scanning=true;
    try {const ids=await this.store.listRecoverableLifecycleReceiptPrepare(this.cursor,20);if(!ids.length){this.cursor='';return;}
      for(const id of ids){if(!shouldContinue()||!this.canProcess())return;this.cursor=id;this.schedule(id);}if(ids.length<20)this.cursor='';
    } finally {this.scanning=false;}
  }
}
