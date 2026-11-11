import { createInventoryInboundQueryPool } from '../../client/src/pages/InventoryManagement/inventory-inbound-query-pool';
it('limits reads to two and lets later tasks run after a pending response', async () => {
 const run=createInventoryInboundQueryPool(); let active=0,max=0; const release: Array<()=>void>=[];
 const query=()=>run(async()=>{active++;max=Math.max(max,active);await new Promise<void>(r=>release.push(r));active--;return 'pending';});
 const a=query(),b=query(),c=query();await Promise.resolve();expect(release).toHaveLength(2);
 release.shift()!();await a;await Promise.resolve();expect(release).toHaveLength(2);
 release.splice(0).forEach(fn=>fn());await Promise.all([b,c]);expect(max).toBe(2);
});
it('releases a slot after an error',async()=>{const run=createInventoryInboundQueryPool(1);const a=run(async()=>{throw new Error('network');});const b=run(async()=>42);await expect(a).rejects.toThrow('network');await expect(b).resolves.toBe(42);});

it('reconciles twenty independent reads in ten waves while preserving input order', async () => {
 jest.useFakeTimers();
 try {
  const run=createInventoryInboundQueryPool(2);let finished=0;
  const result=Promise.all(Array.from({length:20},(_,i)=>run(async()=>{
   await new Promise<void>(resolve=>setTimeout(resolve,100));finished++;return i;
  })));
  await jest.advanceTimersByTimeAsync(999);expect(finished).toBe(18);
  await jest.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toEqual(Array.from({length:20},(_,i)=>i));
 } finally {jest.useRealTimers();}
});
