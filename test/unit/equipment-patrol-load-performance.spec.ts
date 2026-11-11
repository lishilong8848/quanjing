import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
const source = readFileSync(resolve(__dirname,'../../client/src/pages/EquipmentPatrolDashboard/index.tsx'),'utf8');
const body = source.slice(source.indexOf('    async (refresh = false) => {', source.indexOf('const loadExecution')),source.indexOf('    [selectedMonth, canRefresh, executionContext]')).trim().replace(/,$/,'');
const deferred = () => { let resolve!: (x:unknown)=>void; let reject!: (x:unknown)=>void; const promise = new Promise((a,b)=>{resolve=a;reject=b;}); return {promise,resolve,reject}; };
function setup(canRefresh=true) {
 const first=deferred(),second=deferred();
 const scope:any={executionGeneration:{current:0},mounted:{current:true},contextRef:{current:'month-a'},executionContext:'month-a',selectedMonth:'2026-11',canRefresh,getEquipmentPatrolExecutions:jest.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)};
 for(const key of ['setExecutionLoading','setExecutionError','setExecutionResponse','setIsRefreshing'])scope[key]=jest.fn();
 const js=ts.transpileModule('const load = '+body+';', {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
 const load=Function(...Object.keys(scope),js+';return load;')(...Object.values(scope));
 return {scope,load,first,second};
}
describe('patrol response ordering',()=>{
 it('ignores an older refresh response and its loading completion',async()=>{const {scope,load,first,second}=setup();const a=load();const b=load(true);second.resolve('new');await b;first.resolve('old');await a;expect(scope.setExecutionResponse.mock.calls).toEqual([[null],['new']]);expect(scope.setExecutionLoading.mock.calls).toEqual([[true],[true],[false]]);});
 it('ignores a previous month before the next effect starts',async()=>{const {scope,load,first}=setup();const p=load();scope.contextRef.current='month-b';first.resolve('old');await p;expect(scope.setExecutionResponse.mock.calls).toEqual([[null]]);expect(scope.setExecutionLoading).not.toHaveBeenCalledWith(false);});
 it('does not publish errors or completion after unmount',async()=>{const {scope,load,first}=setup();const p=load(true);scope.mounted.current=false;first.reject(new Error('offline'));await p;expect(scope.setExecutionError.mock.calls).toEqual([[null]]);expect(scope.setExecutionLoading).not.toHaveBeenCalledWith(false);});
 it('does not elevate refresh permission and adds no artificial delay',async()=>{const {scope,load,first}=setup(false);const p=load(true);expect(scope.getEquipmentPatrolExecutions).toHaveBeenCalledWith('2026-11',false);first.resolve('done');await p;expect(scope.setIsRefreshing).toHaveBeenLastCalledWith(false);const handler=source.slice(source.indexOf('  const handleRefresh ='),source.indexOf('  const kpis'));expect(handler).not.toContain('setTimeout');});
});
