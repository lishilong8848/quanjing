import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';

const root=process.cwd();
const original=JSON.parse(fs.readFileSync('D:/ai/nt-smoke-pool/baseline-extracted-20261003-191028/server-baseline-manifest.json','utf8').replace(/^\uFEFF/,''));
const production=JSON.parse(fs.readFileSync('D:/ai/nt-smoke-pool/candidate-20261003-191028/hotfix-manifest.json','utf8').replace(/^\uFEFF/,''));
for(const file of production.releaseFiles){if(!original.files.some(x=>x.path===file.targetPath))original.files.push({path:file.targetPath,sha256:file.sha256,size:file.size});}
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function run(mutate){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nt-baseline-gate-'));
  try {
    const baseline=structuredClone(original);mutate(baseline);
    const file=path.join(dir,'manifest.json');fs.writeFileSync(file,JSON.stringify(baseline));
    return spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/assert-current-production-baseline.ps1'),'-BaselineManifestPath',file,'-ProductionReleaseStatePath',path.join(root,'docs/engineering/production-release-state.json'),'-ProductionPackageRoot',path.join(root,'output/hotfix')],{encoding:'utf8',timeout:30000});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
}
test('installed production startup bytes are accepted instead of pre-install base bytes',()=>{
  const result=run(()=>{});assert.equal(result.status,0,result.stderr);
});
test('previous startup bytes are rejected even if runtime still matches',()=>{
  const result=run(b=>{b.baseFiles.find(x=>x.path==='start.ps1').sha256='440d7359408cd2182689fe69767c201d953a933165063f84b5dde711d9ac3d69';b.baseFingerprint=hash(b.baseFiles.map(x=>`${x.path}:${x.sha256}`).join('\n'));});assert.notEqual(result.status,0);
});
test('strict server drift is rejected',()=>{const result=run(b=>{b.files.find(x=>x.path.startsWith('dist/server/')).sha256='0'.repeat(64);});assert.notEqual(result.status,0);});
test('extra strict server file is rejected',()=>{const result=run(b=>{b.files.push({path:'dist/server/unmanaged.js',sha256:'0'.repeat(64),size:0});});assert.notEqual(result.status,0);});
test('duplicate base entry is rejected',()=>{const result=run(b=>{b.baseFiles.push(b.baseFiles[0]);b.baseFingerprint=hash(b.baseFiles.map(x=>`${x.path}:${x.sha256}`).join('\n'));});assert.notEqual(result.status,0);});
test('altered base checksum is rejected',()=>{const result=run(b=>{b.baseFingerprint='0'.repeat(64);});assert.notEqual(result.status,0);});
test('omitted installed startup helper is rejected before building',()=>{const result=run(b=>{b.files=b.files.filter(x=>x.path!=='scripts/verify-contract-storage-startup.mjs');});assert.notEqual(result.status,0);assert.match(result.stderr,/release target/);});
test('drifted installed startup helper is rejected before building',()=>{const result=run(b=>{b.files.find(x=>x.path==='scripts/verify-contract-storage-startup.mjs').sha256='0'.repeat(64);});assert.notEqual(result.status,0);assert.match(result.stderr,/release target/);});
