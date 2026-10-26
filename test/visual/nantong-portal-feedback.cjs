const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'output/portal-image-20261012'),site=path.join(out,'site'),port=43312;
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const freezeFile=path.join(out,'freeze.json'),freeze=JSON.parse(fs.readFileSync(freezeFile,'utf8'));
const snapshot=()=>Object.fromEntries([...freeze.files.map(item=>item.path),__filename,...fs.readdirSync(site).map(name=>path.join(site,name)),require.resolve('playwright-core')].map(file=>[file,hash(file)]));
const proof={startedAt:new Date().toISOString(),command:`"${process.execPath}" "${__filename}"`,toolSha256:hash(__filename),node:process.version,nodeSha256:hash(process.execPath),freezeSha256:hash(freezeFile),browserProofSha256:hash(path.join(out,'browser-proof.json')),warmupCount:5,sampleCount:20,thresholdMs:100,metric:'Trusted browser click event timestamp to next RAF with matching visible device caption; not hardware-to-paint',passed:false,before:snapshot()};
let server,browser,feedbackPage;
(async()=>{
  try {
    for(const item of freeze.files)assert.equal(hash(item.path),item.sha256,'Frozen input changed: '+item.path);
    const old=JSON.parse(fs.readFileSync(path.join(out,'browser-proof.json'),'utf8'));assert.equal(old.passed,true);assert.deepEqual(Object.fromEntries(fs.readdirSync(site).map(name=>[name,hash(path.join(site,name))])),old.siteBefore);
    server=http.createServer((req,res)=>{
      const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      const file=pathname.startsWith('/portal/')?path.join(root,'client/public',pathname):path.join(site,pathname==='/'?'index.html':pathname);
      if(!(file.startsWith(site+path.sep)||file.startsWith(path.join(root,'client/public/portal')+path.sep))||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
      res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.html':'text/html','.webp':'image/webp','.jpg':'image/jpeg','.png':'image/png'}[path.extname(file)]||'application/octet-stream','Cache-Control':pathname.startsWith('/portal/vnet-photo-20261012/')?'public, max-age=31536000, immutable':'public, max-age=0, must-revalidate'});fs.createReadStream(file).pipe(res);
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
    browser=await chromium.launch({channel:'msedge',headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'}),page=await context.newPage();
    feedbackPage=page;
    await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:'domcontentloaded'});
    await page.locator('.photo-systems').scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('.system-photo')?.dataset.imageState==='ready');
    const environment=()=>page.evaluate(()=>({visibilityState:document.visibilityState,hasFocus:document.hasFocus(),viewport:{width:innerWidth,height:innerHeight},motionReduced:matchMedia('(prefers-reduced-motion: reduce)').matches,userAgent:navigator.userAgent}));
    proof.environmentBefore={...await environment(),browserVersion:browser.version(),network:'local server, no network throttle'};
    await page.evaluate(()=>{
      window.__portalFeedback={mode:'warmup',rows:[]};let pointer=null;
      document.addEventListener('pointerdown',event=>{
        const button=event.target.closest('.system-device-list button');if(!button)return;
        pointer={button,eventTimeStamp:event.timeStamp,captureAt:performance.now(),isTrusted:event.isTrusted,pointerType:event.pointerType};
      },true);
      document.addEventListener('click',event=>{
        const button=event.target.closest('.system-device-list button');if(!button)return;
        const store=window.__portalFeedback,start=performance.now();
        const row={sequence:store.rows.length,phase:store.mode,target:button.textContent.trim().replace(/^\d+\s*/,''),click:{eventTimeStamp:event.timeStamp,captureAt:start,isTrusted:event.isTrusted},pointer:pointer?.button===button?{eventTimeStamp:pointer.eventTimeStamp,captureAt:pointer.captureAt,isTrusted:pointer.isTrusted,pointerType:pointer.pointerType}:null,rafAt:null,label:null,visible:null,clickToVisibleMs:null,pointerToVisibleMs:null,paintAt:null};
        store.rows.push(row);
        requestAnimationFrame(()=>{
          const caption=document.querySelector('.equipment-caption h3'),panel=document.querySelector('#portal-system-panel'),rect=caption.getBoundingClientRect(),style=getComputedStyle(caption);
          row.rafAt=performance.now();row.label=panel.dataset.device;
          row.visible=caption.textContent===row.target&&style.visibility==='visible'&&Number(style.opacity)>0&&rect.width>0&&rect.height>0&&rect.top<innerHeight&&rect.bottom>0;
          row.clickToVisibleMs=row.rafAt-row.click.eventTimeStamp;
          row.pointerToVisibleMs=row.pointer?row.rafAt-row.pointer.eventTimeStamp:null;
        });
      },true);
    });
    for(let index=0;index<25;index++) {
      if(index===5)await page.evaluate(()=>{window.__portalFeedback.mode='measured';});
      await page.locator('.system-device-list button').nth(index%7).click();
      await page.waitForFunction(count=>window.__portalFeedback.rows.length===count&&window.__portalFeedback.rows[count-1].rafAt!==null,index+1);
    }
    proof.raw=await page.evaluate(()=>window.__portalFeedback.rows);
    const measured=proof.raw.filter(row=>row.phase==='measured');assert.equal(measured.length,20);assert.equal(proof.raw.filter(row=>row.phase==='warmup').length,5);
    for(const row of measured){assert.equal(row.click.isTrusted,true);assert.equal(row.pointer?.isTrusted,true);assert.equal(row.label,row.target);assert.equal(row.visible,true);assert(Number.isFinite(row.clickToVisibleMs)&&row.clickToVisibleMs>=0);if(row.pointerToVisibleMs!==null)assert(Number.isFinite(row.pointerToVisibleMs)&&row.pointerToVisibleMs>=0);}
    const sorted=measured.map(row=>row.clickToVisibleMs).sort((a,b)=>a-b);proof.clickToVisibleP95Ms=sorted[Math.ceil(sorted.length*.95)-1];assert(proof.clickToVisibleP95Ms<=100);
    proof.environmentAfter={...await environment(),browserVersion:browser.version(),network:'local server, no network throttle'};
    assert.equal(proof.environmentBefore.visibilityState,'visible');assert.equal(proof.environmentAfter.visibilityState,'visible');
    assert.deepEqual(proof.environmentAfter.viewport,proof.environmentBefore.viewport);
    assert.equal(proof.environmentAfter.motionReduced,proof.environmentBefore.motionReduced);
    proof.after=snapshot();assert.deepEqual(proof.after,proof.before);proof.passed=true;
    await context.close();
  } catch(error){proof.error=error.stack;process.exitCode=1;}
  finally {
    if(!proof.raw&&feedbackPage&&!feedbackPage.isClosed()) {
      try { proof.raw=await feedbackPage.evaluate(()=>window.__portalFeedback?.rows??null); }
      catch(error){proof.rawCaptureError=error.message;}
    }
    if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));
    proof.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'feedback-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:proof.passed,rawCount:proof.raw?.length,p95Ms:proof.clickToVisibleP95Ms,error:proof.error}));
  }
})();
