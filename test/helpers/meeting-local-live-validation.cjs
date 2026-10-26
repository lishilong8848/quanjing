const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
require('reflect-metadata');
require('ts-node').register({
  project: 'tsconfig.node.json',
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
  baseUrl: process.cwd(),
  paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] },
});
const { HttpService } = require('@nestjs/axios');
const {
  WeeklyGateway,
} = require('../../server/modules/meeting-management/weekly.gateway');
const gateway = new WeeklyGateway(new HttpService());
const base = 'http://127.0.0.1:4204';
const out = path.resolve('output/weekly-local-live-validation-20261009');
const ledger = path.resolve('.cache/meeting-local-live/workspace/ledger.json');
let cookie;
const proof = {
  startedAt: new Date().toISOString(),
  checks: [],
  passed: false,
  restored: false,
};
const save = () =>
  fs.writeFileSync(
    path.join(out, 'live-proof.json'),
    JSON.stringify(proof, null, 2),
  );
async function api(route, body) {
  const response = await fetch(base + '/api/meeting-management/' + route, {
    method: body ? 'POST' : 'GET',
    headers: {
      Cookie: cookie,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const data = await response.json();
  assert(
    response.ok,
    `接口失败 ${route}: ${response.status} ${data.message || ''}`,
  );
  return data;
}
async function waitJob(id) {
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const job = await api('weekly/jobs/' + id);
    if (job.status === 'success') return job;
    if (['error', 'uncertain'].includes(job.status))
      throw Error(job.error || '同步失败');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw Error('同步任务超时，请核查任务台账');
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  assert.equal(
    (await fetch(base + '/api/meeting-management/weekly/workspace')).status,
    401,
  );
  const session = await fetch(base + '/api/access/session');
  cookie = session.headers.get('set-cookie').split(';')[0];
  assert.equal((await session.json()).role, 'admin');
  assert.equal(
    (
      await fetch(base + '/api/access/session', {
        headers: { Origin: 'https://other.example' },
      })
    ).status,
    403,
  );
  proof.checks.push('无会话401、跨站403、本机会话通过');
  let workspace = await api('weekly/workspace');
  assert(workspace.writeAccess.enabled);
  assert.equal(workspace.schedule.enabled, false);
  assert(workspace.people.length > 0 && !workspace.peopleError);
  assert.equal(workspace.jobs.length, 0, '首次隔离验收不得混入用户任务');
  proof.runtime = workspace.runtime;
  proof.peopleCount = workspace.people.length;
  proof.checks.push('真实人员读取、手动写入口启用、自动定时关闭');
  if (fs.existsSync(ledger))
    fs.copyFileSync(ledger, ledger + '.before-local-validation');
  else
    fs.writeFileSync(
      ledger + '.before-local-validation',
      JSON.stringify({ schema: 1, meetings: [], receipts: {} }),
    );
  const recordId = 'recvxq9RkUcun3';
  const form = await api('weekly/records/' + recordId);
  const original = gateway.text(
    (await gateway.record(recordId))['阿里会议待办'],
  );
  assert.equal(
    form.meeting.sections.find((item) => item.key === 'customer-actions')
      ?.content || '',
    original.trim(),
  );
  assert.equal(typeof original, 'string');
  const marker = 'CODEX_QA_LOCAL_' + randomUUID();
  const desired = original + '\n' + marker + '：本地同步验收（将恢复原文）';
  fs.writeFileSync(
    path.resolve('.cache/meeting-local-live/original-ali-text.json'),
    JSON.stringify({ recordId, original, desired }),
  );
  proof.recordId = recordId;
  proof.originalSha256 = createHash('sha256').update(original).digest('hex');
  save();
  let wrote = false;
  try {
    const command = {
      clientMutationId: randomUUID(),
      expectedVersion: 0,
      expectedText: original,
      meeting: {
        targetRecordId: recordId,
        kind: 'ali',
        plannedDate: '2026-10-09',
        actualDate: '2026-10-09',
        status: 'held',
        note: '本地同步验收',
        rawText: desired,
        todos: [],
      },
    };
    const job = await api('weekly/meetings', command);
    wrote = true;
    const replay = await api('weekly/meetings', command);
    assert.equal(replay.id, job.id);
    const finished = await waitJob(job.id);
    assert.equal(
      gateway.text((await gateway.record(recordId))['阿里会议待办']),
      desired.trim(),
    );
    assert.equal(
      (await api('weekly/records/' + recordId)).meeting.sections.find(
        (item) => item.key === 'customer-actions',
      ).content,
      desired.trim(),
    );
    proof.checks.push(
      '真实待办提交、持久任务、同Mutation去重、飞书语义回读一致',
    );
    proof.jobId = finished.id;
    save();
  } finally {
    if (wrote) {
      workspace = await api('weekly/workspace');
      const entry = workspace.meetings.find(
        (item) => item.targetRecordId === recordId && item.kind === 'ali',
      );
      const restore = {
        clientMutationId: randomUUID(),
        expectedVersion: entry?.version || 0,
        expectedText: desired,
        meeting: {
          targetRecordId: recordId,
          kind: 'ali',
          plannedDate: '2026-10-09',
          actualDate: '2026-10-09',
          status: 'held',
          note: '',
          rawText: original,
          todos: [],
        },
      };
      await waitJob((await api('weekly/meetings', restore)).id);
      assert.equal(
        gateway.text((await gateway.record(recordId))['阿里会议待办']),
        original,
      );
      proof.restored = true;
      proof.checks.push('真实测试文字已恢复原文并回读确认');
      save();
    }
  }
  proof.passed = true;
}
main()
  .catch((error) => {
    proof.error = error.message;
    process.exitCode = 1;
  })
  .finally(() => {
    proof.finishedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify(proof));
  });
