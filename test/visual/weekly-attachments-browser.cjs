const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const out = path.resolve('output/weekly-attachments-validation-20261009');
const api = 'http://127.0.0.1:4202';
const proof = { startedAt: new Date().toISOString(), passed: false, checks: [], errors: [], posts: [] };
const execution = JSON.parse(fs.readFileSync(path.join(out, 'execution-proof.json')));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
let png;
const inspect = async id => (await fetch(`${api}/__qa/weekly-record?id=${id}`)).json();
const reset = async () => assert((await fetch(`${api}/__qa/reset-weekly`)).ok);
const control = async mode => assert((await fetch(`${api}/__qa/control?mode=${mode}`)).ok);
async function main() {
  assert(execution.passed);
  await reset();
  const browser = await chromium.launch({channel: 'msedge', headless: true});
  const context = await browser.newContext({ viewport: {width:1440,height:1050}, permissions:['clipboard-read','clipboard-write'] });
  const page = await context.newPage();
  page.on('pageerror', error => proof.errors.push(error.message));
  page.on('console', message => { if (/same key|unique.*key/.test(message.text())) proof.errors.push(message.text()); });
  let failUpload = true;
  await page.route('**/api/**', async route => {
    const request = route.request();
    if (!request.url().startsWith('http://127.0.0.1:4200/api/')) return route.continue();
    if (request.method() === 'POST') {
      proof.posts.push({url:request.url(), body:request.postDataBuffer()?.toString().match(/filename="([^"]+)"/)?.[1]});
      if (failUpload && request.url().endsWith('/weekly/attachments') && request.postDataBuffer()?.toString().includes('filename="retry.pdf"')) {
        failUpload=false;
        return route.fulfill({status:503,json:{message:'验收模拟：受理失败，可重试'}});
      }
    }
    const response = await route.fetch({url:request.url().replace('http://127.0.0.1:4200',api)});
    await route.fulfill({response});
  });
  const dialog = () => page.getByRole('dialog');
  const paste = async () => {
    await page.bringToFront();
    await page.evaluate(() => {
      document.addEventListener('paste', event => { window.__pasteInfo = { files: event.clipboardData.files.length, items:[...event.clipboardData.items].map(item=>({kind:item.kind,type:item.type})), target:event.target.tagName }; }, {once:true,capture:true});
    });
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width=32; canvas.height=24;
      canvas.getContext('2d').fillRect(0,0,32,24);
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]);
    });
    await dialog().getByLabel('整段待办内容').focus();
    await page.keyboard.press('Control+V');
    await page.waitForTimeout(700);
    proof.lastPaste=await page.evaluate(()=>window.__pasteInfo || {clipboardEvent:false});
  };
  try {
    await control('normal');
    const snapshot = await (await fetch(`${api}/api/meeting-management/snapshot`)).json();
    const target = snapshot.records.filter(item=>item.source==='nantong-weekly').sort((a,b)=>(b.date||'').localeCompare(a.date||''))[0];
    await page.goto('http://127.0.0.1:4200/meeting-management/nantong-weekly');
    png = Buffer.from(await page.evaluate(() => { const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24;canvas.getContext('2d').fillRect(0,0,32,24);return canvas.toDataURL('image/png').split(',')[1]; }), 'base64');
    await page.getByLabel('目标周报').selectOption(target.id);
    await page.getByRole('button',{name:'阿里待办',exact:true}).click();
    await dialog().getByLabel('整段待办内容').fill('附件验证：整段待办保留\n1、检查现场\n2、跟进整改');
    const files = Array.from({length:7},(_,index)=>({name:`截图${index}.png`,mimeType:'image/png',buffer:Buffer.concat([png,Buffer.from([index])])}));
    files.push({name:'retry.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\n会议附件测试')},{name:'会议纪要.txt',mimeType:'text/plain',buffer:Buffer.from('测试纪要')});
    await dialog().getByLabel('选择会议附件').setInputFiles(files);
    assert.equal(await dialog().locator('figure').count(),9);
    assert.equal(await dialog().locator('img').count(),7);
    await dialog().getByLabel('选择会议附件').setInputFiles({name:'oversize.zip',mimeType:'application/zip',buffer:Buffer.alloc(10*1024*1024+1)});
    await dialog().getByRole('alert').filter({hasText:'oversize.zip'}).waitFor();
    assert.equal(await dialog().locator('figure').count(),9);
    await paste();
    proof.pastedFiles=await dialog().locator('figure figcaption').allTextContents();
    if(proof.pastedFiles.length!==10) {
      await page.screenshot({path:path.join(out,'paste-debug.png')});
      fs.writeFileSync(path.join(out,'paste-debug.html'),await dialog().innerHTML());
    }
    assert.equal(await dialog().locator('figure').count(),10,JSON.stringify({event:proof.lastPaste,files:proof.pastedFiles}));
    assert.equal(await dialog().getByLabel('整段待办内容').inputValue(),'附件验证：整段待办保留\n1、检查现场\n2、跟进整改');
    await dialog().getByLabel('粘贴会议截图').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(out,'attachments-desktop.png')});
    proof.checks.push('超过5张、混合PDF/文本附件、真实系统剪贴板Ctrl+V截图，原待办文本保留');
    await dialog().getByRole('button',{name:'保存',exact:true}).evaluate(button=>{button.click();button.click();});
    await dialog().getByRole('alert').filter({hasText:'retry.pdf'}).waitFor();
    assert.equal(await dialog().locator('figure').count(),10);
    assert.equal(proof.posts.filter(item=>item.url.endsWith('/weekly/meetings')).length,1);
    await dialog().getByRole('button',{name:'保存',exact:true}).click();
    await dialog().waitFor({state:'hidden'});
    let state;
    for(let index=0;index<80;index++) {
      state=await inspect(target.id);
      if(state.jobs.length===11 && state.jobs.every(job=>job.status==='success'))break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert(state.jobs.every(job=>job.status==='success'),JSON.stringify(state.jobs));
    assert.equal(state.fields['阿里会议附件'].length,10);
    assert.equal(state.imageUploads,10);
    assert.equal(state.fields['阿里会议待办'],'附件验证：整段待办保留\n1、检查现场\n2、跟进整改');
    assert.equal(proof.posts.filter(item=>item.url.endsWith('/weekly/meetings')).length,1);
    assert.equal(proof.posts.filter(item=>item.url.endsWith('/weekly/attachments')).length,11);
    assert(state.fields['阿里会议附件'].some(item=>item.name.includes('retry.pdf')));
    proof.checks.push('每附件独立任务，受理失败保留草稿，重试跳过7个已受理附件，重复点击不重复保存');
    await reset();
    await control('image-write-fail');
    await page.reload();
    await page.getByLabel('目标周报').selectOption(target.id);
    await page.getByRole('button',{name:'阿里待办',exact:true}).click();
    await dialog().getByLabel('整段待办内容').fill('普通附件回填失败测试');
    await dialog().getByLabel('选择会议附件').setInputFiles({name:'会议记录.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.7\n失败重试')});
    await dialog().getByRole('button',{name:'保存',exact:true}).click();
    await dialog().waitFor({state:'hidden'});
    const attachmentJob = page.locator('.weekly-job').filter({hasText:'会议记录.pdf'});
    await attachmentJob.getByRole('button',{name:'重试失败步骤',exact:true}).waitFor();
    assert.equal((await inspect(target.id)).imageUploads,1);
    await control('normal');
    await attachmentJob.getByRole('button',{name:'重试失败步骤',exact:true}).click();
    await attachmentJob.getByText('已完成',{exact:true}).waitFor();
    assert.equal((await inspect(target.id)).imageUploads,1);
    proof.checks.push('普通PDF回填失败显示文件名，重试仅回填，已上传文件不重传');
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'属地周会待办',exact:true}).click();
    await dialog().getByLabel('整段待办内容').fill('手机截图验证');
    await paste();
    await page.waitForFunction(()=>document.querySelectorAll('.weekly-image-previews figure').length===1);
    assert(await dialog().evaluate(node=>node.scrollWidth<=node.clientWidth+1));
    await dialog().getByLabel('粘贴会议截图').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(out,'attachments-mobile.png')});
    await dialog().getByRole('button',{name:'取消',exact:true}).click();
    assert.equal((await inspect(target.id)).imageUploads,1);
    proof.checks.push('390px弹窗截图预览、文件操作无横向溢出，取消不上传');
    await reset();
    assert.equal((await inspect(target.id)).jobs.length,0);
    for(const input of execution.inputs)assert.equal(sha(input.path),input.sha256,input.path);
    assert.equal(proof.errors.length,0,JSON.stringify(proof.errors));
    proof.executionProofSha256=sha(path.join(out,'execution-proof.json'));
    proof.passed=true;
  } finally {
    await control('normal');
    await browser.close();
    proof.finishedAt=new Date().toISOString();
    fs.writeFileSync(path.join(out,'browser-proof.json'),JSON.stringify(proof,null,2));
  }
  console.log(JSON.stringify({passed:proof.passed,checks:proof.checks}));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
