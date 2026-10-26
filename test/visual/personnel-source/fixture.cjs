const { randomUUID, createHash } = require('node:crypto');
const version = 'd'.repeat(64), appId = 'cli_source_visual_synthetic';
const clone = value => JSON.parse(JSON.stringify(value));
const makeSource = () => ({ status: 'active', source: { appId, appToken: 'syntheticBase', tableId: 'tblPeople', dutyTableId: 'tblDuties' }, directoryVersion: version,
  activatedAt: Date.now(), lastSuccessAt: Date.now(), pending: [], routes: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => {
    const dutyRecordId = `recSource${index + 1}`;
    return [dutyRecordId, { appId, dutyRecordId, kind: 'warehouse_approver', buildings: ['C楼'], specialties: null, startsAt: 0, endsAt: null, version: 1,
      confirmedBatchId: 'eb761f03-468f-4a86-b971-1f074fa695cc', members: [{ personId: `local-external-${'a'.repeat(64)}`, recordId: 'recPerson', openId: 'ou_source_current', name: '现任合成负责人' }] }];
  })) });
function createFixture() {
  let configuration, mode, loseNext, holdSave, heldSave, heldPreview;
  let requests = [], mutationWrites = 0, baselineWrites = 0, ledger = new Map(), previewCalls = 0, baselinePreviewCalls = 0, events = [];
  const event = action => events.push({ action, at: Date.now(), revision: configuration?.revision, sourceStatus: configuration?.personnelSource?.status });
  function reset(options = {}) {
    heldSave?.response.destroy(); heldPreview?.response.destroy(); heldSave = heldPreview = undefined;
    configuration = { revision: 1, appId, accounts: [], audit: [], cardRules: [
      { appId, code: 'warehouse_responsible', building: 'C楼', version: 1, members: [{ openId: 'ou_source_old', name: '旧覆盖人员' }] },
      { appId, code: 'warehouse_notify', building: 'C楼', version: 1, members: [{ openId: 'ou_source_notify', name: '未接管知会人员' }] },
    ], ...(options.active ? { personnelSource: makeSource() } : {}) };
    if(options.baseline)configuration.cardRules[0].members=[{openId:'ou_source_current',name:'旧缓存姓名'}];
    mode = options.mode || 'ready'; loseNext = options.loseNext || false; holdSave = !!options.holdSave;
    requests = []; mutationWrites = 0; baselineWrites = 0; ledger = new Map(); previewCalls = 0; baselinePreviewCalls = 0; events = []; event('reset');
  }
  reset();
  function preview(variant = mode) {
    const rows = Array.from({ length: variant === 'old' ? 1 : 1000 }, (_, index) => ({ dutyRecordId: `recSource${index + 1}`, name: variant === 'old' ? '过期旧职责' : `合成职责${String(index + 1).padStart(4, '0')}`,
      kind: 'warehouse_approver', buildings: ['C楼'], specialties: null, members: ['现任合成负责人'], status: variant === 'blocked' ? 'unconfirmed' : 'aligned', ...(variant === 'blocked' ? { reason: '岗位人员已变化，请完成岗位交接' } : {}) }));
    return { configurationRevision: configuration.revision, directoryVersion: version, checkedAt: Date.now(), canActivate: variant !== 'empty' && variant !== 'blocked',
      unmanagedKinds:['purchase_approver','contract_notify'],problems: variant === 'empty' ? ['尚无可识别岗位，请核对人员岗位、范围或额外职责'] : [], rows: variant === 'empty' ? [] : rows };
  }
  function baselinePreview(variant=mode){
    const value=preview(variant), routes=makeSource().routes;
    return {...value,oldSourceFingerprint:'f'.repeat(64),previewFingerprint:createHash('sha256').update(JSON.stringify([configuration.revision,variant,'synthetic-baseline'])).digest('hex'),canConfirm:value.canActivate,
      rows:value.rows.map(row=>({...row,dutyRecordId:`position-${createHash('sha256').update(row.dutyRecordId).digest('hex')}`,origin:'personnel_position',source:'已核对原库房审批配置'})),assignments:Object.fromEntries(Object.entries(routes).map(([id,route])=>{const {confirmedBatchId,...body}=route;const key=`position-${createHash('sha256').update(id).digest('hex')}`;return [key,{...body,dutyRecordId:key,origin:'personnel_position'}];}))};
  }
  const send = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
  async function handle(request, response) {
    const url = new URL(request.url, 'http://fixture'), prefix = '/api/access/configuration';
    let body = ''; if (request.method === 'POST') for await (const chunk of request) body += chunk;
    const input = body ? JSON.parse(body) : {};
    if (url.pathname === '/__fixture/reset') { reset(input); send(response, 200, {}); return true; }
    if (url.pathname === '/__fixture/control') {
      event(`control:${input.action || input.mode}`);
      if (input.mode) mode = input.mode;
      if (input.action === 'releasePreview' && heldPreview) { send(heldPreview.response, 201, heldPreview.value); heldPreview = undefined; }
      if (input.action === 'releaseSave' && heldSave) { send(heldSave.response, 201, heldSave.value); heldSave = undefined; }
      if (input.action === 'externalPause') { configuration.personnelSource = { ...(configuration.personnelSource || makeSource()), status: 'paused' }; configuration.revision++; }
      if (input.action === 'externalBaseline') { configuration.personnelBaseline={id:randomUUID(),confirmedAt:Date.now(),actorName:'另一合成管理员',count:999};configuration.revision++; }
      event(`controlled:${input.action || input.mode}`);
      send(response, 200, {}); return true;
    }
    if (url.pathname === '/__fixture/status') { send(response, 200, { requests, mutationWrites, baselineWrites, previewCalls, baselinePreviewCalls, revision: configuration.revision, sourceStatus: configuration.personnelSource?.status, heldSave: !!heldSave, heldPreview: !!heldPreview }); return true; }
    if (!url.pathname.startsWith(prefix)) return false;
    requests.push({ method: request.method, url: url.pathname, input });
    if (url.pathname === prefix && request.method === 'GET') { send(response, 200, configuration); return true; }
    if (url.pathname === prefix + '/people') { send(response, 200, { appId, accounts: [], people: [{ openId: 'ou_source_current', name: '旧缓存姓名' }], snapshotAt: Date.now() }); return true; }
    if(url.pathname===prefix+'/personnel-baseline/preview'){
      baselinePreviewCalls++;if(mode==='holdPreview'){heldPreview={response,value:baselinePreview('old')};return true;}
      await new Promise(resolve=>setTimeout(resolve,mode==='slowRead'?16000:200));if(mode==='error')send(response,503,{message:'合成来源暂不可用，请重试'});else send(response,201,baselinePreview());return true;
    }
    if(url.pathname===prefix+'/personnel-baseline/confirm'){
      event('baseline:received');
      if(ledger.has(input.clientMutationId)){if(JSON.stringify(input)!==ledger.get(input.clientMutationId))send(response,409,{message:'重复内容不一致'});else send(response,201,configuration);return true;}
      if(configuration.personnelSource||input.expectedRevision!==configuration.revision||input.expectedFingerprint!==baselinePreview().previewFingerprint||!baselinePreview().canConfirm){send(response,409,{message:'目录、现行岗位或配置已变化，请重新核对首次清单'});return true;}
      await new Promise(resolve=>setTimeout(resolve,200));configuration.personnelBaseline={id:randomUUID(),confirmedAt:Date.now(),actorName:'合成管理员',count:1000};configuration.revision++;
      ledger.set(input.clientMutationId,JSON.stringify(input));baselineWrites++;event('baseline:committed');
      if(loseNext){loseNext=false;response.writeHead(201,{'Content-Type':'application/json; charset=utf-8'});response.end('{');return true;}
      if(holdSave){holdSave=false;heldSave={response,value:clone(configuration)};return true;}send(response,201,configuration);return true;
    }
    if (url.pathname === prefix + '/card-members') {
      const code = url.searchParams.get('code'), building = url.searchParams.get('building');
      const owned = configuration.personnelSource && code === 'warehouse_responsible' && building === 'C楼';
      send(response, 200, { members: owned ? [{ openId: 'ou_source_current', name: '现任合成负责人' }] : configuration.cardRules.find(rule => rule.code === code && rule.building === building)?.members || [{ openId: 'ou_other', name: '合成默认人员' }] }); return true;
    }
    if (url.pathname === prefix + '/personnel-source/preview') {
      previewCalls++;
      if (mode === 'holdPreview') { heldPreview = { response, value: preview('old') }; return true; }
      await new Promise(resolve => setTimeout(resolve, 200));
      if (mode === 'error') send(response, 503, { message: '合成来源暂不可用，请重试' }); else send(response, 201, preview());
      return true;
    }
    if (url.pathname === prefix + '/personnel-source') {
      event('mutation:received');
      if (ledger.has(input.clientMutationId)) { if (JSON.stringify(input) !== ledger.get(input.clientMutationId)) send(response, 409, { message: '重复内容不一致' }); else send(response, 201, configuration); return true; }
      if (input.expectedRevision !== configuration.revision || input.expectedDirectoryVersion !== version || mode === 'empty' || mode === 'blocked') { send(response, 409, { message: '来源已变化，请重新核对' }); return true; }
      await new Promise(resolve => setTimeout(resolve, 200));
      configuration.personnelSource = input.action === 'pause' ? { ...configuration.personnelSource, status: 'paused' } : makeSource(); configuration.revision++;
      ledger.set(input.clientMutationId, JSON.stringify(input)); mutationWrites++;
      event('mutation:committed');
      if (loseNext) {
        const disconnect = loseNext === 'connection';
        loseNext = false;
        if (disconnect) { response.destroy(); return true; }
        // A complete HTTP response with a lost JSON tail cannot be silently retried by Chromium's connection recovery.
        response.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' }); response.end('{'); return true;
      }
      if (holdSave) { holdSave = false; heldSave = { response, value: clone(configuration) }; return true; }
      send(response, 201, configuration); return true;
    }
    send(response, 404, { message: 'Unexpected fixture API' }); return true;
  }
  return { handle, snapshot: () => ({ requests, events, mutationWrites, baselineWrites, previewCalls, baselinePreviewCalls, revision: configuration.revision, sourceStatus: configuration.personnelSource?.status }),
    close() { heldSave?.response.destroy(); heldPreview?.response.destroy(); }, id: randomUUID() };
}
module.exports = { createFixture };
