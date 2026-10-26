'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { root, origin, port, aliases } = require('../alarm-review-overlay-fix-v1/server.cjs');
const evidence = path.join(root, 'output/release-next-after-20261005-182903');
const preparedPath = path.join(evidence, 'alarm-review-real-entry-person-position-prepared-20261006-v2.json');
const resultPath = path.join(evidence, 'alarm-review-real-entry-person-position-result-20261006-v2.json');
const plan = 'docs/engineering/alarm-review-person-position-v2-plan-2026-10-06.md';
const original = path.join(root, 'test/visual/alarm-review-real-entry');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const relative = file => path.relative(root, file).replace(/\\/g, '/');
function safeFile(file) { const actual = path.resolve(file); assert(!fs.lstatSync(actual).isSymbolicLink(), 'REPARSE_INPUT_REJECTED'); return actual; }
function bind(file) { file = safeFile(file); return { file: relative(file), sha256: hash(file) }; }
function checkBinding(input) { assert.equal(hash(path.resolve(root, input.file)), input.sha256, `INPUT_DRIFT:${input.file}`); }

function diagnosticCode(error) {
  return typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) && !/SECRET|TOKEN|PASSWORD|COOKIE/.test(error.code) ? error.code : 'NO_SAFE_ERROR_CODE';
}
function diagnosticSummary(error) {
  const seen = new Set(), nodes = []; let current = error;
  for (let i = 0; current && i < 5 && !seen.has(current); i++) {
    seen.add(current); nodes.push(current); current = typeof current === 'object' ? current.cause || current.error : null;
  }
  const node = [...nodes].reverse().find(value => value?.name === 'CssSyntaxError') || nodes.at(-1) || {};
  const message = typeof node === 'string' ? node : String(node.reason || node.message || '');
  let reason = 'UNKNOWN_REASON_NOT_EXPOSED', reasonGap = true;
  if (/Failed to find ['"]@\/inspector\.dev\.css['"]/.test(message)) { reason = "Failed to find '@/inspector.dev.css'"; reasonGap = false; }
  else if (/Cannot find module/.test(message)) { reason = 'Cannot find module (identifier omitted)'; reasonGap = false; }
  else if (/Module not found/.test(message)) { reason = 'Module not found (identifier omitted)'; reasonGap = false; }
  const rawPath = String(error?.moduleName || '').split('!').at(-1).split('?')[0].replace(/\\/g, '/').replace(/^\.\//, '');
  const modulePath = /^(client|server|shared|test|node_modules)\/[A-Za-z0-9_@./-]+$/.test(rawPath) && !/(secret|token|password|cookie)/i.test(rawPath) && !rawPath.split('/').includes('..') ? rawPath.slice(0, 240) : '<unavailable-or-private>';
  const name = ['CssSyntaxError', 'Error', 'TypeError', 'ModuleBuildError', 'ModuleNotFoundError'].includes(node.name) ? node.name : 'UnknownError';
  const position = key => Number.isSafeInteger(node[key]) && node[key] > 0 ? node[key] : undefined;
  return { path: modulePath, name, code: diagnosticCode(node), reason: reason.slice(0, 400), reasonGap, line: position('line'), column: position('column'), causeDepth: nodes.length, causeTraversalTruncated: Boolean(current && nodes.length === 5) };
}

function retainOwned(directory, state) {
  state.ownedDirectoryRemoved = false; state.retainedDirectory = directory; state.retentionReason = 'PROMISE_ONLY_DIAGNOSTIC_NO_DELETION';
  return { outcome: 'failed', errorCode: 'OWNED_DIRECTORY_INTENTIONALLY_RETAINED' };
}
function promiseRm(native, validate, recursiveRejected) {
  return function (file, options, ...args) {
    try { validate(file); if (options?.recursive) recursiveRejected(); return native.call(this, file, options, ...args); }
    catch (error) { return Promise.reject(error); }
  };
}
function browserFailureSummary(error) {
  const message = String(error?.message || '');
  const categories = [
    ['Target page, context or browser has been closed', 'BROWSER_TARGET_CLOSED'],
    ['Failed to launch', 'BROWSER_LAUNCH_FAILED'], ['executable doesn', 'BROWSER_EXECUTABLE_MISSING'],
    ['ProcessSingleton', 'BROWSER_PROFILE_SINGLETON'], ['Timeout', 'BROWSER_TIMEOUT'],
    ['EPERM', 'BROWSER_PERMISSION_DENIED'], ['EACCES', 'BROWSER_PERMISSION_DENIED'],
    ['RECURSIVE_RM_REJECTED', 'RECURSIVE_RM_REJECTED'],
  ];
  const reason = categories.find(([pattern]) => message.includes(pattern))?.[1] || 'UNKNOWN_BROWSER_REASON_NOT_EXPOSED';
  const exit = /<process did exit: exitCode=(-?\d+|null), signal=(null|SIG[A-Z]+)>/.exec(message);
  const pid = /<launched> pid=(\d+)/.exec(message);
  return { reason, reasonGap: reason === 'UNKNOWN_BROWSER_REASON_NOT_EXPOSED', code: diagnosticCode(error),
    browserPid: pid ? Number(pid[1]) : null, browserExitCode: exit && exit[1] !== 'null' ? Number(exit[1]) : null,
    browserSignal: exit?.[2] || null };
}
const READY_BUDGET_MS = 60000, READY_OBSERVATION_MS = 12000;
function observeServerReady(child, report, options = {}) {
  const now = options.now || Date.now, schedule = options.schedule || setTimeout, cancel = options.cancel || clearTimeout;
  const started = now(); let soft, hard, settled = false, stage = 'early-isolation';
  return new Promise((resolve, reject) => {
    const finish = (error, value) => { if (settled) return; settled = true; cancel(soft); cancel(hard); child.removeListener('message', message); child.removeListener('exit', exit); if (error) reject(error); else resolve(value); };
    const message = value => {
      if (value?.event === 'startup-phase' && ['early-isolation', 'application-imports', 'nest-module-compile', 'nest-http-listen'].includes(value.stage)) stage = value.stage;
      if (value?.event === 'ready') finish(null, value);
      if (value?.event === 'failed') { report({ event: 'server-start-failed', stage, code: diagnosticCode(value) }); finish(new Error('ISOLATED_SERVER_START_FAILED')); }
    };
    const exit = () => finish(new Error('OWNED_SERVER_EXIT_BEFORE_READY'));
    child.on('message', message); child.once('exit', exit);
    soft = schedule(() => { if (!settled) report({ event: 'startup-deadline-observation', elapsedMs: now() - started, stage }); }, options.softMs ?? READY_OBSERVATION_MS);
    hard = schedule(() => finish(new Error('SERVER_READY_TIMEOUT')), options.timeoutMs ?? READY_BUDGET_MS);
  });
}
function queueSafeClose(child, ready) {
  let sent = false;
  const send = () => { if (!sent && child.connected) { sent = true; child.send({ kind: 'close' }); } };
  const message = value => { if (value?.event === 'ready') { child.removeListener('message', message); send(); } };
  if (ready) send(); else child.on('message', message);
  return () => child.removeListener('message', message);
}
function preserveAssets(phases, assets) {
  assert(assets.some(x => x.name === 'app.js') && assets.some(x => x.name === 'app.css'), 'REQUIRED_ASSETS_MISSING');
  assert(assets.every(x => /^[a-f0-9]{64}$/.test(x.sha256)), 'ASSET_HASH_INVALID'); phases.assets = assets;
}
async function waitFor(test, message, timeout = 12000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await test()) return; await new Promise(resolve => setTimeout(resolve, 40)); } throw new Error(message); }
const loginStageIds = new Set(['identity', 'menu', 'password', 'submit', 'role']);
function loginSnapshot(id, raw = {}) {
  const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : null;
  const bool = value => typeof value === 'boolean' ? value : null;
  return { locatorId: loginStageIds.has(id) ? id : 'unknown', count: count(raw.count), visible: bool(raw.visible), enabled: bool(raw.enabled),
    rootChildren: count(raw.rootChildren), role: ['guest', 'admin', 'editor'].includes(raw.role) ? raw.role : 'unknown',
    boundaryFailed: bool(raw.boundaryFailed), loginDialog: bool(raw.loginDialog) };
}
function loginLocator(page, id) {
  if (id === 'identity') return page.getByRole('button', { name: /当前身份：.*打开身份切换菜单/ }).first();
  if (id === 'menu') return page.getByRole('menuitem', { name: '输入密码切换身份' });
  const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '统一权限登录' }) });
  if (id === 'password') return dialog.getByLabel('访问密码');
  if (id === 'submit') return dialog.getByRole('button', { name: '登录', exact: true });
  return null;
}
function actionabilitySnapshot(error, raw = {}) {
  const message = typeof error?.message === 'string' ? error.message : '';
  const checks = [['intercept', /intercepts pointer events/i], ['not-stable', /element is not stable/i], ['not-visible', /element is not visible/i], ['out-of-viewport', /element is outside of the viewport/i], ['detached', /element (?:was detached|is not attached)|error:notconnected/i]];
  const category = checks.find(([, pattern]) => pattern.test(message))?.[0] || 'unknown';
  const bool = value => typeof value === 'boolean' ? value : 'unknown';
  const pointer = value => ['auto', 'none', 'other', 'unknown'].includes(value) ? value : 'unknown';
  const zIndex = value => Number.isSafeInteger(value) && value >= -2147483648 && value <= 2147483647 ? value : 'unknown';
  return { errorCategory: category, centerInViewport: bool(raw.centerInViewport), centerHitsButton: bool(raw.centerHitsButton),
    hitKind: ['dialog-overlay', 'dialog-content', 'dropdown-content', 'other', 'unknown'].includes(raw.hitKind) ? raw.hitKind : 'unknown',
    bodyPointer: pointer(raw.bodyPointer), buttonPointer: pointer(raw.buttonPointer), zIndex: zIndex(raw.zIndex),
    menuCount: Number.isSafeInteger(raw.menuCount) && raw.menuCount >= 0 && raw.menuCount <= 100000 ? raw.menuCount : 'unknown' };
}
function submitActionabilityDOM(button) {
  const rect = button.getBoundingClientRect(), x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const centerInViewport = rect.width > 0 && rect.height > 0 && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
  const hit = centerInViewport ? document.elementFromPoint(x, y) : null;
  const layer = hit?.closest('[data-slot="dialog-overlay"],[data-slot="dialog-content"],[data-slot="dropdown-menu-content"]');
  const slot = layer?.getAttribute('data-slot'), map = { 'dialog-overlay': 'dialog-overlay', 'dialog-content': 'dialog-content', 'dropdown-menu-content': 'dropdown-content' };
  const pointer = node => { const value = node ? getComputedStyle(node).pointerEvents : null; return value === null ? 'unknown' : value === 'auto' || value === 'none' ? value : 'other'; };
  const z = getComputedStyle(button).zIndex;
  return { centerInViewport, centerHitsButton: Boolean(hit && (hit === button || button.contains(hit))),
    hitKind: hit ? map[slot] || 'other' : 'unknown', bodyPointer: pointer(document.body), buttonPointer: pointer(button),
    zIndex: /^-?\d+$/.test(z) ? Number(z) : 'unknown', menuCount: document.querySelectorAll('[data-slot="dropdown-menu-content"][role="menu"]').length };
}

