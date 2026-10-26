import { createRepairDialogFocus } from '../../client/src/pages/EquipmentLedgerManagement/repair-dialog-focus';

function fixture() {
  const callbacks: FrameRequestCallback[] = [];
  const cancelFrame = jest.fn();
  const requestFrame = jest.fn((callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  const input = { isConnected: true, focus: jest.fn() };
  const scheduler = createRepairDialogFocus(requestFrame, cancelFrame);
  return { callbacks, cancelFrame, input, scheduler };
}

describe('维修弹窗延后聚焦', () => {
  it('先让内容绘制一帧，再读取当前搜索框聚焦并避免滚动', () => {
    const { scheduler, input, callbacks } = fixture();
    scheduler.schedule(() => input as unknown as HTMLInputElement);
    expect(input.focus).not.toHaveBeenCalled();
    callbacks[0](0);
    expect(input.focus).not.toHaveBeenCalled();
    callbacks[1](16);
    expect(input.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('首帧已执行后关闭仍取消第二帧，旧回调不抢焦点', () => {
    const { scheduler, input, callbacks, cancelFrame } = fixture();
    scheduler.schedule(() => input as unknown as HTMLInputElement);
    callbacks[0](0);
    scheduler.cancel();
    expect(cancelFrame).toHaveBeenCalledWith(2);
    callbacks[1](16);
    expect(input.focus).not.toHaveBeenCalled();
  });

  it('关闭或卸载后取消任务，即使旧回调到达也不抢焦点', () => {
    const { scheduler, input, callbacks, cancelFrame } = fixture();
    scheduler.schedule(() => input as unknown as HTMLInputElement);
    scheduler.cancel();
    expect(cancelFrame).toHaveBeenCalledWith(1);
    callbacks[0](0);
    expect(input.focus).not.toHaveBeenCalled();
  });

  it('连续打开只允许最新任务聚焦', () => {
    const { scheduler, input, callbacks } = fixture();
    const oldInput = { isConnected: true, focus: jest.fn() };
    scheduler.schedule(() => oldInput as unknown as HTMLInputElement);
    scheduler.schedule(() => input as unknown as HTMLInputElement);
    callbacks[0](0);
    callbacks[1](0);
    callbacks[2](16);
    expect(oldInput.focus).not.toHaveBeenCalled();
    expect(input.focus).toHaveBeenCalledTimes(1);
  });

  it('忽略已离开文档的搜索框及空引用', () => {
    const { scheduler, input, callbacks } = fixture();
    input.isConnected = false;
    scheduler.schedule(() => input as unknown as HTMLInputElement);
    callbacks[0](0);
    callbacks[1](16);
    scheduler.schedule(() => null);
    callbacks[2](32);
    expect(() => callbacks[3](48)).not.toThrow();
    expect(input.focus).not.toHaveBeenCalled();
  });
});
