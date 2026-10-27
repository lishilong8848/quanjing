const path = require('node:path');
require('reflect-metadata');
require('ts-node').register({ transpileOnly: true, compilerOptions: {
  module: 'CommonJS', moduleResolution: 'node', esModuleInterop: true,
  experimentalDecorators: true, emitDecoratorMetadata: true,
} });
require('tsconfig-paths').register({ baseUrl: path.resolve(__dirname, '../..'), paths: {
  '@server/*': ['server/*'], '@shared/*': ['shared/*'],
} });
const { resolveLeaveRequestApplicant } = require('../../shared/leave-request-applicant');
const { bindLeaveRequestApplicant } = require('../../server/modules/duty-schedule/leave-request-applicant');
const express = require('express');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.post('/__innerapi__/*', (_req, res) => res.status(204).end());
const names = ['验收员工甲', '验收员工乙', ...Array.from({ length: 1200 }, (_, i) => `验收人员${i}`)];
const stationNames = ['验收110人员甲', '验收110人员乙'];
const stationRecords = stationNames.map((name, i) => ({ record_id: `recQAStation${i}`, fields: {
  姓名: name, '机楼/专业': ['110站'], 员工姓名: [{ id: 'ou_station_shared', name: '南通基地-110kV变电站值班' }],
} }));
function assertStationApplicant(actor, name) {
  if (actor !== 'station') return;
  const { assertStation110WorkforceIdentity } = require('../../server/common/access/workforce-request-applicant');
  const selected = stationRecords.find(record => record.fields.姓名 === name) || { record_id: 'recQAOutside', fields: { 姓名: name, '机楼/专业': ['A楼'] } };
  assertStation110WorkforceIdentity(actors.station, 'cli_station_fixture', stationRecords, selected);
}
const actors = {
  station: { role: 'guest', purchaseBuilding: null, accountId: 'feishu-' + require('node:crypto').createHash('sha256').update('cli_station_fixture\0ou_station_shared').digest('hex'), displayName: '南通基地-110kV变电站值班' },
  guest: { role: 'guest', purchaseBuilding: null },
  feishu: { role: 'admin', purchaseBuilding: null, accountId: 'feishu-' + 'a'.repeat(64), displayName: names[0] },
  external: { role: 'guest', purchaseBuilding: null, accountId: 'local-external-' + require('node:crypto').createHash('sha256').update(JSON.stringify(['cli_station_fixture', 'canonicalPersonApp', 'tblCanonicalPerson', 'recBrowserExternal'])).digest('hex'), displayName: names[1] },
  member: { role: 'site_member', purchaseBuilding: null, accountId: 'feishu-' + 'e'.repeat(64), displayName: names[0] },
  legacy: { role: 'admin', purchaseBuilding: null, accountId: 'local-admin', displayName: '管理员' },
  missing: { role: 'admin', purchaseBuilding: null, accountId: 'feishu-' + 'c'.repeat(64) },
  unmatched: { role: 'admin', purchaseBuilding: null, accountId: 'feishu-' + 'd'.repeat(64), displayName: '未维护验收人员' },
};
const actorOf = req => /ss_qa_actor=([a-z]+)/.exec(req.headers.cookie || '')?.[1] || 'guest';
const session = actor => {
  const principal = actors[actor] || actors.guest;
  return { ...principal,
    expiresAt: actor === 'guest' ? null : Date.now() + 3600000,
    principalFingerprint: actor === 'guest' ? null : 'qa-fingerprint-' + actor,
    pagePaths: ['/nantong-base', '/monthly-schedule', '/mbti-assessment', '/change-request/apply'],
    capabilities: { canEdit: principal.role === 'admin', canDelete: principal.role === 'admin', canForceRefresh: principal.role === 'admin', canAccessContracts: principal.role === 'admin' },
  };
};
const observations = [];
let resultMode = 'failure';
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) observations.push({ path: req.path, actor: actorOf(req), method: req.method });
  next();
});
app.get('/qa/report', (_, res) => res.json(observations));
app.get('/qa/result/:mode', (req, res) => {
  if (!['success', 'failure'].includes(req.params.mode)) return res.status(400).end();
  resultMode = req.params.mode;
  res.type('text/plain').send(`隔离验收结果：${resultMode}`);
});
app.get('/qa/:actor', (req, res) => {
  const actor = req.params.actor;
  if (!actors[actor]) return res.status(404).end();
  res.cookie('ss_qa_actor', actor, { sameSite: 'lax', httpOnly: true });
  res.redirect('/monthly-schedule');
});
app.get('/api/access/session', (req, res) => res.json(session(actorOf(req))));
app.get('/api/access/runtime', (_, res) => res.json({ accessControlEnabled: true, feishuLoginEnabled: false }));
app.get('/api/access/login-names', (_, res) => res.json({ names: names.slice(0, 2), snapshotAt: Date.now() }));
app.post('/api/access/logout', (_, res) => { res.cookie('ss_qa_actor', 'guest'); res.json(session('guest')); });
app.post('/api/access/login', (req, res) => {
  const actor = req.body.employeeName === names[1] ? 'external' : 'legacy';
  res.cookie('ss_qa_actor', actor, { sameSite: 'lax', httpOnly: true });
  res.json(session(actor));
});
const schedulesFor = (year, month, station = false) => {
  const days = new Date(year, month, 0).getDate();
  return Array.from({ length: days }, (_, i) => {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
    return { id: `qa-${date}`, recordId: `rec${year}${month}${i}`, dutyCode: null, scheduleDate: date,
      code: null, building: 'building_a', team: '甲', shift: 'white', personText: names.slice(0, 2).join('、'),
      dutyStaffReference: names.slice(0, 2), dutyStaffActual: names.slice(0, 2), remark: '', emergencyDuty: '', emergencyDutySchedule: '',
      leaveStaff: [], substituteStaff: [], actualDutyStaff: names.slice(0, 2).join('、'), buildingText: 'A楼', teamText: '甲',
      shiftText: '白班', createdAt: '', updatedAt: '',
      ...(station ? { building: 'station_110', buildingText: '110站', dutyStaffActual: stationNames, dutyStaffReference: stationNames, personText: stationNames.join('、'), actualDutyStaff: stationNames.join('、') } : {}),
    };
  });
};
app.get('/api/monthly-schedules/:year/:month', (req, res) => res.json({ year: +req.params.year, month: +req.params.month, schedules: schedulesFor(+req.params.year, +req.params.month, actorOf(req) === 'station') }));
app.get('/api/bitable/person-profiles', (_, res) => res.json({ organizations: [...names.map(name => ({ supervisorText: name, position: '值班员', buildingsSpecialties: ['A楼'], shift: '白班' })), ...stationNames.map(name => ({ supervisorText: name, position: '110站值班人员', buildingsSpecialties: ['110站'], shift: '白班' }))], changeRequestSubmitters: [] }));
app.get('/api/bitable/person-profile-details', (_, res) => res.json({ organizations: [] }));
app.get('/api/duty-schedules/work-calendar', (_, res) => res.json({ days: [], revision: 'qa' }));
app.get('/api/duty-schedules/emergency-duty', (_, res) => res.json({ schedules: [] }));
app.get('/api/duty-schedules/travel-staff', (_, res) => res.json({ success: true, total: 0, details: [] }));
app.get('/api/bitable/today-leave-staff', (req, res) => res.json({ date: req.query.date, buildings: [], totalLeaveCount: 0 }));
app.get('/api/bitable/schedule-snapshot-revision', (_, res) => res.json({ revision: 'qa' }));
for (const kind of ['festival', 'holiday']) app.get(`/api/bitable/${kind}-schedules`, (_, res) => res.json({ schedules: [] }));
app.get('/api/sealing-info/:year', (req, res) => res.json({ year: +req.params.year, sealingInfos: [], sealings: [] }));
app.get('/api/change-info/:year', (req, res) => res.json({ year: +req.params.year, changes: [] }));
app.get('/api/weather-warning/snapshot', (_, res) => res.json({ status: 'clear', sourceState: 'fresh', snapshotAt: new Date().toISOString(), guardLevel: null, matchedWarnings: [], unmatchedWarnings: [], actions: [], weather: null, checkSummary: { total: 0 }, features: { registrationEnabled: false } }));
app.post('/api/duty-schedules/leave-request', require('multer')().array('screenshot', 1), (req, res) => {
  try {
    const request = JSON.parse(req.body.payload);
    const actor = actorOf(req);
    const name = bindLeaveRequestApplicant(request.leaveStaffName, actors[actor], actor !== 'guest');
    assertStationApplicant(actor, name);
    if (actor === 'external') {
      require('../../server/common/access/self-service-applicant').assertSelfServicePersonnelIdentity(actors.external, {
        appId: 'cli_station_fixture', appToken: 'canonicalPersonApp', tableId: 'tblCanonicalPerson', recordId: 'recBrowserExternal', openId: 'ou_external',
      });
    }
    observations.push({ submission: true, name, clientMutationId: request.clientMutationId, outcome: resultMode, applicantMode: resolveLeaveRequestApplicant(actors[actor], actor !== 'guest').mode });
    setTimeout(() => {
      if (resultMode === 'success') {
        res.json({ ...request.expectedImpact, success: true, clientMutationId: request.clientMutationId,
          leaveStaffName: name, startAt: request.startAt, endAt: request.endAt,
          total: 1, created: 1, recordIds: ['recLeaveBrowser'], message: '隔离验收：请休假已提交',
        });
      } else {
        res.status(400).json({ message: '隔离验收：提交失败，草稿已保留', writeDisposition: 'definitely-not-written' });
      }
    }, 500);
  } catch (error) { res.status(error.getStatus?.() || 400).json({ message: error.message }); }
});
const { bindSelfServiceApplicant } = require('../../server/common/access/self-service-applicant');
const { ATTACHED_BANK, scoreAttachedBank, getAttachedBankDisplayType } = require('../../shared/mbti-attached-bank-model');
const personOf = actor => ({ recordId: actor === 'external' ? 'recBrowserExternal' : 'recBrowserFeishu', name: actors[actor].displayName, position: '值班员', buildings: ['A楼'] });
const fail = (res, error) => res.status(error.getStatus?.() || 400).json({ message: error.message });
app.get('/api/bitable/mbti-assessment/me', (req, res) => {
  const actor = actorOf(req);
  try {
    bindSelfServiceApplicant('', actors[actor], actor !== 'guest');
    if (actor === 'unmatched') return res.status(403).json({ message: '登录账号未唯一匹配到人员，请联系管理员核对' });
    res.json(personOf(actor));
  } catch (error) { fail(res, error); }
});
app.get('/api/bitable/mbti-assessment/people', (req, res) => res.json({ people: names.slice(0, 2).map((name, i) => ({ recordId: `recLegacy${i}`, name, buildings: ['A楼'], position: '值班员' })), stale: false }));
app.get('/api/bitable/mbti-assessment/onboarding', (_, res) => res.json({ recordId: 'recNewEmployee', name: '验收入职员工' }));
app.post('/api/bitable/mbti-assessment/submit', (req, res) => {
  const actor = actorOf(req);
  try {
    const value = req.body;
    if (value.audience === 'active') {
      value.name = bindSelfServiceApplicant(value.name, actors[actor], actor !== 'guest');
      if (actor !== 'legacy' && value.recordId !== personOf(actor).recordId) throw new Error('测试人员必须为当前登录本人');
    }
    const type = getAttachedBankDisplayType(scoreAttachedBank(value.version, value.answers));
    observations.push({ submission: 'mbti', actor, name: value.name, recordId: value.recordId, clientMutationId: value.clientMutationId, outcome: resultMode });
    if (resultMode === 'failure') return res.status(503).json({ message: '隔离验收：同步失败，请重试' });
    res.json({ recordId: value.recordId, type, syncState: 'success' });
  } catch (error) { fail(res, error); }
});
app.post('/api/duty-schedules/overtime-request', require('multer')().array('screenshot', 1), (req, res) => {
  const actor = actorOf(req);
  try {
    const value = JSON.parse(req.body.payload);
    const { bindWorkforceRequestApplicant } = require('../../server/common/access/workforce-request-applicant');
    const name = bindWorkforceRequestApplicant(value.staffName, actors[actor], actor !== 'guest', '提交加班申请');
    assertStationApplicant(actor, name);
    observations.push({ submission: 'overtime', actor, name, clientMutationId: value.clientMutationId, screenshotCount: req.files.length, outcome: resultMode });
    setTimeout(() => resultMode === 'failure' ? res.status(400).json({ message: '隔离验收：提交失败，草稿已保留', writeDisposition: 'definitely-not-written' }) : res.json({ success: true, created: 1, clientMutationId: value.clientMutationId, recordId: 'recBrowserOvertime', requestFingerprint: 'a'.repeat(64), impact: value.expectedImpact, message: '隔离验收：加班已提交' }), 500);
  } catch (error) { fail(res, error); }
});
app.get('/api/duty-schedules/change-request/people', (_, res) => res.json({ people: names.slice(0, 2).map((name, i) => ({ id: `cr-person-${i}`, name, description: 'A楼' })), snapshotAt: Date.now() }));
app.post('/api/duty-schedules/change-request', require('multer')().array('documents', 5), (req, res) => {
  const actor = actorOf(req);
  try {
    const value = typeof req.body.payload === 'string' ? JSON.parse(req.body.payload) : req.body;
    const name = bindSelfServiceApplicant(value.submitterName, actors[actor], actor !== 'guest');
    observations.push({ submission: 'change', actor, name, clientMutationId: value.clientMutationId, outcome: resultMode });
    setTimeout(() => resultMode === 'failure' ? res.status(400).json({ message: '隔离验收：提交失败，草稿已保留' }) : res.json({ success: true, clientMutationId: value.clientMutationId, record: { id: 'recChangeBrowser', recordId: 'recChangeBrowser', ...value }, message: '隔离验收：变更已提交' }), 500);
  } catch (error) { fail(res, error); }
});
app.use('/api', (_, res) => res.status(503).json({ message: '隔离验收未配置该模块' }));
const staticRoot = path.join(process.env.TEMP, 'nt-self-service-client-validation');
app.use(express.static(staticRoot));
app.get(/.*/, (_, res) => res.sendFile(path.join(staticRoot, 'index.html')));
const server = app.listen(43236, '127.0.0.1', () => console.log('self service fixture ready: synthetic data only, no external writes'));
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
