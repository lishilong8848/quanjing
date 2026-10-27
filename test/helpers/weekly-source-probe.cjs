require('reflect-metadata');
require('ts-node').register({ project: 'tsconfig.node.json', transpileOnly: true, compilerOptions: { module: 'commonjs', experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true } });
require('tsconfig-paths').register({ baseUrl: process.cwd(), paths: { '@server/*': ['server/*'], '@shared/*': ['shared/*'] } });
const { HttpService } = require('@nestjs/axios');
const { WeeklyGateway } = require('../../server/modules/meeting-management/weekly.gateway');
const { text, documentUrl } = require('../../server/modules/meeting-management/meeting.mapper');
const { splitActions } = require('../../server/modules/meeting-management/meeting.actions');
const { getTenantAccessToken } = require('../../server/common/feishu/bitable-direct-read');
(async () => {
  const gateway = new WeeklyGateway(new HttpService());
  for (const id of ['recvxvUn40nx3O', 'recvwKLPD56d2R']) {
    const row = await gateway.record(id);
    console.log(JSON.stringify({ id, link: row['链接'], mappedLink: documentUrl(row['链接']), actions: id === 'recvxvUn40nx3O' ? { raw: row['本周代办'], text: gateway.text(row['本周代办']), parsed: splitActions(gateway.text(row['本周代办'])) } : null, keys: Object.keys(row) }));
  }
  const http = new HttpService();
  const access = await getTenantAccessToken(http);
  const response = await http.axiosRef.post('https://open.feishu.cn/open-apis/base/v3/bases/Ku17b5rmgaULYJsioBpcHl0Xnqd/tables/tbl9GlPjdwTHIKSp/records/batch_get', { record_id_list: ['recvwKLPD56d2R'] }, { headers: { Authorization: `Bearer ${access}` }, timeout: 10000 });
  console.log(JSON.stringify({ api: 'v3-read', code: response.data.code, data: response.data.data }));
  const doc = await http.axiosRef.get('https://open.feishu.cn/open-apis/docx/v1/documents/U80NdM3T8o2MiHxzdyPcER1VntS/blocks', { headers: { Authorization: `Bearer ${access}` }, params: { page_size: 500 }, timeout: 10000 });
  console.log(JSON.stringify({ api: 'doc-blocks', code: doc.data.code, count: doc.data.data?.items?.length, page: doc.data.data?.has_more, first: doc.data.data?.items?.slice(0, 3) }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
