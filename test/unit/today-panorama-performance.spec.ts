import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { createBusinessClockNotifier, createPanoramaReadCoalescer } from '../../client/src/pages/TodayOperationsPanorama/panorama-refresh';
import { resolveShanghaiOnDutyLeadShift } from '../../client/src/pages/TodayOperationsPanorama/top-kpi-model';
const key = (date: Date) => `${new Date(date.getTime()+8*3600000).toISOString().slice(0,10)}:${resolveShanghaiOnDutyLeadShift(date)}`;
const date = (text:string) => new Date(text+'+08:00');
describe('panorama clock isolation',()=>{
 it('does not request a parent render during 3600 ordinary seconds',()=>{const initial=date('2026-11-11T10:00:00');const notify=jest.fn();const tick=createBusinessClockNotifier(key,initial,notify);for(let i=1;i<=3600;i++)tick(new Date(initial.getTime()+i*1000));expect(notify).not.toHaveBeenCalled();});
 it.each([['2026-11-11T08:59:59','2026-11-11T09:00:00'],['2026-11-11T17:59:59','2026-11-11T18:00:00'],['2026-11-11T23:59:59','2026-11-12T00:00:00']])('updates business state at %s', (before,after)=>{const notify=jest.fn();const tick=createBusinessClockNotifier(key,date(before),notify);tick(date(after));tick(date(after));expect(notify).toHaveBeenCalledTimes(1);expect(notify).toHaveBeenCalledWith(date(after));});
 it('catches up across suspended days on visibility tick',()=>{const notify=jest.fn();const tick=createBusinessClockNotifier(key,date('2026-11-11T10:00:00'),notify);tick(date('2026-11-13T19:00:00'));expect(notify).toHaveBeenCalledTimes(1);});
});
describe('panorama outstanding read merge',()=>{
 it('shares pending calls but never caches settled data',async()=>{const read=createPanoramaReadCoalescer();let done!:(value:number)=>void;const load=jest.fn(()=>new Promise<number>(r=>{done=r;}));const a=read('identity:date:false',load),b=read('identity:date:false',load);expect(a).toBe(b);await Promise.resolve();expect(load).toHaveBeenCalledTimes(1);done(1);await a;await read('identity:date:false',async()=>2).then(value=>expect(value).toBe(2));});
 it('separates identity, date and forced refresh and releases failed entries',async()=>{const read=createPanoramaReadCoalescer();const load=jest.fn(async()=>1);await Promise.all(['a:d:false','a:d:true','b:d:false','a:e:false'].map(key=>read(key,load)));expect(load).toHaveBeenCalledTimes(4);await expect(read('bad',async()=>{throw new Error('failure');})).rejects.toThrow('failure');await expect(read('bad',async()=>2)).resolves.toBe(2);});
});

describe('panorama identity boundary',()=>{
 it('keys the entire stateful page by the principal before rendering any old details',()=>{
  const source=readFileSync(resolve(__dirname,'../../client/src/pages/TodayOperationsPanorama/index.tsx'),'utf8');
  const wrapper=source.slice(source.indexOf('export default function TodayOperationsPanoramaPage()'),source.indexOf('function TodayOperationsPanoramaContent()')).replace('export default ','');
  const js=ts.transpileModule(wrapper,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React,module:ts.ModuleKind.CommonJS}}).outputText;
  let access:any={principalFingerprint:'person-a:v1',role:'inventory_admin',accountId:'a'};
  const content=()=>null;
  const render=Function('useAccess','TodayOperationsPanoramaContent','React',js+';return TodayOperationsPanoramaPage;')(()=>access,content,require('react'));
  const first=render();access={...access,principalFingerprint:'person-b:v1',accountId:'b'};const second=render();
  expect(first.type).toBe(content);expect(second.type).toBe(content);expect(first.key).not.toBe(second.key);
  access={...access,principalFingerprint:'person-b:v2'};expect(render().key).not.toBe(second.key);
  access={role:'guest',accountId:'guest-a'};const guest=render();access={role:'guest',accountId:'guest-b'};expect(render().key).not.toBe(guest.key);
 });
});
