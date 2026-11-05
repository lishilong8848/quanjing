import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseWorkflowStore } from '../../server/modules/purchase-inventory/purchase-workflow.store';

describe('platform identity evidence in the actual purchase command ledger',()=>{
 let directory:string,file:string,store:PurchaseWorkflowStore;
 const identity:any={source:'impersonation',actorAccountId:'admin_one',actorDisplayName:'管理员',actorAuthorizationVersion:7,subjectAccountId:'person_one',subjectDisplayName:'人员',subjectAuthorizationVersion:4,sessionFamilyFingerprint:'a'.repeat(43),expiresAt:2_000_000_000_000};
 const command:any={key:'order:rec_one',recordId:'rec_one',action:'order',fingerprint:'fingerprint',expectedResultFingerprint:'expected',actorOpenId:'',accessRole:'building_admin',authenticationMode:'delegated-app',startedAt:'2026-11-04T00:00:00.000Z',platformIdentity:identity};
 beforeEach(async()=>{directory=await mkdtemp(join(tmpdir(),'purchase-native-proof-'));file=join(directory,'ledger.json');store=new PurchaseWorkflowStore(file);await store.onModuleInit();});
 afterEach(async()=>{await store.onModuleDestroy();await rm(directory,{recursive:true,force:true});});
 it('persists both identities without a token, survives restart and cannot alter identity when completing',async()=>{
   await expect(store.claimCommand(command)).rejects.toThrow();
   expect((await store.claimCommand(command,()=>{})).claimed).toBe(true);
   const raw=await readFile(file,'utf8');expect(raw).toContain('admin_one');expect(raw).toContain('person_one');
   await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
   expect((await store.findCommand(command.key))?.platformIdentity).toEqual(identity);
   await expect(store.recordCommand({...command,platformIdentity:{...identity,actorAccountId:'other_admin'},completedAt:'2026-11-04T00:01:00.000Z',notificationWarnings:[]})).rejects.toThrow();
   await store.recordCommand({...command,platformIdentity:undefined,completedAt:'2026-11-04T00:01:00.000Z',notificationWarnings:[]});
   expect((await store.findCommand(command.key))?.platformIdentity).toEqual(identity);
 });
 it('fails closed on corruption instead of dropping platform identity',async()=>{
   await store.claimCommand(command,()=>{});const raw=JSON.parse(await readFile(file,'utf8'));raw.commands[0].platformIdentity.actorAuthorizationVersion=0;await writeFile(file,JSON.stringify(raw));
   await expect(store.findCommand(command.key)).rejects.toThrow('身份账本损坏');
 });
 it('requires a synchronous authorization and rejects a forged actor open ID',async()=>{
   await expect(store.claimCommand(command,(()=>Promise.resolve()) as never)).rejects.toThrow();
   await expect(store.claimCommand({...command,actorOpenId:'ou_somebody'},()=>{})).rejects.toThrow();
   expect(await store.findCommand(command.key)).toBeNull();
 });
 it('serializes prepared recovery against the send fence and rejects a stale attempt',async()=>{
   const first=await store.claimCommand(command,()=>{}), attempt=first.entry.platformAttemptId!;
   const outcomes=await Promise.allSettled([store.releaseCommandClaim(command.key,command.fingerprint,attempt,'prepared'),store.beginPlatformCommandDispatch(command.key,command.fingerprint,attempt)]);
   const state=await store.findCommand(command.key);
   if(state){expect(state.platformDispatch).toBe('dispatch_started');expect(await store.releaseCommandClaim(command.key,command.fingerprint,attempt,'prepared')).toBe(false);}
   else {expect(outcomes[0]).toMatchObject({status:'fulfilled',value:true});const next=await store.claimCommand(command,()=>{});expect(next.entry.platformAttemptId).not.toBe(attempt);await expect(store.beginPlatformCommandDispatch(command.key,command.fingerprint,attempt)).rejects.toThrow();}
 });
 it('persists dispatch_started across restart and only definite rejection releases that attempt',async()=>{
   const first=await store.claimCommand(command,()=>{}), attempt=first.entry.platformAttemptId!;
   await store.beginPlatformCommandDispatch(command.key,command.fingerprint,attempt);
   await store.onModuleDestroy();store=new PurchaseWorkflowStore(file);await store.onModuleInit();
   expect((await store.findCommand(command.key))?.platformDispatch).toBe('dispatch_started');
   expect(await store.releaseCommandClaim(command.key,command.fingerprint,attempt,'prepared')).toBe(false);
   expect(await store.releaseCommandClaim(command.key,command.fingerprint,'wrong','definite_rejection')).toBe(false);
   expect(await store.releaseCommandClaim(command.key,command.fingerprint,attempt,'definite_rejection')).toBe(true);
 });
});

