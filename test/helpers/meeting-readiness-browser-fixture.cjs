const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-readiness-qa-'));
process.env.FEISHU_LOCAL_CACHE_DIR = temporary;
process.env.WEEKLY_WORKSPACE_DIR = path.join(temporary, 'weekly');
process.env.NANTONG_WEEKLY_SCHEDULE_ENABLED = 'false';
process.env.NANTONG_WEEKLY_PRECREATE_ENABLED = 'false';
require('reflect-metadata');
require('ts-node').register({
  project: 'tsconfig.node.json',
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
    moduleResolution: 'node',
    emitDecoratorMetadata: true,
    experimentalDecorators: true,
    esModuleInterop: true,
  },
});
require('tsconfig-paths').register({
  baseUrl: path.resolve(__dirname, '../..'),
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const { NestFactory } = require('@nestjs/core');
const {
  MeetingManagementModule,
} = require('../../server/modules/meeting-management/meeting.module');
const {
  MeetingService,
} = require('../../server/modules/meeting-management/meeting.service');
const {
  WeeklyGateway,
} = require('../../server/modules/meeting-management/weekly.gateway');
const {
  WeeklyEngine,
  WeeklyEngineError,
} = require('../../server/modules/meeting-management/weekly.engine');
let app;
let mode = 'fail';
let calls = 0;
const requests = [];
const record = {
  id: 'recReadinessQA',
  title: '运行检查验收周报',
  date: '2026-10-07',
  weekLabel: '2026年第41周',
  scope: '机房',
  nature: '管理类',
  source: 'nantong-weekly',
  documentUrl: null,
  updatedAt: null,
  hasActions: false,
  sectionTitles: [],
  searchText: '',
};
const snapshot = {
  snapshotId: 'readiness-qa',
  updatedAt: new Date().toISOString(),
  syncState: 'ready',
  message: null,
  records: [record],
  latestActions: null,
  sources: [],
};
async function stop() {
  if (app) await app.close();
  if (!path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep))
    throw new Error('QA_DIRECTORY_BOUNDARY');
  fs.rmSync(temporary, { recursive: true, force: true });
  process.exit(0);
}
async function main() {
  app = await NestFactory.create(MeetingManagementModule, { logger: false });
  const meetings = app.get(MeetingService);
  meetings.snapshot = async () => snapshot;
  meetings.weeklySnapshot = async () => snapshot;
  meetings.detail = async () => ({
    snapshotId: snapshot.snapshotId,
    meeting: { ...record, sections: [] },
  });
  const gateway = app.get(WeeklyGateway);
  for (const name of Object.getOwnPropertyNames(WeeklyGateway.prototype)) {
    if (name !== 'constructor' && typeof gateway[name] === 'function')
      gateway[name] = () => {
        throw new Error('QA_EXTERNAL_BOUNDARY');
      };
  }
  gateway.people = async () => [];
  gateway.record = async () => ({ 日期: record.date, 第几周: record.title });
  const engine = app.get(WeeklyEngine);
  engine.call = async (payload) => {
    if (payload.action !== 'check') throw new Error('QA_GENERATION_BOUNDARY');
    calls += 1;
    if (mode === 'fail')
      throw new WeeklyEngineError('private fixture', undefined, {
        category: 'cli-config-read',
      });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return { ready: true, version: 'standalone-20261009-template-v3' };
  };
  app.use((req, res, next) => {
    if (req.path === '/__qa/stop') {
      res.json({ stopping: true });
      setImmediate(() => void stop());
      return;
    }
    if (req.path === '/__qa/control') {
      mode = req.query.mode === 'ready' ? 'ready' : 'fail';
      return res.json({ mode });
    }
    if (req.path === '/__qa/status')
      return res.json({ calls, requests, runtime: engine.status() });
    if (req.method !== 'GET')
      return res.status(403).json({ message: '隔离验收禁止业务写入' });
    requests.push({ path: req.path, recheck: req.query.recheck === '1' });
    if (req.path === '/api/access/session')
      return res.json({
        role: 'admin',
        purchaseBuilding: null,
        displayName: '隔离验收',
        expiresAt: Date.now() + 3600000,
        principalFingerprint: 'readiness-qa',
        capabilities: {
          canEdit: true,
          canDelete: true,
          canForceRefresh: true,
          canAccessContracts: true,
        },
      });
    if (req.path === '/api/access/feishu/config')
      return res.json({ enabled: false });
    req.accessPrincipal = {
      role: 'admin',
      purchaseBuilding: null,
      accountId: 'readiness-qa',
    };
    next();
  });
  await app.listen(4202, '127.0.0.1');
  console.log('readiness fixture ready: 4202');
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
main().catch(async () => {
  console.error('QA_START_FAILED');
  await stop();
});
