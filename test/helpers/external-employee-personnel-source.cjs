const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..');
require('dotenv').config({ path: path.join(root, '.env'), override: true, quiet: true });
require('dotenv').config({ path: path.join(root, '.env.local'), override: true, quiet: true });
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'node', experimentalDecorators: true, emitDecoratorMetadata: true } });
require('tsconfig-paths').register({ baseUrl: root, paths: { '@shared/*': ['shared/*'], '@server/*': ['server/*'] } });
(async () => {
  const { APPROVED_FEISHU_APP_ID } = require('../../server/common/access/feishu-access-approved-grants');
  const appId = process.env.FEISHU_APP_ID?.trim();
  if (appId !== APPROVED_FEISHU_APP_ID) throw new Error('application');
  const http = { axiosRef: require('axios').create() };
  const source = require('../../server/modules/bitable-sync/employee-onboarding.config').readEmployeeOnboardingConfig();
  const bitable = require('../../server/common/feishu/bitable-direct-read');
  const auth = { appId, appSecret: process.env.FEISHU_APP_SECRET?.trim() };
  const appToken = await bitable.resolveBitableAppToken(http, { ...source, auth, requestTimeoutMs: () => 8000 });
  const token = await bitable.getTenantAccessToken(http, auth);
  const metadata = async resource => {
    let items = [], pageToken, visited = new Set();
    do {
      const response = await http.axiosRef.get(`https://open.feishu.cn/open-apis/bitable/v1/apps/${appToken}/tables/${source.tableId}/${resource}`, { headers: { Authorization: `Bearer ${token}` }, params: { page_size: 100, page_token: pageToken }, timeout: 8000 });
      if (response.data?.code !== 0 || !Array.isArray(response.data.data?.items)) throw new Error('metadata');
      items.push(...response.data.data.items); pageToken = response.data.data.has_more ? response.data.data.page_token : undefined;
      if ((response.data.data.has_more && !pageToken) || (pageToken && visited.has(pageToken))) throw new Error('pagination');
      if (pageToken) visited.add(pageToken);
    } while (pageToken);
    return items;
  };
  const { readExternalEmployeeCredentials } = require('../../server/common/access/external-employee-directory');
  const employees = await readExternalEmployeeCredentials(http, appId, appToken, source.tableId, token, await metadata('fields'), await metadata('views'));
  const report = { readOnly: true, at: new Date().toISOString(), view: '外部账号人员', total: employees.length, active: employees.filter(employee => employee.active).length, configuredCredentials: employees.filter(employee => employee.passwordHash).length, uniqueIdentities: new Set(employees.map(employee => employee.id)).size, credentialsReturnedToBrowser: false, externalWrites: 0, localAccountWrites: 0 };
  fs.writeFileSync(path.join(root, 'output/multi-building-access-check/external-personnel-source.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(() => { console.error('外部员工真实视图只读核对失败；未输出姓名、密码、摘要或认证信息。'); process.exitCode = 1; });
