import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { describePendingPurchaseReadFailure } from '../../client/src/pages/InventoryManagement/pending-purchase-read-state';

// Execute the real callback body from the page, rather than reimplementing its request guards.
const sourcePath=path.resolve(__dirname,'../../client/src/pages/InventoryManagement/InventoryMovementPage.tsx');
const source=ts.createSourceFile(sourcePath,fs.readFileSync(sourcePath,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let callbackText='';
function find(node:ts.Node):void {
 if(ts.isVariableDeclaration(node)&&node.name.getText(source)==='loadPendingPurchases'&&node.initializer&&ts.isCallExpression(node.initializer)) callbackText=node.initializer.arguments[0].getText(source);
 ts.forEachChild(node,find);
}
find(source);
if(!callbackText)throw new Error('Actual pending-purchase callback not found');
function fixture(canRefresh=true,type='inbound') {
 const existing=[{executionRecordId:'already-visible'}];
 const scope={canRefresh,type,pendingRequestRef:{current:0},principalRequestGenerationRef:{current:1},principalRequestPrincipalRef:{current:'account-a'},principalFingerprint:'account-a',mountedRef:{current:true},setPendingLoading:jest.fn(),setPendingError:jest.fn(),setPendingAccessDenied:jest.fn(),setInboundState:jest.fn(),mergePurchaseQueryResult:jest.fn(),getPendingPurchaseInbounds:jest.fn(),describePendingPurchaseReadFailure};
 const code=ts.transpileModule(`module.exports=function(scope){const {${Object.keys(scope).join(',')}}=scope;return (${callbackText});}`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const holder={exports:null as any};new Function('module',code)(holder);
 return {scope,existing,load:holder.exports(scope) as (force?:boolean)=>Promise<unknown>};
}
function deferred(){let resolve!:(value:unknown)=>void,reject!:(error:unknown)=>void;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

describe('real pending-purchase page callback',()=>{
 it('retains the existing list on a failed background read and ends loading',async()=>{
  const {scope,load,existing}=fixture();scope.getPendingPurchaseInbounds.mockRejectedValue({code:'ETIMEDOUT'});
  await expect(load(true)).resolves.toBeNull();
  expect(scope.setInboundState).not.toHaveBeenCalled();expect(existing).toEqual([{executionRecordId:'already-visible'}]);
  expect(scope.setPendingLoading.mock.calls).toEqual([[true],[false]]);
  expect(scope.setPendingError).toHaveBeenLastCalledWith(expect.stringContaining('超时'));
  expect(scope.setPendingAccessDenied).not.toHaveBeenCalled();
 });
 it.each([401,403])('hides a denied list then clears denial only on a successful read (%s)',async status=>{
  const {scope,load}=fixture();scope.getPendingPurchaseInbounds.mockRejectedValueOnce({response:{status}}).mockResolvedValueOnce({items:[{executionRecordId:'fresh'}]});
  await load();expect(scope.setPendingAccessDenied).toHaveBeenLastCalledWith(true);expect(scope.setInboundState).not.toHaveBeenCalled();
  await load();expect(scope.setPendingAccessDenied).toHaveBeenLastCalledWith(false);expect(scope.setInboundState).toHaveBeenCalledTimes(1);
 });
 for(const outcome of ['success','failure']) {
  it.each(['request','generation','principal','unmount'])(`ignores stale ${outcome} after %s changes`,async boundary=>{
   const {scope,load}=fixture(),pending=deferred();scope.getPendingPurchaseInbounds.mockReturnValue(pending.promise);
   const result=load();scope.setPendingLoading.mockClear();scope.setPendingError.mockClear();
   if(boundary==='request')scope.pendingRequestRef.current++;
   if(boundary==='generation')scope.principalRequestGenerationRef.current++;
   if(boundary==='principal')scope.principalRequestPrincipalRef.current='account-b';
   if(boundary==='unmount')scope.mountedRef.current=false;
   if(outcome==='success')pending.resolve({items:[{executionRecordId:'late'}]});else pending.reject({response:{status:403}});
   await expect(result).resolves.toBeNull();
   expect(scope.setInboundState).not.toHaveBeenCalled();expect(scope.setPendingError).not.toHaveBeenCalled();expect(scope.setPendingLoading).not.toHaveBeenCalled();expect(scope.setPendingAccessDenied).not.toHaveBeenCalled();
  });
 }
 it.each([true,false])('keeps forced reads subject to refresh permission (%s)',async permission=>{
  const {scope,load}=fixture(permission);scope.getPendingPurchaseInbounds.mockResolvedValue({items:[]});await load(true);
  expect(scope.getPendingPurchaseInbounds).toHaveBeenCalledWith(permission);expect(scope.getPendingPurchaseInbounds).toHaveBeenCalledTimes(1);
 });
 it('rejects malformed results without replacing the last good list',async()=>{
  const {scope,load}=fixture();scope.getPendingPurchaseInbounds.mockResolvedValue({items:null});await load();expect(scope.setInboundState).not.toHaveBeenCalled();expect(scope.setPendingError).toHaveBeenLastCalledWith(expect.stringContaining('暂时无法核对'));
 });
});
