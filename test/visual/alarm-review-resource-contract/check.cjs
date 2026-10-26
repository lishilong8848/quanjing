'use strict';
const fs=require('node:fs'), path=require('node:path'), crypto=require('node:crypto'), assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../..');
const evidence=path.join(root,'output/release-next-after-20261005-182903');
const logo=path.join(root,'client/public/assets/vnet-logo-transparent.png');
const logoSha='222250e0c2238f228c4eae76aa748ebb9d07f4bbf6cb6c720616778308e3edfc';
const preparedFile=path.join(evidence,'alarm-review-resource-pure-prepared-20261006-v1.json');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const rejected=()=>{throw new Error('RESOURCE_REJECTED');};
function strictOpen(original) { return function(file,flags,...args) {
  if(file!==logo || !path.isAbsolute(file) || (flags!=='r' && flags!==fs.constants.O_RDONLY)) rejected();
  return original.call(this,file,flags,...args);
}; }
function classify(value,known) {
  if(!value || typeof value.url!=='string' || typeof value.method!=='string' || typeof value.abortCompleted!=='boolean') return 'unverified';
  return known.includes(value.url) && value.method==='GET' && value.abortCompleted && value.abortReason==='blockedbyclient'
    ? 'known-external-get-rejected' : 'unknown-or-unverified-rejected';
}
async function run() {
  assert.deepEqual(process.argv.slice(2,4),['--check-resource-contract','--approved-pure']);
  assert.equal(process.argv[4],'--prepared-sha'); assert.equal(process.argv.length,6);
  assert.match(process.argv[5],/^[a-f0-9]{64}$/); assert.equal(hash(preparedFile),process.argv[5],'PREPARED_DRIFT');
  const prepared=JSON.parse(fs.readFileSync(preparedFile,'utf8'));
  for(const item of prepared.inputs) assert.equal(hash(path.resolve(root,item.file)),item.sha256,'INPUT_DRIFT');
  const snapshot=JSON.parse(fs.readFileSync(path.join(evidence,'alarm-review-resource-static-binding-20261006-v1.json'),'utf8'));
  assert.equal(snapshot.canonicalAbsolutePath,logo); assert.equal(snapshot.sha256,logoSha); assert.equal(snapshot.bytes,21109);
  for(const key of Object.keys(process.env)) if(!['SystemRoot','WINDIR','PATH'].includes(key)) delete process.env[key];
  process.env.DISABLE_V8_COMPILE_CACHE='1';
  const cp=require('node:child_process'), fixedExec=cp.execFileSync;
  const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  assert.equal(powershell,prepared.powershellExecutable,'POWERSHELL_PATH_DRIFT');
  const ancestors=[];for(let at=logo;;at=path.dirname(at)){ancestors.push(at);if(at===path.dirname(at))break;}
  assert.deepEqual(ancestors,snapshot.windowsAncestors.map(item=>item.path));
  const psPaths=[...ancestors].reverse().map(file=>"'"+file.replace(/'/g,"''")+"'").join(',');
  const psCommand="$ErrorActionPreference='Stop'; @("+psPaths+") | ForEach-Object { $item=Get-Item -LiteralPath $_ -Force; if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'RESOURCE_REPARSE_REJECTED'}; [pscustomobject]@{path=$item.FullName;reparse=[bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)} } | ConvertTo-Json -Compress";
  assert.equal(crypto.createHash('sha256').update(psCommand).digest('hex'),prepared.powershellCommandSha256,'POWERSHELL_COMMAND_DRIFT');
  let forbidden=0;const deny=()=>{forbidden++;throw new Error('RESOURCE_SIDE_EFFECT_REJECTED');};
  for(const api of ['http','https']){const mod=require('node:'+api);mod.request=deny;mod.get=deny;mod.createServer=deny;}
  for(const api of ['net','tls']){const mod=require('node:'+api);mod.connect=deny;mod.createConnection=deny;mod.createServer=deny;}
  require('node:dgram').createSocket=deny;globalThis.fetch=deny;
  for(const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])cp[key]=deny;
  for(const key of ['writeFileSync','appendFileSync','writeSync','mkdirSync','unlinkSync','rmdirSync','rmSync','renameSync','copyFileSync','cpSync','linkSync','symlinkSync','truncateSync','chmodSync','createWriteStream','mkdtempSync','writeFile','appendFile','write','mkdir','unlink','rmdir','rm','rename','copyFile','cp','link','symlink','truncate','chmod','mkdtemp'])if(fs[key])fs[key]=deny;
  for(const key of ['writeFile','appendFile','mkdir','unlink','rmdir','rm','rename','copyFile','cp','link','symlink','truncate','chmod','mkdtemp'])if(fs.promises[key])fs.promises[key]=async()=>deny();
  const nativeOpen=fs.open,nativeOpenSync=fs.openSync,promiseOpen=fs.promises.open;
  const writes=flags=>typeof flags==='number'?Boolean(flags&(fs.constants.O_WRONLY|fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_TRUNC|fs.constants.O_APPEND)):/[wa+]/.test(flags);
  fs.open=function(file,flags,...args){if(writes(flags))deny();return nativeOpen.call(this,file,flags,...args);};
  fs.openSync=function(file,flags,...args){if(writes(flags))deny();return nativeOpenSync.call(this,file,flags,...args);};
  fs.promises.open=async function(file,flags,...args){if(writes(flags))deny();return promiseOpen.call(this,file,flags,...args);};
  const windows=JSON.parse(fixedExec(powershell,['-NoProfile','-NonInteractive','-Command',psCommand],{encoding:'utf8',timeout:10000,windowsHide:true}));
  assert.deepEqual(windows.map(item=>item.path),[...ancestors].reverse());assert(windows.every(item=>item.reparse===false),'WINDOWS_REPARSE_REJECTED');
  const actual=require('../alarm-review-version-contract-v1/server.cjs');
  let oldNativeCalls=0;const old=actual.bundleReadOpen(()=>{oldNativeCalls++;},new Map(),rejected);
  assert.throws(()=>old(logo,'r',()=>{}),/RESOURCE_REJECTED/);assert.equal(oldNativeCalls,0);
  assert.throws(()=>actual.verifyBundleReads([{file:logo,sha256:'0'.repeat(64)}]),/BUNDLE_READ_HASH_MISMATCH/);
  const proofs=actual.verifyBundleReads([{file:logo,sha256:logoSha}]);
  assert.equal(proofs.size,1);assert.equal(proofs.get(logo).size,21109);
  let opened=0,closed=0,nativeCalls=0;
  for(const flags of ['r',fs.constants.O_RDONLY])await new Promise((resolve,reject)=>{
    const receiver={tag:'synthetic-read-receiver'};
    const callback=(error,fd)=>{if(error)return reject(error);opened++;
      try{const stat=fs.fstatSync(fd);const proof=proofs.get(logo);assert.equal(stat.dev,proof.dev);assert.equal(stat.ino,proof.ino);
        const data=Buffer.alloc(21109);assert.equal(fs.readSync(fd,data,0,data.length,0),21109);assert.equal(crypto.createHash('sha256').update(data).digest('hex'),logoSha);assert.equal(data.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
      }catch(error){reject(error);}finally{fs.closeSync(fd);closed++;}resolve();
    };
    const spy=function(file,value,mode,cb){assert.equal(this,receiver);assert.equal(file,logo);assert.equal(value,flags);assert.equal(mode,0o444);assert.equal(cb,callback);nativeCalls++;return nativeOpen.call(this,file,value,mode,cb);};
    const wrapper=strictOpen(actual.bundleReadOpen(spy,proofs,rejected));
    assert.equal(wrapper.call(receiver,logo,flags,0o444,callback),undefined);
  });
  const shouldNotOpen=()=>{throw new Error('UNEXPECTED_NATIVE_OPEN');};
  const strict=strictOpen(actual.bundleReadOpen(shouldNotOpen,proofs,rejected));
  const negative=[[path.relative(root,logo),'r'],[logo+':stream','r'],[path.join(path.dirname(logo),'unknown.png'),'r'],[Buffer.from(logo),'r'],[new URL('file:///D:/unknown.png'),'r'],[logo,'w'],[logo,'r+'],[logo,fs.constants.O_WRONLY],[logo,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK],[logo,null]];
  for(const args of negative)assert.throws(()=>strict(...args,()=>{}),/RESOURCE_REJECTED/);
  for(const property of ['size','ino','dev','mtimeMs']){
    const wrong=new Map([[logo,{...proofs.get(logo),[property]:proofs.get(logo)[property]+1}]]);
    assert.throws(()=>strictOpen(actual.bundleReadOpen(shouldNotOpen,wrong,rejected))(logo,'r',()=>{}),/RESOURCE_REJECTED/);
  }
  const known=snapshot.sourceAnchors.map(item=>item.url);
  for(const url of known)assert.equal(classify({url,method:'GET',abortCompleted:true,abortReason:'blockedbyclient'},known),'known-external-get-rejected');
  const requestNegatives=[{url:known[0]+'&unknown=1',method:'GET',abortCompleted:true,abortReason:'blockedbyclient'},{url:known[1],method:'POST',abortCompleted:true,abortReason:'blockedbyclient'},{url:known[0],method:'GET',abortCompleted:false,abortReason:'blockedbyclient'},{url:'https://unknown.invalid/private',method:'GET',abortCompleted:true,abortReason:'blockedbyclient'}];
  for(const item of requestNegatives)assert.equal(classify(item,known),'unknown-or-unverified-rejected');
  const prior=JSON.parse(fs.readFileSync(path.join(evidence,'alarm-review-real-entry-version-contract-result-20261006-v1.json'),'utf8'));
  assert.equal(prior.outcome,'failed');assert.equal(prior.observations.length,6);assert(prior.observations.every(item=>item.result==='passed'));
  assert.equal(prior.phases.browserProof.violations.length,14);assert(prior.phases.browserProof.violations.every(item=>classify(item,known)==='unverified'));
  assert.equal(prior.phases.callbackReadRejections.length,7);assert.equal(prior.parentPolicy.rejectedWrites,3);
  assert.equal(prior.cleanup.ownedDirectoryRemoved,false);assert(prior.cleanup.retainedDirectory);
  assert.equal(opened,2);assert.equal(closed,2);assert.equal(nativeCalls,2);assert.equal(forbidden,0);
  console.log(JSON.stringify({status:'resource-contract-pure-passed',preparedSha256:hash(preparedFile),oldNotBoundRed:true,actualReadonlyOpens:opened,actualReadonlyCloses:closed,nativeTransparencyPassed:true,pathAndFlagNegativeCases:negative.length,identityNegativeCases:4,exactRequestPositiveCases:2,requestNegativeCases:4,historicalUnverified:14,windowsFreshAttributes:true,originalWholeResult:'failed',originalCounts:{browser:14,child:7,parent:3},parentTargets:'unknown',originalRetain:true,forbiddenSideEffects:forbidden,applicationStarted:false,browserStarted:false,componentCompilerExecuted:false,realFieldAndP95NotResolved:true}));
}
if(require.main===module)run().catch(()=>{process.stderr.write('RESOURCE_CONTRACT_PURE_FAILED\n');process.exitCode=1;});
