// Creates and cleans only resources carrying this run's persisted QA identity.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
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
  baseUrl: process.cwd(),
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const { HttpService } = require('@nestjs/axios');
const {
  WeeklyGateway,
} = require('../../server/modules/meeting-management/weekly.gateway');
const {
  WeeklyEngine,
} = require('../../server/modules/meeting-management/weekly.engine');
const {
  getTenantAccessToken,
} = require('../../server/common/feishu/bitable-direct-read');
const out = path.resolve('output/weekly-workspace-validation');
fs.mkdirSync(out, { recursive: true });
const journal = path.join(out, 'real-integration.json');
if (fs.existsSync(journal))
  fs.renameSync(journal, path.join(out, `real-integration-${Date.now()}.json`));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-weekly-real-'));
process.env.WEEKLY_WORKSPACE_DIR = work;
process.env.FEISHU_LOCAL_CACHE_DIR = work;
const proof = {
  runId: `qa-weekly-${crypto.randomUUID()}`,
  startedAt: new Date().toISOString(),
  steps: [],
  cleanup: {},
};
const persist = () => fs.writeFileSync(journal, JSON.stringify(proof, null, 2));
persist();
const http = new HttpService();
const gateway = new WeeklyGateway(http);
const engine = new WeeklyEngine();
const step = (name) => {
  proof.steps.push(name);
  persist();
  console.log(name);
};
async function main() {
  try {
    if (process.env.FEISHU_APP_ID !== 'cli_0831564613853b26')
      throw new Error('验收应用不匹配');
    if (!(await engine.check()).ready) throw new Error('引擎未就绪');
    const people = await gateway.people();
    const owner = people.find(
      (p) => p.openId === 'PUBLIC_EXAMPLE_FEISHU_TYPHOON_PATH_TEST_OPEN_ID',
    );
    if (!owner) throw new Error('已确认账号不在示例人员019员目录');
    step('engine-and-person-directory-ready');
    const artifact = await engine.call({
      action: 'prepare',
      targetRecordId: 'recvxpHuxHBmqn',
      startDate: '2026-10-01',
      endDate: '2026-10-07',
    });
    if (!artifact.xml || artifact.xml.includes('\uFFFD'))
      throw new Error('周报预生成存在异常字符');
    proof.prepare = {
      xmlBytes: Buffer.byteLength(artifact.xml),
      xmlSHA256: crypto.createHash('sha256').update(artifact.xml).digest('hex'),
    };
    step('readonly-prepare-confirmed-with-utf8');
    if (process.argv.includes('--prepare-only')) {
      proof.passed = true;
      return;
    }
    await gateway.ensureCreationField();
    proof.rowId = await gateway.createRow('2000-01-05', proof.runId);
    persist();
    if ((await gateway.findCreated(proof.runId)) !== proof.rowId)
      throw new Error('创建标识回读不符');
    step('row-marker-confirmed');
    const text = `1. ${proof.runId} 测试待办（验收后清理）｜示例人员019：${owner.name}｜截止：2000-01-06｜待办`;
    await gateway.update(
      proof.rowId,
      { 阿里会议待办: '' },
      { 阿里会议待办: text },
    );
    await gateway.update(
      proof.rowId,
      { 阿里会议待办: '' },
      { 阿里会议待办: text },
    );
    if (
      gateway.text((await gateway.record(proof.rowId))['阿里会议待办']) !== text
    )
      throw new Error('待办回读失败');
    step('todo-semantic-readback-and-idempotent-retry-confirmed');
    const xml = artifact.xml.replace(
      /<title>.*?<\/title>/s,
      `<title>${proof.runId} 周报验收（验收后清理）</title>`,
    );
    try {
      proof.documentUrl = (
        await engine.call({ action: 'create', xml })
      ).documentUrl;
    } catch (error) {
      if (error.documentUrl) {
        proof.documentUrl = error.documentUrl;
        persist();
      }
      throw error;
    }
    persist();
    step('document-created-and-body-confirmed');
    await gateway.grantDocument(proof.documentUrl, [owner.openId]);
    await gateway.grantDocument(proof.documentUrl, [owner.openId]);
    step('document-edit-permission-confirmed');
    await engine.call({
      action: 'document',
      documentUrl: proof.documentUrl,
      xml,
    });
    step('document-overwrite-and-body-confirmed');
    await gateway.update(
      proof.rowId,
      { 链接: '' },
      {
        链接: proof.documentUrl,
        专业线: artifact.professional,
        运营线: artifact.operations,
      },
    );
    step('archive-semantic-readback-confirmed');
    proof.passed = true;
  } catch (error) {
    proof.passed = false;
    if (error.diagnostic) proof.diagnostic = error.diagnostic;
    proof.error =
      /^(验收|引擎|已确认|创建标识|待办|缺少|周报|多维表|目标)/.test(
        error.message,
      )
        ? error.message
        : '真实集成验证失败';
    console.log(proof.error);
  } finally {
    try {
      if (
        !proof.rowId &&
        proof.steps.includes('engine-and-person-directory-ready')
      )
        proof.rowId = await gateway.findCreated(proof.runId);
      if (proof.rowId) {
        if (
          gateway.text((await gateway.record(proof.rowId))['周报生成标识']) !==
          proof.runId
        )
          throw new Error('清理标识不匹配');
        const access = await getTenantAccessToken(http);
        const response = await http.axiosRef.delete(
          `https://open.feishu.cn/open-apis/bitable/v1/apps/Ku17b5rmgaULYJsioBpcHl0Xnqd/tables/tbl96c6dccf01af4/records/${proof.rowId}`,
          { timeout: 10000, headers: { Authorization: `Bearer ${access}` } },
        );
        if (
          response.data.code !== 0 ||
          (await gateway.findCreated(proof.runId))
        )
          throw new Error('测试条目清理未确认');
        proof.cleanup.row = true;
      }
      if (proof.documentUrl) {
        const token = proof.documentUrl.match(
          /^https:\/\/vnet\.feishu\.cn\/docx\/([A-Za-z0-9]+)$/,
        )?.[1];
        if (!token) throw new Error('测试文档链接不匹配');
        const access = await getTenantAccessToken(http);
        const response = await http.axiosRef.delete(
          `https://open.feishu.cn/open-apis/drive/v1/files/${token}`,
          {
            params: { type: 'docx' },
            timeout: 10000,
            headers: { Authorization: `Bearer ${access}` },
          },
        );
        if (response.data.code !== 0) throw new Error('测试文档清理未确认');
        proof.cleanup.document = true;
      }
      const resolved = path.resolve(work);
      if (
        !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
        !path.basename(resolved).startsWith('nt-weekly-real-')
      )
        throw new Error('临时目录身份不符');
      fs.rmSync(resolved, { recursive: true });
      proof.cleanup.local = true;
    } catch {
      proof.cleanup.error = '测试资源清理尚未确认，请按本验收台账处理';
    }
    proof.finishedAt = new Date().toISOString();
    persist();
    console.log(
      JSON.stringify({
        passed: proof.passed,
        steps: proof.steps,
        cleanup: proof.cleanup,
      }),
    );
    if (!proof.passed || proof.cleanup.error) process.exitCode = 1;
  }
}
main();
