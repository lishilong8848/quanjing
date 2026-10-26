'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),{spawnSync}=require('node:child_process');
const script=path.resolve('scripts/diagnostics/Collect-ApprovalLatency.ps1'),id='reczz28QKx6qoPZ6',purchase='reczz28PyQ7oAauG',secret='SYNTHETIC_SECRET_NEVER_EXPORT',hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function fixture(fn){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-approval-latency-')),root=path.join(dir,'app'),out=path.join(dir,'reports');
 fs.mkdirSync(path.join(root,'dist/server'),{recursive:true});fs.mkdirSync(path.join(root,'logs'));fs.mkdirSync(path.join(root,'.runtime'));fs.mkdirSync(path.join(dir,'nantong-schedule-state'));
 fs.writeFileSync(path.join(root,'start.ps1'),'# inert');fs.writeFileSync(path.join(root,'dist/server/main.js'),'// inert');fs.writeFileSync(path.join(root,'.env'),'SECRET='+secret);
 const leave=path.join(dir,'nantong-schedule-state/leave-workflow-ledger.json'),buy=path.join(root,'.runtime/purchase-workflow-ledger.json'),log=path.join(root,'logs/app.out.log');
 fs.writeFileSync(leave,JSON.stringify({version:4,applications:[{recordId:id,status:'approved',snapshot:{reason:secret}}],actions:[],tasks:[]}));
 fs.writeFileSync(buy,JSON.stringify({version:2,notifications:[{recordId:purchase,kind:'manager_batch_order_command',status:'completed',attempts:1,lastError:secret,cardContext:secret},{recordId:'rec_other',kind:secret,status:'pending'}],managerApprovalBatches:[{recordIds:[purchase],messageId:'om_test',cardContext:secret}]}));
 fs.writeFileSync(log,`2026-10-22 13:18:40 LOG record=${id} prepareMs=3010 commitMs=35 totalMs=3045 claimed=true PRIVATE=${secret}\n2026-10-22 05:18:40 LOG ${purchase} ETIMEDOUT ${secret}\n2026-10-22 05:18:41 WARN record=${purchase} action=submit_order queueMs=200 readMs=2600 decisionMs=30 writeMs=20 renderMs=5 totalMs=2855 claimed=true ${secret}\n`);
 const files=[leave,buy,log,path.join(root,'.env'),path.join(root,'start.ps1'),path.join(root,'dist/server/main.js')];
 const env={...process.env};delete env.LEAVE_WORKFLOW_LEDGER_PATH;delete env.PURCHASE_WORKFLOW_LEDGER_PATH;
 const run=(args=[])=>spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-AppRoot',root,...(args.includes('-OutputDirectory')?[]:['-OutputDirectory',out]),...args],{env,encoding:'utf8',windowsHide:true,timeout:25000});
 try{fn({dir,root,out,files,run,buy,log,leave});}finally{assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));assert(path.basename(dir).startsWith('nt-approval-latency-'));fs.rmSync(dir,{recursive:true,force:true});}
}
test('exports exact case timings and purchase task metadata without secrets or mutation',()=>fixture(f=>{
 const before=f.files.map(hash),r=f.run();assert.equal(r.status,0,r.stderr||r.stdout);const s=JSON.parse(r.stdout.trim()),v=JSON.parse(fs.readFileSync(s.reportPath));
 assert.equal(v.purchaseLedger.status,'matched');assert.equal(v.purchaseLedger.counts.notifications,2);assert.equal(v.purchaseLedger.tasks.length,1);
 assert.deepEqual(v.logs[0].events[0].acceptanceTiming,{caseCode:'XJ-1180',prepareMs:3010,commitMs:35,totalMs:3045,claimed:true});
 assert.deepEqual(v.logs[0].events[2].acceptanceTiming,{caseCode:'CG261021-602',action:'submit_order',queueMs:200,readMs:2600,decisionMs:30,writeMs:20,renderMs:5,totalMs:2855,claimed:true});
 assert.equal(v.logs[0].events[1].acceptanceTiming,null);assert.equal(v.applicationWrites,0);assert.equal(v.networkCalls,0);assert.equal(v.runtimeEnvironmentVerified,false);
 const text=JSON.stringify(v);for(const blocked of [secret,'rec_other','cardContext','claimToken'])assert(!text.includes(blocked),blocked);
 assert.deepEqual(f.files.map(hash),before);assert.equal(hash(s.reportPath),s.reportSha256);
}));
test('missing purchase evidence is incomplete and never looks successful',()=>fixture(f=>{
 fs.unlinkSync(f.buy);const r=f.run();assert.equal(r.status,2,r.stderr||r.stdout);const v=JSON.parse(fs.readFileSync(JSON.parse(r.stdout.trim()).reportPath));assert.equal(v.purchaseLedger.status,'missing');assert.equal(v.status,'incomplete');
}));
test('refuses output within the application and leaves original bytes unchanged',()=>fixture(f=>{
 const before=f.files.map(hash),r=f.run(['-OutputDirectory',path.join(f.root,'bad-output')]);assert.equal(r.status,1);assert.match(r.stderr,/DIAG_OUTPUT_INSIDE_APPLICATION/);assert(!fs.existsSync(path.join(f.root,'bad-output')));assert.deepEqual(f.files.map(hash),before);
}));
test('explicit purchase ledger configuration is respected without exporting its contents',()=>fixture(f=>{
 const custom=path.join(f.dir,'custom.json');fs.renameSync(f.buy,custom);fs.appendFileSync(path.join(f.root,'.env'),'\nPURCHASE_WORKFLOW_LEDGER_PATH="'+custom+'"\n');
 const r=f.run();assert.equal(r.status,0,r.stderr||r.stdout);const v=JSON.parse(fs.readFileSync(JSON.parse(r.stdout.trim()).reportPath));assert.equal(v.purchaseLedger.status,'matched');assert(!JSON.stringify(v).includes(custom));
}));
