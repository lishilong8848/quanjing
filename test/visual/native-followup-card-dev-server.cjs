// Local card simulator only: real card/service/store/parser, synthetic gateway and identities.
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../..');
const port = 32121, origin = `http://127.0.0.1:${port}`;

async function createPreview() {
  require('reflect-metadata');
  require('ts-node').register({ transpileOnly: true, compilerOptions: {
    module: 'CommonJS', moduleResolution: 'node', experimentalDecorators: true, emitDecoratorMetadata: true,
  } });
  require('tsconfig-paths').register({ baseUrl: root, paths: { '@shared/*': ['shared/*'], '@server/*': ['server/*'] } });
  process.env.FEISHU_APP_ID = 'cli_synthetic_native';
  process.env.NANTONG_DAILY_PATROL_ENABLED = 'true';
  const { ConflictException, ForbiddenException, NotFoundException } = require('@nestjs/common');
  const { TodayOperationsFollowUpCardService } = require('../../server/modules/bitable-sync/today-operations-follow-up-card.service');
  const { TodayOperationsFollowUpCardStore } = require('../../server/modules/bitable-sync/today-operations-follow-up-card.store');
  const { followUpRecordFingerprint } = require('../../server/modules/bitable-sync/today-operations-follow-up-card.types');
  const { buildTodayOperationsFollowUpUpdateFields } = require('../../server/modules/bitable-sync/today-operations-anomaly.gateway');
  const { buildDailyOperationsPatrolCard } = require('../../server/modules/duty-schedule/daily-operations-patrol.card');
  const { feishuIdentityFingerprint } = require('../../server/common/access/feishu-access-approved-grants');
  const appId = process.env.FEISHU_APP_ID;
  const actors = new Map([
    ['ou_editor', { role: 'editor', displayName: '模拟运维人员' }],
    ['ou_viewer', { role: 'duty_editor', displayName: '模拟只读人员' }],
  ].map(([openId, principal]) => [openId, { ...principal, purchaseBuilding: null,
    accountId: `feishu-${feishuIdentityFingerprint(appId, openId)}`, authorizationVersion: 1 }]));
  const configuration = {
    canUseFeishuBusinessIdentity: (id, candidateApp) => candidateApp === appId && [...actors.values()].some(actor => actor.accountId === id),
    feishuPrincipal: (openId, candidateApp) => candidateApp === appId ? structuredClone(actors.get(openId)) : undefined,
    pagePermissions: () => ({ paths: ['/today-operations-panorama'], revision: 1, configured: true }),
  };
  const initial = [
    { recordId: 'rec_01_patrol', issueKey: 'synthetic-patrol', date: '2026-10-29', source: '每日巡视',
      item: 'H楼巡视记录待跟进', description: '合成数据：巡视发现设备状态异常，请填写核查情况。', building: 'H楼',
      acknowledged: false, completed: false, treatmentMeasure: '', handlerName: '', handledAt: '' },
    { recordId: 'rec_02_attendance', issueKey: 'synthetic-attendance', date: '2026-10-29', source: '考勤通晒',
      item: 'C楼考勤异常待核查', description: '合成数据：请核对考勤与排班信息，记录跟进结果。', building: 'C楼',
      acknowledged: true, completed: false, treatmentMeasure: '已知悉，待核对记录', handlerName: '模拟运维人员', handledAt: '2026-10-29T01:30:00.000Z' },
  ];
  const records = new Map(initial.map(record => [record.recordId, structuredClone(record)]));
  const mutations = new Map();
  let card, writeCount = 0, patchCount = 0, lastWorkerError = '';
  const gateway = {
    async getFollowUp(id) {
      if (!records.has(id)) throw new NotFoundException('合成记录不存在');
      return structuredClone(records.get(id));
    },
    async updateFollowUp(update, expected) {
      const fields = buildTodayOperationsFollowUpUpdateFields(update);
      const current = await this.getFollowUp(update.recordId);
      if (mutations.get(update.recordId) === update.clientMutationId) return current;
      if (!expected || followUpRecordFingerprint(expected) !== followUpRecordFingerprint(current)) {
        throw new ConflictException('合成记录已变化，请重新核对');
      }
      const result = { ...current, acknowledged: fields['已知悉'], completed: fields['已处理完成'],
        treatmentMeasure: fields['处理措施'], handlerName: fields['处理人姓名'],
        handledAt: fields['处理时间'] ? new Date(fields['处理时间']).toISOString() : current.handledAt };
      records.set(result.recordId, structuredClone(result)); mutations.set(result.recordId, update.clientMutationId);
      writeCount += 1;
      return structuredClone(result);
    },
    async patchInteractiveCard(messageId, replacement) {
      assert.equal(messageId, 'om_preview');
      card = structuredClone(replacement); patchCount += 1;
    },
  };
  const directory = path.join(root, 'output/followup-login-diagnosis-20261029', `native-preview-${randomUUID()}`);
  fs.mkdirSync(directory, { recursive: true });
  const store = new TodayOperationsFollowUpCardStore(path.join(directory, 'ledger.json'));
  const service = new TodayOperationsFollowUpCardService(store, gateway, configuration);
  service.schedulePendingTasks = () => setImmediate(() => {
    void service.runPendingTasks().catch(error => { lastWorkerError = error.message; });
  });
  const batchId = await service.prepare(initial.map(record => record.recordId), 'synthetic-daily-preview');
  card = buildDailyOperationsPatrolCard({
    businessDate: '2026-10-29', startDate: '2026-10-29', endDate: '2026-11-05',
    generatedAt: '2026-10-29T01:30:00.000Z', evaluatedFacilityPoints: 2, totalIssues: 2, hasAlerts: true,
    checks: [{ key: 'facility', label: '巡视与考勤跟进', status: 'alert', count: 2, summary: '2条合成记录',
      issues: initial.map((record, index) => ({ id: `synthetic-${index}`, check: 'facility', title: record.item,
        detail: record.description, date: record.date, severity: 'warning' })) }],
  }, { followUpCardId: batchId });
  await service.bindMessage(batchId, 'om_preview', card);
  return {
    directory,
    state: () => ({ simulation: true, externalRequests: 0, realBusinessWrites: 0, card, writeCount, patchCount,
      records: [...records.values()].map(record => structuredClone(record)), ...(lastWorkerError ? { lastWorkerError } : {}) }),
    async action(body) {
      if (!body || !actors.has(body.actor) || !body.action || typeof body.action !== 'object' || Array.isArray(body.action)) {
        throw new ForbiddenException('请选择本地模拟身份和卡片动作');
      }
      const result = await service.handle({ event_type: 'card.action.trigger', event_id: `preview_${randomUUID()}`,
        operator: { open_id: body.actor }, context: { open_message_id: 'om_preview' }, action: body.action });
      if (result.card) card = structuredClone(result.card);
      return result;
    },
  };
}

