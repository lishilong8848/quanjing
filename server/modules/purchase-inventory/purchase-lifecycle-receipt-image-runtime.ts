import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { createHash } from 'node:crypto';
import { AccessConfigurationService } from '../../common/access/access-configuration.service';
import { getEffectiveFeishuAppCredentials, parseFeishuBitableLink, readEnv } from '../../common/config/external-services.config';
import { currentHotfixActivation } from '../../common/hotfix-runtime-activation';
import { canPerformBusinessAction } from '../../../shared/business-permissions';
import { purchaseAuthorityTarget } from './purchase-authority-target';
import { mapExecutionRecord } from './purchase-workflow.gateway';
import { resolvePurchaseStage } from './purchase-workflow.rules';
import { PurchaseWorkflowStore, type LifecycleReceiptImageAuthorizationContext, type PurchaseManagerApprovalBatchEntry, type PurchaseManagerApprovalBatchItemEntry } from './purchase-workflow.store';
import type { LifecycleReceiptPrepareInput } from './purchase-lifecycle-receipt-prepare-coordinator';
import { PurchaseLifecycleCardTransport } from './purchase-lifecycle-card-transport';
import { createLifecycleReceiptFeishuTransport } from './purchase-lifecycle-receipt-feishu-transport';
import { createPurchaseLifecycleReceiptEventVerifier } from './purchase-lifecycle-receipt-event-verifier';
import { createLifecyclePrivateChatVerifier } from './purchase-lifecycle-private-chat-verifier';
import { createLifecycleReceiptImageStoreAdapter } from './purchase-lifecycle-receipt-image-store-adapter';
import { PurchaseLifecycleReceiptImageCoordinator, type LifecycleReceiptImageStore } from './purchase-lifecycle-receipt-image-coordinator';

type Source={appId:string;appSecret:string;appToken:string;tableId:string};
type Options={readSource?:()=>Source;enabled?:()=>boolean;acceptingWork?:()=>boolean;intervalMs?:number;reportFailure?:(code:string)=>void};
export const PURCHASE_LIFECYCLE_RECEIPT_IMAGE_RUNTIME_OPTIONS='PURCHASE_LIFECYCLE_RECEIPT_IMAGE_RUNTIME_OPTIONS';
function configuredSource():Source {
  const credentials=getEffectiveFeishuAppCredentials(),link=parseFeishuBitableLink(readEnv('FEISHU_PURCHASE_INVENTORY_SOURCE_URL'));
  return {...credentials,appToken:readEnv('FEISHU_PURCHASE_INVENTORY_APP_TOKEN')||link.appToken,tableId:readEnv('FEISHU_PURCHASE_EXECUTION_TABLE_ID')};
}
function sourceFingerprint(source:Source):string{return createHash('sha256').update(JSON.stringify([source.appId,source.appToken,source.tableId])).digest('hex');}
function sameSource(a:Source,b:Source):boolean{return a.appId===b.appId&&a.appSecret===b.appSecret&&a.appToken===b.appToken&&a.tableId===b.tableId;}

