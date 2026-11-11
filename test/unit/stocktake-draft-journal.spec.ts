import { StocktakeDraftJournal, prepareStocktakeLineRetry, settleStocktakeLineDraft, discardEditableStocktakeDraft } from '../../client/src/pages/InventoryManagement/stocktake-draft-journal';
class MemoryStorage implements Storage {
 readonly data = new Map<string,string>();
 get length(){return this.data.size;} clear(){this.data.clear();} key(index:number){return [...this.data.keys()][index]??null;}
 getItem(key:string){return this.data.get(key)??null;} setItem(key:string,value:string){this.data.set(key,value);} removeItem(key:string){this.data.delete(key);}
}
const principal={role:'inventory_admin' as const,purchaseBuilding:'C楼' as const,accountId:'zch',authorizationVersion:1};
const key='sample:2026-11:C楼:rec1';
const person={recordId:'recPerson',openId:'ou_person',name:'朱春华',employeeNo:'1',building:'C楼',position:'',specialty:''};
const draft={baseVersion:1,quantity:'',person,note:'',dirty:true,retry:null};
const request={scope:'sample' as const,month:'2026-11',building:'C楼' as const,recordId:'rec1',expectedVersion:1,actualQuantity:12,confirmer:person,note:'',clientMutationId:'original-id'};
const {clientMutationId,...payload}=request;
const pending={...draft,quantity:'12',retry:{signature:JSON.stringify(['confirm',payload]),request}};
describe('stocktake persistent draft isolation',()=>{
 it('restores person-only and pending original request across remounts',()=>{
  const storage=new MemoryStorage();const first=new StocktakeDraftJournal(principal,storage);first.set(key,draft);
  expect(new StocktakeDraftJournal(principal,storage).get(key)).toEqual(draft);
  first.set(key,pending);first.assertSaved(key);
  const restored=new StocktakeDraftJournal(principal,storage).get(key)!;
  expect(restored.retry?.request).toEqual(request);
  expect(restored.retry?.request.clientMutationId).toBe('original-id');
 });
 it('isolates account, impersonator, month, building, scope and row',()=>{
  const storage=new MemoryStorage();const first=new StocktakeDraftJournal(principal,storage);first.set(key,draft);
  expect(new StocktakeDraftJournal({...principal,accountId:'other'},storage).size).toBe(0);
  expect(new StocktakeDraftJournal({...principal,impersonation:{actorAccountId:'admin',actorName:'',targetName:'',expiresAt:1}},storage).size).toBe(0);
  const restored=new StocktakeDraftJournal(principal,storage);
  for(const other of ['review:2026-11:C楼:rec1','sample:2026-10:C楼:rec1','sample:2026-11:B楼:rec1','sample:2026-11:C楼:rec2'])expect(restored.get(other)).toBeUndefined();
 });
 it('does not restore or erase an old-version request until the server confirms the row',()=>{
  const storage=new MemoryStorage();new StocktakeDraftJournal(principal,storage).set(key,pending);
  const next=new StocktakeDraftJournal({...principal,authorizationVersion:2},storage);
  expect(next.get(key)).toBeUndefined();expect(next.issue(key)).toContain('权限变更');
  next.delete(key);expect(storage.length).toBe(1);expect(()=>next.assertSaved(key)).toThrow('权限变更');
  next.clearConfirmed(key);expect(storage.length).toBe(0);
 });
 it('fails closed on quota/readback and preserves the last persisted original request',()=>{
  const storage=new MemoryStorage();const journal=new StocktakeDraftJournal(principal,storage);journal.set(key,pending);
  storage.setItem=()=>{throw new Error('quota');};journal.set(key,{...pending,note:'changed'});
  expect(()=>journal.assertSaved(key)).toThrow('未能安全保存');
  expect(new StocktakeDraftJournal(principal,storage).get(key)?.retry?.request.clientMutationId).toBe('original-id');
 });
 it('rejects a mismatched retry record without writing it',()=>{
  const storage=new MemoryStorage();const journal=new StocktakeDraftJournal(principal,storage);
  journal.set('sample:2026-11:C楼:other',pending);
  expect(storage.length).toBe(0);expect(()=>journal.assertSaved('sample:2026-11:C楼:other')).toThrow('格式无效');
 });
 it('retains malformed bytes and blocks writes rather than deleting recovery',()=>{
  const storage=new MemoryStorage();const journal=new StocktakeDraftJournal(principal,storage);journal.set(key,pending);
  const stored=storage.key(0)!;storage.setItem(stored,'{bad');
  const next=new StocktakeDraftJournal(principal,storage);expect(()=>next.assertSaved(key)).toThrow('无法核验');expect(storage.getItem(stored)).toBe('{bad');
 });
 it('persists a bulk task separately without touching row drafts',()=>{
  const storage=new MemoryStorage();const journal=new StocktakeDraftJournal(principal,storage);journal.set(key,draft);
  const bulk='bulk:review:2026-11:C楼',bulkPayload={scope:'review',month:'2026-11',building:'C楼',expectedVersion:1,confirmer:person,lines:[{recordId:'rec1',expectedVersion:1,actualQuantity:12,confirmer:person,note:''}]},task={retry:{signature:JSON.stringify(bulkPayload),request:{...bulkPayload,clientMutationId:'bulk-original'}},accepted:null};
  journal.saveTask(bulk,task);journal.assertSaved(bulk);
  const next=new StocktakeDraftJournal(principal,storage);expect(next.readTask(bulk)).toEqual(task);next.deleteTask(bulk);expect(next.get(key)).toEqual(draft);
 });
});

