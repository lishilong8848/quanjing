const fs = require('node:fs');
const path = require('node:path');
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
  fetchBitableRecords,
  getTenantAccessToken,
} = require('../../server/common/feishu/bitable-direct-read');
const sources = [
  {
    source: 'training',
    appToken: 'PUBLIC_EXAMPLE_FEISHU_DAILY_REPORT_APP_TOKEN',
    tableId: 'tbl00349d6675ac8',
    viewId: 'vew5BJWcH2',
    tableName: '培训分享会',
  },
  {
    source: 'ali-meeting',
    appToken: 'PUBLIC_EXAMPLE_FEISHU_DAILY_REPORT_APP_TOKEN',
    tableId: 'tbl1e190ddc55baa',
    viewId: 'vewae6upeP',
    tableName: '阿里会议',
  },
];
const http = new HttpService();
async function main() {
  const access = await getTenantAccessToken(http);
  const proof = [];
  for (const source of sources) {
    const fields = [];
    let page;
    do {
      const res = await http.axiosRef.get(
        `https://open.feishu.cn/open-apis/bitable/v1/apps/${source.appToken}/tables/${source.tableId}/fields`,
        {
          params: { page_size: 100, ...(page ? { page_token: page } : {}) },
          timeout: 10000,
          headers: { Authorization: `Bearer ${access}` },
        },
      );
      if (res.data.code !== 0)
        throw new Error(`字段读取失败：${source.source}`);
      fields.push(
        ...res.data.data.items.map((f) => ({
          name: f.field_name,
          type: f.type,
        })),
      );
      page = res.data.data.has_more ? res.data.data.page_token : undefined;
    } while (page);
    const records = await fetchBitableRecords(http, {
      ...source,
      automaticFields: true,
      strict: true,
      allowStale: false,
      forceRefresh: true,
    });
    const {
      mapAdditionalMeeting,
    } = require('../../server/modules/meeting-management/meeting.sources.mapper');
    const meetings = records.map((r) => mapAdditionalMeeting(r, source));
    const distribution = (name) =>
      Object.fromEntries(
        [
          ...new Set(records.map((r) => String(r.fields[name] || '未填写'))),
        ].map((v) => [
          v,
          records.filter((r) => String(r.fields[name] || '未填写') === v)
            .length,
        ]),
      );
    const entry = {
      source: source.source,
      count: records.length,
      fields,
      documents: meetings.filter((m) => m.documentUrl).length,
      resources: meetings.reduce((n, m) => n + m.resources.length, 0),
      warnings: meetings.filter((m) => m.warnings.length).length,
      attachments: meetings.filter((m) => m.attachmentNames.length).length,
      types: distribution(source.source === 'training' ? '分享类型' : '类型'),
      locations: distribution(
        source.source === 'training' ? '机房名称' : '会议属性',
      ),
      dates: meetings
        .map((m) => m.date)
        .filter(Boolean)
        .sort()
        .filter((_, i, all) => i === 0 || i === all.length - 1),
    };
    proof.push(entry);
    console.log(JSON.stringify(entry));
  }
  const out = path.resolve('output/meeting-sources-validation');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(
    path.join(out, 'source-read.json'),
    JSON.stringify(proof, null, 2),
  );
}
main().catch(() => {
  console.error('新会议数据源读取失败，请核对应用权限');
  process.exitCode = 1;
});
