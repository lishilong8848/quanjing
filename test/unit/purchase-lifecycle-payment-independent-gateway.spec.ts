import { createHash, randomUUID } from 'node:crypto';
import { LifecyclePaymentPerFileGatewayAdapter } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-upload-gateway';

describe('per-file payment frozen-source gateway',()=>{
  const original={appId:'cli_synthetic',appToken:'base_synthetic',tableId:'tbl_synthetic'};
  const file={originalname:'proof.png',mimetype:'image/png',size:3,buffer:Buffer.from('abc')};
  function fixture(){
    let source={...original},credentials={app_id:original.appId,app_secret:'synthetic-only'};
    const identity={appId:original.appId,uploadSourceFingerprint:createHash('sha256').update(JSON.stringify(Object.values(original))).digest('hex'),assertCurrent:jest.fn()};
    const http={axiosRef:{post:jest.fn(async(url:string)=>url.includes('/auth/')?{data:{code:0,tenant_access_token:'synthetic-token'}}:{data:{code:0,data:{file_token:'file_confirmed'}}})}};
    return {identity,http,adapter:new LifecyclePaymentPerFileGatewayAdapter(http as never,()=>source,()=>credentials),setSource:(next:typeof source)=>{source=next;},setCredentials:(next:typeof credentials)=>{credentials=next;}};
  }
  it('uses a same-app token and freezes the upload Base without reusing the generic cache',async()=>{
    const x=fixture();expect(await x.adapter.uploadOne(file,randomUUID(),x.identity as never)).toBe('file_confirmed');
    expect(x.http.axiosRef.post).toHaveBeenCalledTimes(2);
    const calls=x.http.axiosRef.post.mock.calls as unknown as any[][];
    expect(calls[0][1]).toEqual({app_id:'cli_synthetic',app_secret:'synthetic-only'});
    expect(calls[1][1].getBuffer().toString()).toContain('base_synthetic');
    expect(calls[1][2]).toMatchObject({maxRedirects:0,headers:{Authorization:'Bearer synthetic-token'}});
  });
  it('checks durable source before authentication and again immediately before uploading',async()=>{
    const x=fixture(),verify=jest.fn(async()=>{throw Error('durable source mismatch');});
    const adapter=new LifecyclePaymentPerFileGatewayAdapter(x.http as never,()=>original,()=>({app_id:original.appId,app_secret:'synthetic-only'}),verify);
    await expect(adapter.uploadOne(file,randomUUID(),x.identity as never)).rejects.toThrow('durable source mismatch');
    expect(x.http.axiosRef.post).not.toHaveBeenCalled();
    verify.mockResolvedValueOnce(undefined);
    await expect(adapter.uploadOne(file,randomUUID(),x.identity as never)).rejects.toThrow('durable source mismatch');
    expect(x.http.axiosRef.post).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith(original.appId,x.identity.uploadSourceFingerprint);
  });
  it.each(['app','base','table','credentials'])('does not upload when %s changes while obtaining a token',async kind=>{
    const x=fixture();x.http.axiosRef.post.mockImplementationOnce(async()=>{
      if(kind==='credentials')x.setCredentials({app_id:'cli_synthetic',app_secret:'changed'});
      else x.setSource({...original,...(kind==='app'?{appId:'cli_other'}:kind==='base'?{appToken:'other_base'}:{tableId:'tbl_other'})});
      return {data:{code:0,tenant_access_token:'synthetic-token'}} as never;
    });
    await expect(x.adapter.uploadOne(file,randomUUID(),x.identity as never)).rejects.toThrow('来源已变化');
    expect(x.http.axiosRef.post).toHaveBeenCalledTimes(1);
  });
  it('does not retry unknown uploads and retains a confirmed receipt despite later authorization changes',async()=>{
    const x=fixture();x.http.axiosRef.post.mockResolvedValueOnce({data:{code:0,tenant_access_token:'synthetic-token'}} as never).mockRejectedValueOnce(new Error('sensitive response'));
    await expect(x.adapter.uploadOne(file,randomUUID(),x.identity as never)).rejects.toThrow('结果待核对');expect(x.http.axiosRef.post).toHaveBeenCalledTimes(2);
    const y=fixture();y.http.axiosRef.post.mockImplementationOnce(async()=>({data:{code:0,tenant_access_token:'synthetic-token'}} as never)).mockImplementationOnce(async()=>{y.identity.assertCurrent.mockImplementation(()=>{throw Error('revoked');});return {data:{code:0,data:{file_token:'confirmed_before_revoke'}}} as never;});
    expect(await y.adapter.uploadOne(file,randomUUID(),y.identity as never)).toBe('confirmed_before_revoke');
  });
});
