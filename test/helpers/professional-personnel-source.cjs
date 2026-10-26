const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, compilerOptions: { module: 'CommonJS', moduleResolution: 'node', experimentalDecorators: true, emitDecoratorMetadata: true } });
require('tsconfig-paths').register({ baseUrl: root, paths: { '@shared/*': ['shared/*'], '@server/*': ['server/*'] } });
const { AccessConfigurationDirectory } = require('../../server/common/access/access-configuration.directory');
const { PROFESSIONAL_DEFAULTS } = require('../../server/common/access/access-professional-defaults');
const { APPROVED_FEISHU_APP_ID, APPROVED_FEISHU_GRANTS, feishuIdentityFingerprint } = require('../../server/common/access/feishu-access-approved-grants');
(async () => {
  if (process.env.FEISHU_APP_ID?.trim() !== APPROVED_FEISHU_APP_ID) throw new Error('应用身份不匹配，未查询');
  const source = await new AccessConfigurationDirectory({ axiosRef: require('axios').create() }).read(true);
  const report = { readOnly: true, personnelComplete: source.personnelComplete, personnelProblems: source.personnelProblems, snapshotAt: source.snapshotAt,
    duplicateGroups: [...new Set(source.employees.map(person => person.openId))].map(id => source.employees.filter(person => person.openId === id)).filter(group => group.length > 1).map(group => ({ count: group.length, sameProfile: new Set(group.map(({openId, ...person}) => JSON.stringify(person))).size === 1, affectedApprovedGrant: APPROVED_FEISHU_GRANTS.some(grant => grant.identityHash === feishuIdentityFingerprint(APPROVED_FEISHU_APP_ID, group[0].openId)), affectedDefault: PROFESSIONAL_DEFAULTS.find(person => person.openId === group[0].openId)?.name || null })),
    people: PROFESSIONAL_DEFAULTS.map(person => {
      const entry = source.employees.find(value => value.openId === person.openId);
      return { expectedName: person.name, matched: !!entry, name: entry?.name, position: entry?.position, specialties: entry?.specialties, inactive: entry?.inactive };
    }) };
  fs.mkdirSync(path.join(root, 'output/professional-access-check'), { recursive: true });
  fs.writeFileSync(path.join(root, 'output/professional-access-check/personnel-source.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
})().catch(() => { console.error('真实人员表只读核对失败；未修改外部数据或本地授权。'); process.exitCode = 1; });
