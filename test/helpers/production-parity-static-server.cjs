const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'output/production-parity-validation-20261010');
const client = path.join(out, 'client');
const records = ['electrical', 'hvac'].flatMap(name => require(path.join(root, `shared/${name}-thresholds.seed.json`)).records);
const date = '2026-10-09';
const weeklyRecord = { id: 'recParityWeekly', title: '2026年第41周-运维周报', date, weekLabel: '第41周', scope: '机房', nature: '管理类', source: 'nantong-weekly', documentUrl: null, updatedAt: new Date().toISOString(), hasActions: false, sectionTitles: [], searchText: '验收周报', resources: [] };
const requests = [];
const item = { recordId: 'recParityStock', sku: 'QA001', name: '验收库存条目', specification: '代表数据', brand: '', primaryCategory: '备件', secondaryCategory: '', building: 'A楼', location: '库位1', storageType: '库内', quantity: 12, minimumQuantity: 1, difference: 0, unit: '件', annualUsage: 0, value: 0, owners: [], lowStock: false, negativeStock: false, idle: false, pendingConfirmation: false };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/__qa/finish' && req.method === 'POST') {
    fs.writeFileSync(path.join(out, `requests-${Date.now()}.json`), JSON.stringify(requests, null, 2));
    res.end('closed'); server.close(); return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__innerapi__/')) {
    requests.push({ path: url.pathname, method: req.method });
    let value;
    if (req.method !== 'GET') { res.writeHead(405); res.end('No business writes in this fixture'); return; }
    if (url.pathname === '/api/access/session') value = { role: 'admin', accountType: 'local', accountId: 'parity-admin', purchaseBuilding: null, displayName: '产物验收管理员', principalFingerprint: 'parity-admin', expiresAt: Date.now() + 3600000, capabilities: { canEdit: true, canDelete: true, canForceRefresh: true, canAccessContracts: true } };
    if (url.pathname === '/api/access/feishu/config') value = { enabled: false };
    if (url.pathname === '/api/threshold-management/records') value = { records, revision: 1, updatedAt: new Date().toISOString(), syncResults: [], sourceSync: { state: 'ready' } };
    if (url.pathname === '/api/threshold-management/sync/source') value = { sourceSync: { state: 'ready' }, revision: 1 };
    if (url.pathname === '/api/threshold-management/adjustments') value = { records: [], revision: 1 };
    if (url.pathname === '/api/meeting-management/snapshot') value = { snapshotId: 'parity', updatedAt: new Date().toISOString(), syncState: 'ready', message: null, records: [weeklyRecord], latestActions: { date, newestReportDate: date, items: [] } };
    if (url.pathname === '/api/meeting-management/weekly/workspace') value = { meetings: [], jobs: [], people: [], peopleError: null, writeAccess: { enabled: true, message: null }, runtime: { ready: true, message: null, templateVersion: 'standalone-20261009-template-v3' }, schedule: { enabled: false, time: '08:30', weekday: 4, timezone: 'Asia/Shanghai' }, creationSchedule: { enabled: false, time: '02:00', timezone: 'Asia/Shanghai' } };
    if (url.pathname === '/api/meeting-management/records/recParityWeekly') value = { snapshotId: 'parity', meeting: { ...weeklyRecord, sections: [] }, documentState: 'ready' };
    if (url.pathname === '/api/inventory-management/stocktake/overview') value = { month: url.searchParams.get('month'), historyStartedAt: null, generation: null, buildings: ['A楼','B楼','C楼','D楼','E楼','H楼','110站'].map(building => ({ building, total: 3, confirmed: 0, differences: 0, status: 'open', shortfall: 0, review: { total: 3, confirmed: 0, differences: 0, surplus: 0, shortage: 0, matched: 0, status: 'open', shortfall: 0 } })) };
    if (url.pathname === '/api/inventory-management/stocktake/sheet') value = { month: url.searchParams.get('month'), building: url.searchParams.get('building'), scope: url.searchParams.get('scope'), status: 'open', version: 1, createdAt: new Date().toISOString(), completedAt: null, historyStartedAt: '', seed: 'qa', algorithm: 'sha256-rank-v1', inventoryCount: 3, randomTarget: 3, shortfall: 0, excludedRecordIds: [], lines: [0,1,2].map(i => ({ inventory: { ...item, recordId: item.recordId + i, name: item.name + i }, reasons: ['random'], movementIds: [], stockFingerprint: 'qa', version: 1, status: 'draft', actualQuantity: null, confirmer: null, note: '', updatedAt: new Date().toISOString(), confirmedAt: null, operatorFingerprint: null })) };
    if (url.pathname === '/api/inventory-management/stocktake/sync-status') value = { pending: 0, syncing: 0, success: 3, error: 0, message: '' };
    if (value !== undefined) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); return; }
    res.writeHead(404); res.end('Unbound fixture endpoint'); return;
  }
  const name = decodeURIComponent(url.pathname);
  const isPublic = name.startsWith('/assets/') || name.startsWith('/meeting-templates/');
  const base = isPublic ? path.join(root, 'client/public') : client;
  const file = path.resolve(base, '.' + (path.extname(name) ? name : '/index.html'));
  const rel = path.relative(base, file);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' }[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
server.listen(4198, '127.0.0.1', () => console.log('production parity static fixture ready: 4198; no external proxy or business writes'));
