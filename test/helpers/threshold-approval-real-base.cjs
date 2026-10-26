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
const { HttpService } = require('@nestjs/axios');
const { createHash, randomUUID } = require('node:crypto');
const { writeFileSync, mkdirSync } = require('node:fs');
const { resolve } = require('node:path');
const {
  ThresholdAdjustmentGateway,
  THRESHOLD_APPROVAL_BASE,
  THRESHOLD_APPROVAL_TABLE,
} = require('../../server/modules/threshold-management/threshold-adjustment.gateway');
const {
  getTenantAccessToken,
} = require('../../server/common/feishu/bitable-direct-read');
async function main() {
  const http = new HttpService(),
    gateway = new ThresholdAdjustmentGateway(http),
    context = await gateway.readContext();
  const self = context.roles.find(
    (p) => p.openId === 'PUBLIC_EXAMPLE_FEISHU_TYPHOON_PATH_TEST_OPEN_ID',
  );
  if (!self) throw new Error('当前应用未确认本人Open ID，停止真实验收');
  if (process.argv.includes('--audit-cleanup')) {
    const remaining = (await gateway.recover()).filter(
      (e) => e.adjustment.before.id.startsWith('qa-threshold-') &&
        e.adjustment.clientMutationId.startsWith('threshold-qa-'),
    );
    const proof = { test: 'threshold-approval-cleanup-audit', checkedAt: new Date().toISOString(), remaining: remaining.length, cardsSent: 0 };
    const dir = resolve('output/threshold-approval-validation');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'real-base-cleanup-audit.json'), JSON.stringify(proof, null, 2));
    console.log(JSON.stringify(proof));
    if (remaining.length) throw new Error('仍有阈值验收记录，清理未完成');
    return;
  }
  const person = { openId: self.openId, name: self.name },
    id = `ta-${randomUUID()}`,
    now = new Date().toISOString();
  const a = {
    id,
    revision: 1,
    policyVersion: 'threshold-dual-approval-v1',
    clientMutationId: `threshold-qa-${randomUUID()}`,
    applicant: person,
    engineer: person,
    managers: [person],
    before: {
      id: `qa-threshold-${randomUUID()}`,
      profession: '电气',
      building: 'A楼',
      device: '阈值验收（无实际设备）',
      section: '验收',
      parameter: '多行及斜杠回读',
      location: '',
      value: '/',
      unit: 'S',
      kind: '设定',
      enabled: '',
      note: '',
      version: 1,
      updatedAt: now,
    },
    value: '单路失电180S\n双路失电600S',
    reason: '阈值验收：独立测试记录，不关联或修改正式设备阈值',
    plannedAt: now,
    submittedAt: now,
    state: 'rejected',
    syncState: 'success',
    stages: [
      {
        role: 'building',
        approver: person,
        decision: {
          action: 'reject',
          actor: person,
          at: now,
          eventId: `ws_threshold_${createHash('sha256').update(id).digest('hex')}`,
          messageId: 'om_qa_not_sent',
          reason: '阈值验收结束',
        },
      },
      { role: 'professional', approver: person },
    ],
  };
  const entry = {
    adjustment: a,
    fingerprint: createHash('sha256').update(id).digest('hex'),
    actorId: 'qa-self-only',
    cloudRevision: 0,
    messages: [],
    attempts: 0,
  };
  let recordId;
  const proof = {
    test: 'threshold-approval-real-base',
    base: THRESHOLD_APPROVAL_BASE,
    table: THRESHOLD_APPROVAL_TABLE,
    createdAt: now,
    roles: context.roles.length,
    engineers: context.engineers.length,
  };
  try {
    recordId = await gateway.sync(entry);
    proof.recordId = recordId;
    if ((await gateway.sync(entry)) !== recordId)
      throw new Error('幂等记录ID不一致');
    const restored = (await gateway.recover()).find(
      (e) => e.adjustment.id === id,
    );
    if (!restored || JSON.stringify(restored.adjustment) !== JSON.stringify(a))
      throw new Error('审批恢复回读不一致');
    proof.semanticReadback = true;
    proof.idempotentRecord = true;
    proof.signedRecovery = true;
  } finally {
    if (recordId) {
      const token = await getTenantAccessToken(http);
      const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${THRESHOLD_APPROVAL_BASE}/tables/${THRESHOLD_APPROVAL_TABLE}/records/${recordId}`;
      const result = await http.axiosRef.delete(url, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
      if (result.data.code !== 0) throw new Error('阈值测试记录清理未确认');
      const remaining = (await gateway.recover()).filter(
        (e) => e.adjustment.id === id,
      );
      if (remaining.length) throw new Error('清理回读仍有测试记录');
      proof.cleaned = true;
    }
    const dir = resolve('output/threshold-approval-validation');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'real-base-proof.json'),
      JSON.stringify(proof, null, 2),
    );
  }
  console.log(JSON.stringify(proof));
}
main().catch((e) => {
  console.error(JSON.stringify({message:e.message,feishuCode:e.response?.data?.code,feishuMessage:e.response?.data?.msg,method:e.config?.method,path:e.config?.url?.split('?')[0]}));
  process.exitCode = 1;
});
