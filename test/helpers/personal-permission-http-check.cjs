const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = 'http://127.0.0.1:43224', origin = 'http://127.0.0.1:43223';
const checks = [];
const post = async (body, headers = {}) => {
  const response = await fetch(`${base}/api/access/configuration/accounts`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() };
};
(async () => {
  const state = await (await fetch(`${base}/api/access/configuration`)).json();
  const account = state.accounts.find(item => item.openId === 'ou_permission_browser_synthetic');
  const request = { clientMutationId: 'synthetic-http-account-change', expectedRevision: state.revision, id: account.id, kind: 'feishu', name: account.name, openId: account.openId, external: true,
    role: 'professional_admin', building: null, specialties: ['电气', '暖通'], enabled: true,
    personalRules: [{ id: 'synthetic-http-rule', module: 'inventory', effect: 'deny', actions: ['update'], buildings: ['A楼', 'C楼'], specialties: ['电气', '暖通'] }], pagePaths: ['/operations-kb'] };
  const check = async (name, body, status, headers) => { const result = await post(body, headers); assert.equal(result.status, status, `${name}: ${result.data.message || 'unexpected response'}`); checks.push({ name, status }); return result.data; };
  await check('未登录仍拒绝', request, 401, { 'x-synthetic-auth': 'guest' });
  await check('错误来源仍拒绝', request, 403, { origin: 'http://invalid.synthetic.local' });
  await check('未知字段仍拒绝', { ...request, unexpected: true }, 400);
  await check('字符串版本仍拒绝', { ...request, expectedRevision: String(state.revision) }, 400);
  await check('畸形个人规则仍拒绝', { ...request, personalRules: [{ id: 'invalid' }] }, 400);
  assert.equal((await (await fetch(`${base}/api/access/configuration`)).json()).revision, state.revision);
  const saved = await check('中间件到控制器服务真实保存', request, 200);
  const stored = saved.accounts.find(item => item.id === account.id);
  assert.deepEqual(stored.personalRules, request.personalRules); assert.deepEqual(stored.pagePaths, request.pagePaths); assert.deepEqual(stored.specialties, request.specialties);
  const replay = await check('成功请求重试幂等', request, 200); assert.equal(replay.revision, saved.revision);
  await check('重复标识异内容拒绝', { ...request, enabled: false }, 409);
  await check('旧版本修改拒绝', { ...request, clientMutationId: 'synthetic-http-stale-version' }, 409);
  const final = await (await fetch(`${base}/api/access/configuration`)).json();
  assert.equal(final.revision, saved.revision); assert.equal(final.accounts.find(item => item.id === account.id).enabled, true);
  const report = { checks, initialRevision: state.revision, finalRevision: final.revision, passed: true };
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
