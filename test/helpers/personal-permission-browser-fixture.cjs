const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const root = fs.realpathSync(os.tmpdir()), temporary = fs.mkdtempSync(path.join(root, 'nt-permission-browser-'));
process.env.ACCESS_CONFIGURATION_FILE = path.join(temporary, 'configuration.json');
process.env.FEISHU_APP_ID = 'cli_permission_browser_synthetic'; process.env.FEISHU_ACCESS_APPROVED_GRANTS_ENABLED = 'false';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:43223';
process.env.LOCAL_ACCESS_SESSION_SECRET = crypto.randomBytes(32).toString('base64');
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'node', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } });
require('tsconfig-paths').register({ baseUrl: path.resolve(__dirname, '../..'), paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
const { UnifiedAccessService, hashAccessPassword } = require('../../server/common/access/unified-access.service');
process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword(crypto.randomBytes(32).toString('hex'));
const { AccessConfigurationService } = require('../../server/common/access/access-configuration.service');
const { AccessConfigurationController } = require('../../server/common/access/access-configuration.controller');
const { AccessLoginRedactionMiddleware } = require('../../server/common/access/access-login-redaction.middleware');
const configuration = new AccessConfigurationService(), access = new UnifiedAccessService(configuration);
const login = access.issueTrustedSession(configuration.localTargets().find(item => item.principal.role === 'admin').principal), actor = login.principal;
const controller = new AccessConfigurationController(configuration, { assertKnown: async () => {} }, access, {}, {});
const app = require('express')(); app.use(require('express').json());
let failure = false, delay = false, saves = 0, requests = [], server;
app.get('/api/access/configuration', (_req, res) => res.json(configuration.snapshot()));
app.post('/api/access/configuration/accounts', (req, res, next) => new AccessLoginRedactionMiddleware().use(req, res, next));
app.post('/api/access/configuration/accounts', async (req, res) => {
  saves++; requests.push({ id: req.body.clientMutationId, body: req.body });
  try {
    if (failure) { failure = false; return res.status(503).json({ message: '合成验收：保存暂时失败' }); }
    if (delay) { delay = false; await new Promise(resolve => setTimeout(resolve, 1200)); }
    req.headers.cookie = req.headers['x-synthetic-auth'] === 'guest' ? '' : `${access.cookieName}=${login.token}`;
    res.json(await controller.account(req, req.body));
  } catch (error) { res.status(error.getStatus?.() || 500).json({ message: error.message }); }
});
app.get('/qa/failure', (_req, res) => { failure = true; res.json({ ready: true }); });
app.get('/qa/delay', (_req, res) => { delay = true; res.json({ ready: true }); });
app.get('/qa/report', (_req, res) => res.json({ saves, requests, revision: configuration.snapshot().revision }));
app.post('/qa/concurrent', async (_req, res) => {
  try { const account = configuration.snapshot().accounts.find(item => item.openId === 'ou_permission_browser_synthetic');
    await configuration.saveAccount({ clientMutationId: crypto.randomUUID(), expectedRevision: configuration.snapshot().revision, id: account.id, kind: account.kind, name: account.name, role: account.role, building: account.building, buildings: account.buildings, specialties: account.specialties, enabled: account.enabled, external: true }, actor);
    res.json({ changed: true });
  } catch (error) { res.status(500).json({ message: error.message }); }
});
app.use('/api', (_req, res) => res.status(503).json({ message: '隔离验收未配置该模块' }));
const cleanup = () => {
  if (path.resolve(path.dirname(temporary)).toLowerCase() !== path.resolve(root).toLowerCase() || fs.lstatSync(temporary).isSymbolicLink() || fs.realpathSync(temporary) !== temporary) throw new Error('测试目录归属异常，保留现场');
  fs.rmSync(temporary, { recursive: true, force: false });
};
(async () => {
  await configuration.saveAccount({ clientMutationId: 'synthetic-browser-initialize', expectedRevision: 0, kind: 'feishu', openId: 'ou_permission_browser_synthetic', name: '合成权限人员', role: 'professional_engineer', building: 'A楼', buildings: ['A楼'], specialties: ['电气'], enabled: true, external: true }, actor);
  server = app.listen(43224, '127.0.0.1', () => console.log('personal permission fixture ready 43224; synthetic local data only'));
})().catch(error => { console.error(error.message); cleanup(); process.exitCode = 1; });
const stop = () => server?.close(() => { cleanup(); process.exit(0); });
process.once('SIGINT', stop); process.once('SIGTERM', stop);
app.post('/qa/stop', (_req, res) => { res.json({ stopped: true }); stop(); });
