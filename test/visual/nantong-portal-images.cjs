const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { rspack, DefinePlugin, NormalModuleReplacementPlugin } = require('@rspack/core');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'output/portal-image-20261012');
const site = path.join(out, 'site');
const fixture = path.join(__dirname, 'portal-images-fixture');
const port = 43312;
const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const owned = [
  'client/src/pages/NantongBaseHome/index.tsx', 'client/src/pages/NantongBaseHome/SystemsGallery.tsx',
  'client/src/pages/NantongBaseHome/PortalImage.tsx', 'client/src/pages/NantongBaseHome/portal-asset.ts',
  'client/src/pages/NantongBaseHome/portal-data.ts', 'client/src/pages/NantongBaseHome/portal.css',
  'client/src/pages/NantongBaseHome/CampusTour.tsx', 'client/src/pages/NantongBaseHome/CampusOverview.tsx',
  'client/src/pages/NantongBaseHome/campus-animation.ts', 'client/src/pages/NantongBaseHome/motion.ts',
  'client/src/pages/NantongBaseHome/use-motion-environment.ts', 'client/src/components/NantongAssistant.tsx',
  'client/src/components/PanoramaAssistantLogo.tsx', 'client/src/components/nantong-assistant.css',
  'client/src/index.css', 'client/src/tailwind-theme.css', 'client/src/typography.css',
  'test/visual/nantong-portal-images.cjs', 'test/visual/portal-images-fixture/entry.tsx',
  'test/visual/portal-images-fixture/api-stub.ts', 'test/visual/portal-images-fixture/explorer-stub.tsx',
  'server/common/static-asset-cache.ts', 'package-lock.json', 'postcss.config.js', 'tailwind.config.ts',
];
const fingerprint = () => Object.fromEntries(owned.map(file => [file, hash(path.join(root, file))]));
function sourceSnapshot() {
  const files = {};
  function walk(folder) {
    for(const entry of fs.readdirSync(folder,{withFileTypes:true})) {
      const file=path.join(folder,entry.name);
      if(entry.isDirectory())walk(file);
      else if(/\.(?:ts|tsx|css|json)$/.test(entry.name))files[file]=hash(file);
    }
  }
  walk(path.join(root,'client/src'));walk(path.join(root,'shared'));
  return files;
}
const sourceBefore=sourceSnapshot();
const resourceDirectory=path.join(root,'client/public/portal/vnet-photo-20261012');
const resourceSnapshot=()=>Object.fromEntries(fs.readdirSync(resourceDirectory).map(name=>[name,hash(path.join(resourceDirectory,name))]));
function toolInfo(name) {
  const entry=require.resolve(name);let directory=path.dirname(entry);
  while(directory!==path.dirname(directory)) {
    const packageFile=path.join(directory,'package.json');
    if(fs.existsSync(packageFile)) {
      const metadata=JSON.parse(fs.readFileSync(packageFile,'utf8'));
      if(metadata.name===name)return {version:metadata.version,sha256:hash(entry),packageSha256:hash(packageFile)};
    }
    directory=path.dirname(directory);
  }
  throw new Error('Package identity missing: '+name);
}
const proof = { startedAt: new Date().toISOString(), node: process.version, nodeSha256: hash(process.execPath), before: fingerprint(), resourcesBefore:resourceSnapshot(), tools:Object.fromEntries(['@rspack/core','react','react-dom','playwright-core','typescript','postcss-loader','css-loader','style-loader','postcss-import','@tailwindcss/postcss','autoprefixer'].map(name=>[name,toolInfo(name)])), cssResolverSha256:hash(require.resolve('postcss-import/lib/resolve-id')), passed: false };
let server, browser;

