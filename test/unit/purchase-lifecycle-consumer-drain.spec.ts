import { FeishuCardActionConsumer } from '../../server/modules/purchase-inventory/feishu-card-action.consumer';
let mockProfile='shared';
jest.mock('../../server/common/config/external-services.config',()=>({...jest.requireActual('../../server/common/config/external-services.config'),getFeishuCardActionConsumerProfile:()=>mockProfile}));
function fixture(){
  let ready=false;const router={isAnyEnabled:()=>false,handle:jest.fn(),handleMessage:jest.fn()};
  const transport={isReady:()=>ready,connect:jest.fn(async()=>{ready=true;}),close:jest.fn(async()=>{ready=false;})};
  return {router,transport,consumer:new FeishuCardActionConsumer(router as never,transport)};
}
describe('one shared callback consumer in lifecycle drain mode',()=>{
  beforeEach(()=>{mockProfile='shared';});
  it('explicitly starts an otherwise idle consumer once and shares both handlers',async()=>{
    const f=fixture();await f.consumer.onApplicationBootstrap();expect(f.transport.connect).not.toHaveBeenCalled();
    await Promise.all([f.consumer.ensureConnected(),f.consumer.ensureConnected(),f.consumer.ensureConnected()]);expect(f.transport.connect).toHaveBeenCalledTimes(1);
    const [card,,message]=f.transport.connect.mock.calls[0] as unknown as [(p:unknown)=>Promise<unknown>,unknown,(p:unknown)=>Promise<unknown>];
    const p={event:'synthetic'};await card(p);await message(p);expect(f.router.handle).toHaveBeenCalledWith(p);expect(f.router.handleMessage).toHaveBeenCalledWith(p);
    await f.consumer.onModuleDestroy();await f.consumer.ensureConnected();expect(f.transport.connect).toHaveBeenCalledTimes(1);
  });
  it('never overrides a disabled runtime role',async()=>{
    mockProfile='disabled';const f=fixture();await f.consumer.ensureConnected();expect(f.transport.connect).not.toHaveBeenCalled();await f.consumer.onModuleDestroy();
  });
  it('does not revive a connection when destruction overlaps connection startup',async()=>{
    const f=fixture();let release!:()=>void;f.transport.connect.mockImplementationOnce(()=>new Promise<void>(resolve=>{release=resolve;}));
    const start=f.consumer.ensureConnected();await Promise.resolve();const stop=f.consumer.onModuleDestroy();release();await Promise.all([start,stop]);
    expect(f.transport.isReady()).toBe(false);await f.consumer.ensureConnected();expect(f.transport.connect).toHaveBeenCalledTimes(1);
  });
  it('reconnects explicitly requested drain work and keeps one connection attempt',async()=>{
    jest.useFakeTimers();const f=fixture();try{
      await f.consumer.ensureConnected();const terminal=(f.transport.connect.mock.calls[0] as unknown as [unknown,(e:Error)=>void])[1];terminal(new Error('synthetic disconnect'));
      await jest.advanceTimersByTimeAsync(5_001);expect(f.transport.connect).toHaveBeenCalledTimes(2);
    }finally{await f.consumer.onModuleDestroy();jest.useRealTimers();}
  });
});
