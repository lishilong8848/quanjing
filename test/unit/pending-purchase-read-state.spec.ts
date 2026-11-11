import {describePendingPurchaseReadFailure,pendingPurchaseReadDisplay} from '../../client/src/pages/InventoryManagement/pending-purchase-read-state';
describe('pending purchase read feedback',()=>{
 it('keeps existing records visible for normal and forced refreshes',()=>{
  expect(pendingPurchaseReadDisplay(true,12)).toBe('refreshing');
  expect(pendingPurchaseReadDisplay(true,0)).toBe('initial-loading');
  expect(pendingPurchaseReadDisplay(false,12)).toBe('ready');
 });
 it.each([401,403])('hides previous results when server rejects access (%s)',status=>{
  const result=describePendingPurchaseReadFailure({response:{status,data:{message:'secret upstream credentials'}}});
  expect(result.hidePrevious).toBe(true);expect(result.message).not.toContain('secret');
  expect(result.message).toContain(status===401?'重新登录':'权限');
 });
 it.each([{code:'ECONNABORTED'},{code:'ETIMEDOUT'},{response:{status:504}},{response:{status:408}}])('reports timeout without clearing a valid list',error=>{
  expect(describePendingPurchaseReadFailure(error)).toEqual({message:expect.stringContaining('超时'),hidePrevious:false});
 });
 it('shows a conflict only for the explicit safe server code, not untrusted text',()=>{
  expect(describePendingPurchaseReadFailure({response:{status:503,data:{code:'INVENTORY_PENDING_READ_CONFLICT'}}})).toEqual({message:expect.stringContaining('正在变更'),hidePrevious:false});
  expect(describePendingPurchaseReadFailure({response:{status:503,data:{message:'待采购入库数据正在更新，本次核对未完成，请稍后重试。'}}}).message).toContain('正在变更');
  expect(describePendingPurchaseReadFailure({response:{status:503,data:{message:'待采购入库数据正在更新，本次核对未完成，请稍后重试。secret'}}}).message).not.toContain('正在变更');
  const result=describePendingPurchaseReadFailure({response:{status:500,data:{message:'数据在读取期间已变更 secret token url'}}});
  expect(result.message).not.toContain('正在变更');expect(result.message).not.toMatch(/token|url|secret/);
 });
 it('distinguishes network loss while keeping generic errors safe',()=>{
  expect(describePendingPurchaseReadFailure({code:'ERR_NETWORK'}).message).toContain('网络');
  for(const error of [null,undefined,new Error('sensitive error'),{response:{status:500,data:{message:'sensitive error'}}}]){
   expect(describePendingPurchaseReadFailure(error).hidePrevious).toBe(false);
   expect(describePendingPurchaseReadFailure(error).message).not.toContain('sensitive');
  }
 });
});