async function compile() {
  const start = performance.now();
  const config = {
    mode: 'production', context: root, entry: path.join(fixture, 'entry.tsx'),
    output: {path: site, filename: 'main.js', chunkFilename: '[name].[contenthash:8].js'},
    resolve: {extensions:['.tsx','.ts','.jsx','.js','.json'], alias:{'@/api$':path.join(fixture,'api-stub.ts'),'@':path.join(root,'client/src'),'@shared':path.join(root,'shared')}},
    module:{rules:[
      {test:/\.tsx?$/,exclude:/node_modules/,use:[{loader:'builtin:swc-loader',options:{jsc:{parser:{syntax:'typescript',tsx:true},transform:{react:{runtime:'automatic'}},target:'es2020'}}}]},
      {test:/\.css$/,use:['style-loader','css-loader',{loader:'postcss-loader',options:{postcssOptions:{config:false,plugins:[
        ['postcss-import',{resolve:(id,basedir,options,node)=>{
          if(id==='@/inspector.dev.css')return [];
          return require('postcss-import/lib/resolve-id')(id,basedir,options,node);
        }}],['@tailwindcss/postcss',{}],['autoprefixer',{}],
      ]}}}]},
      {test:/\.(woff2?|ttf|png|jpg|svg|webp)$/,type:'asset/resource'},
    ]},
    plugins:[new DefinePlugin({'process.env.CLIENT_BASE_PATH':JSON.stringify('')}),new NormalModuleReplacementPlugin(/\.\/AppExplorer$/,path.join(fixture,'explorer-stub.tsx'))],
    performance:{hints:false}, devtool:false,
  };
  await new Promise((resolve,reject) => {
    const compiler = rspack(config);
    compiler.run((error,stats)=>compiler.close(()=>{
      if(error)return reject(error);
      fs.writeFileSync(path.join(out,'component-build.log'),stats.toString({all:false,errors:true,warnings:true,timings:true}));
      if(stats.hasErrors())return reject(new Error('Component compilation failed; see component-build.log'));
      const moduleJson=stats.toJson({all:false,modules:true,nestedModules:true});
      const closure={};
      const visit=modules=>{for(const module of modules||[]){const file=(module.identifier||'').split('!').pop().split('|').pop();if(sourceBefore[file]){assert.equal(hash(file),sourceBefore[file],'Source drift during compile: '+file);closure[path.relative(root,file)]=sourceBefore[file];}visit(module.modules);}};
      visit(moduleJson.modules);proof.compiledClosure=closure;
      resolve();
    }));
  });
  proof.compileMs=Math.round(performance.now()-start);
  fs.writeFileSync(path.join(site,'index.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="root"></div><script src="/main.js"></script></body></html>');
}

async function serve() {
  const {staticAssetCacheControl}=require('typescript').transpileModule ? (()=>{
    const code=require('typescript').transpileModule(fs.readFileSync(path.join(root,'server/common/static-asset-cache.ts'),'utf8'),{compilerOptions:{module:require('typescript').ModuleKind.CommonJS}}).outputText;
    const exports={}; new Function('exports',code)(exports); return exports;
  })():{};
  server=http.createServer((req,res)=>{
    const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=name.startsWith('/portal/')?path.join(root,'client/public',name):path.join(site,name==='/'?'index.html':name);
    const allowed= file.startsWith(site+path.sep)||file.startsWith(path.join(root,'client/public/portal')+path.sep);
    if(!allowed||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end();return;}
    const contentType={'.js':'text/javascript','.css':'text/css','.webp':'image/webp','.jpg':'image/jpeg','.png':'image/png','.html':'text/html'}[path.extname(file)]||'application/octet-stream';
    res.writeHead(200,{'Content-Type':contentType,'Cache-Control':staticAssetCacheControl(file)});fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
}

async function verify() {
  browser=await chromium.launch({channel:'msedge',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const page=await context.newPage();
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.locator('.photo-systems').scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('.system-photo')?.dataset.imageState==='ready');
  const initial=await page.locator('.system-photo').evaluate(img=>({src:img.currentSrc,width:img.naturalWidth}));
  assert(initial.src.endsWith('.webp'));
  const thumbSrcs=await page.locator('.system-photo-thumbnails img').evaluateAll(images=>images.map(img=>img.src));
  assert(thumbSrcs.every(src=>src.includes('-thumbnail.')));
  await page.getByRole('tab',{name:'弱电系统 INTELLIGENCE'}).click();
  await page.locator('.system-device-list button').filter({hasText:'交换机'}).click();
  await page.waitForFunction(()=>document.querySelector('.system-photo')?.dataset.imageState==='ready');
  await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('.system-photo')).opacity)>=0.99);
  await page.locator('.system-photo-frame').screenshot({path:path.join(out,'desktop-switch.png')});
  const deviceButtons=page.locator('.system-device-list button');
  for(let i=0;i<4;i++)await deviceButtons.nth(i).click();
  assert.equal(await page.locator('#portal-system-panel').getAttribute('data-device'),'阀控柜');
  await page.waitForFunction(()=>document.querySelector('.system-photo')?.dataset.imageState==='ready');
  assert.equal(await page.locator('.system-photo').getAttribute('alt'),'阀控柜');
  await page.getByRole('button',{name:'打开全景小帮手',exact:true}).click();
  await page.getByRole('region',{name:'全景小帮手对话'}).waitFor();
  assert.equal(await page.locator('.nantong-assistant-avatar img').evaluate(img=>img.naturalWidth),128);
  await page.screenshot({path:path.join(out,'desktop-assistant.png')});
  await page.getByRole('button',{name:'隐藏小帮手',exact:true}).click();
  await page.getByRole('button',{name:'显示全景小帮手'}).click();
  await page.getByRole('button',{name:'打开全景小帮手',exact:true}).waitFor();
  await context.close();

  const mobile=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,serviceWorkers:'block'});
  const phone=await mobile.newPage();
  await phone.goto(`http://127.0.0.1:${port}/`);
  await phone.locator('.photo-systems').scrollIntoViewIfNeeded();
  await phone.waitForFunction(()=>document.querySelector('.system-photo')?.dataset.imageState==='ready');
  const mobileSource=await phone.locator('.system-photo').evaluate(img=>({src:img.currentSrc,width:img.naturalWidth}));
  assert(mobileSource.src.includes('-mobile.'));assert(mobileSource.width<=768);
  assert(await phone.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await phone.getByRole('button',{name:'打开全景小帮手',exact:true}).click();
  const rect=await phone.locator('.nantong-assistant-panel').boundingBox();
  assert(rect.x>=0&&rect.x+rect.width<=390);
  await phone.screenshot({path:path.join(out,'mobile-assistant.png')});
  await mobile.close();

  const failure=await browser.newContext();const probe=await failure.newPage();
  let rejectImage=true;
  const sample=path.join(root,'client/public/portal/vnet-photo-20261012',require(path.join(root,'client/public/portal/vnet-photo-20261012/manifest.json'))['ali-hvdc.jpg'].mobile.file);
  await probe.route('**/probe.webp',route=>rejectImage?route.abort():route.fulfill({contentType:'image/webp',body:fs.readFileSync(sample)}));
  await probe.goto(`http://127.0.0.1:${port}/?request-test=1`);
  await probe.locator('.portal-image-error').waitFor({timeout:5000});
  proof.failureProbe={state:await probe.locator('img').getAttribute('data-image-state'),text:await probe.locator('.portal-image-error').innerText()};
  assert(proof.failureProbe.text.includes('图片加载失败'));rejectImage=false;
  await probe.getByRole('button',{name:'重新加载'}).click();
  await probe.waitForFunction(()=>document.querySelector('img')?.dataset.imageState==='ready');
  assert.equal(await probe.locator('.portal-image-error').count(),0);
  await failure.close();

  const timeoutContext=await browser.newContext();const timeoutPage=await timeoutContext.newPage();
  await timeoutPage.clock.install();
  let release;const held=new Promise(resolve=>release=resolve);
  await timeoutPage.route('**/probe.webp',async route=>{await held;try{await route.abort();}catch{}});
  await timeoutPage.goto(`http://127.0.0.1:${port}/?request-test=1`,{waitUntil:'domcontentloaded'});
  await timeoutPage.locator('img').waitFor({state:'attached'});
  await timeoutPage.clock.runFor(100);await timeoutPage.clock.fastForward(16000);
  await timeoutPage.locator('.portal-image-error').waitFor();
  assert((await timeoutPage.locator('.portal-image-error').innerText()).includes('图片加载超时'));
  release();await timeoutContext.close();
  const staleContext=await browser.newContext();const stalePage=await staleContext.newPage();
  let releaseOld;const oldHeld=new Promise(resolve=>releaseOld=resolve);
  await stalePage.route('**/probe.webp',async route=>{await oldHeld;try{await route.fulfill({contentType:'image/webp',body:fs.readFileSync(sample)});}catch{}});
  await stalePage.route('**/probe-new.webp',route=>route.fulfill({contentType:'image/webp',body:fs.readFileSync(sample)}));
  await stalePage.goto(`http://127.0.0.1:${port}/?request-test=1`,{waitUntil:'domcontentloaded'});
  await stalePage.getByRole('button',{name:'切换新图'}).click();
  await stalePage.waitForFunction(()=>document.querySelector('img')?.dataset.imageState==='ready');
  releaseOld();
  await stalePage.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert((await stalePage.locator('img').getAttribute('src')).endsWith('/probe-new.webp'));
  assert.equal(await stalePage.locator('img').getAttribute('data-image-state'),'ready');
  await staleContext.close();
  assert.deepEqual(errors,[]);
  proof.desktop=initial;proof.mobile=mobileSource;proof.scenarios=['desktop display','small thumbnails','rapid switching','assistant open/hide/reveal','390px responsive image and layout','failure/retry','15s timeout','old image response after source switch'];
  const limited=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  const limitedPage=await limited.newPage();
  const cdp=await limited.newCDPSession(limitedPage);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:200000,uploadThroughput:100000});
  await limitedPage.goto(`http://127.0.0.1:${port}/`,{waitUntil:'domcontentloaded'});
  const scrollStart=performance.now();await limitedPage.locator('.photo-systems').scrollIntoViewIfNeeded();
  await limitedPage.waitForFunction(()=>document.querySelector('.system-photo')?.dataset.imageState==='ready');
  proof.limitedNetwork={latencyMs:150,downloadBytesPerSecond:200000,initialVisibleReadyMs:Math.round(performance.now()-scrollStart)};
  assert(proof.limitedNetwork.initialVisibleReadyMs<6000);
  const feedback=[];
  for(let i=0;i<20;i++) {
    const device=i%7;
    const result=await limitedPage.evaluate(index=>new Promise(resolve=>{
      const button=document.querySelectorAll('.system-device-list button')[index];
      const expected=button.textContent.trim().replace(/^\d+\s*/, '');
      const start=performance.now();button.click();
      requestAnimationFrame(()=>resolve({elapsed:performance.now()-start,device:document.querySelector('#portal-system-panel').dataset.device,expected}));
    }),device);
    assert.equal(result.device,result.expected);feedback.push(result.elapsed);
  }
  feedback.sort((a,b)=>a-b);proof.limitedNetwork.switchFeedbackP95Ms=feedback[Math.ceil(feedback.length*0.95)-1];
  proof.limitedNetwork.feedbackDefinition='Native button.click event dispatch to next requestAnimationFrame showing the new device label; proxy for input-to-paint, excludes physical input delivery';
  assert(proof.limitedNetwork.switchFeedbackP95Ms<=100);
  await limited.close();proof.scenarios.push('1.6Mbps/150ms network and P95 switching feedback');
  const headers=await fetch(`http://127.0.0.1:${port}/portal/vnet-photo-20261012/panorama-assistant.51a26c035165.webp`);
  assert.equal(headers.headers.get('cache-control'),'public, max-age=31536000, immutable');
}

