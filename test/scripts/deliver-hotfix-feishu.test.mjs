import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const moduleUrl = new URL('../../scripts/deliver-hotfix-feishu.mjs', import.meta.url);
const load = () => import(moduleUrl);
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const appId = 'cli_a9d1c9fe9d381cee';
const auth = {appId, verified:true, identities:{bot:{available:true, verified:true}}};
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'nt-file-delivery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'output/hotfix'),{recursive:true});
  const id='nantong-safe-full-runtime-hotfix-20261021-123253';
  const outer=path.join(root,'output/hotfix/nantong-one-click-hotfix-20261021-123253.zip');
  fs.writeFileSync(outer,'synthetic accepted ZIP');
  const report={packageId:id,status:'accepted-for-user-deployment-not-production-registered',outerPath:outer,outerSha256:sha(fs.readFileSync(outer)),evidenceBindings:[]};
  const deliveryPath=path.join(root,'output/DELIVERY.json'); fs.writeFileSync(deliveryPath,JSON.stringify(report));
  return {root,deliveryPath,outer,report};
}
function transport(f, options={}) {
  const calls=[];
  const cli=async args=>{
    calls.push(args);
    if(args[0]==='auth')return options.auth||auth;
    if(args.includes('+messages-send')) {
      if(options.fail)throw Error('send failed');
      return {message_id:args.includes('--file')?'om_file':'om_text',chat_id:'oc_dm',create_time:'1'};
    }
    if(args.includes('+messages-mget'))return {messages:[{message_id:'om_file',msg_type:'file',content:JSON.stringify({file_key:'file_proof',file_name:path.basename(f.outer)})}]};
    if(args.includes('+messages-resources-download')) {
      fs.writeFileSync(path.resolve(f.root,args[args.indexOf('--output')+1]),options.badDownload?'corrupted':fs.readFileSync(f.outer));
      return {success:true};
    }
    throw Error('unexpected CLI call');
  };
  return {calls,cli};
}
test('delivery entry point exists',async()=>assert.equal(typeof (await load()).deliver,'function'));
test('sends exact accepted ZIP and metadata once, persists remote recovery identity',async t=>{
  const f=fixture(t), api=transport(f), {deliver}=await load();
  const first=await deliver({...f,cli:api.cli});
  assert.equal(first.fileMessageId,'om_file'); assert.equal(first.metadataMessageId,'om_text');
  assert.equal(first.fileKey,'file_proof'); assert.equal(first.downloadVerified,true);
  assert(fs.existsSync(f.outer));
  const again=await deliver({...f,cli:api.cli}); assert.equal(again.fileMessageId,first.fileMessageId);
  assert.equal(api.calls.filter(a=>a.includes('+messages-send')).length,2);
});
test('wrong application cannot reuse the confirmed app-specific Open ID',async t=>{
  const f=fixture(t), api=transport(f,{auth:{...auth,appId:'cli_wrong'}});
  await assert.rejects((await load()).deliver({...f,cli:api.cli}),/application/);
  assert.equal(api.calls.filter(a=>a.includes('+messages-send')).length,0); assert(fs.existsSync(f.outer));
});
test('send failure retains ZIP and uncertain intent prevents blind retry',async t=>{
  const f=fixture(t), api=transport(f,{fail:true}), {deliver}=await load();
  await assert.rejects(deliver({...f,cli:api.cli}),/send failed/); assert(fs.existsSync(f.outer));
  const next=transport(f); await assert.rejects(deliver({...f,cli:next.cli}),/uncertain/);
  assert.equal(next.calls.filter(a=>a.includes('+messages-send')).length,0);
});
test('modified package rejected before any send',async t=>{
  const f=fixture(t), api=transport(f); fs.appendFileSync(f.outer,'drift');
  await assert.rejects((await load()).deliver({...f,cli:api.cli}),/SHA/);
  assert.equal(api.calls.length,0);
});
test('ZIP outside exact output/hotfix boundary rejected',async t=>{
  const f=fixture(t), api=transport(f); const p=path.join(f.root,'elsewhere.zip'); fs.copyFileSync(f.outer,p);
  fs.writeFileSync(f.deliveryPath,JSON.stringify({...f.report,outerPath:p}));
  await assert.rejects((await load()).deliver({...f,cli:api.cli}),/boundary/); assert.equal(api.calls.length,0);
});
test('download SHA mismatch keeps source ZIP and does not mark remote verified',async t=>{
  const f=fixture(t), api=transport(f,{badDownload:true});
  await assert.rejects((await load()).deliver({...f,cli:api.cli}),/download SHA/); assert(fs.existsSync(f.outer));
});
test('CLI normalized file marker is parsed without repeating successful messages',async t=>{
  const f=fixture(t), api=transport(f);
  const cli=async args=>args.includes('+messages-mget')?{messages:[{message_id:'om_file',msg_type:'file',content:'<file key="file_proof" name="package.zip" />'}]}:api.cli(args);
  const r=await (await load()).deliver({...f,cli});
  assert.equal(r.fileKey,'file_proof'); assert.equal(r.downloadVerified,true);
});
test('changed evidence blocks delivery',async t=>{
  const f=fixture(t), api=transport(f), e=path.join(f.root,'output/acceptance.json'); fs.writeFileSync(e,'changed');
  fs.writeFileSync(f.deliveryPath,JSON.stringify({...f.report,evidenceBindings:[{path:e,sha256:sha('original')}]}));
  await assert.rejects((await load()).deliver({...f,cli:api.cli}),/evidence/); assert.equal(api.calls.length,0);
});
test('restore entry point restores only the SHA-bound remote attachment',async t=>{
  const f=fixture(t), api=transport(f), mod=await load();
  assert.equal(typeof mod.restore,'function');
  const result=await mod.deliver({...f,cli:api.cli});
  const bytes=fs.readFileSync(f.outer); fs.unlinkSync(f.outer); fs.unlinkSync(result.downloadPath);
  const cli=async args=>{
    if(args[0]==='auth')return auth;
    if(args.includes('+messages-resources-download')){fs.writeFileSync(path.resolve(f.root,args[args.indexOf('--output')+1]),bytes);return {};}
    throw Error('restore must never send');
  };
  const recovered=await mod.restore({...f,cli});
  assert.equal(recovered.outerSha256,f.report.outerSha256);
  assert.equal(sha(fs.readFileSync(f.outer)),f.report.outerSha256);
});
test('restores embedded inner ZIP with its own exact SHA',async t=>{
  const f=fixture(t), {zipSync}=createRequire(import.meta.url)('fflate');
  const inner=Buffer.from('synthetic inner bytes'), outer=zipSync({'_hotfix-payload\\hotfix-package.zip':inner});
  fs.writeFileSync(f.outer,outer);
  const d={...f.report,outerSha256:sha(outer),innerPath:path.join(f.root,'output/hotfix',f.report.packageId+'.zip'),innerSha256:sha(inner)};
  fs.writeFileSync(f.deliveryPath,JSON.stringify(d));
  const api=transport(f), {deliver,restore}=await load(); const receipt=await deliver({...f,cli:api.cli});
  fs.unlinkSync(f.outer);fs.unlinkSync(receipt.downloadPath);
  const result=await restore({...f,cli:async args=>{
    if(args[0]==='auth')return auth;
    if(args.includes('+messages-resources-download')){fs.writeFileSync(path.resolve(f.root,args[args.indexOf('--output')+1]),outer);return {};}
    throw Error('no sends during restore');
  }});
  assert.equal(result.innerSha256,sha(inner)); assert.deepEqual(fs.readFileSync(d.innerPath),inner);
});
test('restore rejects changed report without downloading',async t=>{
  const f=fixture(t),api=transport(f), {deliver,restore}=await load(); await deliver({...f,cli:api.cli});
  fs.writeFileSync(f.deliveryPath,JSON.stringify({...f.report,innerPath:'changed'}));
  const before=api.calls.length;await assert.rejects(restore({...f,cli:api.cli}),/binding/);assert.equal(api.calls.length,before);
});
test('PowerShell cleanup result sums hashtable rows without failing after deletion',()=>{
  const script=fs.readFileSync(new URL('../../scripts/deliver-hotfix-feishu.ps1',import.meta.url),'utf8');
  const resultLine=script.split(/\r?\n/).find(l=>l.trim().startsWith('$result=[ordered]'));
  assert(resultLine);
  const planPath=fileURLToPath(import.meta.url).replaceAll("'","''");
  const command=`$ErrorActionPreference='Stop';$rows=@(@{size=11},@{size=19});$d=[pscustomobject]@{packageId='synthetic'};$planPath='${planPath}';${resultLine};$result.releasedBytes`;
  assert.equal(execFileSync('powershell.exe',['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true}).trim(),'30');
});
