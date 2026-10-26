const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{chromium}=require('playwright-core');
const out=path.resolve('output/weekly-workbench-validation-20261009'),ui='http://127.0.0.1:4203',api='http://127.0.0.1:4202';
const proof={startedAt:new Date().toISOString(),passed:false,checks:[],errors:[]};
(async()=>{
 const browser=await chromium.launch({channel:'msedge',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',error=>proof.errors.push(error.message));
 try{
 await fetch(api+'/__qa/control?mode=normal&role=admin');assert((await fetch(api+'/__qa/reset-weekly')).ok);
 await page.goto(ui+'/meeting-management/nantong-weekly');await page.getByRole('heading',{name:'周报工作台'}).waitFor();
 const latest=(await (await fetch(api+'/api/meeting-management/snapshot')).json()).records.filter(r=>r.source==='nantong-weekly').sort((a,b)=>(b.date||'').localeCompare(a.date||'')||a.id.localeCompare(b.id))[0];
 await page.waitForFunction(id=>document.querySelector('select[aria-label="目标周报"]')?.value===id,latest.id);
 assert.equal(await page.getByRole('link',{name:'历史会议',exact:true}).count(),0);assert.equal(await page.locator('.weekly-console-actions button').count(),3);
 await page.screenshot({path:path.join(out,'workbench-desktop.png')});proof.checks.push('导航移除历史会议；工作台默认最新周报、三个主要操作并列');
 await page.getByLabel('目标周报').selectOption('');assert(await page.getByRole('button',{name:'阿里待办',exact:true}).isDisabled());assert(await page.getByRole('button',{name:'生成周报',exact:true}).isDisabled());
 await page.getByLabel('目标周报').selectOption(latest.id);
 await page.getByRole('button',{name:'生成周报',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'开始生成',exact:true}).waitFor();
 await page.waitForFunction(()=>![...document.querySelectorAll('[role="dialog"] button')].find(b=>b.textContent==='开始生成')?.disabled);
 assert.equal(await page.getByRole('dialog').getByLabel('结束日期').inputValue(),latest.date);await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
 proof.checks.push('未选周报时明确禁用；生成弹窗核对目标并保留日期调整');
 await page.goto(ui+'/meeting-management/nantong-weekly?record=recvwKLPD56d2R');await page.getByRole('dialog').getByRole('button',{name:'管理线',exact:true}).waitFor({timeout:30000});
 const dialog=page.getByRole('dialog');assert.equal(await dialog.getByRole('button',{name:'全部内容',exact:true}).getAttribute('aria-pressed'),'true');
 await dialog.getByRole('button',{name:'管理线',exact:true}).click();await dialog.getByText('A楼：风险处置',{exact:true}).count();
 const management=await dialog.locator('.meeting-content-text').innerText();assert(management.includes('970')&&management.includes('A楼'));assert(!management.includes('1、电气专业线'));
 await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('[role="dialog"]')).opacity)>=0.999);await page.screenshot({path:path.join(out,'week40-management.png')});
 await dialog.getByRole('button',{name:'上周周会待办',exact:true}).click();const todos=await dialog.locator('.meeting-content-text').innerText();assert(todos.trim().length>0);await page.screenshot({path:path.join(out,'week40-todos.png')});
 const detail=await (await fetch(api+'/api/meeting-management/records/recvwKLPD56d2R')).json();assert.equal(detail.documentState,'ready');assert.equal(detail.meeting.documentUrl,'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE');
 proof.original={id:detail.meeting.id,documentState:detail.documentState,sections:detail.meeting.sections.map(s=>({key:s.key,origin:s.origin||'table',chars:s.content.length,sha256:crypto.createHash('sha256').update(s.content).digest('hex')}))};
 proof.checks.push('真实第40周原文：管理线、上周周会待办补读成功；不混入专业线；默认全部内容；原始周报链接恢复');
 await dialog.getByRole('button',{name:'关闭',exact:true}).click();await page.setViewportSize({width:390,height:844});await page.goto(ui+'/meeting-management/nantong-weekly');await page.getByRole('heading',{name:'周报工作台'}).waitFor();
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:path.join(out,'workbench-mobile.png')});proof.checks.push('390px 工作台纵排，无遮挡及整页横向滚动');
 await page.goto(ui+'/meeting-management/history');await page.waitForURL(ui+'/meeting-management');assert.equal(await page.getByRole('link',{name:'历史会议',exact:true}).count(),0);proof.checks.push('旧历史会议地址安全跳转会议总览');
 assert.equal(proof.errors.length,0);assert((await fetch(api+'/__qa/reset-weekly')).ok);proof.passed=true;
 }catch(error){proof.error=error.message;process.exitCode=1;await page.screenshot({path:path.join(out,'failure.png')});}finally{await browser.close();proof.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'browser-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));}
})();
