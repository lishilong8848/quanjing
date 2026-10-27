// Reuses the existing real MonthlySchedule/login-entry fixture; all APIs are local synthetic data.
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { rspack } = require('@rspack/core'), { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..'), name = process.argv[2];
if (!/^[a-z0-9-]+$/.test(name || '')) throw Error('Unique evidence name required');
const output = path.join(root, 'output/leave-three-months-20261027', name);
if (fs.existsSync(output)) throw Error('Evidence exists');
fs.mkdirSync(output, { recursive: true });
const keepOpen = process.argv.includes('--keep-open');
const performanceOnly = process.argv.includes('--performance-only');
if(process.argv.includes('--production')){
  process.env.MEETING_BROWSER_MODE='production';
  process.env.NODE_ENV='production';
}
const reuseIndex=process.argv.indexOf('--reuse-build'), reuseName=reuseIndex<0?null:process.argv[reuseIndex+1];
if(reuseName&&!/^[a-z0-9-]+$/.test(reuseName))throw Error('Invalid reusable build name');
const assetRoot=reuseName?path.join(root,'output/leave-three-months-20261027',reuseName):output;
const base = require('../helpers/leave-applicant-browser.rspack.cjs');
const fixture = require('../helpers/leave-applicant-browser-fixture.cjs');
const proof = { passed: false, checks: [], cases: [], errors: [], externalRequests: [], requests: [], screenshots: [] };
proof.buildMode=base.mode;
const percentile = (values, fraction) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length*fraction)-1)] ?? null;
let server, browser, page;
const compiler = reuseName?null:rspack({ ...base, devServer: undefined, output: { ...base.output, path: output, clean: false } });
async function main() {
  const buildStart = performance.now();
  if(reuseName){
    const prior=JSON.parse(fs.readFileSync(path.join(assetRoot,'proof.json'),'utf8'));
    assert(prior.sourceHashes?.length,'Source binding missing');
    for(const source of prior.sourceHashes)assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(root,source.path))).digest('hex'),source.sha256,`Compiled source changed: ${source.path}`);
    proof.sourceHashes=prior.sourceHashes;proof.reusedBuild=assetRoot;
  }else{
  await new Promise((resolve, reject) => compiler.run((error, stats) => {
    if (!error && !stats.hasErrors()) proof.sourceHashes = [...stats.compilation.fileDependencies]
      .filter(file => file.startsWith(root + path.sep) && !file.includes(path.sep+'node_modules'+path.sep) && fs.existsSync(file) && fs.statSync(file).isFile())
      .sort().map(file => ({ path:path.relative(root,file), sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
    compiler.close(() => error || stats.hasErrors() ? reject(error || Error(stats.toString({all:false,errors:true}))) : resolve());
  }));
  }
  proof.compileMs = performance.now()-buildStart;
  console.log(JSON.stringify({ phase: 'development-compile-complete', compileMs: proof.compileMs }));
  const app = fixture.app;
  app.use('/__innerapi__', (_, res) => res.json({ code: 0, data: null }));
  app.use(require('express').static(path.join(root,'client/public'),{dotfiles:'deny'}));
  app.use((req,res) => {
    const filename = new URL(req.url,'http://127.0.0.1').pathname.slice(1);
    if (/^[\w.-]+\.(?:js|css|png|svg|jpe?g|woff2?)$/.test(filename) && fs.existsSync(path.join(assetRoot,filename))) return res.sendFile(path.join(assetRoot,filename));
    res.set('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; frame-src 'none'; object-src 'none'");
    return res.sendFile(path.join(assetRoot,'index.html'));
  });
  server = http.createServer(app);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  proof.origin=origin; proof.pid=process.pid;
  browser=await chromium.launch({channel:'msedge',headless:true});
  if(performanceOnly){await measureProduction(browser,origin);return;}
  const scenarios=[
    {key:'middle-1800', date:'2026-10-15', months:['2026-09','2026-10','2026-11'], rows:600, rounds:20},
    {key:'cross-december', date:'2026-12-15', months:['2026-11','2026-12','2027-01'], rows:600, rounds:3},
    {key:'cross-january', date:'2027-01-15', months:['2026-12','2027-01','2027-02'], rows:600, rounds:3},
    {key:'history-retained', date:'2026-10-15', selected:'2026-08-15', months:['2026-09','2026-10','2026-11'], rows:600, rounds:3},
    {key:'long-white', date:'2026-10-15', months:['2026-09','2026-10','2026-11'], rows:600, shift:'long_white', rounds:3},
    {key:'stress-6000', date:'2026-10-15', months:['2026-09','2026-10','2026-11'], rows:2000, rounds:20},
  ];
  for(const scenario of scenarios){
    const now=`${scenario.date}T01:00:00Z`;
    fixture.configureScenario({rowsPerMonth:scenario.rows,delayMs:200,now,shift:scenario.shift||'white'});
    page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai'});
    await page.clock.setFixedTime(new Date(now));
    page.on('pageerror',error=>proof.errors.push({case:scenario.key,message:error.message}));
    await page.route('**/*',route=>{
      if(new URL(route.request().url()).origin!==origin){proof.externalRequests.push(route.request().url());return route.abort();}
      return route.continue();
    });
    await page.context().addCookies([{name:'qa_actor',value:'feishu',url:origin}]);
    await page.addInitScript(()=>{
      window.__leaveTimings={open:[],select:[]}; let openStarted=null;
      document.addEventListener('click',event=>{const item=event.target.closest?.('[role="menuitem"]');if(item?.textContent.includes('请休假&差旅申请'))openStarted=performance.now();},true);
      document.addEventListener('change',event=>{if(/^leave-(start|end)-(date|time)$/.test(event.target.id||'')){const started=performance.now();requestAnimationFrame(()=>window.__leaveTimings.select.push(performance.now()-started));}},true);
      document.addEventListener('DOMContentLoaded',()=>new MutationObserver(()=>{
        if(openStarted===null)return;
        const dialog=[...document.querySelectorAll('[role="dialog"]')].find(x=>x.textContent.includes('请休假&差旅申请'));
        if(dialog){const started=openStarted;openStarted=null;requestAnimationFrame(()=>window.__leaveTimings.open.push(performance.now()-started));}
      }).observe(document.body,{childList:true,subtree:true}));
    });
    const navigationStarted=performance.now();
    await page.goto(`${origin}/monthly-schedule?form=leave${scenario.selected?'&screenshotDate='+scenario.selected:''}`);
    const dialog=page.getByRole('dialog').filter({hasText:'请休假&差旅申请'});
    await dialog.waitFor();
    await page.waitForFunction(()=>document.querySelector('#leave-staff-name')?.value==='验收员工甲' && document.querySelector('#leave-start-date')?.value);
    await page.waitForFunction(months=>months.every(month=>[...document.querySelector('#leave-start-date').options].some(option=>option.text.startsWith(month))),scenario.months);
    const initialReadyMs=performance.now()-navigationStarted;
    const scheduleReads=()=>fixture.observations.filter(x=>x.path.startsWith('/api/monthly-schedules/'));
    const counts=()=>Object.fromEntries([...new Set(scheduleReads().map(x=>x.path))].map(p=>[p,scheduleReads().filter(x=>x.path===p).length]));
    assert(scheduleReads().every(x=>!x.refresh),'Unexpected forced schedule read');
    assert(Object.values(counts()).every(n=>n===1),'Duplicate initial month read');
    assert.equal(scheduleReads().length,scenario.selected?4:3);
    const initialRequests=scheduleReads().length;
    const groups=await dialog.locator('#leave-start-date option').evaluateAll(options=>options.map(option=>({value:option.value,label:option.textContent})));
    for(const month of scenario.months)assert(groups.some(x=>x.label.startsWith(month)),`${scenario.key} missing ${month}`);
    const previousGroup=groups.find(x=>x.label.startsWith(scenario.months[0]+'-10')) || groups.find(x=>x.label.startsWith(scenario.months[0]+'-09'));
    assert(previousGroup,'Synthetic previous-month selection absent');
    await dialog.locator('#leave-start-date').selectOption(previousGroup.value);
    await page.waitForFunction(months=>months.every(month=>[...document.querySelector('#leave-end-date').options].some(option=>option.text.startsWith(month))),scenario.months);
    const endGroup=await dialog.locator('#leave-end-date option').evaluateAll((options,month)=>options.find(option=>option.text.startsWith(month+'-10'))?.value,scenario.months[2]);
    if(endGroup)await dialog.locator('#leave-end-date').selectOption(endGroup);
    await dialog.locator('#leave-start-date').click(); await page.keyboard.press('Escape');
    await page.waitForTimeout(100);
    assert.equal(scheduleReads().length,initialRequests,'Dropdown interaction added a month request');
    for(let i=0;i<scenario.rounds;i++){
      await dialog.getByRole('button',{name:'取消',exact:true}).click(); await dialog.waitFor({state:'hidden'});
      await page.getByRole('button',{name:'常用工具',exact:true}).click();
      await page.getByRole('menuitem',{name:'人员相关',exact:true}).hover();
      await page.getByRole('menuitem',{name:'请休假&差旅申请',exact:true}).click();
      await dialog.waitFor();
      await page.waitForFunction(()=>Boolean(document.querySelector('#leave-start-date')?.value));
    }
    assert.equal(scheduleReads().length,initialRequests,'Repeated opening added schedule reads');
    assert(!fixture.observations.some(x=>x.path==='/api/duty-schedules/leave-request'&&x.method==='POST'),'Fixture must not submit leave');
    await page.waitForTimeout(60);
    const timing=await page.evaluate(()=>window.__leaveTimings);
    const result={key:scenario.key,syntheticRows:scenario.rows*(scenario.selected?4:3),initialReadyMs,monthRequests:counts(),dropdownRequestIncrease:0,reopenRequestIncrease:0,openSamples:timing.open.length,clickToVisibleP50:percentile(timing.open,.5),clickToVisibleP95:percentile(timing.open,.95),selectEventToFrameP95:percentile(timing.select,.95),method:'Browser performance.now: menu-item click to dialog next frame, and native select change to next frame; synthetic localhost; no CPU throttling'};
    assert(timing.open.length>=scenario.rounds-1,'Missing representative interaction timing samples');
    if(scenario.selected){
      await dialog.getByRole('button',{name:'取消',exact:true}).click();
      assert((await page.locator('.duty-calendar-panel').innerText()).includes('2026年8月'),'Historical overview month missing');
    }
    if(['middle-1800','stress-6000'].includes(scenario.key)){
      assert(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'Desktop dialog overflow');
      const file=path.join(output,scenario.key+'.png'); await page.screenshot({path:file}); proof.screenshots.push(file);
    }
    proof.cases.push(result); proof.requests.push({case:scenario.key,requests:[...fixture.observations]});
    await page.close(); page=null;
  }
  proof.checks.push('three default months available in month middle','December/January year boundaries','historical overview retained with extra month','long-white candidates keep work-calendar behavior','monthly cache/in-flight dedup and zero dropdown/reopen reads','1800/6000-row desktop interaction metrics');
  assert.deepEqual(proof.errors,[]); assert.deepEqual(proof.externalRequests,[]);proof.passed=true;
  fixture.configureScenario({rowsPerMonth:600,delayMs:0});
  proof.previewUrl=`${origin}/qa/feishu`;
}
async function measureProduction(browser,origin){
  assert.equal(base.mode,'production','Performance comparison requires production React/config');
  const current=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(new Date());
  const scenarios=[{key:'single-month-600',rows:600,onlyMonth:current,total:600},{key:'three-month-1800',rows:600,total:1800},{key:'three-month-6000',rows:2000,total:6000}];
  for(const scenario of scenarios){
    fixture.configureScenario({rowsPerMonth:scenario.rows,delayMs:200,onlyMonth:scenario.onlyMonth||null});
    page=await browser.newPage({viewport:{width:1440,height:1000},timezoneId:'Asia/Shanghai'});
    page.on('pageerror',error=>proof.errors.push({case:scenario.key,message:error.message}));
    await page.route('**/*',route=>{
      if(new URL(route.request().url()).origin!==origin){proof.externalRequests.push(route.request().url());return route.abort();}
      return route.continue();
    });
    await page.context().addCookies([{name:'qa_actor',value:'feishu',url:origin}]);
    await page.addInitScript(()=>{
      window.__productionLeavePerf={open:[],select:[],longTasks:[],started:0};let started=null;
      new PerformanceObserver(list=>{for(const entry of list.getEntries())window.__productionLeavePerf.longTasks.push({start:entry.startTime,duration:entry.duration});}).observe({type:'longtask',buffered:true});
      document.addEventListener('click',event=>{const item=event.target.closest?.('[role="menuitem"]');if(item?.textContent.includes('请休假&差旅申请'))started=performance.now();},true);
      document.addEventListener('change',event=>{if(event.target.id==='leave-start-date'){const at=performance.now();requestAnimationFrame(()=>window.__productionLeavePerf.select.push({at,rafMs:performance.now()-at}));}},true);
      document.addEventListener('DOMContentLoaded',()=>new MutationObserver(()=>{
        if(started===null)return;
        const target=[...document.querySelectorAll('[role="dialog"]')].find(e=>e.textContent.includes('请休假&差旅申请'));
        if(target){const at=started;started=null;const domMs=performance.now()-at;requestAnimationFrame(()=>window.__productionLeavePerf.open.push({at,domMs,rafMs:performance.now()-at}));}
      }).observe(document.body,{childList:true,subtree:true,attributes:true}));
    });
    const navStarted=performance.now();
    await page.goto(`${origin}/monthly-schedule?form=leave`);
    const dialog=page.getByRole('dialog').filter({hasText:'请休假&差旅申请'});
    await dialog.waitFor();await page.waitForFunction(()=>Boolean(document.querySelector('#leave-start-date')?.value));
    const readyMs=performance.now()-navStarted;
    const clockStart=await page.evaluate(()=>({value:performance.now(),native:performance.now.toString().includes('[native code]'),date:Date.now()}));
    const hostStart=performance.now();await page.waitForTimeout(250);
    const clockEnd=await page.evaluate(()=>({value:performance.now(),date:Date.now()}));
    assert(clockStart.native,'performance.now was replaced');assert(clockEnd.value-clockStart.value>=200,'Monotonic clock did not advance naturally');
    const clock={usedPlaywrightClock:false,native:clockStart.native,browserElapsedMs:clockEnd.value-clockStart.value,hostElapsedMs:performance.now()-hostStart,dateElapsedMs:clockEnd.date-clockStart.date};
    const selectValue=async day=>dialog.locator('#leave-start-date option').evaluateAll((options,prefix)=>options.find(x=>x.textContent.startsWith(prefix))?.value,`${current}-${day}`);
    async function openAgain(){
      await dialog.getByRole('button',{name:'取消',exact:true}).click();await dialog.waitFor({state:'hidden'});
      await page.getByRole('button',{name:'常用工具',exact:true}).click();await page.getByRole('menuitem',{name:'人员相关',exact:true}).hover();
      await page.getByRole('menuitem',{name:'请休假&差旅申请',exact:true}).click();await dialog.waitFor();await page.waitForFunction(()=>Boolean(document.querySelector('#leave-start-date')?.value));
    }
    for(let i=0;i<5;i++){await openAgain();const value=await selectValue(i%2?'16':'15');assert(value);await dialog.locator('#leave-start-date').selectOption(value);}
    await page.waitForTimeout(1200);
    await page.evaluate(()=>{window.__productionLeavePerf.open=[];window.__productionLeavePerf.select=[];window.__productionLeavePerf.started=performance.now();});
    const beforeReads=fixture.observations.filter(x=>x.path.startsWith('/api/monthly-schedules/')).length;
    for(let i=0;i<20;i++){
      await openAgain();const value=await selectValue(i%2?'16':'15');assert(value);await dialog.locator('#leave-start-date').selectOption(value);
      await page.waitForFunction(count=>window.__productionLeavePerf.open.length>=count&&window.__productionLeavePerf.select.length>=count,i+1);
    }
    await page.waitForTimeout(100);
    const timing=await page.evaluate(()=>({...window.__productionLeavePerf,domNodes:document.querySelectorAll('*').length,startGroups:document.querySelector('#leave-start-date').options.length,endGroups:document.querySelector('#leave-end-date').options.length}));
    const reads=fixture.observations.filter(x=>x.path.startsWith('/api/monthly-schedules/'));
    const perMonth=Object.fromEntries([...new Set(reads.map(x=>x.path))].map(p=>[p,reads.filter(x=>x.path===p).length]));
    assert.equal(reads.length,3);assert.equal(beforeReads,3);assert(Object.values(perMonth).every(n=>n===1));assert(reads.every(x=>!x.refresh));
    assert.equal(timing.open.length,20);assert.equal(timing.select.length,20);
    const longTasks=timing.longTasks.filter(x=>x.start>=timing.started);
    const summarize=values=>({p50:percentile(values,.5),p95:percentile(values,.95),max:Math.max(...values)});
    proof.cases.push({key:scenario.key,syntheticRows:scenario.total,profileCount:fixture.names.length,production:true,clock,initialReadyMs:readyMs,monthRequests:perMonth,additionalInteractionReads:0,openSamples:20,selectionSamples:20,clickToDialogDomMs:summarize(timing.open.map(x=>x.domMs)),clickToNextFrameMs:summarize(timing.open.map(x=>x.rafMs)),selectChangeToNextFrameMs:summarize(timing.select.map(x=>x.rafMs)),domNodes:timing.domNodes,startGroups:timing.startGroups,endGroups:timing.endGroups,longTasks:{count:longTasks.length,totalMs:longTasks.reduce((a,x)=>a+x.duration,0),maxMs:Math.max(0,...longTasks.map(x=>x.duration))},rawTimings:timing});
    console.log(JSON.stringify({phase:'performance-case-complete',...proof.cases.at(-1),rawTimings:undefined}));
    if(scenario.total===6000){
      const baseline=proof.cases[0],currentCase=proof.cases.at(-1);
      const regression=currentCase.clickToDialogDomMs.p95>baseline.clickToDialogDomMs.p95*1.25+30||currentCase.selectChangeToNextFrameMs.p95>baseline.selectChangeToNextFrameMs.p95*1.25+30;
      if(regression||currentCase.clickToDialogDomMs.p95>200){
        const cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.start');
        await cdp.send('Tracing.start',{categories:'devtools.timeline,v8,blink.user_timing,disabled-by-default-devtools.timeline,disabled-by-default-v8.cpu_profiler',transferMode:'ReturnAsStream'});
        for(let i=0;i<3;i++){await openAgain();await dialog.locator('#leave-start-date').selectOption(await selectValue(i%2?'16':'15'));await page.waitForTimeout(100);}
        const profile=await cdp.send('Profiler.stop');fs.writeFileSync(path.join(output,'stress.cpuprofile'),JSON.stringify(profile.profile));
        const finished=new Promise(resolve=>cdp.once('Tracing.tracingComplete',resolve));await cdp.send('Tracing.end');const {stream}=await finished;
        const parts=[];while(true){const part=await cdp.send('IO.read',{handle:stream});parts.push(part.base64Encoded?Buffer.from(part.data,'base64'):Buffer.from(part.data));if(part.eof)break;}await cdp.send('IO.close',{handle:stream});
        fs.writeFileSync(path.join(output,'stress-trace.json'),Buffer.concat(parts));proof.performanceTrace={trigger:'Production remained slow or exceeded comparison threshold',cpuProfile:'stress.cpuprofile',trace:'stress-trace.json'};await cdp.detach();
      }
    }
    await page.close();page=null;
  }
  assert.deepEqual(proof.errors,[]);assert.deepEqual(proof.externalRequests,[]);
  assert(!fixture.observations.some(x=>x.path==='/api/duty-schedules/leave-request'&&x.method==='POST'));
  proof.checks.push('production React and one immutable fixture build','same1202profiles and three API calls for all sizes','no mocked wall/monotonic clock','20 equal current-month selections and reopenings per size','no submission/external calls');proof.passed=true;
  proof.performanceAccepted=false;proof.performanceAssessment='Measurements require independent comparison; functional checks alone do not mark performance accepted.';
  fixture.configureScenario({rowsPerMonth:600});proof.previewUrl=`${origin}/qa/feishu`;
}
main().catch(async error=>{proof.errors.push(error.stack||String(error));proof.failedRequests=fixture.observations;process.exitCode=1;if(page){proof.lastPageText=await page.locator('body').innerText().catch(()=> 'unavailable');await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});}}).finally(async()=>{
  await browser?.close();fs.writeFileSync(path.join(output,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:proof.passed,output,origin:proof.origin,pid:process.pid,keepOpen}));if(!keepOpen||!proof.passed)server?.close();
});
const stop=()=>server?.close(()=>process.exit(0));process.once('SIGINT',stop);process.once('SIGTERM',stop);
