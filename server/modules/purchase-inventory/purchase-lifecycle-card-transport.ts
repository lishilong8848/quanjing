import { Injectable } from '@nestjs/common';
import { getEffectiveFeishuAppCredentials } from '../../common/config/external-services.config';
import type { FeishuCardActionHandler, FeishuCardActionTerminalFailureHandler, FeishuCardActionTransport, FeishuMessageHandler } from '../overtime-workflow/overtime-workflow.card-action.consumer';
import { createLifecycleReceiptWsIngress } from './purchase-lifecycle-receipt-ws-ingress';

/** Replaces the shared transport; never register this beside another live connection. */
@Injectable()
export class PurchaseLifecycleCardTransport implements FeishuCardActionTransport {
  private ingress:ReturnType<typeof createLifecycleReceiptWsIngress>|undefined;
  private pending:Promise<void>|undefined;
  private generation=0;
  async connect(handler:FeishuCardActionHandler,onTerminalFailure:FeishuCardActionTerminalFailureHandler,messageHandler?:FeishuMessageHandler):Promise<void> {
    if(this.pending)return this.pending;
    if(this.ingress?.isReady())return;
    this.ingress?.close();
    const epoch=++this.generation;
    const ingress=createLifecycleReceiptWsIngress({readCredentials:()=>getEffectiveFeishuAppCredentials(),onCard:handler,
      onMessage:payload=>messageHandler ? messageHandler(payload) : Promise.resolve(),
      onFailure:()=>{if(this.generation===epoch)onTerminalFailure(new Error('飞书共享回调连接不可用'));}});
    this.ingress=ingress;
    const start=ingress.start();this.pending=start;
    try{await start;}catch{if(this.ingress===ingress){ingress.close();this.ingress=undefined;}throw new Error('飞书共享回调连接不可用');}
    finally{if(this.pending===start)this.pending=undefined;}
  }
  isReady():boolean{return this.ingress?.isReady()===true;}
  isAuthenticatedWsDelivery(payload:unknown,appId:string):boolean{return this.ingress?.isAuthenticatedWsDelivery(payload,appId)===true;}
  async close():Promise<void>{this.generation++;const current=this.ingress;this.ingress=undefined;current?.close();const pending=this.pending;if(pending)await pending.catch(()=>undefined);if(this.pending===pending)this.pending=undefined;}
}
