jest.mock('@lark-apaas/client-toolkit/utils/getAxiosForBackend',()=>({axiosForBackend:jest.fn()}));
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { previewPersonnelBaseline, confirmPersonnelBaseline, previewPersonnelSource, changePersonnelSource, loadConfiguration, saveAccount } from '../../client/src/pages/SystemConfiguration/api';

describe('岗位核对独立超时预算',()=>{
  beforeEach(()=>{jest.useFakeTimers();});
  afterEach(()=>{jest.useRealTimers();jest.resetAllMocks();});
  function delayed(delay:number){
    (axiosForBackend as jest.Mock).mockImplementation(({timeout})=>new Promise((resolve,reject)=>{
      setTimeout(()=>delay>timeout?reject({code:'ECONNABORTED'}):resolve({status:200,data:{ok:true}}),Math.min(delay,timeout));
    }));
  }
  it.each([previewPersonnelBaseline,previewPersonnelSource])('冷核源超过15秒仍能返回，且等待有界',async read=>{
    delayed(16_000);const pending=read();const check=expect(pending).resolves.toEqual({ok:true});await jest.advanceTimersByTimeAsync(16_000);await check;
    expect(axiosForBackend).toHaveBeenCalledWith(expect.objectContaining({timeout:60_000}));
  });
  it('确认和启用同样允许新鲜核源，普通保存预算不变',async()=>{
    delayed(16_000);
    for(const write of [confirmPersonnelBaseline,changePersonnelSource]){
      const input={clientMutationId:'synthetic-stable-mutation'};const pending=write(input as never),check=expect(pending).resolves.toEqual({ok:true});await jest.advanceTimersByTimeAsync(16_000);await check;
      expect(axiosForBackend).toHaveBeenLastCalledWith(expect.objectContaining({timeout:60_000,data:input}));
    }
    const pending=saveAccount({} as never),check=expect(pending).rejects.toThrow('保存结果未确认');await jest.advanceTimersByTimeAsync(15_000);await check;
    expect(axiosForBackend).toHaveBeenLastCalledWith(expect.objectContaining({timeout:15_000}));
  });
  it('超出核源预算仍失败并可重试，普通读取保持15秒',async()=>{
    delayed(61_000);const pending=previewPersonnelBaseline(),check=expect(pending).rejects.toThrow('读取超时');await jest.advanceTimersByTimeAsync(60_000);await check;
    const write=confirmPersonnelBaseline({} as never),uncertain=expect(write).rejects.toThrow('保存结果未确认');await jest.advanceTimersByTimeAsync(60_000);await uncertain;
    const normal=loadConfiguration(),normalCheck=expect(normal).rejects.toThrow('读取超时');await jest.advanceTimersByTimeAsync(15_000);await normalCheck;
  });
});
