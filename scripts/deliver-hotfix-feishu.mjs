import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';

export const APP_ID='cli_a9d1c9fe9d381cee';
export const RECIPIENT='ou_a6644e62a43b916c6bc26148cf74f208';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const check=(yes,message)=>{if(!yes)throw Error(message);};
const same=(a,b)=>a.toLowerCase()===b.toLowerCase();
function ordinary(p) {
  const st=fs.lstatSync(p);
  check(st.isFile()&&!st.isSymbolicLink()&&st.nlink===1&&same(fs.realpathSync.native(p),path.resolve(p)),'Unsafe ordinary file');
  return st;
}
function save(p,value) {
  const tmp=p+'.'+crypto.randomUUID()+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  fs.renameSync(tmp,p);
}
function data(result) {
  check(result&&result.ok!==false&&(result.code===undefined||result.code===0),'CLI reported failure');
  return result.data??result;
}
export function cliAdapter(entry,root) {
  check(path.isAbsolute(entry)&&fs.statSync(entry).isFile(),'CLI entry must be an existing absolute path');
  return async args=>{
    let bytes;
    try {
      bytes=execFileSync(process.execPath,[entry,...args,'--json'],{cwd:root,windowsHide:true,timeout:180000,maxBuffer:4*1024*1024,
        env:{...process.env,LARKSUITE_CLI_NO_UPDATE_NOTIFIER:'1',LARKSUITE_CLI_NO_SKILLS_NOTIFIER:'1'},stdio:['ignore','pipe','pipe']});
    } catch(e) {throw Error(`lark-cli failed (exit ${e.status??'unknown'}). No ZIP was deleted; inspect CLI permissions/network before retry.`);}
    return data(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,'')));
  };
}

