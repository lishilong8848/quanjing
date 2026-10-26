const { mkdtempSync, rmSync, writeFileSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const temporary = mkdtempSync(join(tmpdir(), 'nt-meeting-source-'));
process.env.FEISHU_LOCAL_CACHE_DIR = temporary;
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
  baseUrl: resolve(__dirname, '../..'),
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const { NestFactory } = require('@nestjs/core');
const {
  MeetingManagementModule,
} = require('../../server/modules/meeting-management/meeting.module');
const {
  MeetingService,
} = require('../../server/modules/meeting-management/meeting.service');
const requests = [];
const memoryWeekly = process.env.WEEKLY_QA_MODE === 'memory';
const port = Number(process.env.MEETING_QA_PORT || 4201);
let role = 'admin';
let mode = 'normal';
let source;
let app;
let resetWeekly;
let inspectWeekly;
let addExternalRow;

async function main() {
  app = await NestFactory.create(MeetingManagementModule, { logger: false });
  app.useBodyParser('json', { limit: '1mb' });
  const service = app.get(MeetingService);
  const started = Date.now();
  source = await service.snapshot();
  const {
    WeeklyGateway,
  } = require('../../server/modules/meeting-management/weekly.gateway');
  const {
    WeeklyEngine,
  } = require('../../server/modules/meeting-management/weekly.engine');
  const {
    WeeklyService,
  } = require('../../server/modules/meeting-management/weekly.service');
  const weekly = app.get(WeeklyService);
  const gateway = app.get(WeeklyGateway);
  const engine = app.get(WeeklyEngine);
  process.env.NANTONG_WEEKLY_SCHEDULE_ENABLED = 'false';
  process.env.NANTONG_WEEKLY_PRECREATE_ENABLED = 'false';
  if (memoryWeekly) {
    const rows = new Map();
    for (const record of source.records.filter(
      (r) => r.source === 'nantong-weekly',
    )) {
      const { meeting } = await service.detail(record.id, false);
      rows.set(
        record.id,
        Object.fromEntries([
          ['日期', record.date],
          ['第几周', record.title],
          ['链接', record.documentUrl || ''],
          ...meeting.sections.map((s) => [
            s.title === '本周待办' ? '本周代办' : s.title,
            s.content,
          ]),
        ]),
      );
    }
    let creates = 0;
    let failures = 0;
    let imageUploads = 0;
    let imageFailures = 0;
    const imageNames = new Map();
    const notifications = [];
    gateway.creationLink = async (_id, recordId) =>
      `https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE`;
    let notificationFailures = 0;
    gateway.sendWeeklyReport = async (chatId, uuid, title, documentUrl) => {
      if (mode === 'notification-fail' && notificationFailures++ === 0)
        throw Object.assign(new Error('验收模拟群提醒权限失败'), {
          notificationRejected: true,
        });
      const existing = notifications.find((n) => n.uuid === uuid);
      if (existing) return existing.messageId;
      const messageId = `om_QaNotification${notifications.length + 1}`;
      notifications.push({ chatId, uuid, title, documentUrl, messageId });
      return messageId;
    };
    addExternalRow = async () => {
      const fields = { 日期: '2026-10-21', 第几周: '隔离外部新增周报' };
      rows.set('recQAExternal', fields);
      await service.addWeeklyRecord('recQAExternal', fields);
    };
    const initialRows = new Map(rows);
    resetWeekly = () => {
      if (weekly.working || weekly.store.pending().length) return false;
      const ledgerPath = resolve(weekly.store.path);
      if (!ledgerPath.startsWith(resolve(temporary) + require('node:path').sep))
        throw new Error('验收台账目录不匹配');
      if (require('node:fs').existsSync(ledgerPath))
        require('node:fs').unlinkSync(ledgerPath);
      rows.clear();
      for (const [id, row] of initialRows) rows.set(id, { ...row });
      service.replace(
        [...rows].map(([record_id, fields]) => ({ record_id, fields })),
        Date.now(),
        Date.now() + 300000,
      );
      creates = 0;
      failures = 0;
      imageUploads = 0;
      imageFailures = 0;
      imageNames.clear();
      notifications.length = 0;
      notificationFailures = 0;
      return true;
    };
    service.refresh = async () =>
      service.replace(
        [...rows].map(([record_id, fields]) => ({ record_id, fields })),
        Date.now(),
        Date.now() + 20000,
      );
    gateway.people = async () => [
      { openId: 'PUBLIC_EXAMPLE_FEISHU_TYPHOON_PATH_TEST_OPEN_ID', name: '示例人员020' },
    ];
    gateway.record = async (id) => {
      if (mode === 'weekly-delay')
        await new Promise((r) => setTimeout(r, 1500));
      if (!rows.has(id)) throw new Error('验收记录不存在');
      return { ...rows.get(id) };
    };
    gateway.update = async (id, expected, desired) => {
      if (mode === 'weekly-fail' && failures++ === 0)
        throw new Error('验收模拟同步失败，可重试');
      if (mode === 'weekly-delay')
        await new Promise((r) => setTimeout(r, 1200));
      const row = rows.get(id);
      const matches = (fields) =>
        Object.entries(fields).every(
          ([name, value]) => gateway.text(row[name]) === gateway.text(value),
        );
      if (matches(desired)) return;
      if (!matches(expected))
        throw new Error('周报内容已被示例人员004修改，请重新打开核对');
      rows.set(id, { ...row, ...desired });
    };
    gateway.ensureCreationField = async () => undefined;
    gateway.assertAttachmentField = async () => undefined;
    gateway.uploadImage = async (_buffer, name) => {
      if (mode === 'image-upload-fail' && imageFailures++ === 0)
        throw Object.assign(new Error('验收模拟图片上传失败'), {
          uploadRejected: true,
        });
      const token = `fileQAImage${++imageUploads}`;
      imageNames.set(token, name);
      return token;
    };
    gateway.appendImages = async (id, field, expected, tokens) => {
      if (mode === 'image-write-fail' && imageFailures++ === 0)
        throw new Error('验收模拟附件回填失败');
      const row = rows.get(id);
      const desired = [...new Set([...expected, ...tokens])].sort();
      const actual = gateway.attachmentTokens(row[field]);
      if (JSON.stringify(actual) === JSON.stringify(desired)) return;
      if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
        throw new Error('会议图片已被示例人员004修改');
      rows.set(id, {
        ...row,
        [field]: desired.map((file_token) => ({
          file_token,
          name: imageNames.get(file_token) || '旧图片',
        })),
      });
    };
    inspectWeekly = (id) => ({
      fields: rows.get(id),
      imageUploads,
      jobs: weekly.store.list().jobs,
      notifications,
    });
    gateway.findCreated = async (id) => {
      if (mode === 'delete-delay')
        await new Promise((resolve) => setTimeout(resolve, 5000));
      if (mode === 'delete-source-fail')
        throw new Error('隔离验收：源表读取超时');
      return (
        [...rows].find(([, row]) => row['周报生成标识'] === id)?.[0] || null
      );
    };
    gateway.assertNoDate = async (date) => {
      if ([...rows.values()].some((row) => row['日期'] === date))
        throw new Error('该日期已有周报');
    };
    gateway.createRow = async (date, marker, saved) => {
      const id = `recQAWeekly${++creates}`;
      rows.set(id, { 日期: date, 周报生成标识: marker });
      saved?.(id);
      return id;
    };
    gateway.grantDocument = async () => undefined;
    engine.check = async () => ({ ready: true });
    engine.status = () => ({
      ready: true,
      message: '隔离验收：不会写入飞书',
      templateVersion: 'qa',
    });
    engine.call = async (payload) =>
      payload.action === 'prepare'
        ? {
            xml: '<h1>隔离验收</h1>',
            professional: '专业线验收',
            operations: '运营线验收',
            title: '验收周报',
          }
        : { documentUrl: 'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE' };
    if (process.env.WEEKLY_QA_UNCERTAIN_DATE) {
      const endDate = process.env.WEEKLY_QA_UNCERTAIN_DATE;
      const {
        validWeeklyDate,
      } = require('../../shared/weekly-workspace.rules');
      if (!validWeeklyDate(endDate)) throw new Error('隔离验收日期无效');
      const old = weekly.store.accept(
        'generate',
        {
          clientMutationId: 'qa-old-uncertain-12345678',
          targetRecordId: 'new',
          startDate: endDate,
          endDate,
          expectedDocumentUrl: null,
          createOnly: true,
        },
        'meeting-qa-admin',
      );
      weekly.store.change(
        old.id,
        {},
        {
          status: 'uncertain',
          stage: 'row-create',
          error: '隔离验收：旧条目创建结果待核对',
        },
      );
    }
  }
  const workspace = weekly.snapshot.bind(weekly);
  if (!memoryWeekly)
    weekly.snapshot = async () => {
      const data = await workspace();
      return {
        ...data,
        writeAccess: { enabled: false, message: '当前为只读预览，无法提交' },
        runtime: {
          ...data.runtime,
          message: '预览仅展示表单，实际提交上线后启用',
        },
      };
    };
  const summary = {
    temporaryDirectory: temporary,
    kind: 'real-feishu-read-with-production-config',
    sourceReadMs: Date.now() - started,
    count: source.records.length,
    snapshotId: source.snapshotId,
    dates: source.records
      .map((item) => item.date)
      .filter(Boolean)
      .sort(),
    documents: source.records.filter((item) => item.documentUrl).length,
    withContent: source.records.filter((item) => item.sectionTitles.length)
      .length,
    distinctWeeks: new Set(
      source.records.map((item) => item.weekLabel).filter(Boolean),
    ).size,
    syncState: source.syncState,
  };
  const evidenceDir =
    process.env.MEETING_QA_EVIDENCE_DIR ||
    resolve(__dirname, '../../output/meeting-management-validation');
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, 'source-read.json'),
    JSON.stringify(summary, null, 2),
  );
  console.log(
    JSON.stringify({
      ...summary,
      dates: { min: summary.dates[0], max: summary.dates.at(-1) },
    }),
  );

  app.use((request, response, next) => {
    const startedAt = Date.now();
    if (request.path === '/__qa/stop') {
      response.json({ stopping: true });
      setImmediate(() => void stop());
      return;
    }
    if (request.path === '/__qa/reset-weekly' && memoryWeekly)
      return response.status(resetWeekly() ? 200 : 409).json({ reset: true });
    if (request.path === '/__qa/weekly-record' && memoryWeekly)
      return response.json(inspectWeekly(String(request.query.id || '')));
    if (request.path === '/__qa/add-row' && memoryWeekly) {
      addExternalRow().then(() => response.json({ added: true }));
      return;
    }
    if (
      !memoryWeekly &&
      request.method === 'POST' &&
      request.path.startsWith('/api/meeting-management/weekly/')
    )
      return response
        .status(403)
        .json({ message: '本预览为只读，实际提交上线后启用' });
    response.on('finish', () => {
      requests.push({
        path: request.path,
        status: response.statusCode,
        ms: Date.now() - startedAt,
      });
    });
    if (request.path === '/__qa/status')
      return response.json({
        role,
        mode,
        requests,
        sourceCount: source.records.length,
      });
    if (request.path === '/__qa/control') {
      role = request.query.role || role;
      mode = request.query.mode || 'normal';
      return response.json({ role, mode });
    }
    if (request.path === '/api/access/session')
      return response.json({
        role,
        purchaseBuilding: null,
        displayName: '会议验收账号',
        expiresAt: Date.now() + 3600000,
        principalFingerprint: `meeting-qa-${role}`,
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
      accountId: 'meeting-qa',
    };
    if (
      request.path.startsWith('/api/meeting-management/') &&
      ['admin', 'editor'].includes(request.accessPrincipal.role)
    ) {
      if (mode === 'snapshot-fail' && request.path.endsWith('/snapshot'))
        return response
          .status(503)
          .json({ message: '验收模拟归档连接失败，请重试' });
      if (mode === 'detail-fail' && request.path.includes('/records/'))
        return response
          .status(503)
          .json({ message: '验收模拟会议内容读取失败，请重试' });
      if (mode === 'large' && request.path.endsWith('/snapshot'))
        return response.json({
          ...source,
          records: Array.from({ length: 10000 }, (_, i) => ({
            ...source.records[i % source.records.length],
            id: `recQA${i}`,
            title: `验收周报${i}`,
            searchText: `验收周报${i} 电气 专业线`,
          })),
        });
      if (mode === 'detail-delay' && request.path.includes('/records/'))
        return setTimeout(next, 1600);
      if (mode === 'detail-timeout' && request.path.includes('/records/'))
        return setTimeout(next, 16500);
      if (
        mode === 'weekly-delay' &&
        request.method === 'POST' &&
        request.path.endsWith('/weekly/actions')
      )
        return setTimeout(next, 1500);
    }
    next();
  });
  await app.listen(port, '127.0.0.1');
  console.log(`meeting fixture ready: http://127.0.0.1:${port}`);
}

async function stop() {
  if (app) await app.close();
  if (
    resolve(temporary).startsWith(resolve(tmpdir()) + require('node:path').sep)
  )
    rmSync(temporary, { recursive: true, force: true });
  process.exit(0);
}
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
main().catch(async (error) => {
  console.error(error.message);
  await stop();
});