/** One module-scoped worker over the original purchase ledger. Construction never calls a network or starts a timer. */
@Injectable()
export class PurchaseLifecycleReceiptImageRuntime implements OnModuleDestroy {
  private readonly logger=new Logger(PurchaseLifecycleReceiptImageRuntime.name);
  private bound:Source|undefined;
  private epoch=0;
  private running=false;
  private timer:ReturnType<typeof setTimeout>|undefined;
  private readonly work=new Map<string,Promise<unknown>>();
  private cursor='';
  private scanning=false;
  private starting:Promise<void>|undefined;
  private readonly transport:ReturnType<typeof createLifecycleReceiptFeishuTransport>;
  readonly privateChatVerifier:ReturnType<typeof createLifecyclePrivateChatVerifier>;
  private readonly verifier:ReturnType<typeof createPurchaseLifecycleReceiptEventVerifier>;
  constructor(private readonly access:AccessConfigurationService,private readonly store:PurchaseWorkflowStore,private readonly http:HttpService,
    private readonly ingress:PurchaseLifecycleCardTransport,@Optional() @Inject(PURCHASE_LIFECYCLE_RECEIPT_IMAGE_RUNTIME_OPTIONS) private readonly options:Options={}) {
    this.transport=createLifecycleReceiptFeishuTransport({readConfig:()=>{this.assertGate();return {...this.bound!};},http:http.axiosRef,isAuthenticatedWsDelivery:(payload,appId)=>ingress.isAuthenticatedWsDelivery(payload,appId)});
    this.verifier=createPurchaseLifecycleReceiptEventVerifier(this.transport);
    const chats=createLifecyclePrivateChatVerifier(this.transport);
    this.privateChatVerifier={verify:async identity=>{await this.verifySource();const proof=await chats.verify(identity);this.assertGate();return proof;},assertProof:(proof,identity)=>{this.assertGate();chats.assertProof(proof,identity);}};
  }
  private enabled():boolean{return this.options.enabled?.()===true;}
  private accepting():boolean{return this.options.acceptingWork ? this.options.acceptingWork()===true : currentHotfixActivation().isAcceptingNewWork();}
  private source():Source {const s=(this.options.readSource||configuredSource)();if(!s||!/^cli_[A-Za-z0-9_-]+$/.test(s.appId)||!s.appSecret||!/^[A-Za-z0-9_-]{1,160}$/.test(s.appToken)||!/^tbl[A-Za-z0-9_-]+$/.test(s.tableId))throw new Error('采购签收图片来源未配置');return {...s};}
  private assertGate(epoch=this.epoch):void {if(!this.running || !this.bound || epoch!==this.epoch || !this.enabled() || !this.accepting() || !sameSource(this.bound,this.source()))throw new Error('采购签收图片处理尚未就绪或来源已变化');}
  isReady():boolean {try{this.assertGate();return this.ingress.isReady();}catch{return false;}}
  async start():Promise<void>{
    if(this.starting)return this.starting;if(this.running)return;
    const interval=this.options.intervalMs??5000;if(!Number.isSafeInteger(interval)||interval<1000||interval>3_600_000)throw new Error('签收图片恢复间隔无效');
    if(!this.enabled()||!this.accepting())throw new Error('采购签收图片处理未启用');const epoch=++this.epoch;
    const pending=(async()=>{const bound=this.source();await this.store.bindLifecycleReceiptImageSource(bound.appId,sourceFingerprint(bound));if(epoch!==this.epoch||!this.enabled()||!this.accepting()||!sameSource(bound,this.source()))throw new Error('采购签收图片来源已变化');this.bound=bound;this.running=true;this.scheduleScan();})();
    this.starting=pending;try{await pending;}finally{if(this.starting===pending)this.starting=undefined;}
  }
  private report():void {this.logger.error('采购签收图片后台处理失败，原任务保留待核对');try{this.options.reportFailure?.('PURCHASE_RECEIPT_IMAGE_PROCESS_FAILED');}catch{/* diagnostics cannot alter a claim */}}
  private scheduleScan():void {const ms=this.options.intervalMs??5000;if(!Number.isSafeInteger(ms)||ms<1000||ms>3_600_000)throw new Error('签收图片恢复间隔无效');const epoch=this.epoch;
    this.timer=setTimeout(()=>{this.timer=undefined;if(!this.running||epoch!==this.epoch)return;void this.recoverOnce().catch(()=>this.report()).finally(()=>{if(this.running&&epoch===this.epoch)this.scheduleScan();});},ms);this.timer.unref?.();}
  async onModuleDestroy():Promise<void>{this.running=false;this.epoch++;if(this.timer)clearTimeout(this.timer);this.timer=undefined;await Promise.allSettled([...this.work.values(),...(this.starting?[this.starting]:[])]);}
  private authorize(context:LifecycleReceiptImageAuthorizationContext,epoch:number):void {
    this.assertGate(epoch);this.assertPreparationAuthority(context.intent,context.batch,context.item);
  }
  /** The caller must already possess a transport-verified card input and invoke
   * this synchronously inside the store's preparation or attachment transaction. */
  assertPreparationAuthority(input:Pick<LifecycleReceiptPrepareInput,'appId'|'actorOpenId'|'executionRecordId'|'approvalBatchId'|'materialType'>,batch:PurchaseManagerApprovalBatchEntry,item:PurchaseManagerApprovalBatchItemEntry):void {
    this.assertGate();const appId=this.bound!.appId;
    if(batch.flowVersion!=='lifecycle_v1'||batch.lifecycleAppId!==appId||input.appId!==appId||batch.requesterOpenId!==input.actorOpenId||item.executionRecordId!==input.executionRecordId||batch.approvalBatchId!==input.approvalBatchId||input.materialType==='invoice'&&item.choice!=='building_self')throw new Error('签收图片原始身份不匹配');
    const target=item.authorityTarget,principal=this.access.feishuPrincipal(input.actorOpenId,appId);
    if(!target||!principal||principal.requiresPasswordChange||!this.access.canUseFeishuBusinessIdentity(principal.accountId,appId)||!canPerformBusinessAction(principal,{module:'purchase',action:'receive',...target}))throw new Error('当前人员无该采购签收权限');
  }
  private async verifySource():Promise<void>{this.assertGate();const bound=this.bound!;await this.store.verifyLifecycleReceiptImageSource(bound.appId,sourceFingerprint(bound));this.assertGate();}
  async accept(payload:unknown):Promise<{accepted:boolean;enqueued:boolean;taskId?:string}>{const epoch=this.epoch;await this.verifySource();
    const snapshot=await this.verifier.verify(payload,this.bound!.appId);this.assertGate(epoch);
    const accepted=await this.store.acceptVerifiedLifecycleReceiptImage(snapshot,(batch,item,intent)=>this.authorize({batch,item,intent},epoch));
    if(accepted.enqueued&&accepted.taskId)this.schedule(accepted.taskId);return accepted;
  }
  schedule(taskId:string):void {this.assertGate();if(this.work.has(taskId))return;const pending=this.process(taskId).catch(()=>this.report()).finally(()=>{if(this.work.get(taskId)===pending)this.work.delete(taskId);});this.work.set(taskId,pending);}
  async recoverOnce():Promise<void>{if(this.scanning)return;this.scanning=true;try{await this.verifySource();const ids=await this.store.listRecoverableLifecycleReceiptImageUploads(this.cursor,20);if(!ids.length){this.cursor='';return;}for(const id of ids){this.assertGate();this.cursor=id;this.schedule(id);}if(ids.length<20)this.cursor='';}finally{this.scanning=false;}}
  private async readCurrentRecord(context:LifecycleReceiptImageAuthorizationContext,epoch:number):Promise<void>{
    this.authorize(context,epoch);const source=this.bound!,id=context.intent.executionRecordId;
    const auth=await this.http.axiosRef.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',{app_id:source.appId,app_secret:source.appSecret},{timeout:10000,maxRedirects:0}).catch(()=>{throw new Error('签收图片应用身份暂不可核对');});this.assertGate(epoch);
    if(auth.data?.code!==0||typeof auth.data.tenant_access_token!=='string'||!auth.data.tenant_access_token)throw new Error('签收图片应用身份不可核对');
    const result=await this.http.axiosRef.post(`https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(source.appToken)}/tables/${encodeURIComponent(source.tableId)}/records/batch_get`,{record_ids:[id]},{headers:{Authorization:`Bearer ${auth.data.tenant_access_token}`},timeout:10000,maxRedirects:0}).catch(()=>{throw new Error('签收图片业务记录暂不可核对');});this.assertGate(epoch);
    const data=result.data?.data;if(result.data?.code!==0||!Array.isArray(data?.records)||data.records.length!==1||data.forbidden_record_ids?.length||data.absent_record_ids?.length)throw new Error('签收图片业务记录不可核对');
    const record=mapExecutionRecord(data.records[0]),target=purchaseAuthorityTarget(record);
    if(record.recordId!==id||record.approvalBatchId!==context.batch.approvalBatchId||record.requesterOpenId!==context.intent.actorOpenId||resolvePurchaseStage(record.status)!=='receipt'||!target||target.building!==context.item.authorityTarget?.building||target.specialty!==context.item.authorityTarget?.specialty)throw new Error('采购单据已不处于原签收阶段');
  }
  async process(taskId:string):Promise<'completed'|'manual_reconciliation'>{
    await this.verifySource();const epoch=this.epoch;
    const base=createLifecycleReceiptImageStoreAdapter(this.store),authorize=(context:unknown)=>this.authorize(context as LifecycleReceiptImageAuthorizationContext,epoch);
    const binding=(context:LifecycleReceiptImageAuthorizationContext)=>JSON.stringify([context.batch.approvalBatchId,context.batch.lifecycleAppId,context.batch.requesterOpenId,context.item.executionRecordId,context.item.authorityTarget,context.item.status,context.item.choice,context.item.purchaserOpenId,context.item.actionEventId,context.intent]);
    const current=async()=>{const inspected=await this.store.inspectLifecycleReceiptImageUpload(taskId,context=>this.authorize(context,epoch));if(inspected.task.state!=='completed')await this.readCurrentRecord(inspected.context,epoch);const expected=binding(inspected.context);return (context:unknown)=>{authorize(context);if(binding(context as LifecycleReceiptImageAuthorizationContext)!==expected)throw new Error('签收图片单据在核对期间发生变化');};};
    const adapter:LifecycleReceiptImageStore={...base,
      claimUpload:async(id,check)=>{const verified=await current();this.assertGate(epoch);return base.claimUpload(id,context=>{check(context);verified(context);});},
      markUploadDispatched:async(id,token,check)=>{const verified=await current();this.assertGate(epoch);return base.markUploadDispatched(id,token,context=>{check(context);verified(context);});},
      commitUploaded:async(id,token,check)=>{const verified=await current();this.assertGate(epoch);return base.commitUploaded(id,token,context=>{check(context);verified(context);});},
    };
    return new PurchaseLifecycleReceiptImageCoordinator(this.verifier,adapter,this.transport,()=>{this.assertGate(epoch);return this.bound!.appId;},authorize).process(taskId);
  }
}