(async()=>{
  try{
    if(process.argv.includes('--reuse-component')) {
      const previousFile=path.join(out,'browser-proof-browser-assert-failed.json');
      const previous=JSON.parse(fs.readFileSync(previousFile,'utf8'));
      assert(previous.compileMs>0,'No successful component compilation to reuse');
      for(const [file,digest] of Object.entries(previous.before))if(file!=='test/visual/nantong-portal-images.cjs')assert.equal(hash(path.join(root,file)),digest,'Original build input changed: '+file);
      assert.deepEqual(resourceSnapshot(),previous.resourcesBefore);
      proof.compiledClosure=previous.compiledClosure;
      proof.reusedCompilation={proofFile:previousFile,proofSha256:hash(previousFile),compileMs:previous.compileMs,limitation:'Original stats extraction captured only 3 module files; remaining listed build inputs are validated via the original before fingerprint. Full app type/build validation remains pending.'};
      proof.siteBefore=Object.fromEntries(fs.readdirSync(site).map(name=>[name,hash(path.join(site,name))]));
    } else await compile();
    await serve();await verify();proof.after=fingerprint();proof.resourcesAfter=resourceSnapshot();assert.deepEqual(proof.after,proof.before);assert.deepEqual(proof.resourcesAfter,proof.resourcesBefore);for(const [name,digest] of Object.entries(proof.compiledClosure))assert.equal(hash(path.join(root,name)),digest,'Compiled source drift: '+name);
    if(proof.siteBefore)assert.deepEqual(Object.fromEntries(fs.readdirSync(site).map(name=>[name,hash(path.join(site,name))])),proof.siteBefore);
    proof.passed=true;
  }
  catch(error){proof.error=error.stack;process.exitCode=1;}
  finally{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));proof.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(out,'browser-proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({passed:proof.passed,compileMs:proof.compileMs,error:proof.error,scenarios:proof.scenarios}));}
})();