// Caller holds both publication leases; only the external CLI is replaceable in tests.
export async function deliver({root,deliveryPath,cli}) {
  root=fs.realpathSync.native(root); deliveryPath=path.resolve(root,deliveryPath);
  const d=read(deliveryPath), stamp=hash(fs.readFileSync(deliveryPath));
  check(/^nantong-safe-full-runtime-hotfix-\d{8}-\d{6}$/.test(d.packageId),'Invalid deployment ID');
  check(d.status==='accepted-for-user-deployment-not-production-registered','Final acceptance required');
  check(/^[a-f0-9]{64}$/.test(d.outerSha256),'Invalid SHA');
  const suffix=d.packageId.replace('nantong-safe-full-runtime-hotfix-','');
  const outer=path.resolve(d.outerPath), expected=path.join(root,'output/hotfix',`nantong-one-click-hotfix-${suffix}.zip`);
  check(same(outer,expected),'ZIP boundary differs');
  const dir=path.join(root,'output/feishu-hotfix-delivery'); fs.mkdirSync(dir,{recursive:true});
  check(same(fs.realpathSync.native(dir),dir),'Ledger boundary differs');
  const receiptPath=path.join(dir,d.packageId+'.json');
  let receipt=fs.existsSync(receiptPath)?read(receiptPath):{schemaVersion:1,packageId:d.packageId,outerSha256:d.outerSha256,deliverySha256:stamp,appId:APP_ID,recipient:RECIPIENT};
  check(receipt.packageId===d.packageId&&receipt.outerSha256===d.outerSha256&&receipt.deliverySha256===stamp&&receipt.appId===APP_ID&&receipt.recipient===RECIPIENT,'Delivery ledger binding differs');
  if(fs.existsSync(outer)) {ordinary(outer); check(hash(fs.readFileSync(outer))===d.outerSha256,'Package SHA differs');}
  else check(receipt.fileMessageId&&receipt.metadataMessageId&&receipt.downloadVerified,'ZIP missing without completed delivery');
  for(const e of d.evidenceBindings??[]) {ordinary(e.path); check(hash(fs.readFileSync(e.path))===e.sha256,'Acceptance evidence differs');}
  const auth=data(await cli(['auth','status','--verify']));
  check(auth.appId===APP_ID&&auth.verified===true&&auth.identities?.bot?.available===true&&auth.identities.bot.verified===true,'Verified bot/application differs');
  const persist=()=>save(receiptPath,{...receipt,updatedAt:new Date().toISOString()});
  async function send(kind,args) {
    const field=kind==='file'?'fileMessageId':'metadataMessageId';
    if(receipt[field])return;
    check(!receipt.inFlight,'Previous send outcome uncertain; reconcile the persisted intent before any retry');
    receipt.inFlight={kind,startedAt:new Date().toISOString()}; persist();
    const key=hash(`${APP_ID}:${RECIPIENT}:${d.packageId}:${d.outerSha256}:${kind}`).slice(0,40);
    const result=data(await cli(['im','+messages-send','--as','bot','--user-id',RECIPIENT,...args,'--idempotency-key',key]));
    check(/^om_/.test(result.message_id??''),'Send outcome uncertain: missing message ID');
    receipt[field]=result.message_id; receipt.chatId=result.chat_id; delete receipt.inFlight; persist();
  }
  await send('file',['--file','./'+path.relative(root,outer).replaceAll('\\','/')]);
  await send('metadata',['--text',`南通排班一键更新包 ${suffix}\n版本：${d.packageId}\n文件：${path.basename(outer)}\nSHA-256：${d.outerSha256}\n请下载上方 ZIP 后解压，双击一键更新入口。此消息仅表示附件交付，不代表新的生产部署成功。`]);
  if(!receipt.fileKey) {
    const result=data(await cli(['im','+messages-mget','--message-ids',receipt.fileMessageId,'--as','bot','--no-reactions']));
    const msg=result.messages?.find(m=>m.message_id===receipt.fileMessageId);
    check(msg&&msg.msg_type==='file','Sent file message not accessible');
    const marker=typeof msg.content==='string'?msg.content.match(/^<file\s+key="(file_[A-Za-z0-9_-]+)"(?:\s+name="[^"]*")?\s*\/>$/):null;
    const content=marker?{file_key:marker[1]}:(typeof msg.content==='string'?JSON.parse(msg.content):msg.content);
    check(/^file_/.test(content?.file_key??''),'Sent attachment key missing');
    receipt.fileKey=content.file_key; persist();
  }
  const download=path.join(dir,d.packageId+'.remote-check.zip');
  if(!receipt.downloadVerified) {
    check(!fs.existsSync(download),'Existing download requires inspection before retry');
    await cli(['im','+messages-resources-download','--message-id',receipt.fileMessageId,'--file-key',receipt.fileKey,'--type','file','--as','bot','--output','./'+path.relative(root,download).replaceAll('\\','/')]);
    ordinary(download); check(hash(fs.readFileSync(download))===d.outerSha256,'Remote download SHA differs');
    receipt.downloadVerified=true; receipt.downloadBytes=fs.statSync(download).size; receipt.downloadVerifiedAt=new Date().toISOString(); persist();
  }
  return {...receipt,receiptPath,downloadPath:download};
}

export async function restore({root,deliveryPath,cli}) {
  root=fs.realpathSync.native(root);
  const d=read(path.resolve(root,deliveryPath));
  check(/^nantong-safe-full-runtime-hotfix-\d{8}-\d{6}$/.test(d.packageId),'Invalid deployment ID');
  const receiptPath=path.join(root,'output/feishu-hotfix-delivery',d.packageId+'.json'), r=read(receiptPath);
  check(r.appId===APP_ID&&r.recipient===RECIPIENT&&r.packageId===d.packageId&&r.outerSha256===d.outerSha256&&r.deliverySha256===hash(fs.readFileSync(path.resolve(root,deliveryPath)))&&r.downloadVerified&&/^om_/.test(r.fileMessageId)&&/^file_/.test(r.fileKey),'Remote restoration binding differs');
  const suffix=d.packageId.replace('nantong-safe-full-runtime-hotfix-','');
  const outer=path.join(root,'output/hotfix',`nantong-one-click-hotfix-${suffix}.zip`);
  check(same(path.resolve(d.outerPath),outer),'Restore boundary differs');
  const auth=data(await cli(['auth','status','--verify']));
  check(auth.appId===APP_ID&&auth.verified===true&&auth.identities?.bot?.verified===true,'Verified bot/application differs');
  const temp=path.join(root,'output/feishu-hotfix-delivery',d.packageId+'.restore.zip');
  check(!fs.existsSync(temp),'Existing restoration file requires inspection');
  if(!fs.existsSync(outer)) {
    await cli(['im','+messages-resources-download','--as','bot','--message-id',r.fileMessageId,'--file-key',r.fileKey,'--type','file','--output','./'+path.relative(root,temp).replaceAll('\\','/')]);
    ordinary(temp); check(hash(fs.readFileSync(temp))===r.outerSha256,'Remote download SHA differs');
    fs.copyFileSync(temp,outer,fs.constants.COPYFILE_EXCL); fs.unlinkSync(temp);
  }
  ordinary(outer); check(hash(fs.readFileSync(outer))===r.outerSha256,'Restored outer SHA differs');
  if(d.innerPath) {
    const inner=path.join(root,'output/hotfix',d.packageId+'.zip');
    check(same(path.resolve(d.innerPath),inner),'Restore inner boundary differs');
    if(!fs.existsSync(inner)) {
      const {unzipSync}=createRequire(import.meta.url)('fflate');
      const entries=unzipSync(fs.readFileSync(outer),{filter:e=>e.name.replaceAll('\\','/')==='_hotfix-payload/hotfix-package.zip'});
      const values=Object.values(entries); check(values.length===1&&hash(values[0])===d.innerSha256,'Embedded inner SHA differs');
      fs.writeFileSync(inner,values[0],{flag:'wx'});
    }
    ordinary(inner); check(hash(fs.readFileSync(inner))===d.innerSha256,'Restored inner SHA differs');
  }
  return {restored:true,outerPath:outer,outerSha256:r.outerSha256,innerPath:d.innerPath??null,innerSha256:d.innerSha256??null};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [deliveryPath,entry,mode]=process.argv.slice(2);
    check(deliveryPath&&entry,'Usage: deliver-hotfix-feishu.mjs DELIVERY.json absolute-lark-cli-run.js');
    check(!mode||mode==='restore','Unknown delivery mode');
    const result=await (mode==='restore'?restore:deliver)({root:process.cwd(),deliveryPath,cli:cliAdapter(entry,process.cwd())});
    console.log(JSON.stringify(result));
  } catch(e) {console.error(e.message);process.exitCode=1;}
}