async function captureLoginState(page, id, error) {
  let timer;
  const fallback = loginSnapshot(id);
  if (id === 'submit') fallback.actionability = actionabilitySnapshot(error);
  try {
    return await Promise.race([ (async () => {
      const locator = loginLocator(page, id);
      const count = locator ? await locator.count() : null;
      const visible = count ? await locator.isVisible() : false;
      const enabled = count ? await locator.isEnabled() : false;
      const dom = await page.evaluate(() => ({
        rootChildren: document.querySelector('#root')?.childElementCount || 0,
        role: window.__alarmEntryObservation?.role,
        boundaryFailed: [...document.querySelectorAll('main[role="alert"]')].some(node => ['页面加载失败', '当前页面暂时不可用'].some(text => node.textContent.includes(text))),
        loginDialog: [...document.querySelectorAll('[role="dialog"] h2')].some(node => node.textContent === '统一权限登录')
      }));
      const state = loginSnapshot(id, { count, visible, enabled, ...dom });
      if (id === 'submit') state.actionability = actionabilitySnapshot(error, await locator.evaluate(submitActionabilityDOM));
      return state;
    })(), new Promise(resolve => { timer = setTimeout(() => resolve(fallback), 1000); }) ]);
  } catch { return fallback; } finally { clearTimeout(timer); }
}
async function observedLoginStep(id, action, sample, checkpoint) {
  assert(loginStageIds.has(id), 'UNKNOWN_LOGIN_STAGE');
  checkpoint('login-step-start', { loginStage: id });
  try { const result = await action(); checkpoint('login-step-complete', { loginStage: id }); return result; }
  catch (error) {
    const sampled = await sample(error), state = loginSnapshot(id, sampled);
    const details = { loginStage: id, state };
    if (id === 'submit') details.actionability = actionabilitySnapshot(error, sampled.actionability);
    checkpoint('login-step-failed', details);
    throw error;
  }
}

