import { PurchaseLifecycleCardTransport } from '../../server/modules/purchase-inventory/purchase-lifecycle-card-transport';
const mockClients:any[]=[];
let mockCredentials={appId:'cli_test',appSecret:'synthetic'};
jest.mock('../../server/common/config/external-services.config',()=>({getEffectiveFeishuAppCredentials:()=>mockCredentials}));
jest.mock('@larksuiteoapi/node-sdk',()=>({LoggerLevel:{error:'error'},EventDispatcher:class{register(handlers:any){return handlers;}},WSClient:class{
  options:any; handlers:any; state='connected';close=jest.fn(()=>{this.state='closed';});
  constructor(options:any){this.options=options;mockClients.push(this);}
  async start(input:any){this.handlers=input.eventDispatcher;this.options.onReady();}
  getConnectionStatus(){return {state:this.state};}
}}));
describe('one shared lifecycle transport',()=>{
  let transport:PurchaseLifecycleCardTransport;
  beforeEach(()=>{mockClients.length=0;mockCredentials={appId:'cli_test',appSecret:'synthetic'};transport=new PurchaseLifecycleCardTransport();});
  afterEach(async()=>{await transport.close();});
  it('coalesces connect and forwards card responses and authenticated immutable messages through one connection',async()=>{
    const response={toast:{type:'info' as const,content:'ok'}},card=jest.fn(async()=>response),failure=jest.fn();let delivered:any;
    const message=jest.fn(async(payload:any)=>{delivered=payload;expect(Object.isFrozen(payload)).toBe(true);expect(transport.isAuthenticatedWsDelivery(payload,'cli_test')).toBe(true);expect(transport.isAuthenticatedWsDelivery({...payload},'cli_test')).toBe(false);});
    await Promise.all([transport.connect(card,failure,message),transport.connect(card,failure,message)]);
    expect(mockClients).toHaveLength(1);expect(transport.isReady()).toBe(true);
    expect(await mockClients[0].handlers['card.action.trigger']({synthetic:true})).toBe(response);
    await mockClients[0].handlers['im.message.receive_v1']({event:{message:{content:'synthetic'}}});
    expect(message).toHaveBeenCalledTimes(1);expect(transport.isAuthenticatedWsDelivery(delivered,'cli_test')).toBe(false);expect(failure).not.toHaveBeenCalled();
  });
  it('withdraws trust while reconnecting, on configuration drift, and after close; then can connect again',async()=>{
    const card=jest.fn(async()=>({toast:{type:'info' as const,content:'ok'}})),message=jest.fn();await transport.connect(card,jest.fn(),message);
    const first=mockClients[0];first.options.onReconnecting();expect(transport.isReady()).toBe(false);await first.handlers['im.message.receive_v1']({});expect(message).not.toHaveBeenCalled();
    first.options.onReconnected();expect(transport.isReady()).toBe(true);
    mockCredentials={appId:'cli_other',appSecret:'synthetic'};expect(transport.isReady()).toBe(false);await expect(first.handlers['card.action.trigger']({})).rejects.toThrow();expect(card).not.toHaveBeenCalled();
    await transport.close();expect(first.close).toHaveBeenCalledTimes(1);expect(transport.isReady()).toBe(false);
    await transport.connect(card,jest.fn(),message);expect(mockClients).toHaveLength(2);expect(transport.isReady()).toBe(true);
  });
  it('reports one generic terminal failure without exposing SDK error content',async()=>{
    const failed=jest.fn();await transport.connect(jest.fn(),failed);const first=mockClients[0];first.options.onError(new Error('secret-like internal detail'));first.options.onError(new Error('second'));
    expect(failed).toHaveBeenCalledTimes(1);expect(failed.mock.calls[0][0].message).toBe('飞书共享回调连接不可用');expect(transport.isReady()).toBe(false);
  });
});
