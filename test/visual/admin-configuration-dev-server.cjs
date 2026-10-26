const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { rspack } = require('@rspack/core');
const root = path.resolve(__dirname, '../..');
const fixture = path.join(root, 'test/fixtures/admin-configuration-browser');
const performanceMode = process.argv.includes('--performance');
const output = path.join(root, `output/admin-configuration-check/${performanceMode ? 'browser-production' : 'browser'}`);
fs.mkdirSync(output,{recursive:true});
const configurationFile = process.argv[2];
if (!configurationFile || !path.isAbsolute(configurationFile) || /[^\x20-\x7e]/.test(configurationFile) || fs.existsSync(configurationFile)) throw new Error('Provide a new absolute ASCII configuration path');
const mocks = path.join(root, 'test/fixtures/feishu-login-browser/api.ts');
function inputFingerprint() {
  const files=[];
  const walk=folder=>{for(const entry of fs.readdirSync(folder,{withFileTypes:true})){const file=path.join(folder,entry.name);if(entry.isDirectory())walk(file);else if(/\.(?:ts|tsx|css|svg|json)$/.test(file))files.push(file);}};
  for(const folder of ['client/src','shared','test/fixtures/admin-configuration-browser','test/fixtures/feishu-login-browser'])walk(path.join(root,folder));
  for(const file of ['test/visual/admin-configuration-dev-server.cjs','package.json','package-lock.json','tailwind.config.ts','postcss.config.js','node_modules/@rspack/core/package.json','node_modules/@rspack/core/dist/index.js'])files.push(path.join(root,file));
  const inputs=files.sort().map(file=>({path:path.relative(root,file).replace(/\\/g,'/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}));
  return {inputs,sha256:crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex')};
}
const compileInput=inputFingerprint();
const compiler = rspack({ context: root, mode: performanceMode ? 'production' : 'development', devtool: false, target: 'web', entry: path.join(fixture, 'entry.tsx'),
  output: { path: output, filename: 'app.js', cssFilename: 'app.css', publicPath: '/' },
  resolve: { extensions: ['.tsx','.ts','.js'], alias: { '@/api$': mocks, '@': path.join(root,'client/src'), '@shared': path.join(root,'shared'),
    '@lark-apaas/client-toolkit/logger$': mocks, '@lark-apaas/client-toolkit/utils/getAxiosForBackend$': mocks, '@lark-apaas/client-toolkit/hooks/useCurrentUserProfile$': mocks, '@lark-apaas/client-toolkit/dataloom$': mocks } },
  module: { rules: [{ test: /\.svg$/, type: 'asset/inline' }, { test: /\.[jt]sx?$/, exclude: /node_modules/, use: { loader: 'builtin:swc-loader', options: { jsc: { parser: { syntax:'typescript', tsx:true }, transform: { react: { runtime:'automatic' } }, target:'es2022' } } } },
    { test:/\.css$/, type:'css/auto', use:{ loader:'postcss-loader', options:{ postcssOptions:{ plugins:{ '@tailwindcss/postcss':{} } } } } }] },
  experiments:{ css:true }, plugins:[new (require('@rspack/core').DefinePlugin)({ 'process.env.CLIENT_BASE_PATH':JSON.stringify('') })] });
if (process.argv.includes('--reuse-client') && fs.existsSync(path.join(output, 'app.js'))) compiler.close(() => start().catch(error => { console.error(error.message); process.exitCode=1; }));
else compiler.run((error, stats) => {
  if (error || stats.hasErrors()) { console.error(error?.message || stats.toString({ all:false,errors:true })); process.exitCode=1; return compiler.close(()=>{}); }
  if(compileInput.sha256!==inputFingerprint().sha256){console.error('Frontend changed during development compile; result invalid');process.exitCode=1;return compiler.close(()=>{});}
  fs.writeFileSync(path.join(output,performanceMode?'production-fixture-compile-evidence.json':'development-compile-evidence.json'),JSON.stringify({...compileInput,mode:performanceMode?'production':'development',node:process.execPath,nodeSha256:crypto.createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),appSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(output,'app.js'))).digest('hex'),cssSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(output,'app.css'))).digest('hex')},null,2));
  compiler.close(() => start().catch(error => { console.error(error.message); process.exitCode=1; }));
});
async function start() {
  require('reflect-metadata');
  require('ts-node').register({ transpileOnly:true, compilerOptions:{ module:'commonjs',moduleResolution:'node',experimentalDecorators:true,emitDecoratorMetadata:true,esModuleInterop:true } });
  require('tsconfig-paths').register({ baseUrl: root, paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
  for (const key of Object.keys(process.env)) if (/^(LOCAL_.*(?:PASSWORD_HASH|SESSION_SECRET)|FEISHU_ACCESS_)/.test(key)) delete process.env[key];
  const { hashAccessPassword, UnifiedAccessService } = require('../../server/common/access/unified-access.service');
  const { AccessConfigurationService } = require('../../server/common/access/access-configuration.service');
  const { AccessConfigurationDirectory } = require('../../server/common/access/access-configuration.directory');
  const { AccessConfigurationCardDirectory } = require('../../server/common/access/access-configuration.card-directory');
  const { UnifiedAccessModule } = require('../../server/common/access/unified-access.module');
  process.env.ACCESS_CONFIGURATION_FILE=configurationFile;
  process.env.LOCAL_ACCESS_SESSION_SECRET=crypto.randomBytes(32).toString('base64');
  process.env.LOCAL_ADMIN_PASSWORD_HASH=hashAccessPassword('fixture-admin-only-123');
  process.env.LOCAL_EDITOR_PASSWORD_HASH=hashAccessPassword('fixture-editor-only-123');
  process.env.LOCAL_ACCESS_COOKIE_SECURE='false';
  process.env.LOCAL_ACCESS_CONTROL_ENABLED='true';
  process.env.PUBLIC_BASE_URL='http://127.0.0.1:43212';
  process.env.FEISHU_APP_ID='cli_configuration_fixture';
  process.env.FEISHU_APP_SECRET='fixture-only-non-network';
  process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED='false';
  process.env.FEISHU_ACCESS_ADMIN_OPEN_IDS='ou_fixture_admin';
  const extra = process.argv.includes('--large') ? Array.from({length:3000},(_,index)=>({openId:`ou_fixture_large_${index}`,name:`合成人员${String(index).padStart(4,'0')}`})) : [];
  process.env.FEISHU_ACCESS_EDITOR_OPEN_IDS=extra.map(person=>person.openId).join(',');
  const people=[{openId:'ou_fixture_admin',name:'配置验收管理员'},{openId:'ou_fixture_person_a',name:'合成示例人员003'},{openId:'ou_fixture_person_b',name:'合成人员乙'},...extra];
  const directory={ read:async()=>({ appId:process.env.FEISHU_APP_ID,people,snapshotAt:Date.now() }), assertKnown:async(ids)=>{ if(ids.some(id=>!people.some(person=>person.openId===id))) throw new (require('@nestjs/common').BadRequestException)('所选身份未在隔离目录中匹配'); } };
  const module=await require('@nestjs/testing').Test.createTestingModule({imports:[UnifiedAccessModule]}).overrideProvider(AccessConfigurationDirectory).useValue(directory)
    .overrideProvider(AccessConfigurationCardDirectory).useValue({read:async()=>({members:[people[0]]})}).compile();
  const app=module.createNestApplication({logger:false});
  const express=app.getHttpAdapter().getInstance();
  express.get('/fixture/login',(_req,res)=>{
    const access=app.get(UnifiedAccessService), config=app.get(AccessConfigurationService);
    const principal=config.feishuPrincipal('ou_fixture_admin',process.env.FEISHU_APP_ID);
    const session=access.issueTrustedSession({...principal,displayName:'配置验收管理员'});
    res.cookie(access.cookieName,session.token,{httpOnly:true,sameSite:'lax'}); res.redirect('/system-configuration');
  });
  express.get('/fixture/logout',(_req,res)=>{res.clearCookie(app.get(UnifiedAccessService).cookieName);res.redirect('/system-configuration');});
  express.use(require('express').static(output));
  express.use(require('express').static(path.join(root,'client/public')));
  express.use((req,res,next)=>req.path.startsWith('/api/') ? next() : res.type('html').send(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body data-fixture-runtime="${performanceMode?'production':'development'}"><div id="root"></div><script src="/app.js"></script></body></html>`));
  await app.listen(43212,'127.0.0.1');
  console.log(JSON.stringify({status:'ADMIN_CONFIGURATION_FIXTURE_READY',pid:process.pid,appRoot:root,configurationFile,url:'http://127.0.0.1:43212/fixture/login',initialRevision:0,externalCalls:0}));
  process.on('SIGINT',()=>app.close().then(()=>process.exit(0)));
}
