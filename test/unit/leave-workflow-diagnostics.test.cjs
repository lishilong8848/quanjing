'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const script=path.resolve(process.env.NT_XJ_DIAGNOSTIC_SCRIPT||'scripts/diagnostics/Collect-XJ1179.ps1');
const recordId='reczz28QGuhnfZME',other='rec_other_private';
const secret='SYNTHETIC_PRIVATE_NEVER_EXPORT_1179';
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function fixture(fn){
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'nt-xj1179-'));
 const root=path.join(base,'app'),out=path.join(base,'reports');
 fs.mkdirSync(path.join(root,'dist/server'),{recursive:true});fs.mkdirSync(path.join(root,'logs'));
 fs.mkdirSync(path.join(base,'nantong-schedule-state'));
 fs.writeFileSync(path.join(root,'start.ps1'),'# synthetic inert startup');fs.writeFileSync(path.join(root,'dist/server/main.js'),'// synthetic inert server');
 fs.writeFileSync(path.join(root,'.env'),'APP_SECRET='+secret+'\n');
 fs.writeFileSync(path.join(root,'.hotfix-installed-release.json'),JSON.stringify({schemaVersion:2,deploymentId:'nantong-safe-full-runtime-hotfix-20261021-191000',secret}));
 const ledger=path.join(base,'nantong-schedule-state/leave-workflow-ledger.json');
 const data={version:4,applications:[{recordId,status:'approved',revision:4,createdAt:'2026-10-22T01:33:00Z',updatedAt:'2026-10-22T01:34:10Z',resolvedAt:'2026-10-22T01:34:09Z',currentStage:null,stageCards:[{messageId:'om_target',recipientOpenId:secret,businessKey:secret}],resultCards:[{messageId:'om_result'}],terminalCardMessageIds:['om_target'],snapshot:{reason:secret,token:secret},lastError:secret},{recordId:other,status:'pending',snapshot:{reason:secret}}],actions:[{recordId,stageKey:'supervisor',stageVersion:1,action:'approve',messageId:'om_target',createdAt:'2026-10-22T01:34:09Z',eventId:secret,actorName:secret,key:secret},{recordId:other,key:secret}],tasks:[{recordId,key:'task-target',kind:'sync_stage_action_cards',status:'completed',attempts:1,createdAt:'2026-10-22T01:34:09Z',updatedAt:'2026-10-22T01:34:10Z',completedAt:'2026-10-22T01:34:10Z',claimToken:secret,lastError:'ETIMEDOUT '+secret,payload:{stageKey:'supervisor',stageVersion:1,recovery:false,patchedMessageIds:['om_target'],token:secret}},{recordId:other,key:secret}]};
 fs.writeFileSync(ledger,JSON.stringify(data));
 fs.writeFileSync(path.join(root,'logs/app.out.log'),'2026-10-22 09:34:10 LOG '+recordId+' ETIMEDOUT Bearer '+secret+'\n2026-10-22 09:34:10 LOG '+other+' '+secret+'\n');
 fs.writeFileSync(path.join(root,'logs/app.err.log'),'2026-10-22 09:34:02 WARN Feishu card action rejected: timeout '+secret+'\n');
 try{return fn({base,root,out,ledger,data});}finally{
  assert(path.resolve(base).startsWith(path.resolve(os.tmpdir())+path.sep));assert(path.basename(base).startsWith('nt-xj1179-'));
  fs.rmSync(base,{recursive:true,force:true});
 }
}
function invoke(f,extra=[]){
 assert(fs.existsSync(script),'diagnostic collector must exist');
 const env={...process.env};delete env.LEAVE_WORKFLOW_LEDGER_PATH;
 const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-AppRoot',f.root,'-OutputDirectory',f.out,...extra],{encoding:'utf8',env,windowsHide:true,timeout:20000});
 assert(!r.error,r.error?.message);return r;
}
function report(r,expected=0){assert.equal(r.status,expected,r.stderr||r.stdout);const summary=JSON.parse(r.stdout.trim());return {summary,value:JSON.parse(fs.readFileSync(summary.reportPath,'utf8'))};}
function snapshots(f){return [f.ledger,path.join(f.root,'.env'),path.join(f.root,'start.ps1'),path.join(f.root,'dist/server/main.js'),path.join(f.root,'logs/app.out.log'),path.join(f.root,'logs/app.err.log'),path.join(f.root,'.hotfix-installed-release.json')].map(p=>[p,hash(p)]);}
test('collects only target metadata, never secrets or source changes, and does not overwrite reports',()=>fixture(f=>{
 const before=snapshots(f),a=report(invoke(f)),b=report(invoke(f));
 assert.equal(a.value.caseRecordId,recordId);assert.equal(a.value.ledgers[0].applications.length,1);
 assert.equal(a.value.ledgers[0].tasks[0].kind,'sync_stage_action_cards');
 assert.deepEqual(a.value.ledgers[0].tasks[0].patchedMessageIds,['om_target']);
 assert.deepEqual(a.value.ledgers[0].tasks[0].errorCodes,['ETIMEDOUT']);
 assert.equal(a.value.fullApprovalProof,false);assert.equal(a.value.networkCalls,0);assert.equal(a.value.applicationWrites,0);
 assert.equal(a.value.runtimeEnvironmentVerified,false);assert.equal(a.value.receiptVerified,false);
 const text=JSON.stringify(a.value)+a.summary.reportPath;
 for(const blocked of [secret,other])assert(!text.includes(blocked),blocked);
 const keys=[];function visit(v){if(!v||typeof v!=='object')return;for(const [k,item] of Object.entries(v)){keys.push(k);visit(item);}}visit(a.value);
 for(const blocked of ['claimToken','snapshot','rejectionReason','lastError','payload','actorName','reason'])assert(!keys.includes(blocked),blocked);
 assert.match(a.value.ledgers[0].snapshotSha256,/^[a-f0-9]{64}$/);
 assert.notEqual(a.summary.reportPath,b.summary.reportPath);assert.deepEqual(snapshots(f),before);
 assert.equal(a.value.logs[0].events[0].correlation,'case-or-message-id');
 assert.equal(a.value.logs[1].events[0].correlation,'window-only-not-case-proven');
}));
test('dotenv local absolute path overrides default without exporting configuration contents',()=>fixture(f=>{
 const custom=path.join(f.base,'custom-ledger.json');f.data.applications[0].revision=19;fs.writeFileSync(custom,JSON.stringify(f.data));const before=hash(custom);
 fs.writeFileSync(path.join(f.root,'.env'),'LEAVE_WORKFLOW_LEDGER_PATH=missing.json\nAPP_SECRET='+secret);
 fs.writeFileSync(path.join(f.root,'.env.local'),'LEAVE_WORKFLOW_LEDGER_PATH="'+custom+'"\nAPP_SECRET='+secret);
 const a=report(invoke(f));assert.equal(a.value.pathResolution.source,'.env.local');assert.equal(a.value.ledgers[0].status,'matched');
 assert.equal(a.value.ledgers[0].applications[0].revision,19);assert.equal(hash(custom),before);
 assert(!JSON.stringify(a.value).includes(secret));
}));
test('missing or malformed ledger yields explicit incomplete report, not success',()=>fixture(f=>{
 fs.unlinkSync(f.ledger);let a=report(invoke(f),2);assert.equal(a.value.ledgers[0].status,'missing');assert.equal(a.value.status,'incomplete');
 fs.writeFileSync(f.ledger,'not JSON '+secret);a=report(invoke(f),2);assert.equal(a.value.ledgers[0].status,'invalid-json');assert(!JSON.stringify(a.value).includes(secret));
}));
test('legacy ledger stays independently labelled, not silently adopted or merged',()=>fixture(f=>{
 fs.mkdirSync(path.join(f.root,'data/leave-workflow'),{recursive:true});fs.writeFileSync(path.join(f.root,'data/leave-workflow/ledger.json'),JSON.stringify(f.data));
 fs.unlinkSync(f.ledger);const a=report(invoke(f),2);assert.equal(a.value.ledgers[0].status,'missing');assert.equal(a.value.ledgers[1].role,'legacy-not-proven-active');assert.equal(a.value.ledgers[1].status,'matched');
}));
test('junction roots are refused without writing a report',()=>fixture(f=>{
 const linked=path.join(f.base,'linked-app');fs.symlinkSync(f.root,linked,'junction');const r=invoke({...f,root:linked});assert.equal(r.status,1);assert.match(r.stderr,/DIAG_UNSAFE_PATH/);assert(!fs.existsSync(f.out));
}));
test('unrecognized task strings and arbitrary payloads cannot escape whitelist',()=>fixture(f=>{
 f.data.tasks[0].kind=secret;f.data.tasks[0].status=secret;f.data.tasks[0].payload.stageKey=secret;f.data.tasks[0].payload.patchedMessageIds=[secret];f.data.tasks[0].createdAt=secret;
 fs.writeFileSync(f.ledger,JSON.stringify(f.data));const a=report(invoke(f));assert(!JSON.stringify(a.value).includes(secret));assert.equal(a.value.ledgers[0].tasks[0].kind,'unknown');
}));
test('Nest en-US timestamps are recognized in the exact case window',()=>fixture(f=>{
 fs.writeFileSync(path.join(f.root,'logs/app.err.log'),'[Nest] 123 - 10/22/2026, 9:34:02 AM WARN Feishu card action rejected: '+secret+'\n');
 const a=report(invoke(f));assert.equal(a.value.logs[1].events.length,1);assert.equal(a.value.logs[1].events[0].timeCandidate,'2026-10-22 09:34:02');
}));
test('bounded full log scan retains early UTC errors beyond the old tail',()=>fixture(f=>{
 fs.writeFileSync(path.join(f.root,'logs/app.out.log'),Buffer.concat([Buffer.from('2026-10-22 01:34:02 WARN Feishu card action rejected: ETIMEDOUT '+secret+'\n'),Buffer.alloc(9*1024*1024,120),Buffer.from('\n2026-10-22 10:20:10 unrelated\n')]));
 const before=snapshots(f),a=report(invoke(f));
 assert.equal(a.value.logs[0].coverage,'complete-bounded-file');
 assert.equal(a.value.logs[0].tailTruncated,false);assert.equal(a.value.logs[0].events.length,1);
 assert.equal(a.value.logs[0].events[0].timeCandidate,'2026-10-22 01:34:02');
 assert.equal(a.value.logs[0].events[0].timeBasisCandidate,'UTC-compatible-unverified');
 assert.equal(a.value.logs[0].events[0].correlation,'window-only-not-case-proven');
 assert(!JSON.stringify(a.value).includes(secret));assert.deepEqual(snapshots(f),before);
}));
test('queue aggregates expose overdue work without exporting other record identities',()=>fixture(f=>{
 f.data.tasks.push({recordId:other,key:secret,businessKey:secret,kind:'sync_approved_leave_schedule',status:'pending',attempts:0,nextAttemptAt:'2026-10-22T01:34:33Z',createdAt:'2026-10-22T01:34:33Z',payload:{secret},lastError:secret});
 fs.writeFileSync(f.ledger,JSON.stringify(f.data));const a=report(invoke(f)),ledger=a.value.ledgers[0];
 assert.equal(ledger.fileBytes,fs.statSync(f.ledger).size);assert.equal(ledger.applicationCount,2);assert.equal(ledger.taskCount,3);
 assert.equal(typeof ledger.readHashParseElapsedMs,'number');assert(ledger.readHashParseElapsedMs>=0);
 assert.deepEqual(ledger.queueSummary.find(x=>x.kind==='sync_approved_leave_schedule'),{kind:'sync_approved_leave_schedule',status:'pending',count:1,overdueCount:1,unattemptedCount:1,hasErrorCount:1,oldestNextAttemptAt:'2026-10-22T01:34:33.0000000+00:00'});
 assert(!JSON.stringify(a.value).includes(secret));assert(!JSON.stringify(a.value).includes(other));
}));
test('generic window error floods cannot displace target-case log evidence',()=>fixture(f=>{
 fs.writeFileSync(path.join(f.root,'logs/app.out.log'),('2026-10-22 01:34:02 WARN Feishu card action rejected: ETIMEDOUT\n').repeat(600)+'2026-10-22 01:34:12 '+recordId+' '+secret+'\n');
 const a=report(invoke(f));assert.equal(a.value.logs[0].eventsTruncated,true);assert(a.value.logs[0].events.some(x=>x.correlation==='case-or-message-id'));assert(a.value.logs[0].events.length<=500);assert(!JSON.stringify(a.value).includes(secret));
}));
test('oversized logs retain explicit bounded tail fallback',()=>fixture(f=>{
 const p=path.join(f.root,'logs/app.out.log'),fd=fs.openSync(p,'w');fs.ftruncateSync(fd,129*1024*1024);fs.writeSync(fd,Buffer.from('\n2026-10-22 09:34:10 '+recordId+' ETIMEDOUT\n'),0,undefined,129*1024*1024);fs.closeSync(fd);
 const a=report(invoke(f));assert.equal(a.value.logs[0].coverage,'tail-only-oversized');assert.equal(a.value.logs[0].tailTruncated,true);assert.equal(a.value.logs[0].tailBytes,8388608);assert.equal(a.value.logs[0].events.length,1);
}));
test('moderate logs include all bytes rather than silently dropping the head',()=>fixture(f=>{
 fs.writeFileSync(path.join(f.root,'logs/app.out.log'),Buffer.concat([Buffer.alloc(9*1024*1024,120),Buffer.from('\n2026-10-22 09:34:10 '+recordId+' ETIMEDOUT\n')]));
 const a=report(invoke(f));assert.equal(a.value.logs[0].tailTruncated,false);assert.equal(a.value.logs[0].tailBytes,fs.statSync(path.join(f.root,'logs/app.out.log')).size);assert.equal(a.value.logs[0].events.length,1);
}));
