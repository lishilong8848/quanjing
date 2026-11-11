jest.mock('../../client/src/api/csrf-token',()=>({getCurrentCsrfToken:jest.fn(()=> 'fresh-csrf-token')}));
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { profileChangeRequest,isProfileChangeRejected } from '../../client/src/api/profile-changes';
describe('profile request outcome classification',()=>{
 const original=global.fetch;
 afterEach(()=>{global.fetch=original;});
 it.each([400,409])('allows corrected input after an explicit %s rejection',async status=>{global.fetch=jest.fn(async()=>({ok:false,status,json:async()=>({message:'明确拒绝'})})) as any;const error=await profileChangeRequest('configuration/profile-changes/recover').catch(e=>e);expect(isProfileChangeRejected(error)).toBe(true);});
 it('keeps the original request for unknown network or service failure',async()=>{global.fetch=jest.fn().mockRejectedValue(new Error('offline'));expect(isProfileChangeRejected(await profileChangeRequest('personal/profile-changes').catch(e=>e))).toBe(false);global.fetch=jest.fn(async()=>({ok:false,status:503,json:async()=>({message:'待核对'})})) as any;expect(isProfileChangeRejected(await profileChangeRequest('personal/profile-changes').catch(e=>e))).toBe(false);});
});
describe('profile list polling and request restoration',()=>{
 function bind(data:any[]){const source=readFileSync(resolve(__dirname,'../../client/src/pages/PersonalCenter/ProfileChanges.tsx'),'utf8');const start=source.indexOf('    const load = async () => {'),end=source.indexOf('    void load();',start);const body=source.slice(start,end);const scope:any={listProfileChanges:jest.fn(async()=>data),admin:false,controller:new AbortController(),seenStatuses:{current:new Map()},completeCallback:{current:jest.fn()},auxiliaryRequests:{current:new Map()},reviewRequest:{current:null},mutation:{current:'original-request-id'},request:{current:null},crypto:{randomUUID:()=> 'next-request-id'},setTimeout:jest.fn()};for(const key of ['setRows','setRecovering','setReviewing','setLoadError','setLoaded','remember','setRecoveringDraft','setLocked','setLoading','setError'])scope[key]=jest.fn();const js=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;const load=Function(...Object.keys(scope),'let timer;'+js+';return load;')(...Object.values(scope));return {scope,load};}
 it('does not erase an unknown mutation error when refreshing the list',async()=>{const {scope,load}=bind([]);await load();expect(scope.setLoadError).toHaveBeenCalledWith('');expect(scope.setError).not.toHaveBeenCalled();});
 it('recovers the original accepted request by its persisted id without resubmitting',async()=>{const {scope,load}=bind([{id:'request-1',clientMutationId:'original-request-id',status:'pending'}]);await load();expect(scope.remember).toHaveBeenCalledWith(null);expect(scope.setLocked).toHaveBeenCalledWith(false);expect(scope.mutation.current).toBe('next-request-id');expect(scope.setLoaded).toHaveBeenCalledWith(true);});
});

describe('profile mutations csrf protection',()=>{
 const original=global.fetch;
 afterEach(()=>{global.fetch=original;});
 it.each(['personal/profile-changes','personal/profile-changes/cancel','configuration/profile-changes/review','configuration/profile-changes/recover'])('sends current CSRF token for %s',async path=>{const call=jest.fn(async()=>({ok:true,status:200,json:async()=>({})}));global.fetch=call as any;const body=path==='personal/profile-changes'?new FormData():{requestId:'r',expectedVersion:1,clientMutationId:'id'};await profileChangeRequest(path,body as any);expect((call.mock.calls as any)[0][1].headers['X-Suda-Csrf-Token']).toBe('fresh-csrf-token');if(body instanceof FormData)expect((call.mock.calls as any)[0][1].headers['Content-Type']).toBeUndefined();});
 it('reports a non-JSON CSRF rejection as explicit rejection without claiming an unknown write',async()=>{global.fetch=jest.fn(async()=>({ok:false,status:403,json:async()=>{throw new Error('html');}})) as any;const error=await profileChangeRequest('personal/profile-changes',new FormData()).catch(e=>e);expect(error.message).toContain('安全校验未通过');expect(isProfileChangeRejected(error)).toBe(true);});
});

describe('profile request time budgets',()=>{
 const original=global.fetch;
 beforeEach(()=>jest.useFakeTimers());
 afterEach(()=>{global.fetch=original;jest.useRealTimers();});
 it.each([['personal/profile-changes',true,60000],['configuration/profile-changes/review',true,15000],['personal/profile-changes',false,15000]])('bounds %s without losing unknown outcome',async(path,write,budget)=>{global.fetch=jest.fn((_url,init:any)=>new Promise((_r,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted'))))) as any;const promise=profileChangeRequest(path as string,write?new FormData():undefined).catch(error=>error);await jest.advanceTimersByTimeAsync(Number(budget)-1);expect((global.fetch as jest.Mock).mock.calls[0][1].signal.aborted).toBe(false);await jest.advanceTimersByTimeAsync(1);const error=await promise;expect(error.message).toContain('超时');expect(isProfileChangeRejected(error)).toBe(false);});
 it('cancels only the requested read and cleans up its timer',async()=>{global.fetch=jest.fn((_url,init:any)=>new Promise((_r,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('aborted'))))) as any;const cancel=new AbortController();const first=profileChangeRequest('personal/profile-changes',undefined,cancel.signal).catch(e=>e);const secondCancel=new AbortController();const second=profileChangeRequest('configuration/profile-changes',undefined,secondCancel.signal).catch(e=>e);cancel.abort();await first;expect((global.fetch as jest.Mock).mock.calls[1][1].signal.aborted).toBe(false);secondCancel.abort();await second;expect(jest.getTimerCount()).toBe(0);});
});
