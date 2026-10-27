'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { root, origin, port, aliases, compilerOptions } = require('./server.cjs');
const evidence = path.join(root, 'output/release-next-after-20261005-182903');
const preparedPath = path.join(evidence, 'alarm-review-real-entry-prepared-20261006-v2.json');
const resultPath = path.join(evidence, 'alarm-review-real-entry-result-20261006.json');
const plan = 'docs/engineering/alarm-review-real-entry-plan-2026-10-06.md';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const relative = file => path.relative(root, file).replace(/\\/g, '/');
function safeFile(file) { const actual = path.resolve(file); assert(!fs.lstatSync(actual).isSymbolicLink(), 'REPARSE_INPUT_REJECTED'); return actual; }
function bind(file) { file = safeFile(file); return { file: relative(file), sha256: hash(file) }; }
function checkBinding(input) { assert.equal(hash(path.resolve(root, input.file)), input.sha256, `INPUT_DRIFT:${input.file}`); }
function prepare() {
  const began = Date.now(), files = new Set(), ts = require('typescript');
  const previous = JSON.parse(fs.readFileSync(path.join(evidence, 'alarm-review-access-runtime-20261006-prepared-v4.json'), 'utf8'));
  for (const item of previous.inputs) { checkBinding(item); files.add(path.resolve(root, item.file)); }
  const add = file => files.add(safeFile(path.resolve(root, file)));
  add(path.join(evidence, 'alarm-review-real-entry-prepared-20261006.json'));
  const browserArgument = process.argv.find(value => value.startsWith('--browser-executable='));
  assert(browserArgument, 'EXPLICIT_EXISTING_BROWSER_REQUIRED');
  const executablePath = safeFile(browserArgument.slice('--browser-executable='.length));
  assert(path.isAbsolute(executablePath) && path.basename(executablePath) === 'chrome.exe', 'BROWSER_PATH_INVALID');
  const systemEnvironment = Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const versionRead = require('node:child_process').spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${executablePath.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { windowsHide: true, encoding: 'utf8', timeout: 5000, env: systemEnvironment });
  assert.equal(versionRead.status, 0, 'BROWSER_METADATA_READ_FAILED');
  const browserVersion = versionRead.stdout.trim(); assert(/^\d+\.\d+\.\d+\.\d+$/.test(browserVersion), 'BROWSER_VERSION_INVALID');
  add(executablePath);
  for (const file of ['entry.tsx', 'data.ts', 'platform-boundaries.tsx', 'server.cjs', 'verify.cjs']) add(path.join(__dirname, file));
  add(plan);
  const contrast = ['client/src/index.tsx', 'client/src/app-entry.tsx', 'client/src/app.tsx',
    'node_modules/@lark-apaas/client-toolkit/lib/components/AppContainer/index.js',
    'node_modules/@lark-apaas/client-toolkit/lib/components/ErrorRender/index.js',
    'node_modules/@lark-apaas/client-toolkit/lib/utils/getAxiosForBackend.js',
    'node_modules/@lark-apaas/client-toolkit/lib/utils/axiosConfig.js'];
  contrast.forEach(add);
  const tools = ['typescript', '@rspack/core', '@rspack/binding', 'postcss-loader', 'postcss', '@tailwindcss/postcss', '@tailwindcss/node', '@tailwindcss/oxide', 'ts-node', 'tsconfig-paths', 'playwright-core'];
  const toolEntries = tools.map(name => { const entry = require.resolve(name); add(entry); let directory = path.dirname(entry); while (!fs.existsSync(path.join(directory, 'package.json'))) { const parent = path.dirname(directory); assert(parent !== directory, 'PACKAGE_MANIFEST_MISSING'); directory = parent; } add(path.join(directory, 'package.json')); return { name, entry: relative(entry) }; });
  for (const name of ['@rspack/binding', '@tailwindcss/oxide']) {
    let directory = path.dirname(require.resolve(name)); while (!fs.existsSync(path.join(directory, 'package.json'))) directory = path.dirname(directory);
    const packageData = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    for (const optional of Object.keys(packageData.optionalDependencies || {}).filter(value => value.includes(`${process.platform}-${process.arch}`))) { const native = require.resolve(optional); add(native); toolEntries.push({ name: optional, entry: relative(native) }); }
  }
  for (const file of ['tsconfig.app.json', 'tsconfig.node.json', 'tsconfig.json', 'tailwind.config.ts', 'postcss.config.js', 'package.json', 'package-lock.json']) add(file);
  // Static import closure for project code + local SDK axios imports; no compilation.
  const seen = new Set(), queue = [path.join(__dirname, 'entry.tsx'), path.join(__dirname, 'data.ts'), ...contrast.map(file => path.resolve(root, file))];
  const resolveLocal = (specifier, parent) => {
    let candidate = specifier.startsWith('@/') ? path.join(root, 'client/src', specifier.slice(2)) : specifier.startsWith('@shared/') ? path.join(root, 'shared', specifier.slice(8)) : specifier.startsWith('.') ? path.resolve(path.dirname(parent), specifier) : null;
    if (!candidate) return null;
    return [candidate, ...['.ts', '.tsx', '.js', '.css', '.json'].map(ext => candidate + ext), ...['index.ts', 'index.tsx', 'index.js'].map(name => path.join(candidate, name))].find(file => fs.existsSync(file) && fs.statSync(file).isFile()) || null;
  };
  while (queue.length) {
    const file = queue.pop(); if (seen.has(file)) continue; seen.add(file); add(file);
    if (!/\.[cm]?[jt]sx?$|\.css$/.test(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    const specs = /\.css$/.test(file) ? [...source.matchAll(/@(?:import|config|source)\s+["']([^"']+)["']/g)].map(match => match[1]) : ts.preProcessFile(source, true, true).importedFiles.map(item => item.fileName);
    for (const specifier of specs) { const next = resolveLocal(specifier, file); if (next && !next.includes(path.sep + 'node_modules' + path.sep)) queue.push(next); else if (next) add(next); }
  }
  const syntax = [];
  for (const name of ['entry.tsx', 'data.ts', 'platform-boundaries.tsx']) { const file = path.join(__dirname, name); const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true); assert.equal(source.parseDiagnostics.length, 0, `SYNTAX:${name}`); syntax.push(name); }
  for (const name of ['server.cjs', 'verify.cjs']) { new (require('node:vm').Script)(fs.readFileSync(path.join(__dirname, name), 'utf8'), { filename: name }); syntax.push(name); }
  const freezes = [JSON.parse(fs.readFileSync(path.join(root, 'docs/engineering/alarm-review-custom-freeze-2026-10-05.json'), 'utf8')).directFiles,
    JSON.parse(fs.readFileSync(path.join(root, 'output/admin-configuration-check/source-freeze.json'), 'utf8')).frozenInputs];
  let frozenCount = 0; for (const inputs of freezes) for (const item of inputs) { checkBinding({ file: item.file || item.path, sha256: item.sha256 }); frozenCount++; }
  const inputs = [...files].sort().map(bind); const digest = crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const record = { kind: 'real-application-access-and-panorama-components-equivalent-single-route', status: 'prepared-not-compiled-not-run',
    beganAt: new Date(began).toISOString(), completedAt: new Date().toISOString(), elapsedMs: Date.now() - began,
    command: [process.execPath, relative(__filename), '--prepare'], node: { version: process.version, path: process.execPath, sha256: hash(process.execPath) },
    inputs, fingerprint: digest, toolEntries, syntax, frozenCount, browser: { executablePath, version: browserVersion, sha256: hash(executablePath), metadataSource: 'Windows PE ProductVersion, read-only; not launched' }, parentEnvironmentAllowlist: ['SystemRoot', 'WINDIR', 'PATH', 'TEMP', 'TMP', 'NODE_ENV=test'], aliases: Object.entries(aliases).map(([key, value]) => ({ key, value: relative(value) })),
    originalShellBindings: contrast.slice(0, 5).map(file => bind(path.resolve(root, file))),
    priorV4BindingsUnchanged: previous.inputs.length, compiled: false, browserStarted: false, externalCalls: 0,
    dependencyEvidence: { oldMarker: bind(path.join(root, '.deps-ready.json')), authoritativePhysicalTreeProven: false, gap: 'Legacy marker + exact tool entries are not a complete dependency tree proof. Release owner must bind an independent valid proof before execution acceptance. No dependency scan or installation performed.' },
    excluded: ['full app.tsx lazy-route graph', 'SDK AppContainer AuthProvider/safety/inspector/QueryProvider/IframeBridge/useAppInfo/telemetry', 'SDK ErrorRender platform reporting', 'real Feishu schema/writes', 'production performance P95', 'production build/deployment'],
    scenarios: ['PC admin real UI password login + single custom review', 'PC editor real UI password login + batch review', 'PC guest read-only', '390 editor custom reply/person keyboard/geometry', '390 guest read-only', 'PC editor actual accounts revocation + late accepted and people responses'],
  };
  assert(!fs.existsSync(preparedPath), 'PREPARED_EXISTS_NO_OVERWRITE');
  fs.writeFileSync(preparedPath, JSON.stringify(record, null, 2));
  process.stdout.write(JSON.stringify({ status: record.status, file: relative(preparedPath), sha256: hash(preparedPath), fingerprint: digest, inputCount: inputs.length, frozenCount, elapsedMs: record.elapsedMs }) + '\n');
}
async function waitFor(test, message, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(message); }
async function browserCases(browser, control, artifact, observations) {
  const requests = [], violations = [], errors = [];
  let expectRevocationRejection = false;
  const customReply = '合成复核结论：已经核查，待现场确认。';
  function assertTask(task, batch) {
    assert.deepEqual(task.items.map(item => item.recordId).sort(), batch ? ['recSyntheticAlarmA', 'recSyntheticAlarmB', 'recSyntheticAlarmC'] : ['recSyntheticAlarmA'], 'TASK_RECORD_SET_MISMATCH');
    assert.equal(task.outcome, '自定义回复'); assert.equal(task.customReply, customReply, 'TASK_CUSTOM_REPLY_MISMATCH');
    assert.equal(task.responsibleRecordId, 'recSyntheticPersonA', 'TASK_PERSON_ID_MISMATCH');
    assert(task.items.every(item => item.state === 'success'), 'TASK_NOT_SUCCESS');
  }
  async function context(width) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    await ctx.route('**/*', async route => { const url = new URL(route.request().url());
      if (url.origin === origin && !url.username && !url.password || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
      violations.push({ kind: 'browser-network-rejected', protocol: url.protocol, host: url.hostname, port: url.port }); await route.abort('blockedbyclient');
    });
    await ctx.addInitScript(() => { document.documentElement.classList.add('light'); });
    ctx.on('page', page => {
      page.on('pageerror', () => errors.push('pageerror'));
      page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) requests.push({ method: response.request().method(), path: url.pathname, status: response.status(), expectedAuthorizationRejection: expectRevocationRejection && url.pathname === '/api/bitable/alarm-human-reviews/people' && response.request().method() === 'GET' && [401, 403].includes(response.status()) }); });
    });
    const page = await ctx.newPage(); await page.goto(origin + '/today-operations-panorama');
    return { ctx, page };
  }
  const role = page => page.evaluate(() => window.__alarmEntryObservation?.role);
  async function login(page, wanted) {
    await page.getByRole('button', { name: /当前身份：.*打开身份切换菜单/ }).first().click();
    await page.getByRole('menuitem', { name: '输入密码切换身份' }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '统一权限登录' }) });
    await dialog.getByLabel('访问密码').fill(`synthetic-entry-${wanted}-123`);
    await dialog.getByRole('button', { name: '登录', exact: true }).click();
    await waitFor(async () => await role(page) === wanted, 'REAL_LOGIN_NOT_COMMITTED');
  }
  async function openList(page) {
    await page.getByRole('button', { name: /异常打标/ }).first().click();
    await page.getByRole('list', { name: '异常打标告警清单' }).waitFor();
  }
  const form = page => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: /^异常跟进/ }) });
  async function choose(page, batch = false) {
    if (batch) { await page.getByLabel('选择当前页异常').check(); await page.getByRole('button', { name: '批量跟进', exact: true }).click(); }
    else await page.getByRole('button', { name: '异常跟进', exact: true }).first().click();
    const dialog = form(page); await dialog.getByText('自定义回复', { exact: true }).click();
    await dialog.getByLabel('回复内容').fill('合成复核结论：已经核查，待现场确认。');
    const search = dialog.getByRole('combobox', { name: '搜索责任人' }); await search.fill('李 明');
    await dialog.getByRole('option', { name: /合成李明/ }).first().waitFor();
    await search.press('ArrowDown'); await search.press('Enter');
    await waitFor(async () => await dialog.locator('.alarm-review-person-selected').count() === 1, 'PERSON_STABLE_SELECTION_MISSING');
    return dialog;
  }
  async function geometry(page, dialog) {
    const boxes = await dialog.evaluate(element => {
      const rect = element.getBoundingClientRect(), close = element.querySelector('[aria-label="关闭异常跟进"]')?.getBoundingClientRect();
      const submit = [...element.querySelectorAll('button')].find(button => button.textContent.includes('提交复核'))?.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: innerWidth, overflow: element.scrollWidth > element.clientWidth + 1, close: close && { top: close.top, bottom: close.bottom }, submit: submit && { top: submit.top, bottom: submit.bottom }, height: innerHeight };
    });
    assert(boxes.left >= 0 && boxes.right <= boxes.width + 1 && !boxes.overflow, 'DIALOG_HORIZONTAL_OVERFLOW');
    assert(boxes.close && boxes.close.top >= 0 && boxes.close.bottom <= boxes.height, 'CLOSE_CLIPPED');
    assert(boxes.submit && boxes.submit.top >= 0 && boxes.submit.bottom <= boxes.height, 'SUBMIT_CLIPPED');
    await page.screenshot({ path: artifact(`geometry-${observations.length}.png`) }); return boxes;
  }
  for (const scenario of [ { name: 'pc-admin-single', width: 1440, identity: 'admin' }, { name: 'pc-editor-batch', width: 1440, identity: 'editor', batch: true }, { name: 'pc-guest', width: 1440 }, { name: '390-editor', width: 390, identity: 'editor' }, { name: '390-guest', width: 390 } ]) {
    const { ctx, page } = await context(scenario.width);
    try {
      const before = await control({ kind: 'state' });
      if (scenario.identity) await login(page, scenario.identity);
      await openList(page);
      if (!scenario.identity) {
        assert.equal(await page.getByRole('button', { name: '异常跟进', exact: true }).count(), 0); assert.equal(await page.getByRole('button', { name: '批量跟进', exact: true }).count(), 0); assert.equal(await page.getByLabel('选择当前页异常').count(), 0);
        const after = await control({ kind: 'state' }); assert.equal(after.tasks.length, before.tasks.length, 'GUEST_CREATED_TASK'); await page.screenshot({ path: artifact(`${scenario.name}.png`) });
      } else {
        const dialog = await choose(page, scenario.batch); const boxes = await geometry(page, dialog);
        const accepted = page.waitForResponse(response => response.url() === origin + '/api/bitable/alarm-human-reviews' && response.request().method() === 'POST');
        await dialog.getByRole('button', { name: '提交复核', exact: true }).click(); assert.equal((await accepted).status(), 201);
        await dialog.getByText(/复核已保存/).waitFor({ timeout: 15000 });
        const after = await control({ kind: 'state' }); assert.equal(after.tasks.length, before.tasks.length + 1, 'TASK_COUNT_MISMATCH');
        const task = after.tasks.at(-1); assertTask(task, scenario.batch);
        observations.push({ scenario: scenario.name, result: 'passed', boxes, taskCount: after.tasks.length });
      }
      if (!scenario.identity) observations.push({ scenario: scenario.name, result: 'passed' });
    } finally { await ctx.close(); }
  }
  const editor = await context(1440), admin = await context(1440);
  try {
    await login(editor.page, 'editor'); await login(admin.page, 'admin'); await openList(editor.page);
    await control({ kind: 'gate', name: 'accepted', hold: true });
    const dialog = await choose(editor.page); const before = await control({ kind: 'state' });
    const lateAccepted = editor.page.waitForResponse(response => response.url() === origin + '/api/bitable/alarm-human-reviews' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: '提交复核', exact: true }).click();
    await waitFor(async () => (await control({ kind: 'state' })).tasks.length === before.tasks.length + 1, 'ACCEPTED_NOT_DURABLE');
    await control({ kind: 'gate', name: 'people', hold: true });
    const latePeople = editor.page.evaluate(() => window.__alarmEntryObservation.readReviewPeople());
    await waitFor(async () => (await control({ kind: 'state' })).counts['GET /api/bitable/alarm-human-reviews/people'] > (before.counts['GET /api/bitable/alarm-human-reviews/people'] || 0), 'LATE_PEOPLE_NOT_STARTED');
    const disabled = await admin.page.evaluate(async () => {
      const snapshot = await (await fetch('/api/access/configuration', { credentials: 'same-origin' })).json();
      const response = await fetch('/api/access/configuration/accounts', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientMutationId: 'entry-revoke-editor-00000001', expectedRevision: snapshot.revision, id: 'local-editor-all', kind: 'local', name: '合成子管理员', role: 'editor', building: null, enabled: false }) });
      return response.status;
    });
    assert.equal(disabled, 201, 'REAL_ACCOUNTS_REVOKE_FAILED');
    expectRevocationRejection = true;
    const rejected = editor.page.waitForResponse(response => response.url().endsWith('/alarm-human-reviews/people') && [401, 403].includes(response.status()));
    const fresh = editor.page.evaluate(() => window.__alarmEntryObservation.readReviewPeople()); await rejected; assert.equal(await fresh, false);
    expectRevocationRejection = false;
    await waitFor(async () => await role(editor.page) === 'guest', 'REAL_INVALIDATION_NOT_COMMITTED');
    await waitFor(async () => await form(editor.page).count() === 0, 'REVOKED_FORM_STILL_OPEN');
    await control({ kind: 'gate', name: 'people', hold: false }); await latePeople;
    await control({ kind: 'gate', name: 'accepted', hold: false });
    assert.equal((await lateAccepted).status(), 201, 'LATE_ACCEPTED_NOT_DELIVERED');
    await editor.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await waitFor(async () => !(await editor.page.evaluate(() => sessionStorage.getItem('alarm-human-review-pending-request') || sessionStorage.getItem('alarm-human-review-active-task'))), 'REVOKED_PERSISTENT_STATE_RESURRECTED');
    assert.equal(await role(editor.page), 'guest'); assert.equal(await form(editor.page).count(), 0);
    assert.equal(await editor.page.getByRole('button', { name: '异常跟进', exact: true }).count(), 0); assert.equal(await editor.page.getByLabel('选择当前页异常').count(), 0);
    const after = await control({ kind: 'state' }); assert.equal(after.tasks.length, before.tasks.length + 1, 'REVOKED_DUPLICATE_WRITE');
    await waitFor(async () => (await control({ kind: 'state' })).tasks.at(-1).items.every(item => item.state === 'success'), 'REVOKED_ACCEPTED_WORKER_NOT_SUCCESS');
    assertTask((await control({ kind: 'state' })).tasks.at(-1), false);
    await editor.page.screenshot({ path: artifact('revoked.png') }); observations.push({ scenario: 'pc-revocation-late-response', result: 'passed', acceptedBeforeRevocation: true, actualGuardRejected: true });
  } finally { await control({ kind: 'gate', name: 'people', hold: false }); await control({ kind: 'gate', name: 'accepted', hold: false }); await editor.ctx.close(); await admin.ctx.close(); }
  assert.equal(violations.length, 0, 'BROWSER_NETWORK_VIOLATION'); assert.equal(errors.length, 0, 'BROWSER_PAGE_ERROR');
  assert(!requests.some(item => item.status >= 400 && !item.expectedAuthorizationRejection), 'UNEXPECTED_API_FAILURE');
  assert.equal(requests.filter(item => item.expectedAuthorizationRejection).length, 1, 'EXPECTED_GUARD_REJECTION_COUNT');
  return { requests, violations, errors };
}
async function run() {
  assert(process.argv.includes('--approved-run'), 'SEPARATE_RUNTIME_APPROVAL_REQUIRED');
  const prepared = JSON.parse(fs.readFileSync(preparedPath, 'utf8')); prepared.inputs.forEach(checkBinding);
  assert.equal(hash(process.execPath), prepared.node.sha256, 'NODE_DRIFT');
  assert(!fs.existsSync(resultPath), 'RESULT_EXISTS_NO_OVERWRITE');
  const os = require('node:os'), net = require('node:net');
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alarm-review-entry-')); assert(!/[^\x20-\x7e]/.test(directory));
  fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ scope: 'alarm-review-real-entry', pid: process.pid, directory: fs.realpathSync(directory) }));
  fs.mkdirSync(path.join(directory, 'bundle')); const output = path.join(directory, 'bundle');
  process.env = { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])), TEMP: directory, TMP: directory, NODE_ENV: 'test' };
  const parentPolicy = { rejectedNetwork: 0, rejectedWrites: 0 };
  const rejectNetwork = () => { parentPolicy.rejectedNetwork++; throw new Error('PARENT_NETWORK_REJECTED'); };
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const values = Array.isArray(args[0]) ? args[0] : args, target = values[0];
    if (!target || typeof target !== 'object' || target.path || target.host !== '127.0.0.1' || Number(target.port) !== port) rejectNetwork();
    return connect.apply(this, args);
  };
  require('node:tls').connect = rejectNetwork;
  const dns = require('node:dns');
  for (const name of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
    const original = dns[name]; if (typeof original === 'function') dns[name] = function (host, ...args) { if (name !== 'lookup' || host !== '127.0.0.1') rejectNetwork(); return original.call(this, host, ...args); };
    if (typeof dns.promises[name] === 'function') dns.promises[name] = async () => rejectNetwork();
    for (const Resolver of [dns.Resolver, dns.promises.Resolver]) if (typeof Resolver?.prototype[name] === 'function') Resolver.prototype[name] = rejectNetwork;
  }
  require('node:dgram').createSocket = rejectNetwork;
  function parentWrite(file) {
    const target = path.resolve(typeof file === 'string' ? file : require('node:url').fileURLToPath(file));
    const within = path.relative(directory, target);
    if (within === '' || !path.isAbsolute(within) && within !== '..' && !within.startsWith('..' + path.sep)) {
      for (let cursor = target; cursor !== path.dirname(directory); cursor = path.dirname(cursor)) if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('PARENT_REPARSE_REJECTED');
      return;
    }
    if (target === evidence || path.dirname(target) === evidence && /^alarm-review-real-entry-[A-Za-z0-9_.-]+\.(json|png)$/.test(path.basename(target))) return;
    parentPolicy.rejectedWrites++; throw new Error('PARENT_WRITE_REJECTED');
  }
  for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'rmdirSync', 'truncateSync', 'chmodSync', 'createWriteStream', 'mkdtempSync']) { const original = fs[name]; fs[name] = function (file, ...args) { parentWrite(file); return original.call(this, file, ...args); }; }
  const nativeOpen = fs.openSync; fs.openSync = function (file, flags, ...args) { if (typeof flags === 'number' ? flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND) : /[wa+]/.test(flags)) parentWrite(file); return nativeOpen.call(this, file, flags, ...args); };
  for (const module of [fs, fs.promises]) for (const name of ['writeFile', 'appendFile', 'mkdir', 'unlink', 'rmdir', 'truncate', 'chmod', 'mkdtemp']) { const original = module[name]; module[name] = function (file, ...args) { parentWrite(file); return original.call(this, file, ...args); }; }
  for (const module of [fs, fs.promises]) { const rename = module.rename; module.rename = function (from, to, ...args) { parentWrite(from); parentWrite(to); return rename.call(this, from, to, ...args); }; const rm = module.rm; module.rm = function (file, options, ...args) { parentWrite(file); if (options?.recursive) throw new Error('RECURSIVE_RM_REJECTED'); return rm.call(this, file, options, ...args); }; }
  const renameSync = fs.renameSync; fs.renameSync = function (from, to) { parentWrite(from); parentWrite(to); return renameSync.call(this, from, to); };
  const rmSync = fs.rmSync; fs.rmSync = function (file, options) { parentWrite(file); if (options?.recursive) throw new Error('RECURSIVE_RM_REJECTED'); return rmSync.call(this, file, options); };
  for (const module of [fs, fs.promises]) { const open = module.open; module.open = function (file, flags, ...args) { if (typeof flags === 'number' ? flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND) : /[wa+]/.test(flags)) parentWrite(file); return open.call(this, file, flags, ...args); }; }
  for (const name of ['copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync', 'symlink', 'symlinkSync']) if (typeof fs[name] === 'function') fs[name] = () => { parentPolicy.rejectedWrites++; throw new Error('PARENT_WRITE_ROUTE_REJECTED'); };
  for (const name of ['copyFile', 'cp', 'link', 'symlink']) if (typeof fs.promises[name] === 'function') fs.promises[name] = async () => { parentPolicy.rejectedWrites++; throw new Error('PARENT_WRITE_ROUTE_REJECTED'); };
  const began = Date.now(), observations = [], artifacts = [], phases = {}, diagnostics = []; let child, browser, outcome = 'failed', errorCode, state, closureModules, stage = 'component-compile';
  const safeCode = error => typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'NO_SAFE_ERROR_CODE';
  const cleanupState = { ownedDirectoryRemoved: false, childClosed: false, portRebound: false, retainedDirectory: undefined };
  function artifact(name) { const file = path.join(evidence, 'alarm-review-real-entry-' + name); assert(!fs.existsSync(file), 'ARTIFACT_EXISTS'); artifacts.push(file); return file; }
  try {
    const compileStart = Date.now(), { rspack } = require('@rspack/core');
    const compiler = rspack(compilerOptions(output));
    try { const stats = await new Promise((resolve, reject) => compiler.run((error, stats) => {
      if (error || stats?.hasErrors()) {
        const report = stats?.toJson({ all: false, errors: true })?.errors || [];
        diagnostics.push({ stage, code: safeCode(error), errorCount: report.length, modules: report.slice(0, 8).map(item => ({ code: safeCode(item), path: String(item.moduleName || '').split('!').at(-1).split('?')[0].replaceAll(root, '<project>').slice(0, 240) })) });
        reject(new Error('COMPONENT_COMPILE_FAILED'));
      } else resolve(stats);
    })); closureModules = stats.toJson({ all: false, modules: true, nestedModules: true }).modules; }
    finally { await new Promise((resolve, reject) => compiler.close(error => error ? reject(error) : resolve())); }
    phases.compileMs = Date.now() - compileStart; prepared.inputs.forEach(checkBinding);
    const assets = fs.readdirSync(output).map(name => ({ name, sha256: hash(path.join(output, name)) })); assert(assets.some(item => item.name === 'app.css') && assets.some(item => item.name === 'app.js'));
    stage = 'isolated-server-start'; const cp = require('node:child_process'), pending = new Map(); let seq = 0;
    child = cp.fork(path.join(__dirname, 'server.cjs'), [directory], { execPath: process.execPath, cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])) });
    const ready = new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('SERVER_READY_TIMEOUT')), 12000); child.on('message', value => { if (value.event === 'ready') { clearTimeout(timer); resolve(value); } if (value.event === 'failed') { diagnostics.push({ stage, childStage: value.stage, code: value.code }); clearTimeout(timer); reject(new Error(value.reason)); } if (value.id && pending.has(value.id)) { const item = pending.get(value.id); pending.delete(value.id); clearTimeout(item.timer); item.resolve(value); } }); child.once('exit', code => { if (code !== 0) reject(new Error('OWNED_SERVER_EXIT_FAILED')); }); });
    await ready;
    const control = message => new Promise((resolve, reject) => { const id = String(++seq); const timer = setTimeout(() => { pending.delete(id); reject(new Error('CONTROL_TIMEOUT')); }, 5000); pending.set(id, { resolve, timer }); child.send({ ...message, id }); });
    const { chromium } = require('playwright-core');
    stage = 'browser-launch'; assert.equal(hash(prepared.browser.executablePath), prepared.browser.sha256, 'BROWSER_BINARY_DRIFT');
    browser = await chromium.launch({ executablePath: prepared.browser.executablePath, headless: true, env: { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])), TEMP: directory, TMP: directory } });
    assert.equal(browser.version(), prepared.browser.version, 'BROWSER_VERSION_DRIFT');
    stage = 'browser-six-scenarios';
    const browserStart = Date.now(), browserProof = await browserCases(browser, control, artifact, observations); phases.browserMs = Date.now() - browserStart;
    state = await control({ kind: 'state' }); assert.equal(state.policy.networkRejected, 0); assert.equal(state.policy.writesRejected, 0); assert.equal(state.gateTimeouts, 0); assert.equal(parentPolicy.rejectedNetwork, 0); assert.equal(parentPolicy.rejectedWrites, 0); assert.equal(observations.length, 6);
    outcome = 'passed'; Object.assign(phases, { assets, browserProof });
  } catch (error) { errorCode = /^[A-Z0-9_:\-/\.]{1,160}$/.test(error.message) ? error.message : 'FIXTURE_EXECUTION_FAILED'; diagnostics.push({ stage, code: safeCode(error), errorCode }); }
  finally {
    let cleanupFailed = false;
    async function cleanStep(name, action) { try { await action(); } catch (error) { cleanupFailed = true; outcome = 'failed'; errorCode = errorCode || 'FIXTURE_CLEANUP_FAILED'; diagnostics.push({ stage: name, code: safeCode(error) }); } }
    await cleanStep('browser-close', async () => { if (browser) await browser.close(); });
    await cleanStep('owned-server-close', async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        if (child.connected) child.send({ kind: 'close' });
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('OWNED_SERVER_CLEANUP_TIMEOUT_NO_FORCE_KILL')), 12000); child.once('exit', () => { clearTimeout(timer); resolve(); }); });
      }
      cleanupState.childClosed = !child || child.exitCode !== null || child.signalCode !== null;
    });
    await cleanStep('source-after-run', async () => { const currentDrift = prepared.inputs.filter(item => hash(path.resolve(root, item.file)) !== item.sha256); if (currentDrift.length) { outcome = 'failed'; errorCode = 'INPUT_DRIFT_AFTER_RUN'; } });
    // Empty directory removal only; never recursive rm or deletion outside the freshly owned marker.
    function cleanup(folder) { assert(!fs.lstatSync(folder).isSymbolicLink()); for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const file = path.join(folder, entry.name); assert(!fs.lstatSync(file).isSymbolicLink()); if (entry.isDirectory()) cleanup(file); else { if (folder === directory) assert(/^(owner|configuration|ledger)\.json$/.test(entry.name) || entry.name.startsWith('playwright_'), 'UNKNOWN_ROOT_FILE_NO_DELETE'); fs.unlinkSync(file); } } fs.rmdirSync(folder); }
    if (!cleanupFailed) await cleanStep('owned-directory-cleanup', async () => { const marker = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8')); assert.equal(marker.pid, process.pid); assert.equal(marker.directory, fs.realpathSync(directory)); cleanup(directory); });
    cleanupState.ownedDirectoryRemoved = !fs.existsSync(directory); if (!cleanupState.ownedDirectoryRemoved) cleanupState.retainedDirectory = directory;
    await cleanStep('port-rebound', async () => { await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); }); cleanupState.portRebound = true; });
    const result = { kind: prepared.kind, outcome, errorCode, preparedSha256: hash(preparedPath), fingerprint: prepared.fingerprint, node: prepared.node, browser: prepared.browser, phases, diagnostics, observations, state, parentPolicy, compilerModules: closureModules, artifacts: artifacts.filter(file => fs.existsSync(file)).map(bind), childPid: child?.pid, cleanup: cleanupState, elapsedMs: Date.now() - began, dependencyProofGap: prepared.dependencyEvidence.gap, productionAppShellCovered: false, externalSchemaCovered: false };
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2)); process.stdout.write(JSON.stringify({ outcome, errorCode, result: relative(resultPath), sha256: hash(resultPath), elapsedMs: result.elapsedMs }) + '\n');
    if (outcome !== 'passed') process.exitCode = 1;
  }
}
if (process.argv.includes('--prepare')) prepare();
else if (process.argv.includes('--run')) run().catch(() => { process.stderr.write('FIXTURE_PRECONDITION_OR_CLEANUP_FAILED\n'); process.exitCode = 1; });
else throw new Error('EXPLICIT_PREPARE_OR_APPROVED_RUN_REQUIRED');
