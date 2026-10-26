const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { rspack } = require('@rspack/core'), { chromium } = require('playwright-core');
const installProbe = require('../personnel-interaction-performance/probe.cjs'), { createFixture } = require('./fixture.cjs');
const root = path.resolve(__dirname, '../../..'), name = process.argv[2], mode = process.argv[3];
if (!/^[a-z0-9-]+$/.test(name || '') || !['card-red','stale-save','timeout','performance','acceptance','baseline','baseline-slow','all-functional'].includes(mode)) throw Error('Unique phase and explicit mode required');
const output = path.join(root, 'output/personnel-stage-four-20261016', name);
if (fs.existsSync(output)) throw Error('Evidence exists'); fs.mkdirSync(output, { recursive: true });
const started = Date.now(), fixture = createFixture(), key = file => path.resolve(file).toLowerCase();
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const proof = { passed: false, mode, nodeVersion: process.version, nodeSha256: hash(process.execPath), startedAt: new Date().toISOString(), groups: [], samples: [], errors: [], externalRequests: [], expectedBlockedStylesheets: [], screenshots: [],
  limits: 'Actual production-mode configuration components with synthetic HTTP. DOM/RAF are feedback proxies, not physical paint, a real phone, real OAuth, or cloud writes.' };
let browser, server, currentPage, inputs = [], before = [], artifacts, artifactRoot = output;
function discoverBefore() {
  const files = new Map();
  const add = file => { if (fs.existsSync(file) && fs.statSync(file).isFile()) files.set(key(file), path.resolve(file)); };
  const inventory = path.join(root, 'output/personnel-stage-three-full-20261015/unified-interaction-native-production-final/proof.json');
  // Only borrow the old compiler's path inventory; no old hash, outcome, or timing is accepted as current proof.
  if (fs.existsSync(inventory)) for (const row of JSON.parse(fs.readFileSync(inventory, 'utf8')).sourceBefore || []) if (!row.path.includes('unified-interaction-native-production-final')) add(row.path);
  const currentGraph = path.join(root, 'output/personnel-stage-four-20261016/source-card-name-red/proof.json');
  if (fs.existsSync(currentGraph)) for (const row of JSON.parse(fs.readFileSync(currentGraph, 'utf8')).sourceAfter || []) add(row.path);
  function walk(folder) { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); if (entry.isSymbolicLink()) throw Error('Unexpected source link');
    if (entry.isDirectory()) walk(file); else if (/\.(?:tsx?|jsx?|css|json|svg)$/.test(entry.name)) add(file); } }
  walk(path.join(root, 'client/src/pages/SystemConfiguration')); walk(path.join(root, 'shared'));
  walk(path.join(root,'node_modules/lucide-react/dist/esm/icons'));
  for (const file of [__filename, path.join(__dirname,'fixture.cjs'),path.join(__dirname,'axios.ts'),path.join(root,'test/visual/fixture-tailwind.config.ts'),path.join(root,'package.json'),path.join(root,'package-lock.json'),
    path.join(root,'tsconfig.json'),path.join(root,'tsconfig.app.json'),process.execPath,...Object.keys(require.cache)]) add(file);
  return new Map([...files].map(([id,file]) => [id,{ path:file,sha256:hash(file) }]));
}
const capture = () => inputs.map(file => ({ path:file,sha256:hash(file) }));
async function main() {
  const reuse = process.argv[4];
  if (reuse) {
    if (!/^[a-z0-9-]+$/.test(reuse)) throw Error('Invalid reuse phase');
    artifactRoot = path.join(root, 'output/personnel-stage-four-20261016', reuse);
    const originalPath = path.join(artifactRoot, 'proof.json'), original = JSON.parse(fs.readFileSync(originalPath, 'utf8'));
    assert.equal(original.nodeSha256, hash(process.execPath));
    assert.deepEqual(original.unboundCompilerInputs, []);
    assert.deepEqual(original.sourceBefore, original.sourceAfter, 'Original compiled input drift');
    assert(original.artifacts && original.compilationMs > 0);
    const changedInfrastructure = new Set([key(__filename), key(path.join(__dirname, 'fixture.cjs'))]);
    for (const row of original.sourceAfter) if (!changedInfrastructure.has(key(row.path))) assert.equal(hash(row.path), row.sha256, `Compiled source changed: ${row.path}`);
    artifacts = original.artifacts;
    assert.equal(hash(path.join(artifactRoot, 'app.js')), artifacts.javascript); assert.equal(hash(path.join(artifactRoot, 'app.css')), artifacts.css);
    inputs = original.sourceAfter.map(row => row.path); before = capture();
    proof.reusedCompilation = { proof: originalPath, proofSha256: hash(originalPath), artifacts, excludedInfrastructure: [...changedInfrastructure] };
    proof.artifacts = artifacts; proof.compilationMs = 0;
  } else {
  const discoveryStart=Date.now(),sourceBefore = discoverBefore();proof.discoveryMs=Date.now()-discoveryStart;
  const compiler = rspack({ context: root, mode: 'production', devtool: false, target: 'web', entry: path.join(root,'test/visual/personnel-interaction-performance/entry.tsx'),
    output: { path:output,filename:'app.js',cssFilename:'app.css',publicPath:'/' }, resolve: { extensions:['.tsx','.ts','.js'], alias: { '@/access/AccessProvider$':path.join(root,'test/visual/personnel-interaction-performance/access.ts'),
      '@':path.join(root,'client/src'),'@shared':path.join(root,'shared'),'@lark-apaas/client-toolkit/utils/getAxiosForBackend$':path.join(__dirname,'axios.ts') } },
    module: { rules: [{test:/\.svg$/,type:'asset/inline'},{test:/\.[jt]sx?$/,exclude:/node_modules/,use:{loader:'builtin:swc-loader',options:{jsc:{parser:{syntax:'typescript',tsx:true},transform:{react:{runtime:'automatic'}},target:'es2022'}}}},
      {test:/\.css$/,type:'css/auto',use:{loader:'postcss-loader',options:{postcssOptions:{plugins:{'@tailwindcss/postcss':{}}}}}}] },experiments:{css:true} });
  const compileStart=Date.now(); let dependencies;
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>{ if(!error&&!stats.hasErrors()){dependencies=[...stats.compilation.fileDependencies];proof.warnings=stats.toJson({all:false,warnings:true}).warnings;}
    compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve()); }));
  proof.compilationMs=Date.now()-compileStart;
  inputs=[...new Set([...dependencies,...Object.keys(require.cache),__filename,path.join(__dirname,'fixture.cjs'),path.join(__dirname,'axios.ts'),process.execPath,path.join(root,'package-lock.json')])]
    .filter(file=>fs.existsSync(file)&&fs.statSync(file).isFile()).map(file=>path.resolve(file)).sort();
  const missing=inputs.filter(file=>!sourceBefore.has(key(file)));proof.unboundCompilerInputs=missing;
  before=inputs.map(file=>({path:file,sha256:sourceBefore.get(key(file))?.sha256 ?? null}));
  if(missing.length)throw Error('Compiler input was not captured before compilation: '+missing.slice(0,8).join(', '));
  assert.deepEqual(before,capture(),'Source drift during compilation');
  artifacts={javascript:hash(path.join(output,'app.js')),css:hash(path.join(output,'app.css'))};proof.artifacts=artifacts;
  proof.bundleBytes={javascript:fs.statSync(path.join(output,'app.js')).size,css:fs.statSync(path.join(output,'app.css')).size};
  }
  server=http.createServer(async(request,response)=>{try{if(await fixture.handle(request,response))return;
    if(request.url==='/app.js'||request.url==='/app.css'){response.writeHead(200,{'Content-Type':request.url.endsWith('.js')?'application/javascript':'text/css'});response.end(fs.readFileSync(path.join(artifactRoot,request.url.slice(1))));return;}
    if(request.url==='/favicon.ico'){response.writeHead(204);response.end();return;}
    response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script src="/app.js"></script></body></html>');
  }catch(error){proof.errors.push(error.stack);response.writeHead(500);response.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;proof.port=server.address().port;
  browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1050}});currentPage=page;
  page.setDefaultTimeout(10_000);page.setDefaultNavigationTimeout(15_000);
  await page.addInitScript(installProbe);page.on('pageerror',error=>proof.errors.push(error.stack||error.message));
  const declaredFont='https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  assert(fs.readFileSync(path.join(root,'client/src/tailwind-theme.css'),'utf8').includes(`@import url('${declaredFont}')`));
  proof.fontPolicy='Existing declared Inter stylesheet is blocked; the browser uses the existing system fallback. This is not font-download or physical-device acceptance.';
  await page.route('**/*',route=>{const url=route.request().url();if(!url.startsWith(origin)){
    if(url===declaredFont)proof.expectedBlockedStylesheets.push(url);else proof.externalRequests.push(url);return route.abort();}return route.continue();});
  const status=async()=>await(await page.request.get(origin+'/__fixture/status')).json();
  const control=async(value)=>await page.request.post(origin+'/__fixture/control',{data:value});
  async function waitForHeld(property){const deadline=Date.now()+5000;let facts;do{facts=await status();if(facts[property]===true)return facts;await new Promise(resolve=>setTimeout(resolve,40));}while(Date.now()<deadline);throw Error(`Fixture never held ${property}: ${JSON.stringify(facts)}`);}
  const sourceTab=()=>page.getByRole('tab',{name:'岗位来源',exact:true});
  const panel=()=>page.getByRole('region',{name:'岗位来源管理',exact:true});
  const check=()=>panel().getByRole('button',{name:'核对来源',exact:true});
  const acknowledge=()=>panel().getByRole('checkbox',{name:'已核对全部职责人员及授权',exact:true});
  const activate=()=>panel().getByRole('button',{name:/^启用岗位来源$|^应用核对结果$|^恢复岗位来源$/});
  let baselineMode=false;
  async function open(options={}){await page.request.post(origin+'/__fixture/reset',{data:{...options,baseline:baselineMode}});await page.evaluate(()=>sessionStorage.clear());await page.goto(origin);await sourceTab().click();await panel().waitFor();}
  async function ready(){await check().click();await panel().getByText('合成职责0001',{exact:true}).waitFor();}
  async function noOverflow(){assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Horizontal overflow');}
  async function shot(label){const file=path.join(output,label+'.png');await page.screenshot({path:file});proof.screenshots.push(file);}
  async function measured(locator,label,phase,kind,expected){await page.locator('[data-feedback-target]').evaluateAll(nodes=>nodes.forEach(node=>node.removeAttribute('data-feedback-target')));
    await locator.evaluate(node=>node.setAttribute('data-feedback-target','true'));await page.evaluate(value=>window.__uiFeedback.arm(value),{label,phase,kind,expected});await locator.click();
    await page.waitForFunction(()=>window.__uiFeedback.rows.at(-1)?.complete);const row=await page.evaluate(()=>window.__uiFeedback.rows.at(-1));proof.samples.push(row);
    assert(!row.error);assert(row.events.some(event=>event.type==='pointerdown'&&event.trusted)&&row.events.some(event=>event.type==='click'&&event.trusted));return row;}
  async function cardScenario(){await page.getByRole('tab',{name:'卡片人员',exact:true}).click();const cards=page.getByRole('tabpanel',{name:'卡片人员',exact:true});await cards.getByRole('button',{name:'出入库',exact:true}).click();await cards.getByRole('combobox',{name:'卡片楼栋',exact:true}).selectOption('C楼');
    await cards.getByRole('button',{name:'查看岗位来源',exact:true}).waitFor();await cards.getByText(/^(现任合成负责人|旧缓存姓名)$/).first().waitFor();
    assert.equal(await cards.getByText('现任合成负责人',{exact:true}).count(),1,'Managed card must show its current source name');
    assert.equal(await cards.getByText('旧覆盖人员',{exact:true}).count(),0);assert.equal(await cards.getByText('旧缓存姓名',{exact:true}).count(),0);
    await cards.getByText('未接管知会人员',{exact:true}).waitFor();assert.equal(await cards.getByRole('button',{name:'配置',exact:true}).count(),1);
    await cards.getByRole('button',{name:'配置',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
    await cards.getByRole('button',{name:'查看岗位来源',exact:true}).click();await panel().waitFor();await noOverflow();}
  async function staleSave(){await open({mode:'ready',holdSave:true});await ready();await acknowledge().check();await activate().click();const held=await waitForHeld('heldSave');assert.equal(held.mutationWrites,1);assert.equal(held.revision,2);proof.heldSaveBeforePause={revision:held.revision,mutationWrites:held.mutationWrites,sourceStatus:held.sourceStatus};await control({action:'externalPause'});assert.equal((await status()).sourceStatus,'paused');await page.getByRole('button',{name:'刷新',exact:true}).click();await panel().getByText('已暂停',{exact:true}).waitFor();await control({action:'releaseSave'});await panel().getByText('配置已有后续更新，请核对当前状态',{exact:true}).waitFor();assert.equal((await status()).sourceStatus,'paused');await panel().getByText('已暂停',{exact:true}).waitFor();}
  const baseline=()=>page.getByRole('region',{name:'首次岗位对齐',exact:true}),baselineCheck=()=>baseline().getByRole('button',{name:'核对首次岗位',exact:true}),baselineBox=()=>baseline().getByRole('checkbox',{name:'已核对首次岗位全部人员及范围',exact:true}),baselineConfirm=()=>baseline().getByRole('button',{name:'批量确认基线',exact:true});
  async function baselineReady(){await baselineCheck().click();await baseline().getByText('合成职责0001',{exact:true}).waitFor();}
  async function baselineScenario(viewport){
    baselineMode=true;
    await page.setViewportSize({width:viewport==='desktop'?1440:390,height:1050});
    await open({mode:'empty'});assert.equal((await status()).baselinePreviewCalls,0);await baselineCheck().click();await baseline().getByText('尚无可识别岗位，请核对人员岗位、范围或额外职责',{exact:true}).waitFor();assert(await baselineConfirm().isDisabled());assert.equal((await status()).baselineWrites,0);await noOverflow();await page.evaluate(()=>scrollTo(0,0));await shot(`baseline-empty-${viewport}`);proof.groups.push(`${viewport}:baseline-empty-no-write`);
    await open({mode:'ready'});await baselineReady();assert.equal(await baseline().getByText('主表岗位',{exact:true}).count(),50);await baseline().getByText('以下职责尚未接管，继续使用现有配置：采购审批、合同通知。',{exact:true}).waitFor();proof.groups.push(`${viewport}:derived-position-origin-and-unmanaged-roles-visible`);await baseline().getByRole('textbox',{name:'搜索首次对齐职责',exact:true}).fill('1000');await baseline().getByText('合成职责1000',{exact:true}).waitFor();assert.equal(await baseline().locator('article').count(),1);await baseline().getByRole('textbox',{name:'搜索首次对齐职责',exact:true}).fill('');assert.equal(await baseline().locator('article').count(),50);await baseline().getByRole('button',{name:'显示更多（950）',exact:true}).click();assert.equal(await baseline().locator('article').count(),100);const calls=(await status()).baselinePreviewCalls;await baselineBox().check();assert.equal((await status()).baselinePreviewCalls,calls);await noOverflow();await page.evaluate(()=>scrollTo(0,0));await shot(`baseline-ready-${viewport}`);
    const before=await(await page.request.get(origin+'/api/access/configuration')).json();await baselineConfirm().click();await baseline().getByText('现行岗位基线已确认，尚未启用岗位来源',{exact:true}).waitFor();const after=await(await page.request.get(origin+'/api/access/configuration')).json();assert.deepEqual(after.accounts,before.accounts);assert.deepEqual(after.cardRules,before.cardRules);assert.equal(after.personnelSource,undefined);assert.equal((await status()).baselineWrites,1);assert.equal((await status()).mutationWrites,0);await activate().waitFor();assert(await activate().isDisabled());await shot(`baseline-confirmed-${viewport}`);proof.groups.push(`${viewport}:baseline-1000-local-confirm-preserves-old-source`);
    await open({mode:'ready',loseNext:true});await baselineReady();await baselineBox().check();await baselineConfirm().click();await baseline().getByText('上次确认结果尚未返回，请使用原请求核对。',{exact:true}).waitFor();let facts=await status();assert.equal(facts.baselineWrites,1);const original=facts.requests.find(row=>row.url.endsWith('/personnel-baseline/confirm')).input.clientMutationId;await page.reload();await sourceTab().click();await baseline().getByRole('button',{name:'重试确认结果',exact:true}).click();await baseline().getByText('现行岗位基线已确认，尚未启用岗位来源',{exact:true}).waitFor();facts=await status();assert.equal(facts.baselineWrites,1);assert.equal(facts.mutationWrites,0);assert.equal(facts.requests.filter(row=>row.url.endsWith('/personnel-baseline/confirm')).at(-1).input.clientMutationId,original);proof.groups.push(`${viewport}:baseline-lost-result-reload-original-mutation`);
    await open({mode:'ready'});await baselineReady();await baselineBox().check();await control({mode:'blocked'});await baselineConfirm().click();await baseline().getByText('目录、现行岗位或配置已变化，请重新核对首次清单',{exact:true}).waitFor();assert(await baselineConfirm().isDisabled());assert.equal((await status()).baselineWrites,0);await control({mode:'ready'});await baselineReady();assert(await baselineBox().isEnabled());proof.groups.push(`${viewport}:baseline-conflict-requires-fresh-review`);
    await open({mode:'error'});await baselineCheck().click();await baseline().getByText('合成来源暂不可用，请重试',{exact:true}).waitFor();assert(await baselineConfirm().isDisabled());await control({mode:'ready'});await baselineReady();proof.groups.push(`${viewport}:baseline-read-error-recovers`);
    await open({mode:'holdPreview'});await baselineCheck().click();await waitForHeld('heldPreview');await page.getByRole('tab',{name:'账号权限',exact:true}).click();await control({mode:'ready'});await sourceTab().click();await baselineReady();await control({action:'releasePreview'});assert.equal(await baseline().getByText('过期旧职责',{exact:true}).count(),0);proof.groups.push(`${viewport}:baseline-unmounted-preview-isolated`);
    await open({mode:'ready',holdSave:true});await baselineReady();await baselineBox().check();await baselineConfirm().click();const held=await waitForHeld('heldSave');assert.equal(held.baselineWrites,1);assert.equal(held.revision,2);await control({action:'externalBaseline'});await page.getByRole('button',{name:'刷新',exact:true}).click();await baseline().getByText(/999项 · 另一合成管理员/).waitFor();await control({action:'releaseSave'});await baseline().getByText('配置已有后续更新，请核对当前状态',{exact:true}).waitFor();await baseline().getByText(/999项 · 另一合成管理员/).waitFor();assert.equal((await status()).baselineWrites,1);proof.groups.push(`${viewport}:baseline-stale-confirm-cannot-overwrite-newer-summary`);
  }
  baselineMode=false;
  await page.goto(origin);await sourceTab().waitFor();
  if(mode==='baseline'||mode==='all-functional')for(const viewport of ['desktop','mobile']){console.log(JSON.stringify({stage:`baseline-${viewport}`,at:new Date().toISOString()}));await baselineScenario(viewport);}
  baselineMode=false;
  if(mode==='card-red'){await open({active:true});await cardScenario();proof.groups.push('canonical-card-name-and-scoped-edit');await shot('card-red');}
  else if(mode==='stale-save'){await staleSave();proof.groups.push('isolated-stale-save');}
  else if(mode==='baseline-slow')for(const viewport of ['desktop','mobile']){
    baselineMode=true;await page.setViewportSize({width:viewport==='desktop'?1440:390,height:1050});await open({mode:'slowRead',holdSave:viewport==='desktop'});
    const started=Date.now();await measured(baselineCheck(),'baseline-slow-read',viewport,'busy','正在核对');
    await baseline().getByText('合成职责0001',{exact:true}).waitFor({timeout:22000});const readMs=Date.now()-started;
    assert(readMs>=16000&&readMs<24000);assert.equal((await status()).baselinePreviewCalls,1);assert(await baselineBox().isEnabled());
    if(viewport==='desktop'){
      await baselineBox().check();await measured(baselineConfirm(),'baseline-slow-confirm',viewport,'busy','正在确认');await waitForHeld('heldSave');
      await new Promise(resolve=>setTimeout(resolve,16000));assert.equal(await baseline().getByText(/保存结果未确认/).count(),0);
      await control({action:'releaseSave'});await baseline().getByText('现行岗位基线已确认，尚未启用岗位来源',{exact:true}).waitFor();
      const facts=await status();assert.equal(facts.baselineWrites,1);assert.equal(facts.mutationWrites,0);assert.equal(facts.sourceStatus,undefined);
    }
    await noOverflow();await page.evaluate(()=>scrollTo(0,0));await shot(`baseline-slow-${viewport}`);proof.groups.push(`${viewport}:16s-read-single-request-and-visible-terminal`);(proof.slowReads??=[]).push({viewport,observedMs:readMs});
  }
  else if(mode==='timeout'){
    baselineMode=true;await page.setViewportSize({width:390,height:1050});await open({mode:'ready',holdSave:true});await baselineReady();await baselineBox().check();
    const started=process.hrtime.bigint();await measured(baselineConfirm(),'baseline-real-timeout','mobile','busy','正在确认');const held=await waitForHeld('heldSave');assert.equal(held.baselineWrites,1);
    const operation=held.requests.find(row=>row.url.endsWith('/personnel-baseline/confirm')).input.clientMutationId;
    await baseline().getByText('保存结果未确认，请核对进度后使用原请求重试',{exact:true}).waitFor({timeout:67000});
    const elapsed=Number(process.hrtime.bigint()-started)/1e6;assert(elapsed>=60000);assert(elapsed<70000);
    await baseline().getByText('上次确认结果尚未返回，请使用原请求核对。',{exact:true}).waitFor();const retry=baseline().getByRole('button',{name:'重试确认结果',exact:true});assert(await retry.isEnabled());
    const draft=await page.evaluate(id=>Object.keys(sessionStorage).filter(key=>key.startsWith('vnet-personnel-baseline:')).some(key=>{try{return JSON.parse(sessionStorage.getItem(key)).clientMutationId===id;}catch{return false;}}),operation);assert(draft);
    await shot('baseline-real-timeout-mobile');await retry.click();await baseline().getByText('现行岗位基线已确认，尚未启用岗位来源',{exact:true}).waitFor();const facts=await status(),requests=facts.requests.filter(row=>row.url.endsWith('/personnel-baseline/confirm'));
    assert.equal(requests.length,2);assert(requests.every(row=>row.input.clientMutationId===operation));assert.equal(facts.baselineWrites,1);assert.equal(facts.mutationWrites,0);assert.equal(facts.sourceStatus,undefined);
    proof.timeout={configuredMs:60000,observedMs:elapsed,draftPreserved:draft,requests:requests.length,acceptedWrites:1,sameMutation:true,sourceActivated:false};proof.groups.push('mobile:baseline-real-60s-timeout-draft-original-retry');await noOverflow();
  }
  else if(mode==='performance')for(const viewport of ['desktop','mobile']){
    await page.setViewportSize({width:viewport==='desktop'?1440:390,height:1050});await open({active:true});
    const formal=viewport==='desktop'?20:10;
    for(const phase of ['warm','formal'])for(let index=0;index<(phase==='warm'?3:formal);index++){
      const next=await sourceTab().getAttribute('aria-selected')==='true'?page.getByRole('tab',{name:'账号权限',exact:true}):sourceTab();
      await measured(next,'source-tab',`${viewport}-${phase}`,'tab');
    }
    await open({mode:'ready'});await ready();
    for(const phase of ['warm','formal'])for(let index=0;index<(phase==='warm'?3:formal);index++){
      const checked=await acknowledge().isChecked();await measured(acknowledge(),'source-acknowledgement',`${viewport}-${phase}`,'checkbox',String(!checked));
    }
    for(const phase of ['warm','formal'])for(let index=0;index<(phase==='warm'?3:formal);index++){
      await measured(check(),'source-preview',`${viewport}-${phase}`,'busy','正在核对');await panel().getByText('合成职责0001',{exact:true}).waitFor();
    }
    for(const phase of ['warm','formal'])for(let index=0;index<(phase==='warm'?3:10);index++){
      await open({mode:'ready'});await ready();await acknowledge().check();await measured(activate(),'source-activate',`${viewport}-${phase}`,'busy','正在保存');await panel().getByText('岗位来源配置已保存',{exact:true}).waitFor();assert.equal((await status()).mutationWrites,1);
    }
    baselineMode=true;await open({mode:'ready'});await baselineReady();
    for(const phase of ['warm','formal'])for(let index=0;index<(phase==='warm'?3:formal);index++){
      const checked=await baselineBox().isChecked();await measured(baselineBox(),'baseline-acknowledgement',`${viewport}-${phase}`,'checkbox',String(!checked));
    }
    for(const phase of ['warm','formal'])for(let index=0;index<(phase==='warm'?3:formal);index++){
      await measured(baselineCheck(),'baseline-preview',`${viewport}-${phase}`,'busy','正在核对');await baseline().getByText('合成职责0001',{exact:true}).waitFor();
    }
    for(const phase of ['warm','formal'])for(let index=0;index<(phase==='warm'?3:10);index++){
      await open({mode:'ready'});await baselineReady();await baselineBox().check();await measured(baselineConfirm(),'baseline-confirm',`${viewport}-${phase}`,'busy','正在确认');await baseline().getByText('现行岗位基线已确认，尚未启用岗位来源',{exact:true}).waitFor();assert.equal((await status()).baselineWrites,1);assert.equal((await status()).mutationWrites,0);
    }
    proof.groups.push(`${viewport}:fixed-performance-matrix`);
    baselineMode=false;
  }
  else if(mode!=='baseline') {
  await open({mode:'ready',loseNext:'connection'});await ready();await acknowledge().check();await activate().click();
  await panel().getByText(/^(岗位来源配置已保存|上次操作结果尚未确认，请使用原请求重试。)$/).waitFor();
  const connectionFacts=await status(),connectionRequests=connectionFacts.requests.filter(row=>row.url.endsWith('/personnel-source'));
  assert.equal(connectionFacts.mutationWrites,1);assert(connectionRequests.every(row=>row.input.clientMutationId===connectionRequests[0].input.clientMutationId));
  proof.connectionRecovery={postCount:connectionRequests.length,mutationWrites:connectionFacts.mutationWrites,confirmed:await panel().getByText('岗位来源配置已保存',{exact:true}).count()===1};
  for(const viewport of ['desktop','mobile']){
    console.log(JSON.stringify({stage:viewport,at:new Date().toISOString()}));await page.setViewportSize({width:viewport==='desktop'?1440:390,height:1050});
    await open({mode:'empty'});assert.equal((await status()).previewCalls,0);assert(await activate().isDisabled());await check().click();await panel().getByText('尚无可识别岗位，请核对人员岗位、范围或额外职责',{exact:true}).waitFor();assert(await activate().isDisabled());assert.equal((await status()).mutationWrites,0);await noOverflow();await shot(`source-empty-${viewport}`);proof.groups.push(`${viewport}:empty-source-never-activates`);
    await open({mode:'ready'});await ready();await panel().getByRole('textbox',{name:'搜索来源职责人员',exact:true}).fill('1000');await panel().getByText('合成职责1000',{exact:true}).waitFor();assert.equal(await panel().locator('article').count(),1);
    await panel().getByRole('textbox',{name:'搜索来源职责人员',exact:true}).fill('');assert.equal(await panel().locator('article').count(),50);await panel().getByRole('button',{name:'显示更多（950）',exact:true}).click();assert.equal(await panel().locator('article').count(),100);await noOverflow();await shot(`source-ready-${viewport}`);
    const initialCalls=(await status()).previewCalls;
    for(const phase of ['warm','formal'])for(let index=0;index<(phase==='warm'?3:10);index++){const checked=await acknowledge().isChecked();await measured(acknowledge(),'source-acknowledgement',`${viewport}-${phase}`,'checkbox',String(!checked));}
    assert.equal((await status()).previewCalls,initialCalls,'Checkbox unexpectedly requested personnel');
    for(const phase of ['warm','formal'])for(let index=0;index<(phase==='warm'?3:10);index++){await measured(check(),'source-preview',`${viewport}-${phase}`,'busy','正在核对');await check().waitFor();await panel().getByText('合成职责0001',{exact:true}).waitFor();}
    await acknowledge().check();await measured(activate(),'source-activate',viewport,'busy','正在保存');await panel().getByText('岗位来源配置已保存',{exact:true}).waitFor();assert.equal((await status()).mutationWrites,1);proof.groups.push(`${viewport}:1000-rows-search-pagination-no-checkbox-network-activate`);
    await panel().getByRole('button',{name:'暂停新办理',exact:true}).click();await panel().getByText('岗位来源已暂停，相关新办理暂缓',{exact:true}).waitFor();assert.equal((await status()).sourceStatus,'paused');await check().click();await panel().getByText('合成职责0001',{exact:true}).waitFor();await acknowledge().check();await panel().getByRole('button',{name:'恢复岗位来源',exact:true}).click();await panel().getByText('岗位来源配置已保存',{exact:true}).waitFor();assert.equal((await status()).sourceStatus,'active');proof.groups.push(`${viewport}:pause-and-explicit-recovery`);
    await open({mode:'error'});await check().click();await panel().getByText('合成来源暂不可用，请重试',{exact:true}).waitFor();assert(await activate().isDisabled());await control({mode:'ready'});await ready();assert(await acknowledge().isEnabled());proof.groups.push(`${viewport}:source-error-visible-retry-preserves-safe-state`);
    await open({mode:'ready',loseNext:true});await ready();await acknowledge().check();await activate().click();await panel().getByText('上次操作结果尚未确认，请使用原请求重试。',{exact:true}).waitFor();let facts=await status();assert.equal(facts.mutationWrites,1);const original=facts.requests.find(row=>row.url.endsWith('/personnel-source')).input.clientMutationId;
    await control({action:'externalPause'});await page.reload();await sourceTab().click();await panel().getByRole('button',{name:'重试确认结果',exact:true}).click();await panel().getByText('岗位来源已暂停，相关新办理暂缓',{exact:true}).waitFor();facts=await status();const writes=facts.requests.filter(row=>row.url.endsWith('/personnel-source'));assert.equal(writes.at(-1).input.clientMutationId,original);assert.equal(facts.mutationWrites,1);assert.equal(facts.sourceStatus,'paused');proof.groups.push(`${viewport}:response-loss-reload-original-mutation-no-old-reactivation`);
    await open({mode:'holdPreview'});await check().click();await waitForHeld('heldPreview');await page.getByRole('tab',{name:'账号权限',exact:true}).click();await control({mode:'ready'});await sourceTab().click();await ready();await control({action:'releasePreview'});assert.equal(await panel().getByText('过期旧职责',{exact:true}).count(),0);proof.groups.push(`${viewport}:unmounted-old-preview-cannot-overwrite`);
    await staleSave();proof.groups.push(`${viewport}:stale-save-response-cannot-overwrite-newer-configuration`);
    await open({active:true});await cardScenario();await shot(`source-card-managed-${viewport}`);proof.groups.push(`${viewport}:managed-canonical-name-unmanaged-edit-navigation`);
  }
  }
  proof.feedback=[];for(const label of mode==='performance'?['source-tab','source-acknowledgement','source-preview','source-activate','baseline-acknowledgement','baseline-preview','baseline-confirm']:['source-acknowledgement','source-preview'])for(const viewport of ['desktop','mobile']){
    const rows=proof.samples.filter(row=>row.label===label&&row.phase===`${viewport}-formal`);if(!rows.length)continue;const submit=['source-activate','baseline-confirm'].includes(label),limit=submit?150:100;assert.equal(rows.length,mode==='performance'&&!submit&&viewport==='desktop'?20:10);
    const values=rows.map(row=>row.domMs).sort((a,b)=>a-b),frames=rows.map(row=>row.rafMs).sort((a,b)=>a-b);proof.feedback.push({label,viewport,count:rows.length,domP95:values[Math.ceil(values.length*.95)-1],rafP95:frames[Math.ceil(frames.length*.95)-1],domMax:values.at(-1),rafMax:frames.at(-1),physicalPaint:null});
    assert(values[Math.ceil(values.length*.95)-1]<=limit,`${viewport} ${label} DOM feedback P95 exceeds ${limit}ms`);
    assert(frames[Math.ceil(frames.length*.95)-1]<=limit,`${viewport} ${label} RAF feedback proxy P95 exceeds ${limit}ms`);
  }
  assert.deepEqual(proof.errors,[]);assert.deepEqual(proof.externalRequests,[]);assert.deepEqual(before,capture());assert.equal(hash(path.join(artifactRoot,'app.js')),artifacts.javascript);assert.equal(hash(path.join(artifactRoot,'app.css')),artifacts.css);proof.passed=true;
}
main().catch(async error=>{proof.errors.push(error.stack||String(error));process.exitCode=1;if(currentPage){try{const file=path.join(output,'failure.png');await currentPage.screenshot({path:file});proof.screenshots.push(file);}catch{}}}).finally(async()=>{
  proof.fixture=fixture.snapshot();fixture.close();if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));proof.cleanup={browserClosed:!!browser,httpClosed:!!server};proof.sourceBefore=before;proof.sourceAfter=inputs.length?capture():[];
  proof.elapsedMs=Date.now()-started;proof.completedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'proof.json'),JSON.stringify(proof,null,2));
  console.log(JSON.stringify({passed:proof.passed,mode,groups:proof.groups.length,samples:proof.samples.length,feedback:proof.feedback,errors:proof.errors.slice(-2),inputs:inputs.length,compilationMs:proof.compilationMs,elapsedMs:proof.elapsedMs,output}));
});
