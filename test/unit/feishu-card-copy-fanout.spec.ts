import { FeishuCardCopyFanout } from '../../server/common/feishu-card-copy/fanout';
import type { CardCopyObserver } from '../../server/common/feishu-card-copy/transport';

function recipient(): jest.Mocked<CardCopyObserver> {
  let sequence=0;
  return {delivered:jest.fn(async()=>{}), reserveUpdate:jest.fn(async()=>({sequence:++sequence})),
    cancelUpdate:jest.fn(async()=>{}),updated:jest.fn(async()=>{}),isCopyMessage:jest.fn(()=>false),diagnostic:jest.fn()};
}
describe('recipient-specific update reservations (offline)',()=>{
  it('keeps independent reservation sequences when updates finish out of order',async()=>{
    const first=recipient(),second=recipient(),fanout=new FeishuCardCopyFanout([first,second],jest.fn());
    const a=await fanout.reserveUpdate('om_original'),b=await fanout.reserveUpdate('om_original');
    await fanout.updated('om_original',{version:2},b);await fanout.updated('om_original',{version:1},a);
    for(const observer of [first,second])expect(observer.updated.mock.calls.map(call=>call[2])).toEqual([{sequence:2},{sequence:1}]);
    await fanout.updated('om_original',{},a);expect(first.updated).toHaveBeenCalledTimes(2);
  });
  it('preserves successful reservations even when another ledger and its diagnostic fail',async()=>{
    const bad=recipient(),good=recipient();bad.reserveUpdate.mockRejectedValue(new Error('damaged ledger'));
    const fanout=new FeishuCardCopyFanout([bad,good],()=>{throw new Error('diagnostic error')});
    const token=await fanout.reserveUpdate('om_original');await fanout.updated('om_original',{},token);
    expect(good.updated).toHaveBeenCalledTimes(1);expect(bad.updated).not.toHaveBeenCalled();
  });
  it('cancels failed recipient reservations without cancelling the successful update',async()=>{
    const bad=recipient(),good=recipient();bad.updated.mockRejectedValue(new Error('write failure'));
    const fanout=new FeishuCardCopyFanout([bad,good],jest.fn());const token=await fanout.reserveUpdate('om_original');
    await fanout.updated('om_original',{},token);await fanout.cancelUpdate(token);
    expect(bad.cancelUpdate).toHaveBeenCalledTimes(1);expect(good.updated).toHaveBeenCalledTimes(1);expect(good.cancelUpdate).not.toHaveBeenCalled();
  });
  it('cancels every reserved peer after a primary update failure, including when one cancellation fails',async()=>{
    const bad=recipient(),good=recipient();bad.cancelUpdate!.mockRejectedValue(new Error('cancel failure'));
    const fanout=new FeishuCardCopyFanout([bad,good],jest.fn());const token=await fanout.reserveUpdate('om_original');
    await fanout.cancelUpdate(token);await fanout.cancelUpdate(token);
    expect(good.cancelUpdate).toHaveBeenCalledTimes(1);expect(bad.cancelUpdate).toHaveBeenCalledTimes(1);
  });
  it('recognizes either readonly message despite another damaged ledger',()=>{
    const bad=recipient(),good=recipient();bad.isCopyMessage.mockImplementation(()=>{throw new Error('damaged')});good.isCopyMessage.mockReturnValue(true);
    expect(new FeishuCardCopyFanout([bad,good],jest.fn()).isCopyMessage('om_copy')).toBe(true);
  });
  it('isolates enrollment failures and rejects unissued update tokens',async()=>{
    const bad=recipient(),good=recipient();bad.delivered.mockRejectedValue(new Error('enroll failure'));
    const fanout=new FeishuCardCopyFanout([bad,good],jest.fn());
    await fanout.delivered({source:'permission-request',messageId:'om_original',card:{},recipientId:'ou_original',recipientType:'open_id',startedAt:new Date().toISOString()});
    await fanout.updated('om_original',{},{});expect(good.delivered).toHaveBeenCalledTimes(1);expect(good.updated).not.toHaveBeenCalled();
  });
});
