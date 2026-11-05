import { retainPurchaseLedgerCapability, validatePurchaseLedgerCapability, PURCHASE_LEDGER_CAPABILITY } from '../../server/modules/purchase-inventory/purchase-ledger-capability';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
describe('purchase ledger runtime capability barrier',()=>{
  it('leaves legacy-only ledgers alone, marks new records, and never clears an existing marker',()=>{
    const old:any={version:2,commands:[],notifications:[],managerApprovalBatches:[]};retainPurchaseLedgerCapability(old);expect(old.requiredRuntimeCapability).toBeUndefined();
    old.commands.push({platformIdentity:{source:'platform'}});retainPurchaseLedgerCapability(old);expect(old.requiredRuntimeCapability).toBe(PURCHASE_LEDGER_CAPABILITY);
    old.commands=[];retainPurchaseLedgerCapability(old);expect(old.requiredRuntimeCapability).toBe(PURCHASE_LEDGER_CAPABILITY);
    expect(()=>validatePurchaseLedgerCapability('future-unknown')).toThrow();
  });
  it('preserves the marker across ordinary store writes and rejects an unsupported marker without changing bytes',async()=>{
    const directory=await mkdtemp(join(tmpdir(),'purchase-capability-')),file=join(directory,'ledger.json'),store=new PurchaseWorkflowStore(file);
    try{
      await store.onModuleInit();await store.recordReminder('initial');
      const raw=JSON.parse(await readFile(file,'utf8'));raw.requiredRuntimeCapability=PURCHASE_LEDGER_CAPABILITY;await writeFile(file,JSON.stringify(raw));
      await store.recordReminder('ordinary-write');expect(JSON.parse(await readFile(file,'utf8')).requiredRuntimeCapability).toBe(PURCHASE_LEDGER_CAPABILITY);
      raw.requiredRuntimeCapability='future-unknown';await writeFile(file,JSON.stringify(raw));const before=await readFile(file);
      await expect(store.recordReminder('must-not-write')).rejects.toThrow('不支持');expect(await readFile(file)).toEqual(before);
    }finally{await store.onModuleDestroy();await rm(directory,{recursive:true,force:true});}
  });
});