function pageHtml() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>异常跟进 · 本地卡片模拟</title>
<style>*{box-sizing:border-box}body{margin:0;background:#f3f5f9;color:#202734;font:15px/1.6 system-ui,sans-serif}.shell{max-width:780px;margin:26px auto;padding:0 18px}.notice{padding:10px 14px;background:#fff6db;border:1px solid #f0d995;border-radius:9px;color:#78601c;font-size:13px}.tools{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:16px 0;flex-wrap:wrap}.tools label{display:flex;align-items:center;gap:8px}.tools select{width:auto}.counter{font-size:13px;color:#637087}.card{background:#fff;border:1px solid #e1e6ed;border-radius:14px;overflow:hidden;box-shadow:0 8px 28px #202d4410}.card-header{padding:17px 20px;font-size:19px;font-weight:700;background:#eaf1ff;color:#2454a6}.card-header.red{background:#fcebea;color:#a33834}.card-header.orange{background:#fff0db;color:#995c16}.card-header.green{background:#e6f6eb;color:#267441}.body{padding:18px;display:flex;flex-direction:column;gap:12px}.columns{display:flex;gap:10px;align-items:flex-start}.column{flex:1;min-width:0;display:flex;flex-direction:column;gap:10px}.md{overflow-wrap:anywhere;white-space:normal}.md .red{color:#ca3d3d}.md .green{color:#27804c}.md .grey{color:#77808d}.md .orange{color:#b7781b}.card-form{display:flex;flex-direction:column;gap:13px}.field{display:flex;flex-direction:column;gap:6px}.field>label{font-size:14px;font-weight:600}select,textarea,input{font:inherit;width:100%;border:1px solid #cdd6e2;border-radius:8px;padding:10px 12px;background:#fff;color:inherit;min-width:0}textarea{min-height:112px;resize:vertical}button{font:inherit;border:1px solid #cfd8e5;background:#fff;color:#31547f;border-radius:8px;padding:10px 14px;min-height:44px;cursor:pointer;overflow-wrap:anywhere;white-space:normal}button.fill{width:100%}button.primary_filled{background:#3370ff;border-color:#3370ff;color:#fff}button:disabled{opacity:.6;cursor:default}button:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid #9dc0ff;outline-offset:2px}hr{width:100%;border:0;border-top:1px solid #e7ebf1;margin:3px 0}#toast{min-height:28px;margin:10px 0;color:#4b637f;overflow-wrap:anywhere}#toast.error{color:#b83232}.foot{color:#798391;font-size:12px;margin:15px 0}details{margin:16px 0;font-size:13px;color:#64748b}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;padding:12px;border:1px solid #e1e6ed;border-radius:8px}@media(max-width:520px){.shell{margin:12px auto;padding:0 10px}.body{padding:13px}.card-header{padding:14px;font-size:18px}.columns{flex-wrap:wrap}.columns>.column{min-width:130px}.tools{align-items:flex-start}.tools label{flex:1}.tools select{flex:1}.notice{font-size:12px}}</style></head>
<body><main class="shell"><div class="notice">仅本地飞书卡片模拟 · 合成数据 · 不连接飞书或真实业务</div><div class="tools"><label for="actor">模拟身份<select id="actor"><option value="ou_editor">可填写人员</option><option value="ou_viewer">只读人员</option></select></label><span id="counter" class="counter">模拟写入：0 次</span></div><div id="toast" role="status" aria-live="polite"></div><section id="card" class="card" aria-label="巡视消息卡片"></section><p class="foot">此页面仅模拟卡片交互，最终布局仍以飞书客户端为准。</p><details><summary>查看卡片 JSON</summary><pre id="json"></pre></details></main><script>(${previewClient.toString()})();</script></body></html>`;
}

function previewClient() {
  const root = document.getElementById('card'), toast = document.getElementById('toast');
  const components = new WeakMap();
  let currentJson = '', polling = false, busy = false, stateRevision = 0;
  function notice(message, type = 'info') { toast.className = type; toast.textContent = message || ''; }
  function markdown(content) {
    const entities = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' };
    let safe = String(content || '').replace(/&(?:lt|gt|quot|amp);|&#39;/g, match => entities[match]);
    safe = safe.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    safe = safe.replace(/\\([\\`*_[\]()])/g, (_match, char) => `&#${char.charCodeAt(0)};`);
    safe = safe.replace(/\*\*([^\n]*?)\*\*/g, '<strong>$1</strong>');
    safe = safe.replace(/&lt;font color=&quot;(red|green|grey|orange)&quot;&gt;/g, '<span class="$1">').replace(/&lt;\/font&gt;/g, '</span>');
    return safe.replace(/\n/g, '<br>');
  }
  function node(component) {
    const tag = component.tag;
    let element;
    if (tag === 'markdown' || tag === 'plain_text') {
      element = document.createElement('div'); element.className = 'md';
      if (tag === 'markdown') element.innerHTML = markdown(component.content); else element.textContent = component.content || '';
    } else if (tag === 'hr') element = document.createElement('hr');
    else if (tag === 'column_set' || tag === 'column') {
      element = document.createElement('div'); element.className = tag === 'column_set' ? 'columns' : 'column';
      for (const child of component.columns || component.elements || []) element.append(node(child));
    } else if (tag === 'form') {
      element = document.createElement('form'); element.className = 'card-form'; element.setAttribute('aria-label', '异常跟进表单');
      for (const child of component.elements || []) element.append(node(child));
      element.addEventListener('submit', event => {
        event.preventDefault();
        const button = event.submitter || element.querySelector('button[type="submit"]');
        const actual = components.get(button);
        if (!actual?.name) return notice('未找到卡片提交动作', 'error');
        void send({ tag: actual.tag, name: actual.name, form_value: Object.fromEntries(new FormData(element).entries()) }, button);
      });
    } else if (tag === 'select_static' || tag === 'input') {
      element = document.createElement('div'); element.className = 'field';
      const control = document.createElement(tag === 'select_static' ? 'select' : component.input_type === 'multiline_text' ? 'textarea' : 'input');
      control.name = component.name; control.id = component.name; control.required = component.required === true;
      if (component.label?.content) { const label = document.createElement('label'); label.htmlFor = control.id; label.textContent = component.label.content; element.append(label); }
      if (tag === 'select_static') {
        for (const option of component.options || []) { const item = document.createElement('option'); item.value = option.value; item.textContent = option.text?.content || option.value; control.append(item); }
        if (component.initial_option !== undefined) control.value = component.initial_option;
      } else {
        control.value = component.default_value || ''; control.placeholder = component.placeholder?.content || '';
        if (component.max_length) control.maxLength = component.max_length;
        if (component.rows) control.rows = component.rows;
      }
      element.append(control);
    } else if (tag === 'button') {
      element = document.createElement('button'); element.type = component.form_action_type === 'submit' ? 'submit' : 'button';
      element.textContent = component.text?.content || '按钮'; element.className = `${component.type || 'default'} ${component.width === 'fill' ? 'fill' : ''}`;
      element.disabled = component.disabled === true; components.set(element, component);
      if (element.type !== 'submit') element.addEventListener('click', () => {
        const callback = component.behaviors?.find(behavior => behavior.type === 'callback');
        if (callback) void send({ tag: component.tag, value: callback.value }, element);
        else notice('本地模拟不执行外部链接跳转');
      });
    } else {
      element = document.createElement('div');
      for (const child of component.elements || []) element.append(node(child));
    }
    return element;
  }
  function render(card) {
    const json = JSON.stringify(card);
    if (json === currentJson) return;
    currentJson = json; root.replaceChildren();
    const header = document.createElement('div'); header.className = `card-header ${card.header?.template || ''}`;
    header.textContent = card.header?.title?.content || '消息卡片'; root.append(header);
    const body = document.createElement('div'); body.className = 'body';
    for (const component of card.body?.elements || card.elements || []) body.append(node(component));
    root.append(body); document.getElementById('json').textContent = JSON.stringify(card, null, 2);
  }
  async function refresh() {
    if (polling) return;
    polling = true;
    const requestedRevision = stateRevision;
    try {
      const response = await fetch('/state', { cache: 'no-store' });
      if (!response.ok) throw new Error('本地预览状态读取失败');
      const state = await response.json();
      if (requestedRevision !== stateRevision) return;
      render(state.card);
      document.getElementById('counter').textContent = `模拟写入：${state.writeCount} 次`;
      if (state.lastWorkerError) notice(state.lastWorkerError, 'error');
    } catch (error) { notice(error.message, 'error'); }
    finally { polling = false; }
  }
  async function send(action, button) {
    if (busy) return;
    busy = true; stateRevision += 1; if (button) button.disabled = true; notice('正在处理…');
    try {
      const response = await fetch('/action', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ actor: document.getElementById('actor').value, action }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || '本地卡片操作失败');
      if (result.card) render(result.card);
      notice(result.toast?.content || '已受理', result.toast?.type); await refresh();
    } catch (error) { notice(error.message, 'error'); }
    finally { busy = false; if (button?.isConnected) button.disabled = components.get(button)?.disabled === true; }
  }
  document.getElementById('actor').addEventListener('change', () => notice('模拟身份已切换，下一次操作按该身份校验'));
  void refresh(); setInterval(() => { void refresh(); }, 200);
}

async function main() {
  const preview = await createPreview();
  const express = require('express'), app = express();
  app.use(express.json({ limit: '32kb' }));
  app.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.get('host') !== `127.0.0.1:${port}` || (request.get('origin') && request.get('origin') !== origin)) {
      return response.status(403).json({ message: '仅允许本地预览访问' });
    }
    next();
  });
  app.get('/', (_request, response) => response.type('html').send(pageHtml()));
  app.get('/state', (_request, response) => response.json(preview.state()));
  app.post('/action', (request, response, next) => preview.action(request.body).then(result => response.json(result)).catch(next));
  app.all('*', (_request, response) => response.status(404).json({ message: '本地预览入口不存在' }));
  app.use((error, _request, response, _next) => response.status(error.getStatus?.() || error.status || 500).json({ message: error.message }));
  const server = app.listen(port, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, origin, ledgerDirectory: preview.directory, externalRequests: 0, realBusinessWrites: 0 })));
  server.on('error', error => { console.error(error.code || 'LOCAL_PREVIEW_START_FAILED'); process.exitCode = 1; });
  process.once('SIGINT', () => server.close(() => process.exit(0)));
}

module.exports = { pageHtml, previewClient };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
