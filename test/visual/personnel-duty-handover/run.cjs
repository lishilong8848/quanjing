const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{rspack}=require('@rspack/core'),{chromium}=require('playwright-core');
const runName=process.argv[2];if(!/^[a-z0-9-]+$/.test(runName||''))throw Error('Unique run name required');
const root=path.resolve(__dirname,'../../..'),output=path.join(root,'output/personnel-stage-three-full-20261015',runName),started=Date.now();
if(fs.existsSync(output))throw Error('Browser evidence exists');
fs.mkdirSync(output,{recursive:true});
const proof={startedAt:new Date().toISOString(),passed:false,checks:[],errors:[],externalRequests:[],previewRequests:0,confirmRequests:0};
const compiler=rspack({context:root,mode:'development',devtool:false,target:'web',entry:path.join(__dirname,'entry.tsx'),output:{path:output,filename:'app.js',cssFilename:'app.css',publicPath:'/'},resolve:{extensions:['.tsx','.ts','.js'],alias:{'@':path.join(root,'client/src'),'@shared':path.join(root,'shared'),'@lark-apaas/client-toolkit/utils/getAxiosForBackend$':path.join(__dirname,'axios.ts')}},module:{rules:[{test:/\.[jt]sx?$/,exclude:/node_modules/,use:{loader:'builtin:swc-loader',options:{jsc:{parser:{syntax:'typescript',tsx:true},transform:{react:{runtime:'automatic'}},target:'es2022'}}}},{test:/\.css$/,type:'css/auto',use:{loader:'postcss-loader',options:{postcssOptions:{plugins:{'@tailwindcss/postcss':{}}}}}}]},experiments:{css:true}});
let server,browser,batch,firstPreview=true;
let inputs=[],before=[];const capture=()=>inputs.map(file=>({path:file,sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
async function main(){
  await new Promise((resolve,reject)=>compiler.run((error,stats)=>{if(!error&&!stats.hasErrors()){inputs=[...stats.compilation.fileDependencies].filter(file=>file.startsWith(root+path.sep)&&!file.includes(path.sep+'node_modules'+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile());inputs.push(__filename,process.execPath,path.join(root,'package-lock.json'),path.join(__dirname,'../fixture-tailwind.config.ts'));inputs=[...new Set(inputs)].sort();before=capture();}compiler.close(()=>error||stats.hasErrors()?reject(error||Error(stats.toString({all:false,errors:true}))):resolve());}));
  require('ts-node').register({transpileOnly:true,compilerOptions:{module:'CommonJS',moduleResolution:'node'}});
  const {preview}=require('./fixture.ts');
  server=http.createServer(async(req,res)=>{
    try{
      if(req.url==='/api/access/configuration/personnel-handover/recovery'){res.writeHead(200,{'Content-Type':'application/json'});return res.end('[]');}
      if(req.url.startsWith('/api/access/configuration/personnel-handover')){
        let body='';for await(const part of req)body+=part;const data=body?JSON.parse(body):{};
        let value=[];
        if(req.url.endsWith('/preview')){proof.previewRequests++;await new Promise(resolve=>setTimeout(resolve,350));if(firstPreview){firstPreview=false;res.writeHead(503,{'Content-Type':'application/json'});return res.end(JSON.stringify({message:'合成人员资料读取失败，请重试'}));}value=preview(data);}
        else if(req.url.endsWith('/confirm')){proof.confirmRequests++;assert(data.request.ownership?.length===2);assert(data.request.ownership.every(row=>row.grants.length===2));const p=preview(data.request);assert(!p.conflicts.length);batch={id:'synthetic-batch',clientMutationId:data.clientMutationId,status:'accepted',permissionStatus:'success',acceptedAt:new Date().toISOString(),version:1,preview:p,items:p.pending.map(item=>({item,status:'accepted'}))};value=batch;await new Promise(resolve=>setTimeout(resolve,500));}
        else if(req.url.endsWith('/progress')){batch={...batch,status:'success',version:2,items:batch.items.map(item=>({...item,status:'success'}))};value=batch;}
        else value=batch?[batch]:[];
        res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify(value));
      }
      if(req.url==='/'||req.url.startsWith('/?')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><body><div id="root"></div><script src="/app.js"></script></body></html>');}
      const file=req.url==='/app.js'?'app.js':req.url==='/app.css'?'app.css':null;if(!file){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':'text/javascript'});fs.createReadStream(path.join(output,file)).pipe(res);
    }catch(error){res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({message:error.message}));proof.errors.push(error.message);}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1050}});
  page.on('pageerror',error=>proof.errors.push(error.message));
  await page.route('**/*',route=>{const url=route.request().url();if(!url.startsWith(origin)){proof.externalRequests.push(url);return route.abort();}return route.continue();});
  await page.goto(origin);await page.getByRole('heading',{name:'岗位交接 · 隔离验收'}).waitFor();
  async function choose(label,name){await page.getByRole('combobox',{name:label,exact:true}).click();await page.getByRole('option').filter({hasText:name}).click();}
  await choose('前任人员','合成前任');await choose('接任人员','合成接任');await page.getByRole('button',{name:'选择全部可交接职责',exact:true}).click();
  const review=page.getByRole('button',{name:'核对交接清单',exact:true});await review.click();await page.getByText('合成人员资料读取失败，请重试',{exact:true}).waitFor();
  assert((await page.getByRole('combobox',{name:'前任人员'}).textContent()).includes('合成前任'));await review.click();await page.getByRole('heading',{name:'确认权限归属',exact:true}).waitFor();
  assert.equal(await page.getByLabel('权限1归属',{exact:true}).count(),1);await page.getByLabel('权限1归属',{exact:true}).selectOption('transfer');await page.getByLabel('权限2归属',{exact:true}).selectOption('retain');
  await page.getByText('归属选择已修改，请重新核对交接清单。',{exact:true}).waitFor();assert(await page.getByRole('button',{name:'确认交接',exact:true}).isDisabled());await review.click();
  await page.getByRole('heading',{name:'确认权限归属',exact:true}).waitFor();await page.waitForFunction(()=>!document.body.innerText.includes('归属选择已修改'));
  await page.evaluate(()=>{window.__samples=[];document.addEventListener('click',event=>{const button=event.target.closest('button');if(button?.textContent.trim()!=='核对交接清单')return;const started=performance.now(),phase=window.__phase;const observer=new MutationObserver(()=>{if(!button.disabled||!button.textContent.includes('正在核对'))return;observer.disconnect();window.__samples.push({phase,ms:performance.now()-started});});observer.observe(button,{subtree:true,childList:true,attributes:true});},true);});
  async function sample(phase,count){await page.evaluate(value=>window.__phase=value,phase);for(let index=0;index<count;index++){await review.click();await page.getByRole('button',{name:'正在核对…',exact:true}).waitFor();await review.waitFor();}}
  await sample('desktop-warm',3);await sample('desktop',20);await page.setViewportSize({width:390,height:844});await sample('mobile-warm',3);await sample('mobile',10);await page.setViewportSize({width:1440,height:1050});
  proof.samples=await page.evaluate(()=>window.__samples);proof.performance={};for(const phase of ['desktop','mobile']){const values=proof.samples.filter(row=>row.phase===phase).map(row=>row.ms),sorted=[...values].sort((a,b)=>a-b);assert.equal(values.length,phase==='desktop'?20:10);const p95=sorted[Math.ceil(sorted.length*.95)-1];assert(p95<=100);proof.performance[phase]={p95,max:Math.max(...values),values};}
  assert.equal(await page.locator('li').filter({hasText:'合成待办'}).count(),0);await page.getByRole('button',{name:'查看请休假明细',exact:true}).click();assert.equal(await page.locator('li').filter({hasText:'合成待办'}).count(),100);await page.getByRole('button',{name:/显示更多/}).click();assert.equal(await page.locator('li').filter({hasText:'合成待办'}).count(),200);await page.getByRole('button',{name:'收起请休假明细',exact:true}).click();
  assert(await page.getByRole('button',{name:'确认交接',exact:true}).isDisabled());await page.getByRole('checkbox',{name:/已核对权限及汇总清单/}).check();
  await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
  const submit=page.getByRole('button',{name:'确认交接',exact:true});await submit.click();await page.getByRole('button',{name:'正在提交…',exact:true}).waitFor();assert(await page.getByRole('button',{name:'正在提交…',exact:true}).isDisabled());await page.getByText('权限继承：已完成',{exact:true}).waitFor();assert.equal(proof.confirmRequests,1);
  await page.getByRole('button',{name:'核对进度',exact:true}).click();await page.getByText('已完成',{exact:true}).first().waitFor();proof.checks.push('失败保留人员/一次选择同步两种身份/过期预览不可提交/1000项折叠分页/一次确认/持久进度');
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(output,'mobile-progress.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  await page.getByRole('button',{name:'新建交接',exact:true}).click();await choose('前任人员','合成前任');await choose('接任人员','合成接任');await page.getByRole('button',{name:'选择全部可交接职责',exact:true}).click();await review.click();await page.getByRole('heading',{name:'确认权限归属',exact:true}).waitFor();await page.screenshot({path:path.join(output,'mobile-ownership.png'),fullPage:true});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth));
  proof.checks.push('390像素归属表单和完成状态无横向溢出');assert.deepEqual(proof.errors,[]);assert(proof.externalRequests.every(url=>url.startsWith('https://fonts.googleapis.com/css2?family=Inter:')));proof.checks.push('现有在线字体已拦截，业务请求仅访问隔离本机服务');assert.deepEqual(before,capture());proof.passed=true;
}
main().catch(error=>{proof.errors.push(error.stack);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server)await new Promise(resolve=>server.close(resolve));proof.sourceBefore=before;proof.sourceAfter=capture();proof.elapsedMs=Date.now()-started;proof.completedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'proof.json'),JSON.stringify(proof,null,2));console.log(JSON.stringify({...proof,sourceBefore:undefined,sourceAfter:undefined,inputs:inputs.length}));});
