const { resolve } = require('node:path');
const fs = require('node:fs');
const { localMeetingPolicy } = require('./meeting-local-policy.cjs');
const root = resolve(__dirname, '../..');
const port = Number(process.env.MEETING_LOCAL_PORT || 4201);
if (![4201, 4204].includes(port)) throw Error('仅允许本地会议端口4201/4204');
process.env.NANTONG_WEEKLY_SCHEDULE_ENABLED = 'false';
process.env.NANTONG_WEEKLY_PRECREATE_ENABLED = 'false';
process.env.WEEKLY_WORKSPACE_DIR = resolve(
  root,
  '.cache/meeting-local-live/workspace',
);
process.env.FEISHU_LOCAL_CACHE_DIR = resolve(
  root,
  '.cache/meeting-local-live/feishu',
);
require('reflect-metadata');
require('ts-node').register({
  project: resolve(root, 'tsconfig.node.json'),
  transpileOnly: true,
  compilerOptions: {
    module: 'commonjs',
    moduleResolution: 'node',
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    esModuleInterop: true,
  },
});
require('tsconfig-paths').register({
  baseUrl: root,
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const { NestFactory } = require('@nestjs/core');
const {
  MeetingManagementModule,
} = require('../../server/modules/meeting-management/meeting.module');
const {
  WeeklyService,
} = require('../../server/modules/meeting-management/weekly.service');
const {
  WeeklyGateway,
} = require('../../server/modules/meeting-management/weekly.gateway');
const {
  WeeklyEngine,
} = require('../../server/modules/meeting-management/weekly.engine');
const policy = localMeetingPolicy(port);
let app;
async function main() {
  app = await NestFactory.create(MeetingManagementModule, { logger: false });
  app.useBodyParser('json', { limit: '1mb' });
  app.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (!policy.allowed(request))
      return response.status(403).json({ message: '仅允许本机会议页面访问' });
    if (request.path === '/api/access/session' && request.method === 'GET') {
      response.setHeader('Set-Cookie', policy.cookie);
      return response.json({
        role: 'admin',
        purchaseBuilding: null,
        displayName: '老马（本地测试）',
        accountId: 'meeting-local-owner',
        expiresAt: Date.now() + 28800000,
        principalFingerprint: 'meeting-local-owner',
        capabilities: {
          canEdit: true,
          canDelete: false,
          canForceRefresh: true,
          canAccessContracts: false,
        },
      });
    }
    if (!policy.authenticated(request))
      return response
        .status(401)
        .json({ message: '本地会话已失效，请刷新页面后重试' });
    request.accessPrincipal = {
      role: 'admin',
      purchaseBuilding: null,
      displayName: '老马（本地测试）',
      accountId: 'meeting-local-owner',
    };
    if (request.path === '/api/access/feishu/config')
      return response.json({ enabled: false });
    if (request.path === '/api/meeting-management/local-status')
      return response.json({
        mode: 'live',
        scheduleEnabled: false,
        workspace: process.env.WEEKLY_WORKSPACE_DIR,
        engine: app.get(WeeklyEngine).status(),
        pending: app.get(WeeklyService).store.pending().length,
      });
    if (
      request.path === '/api/meeting-management/local-stop' &&
      request.method === 'POST'
    ) {
      if (app.get(WeeklyService).store.pending().length)
        return response.status(409).json({ message: '有未完成任务，不能停止' });
      response.json({ stopping: true });
      setImmediate(() => void stop());
      return;
    }
    if (!request.path.startsWith('/api/meeting-management/'))
      return response.status(404).json({ message: '本地入口仅支持会议工作台' });
    next();
  });
  const weekly = app.get(WeeklyService);
  const snapshot = weekly.snapshot.bind(weekly);
  weekly.snapshot = async () => ({
    ...(await snapshot()),
    writeAccess: { enabled: true, message: '提交将同步到目标周报' },
  });
  await app.get(WeeklyGateway).assertAttachmentField('阿里会议附件');
  await app.get(WeeklyGateway).assertAttachmentField('属地周会附件');
  await app.listen(port, '127.0.0.1');
  fs.mkdirSync(resolve(root, 'output/weekly-local-live-validation-20261009'), {
    recursive: true,
  });
  fs.writeFileSync(
    resolve(root, 'output/weekly-local-live-validation-20261009/runtime.json'),
    JSON.stringify(
      {
        mode: 'live',
        port,
        pid: process.pid,
        scheduleEnabled: false,
        workspace: process.env.WEEKLY_WORKSPACE_DIR,
        startedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      ready: true,
      port,
      pid: process.pid,
      mode: 'live',
      scheduleEnabled: false,
    }),
  );
}
async function stop() {
  if (app) await app.close();
  process.exit(0);
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
main().catch(async (error) => {
  console.error(
    '本地会议后端启动失败：' +
      (error.response ? '飞书连接未通过，请核查应用配置或网络' : error.message),
  );
  if (app) await app.close();
  process.exitCode = 1;
});
