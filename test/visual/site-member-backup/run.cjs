const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../../..'),phase=process.argv[2]||'browser';
if(!/^[a-z0-9-]+$/.test(phase))throw Error('Invalid phase');
const out=path.join(root,'output/site-member-backup-20261023',phase);
if(fs.existsSync(out))throw Error('Evidence exists');fs.mkdirSync(out,{recursive:true});
const started=Date.now(),saved={...process.env},temporary=fs.mkdtempSync(path.join(os.tmpdir(),'nt-backup-browser-'));
require('ts-node').register({skipProject:true,transpileOnly:true,compilerOptions:{module:'CommonJS',target:'ES2022',experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true}});
require('reflect-metadata');require('tsconfig-paths').register({baseUrl:root,paths:{'@shared/*':['shared/*'],'@server/*':['server/*']}});
const express=require('express'),{rspack,DefinePlugin}=require('@rspack/core'),{chromium}=require('playwright-core');
const {AccessConfigurationService}=require('../../../server/common/access/access-configuration.service');
const {UnifiedAccessService,hashAccessPassword}=require('../../../server/common/access/unified-access.service');
const {UnifiedAccessController}=require('../../../server/common/access/unified-access.controller');
const {UnifiedAccessGuard}=require('../../../server/common/access/unified-access.guard');
const {GuestReadable,GuestSubmittable}=require('../../../server/common/access/unified-access.decorators');
const {Reflector}=require('@nestjs/core');
class Probe {read(){}submit(){}}
GuestReadable()(Probe.prototype,'read',Object.getOwnPropertyDescriptor(Probe.prototype,'read'));
GuestSubmittable()(Probe.prototype,'submit',Object.getOwnPropertyDescriptor(Probe.prototype,'submit'));
const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files=new Set([__filename,process.execPath,path.join(__dirname,'entry.tsx'),path.join(root,'package.json'),path.join(root,'package-lock.json'),path.join(root,'test/visual/fixture-tailwind.config.ts'),path.join(root,'test/visual/mobile-feishu-session/styles.css'),path.join(root,'test/fixtures/feishu-login-browser/api.ts'),...Object.keys(require.cache).filter(file=>file.startsWith(root+path.sep)&&!file.includes(path.sep+'node_modules'+path.sep))]);
function walk(folder){for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isSymbolicLink())throw Error('Source links rejected');if(entry.isDirectory())walk(file);else if(/\.(tsx?|jsx?|json|css|svg)$/.test(file))files.add(file);}}
walk(path.join(root,'client'));walk(path.join(root,'shared'));
for(const file of ['test/visual/mobile-feishu-session/entry.tsx','postcss.config.js','client/src/components/ui/README.md'])files.add(path.join(root,file));
const capture=()=>[...files].sort().map(file=>({path:file,sha256:sha(file)}));
const before=capture(),proof={passed:false,checks:[],errors:[],externalRequests:[],expectedBlockedFonts:[],sourceBefore:before,limit:'Actual React components plus real access controller/service/guard on loopback and synthetic credentials. Not full Nest bootstrap, physical phone, production network, cloud OAuth or WS/card acceptance.'};
let browser,server;
async function main(){
  process.env.ACCESS_CONFIGURATION_FILE=path.join(temporary,'accounts.json');process.env.LOCAL_ACCESS_CONTROL_ENABLED='true';
  process.env.LOCAL_ACCESS_SESSION_SECRET=crypto.randomBytes(32).toString('base64');process.env.LOCAL_SITE_MEMBER_PASSWORD_HASH=hashAccessPassword('synthetic-backup-password');
  delete process.env.FEISHU_APP_ID;
  const configuration=new AccessConfigurationService(),access=new UnifiedAccessService(configuration),controller=new UnifiedAccessController(access,{}),guard=new UnifiedAccessGuard(new Reflector(),access);
  const backup=configuration.snapshot().accounts.find(account=>account.id==='local-site_member-all');assert(backup);
  const mock=path.join(root,'test/fixtures/feishu-login-browser/api.ts');
  const compiler=rspack({context:root,mode:'development',devtool:false,target:'web',entry:path.join(__dirname,'entry.tsx'),output:{path:out,filename:'app.js',cssFilename:'app.css',publicPath:'/'},resolve:{extensions:['.tsx','.ts','.js'],alias:{'@/api$':mock,'@':path.join(root,'client/src'),'@shared':path.join(root,'shared'),'@lark-apaas/client-toolkit/logger$':mock,'@lark-apaas/client-toolkit/utils/getAxiosForBackend$':mock,'@lark-apaas/client-toolkit/hooks/useCurrentUserProfile$':mock,'@lark-apaas/client-toolkit/dataloom$':mock}},module:{rules:[{test:/\.svg$/,type:'asset/inline'},{test:/\.[jt]sx?$/,exclude:/node_modules/,use:{loader:'builtin:swc-loader',options:{jsc:{parser:{syntax:'typescript',tsx:true},transform:{react:{runtime:'automatic'}},target:'es2022'}}}},{test:/\.css$/,type:'css/auto',use:{loader:'postcss-loader',options:{postcssOptions:{plugins:{'@tailwindcss/postcss':{}}}}}}]},experiments:{css:true},plugins:[new DefinePlugin({'process.env.CLIENT_BASE_PATH':JSON.stringify('')})]});
  const compileStart=Date.now();await new Promise((resolve,reject)=>compiler.run((error,stats)=>{if(!error&&!stats.hasErrors()){
    const inputs=[...stats.compilation.fileDependencies].filter(file=>file.startsWith(root+path.sep)&&!file.includes(path.sep+'node_modules'+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile());
    const missing=inputs.filter(file=>!files.has(file));if(missing.length)error=Error('Unbound source: '+missing.join(', '));proof.compilerSourceInputs=inputs;
  }compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve());}));proof.compileMs=Date.now()-compileStart;
  const app=express();app.use(express.json());app.use((req,_res,next)=>{Object.defineProperty(req,'secure',{value:true});next();});
  app.post('/api/access/login',(req,res,next)=>controller.login(req.body,req,res).then(value=>res.json(value)).catch(next));
  app.get('/api/access/session',(req,res)=>res.json(controller.session(req,res)));app.post('/api/access/logout',(req,res)=>res.json(controller.logout(req,res)));
  for(const route of ['/api/duty-schedules','/api/bitable/today-operations-overview','/api/access/configuration','/api/duty-schedules/leave-request','/api/duty-schedules/overtime-request'])app.all(route,async(req,res,next)=>{
    try{const allowed=await guard.canActivate({getHandler:()=>req.method==='GET'?Probe.prototype.read:Probe.prototype.submit,getClass:()=>Probe,switchToHttp:()=>({getRequest:()=>req,getResponse:()=>res})});res.status(allowed?200:403).json({allowed});}catch(error){next(error);}
  });
  app.get('/app.js',(_req,res)=>res.sendFile(path.join(out,'app.js')));app.get('/app.css',(_req,res)=>res.sendFile(path.join(out,'app.css')));
  app.use('/api',(_req,res)=>res.status(404).json({message:'Fixture endpoint unavailable'}));
  app.use((_req,res)=>res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script>window.__backup=${JSON.stringify(backup).replace(/</g,'\\u003c')}</script><script src="/app.js"></script></body></html>`));
  app.use((error,_req,res,_next)=>res.status(typeof error.getStatus==='function'?error.getStatus():500).json({message:'Fixture request rejected'}));
  server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});proof.port=server.address().port;const origin=`http://127.0.0.1:${proof.port}`;
  browser=await chromium.launch({channel:'msedge',headless:true});
  for(const width of [390,1440]){
    const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();page.on('pageerror',error=>proof.errors.push(error.message));
    // Partitioned cookies belong to the page's top-level site, not Playwright's standalone request context.
    const request=(url,method='GET')=>page.evaluate(async({url,method})=>{const response=await fetch(url,{method,credentials:'same-origin',...(method==='POST'?{headers:{'Content-Type':'application/json'},body:'{}'}:{})});return {status:response.status,data:await response.json()};},{url,method});
    await page.route('**/*',route=>{const url=route.request().url();if(!url.startsWith(origin)){if(url.startsWith('https://fonts.googleapis.com/'))proof.expectedBlockedFonts.push(url);else proof.externalRequests.push(url);return route.abort();}return route.continue();});
    await page.goto(origin);await page.getByTestId('identity').filter({hasText:'未登录'}).waitFor();await page.getByRole('button',{name:'打开登录',exact:true}).click();await page.getByRole('button',{name:'备用登录',exact:true}).click();
    const dialog=page.getByRole('dialog');await dialog.getByLabel('访问密码',{exact:true}).fill('synthetic-wrong-password');await dialog.getByRole('button',{name:'登录',exact:true}).click();await dialog.getByRole('alert').waitFor();
    await dialog.getByLabel('访问密码',{exact:true}).fill('synthetic-backup-password');await dialog.getByRole('button',{name:'登录',exact:true}).click();await page.getByTestId('identity').filter({hasText:'基地备用 / site_member'}).waitFor();assert.equal(await dialog.count(),0);
    const session=(await request('/api/access/session')).data;assert.equal(session.displayName,'基地备用');assert.equal(session.role,'site_member');assert(session.pagePaths.includes('/monthly-schedule')&&session.pagePaths.includes('/today-operations-panorama'));assert(!session.pagePaths.includes('/system-configuration'));
    assert.equal((await request('/api/duty-schedules')).status,200);assert.equal((await request('/api/duty-schedules?force=1')).status,403);assert.equal((await request('/api/duty-schedules/leave-request','POST')).status,403);assert.equal((await request('/api/access/configuration')).status,403);
    await page.screenshot({path:path.join(out,`login-${width}.png`)});await page.getByRole('button',{name:'检查备用配置',exact:true}).click();
    const editor=page.getByRole('dialog',{name:'编辑账号权限'});await editor.waitFor();const role=editor.getByLabel('权限角色',{exact:true});assert(await role.isDisabled());assert.equal(await role.inputValue(),'site_member');await editor.getByText('基地成员默认页面只读；个人申请请使用本人账号',{exact:true}).waitFor();assert.equal(await editor.locator('fieldset').count(),0);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.waitForFunction(()=>{const node=document.querySelector('[role="dialog"]');if(!node)return false;const box=node.getBoundingClientRect();return box.width>100&&box.left>=-1&&Math.abs(box.right-innerWidth)<1;});
    await page.screenshot({path:path.join(out,`editor-${width}.png`)});await editor.getByRole('button',{name:'关闭',exact:true}).click();
    await request('/api/access/logout','POST');await page.reload();await page.getByTestId('identity').filter({hasText:'未登录 / guest'}).waitFor();assert.equal((await context.cookies()).filter(cookie=>cookie.name===access.cookieName).length,0);
    proof.checks.push(`${width}: wrong password stays guest; real login/confirmation/role/pages; protected reads and writes; fixed editor role; logout clears session`);await context.close();
  }
  assert.deepEqual(proof.errors,[]);assert.deepEqual(proof.externalRequests,[]);assert.deepEqual(before,capture());proof.passed=true;
}
main().catch(error=>{proof.errors.push(error.stack||String(error));process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));fs.rmSync(temporary,{recursive:true,force:true});process.env=saved;
  proof.sourceAfter=capture();proof.cleaned=!fs.existsSync(temporary)&&(!server||!server.listening);proof.artifacts=['app.js','app.css'].filter(file=>fs.existsSync(path.join(out,file))).map(file=>({file,sha256:sha(path.join(out,file))}));proof.elapsedMs=Date.now()-started;
  fs.writeFileSync(path.join(out,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:proof.passed,checks:proof.checks,errors:proof.errors,compileMs:proof.compileMs,elapsedMs:proof.elapsedMs,cleaned:proof.cleaned,output:out}));
});
