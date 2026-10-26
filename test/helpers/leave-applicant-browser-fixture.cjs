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
app.use(express.json());
const names = ['验收员工甲', '验收员工乙', ...Array.from({ length: 1200 }, (_, i) => `验收人员${i}`)];
const actors = {
  guest: { role: 'guest', purchaseBuilding: null },
  feishu: { role: 'admin', purchaseBuilding: null, accountId: 'feishu-' + 'a'.repeat(64), displayName: names[0] },
  external: { role: 'guest', purchaseBuilding: null, accountId: 'local-external-' + 'b'.repeat(64), displayName: names[1] },
  member: { role: 'site_member', purchaseBuilding: null, accountId: 'feishu-' + 'e'.repeat(64), displayName: names[0] },
  legacy: { role: 'admin', purchaseBuilding: null, accountId: 'local-admin', displayName: '管理员' },
  missing: { role: 'admin', purchaseBuilding: null, accountId: 'feishu-' + 'c'.repeat(64) },
  unmatched: { role: 'admin', purchaseBuilding: null, accountId: 'feishu-' + 'd'.repeat(64), displayName: '未维护验收人员' },
};
const actorOf = req => /qa_actor=([a-z]+)/.exec(req.headers.cookie || '')?.[1] || 'guest';
const session = actor => {
  const principal = actors[actor] || actors.guest;
  return { ...principal,
    expiresAt: actor === 'guest' ? null : Date.now() + 3600000,
    principalFingerprint: actor === 'guest' ? null : 'qa-fingerprint-' + actor,
    pagePaths: ['/nantong-base', '/monthly-schedule'],
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
  res.cookie('qa_actor', actor, { sameSite: 'lax', httpOnly: true });
  res.redirect('/monthly-schedule');
});
app.get('/api/access/session', (req, res) => res.json(session(actorOf(req))));
app.get('/api/access/runtime', (_, res) => res.json({ accessControlEnabled: true, feishuLoginEnabled: false }));
app.get('/api/access/login-names', (_, res) => res.json({ names: names.slice(0, 2), snapshotAt: Date.now() }));
app.post('/api/access/logout', (_, res) => { res.cookie('qa_actor', 'guest'); res.json(session('guest')); });
app.post('/api/access/login', (req, res) => {
  const actor = req.body.employeeName === names[1] ? 'external' : 'legacy';
  res.cookie('qa_actor', actor, { sameSite: 'lax', httpOnly: true });
  res.json(session(actor));
});
const schedulesFor = (year, month) => {
  const days = new Date(year, month, 0).getDate();
  return Array.from({ length: days }, (_, i) => {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`;
    return { id: `qa-${date}`, recordId: `rec${year}${month}${i}`, dutyCode: null, scheduleDate: date,
      code: null, building: 'building_a', team: '甲', shift: 'white', personText: names.slice(0, 2).join('、'),
      dutyStaffReference: names.slice(0, 2), dutyStaffActual: names.slice(0, 2), remark: '', emergencyDuty: '', emergencyDutySchedule: '',
      leaveStaff: [], substituteStaff: [], actualDutyStaff: names.slice(0, 2).join('、'), buildingText: 'A楼', teamText: '甲',
      shiftText: '白班', createdAt: '', updatedAt: '',
    };
  });
};
app.get('/api/monthly-schedules/:year/:month', (req, res) => res.json({ year: +req.params.year, month: +req.params.month, schedules: schedulesFor(+req.params.year, +req.params.month) }));
app.get('/api/bitable/person-profiles', (_, res) => res.json({ organizations: names.map(name => ({ supervisorText: name, position: '值班员', buildingsSpecialties: ['A楼'], shift: '白班' })), changeRequestSubmitters: [] }));
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
app.use('/api', (_, res) => res.status(503).json({ message: '隔离验收未配置该模块' }));
const server = app.listen(43226, '127.0.0.1', () => console.log('leave applicant fixture ready: synthetic data only, no external writes'));
process.once('SIGINT', () => server.close());
process.once('SIGTERM', () => server.close());
