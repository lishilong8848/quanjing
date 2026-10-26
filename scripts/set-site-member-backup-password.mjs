import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, renameSync } from 'node:fs';
import { resolve, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PASSWORD_HASH_NAMES, readEnvironmentHashes, writeEnvironmentFileWithLocalOverrides } from './reset-all-access-passwords.mjs';

const name='LOCAL_SITE_MEMBER_PASSWORD_HASH',accountId='local-site_member-all';
function readFile(file,maximum=2*1024*1024){
  const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>maximum)throw Error('配置文件路径或大小异常，未修改密码。');
  return readFileSync(file,'utf8').replace(/^\uFEFF/,'');
}
function setting(source,key){
  const values=source.split(/\r?\n/).flatMap(line=>{const match=/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);return match?.[1]===key?[match[2].trim()]:[];});
  if(values.length>1)throw Error('权限配置路径重复，请先核对配置。');
  const value=values[0];return value&&/^(['"]).*\1$/.test(value)?value.slice(1,-1):value;
}
export function setSiteMemberBackupPassword(password,appRoot,{renameFile=renameSync}={}){
  if(typeof password!=='string'||password.length<8||password.length>256)throw Error('密码需为8至256字符，原配置未改变。');
  const root=resolve(appRoot),directory=lstatSync(root);if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('系统目录无效，未修改密码。');
  const envFile=join(root,'.env'),localFile=join(root,'.env.local'),source=readFile(envFile),local=existsSync(localFile)?readFile(localFile):'';
  const configured=setting(local,'ACCESS_CONFIGURATION_FILE')??setting(source,'ACCESS_CONFIGURATION_FILE')??process.env.ACCESS_CONFIGURATION_FILE;
  if(configured&&!isAbsolute(configured))throw Error('权限配置路径必须为绝对路径，未修改密码。');
  const stateFile=configured||join(root,'.runtime','access-configuration.json');
  const configuredHashes=[];
  if(existsSync(stateFile)){
    let state;try{state=JSON.parse(readFile(stateFile,8*1024*1024));}catch{throw Error('权限台账读取失败，未修改密码。');}
    if(!state||state.schemaVersion!==1||!state.accounts||typeof state.accounts!=='object'||Array.isArray(state.accounts))throw Error('权限台账结构异常，未修改密码。');
    if(Object.hasOwn(state.accounts,accountId))throw Error('基地备用账号已有配置页设置，请在配置页修改此账号密码；现场脚本未改动任何配置。');
    for(const account of Object.values(state.accounts))if(account?.kind==='local'&&account.loginMethod===undefined&&account.enabled&&!account.deleted&&account.passwordHash)configuredHashes.push(account.passwordHash);
  }
  const names=[...PASSWORD_HASH_NAMES,name],existing={...readEnvironmentHashes(envFile,names),...(existsSync(localFile)?readEnvironmentHashes(localFile,names):{})};
  for(const hash of [...PASSWORD_HASH_NAMES.map(key=>existing[key]),...configuredHashes]){
    if(!hash)continue;
    const match=/^scrypt\$([^$]+)\$([^$]+)$/.exec(hash),salt=match&&Buffer.from(match[1],'base64'),derived=match&&Buffer.from(match[2],'base64');
    if(!match||salt.length<16||derived.length!==32||salt.toString('base64')!==match[1]||derived.toString('base64')!==match[2])throw Error('已有备用角色密码配置无效，请先核对；原配置未改变。');
    if(timingSafeEqual(scryptSync(password,salt,32),derived))throw Error('此密码已用于其他备用角色，请使用不同密码；原配置未改变。');
  }
  const salt=randomBytes(16),hash=`scrypt$${salt.toString('base64')}$${scryptSync(password,salt,32).toString('base64')}`;
  writeEnvironmentFileWithLocalOverrides(envFile,{[name]:hash},renameFile,names);
  return {account:'基地备用',configured:true,restartRequired:true};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  let password=process.env.SITE_MEMBER_BACKUP_NEW_PASSWORD;delete process.env.SITE_MEMBER_BACKUP_NEW_PASSWORD;
  try{if(process.argv.length!==3)throw Error('请使用配套密码设置脚本。');const result=setSiteMemberBackupPassword(password,process.argv[2]);process.stdout.write(JSON.stringify(result));}
  catch(error){process.stderr.write(`${error instanceof Error?error.message:'密码设置失败，未确认成功。'}\n`);process.exitCode=1;}
  finally{password='';}
}
