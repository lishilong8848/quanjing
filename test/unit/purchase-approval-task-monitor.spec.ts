import { monitorAcceptedPurchaseApproval } from '../../client/src/pages/PurchaseInventoryManagement/purchase-approval-task-monitor';

describe('accepted purchase approval monitoring', () => {
  const task = (status: string) => ({success:true,task:{id:'task-one',recordId:'rec_one',status,message:status}}) as never;
  it('recovers from a read failure by querying the same task without submitting again', async () => {
    const read = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(task('running')).mockResolvedValueOnce(task('completed'));
    const result = await monitorAcceptedPurchaseApproval({taskId:'task-one',recordId:'rec_one',current:()=>true,read,wait:async()=>{},attempts:3});
    expect(result.state).toBe('completed');
    expect(read.mock.calls).toEqual([['task-one'],['task-one'],['task-one']]);
  });
  it('does not display another task or a response from a previous session', async () => {
    const read = jest.fn().mockResolvedValue({success:true,task:{id:'other',recordId:'rec_one',status:'completed'}});
    expect((await monitorAcceptedPurchaseApproval({taskId:'task-one',recordId:'rec_one',current:()=>true,read,wait:async()=>{}})).state).toBe('failed');
    let current=true;
    read.mockImplementation(async()=>{current=false;return task('completed');});
    expect((await monitorAcceptedPurchaseApproval({taskId:'task-one',recordId:'rec_one',current:()=>current,read,wait:async()=>{}})).state).toBe('cancelled');
  });
  it('leaves a slow or unavailable result pending rather than reporting success', async () => {
    const read=jest.fn().mockResolvedValue(task('running'));
    expect((await monitorAcceptedPurchaseApproval({taskId:'task-one',recordId:'rec_one',current:()=>true,read,wait:async()=>{},attempts:2})).state).toBe('pending');
    expect(read).toHaveBeenCalledTimes(2);
  });
});
