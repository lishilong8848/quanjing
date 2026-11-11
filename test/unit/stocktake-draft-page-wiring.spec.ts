const mockPrincipal = {role:'inventory_admin',purchaseBuilding:'C楼',buildings:['C楼'],accountId:'fixture-zch',authorizationVersion:1,principalFingerprint:'fixture-zch',capabilities:{canEdit:true,canDelete:true,canForceRefresh:true},isLoading:false};
jest.mock('react',()=>({
 ...jest.requireActual('react'),
 useRef:(value:unknown)=>({current:value}),
 useState:(value:unknown)=>[typeof value==='function'?(value as Function)():value,jest.fn()],
 useEffect:jest.fn(),useCallback:(fn:unknown)=>fn,useMemo:(fn:Function)=>fn(),useDeferredValue:(value:unknown)=>value,
}));
jest.mock('react-router-dom',()=>({...jest.requireActual('react-router-dom'),useSearchParams:()=>[new URLSearchParams('view=stocktake&action=execute'),jest.fn()]}));
jest.mock('../../client/src/access/AccessProvider',()=>({useAccess:()=>mockPrincipal}));
jest.mock('../../client/src/api',()=>({getInventoryManagementDashboard:jest.fn(),getInventoryManagementItems:jest.fn()}));
jest.mock('../../client/src/pages/InventoryManagement/inventory-stocktake.api',()=>({getStocktakeOverview:jest.fn()}));
jest.mock('../../client/src/pages/PurchaseInventoryManagement/ManagementHeader',()=>({ManagementHeader:()=>null}));
jest.mock('../../client/src/pages/InventoryManagement/InventoryMovementPage',()=>({InventoryMovementPage:()=>null}));
jest.mock('../../client/src/pages/InventoryManagement/InventoryDetailDialog',()=>({InventoryDetailDialog:()=>null}));
import InventoryManagementPage from '../../client/src/pages/InventoryManagement';
import { StocktakeDraftJournal } from '../../client/src/pages/InventoryManagement/stocktake-draft-journal';
class StorageMock implements Storage {
 readonly values=new Map<string,string>();get length(){return this.values.size;}key(i:number){return [...this.values.keys()][i]??null;}
 getItem(k:string){return this.values.get(k)??null;}setItem(k:string,v:string){this.values.set(k,v);}removeItem(k:string){this.values.delete(k);}clear(){this.values.clear();}
}
function pageDrafts(): StocktakeDraftJournal {
 const rendered=InventoryManagementPage() as any;
 // Actual execute branch: Suspense -> lazy InventoryStocktakePage props.
 return rendered.props.children.props.drafts;
}
it('wires persistent journal through the actual page and restores it after breakpoint remount or refresh',()=>{
 const storage=new StorageMock();Object.defineProperty(globalThis,'window',{value:{sessionStorage:storage},configurable:true});
 try {
  const first=pageDrafts();expect(first).toBeInstanceOf(StocktakeDraftJournal);
  const key='sample:2026-11:C楼:fixture-item-0';
  const draft={baseVersion:1,quantity:'13',person:{recordId:'recPerson',openId:'ou_person',name:'朱春华',employeeNo:'1',building:'C楼',position:'',specialty:''},note:'隔离验收草稿',dirty:true,retry:null};
  first.set(key,draft);expect(storage.length).toBe(1);
  const remounted=pageDrafts();expect(remounted).not.toBe(first);expect(remounted.get(key)).toEqual(draft);
  const refreshed=pageDrafts();expect(refreshed.get(key)).toEqual(draft);
 } finally {Reflect.deleteProperty(globalThis,'window');}
});

it('actual page restoration preserves pending IDs and isolates permission/account changes',()=>{
 const storage=new StorageMock();Object.defineProperty(globalThis,'window',{value:{sessionStorage:storage},configurable:true});
 try {
  const key='sample:2026-11:C楼:fixture-item-0';
  const payload={scope:'sample' as const,month:'2026-11',building:'C楼' as const,recordId:'fixture-item-0',expectedVersion:1,actualQuantity:13,confirmer:null,note:'保留原请求'};
  const pending={baseVersion:1,quantity:'13',person:null,note:payload.note,dirty:true,retry:{signature:JSON.stringify(['draft',payload]),request:{...payload,clientMutationId:'original-request-id'}}};
  pageDrafts().set(key,pending);
  expect(pageDrafts().get(key)?.retry?.request.clientMutationId).toBe('original-request-id');
  mockPrincipal.authorizationVersion=2;
  const changed=pageDrafts();expect(changed.get(key)).toBeUndefined();expect(changed.issue(key)).toContain('权限变更');
  mockPrincipal.accountId='different-user';expect(pageDrafts().size).toBe(0);
  expect(storage.length).toBe(1);
 } finally {mockPrincipal.authorizationVersion=1;mockPrincipal.accountId='fixture-zch';Reflect.deleteProperty(globalThis,'window');}
});
