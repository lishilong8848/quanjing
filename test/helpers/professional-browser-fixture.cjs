const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-professional-fixture-'));
process.env.ACCESS_CONFIGURATION_FILE = path.join(temporary, 'configuration.json');
process.env.FEISHU_LOCAL_CACHE_DIR = temporary;
process.env.FEISHU_APP_ID = 'cli_0831564613853b26'; process.env.FEISHU_APP_SECRET = 'synthetic-fixture-only';
process.env.PUBLIC_BASE_URL = 'http://127.0.0.1:43213';
process.env.LOCAL_ACCESS_SESSION_SECRET = crypto.randomBytes(32).toString('base64');
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'node', esModuleInterop: true, experimentalDecorators: true, emitDecoratorMetadata: true } });
require('tsconfig-paths').register({ baseUrl: path.resolve(__dirname, '../..'), paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
const { UnifiedAccessService, hashAccessPassword } = require('../../server/common/access/unified-access.service');
process.env.LOCAL_ADMIN_PASSWORD_HASH = hashAccessPassword(crypto.randomBytes(32).toString('hex'));
const { AccessConfigurationService } = require('../../server/common/access/access-configuration.service');
const { AccessPersonnelSyncService } = require('../../server/common/access/access-personnel-sync.service');
const { AccessConfigurationController } = require('../../server/common/access/access-configuration.controller');
const { UnifiedAccessController } = require('../../server/common/access/unified-access.controller');
const { UnifiedAccessGuard } = require('../../server/common/access/unified-access.guard');
const { Reflector } = require('@nestjs/core');
const { PROFESSIONAL_DEFAULTS } = require('../../server/common/access/access-professional-defaults');
const bitable = require('../../server/common/feishu/bitable-direct-read');
const records = ['暖通', '电气', '未维护'].map((specialty, index) => ({ record_id: `recFixture${index}`, fields: { 机楼: 'A楼', 设备编号: `QA${index}`, 设备名称: ['验收暖通设备', '验收电气设备', '验收未维护设备'][index], 系统名称: specialty, 大设备类型: '冷却塔', 数量: 1, 维保截止日期: '2099-01-01' } }));
bitable.fetchBitableRecords = async () => records; bitable.resolveBitableAppToken = async () => 'fixture'; bitable.readLatestPersistedBitableRecordSnapshot = async () => null;
const { EquipmentLedgerService } = require('../../server/modules/equipment-lifecycle/equipment-ledger.service');
const { EquipmentLedgerController } = require('../../server/modules/equipment-lifecycle/equipment-ledger.controller');
const configuration = new AccessConfigurationService(), access = new UnifiedAccessService(configuration);
const actor = configuration.localTargets().find(item => item.principal.role === 'admin').principal;
const directory = { read: async () => ({ appId: process.env.FEISHU_APP_ID, personnelComplete: true, snapshotAt: Date.now(), people: PROFESSIONAL_DEFAULTS.map(person => ({ ...person, source: 'employee' })), employees: PROFESSIONAL_DEFAULTS.map(person => ({ ...person, position: '专业示例人员001', specialties: person.specialties.join('、'), inactive: false })) }), assertKnown: async () => {} };
const sync = new AccessPersonnelSyncService(configuration, directory);
const configController = new AccessConfigurationController(configuration, directory, access, {}, sync);
const accessController = new UnifiedAccessController(access, {});
const ledger = new EquipmentLedgerController(new EquipmentLedgerService({}, {}), {});
const guard = new UnifiedAccessGuard(new Reflector(), access);
const app = require('express')(); app.use(require('express').json());
let failSync = false;
app.get('/qa/:actor', (req, res) => {
  if (req.params.actor === 'sync-failure') { failSync = true; return res.redirect('/system-configuration'); }
  const principal = req.params.actor === 'hvac' ? { ...configuration.feishuPrincipal(PROFESSIONAL_DEFAULTS[1].openId, process.env.FEISHU_APP_ID), feishuAppId: process.env.FEISHU_APP_ID } : actor;
  const token = access.issueTrustedSession(principal);
  res.cookie(access.cookieName, token.token, { httpOnly: true, sameSite: 'lax' });
  res.redirect(req.params.actor === 'hvac' ? '/equipment-ledger-management' : '/system-configuration');
});
const route = (method, url, controller, handlerName, operation) => app[method](url, async (req, res) => {
  try {
    if (!guard.canActivate({ getClass: () => controller.constructor, getHandler: () => controller[handlerName], switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) })) return res.status(403).json({ message: '无权访问' });
    const result = await operation(req, res); if (!res.headersSent) res.json(result);
  } catch (error) { res.status(error.getStatus?.() || 500).json({ message: error.message }); }
});
route('get','/api/access/session', accessController, 'session', (req,res) => accessController.session(req,res));
route('get','/api/access/runtime', accessController, 'runtime', (_,res) => accessController.runtime(res));
route('get','/api/access/configuration', configController, 'read', req => configController.read(req));
route('get','/api/access/configuration/people', configController, 'people', req => configController.people(req));
route('post','/api/access/configuration/accounts', configController, 'account', req => configController.account(req,req.body));
route('post','/api/access/configuration/personnel-sync', configController, 'synchronize', req => { if (failSync) { failSync = false; throw new Error('验收模拟：人员表暂时不可用'); } return configController.synchronize(req); });
route('get','/api/equipment-ledger/dashboard', ledger, 'getDashboard', req => ledger.getDashboard(req,req.query.refresh,req.query.async));
route('get','/api/equipment-ledger/items', ledger, 'getItems', req => ledger.getItems(req,req.query));
app.use('/api',(_,res)=>res.status(503).json({ message: '隔离验收未配置该模块' }));
let server;
(async () => { await configuration.onModuleInit(); server = app.listen(43214, '127.0.0.1', () => console.log('professional fixture ready on 43214; synthetic local data only')); })().catch(error => { console.error(error.message); process.exitCode=1; });
const stop = () => server?.close(() => { fs.rmSync(temporary,{ recursive:true,force:true }); process.exit(0); }); process.once('SIGINT',stop); process.once('SIGTERM',stop);
