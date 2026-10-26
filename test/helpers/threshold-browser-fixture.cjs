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
  baseUrl: require('node:path').resolve(__dirname, '../..'),
  paths: require('../../tsconfig.node.json').compilerOptions.paths,
});
const { NestFactory } = require('@nestjs/core');
const { mkdtempSync, rmSync, existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const temporary = mkdtempSync(join(tmpdir(), 'nt-threshold-browser-'));
process.env.THRESHOLD_LEDGER_PATH = join(temporary, 'records.json');
const {
  ThresholdModule,
} = require('../../server/modules/threshold-management/threshold.module');
const requests = [];
let mode = 'normal';
let role = 'admin';
async function main() {
  const app = await NestFactory.create(ThresholdModule, { logger: false });
  app.use((request, response, next) => {
    const started = Date.now();
    if (request.path === '/__qa/shutdown') {
      response.json({ stopping: true });
      void app.close().then(() => {
        rmSync(temporary, { recursive: true, force: true });
        process.exit(0);
      });
      return;
    }
    response.on('finish', () =>
      requests.push({
        method: request.method,
        path: request.path,
        status: response.statusCode,
        ms: Date.now() - started,
      }),
    );
    if (request.path === '/__qa/status')
      return response.json({
        requests,
        role,
        mode,
        persistedCount: existsSync(process.env.THRESHOLD_LEDGER_PATH)
          ? JSON.parse(readFileSync(process.env.THRESHOLD_LEDGER_PATH, 'utf8'))
              .records.length
          : null,
      });
    if (request.path === '/__qa/control') {
      mode = request.query.mode || 'normal';
      role = request.query.role || role;
      return response.json({ mode, role });
    }
    if (request.path === '/api/access/session')
      return response.json({
        role,
        purchaseBuilding: null,
        displayName: '阈值验收账号',
        expiresAt: Date.now() + 3600000,
        principalFingerprint: `threshold-qa-${role}`,
        capabilities: {
          canEdit: ['admin', 'editor'].includes(role),
          canDelete: role === 'admin',
          canForceRefresh: true,
          canAccessContracts: role === 'admin',
        },
      });
    if (request.path === '/api/access/feishu/config')
      return response.json({ enabled: false });
    request.accessPrincipal = {
      role: request.headers['x-qa-role'] || role,
      purchaseBuilding: null,
      accountId: 'threshold-qa',
    };
    if (
      request.method === 'POST' &&
      request.path === '/api/threshold-management/mutations'
    ) {
      const requested = mode;
      mode = 'normal';
      if (requested === 'fail')
        return response
          .status(400)
          .json({ message: '代表性校验失败，请修正后重试' });
      if (requested === 'delay') return setTimeout(next, 1200);
      if (requested === 'timeout') return setTimeout(next, 17000);
    }
    next();
  });
  await app.listen(4191, '127.0.0.1');
  console.log('threshold fixture ready: http://127.0.0.1:4191');
  async function stop() {
    await app.close();
    rmSync(temporary, { recursive: true, force: true });
    process.exit(0);
  }
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
main().catch((error) => {
  console.error(error.message);
  rmSync(temporary, { recursive: true, force: true });
  process.exit(1);
});