async function browserCases(browser, control, artifact, observations, partialProof, checkpoint, stop) {
  const requests = [], violations = [], errors = [], cdpErrors = [], sessions = new Map(), closures = new WeakMap(), bound = bundleModules();
  Object.assign(partialProof, { requests, violations, errors, cdpErrors });
  function closeContext(ctx) {
    if (closures.has(ctx)) return closures.get(ctx);
    const task = (async () => { try { const cdp = sessions.get(ctx); if (cdp) { checkpoint('cdp-detach-start'); await cdp.detach(); checkpoint('cdp-detach-complete'); sessions.delete(ctx); } } finally { await ctx.close(); } })();
    closures.set(ctx, task); return task;
  }
  Object.defineProperty(partialProof, 'closeContexts', { value: async () => { for (const ctx of sessions.keys()) await closeContext(ctx); }, enumerable: false });
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
    ctx.on('page', page => {
      page.on('pageerror', error => { const summary = pageErrorSummary(error, bound); errors.push(summary); checkpoint('pageerror', { error: summary }); stop(new Error('BROWSER_PAGE_ERROR_STOPPED')); });
      page.on('response', response => { const url = new URL(response.url()); if (url.pathname.startsWith('/api/')) requests.push({ method: response.request().method(), path: url.pathname, status: response.status(), expectedAuthorizationRejection: expectRevocationRejection && url.pathname === '/api/bitable/alarm-human-reviews/people' && response.request().method() === 'GET' && [401, 403].includes(response.status()) }); });
    });
    const page = await ctx.newPage(); checkpoint('cdp-session-start'); const cdp = await ctx.newCDPSession(page); sessions.set(ctx, cdp);
    cdp.on('Runtime.exceptionThrown', payload => { const summary = cdpExceptionSummary(payload.exceptionDetails, bound); cdpErrors.push(summary); checkpoint('cdp-exception', { error: summary, order: cdpErrors.length }); stop(new Error('BROWSER_CDP_ERROR_STOPPED')); });
    checkpoint('cdp-runtime-enable-start'); await cdp.send('Runtime.enable'); checkpoint('cdp-runtime-enable-complete');
    checkpoint('page-goto-start'); await page.goto(origin + '/today-operations-panorama'); checkpoint('page-goto-complete');
    return { ctx, page };
  }
  const role = page => page.evaluate(() => window.__alarmEntryObservation?.role);
  async function login(page, wanted) {
    const step = (id, action) => observedLoginStep(id, action, error => captureLoginState(page, id, error), checkpoint);
    await step('identity', () => page.getByRole('button', { name: /当前身份：.*打开身份切换菜单/ }).first().click());
    await step('menu', () => page.getByRole('menuitem', { name: '输入密码切换身份' }).click());
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '统一权限登录' }) });
    await step('password', () => dialog.getByLabel('访问密码').fill(`synthetic-entry-${wanted}-123`));
    const loginHit = await dialog.getByRole('button', { name: '登录', exact: true }).evaluate(submitActionabilityDOM);
    assert.equal(loginHit.centerHitsButton, true, 'LOGIN_CENTER_OBSCURED');
    const loginResponse = page.waitForResponse(response => response.url() === origin + '/api/access/login' && response.request().method() === 'POST');
    await step('submit', () => dialog.getByRole('button', { name: '登录', exact: true }).click());
    assert.equal((await loginResponse).status(), 201, 'LOGIN_POST_NOT_ACCEPTED');
    await step('role', () => waitFor(async () => await role(page) === wanted, 'REAL_LOGIN_NOT_COMMITTED'));
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
    const search = dialog.getByRole('combobox', { name: '搜索示例人员019' }); await search.fill('李 明');
    await dialog.getByRole('option', { name: /合成李明/ }).first().waitFor();
    let personStage = 'person-keyboard';
    checkpoint('person-check-start', { personStage });
    try {
      await search.press('ArrowDown'); await search.press('Home');
      const activeFirst = dialog.getByRole('option', { name: /合成李明/ }).first();
      const selected = { ariaSelected: await activeFirst.getAttribute('aria-selected'), recordId: await activeFirst.getAttribute('data-value') };
      assertFirstPerson(selected);
      await search.press('Enter');
      personStage = 'selected-identity';
      checkpoint('person-check-start', { personStage });
      const picked = dialog.locator('.alarm-review-person-selected');
      const selectedSpan = picked.locator(':scope > span');
      await selectedSpan.waitFor({ state: 'visible' });
      assert.equal(await selectedSpan.count(), 1, 'SELECTED_PERSON_NAME_NOT_UNIQUE');
      assertPickedPerson(await selectedSpan.evaluate(readSelectedPerson));
      checkpoint('person-check-complete', { personStage });
    } catch (error) {
      checkpoint('person-check-failed', { personStage, code: diagnosticCode(error) });
      throw error;
    }
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
      if (scenario.name === 'pc-admin-single' || scenario.name === '390-editor') {
        const native = page.locator('dialog.today-panorama-rack-usage-dialog');
        assert.equal(await native.count(), 1, 'ACTUAL_CLOSED_NATIVE_MISSING');
        assert.equal(await native.evaluate(element => element.open), false, 'ACTUAL_CLOSED_NATIVE_OPEN');
        await page.getByRole('button', { name: '查看各楼机柜上架率明细', exact: true }).click();
        assert.equal(await native.evaluate(element => element.matches(':modal')), true, 'ACTUAL_RACK_TOP_LAYER_MISSING');
        await page.getByRole('button', { name: '关闭各楼机柜上架率', exact: true }).click();
        assert.equal(await native.evaluate(element => element.open), false, 'ACTUAL_RACK_NOT_CLOSED');
        checkpoint('actual-native-open-close', { scenario: scenario.name });
      }
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
    } finally { await closeContext(ctx); }
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
  } finally { await control({ kind: 'gate', name: 'people', hold: false }); await control({ kind: 'gate', name: 'accepted', hold: false }); try { await closeContext(editor.ctx); } finally { await closeContext(admin.ctx); } }
  assert.equal(violations.length, 0, 'BROWSER_NETWORK_VIOLATION'); assert.equal(errors.length, 0, 'BROWSER_PAGE_ERROR');
  assert(!requests.some(item => item.status >= 400 && !item.expectedAuthorizationRejection), 'UNEXPECTED_API_FAILURE');
  assert.equal(requests.filter(item => item.expectedAuthorizationRejection).length, 1, 'EXPECTED_GUARD_REJECTION_COUNT');
  return { requests, violations, errors };
}

