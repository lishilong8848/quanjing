import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,existsSync,mkdirSync,rmSync,readdirSync,renameSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scryptSync,timingSafeEqual } from 'node:crypto';
import { readEnvironmentHashes } from '../../scripts/reset-all-access-passwords.mjs';
const name='LOCAL_SITE_MEMBER_PASSWORD_HASH';
async function setter(){return (await import('../../scripts/set-site-member-backup-password.mjs')).setSiteMemberBackupPassword;}
function fixture(run){const root=mkdtempSync(join(tmpdir(),'nt-backup-password-'));writeFileSync(join(root,'.env'),'OTHER_SETTING=preserve\r\n');return Promise.resolve().then(()=>run(root)).finally(()=>rmSync(root,{recursive:true,force:true}));}
test('定向读取备用密码哈希，不更改旧全量重置字段列表',()=>fixture(root=>{
  writeFileSync(join(root,'.env'),`${name}=synthetic-hash\n`);assert.equal(readEnvironmentHashes(join(root,'.env'),[name])[name],'synthetic-hash');
}));
test('仅保存随机盐哈希，清除同名.env.local覆盖，其他配置保持',()=>fixture(async root=>{
  const set=await setter(),adminSalt=Buffer.alloc(16,3),adminHash=`scrypt$${adminSalt.toString('base64')}$${scryptSync('synthetic-admin-password',adminSalt,32).toString('base64')}`;
  writeFileSync(join(root,'.env.local'),`${name}=old\r\nLOCAL_ADMIN_PASSWORD_HASH=${adminHash}\r\n`);
  set('synthetic-backup-password',root);const text=readFileSync(join(root,'.env'),'utf8'),local=readFileSync(join(root,'.env.local'),'utf8');
  assert(text.includes('OTHER_SETTING=preserve\r\n'));assert(!text.includes('synthetic-backup-password'));assert(!local.includes(`${name}=`));assert(local.includes(`LOCAL_ADMIN_PASSWORD_HASH=${adminHash}`));
  const first=readEnvironmentHashes(join(root,'.env'),[name])[name],[,salt,derived]=first.split('$');assert(timingSafeEqual(scryptSync('synthetic-backup-password',Buffer.from(salt,'base64'),32),Buffer.from(derived,'base64')));
  set('synthetic-backup-password',root);assert.notEqual(readEnvironmentHashes(join(root,'.env'),[name])[name],first);
  assert.deepEqual(readdirSync(root).sort(),['.env','.env.local']);
}));
test('过短密码或与已有角色重复时，原配置字节不变',()=>fixture(async root=>{
  const set=await setter(),before=readFileSync(join(root,'.env'));assert.throws(()=>set('short',root),/8/);assert.deepEqual(readFileSync(join(root,'.env')),before);
  const salt=Buffer.alloc(16,7),hash=`scrypt$${salt.toString('base64')}$${scryptSync('synthetic-shared-password',salt,32).toString('base64')}`;
  writeFileSync(join(root,'.env'),`LOCAL_ADMIN_PASSWORD_HASH=${hash}\n`);const original=readFileSync(join(root,'.env'));assert.throws(()=>set('synthetic-shared-password',root),/其他/);assert.deepEqual(readFileSync(join(root,'.env')),original);
}));
test('有持久账号覆盖时明确拒绝，不改密码及台账',()=>fixture(async root=>{
  const set=await setter();mkdirSync(join(root,'.runtime'));const file=join(root,'.runtime','access-configuration.json'),data=JSON.stringify({schemaVersion:1,accounts:{'local-site_member-all':{enabled:false}}});writeFileSync(file,data);
  const before=readFileSync(join(root,'.env'));assert.throws(()=>set('synthetic-backup-password',root),/配置页/);assert.deepEqual(readFileSync(join(root,'.env')),before);assert.equal(readFileSync(file,'utf8'),data);
}));
test('不能与配置页保存的其他启用备用账号密码重复',()=>fixture(async root=>{
  const set=await setter(),salt=Buffer.alloc(16,9),hash=`scrypt$${salt.toString('base64')}$${scryptSync('synthetic-configured-password',salt,32).toString('base64')}`;
  mkdirSync(join(root,'.runtime'));writeFileSync(join(root,'.runtime','access-configuration.json'),JSON.stringify({schemaVersion:1,accounts:{'local-admin-all':{kind:'local',enabled:true,deleted:false,passwordHash:hash}}}));
  const before=readFileSync(join(root,'.env'));assert.throws(()=>set('synthetic-configured-password',root),/其他/);assert.deepEqual(readFileSync(join(root,'.env')),before);
}));
test('第二个配置文件切换失败时，两份原字节都恢复且无临时残留',()=>fixture(async root=>{
  const set=await setter();writeFileSync(join(root,'.env.local'),`${name}=old\n`);const before=readFileSync(join(root,'.env')),local=readFileSync(join(root,'.env.local'));let failed=false;
  assert.throws(()=>set('synthetic-backup-password',root,{renameFile:(from,to)=>{if(!failed&&to===join(root,'.env.local')&&from.endsWith('.tmp')){failed=true;throw Error('synthetic-rename-failure');}renameSync(from,to);}}),/synthetic-rename-failure/);
  assert.deepEqual(readFileSync(join(root,'.env')),before);assert.deepEqual(readFileSync(join(root,'.env.local')),local);assert.deepEqual(readdirSync(root).sort(),['.env','.env.local']);
}));
