import { buildPurchaseLifecycleCard } from '../../server/modules/purchase-inventory/purchase-lifecycle-card';
import type { PurchaseLifecycleProjectedItem } from '../../server/modules/purchase-inventory/purchase-lifecycle-projection';

describe('payment upload entry on an authorized lifecycle card',()=>{
  const item:PurchaseLifecycleProjectedItem={recordId:'rec_one',currentStage:'ordering',stages:[{stage:'ordering',fields:[],attachments:[{purpose:'payment',index:0}]}],actions:['order']};
  const input={approvalBatchId:'purchase-batch-payment',cardRevision:4,generation:2,attachmentBaseUrl:'https://www.sm.sjhl.online:3001',observer:false,items:[item]};
  const buttons=(card:any)=>card.body.elements.filter((entry:any)=>entry.tag==='button');
  it('uses the configured www origin and same batch, record and generation while retaining existing attachment viewing',()=>{
    const card=buildPurchaseLifecycleCard({...input,paymentUploadReady:()=>true});
    const all=buttons(card),upload=all.find((button:any)=>button.text.content==='上传付款附件');
    const url=new URL(upload.behaviors[0].default_url);
    expect(url.origin).toBe('https://www.sm.sjhl.online:3001');expect(url.pathname).toBe('/purchase-lifecycle-payment-upload');
    expect(Object.fromEntries(url.searchParams)).toEqual({approvalBatchId:input.approvalBatchId,executionRecordId:'rec_one',generation:'2'});
    expect(all.some((button:any)=>button.text.content==='付款附件 1')).toBe(true);
    const continued=buttons(buildPurchaseLifecycleCard({...input,generation:3,continued:true,paymentUploadReady:()=>true})).find((button:any)=>button.text.content==='上传付款附件');
    expect(new URL(continued.behaviors[0].default_url).searchParams.get('generation')).toBe('3');
  });
  it('never offers writes to observers, wrong stages or participants without the order grant',()=>{
    for(const changed of [{observer:true},{items:[{...item,actions:[]}]},{items:[{...item,currentStage:'receipt' as const}]}]){
      expect(JSON.stringify(buildPurchaseLifecycleCard({...input,...changed,paymentUploadReady:()=>true}))).not.toContain('上传付款附件');
    }
  });
  it('keeps the entry absent by default or when capability is false, throws, or is asynchronous',()=>{
    for(const paymentUploadReady of [undefined,()=>false,()=>{throw Error('not ready');},(()=>Promise.resolve(true)) as unknown as ()=>boolean,(()=>Promise.reject(Error('not ready'))) as unknown as ()=>boolean]){
      expect(JSON.stringify(buildPurchaseLifecycleCard({...input,paymentUploadReady}))).not.toContain('上传付款附件');
    }
  });
});