function bundleModules() {
  assert(activeBundleJs && /^[a-f0-9]{64}$/.test(activeBundleJs.sha256), 'CURRENT_JS_NOT_BOUND');
  assert.equal(hash(activeBundleJs.file), activeBundleJs.sha256, 'CURRENT_JS_DRIFT');
  const lines = fs.readFileSync(activeBundleJs.file, 'utf8').split(/\r?\n/), modules = [];
  lines.forEach((line, i) => {
    const match = /^"(\.\/[^"]+)"\(__unused_rspack_module,/.exec(line);
    if (match && /^\.\/(client|shared|test|node_modules)\/[A-Za-z0-9_@./-]+$/.test(match[1])) modules.push({ id: match[1], line: i + 1 });
  });
  return { lines, modules };
}
function pageErrorSummary(error, bound) {
  const name = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError'].includes(error?.name) ? error.name : 'UnknownError';
  const code = ['ERR_MODULE_NOT_FOUND', 'ERR_INVALID_ARG_TYPE'].includes(error?.code) ? error.code : 'NO_SAFE_ERROR_CODE';
  const reason = name === 'ReferenceError' && error?.message === 'process is not defined' ? 'PROCESS_NOT_DEFINED' : 'UNKNOWN_PAGE_ERROR';
  const match = /http:\/\/127\.0\.0\.1:39894\/app\.js:(\d+):(\d+)(?=[)\s]|$)/.exec(String(error?.stack || ''));
  let line = null, column = null, moduleId = null;
  if (match) {
    const l = Number(match[1]), c = Number(match[2]);
    if (Number.isSafeInteger(l) && l > 0 && l <= bound.lines.length && Number.isSafeInteger(c) && c > 0 && c <= bound.lines[l - 1].length + 1) {
      line = l; column = c; moduleId = bound.modules.filter(item => item.line <= l).at(-1)?.id || null;
    }
  }
  return { name, code, reason, line, column, moduleId };
}
function cdpExceptionSummary(details, bound) {
  const names = ['Error', 'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'EvalError', 'URIError'];
  const name = names.includes(details?.exception?.className) ? details.exception.className : 'UnknownError';
  const frames = Array.isArray(details?.stackTrace?.callFrames) ? details.stackTrace.callFrames : [];
  const candidates = [...frames, ...(details?.url !== undefined ? [details] : [])];
  let sourcePresent = false, droppedFrames = 0, location = null;
  for (const frame of candidates) {
    if (frame?.url !== origin + '/app.js') { droppedFrames++; continue; }
    sourcePresent = true;
    const l = frame.lineNumber, c = frame.columnNumber;
    if (!Number.isSafeInteger(l) || !Number.isSafeInteger(c) || l < 0 || c < 0 || l >= bound.lines.length || c >= bound.lines[l].length + 1) { droppedFrames++; continue; }
    if (!location) {
      const line = l + 1, column = c + 1;
      const index = bound.modules.findIndex((item, i) => item.line <= line && bound.modules[i + 1]?.line > line);
      location = { line, column, moduleId: index >= 0 ? bound.modules[index].id : null };
    }
  }
  return { name, location, sourcePresent, droppedFrames };
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
  const nativePromiseRm = fs.promises.rm;
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
  fs.promises.rm = promiseRm(nativePromiseRm, parentWrite, () => { parentPolicy.rejectedWrites++; throw new Error('RECURSIVE_RM_REJECTED'); });
  const renameSync = fs.renameSync; fs.renameSync = function (from, to) { parentWrite(from); parentWrite(to); return renameSync.call(this, from, to); };
  const rmSync = fs.rmSync; fs.rmSync = function (file, options) { parentWrite(file); if (options?.recursive) throw new Error('RECURSIVE_RM_REJECTED'); return rmSync.call(this, file, options); };
  for (const module of [fs, fs.promises]) { const open = module.open; module.open = function (file, flags, ...args) { if (typeof flags === 'number' ? flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND) : /[wa+]/.test(flags)) parentWrite(file); return open.call(this, file, flags, ...args); }; }
  for (const name of ['copyFile', 'copyFileSync', 'cp', 'cpSync', 'link', 'linkSync', 'symlink', 'symlinkSync']) if (typeof fs[name] === 'function') fs[name] = () => { parentPolicy.rejectedWrites++; throw new Error('PARENT_WRITE_ROUTE_REJECTED'); };
  for (const name of ['copyFile', 'cp', 'link', 'symlink']) if (typeof fs.promises[name] === 'function') fs.promises[name] = async () => { parentPolicy.rejectedWrites++; throw new Error('PARENT_WRITE_ROUTE_REJECTED'); };
  const began = Date.now(), observations = [], artifacts = [], phases = {}, diagnostics = []; let child, browser, serverReady = false, outcome = 'failed', errorCode, state, closureModules, compileStartedAt, stage = 'asset-reuse';
  const safeCode = diagnosticCode;
  const numericPolicy = value => value && ['networkRejected', 'writesRejected', 'allowedConnections'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ? Object.fromEntries(['networkRejected', 'writesRejected', 'allowedConnections'].map(key => [key, value[key]])) : 'unknown';
  const cleanupState = { ownedDirectory: directory, ownerPid: process.pid, childPid: null, ownedDirectoryRemoved: false, childClosed: false, portRebound: false, retainedDirectory: undefined };
  function artifact(name) { const file = path.join(evidence, 'alarm-review-real-entry-person-position-v2-' + name); assert(!fs.existsSync(file), 'ARTIFACT_EXISTS'); artifacts.push(file); return file; }

  const journalPath = path.join(evidence, 'alarm-review-real-entry-person-position-journal-20261006-v2.json'), journal = { preparedSha256: hash(preparedPath), ownerPid: process.pid, events: [] };
  function checkpoint(event, details = {}) {
    journal.events.push({ event, stage, elapsedMs: Date.now() - began, ...details }); journal.phases = phases; journal.parentPolicy = parentPolicy; journal.childPid = child?.pid;
    fs.writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  }
  const uncaught = error => checkpoint('uncaught-observed', { failure: browserFailureSummary(error) });
  process.on('uncaughtExceptionMonitor', uncaught);

  try {
    stage = 'asset-reuse'; checkpoint('asset-reuse-begin'); const assetReuseStarted = Date.now();
    const assets = prepared.reusedAssets.map(item => {
      assert.equal(hash(item.file), item.sha256, 'FROZEN_COMPONENT_ASSET_DRIFT');
      assert.equal(fs.statSync(item.file).size, item.bytes, 'FROZEN_COMPONENT_ASSET_SIZE_DRIFT');
      fs.writeFileSync(path.join(output, item.name), fs.readFileSync(item.file));
      return { name: item.name, sha256: item.sha256, bytes: item.bytes };
    });
    assert.deepEqual(fs.readdirSync(output).sort(), ['app.css', 'app.js'], 'REUSED_ASSET_SLOTS_MISMATCH');
    const marker = JSON.parse(fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'));
    const assetProof = { kind: 'overlay-fix-component-output', directory: fs.realpathSync(directory), ownerPid: process.pid, preparedSha256: hash(preparedPath),
      assets, originCompileResult: prepared.originCompileResult, originAssetProof: prepared.originAssetProof, generatedByThisRun: false };
    require('../alarm-review-overlay-fix-v1/server.cjs').validateAssetProof(assetProof, directory, marker);
    fs.writeFileSync(path.join(directory, 'asset-proof.json'), JSON.stringify(assetProof, null, 2));
    const assetProofSha256 = hash(path.join(directory, 'asset-proof.json'));
    phases.assetProof = { sha256: assetProofSha256, ...assetProof };
    activeBundleJs = { file: path.join(output, 'app.js'), sha256: assets[0].sha256 };
    preserveAssets(phases, assets); phases.assetReuseMs = Date.now() - assetReuseStarted; phases.compilerExecuted = false; checkpoint('asset-reuse-complete');
    stage = 'isolated-server-start'; const cp = require('node:child_process'), pending = new Map(); let seq = 0;
    child = cp.fork(path.join(root, 'test/visual/alarm-review-overlay-fix-v1/server.cjs'), [directory, assetProofSha256], { execPath: process.execPath, cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])) });
    cleanupState.childPid = child.pid; checkpoint('server-start'); const serverStartedAt = Date.now();
    child.on('message', value => { if (value?.event === 'ready') { serverReady = true; phases.childPolicy = numericPolicy(value.policy); } if (value?.event === 'closed') phases.childPolicy = numericPolicy(value.policy); if (value?.event === 'callback-read-rejected') { const summary = require('../alarm-review-overlay-fix-v1/server.cjs').callbackReadSummary(value.summary?.category, value.summary?.resourceId === 'vnet-logo' ? path.join(root, 'client/public/assets/vnet-logo-transparent.png') : null); (phases.callbackReadRejections ||= []).push(summary); checkpoint('callback-read-rejected', { summary }); } if (value?.id && pending.has(value.id)) { const item = pending.get(value.id); pending.delete(value.id); clearTimeout(item.timer); item.resolve(value); } });
    const ready = observeServerReady(child, event => { diagnostics.push({ stage, ...event }); checkpoint(event.event, { observedStage: event.stage }); });
    await ready; phases.serverStartMs = Date.now() - serverStartedAt; checkpoint('server-ready');
    const control = message => new Promise((resolve, reject) => { const id = String(++seq); const timer = setTimeout(() => { pending.delete(id); reject(new Error('CONTROL_TIMEOUT')); }, 5000); pending.set(id, { resolve, timer }); child.send({ ...message, id }); });
    const { chromium } = require('playwright-core');
    stage = 'browser-launch'; assert.equal(hash(prepared.browser.executablePath), prepared.browser.sha256, 'BROWSER_BINARY_DRIFT');
    checkpoint('browser-launch');
    browser = await chromium.launch({ executablePath: prepared.browser.executablePath, headless: true, env: { ...Object.fromEntries(['SystemRoot', 'WINDIR', 'PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]])), TEMP: directory, TMP: directory } });
    assert.equal(browser.version(), prepared.browser.version, 'BROWSER_VERSION_DRIFT');
    phases.browserRuntime = { version: browser.version(), executableSha256: prepared.browser.sha256 }; checkpoint('browser-ready');
    phases.representativeCss = { executedThisRun: false, inheritedResult: prepared.originCompileResult, inheritedObservations: prepared.inheritedCssObservations };
    stage = 'browser-six-scenarios';
    const browserStart = Date.now(); phases.browserProof = {}; let stopPageError; const firstPageError = new Promise((resolve, reject) => { stopPageError = reject; }); checkpoint('browser-six-scenarios');
    try { await Promise.race([browserCases(browser, control, artifact, observations, phases.browserProof, checkpoint, stopPageError), firstPageError]); }
    catch (error) {
      try {
        const observed = await control({ kind: 'state' });
        state = { policy: numericPolicy(observed.policy), gateTimeouts: Number.isSafeInteger(observed.gateTimeouts) ? observed.gateTimeouts : null, taskCount: Array.isArray(observed.tasks) ? observed.tasks.length : null };
        checkpoint('failed-stage-read-only-state', { state });
      } catch (stateError) { checkpoint('failed-stage-state-unavailable', { code: diagnosticCode(stateError) }); }
      throw error;
    } finally { phases.browserMs = Date.now() - browserStart; checkpoint('browser-six-scenarios-settled'); }
    const rawState = await control({ kind: 'state' }); state = { policy: rawState.policy ? { networkRejected: rawState.policy.networkRejected, writesRejected: rawState.policy.writesRejected, allowedConnections: rawState.policy.allowedConnections } : 'unknown', gateTimeouts: rawState.gateTimeouts, taskCount: Array.isArray(rawState.tasks) ? rawState.tasks.length : null }; assert.equal(state.policy.networkRejected, 0); assert.equal(state.policy.writesRejected, 0); assert.equal(state.gateTimeouts, 0); assert.equal(parentPolicy.rejectedNetwork, 0); assert.equal(parentPolicy.rejectedWrites, 0); assert.equal(observations.length, 6);
    outcome = 'passed';
  } catch (error) { errorCode = /^[A-Z0-9_:\-/\.]{1,160}$/.test(error.message) ? error.message : 'FIXTURE_EXECUTION_FAILED'; diagnostics.push({ stage, code: safeCode(error), errorCode, failure: browserFailureSummary(error) }); checkpoint('execution-failed', { failure: browserFailureSummary(error) }); if (browser) { for (const ctx of browser.contexts()) { const pages = ctx.pages(); if (pages[0]) { try { await pages[0].screenshot({ path: artifact('failure-'+artifacts.length+'.png') }); } catch { diagnostics.push({ stage: 'failure-screenshot', code: 'SCREENSHOT_UNAVAILABLE' }); } } } }
  }
  finally {
    if (compileStartedAt && phases.compileMs === undefined) phases.compileMs = Date.now() - compileStartedAt;
    let cleanupFailed = false;
    async function cleanStep(name, action) { try { await action(); } catch (error) { cleanupFailed = true; outcome = 'failed'; errorCode = errorCode || 'FIXTURE_CLEANUP_FAILED'; diagnostics.push({ stage: name, code: safeCode(error) }); } }
    await cleanStep('page-contexts-close', async () => { if (phases.browserProof?.closeContexts) await phases.browserProof.closeContexts(); });
    await cleanStep('browser-close', async () => { if (browser) await browser.close(); });
    await cleanStep('owned-server-close', async () => {
      if (child && child.exitCode === null && child.signalCode === null) {
        const releaseClose = queueSafeClose(child, serverReady);
        await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('OWNED_SERVER_CLEANUP_TIMEOUT_NO_FORCE_KILL')), 12000); child.once('exit', () => { clearTimeout(timer); releaseClose(); resolve(); }); });
      }
      cleanupState.childClosed = !child || child.exitCode !== null || child.signalCode !== null;
    });
    await cleanStep('source-after-run', async () => { const currentDrift = prepared.inputs.filter(item => hash(path.resolve(root, item.file)) !== item.sha256); if (currentDrift.length) { outcome = 'failed'; errorCode = 'INPUT_DRIFT_AFTER_RUN'; } });
    const retention = retainOwned(directory, cleanupState); outcome = retention.outcome; errorCode = errorCode || retention.errorCode;
    await cleanStep('port-rebound', async () => { await new Promise((resolve, reject) => { const probe = net.createServer(); probe.once('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); }); cleanupState.portRebound = true; });
    const result = { kind: prepared.kind, outcome, errorCode, preparedSha256: hash(preparedPath), fingerprint: prepared.fingerprint, node: prepared.node, browser: prepared.browser, phases, diagnostics, observations, state, parentPolicy, compilerModules: closureModules, artifacts: artifacts.filter(file => fs.existsSync(file)).map(bind), childPid: child?.pid, cleanup: cleanupState, elapsedMs: Date.now() - began, dependencyProofGap: prepared.dependencyEvidence.gap, productionAppShellCovered: false, externalSchemaCovered: false };
    checkpoint('cleanup-settled', { outcome, errorCode, cleanup: { childClosed: cleanupState.childClosed, portRebound: cleanupState.portRebound, ownedDirectoryRemoved: cleanupState.ownedDirectoryRemoved } }); process.removeListener('uncaughtExceptionMonitor', uncaught);
    fs.writeFileSync(resultPath, JSON.stringify(result, null, 2)); process.stdout.write(JSON.stringify({ outcome, errorCode, result: relative(resultPath), sha256: hash(resultPath), elapsedMs: result.elapsedMs }) + '\n');
    if (outcome !== 'passed') process.exitCode = 1;
  }
}

const styleFile = 'client/src/pages/TodayOperationsPanorama/styles.css';
const oldSelector = "body:has(.today-panorama-detail-dialog) [data-slot='dialog-overlay']";
const newSelector = "[data-slot='dialog-overlay']:has(+ .today-panorama-detail-dialog)";
const baselinePath = path.join(evidence, 'alarm-review-real-entry-overlay-fix-old-css-20261006-v1.css');
const transitionPath = path.join(evidence, 'alarm-review-real-entry-overlay-fix-transition-20261006-v1.json');
const priorPath = path.join(evidence, 'alarm-review-real-entry-actionability-prepared-20261006-v1.json');
let activeBundleJs;
function priorPrepared() {
  assert.equal(hash(priorPath), '4f01454730dc4c3acf9b9492ef8955f7d957404424cc84660931e30a65971614', 'PRIOR_PREPARED_DRIFT');
  return JSON.parse(fs.readFileSync(priorPath, 'utf8'));
}
function cssRule(text, selector) {
  const at = text.indexOf(selector + ' {');
  assert(at >= 0 && text.indexOf(selector + ' {', at + 1) < 0, 'CSS_RULE_NOT_UNIQUE');
  const end = text.indexOf('}', at); assert(end > at, 'CSS_RULE_INCOMPLETE');
  return text.slice(at, end + 1);
}
function captureBaseline() {
  const prior = priorPrepared(), item = prior.inputs.find(x => x.file === styleFile); assert(item, 'OLD_STYLE_NOT_BOUND');
  checkBinding(item); assert(!fs.existsSync(baselinePath), 'BASELINE_EXISTS_NO_OVERWRITE');
  const bytes = fs.readFileSync(path.join(root, styleFile));
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), item.sha256);
  cssRule(bytes.toString('utf8'), oldSelector);
  fs.writeFileSync(baselinePath, bytes);
  console.log(JSON.stringify({ status: 'old-source-byte-baseline-captured', file: relative(baselinePath), sha256: hash(baselinePath), compiled: false, browserStarted: false }));
}
function verifyTransition() {
  const prior = priorPrepared(), old = prior.inputs.find(x => x.file === styleFile); assert(old);
  assert.equal(hash(baselinePath), old.sha256, 'OLD_STYLE_BASELINE_DRIFT');
  const before = fs.readFileSync(baselinePath, 'utf8'), after = fs.readFileSync(path.join(root, styleFile), 'utf8');
  const count = before.split(oldSelector).length - 1; assert.equal(count, 1, 'OLD_SELECTOR_NOT_UNIQUE');
  assert.equal(after, before.replace(oldSelector, newSelector), 'NON_SELECTOR_STYLE_CHANGE');
  assert.equal(cssRule(before, oldSelector).split('{').at(-1), cssRule(after, newSelector).split('{').at(-1), 'DETAIL_LAYER_CHANGED');
  for (const item of prior.inputs) if (item.file !== styleFile) checkBinding(item);
  return { file: styleFile, beforeSha256: old.sha256, afterSha256: hash(path.join(root, styleFile)), oldSource: bind(baselinePath), beforeRule: cssRule(before, oldSelector), afterRule: cssRule(after, newSelector) };
}
function readSelectedPerson(span) {
  return {
    name: Array.from(span.childNodes).filter(node => node.nodeType === 3).map(node => node.textContent || '').join('').trim(),
    metadata: span.querySelector(':scope > small')?.textContent?.trim() || ''
  };
}
function assertPickedPerson(value) {
  assert.equal(value.name, '合成李明', 'SELECTED_PERSON_NAME_NOT_A');
  assert.match(value.metadata, /^A楼(?:\s*·|$)/, 'SELECTED_PERSON_BUILDING_NOT_A');
}
function assertFirstPerson(value) {
  assert.equal(value.ariaSelected, 'true', 'KEYBOARD_FIRST_PERSON_NOT_SELECTED');
  assert.equal(value.recordId, 'recSyntheticPersonA', 'KEYBOARD_FIRST_PERSON_WRONG_ID');
}
const browserOnlyPriorPath = path.join(evidence, 'alarm-review-real-entry-overlay-fix-prepared-20261006-v1.json');
const compiledResultPath = path.join(evidence, 'alarm-review-real-entry-overlay-fix-result-20261006-v1.json');
const originalAssetProofPath = 'C:/Users/36056/AppData/Local/Temp/alarm-review-entry-9M1K3f/asset-proof.json';
function prepare() {
  const began = Date.now(), mono = performance.now();
  assert(!fs.existsSync(preparedPath), 'PREPARED_EXISTS_NO_OVERWRITE');
  assert.equal(hash(browserOnlyPriorPath), '39947d39f1debe8a3453ec466e9e4c09860365111ef536e9867f9d3709d66c68');
  assert.equal(hash(compiledResultPath), 'e26fa5d8b4a5dd3504abda008f8229daceb6c82899714e62cf85e508c90c773f');
  assert.equal(hash(originalAssetProofPath), '727cf768b03a27183818fb81b0981a7ec3a08310f027e17fb9a8bcbe2dfa7f15');
  const prior = JSON.parse(fs.readFileSync(browserOnlyPriorPath, 'utf8')); prior.inputs.forEach(checkBinding);
  assert.equal(hash(process.execPath), prior.node.sha256); assert.equal(hash(prior.browser.executablePath), prior.browser.sha256);
  const compiled = JSON.parse(fs.readFileSync(compiledResultPath, 'utf8')), proof = JSON.parse(fs.readFileSync(originalAssetProofPath, 'utf8'));
  assert.equal(compiled.phases.compilerExecuted, true);
  assert.equal(proof.preparedSha256, hash(browserOnlyPriorPath)); assert.deepEqual(proof, Object.fromEntries(Object.entries(compiled.phases.assetProof).filter(([key]) => key !== 'sha256')));
  assert.deepEqual(compiled.phases.representativeCss.observations.map(x => x.width), [1440, 390]);
  assert(compiled.phases.representativeCss.observations.every(x => x.oldRuleRed && x.newRuleGreen && x.ownDetail && x.review && x.nativeTopLayerAndClosed));
  require('../alarm-review-overlay-fix-v1/server.cjs').validateAssetProof(proof, proof.directory, { directory: proof.directory, scope: 'alarm-review-real-entry', pid: proof.ownerPid });
  const fixed = [
    { name: 'app.js', sha256: '3737ae149932310988c00bafb460afe9783c5f7ccb2eb898a583699228715494', bytes: 1178305 },
    { name: 'app.css', sha256: '58819100f006f5f92a5378293707584c121a9bf6cefced3fa03887a5aff6249d', bytes: 638637 }
  ];
  assert.deepEqual(proof.assets, fixed);
  const reused = fixed.map(item => { const file = path.join(proof.directory, 'bundle', item.name);
    safeFile(file); assert.equal(fs.realpathSync(file), file, 'REUSED_ASSET_REALPATH_DRIFT'); assert.equal(hash(file), item.sha256); assert.equal(fs.statSync(file).size, item.bytes); return { ...item, file }; });
  const files = new Set(prior.inputs.map(x => path.resolve(root, x.file)));
  for (const file of [__filename, plan, browserOnlyPriorPath, compiledResultPath, originalAssetProofPath, ...reused.map(x => x.file), 'node_modules/cmdk/dist/index.mjs']) files.add(safeFile(path.resolve(root, file)));
  new (require('node:vm').Script)(fs.readFileSync(__filename, 'utf8'), { filename: __filename });
  const inputs = [...files].sort().map(bind), fingerprint = crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
  const record = { ...prior, status: 'person-position-browser-only-prepared-not-run', fixtureVersion: 'person-position-v2', inputs, fingerprint, compilerWillRun: false,
    reusedAssets: reused, originCompileResult: bind(compiledResultPath), originAssetProof: bind(originalAssetProofPath),
    inheritedCssObservations: compiled.phases.representativeCss.observations, representativeWillRun: false,
    command: [process.execPath, relative(__filename), '--prepare'], runtimeCommand: [process.execPath, relative(__filename), '--run', '--approved-run'],
    beganAt: new Date(began).toISOString(), completedAt: new Date().toISOString(), elapsedMs: Date.now()-began, monotonicElapsedMs: performance.now()-mono };
  fs.writeFileSync(preparedPath, JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ status: record.status, sha256: hash(preparedPath), inputs: inputs.length, fingerprint, elapsedMs: record.elapsedMs, monotonicElapsedMs: record.monotonicElapsedMs }));
}

function checkPersonPositionContract() {
  const began = Date.now(), positive = { ariaSelected: 'true', recordId: 'recSyntheticPersonA' };
  assertFirstPerson(positive);
  for (const value of [{ ...positive, ariaSelected: 'false' }, { ...positive, ariaSelected: null }, { ...positive, recordId: 'recSyntheticPersonB' }, { ...positive, recordId: null }]) assert.throws(() => assertFirstPerson(value), { name: 'AssertionError' });
  const source = fs.readFileSync(__filename, 'utf8');
  const start = source.indexOf('\n  async function choose('), end = source.indexOf('\n  async function geometry(', start), choose = source.slice(start, end);
  assert(choose.indexOf("search.press('ArrowDown')") < choose.indexOf("search.press('Home')"));
  assert(choose.indexOf("search.press('Home')") < choose.indexOf('assertFirstPerson(selected)'));
  assert(choose.indexOf('assertFirstPerson(selected)') < choose.indexOf("search.press('Enter')"));
  assert(!choose.includes("getByText('合成李明', { exact: true })"));
  assert(choose.includes("selectedSpan.evaluate(readSelectedPerson)"));
  assert(choose.includes("assertPickedPerson("));
  assert(choose.includes("'person-keyboard'") && choose.includes("'selected-identity'"));
  const span = (name, metadata) => ({
    childNodes: [{ nodeType: 3, textContent: name }, { nodeType: 1, textContent: metadata }],
    querySelector: selector => { assert.equal(selector, ':scope > small'); return metadata === null ? null : { textContent: metadata }; }
  });
  const valid = span('合成李明', 'A楼 · 合成电气工程师');
  assert.deepEqual(readSelectedPerson(valid), { name: '合成李明', metadata: 'A楼 · 合成电气工程师' });
  assertPickedPerson(readSelectedPerson(valid));
  assert.notEqual(readSelectedPerson(valid).name, valid.childNodes.map(node => node.textContent).join(''));
  for (const invalid of [span('合成李明二', 'A楼 · 合成电气工程师'), span('', 'A楼 · 合成电气工程师'), span('合成李明', null), span('合成李明', 'B楼 · 合成电气工程师')]) {
    assert.throws(() => assertPickedPerson(readSelectedPerson(invalid)), { name: 'AssertionError' });
  }
  assert(!choose.includes('force:'));
  const prepared = JSON.parse(fs.readFileSync(preparedPath, 'utf8')); prepared.inputs.forEach(checkBinding);
  const record = { status: 'person-position-new-precondition-pure-passed', prepared: bind(preparedPath), tool: bind(__filename), node: bind(process.execPath),
    selectedFirstPositive: true, rejectedSelectionCases: 4, selectedSpanShapePositive: true, rejectedSelectedIdentityCases: 4, nameReadFromDirectTextNodesOnly: true, keyboardHomeAndExactNameBuildingOrder: true,
    browserExecuted: false, compilerExecuted: false, serviceStarted: false, elapsedMs: Date.now()-began };
  const file = path.join(evidence, 'alarm-review-real-entry-person-position-contract-20261006-v2.json');
  assert(!fs.existsSync(file), 'CONTRACT_EXISTS_NO_OVERWRITE'); fs.writeFileSync(file, JSON.stringify(record,null,2));
  console.log(JSON.stringify({ status: record.status, sha256: hash(file), elapsedMs: record.elapsedMs }));
}

async function representativeOverlayCases(browser, artifact, checkpoint, partial) {
  const transition = verifyTransition(), detailCss = cssRule(fs.readFileSync(path.join(root, styleFile), 'utf8'), '.today-panorama-detail-dialog');
  const reviewCss = fs.readFileSync(path.join(root, 'client/src/pages/TodayOperationsPanorama/alarm-review.css'), 'utf8');
  const observations = []; partial.observations = observations;
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' }); let page;
    try {
      await ctx.route('**/*', route => route.abort('blockedbyclient'));
      page = await ctx.newPage();
      const errors = []; page.on('pageerror', () => { errors.push('PAGE_ERROR'); }); partial.errors = errors;
      await page.setContent('<!doctype html><html><head></head><body><dialog id="native" class="today-panorama-detail-dialog"><button id="native-button">机柜</button></dialog><div data-slot="dialog-overlay" id="overlay"></div><div data-slot="dialog-content" id="content" class="fixture-content"><button id="submit">登录</button></div></body></html>');
      await page.addStyleTag({ content: '[data-slot="dialog-overlay"]{position:fixed;inset:0;z-index:50;pointer-events:auto;background:rgba(0,0,0,.1)}.fixture-content{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:50;width:min(300px,90vw);padding:20px;background:#fff}button{padding:12px}dialog:not([open]){display:none}' + detailCss + reviewCss });
      const style = await page.addStyleTag({ content: transition.beforeRule });
      const sample = () => page.locator('#submit').evaluate(button => {
        const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);
        return { nativeClosed: !document.querySelector('#native').open, nativeInDom: Boolean(document.querySelector('dialog.today-panorama-detail-dialog')),
          hit: hit?.id || 'other', overlayZ: getComputedStyle(document.querySelector('#overlay')).zIndex,
          contentZ: getComputedStyle(document.querySelector('#content')).zIndex };
      });
      const red = await sample(); assert.equal(red.nativeClosed, true); assert.equal(red.nativeInDom, true);
      assert.equal(red.hit, 'overlay', 'OLD_CSS_REPRESENTATIVE_NOT_RED'); assert.equal(red.overlayZ, '79');
      checkpoint('representative-css-red', { width, ...red });
      await style.evaluate((element, rule) => { element.textContent = rule; }, transition.afterRule);
      const green = await sample(); assert.equal(green.hit, 'submit', 'NEW_CSS_REPRESENTATIVE_NOT_GREEN'); assert.equal(green.overlayZ, '50'); assert.equal(green.contentZ, '50');
      await page.getByRole('button', { name: '登录', exact: true }).click();
      await page.locator('#content').evaluate(element => element.classList.add('today-panorama-detail-dialog'));
      assert.equal(await page.locator('#overlay').evaluate(e => getComputedStyle(e).zIndex), '79', 'OWN_DETAIL_OVERLAY_NOT_79');
      assert.equal(await page.locator('#content').evaluate(e => getComputedStyle(e).zIndex), '80', 'OWN_DETAIL_CONTENT_NOT_80');
      await page.locator('#content').evaluate(element => { element.classList.remove('today-panorama-detail-dialog'); element.classList.add('alarm-review-dialog'); });
      assert.equal(await page.locator('#overlay').evaluate(e => getComputedStyle(e).zIndex), '81', 'REVIEW_SCOPE_CHANGED');
      assert.equal(await page.locator('#content').evaluate(e => getComputedStyle(e).zIndex), '82', 'REVIEW_LAYER_CHANGED');
      await page.locator('#content').evaluate(element => element.classList.remove('alarm-review-dialog'));
      await page.locator('#native').evaluate(element => element.showModal());
      assert.equal(await page.locator('#native').evaluate(element => element.matches(':modal')), true, 'NATIVE_TOP_LAYER_MISSING');
      const nativeHit = await page.locator('#native-button').evaluate(button => { const r=button.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return hit===button; });
      assert.equal(nativeHit, true, 'NATIVE_CLICK_OBSCURED');
      await page.locator('#native').evaluate(element => element.close());
      assert.equal((await sample()).hit, 'submit', 'CLOSED_NATIVE_REACTIVATES_OVERLAY');
      assert.equal(errors.length, 0, 'REPRESENTATIVE_PAGE_ERROR');
      await page.screenshot({ path: artifact('representative-'+width+'.png') });
      observations.push({ width, oldRuleRed: true, newRuleGreen: true, ownDetail: true, review: true, nativeTopLayerAndClosed: true });
      checkpoint('representative-css-green', { width, ...green });
    } catch (error) { if (page) await page.screenshot({ path: artifact('representative-failed-'+width+'.png') }); throw error; }
    finally { await ctx.close(); }
  }
}
if (process.argv.includes('--prepare')) prepare();
else if (process.argv.includes('--check-person-position-contract')) { try { checkPersonPositionContract(); } catch (error) { process.stderr.write(JSON.stringify({ status: 'person-position-contract-failed', code: diagnosticCode(error) })+'\n'); process.exitCode=1; } }
else if (process.argv.includes('--run')) run().catch(() => { process.stderr.write('FIXTURE_PRECONDITION_OR_CLEANUP_FAILED\n'); process.exitCode = 1; });