it('never generates a replacement ID when an unknown request is retried after a newer server version',()=>{
 const newId=jest.fn(()=> 'unsafe-new-id');
 const restored=new StocktakeDraftJournal(principal,new MemoryStorage());restored.set(key,pending);
 const retry=prepareStocktakeLineRetry('confirm',{...payload,expectedVersion:9,actualQuantity:99},restored.get(key)!.retry,newId);
 expect(retry.request).toEqual(request);expect(newId).not.toHaveBeenCalled();
});

it('allows explicit retry after a transient quota failure without erasing an old record',()=>{
 const storage=new MemoryStorage();const journal=new StocktakeDraftJournal(principal,storage);
 const set=storage.setItem.bind(storage);storage.setItem=()=>{throw new Error('quota');};
 journal.set(key,pending);expect(()=>journal.assertSaved(key)).toThrow();
 storage.setItem=set;journal.set(key,pending);expect(()=>journal.assertSaved(key)).not.toThrow();
 expect(new StocktakeDraftJournal(principal,storage).get(key)?.retry?.request.clientMutationId).toBe('original-id');
});

it('updates only one persisted row when editing a thousand-row draft collection',()=>{
 const storage=new MemoryStorage();const journal=new StocktakeDraftJournal(principal,storage);
 for(let i=0;i<1000;i++)journal.set('sample:2026-11:C楼:row'+i,draft);
 const spy=jest.spyOn(storage,'setItem');journal.set('sample:2026-11:C楼:row500',{...draft,quantity:'4'});
 expect(spy).toHaveBeenCalledTimes(1);expect(storage.length).toBe(1000);
 const restored=new StocktakeDraftJournal(principal,storage);expect(restored.size).toBe(1000);expect(restored.get('sample:2026-11:C楼:row500')?.quantity).toBe('4');
});

it('settles a successful refresh without waiting for an input effect and preserves unsaved values',()=>{
 const storage=new MemoryStorage();const journal=new StocktakeDraftJournal(principal,storage);
 journal.set(key,{...pending,retry:{signature:JSON.stringify(['refresh-line',payload]),request}});
 settleStocktakeLineDraft(journal,key,{version:2,status:'draft',actualQuantity:null,confirmer:null,note:''} as any,{quantity:'12',person,note:'保留备注'});
 const reloaded=new StocktakeDraftJournal(principal,storage).get(key)!;
 expect(reloaded).toMatchObject({baseVersion:2,quantity:'12',person,note:'保留备注',dirty:true,retry:null});
});
it('only explicitly discards obsolete pure drafts, never a pending original request',()=>{
 const storage=new MemoryStorage();new StocktakeDraftJournal(principal,storage).set(key,draft);
 const next=new StocktakeDraftJournal({...principal,authorizationVersion:2},storage);
 expect(next.canDiscardObsoleteDraft(key)).toBe(true);expect(storage.length).toBe(1);
 expect(next.discardObsoleteDraft(key)).toBe(true);expect(storage.length).toBe(0);expect(next.issue(key)).toBe('');
 new StocktakeDraftJournal(principal,storage).set(key,pending);
 const locked=new StocktakeDraftJournal({...principal,authorizationVersion:2},storage);
 expect(locked.canDiscardObsoleteDraft(key)).toBe(false);expect(locked.discardObsoleteDraft(key)).toBe(false);expect(storage.length).toBe(1);
});

it('cannot discard a stale draft during bulk processing or replace an unresolved request',()=>{
 const storage=new MemoryStorage();const journal=new StocktakeDraftJournal(principal,storage);journal.set(key,draft);
 expect(discardEditableStocktakeDraft(journal,key,false)).toBe(false);expect(journal.get(key)).toEqual(draft);
 journal.set(key,pending);expect(discardEditableStocktakeDraft(journal,key,true)).toBe(false);expect(journal.get(key)).toEqual(pending);
});
it('retains both UI draft and persisted content when deletion silently fails',()=>{
 const storage=new MemoryStorage();const journal=new StocktakeDraftJournal(principal,storage);journal.set(key,draft);
 const remove=storage.removeItem.bind(storage);storage.removeItem=()=>{};
 expect(discardEditableStocktakeDraft(journal,key,true)).toBe(false);expect(journal.get(key)).toEqual(draft);expect(storage.length).toBe(1);
 storage.removeItem=remove;expect(discardEditableStocktakeDraft(journal,key,true)).toBe(true);expect(journal.has(key)).toBe(false);expect(storage.length).toBe(0);
});
