const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const out = path.resolve('output/weekly-actions-validation-20261009');
const cliScript = process.env.MEETING_QA_LARK_CLI;
if (!cliScript || !fs.existsSync(cliScript)) throw new Error('先指定已验证的 lark-cli 入口');
require('reflect-metadata');
require('ts-node').register({ project: 'tsconfig.node.json', transpileOnly: true, compilerOptions: { module: 'commonjs', moduleResolution: 'node', experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true } });
require('tsconfig-paths').register({ baseUrl: process.cwd(), paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
const { HttpService } = require('@nestjs/axios');
const { WeeklyGateway } = require('../../server/modules/meeting-management/weekly.gateway');
const { WEEKLY_MEETING_SOURCE } = require('../../server/modules/meeting-management/meeting.service');
const { prepareActionEdit } = require('../../server/modules/meeting-management/meeting.action-edit');
const gateway = new WeeklyGateway(new HttpService());
const existingId = process.env.MEETING_QA_REAL_RECORD;
const previous = existingId ? JSON.parse(fs.readFileSync(path.join(out, 'real-feishu-proof.json'))) : null;
if (previous) fs.copyFileSync(path.join(out, 'real-feishu-proof.json'), path.join(out, 'real-feishu-proof-create-return.json'));
const marker = previous?.marker || `CODEX_QA_WEEKLY_${crypto.randomUUID()}`;
const common = ['--base-token', WEEKLY_MEETING_SOURCE.appToken, '--table-id', WEEKLY_MEETING_SOURCE.tableId, '--as', 'user'];
const proof = { startedAt: new Date().toISOString(), passed: false, marker, recordId: null, cleanup: false, checks: [] };
const save = () => fs.writeFileSync(path.join(out, 'real-feishu-proof.json'), JSON.stringify(proof, null, 2));
const invoke = args => spawnSync(process.execPath, [cliScript, 'base', ...args, ...common], { encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
const cli = args => {
  const result = invoke(args);
  let data; try { data = JSON.parse(result.stdout || '{}'); } catch { throw new Error('飞书 CLI 返回无法解析，请检查本次验收标识'); }
  if (result.error || result.status !== 0 || data.ok !== true) throw new Error(`飞书验收操作失败：${args[0]}`);
  return data.data;
};
async function main() {
  let id; save();
  try {
    if (existingId) id = existingId;
    else {
      const created = cli(['+record-upsert', '--json', JSON.stringify({ 日期: '2000-01-01 00:00:00', 周报生成标识: marker, 本周代办: `1. ${marker}原事项\n2. ${marker}相邻事项` })]);
      id = created.record?.id || created.record?.record_id || created.record_id || created.record_id_list?.[0];
      if (!id) {
        const found = cli(['+record-search', '--keyword', marker.slice(-36), '--search-field', '周报生成标识', '--field-id', '周报生成标识', '--limit', '2', '--format', 'json']);
        if (found.has_more || found.record_id_list?.length !== 1) throw new Error('测试记录定位不唯一，禁止重复创建');
        id = found.record_id_list[0];
      }
    }
    if (!/^rec[A-Za-z0-9]+$/.test(id || '')) throw new Error('测试记录编号未确认，禁止重复创建');
    proof.recordId = id; save();
    const initial = await gateway.record(id); assert.equal(gateway.text(initial['周报生成标识']), marker);
    const edit = prepareActionEdit({ clientMutationId: crypto.randomUUID(), targetRecordId: id, actionId: `${id}:current-actions:0`, expectedContent: `${marker}原事项`, content: `${marker}修改后的事项`, assignee: { kind: 'custom', name: '验收人员' } }, gateway.text(initial['本周代办']));
    await gateway.update(id, { [edit.field]: edit.expectedText }, { [edit.field]: edit.desiredText });
    await gateway.update(id, { [edit.field]: edit.expectedText }, { [edit.field]: edit.desiredText });
    assert.equal(gateway.text((await gateway.record(id))['本周代办']), edit.desiredText);
    proof.checks.push('真实单项修改、责任人文本与相邻事项保留，重复回读确认');
    const block = `${marker}\n1. 整段测试\n  保留缩进\n\n2. 保留编号与换行`;
    await gateway.update(id, { 阿里会议待办: '' }, { 阿里会议待办: block });
    assert.equal(gateway.text((await gateway.record(id))['阿里会议待办']), block);
    proof.checks.push('真实整段待办写入和回读'); save();
    await gateway.assertAttachmentField('阿里会议附件'); await gateway.assertAttachmentField('属地周会附件');
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5GkAAAAASUVORK5CYII=', 'base64');
    const token = await gateway.uploadImage(image, `${marker}.png`, 'image/png');
    await gateway.appendImages(id, '阿里会议附件', [], [token]);
    await gateway.appendImages(id, '阿里会议附件', [], [token]);
    assert.deepEqual(gateway.attachmentTokens((await gateway.record(id))['阿里会议附件']), [token]);
    proof.checks.push('运行应用真实上传、附件字段追加与 token 回读，重复同步不重复附件');
    const people = await gateway.people(); assert(people.length > 0 && people.every(person => /^ou_[A-Za-z0-9]{10,100}$/.test(person.openId)));
    proof.peopleCount = people.length; proof.checks.push('运行应用在职目录可读，稳定人员 ID 有效'); proof.passed = true;
  } catch (error) { proof.error = error.message; process.exitCode = 1; }
  finally {
    if (id) {
      try {
        const fields = await gateway.record(id); assert.equal(gateway.text(fields['周报生成标识']), marker);
        for (const field of ['阿里会议附件', '属地周会附件']) {
          const tokens = gateway.attachmentTokens(fields[field]);
          if (tokens.length) cli(['+record-remove-attachment', '--record-id', id, '--field-id', field, ...tokens.flatMap(token => ['--file-token', token]), '--yes']);
        }
        const clean = await gateway.record(id);
        assert(!gateway.attachmentTokens(clean['阿里会议附件']).length && !gateway.attachmentTokens(clean['属地周会附件']).length);
        cli(['+record-delete', '--record-id', id, '--yes']);
        const absent = invoke(['+record-get', '--record-id', id]);
        assert(absent.status !== 0 && /record.*not.?found|record.*deleted|记录.*不存在|记录.*删除|1254043|1254044/i.test(absent.stdout || ''), '测试记录删除回读未确认');
        proof.cleanup = true;
      } catch (error) { proof.cleanupError = error.message; process.exitCode = 1; }
    }
    proof.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ passed: proof.passed, cleanup: proof.cleanup, checks: proof.checks, peopleCount: proof.peopleCount, error: proof.error, cleanupError: proof.cleanupError }));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
