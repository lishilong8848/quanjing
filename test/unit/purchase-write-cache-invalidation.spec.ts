import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as ts from 'typescript';

jest.mock('@server/common/config/external-services.config', () => ({
  assertBitableTableConfig: jest.fn(),
  getFeishuAuthPayload: () => ({ app_id: 'synthetic-invalidation-app', app_secret: 'synthetic-only' }),
}), { virtual: true });

const root = 'server/modules/purchase-inventory/';
let cache: typeof import('../../server/common/feishu/bitable-direct-read');
let temp: string;
const previousDir = process.env.FEISHU_LOCAL_CACHE_DIR;
beforeAll(async () => {
  temp = await mkdtemp(join(tmpdir(), 'nantong-write-invalidation-'));
  process.env.FEISHU_LOCAL_CACHE_DIR = temp;
  cache = require('../../server/common/feishu/bitable-direct-read');
});
afterAll(async () => {
  if (previousDir === undefined) delete process.env.FEISHU_LOCAL_CACHE_DIR; else process.env.FEISHU_LOCAL_CACHE_DIR = previousDir;
  if (temp) await rm(temp, { recursive: true, force: true });
});
function method(file: string, name: string, bindings: Record<string, unknown> = {}) {
  const source = ts.createSourceFile(file, readFileSync(join(process.cwd(), root, file), 'utf8'), ts.ScriptTarget.Latest, true);
  let node: ts.MethodDeclaration | undefined;
  const walk = (candidate: ts.Node) => { if (ts.isMethodDeclaration(candidate) && candidate.name.getText(source) === name) node = candidate; else ts.forEachChild(candidate, walk); };
  walk(source); if (!node) throw new Error(`Missing actual method ${name}`);
  const code = ts.transpileModule(`export const work = async function(${node.parameters.map(p => p.getText(source)).join(',')}) ${node.body!.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function('exports', ...Object.keys(bindings), `${code}; return exports.work;`)({}, ...Object.values(bindings));
}
async function seed(appToken: string, tableId: string) {
  const options = { appToken, tableId, tableName: 'synthetic', forceRefresh: true, strict: true, requirePersisted: true };
  const http = { axiosRef: { post: jest.fn(async (url: string) => url.includes('/auth/')
    ? { data: { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 } }
    : { data: { code: 0, data: { items: [{ record_id: 'old', fields: { value: 'before-write' } }], has_more: false } } }) } };
  await cache.fetchBitableRecords(http as never, options);
  expect(await cache.readLatestPersistedBitableRecordSnapshot({ ...options, directOnly: true })).not.toBeNull();
  return options;
}
const cases = [
  ['updateExecutionRecordWithTimeout', 'execution', (app: string) => ['rec', { 状态: 'synthetic' }, 'token', 10000]],
  ['updateSubmissionRecord', 'submission', (app: string) => ['rec', { 状态: 'synthetic' }, 'token']],
  ['createRecord', 'target', (app: string) => [app, 'target', {}, 'token', 'synthetic']],
  ['deleteRecord', 'target', (app: string) => [app, 'target', 'rec', 'token', 'synthetic']],
  ['batchDeleteRecords', 'target', (app: string) => [app, 'target', ['rec-a', 'rec-b'], 'token', 'synthetic']],
] as const;
describe('purchase mutations invalidate real disk snapshots', () => {
  it.each(cases.flatMap(row => ['success', 'unknown', 'partial'].map(outcome => ({ row, outcome }))))('$row.0 $outcome cannot revive a pre-write snapshot', async ({ row, outcome }) => {
    const [name, table, args] = row, app = `synthetic-${name}-${outcome}`;
    const target = await seed(app, table), unrelated = await seed(app, 'unrelated');
    const write = jest.fn(async () => {
      if (outcome === 'unknown') throw new Error('synthetic lost response');
      return { data: outcome === 'partial' ? { code: 1255000, data: { records: [{ record_id: 'rec-a', deleted: true }] } } : { code: 0, data: { record: { record_id: 'created' } } } };
    });
    const gateway = { config: () => ({ appToken: app, executionTableId: 'execution', submissionTableId: 'submission' }),
      resolveExecutionFieldNames: jest.fn(async f => f), httpService: { axiosRef: { put: write, post: write, delete: write } } };
    const run = method('purchase-workflow.gateway.ts', name, {
      invalidateBitableRecordCache: cache.invalidateBitableRecordCache,
      recordsUrl: (a: string, t: string) => `https://synthetic.invalid/${a}/${t}`,
      requestConfig: () => ({}), clean: (v: unknown) => String(v || ''), BadGatewayException: Error,
      assertFeishuSuccess: (data: any) => { if (data.code !== 0) throw new Error('synthetic partial write'); },
    });
    const promise = run.apply(gateway, args(app));
    if (outcome === 'success') await promise; else await expect(promise).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    expect(await cache.readLatestPersistedBitableRecordSnapshot({ ...target, directOnly: true })).toBeNull();
    expect(await cache.readLatestPersistedBitableRecordSnapshot({ ...unrelated, directOnly: true })).not.toBeNull();
  });
  it('preserves caches when source guard rejects before any write', async () => {
    const target = await seed('synthetic-preflight', 'execution'), write = jest.fn();
    const run = method('purchase-workflow.gateway.ts', 'updateExecutionRecordWithTimeout');
    await expect(run.call({ config: () => ({ appToken: target.appToken, executionTableId: target.tableId }), httpService: { axiosRef: { put: write } } }, 'rec', {}, 'token', 10000,
      async () => { throw new Error('source changed'); })).rejects.toThrow('source changed');
    expect(write).not.toHaveBeenCalled();
    expect(await cache.readLatestPersistedBitableRecordSnapshot({ ...target, directOnly: true })).not.toBeNull();
  });
  it.each(['success', 'unknown', 'missing-id'])('application record %s invalidates without another write', async outcome => {
    const target = await seed(`synthetic-application-${outcome}`, 'execution');
    const write = jest.fn(async () => { if (outcome === 'unknown') throw new Error('lost response'); return { data: { code: 0, data: { record: outcome === 'missing-id' ? {} : { record_id: 'new' } } } }; });
    const run = method('purchase-application.service.ts', 'createApplicationRecord', {
      recordWriteOutcomeIsUncertain: () => true, UncertainApplicationRecordMutationError: Error, safeErrorMessage: () => 'synthetic',
      assertFeishuSuccess: () => undefined, isRecord: (v: any) => !!v && typeof v === 'object', clean: (v: any) => String(v || ''),
    });
    const promise = run.call({ httpService: { axiosRef: { post: write } }, invalidateApplicationRecordCache: (appToken: string, tableId: string) => cache.invalidateBitableRecordCache({ appToken, tableId, deletePersisted: true }) }, target.appToken, target.tableId, {}, 'token');
    if (outcome === 'success') await promise; else await expect(promise).rejects.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    expect(await cache.readLatestPersistedBitableRecordSnapshot({ ...target, directOnly: true })).toBeNull();
  });
  it.each(['unknown', 'source-changed-after-write'])('legacy approval %s invalidates its frozen source only', async outcome => {
    const target = await seed(`synthetic-legacy-${outcome}`, 'execution');
    const write = jest.fn(async () => { if (outcome === 'unknown') throw new Error('lost response'); return { data: { code: 0 } }; });
    const run = method('purchase-platform-legacy-approval-gateway.ts', 'writeDecision', {
      requireSource: () => target, validatePatch: (x: unknown) => x, recordId: (x: unknown) => x,
      acquireToken: async () => ({ token: 'token', credentials: {} }), assertCredentials: () => undefined,
      currentHotfixActivation: () => ({ isAcceptingNewWork: () => true }), http: { axiosRef: { put: write } },
      base: () => 'https://synthetic.invalid', responseData: () => undefined, BadGatewayException: Error,
      assertUnchanged: () => { throw new Error('source changed'); }, invalidateBitableRecordCache: cache.invalidateBitableRecordCache,
    });
    await expect(run('rec', {}, 'synthetic')).rejects.toThrow(); expect(write).toHaveBeenCalledTimes(1);
    expect(await cache.readLatestPersistedBitableRecordSnapshot({ ...target, directOnly: true })).toBeNull();
  });
  it.each(['application', 'workflow'].flatMap(kind => ['success', 'unknown'].map(outcome => ({ kind, outcome }))))('$kind field creation $outcome invalidates the old record projection', async ({ kind, outcome }) => {
    const target = await seed(`synthetic-field-${kind}-${outcome}`, 'execution');
    const write = jest.fn(async () => { if (outcome === 'unknown') throw new Error('lost schema write response'); return { data: { code: 0 } }; });
    const gateway = { config: () => ({ appToken: target.appToken, executionTableId: target.tableId }), getTenantAccessToken: async () => 'token',
      httpService: { axiosRef: { get: async () => ({ data: { code: 0, data: { items: [], has_more: false } } }), post: write } },
      ensuredOnlineLinkFieldCounts: new Map(), invalidateApplicationRecordCache: (appToken: string, tableId: string) => cache.invalidateBitableRecordCache({ appToken, tableId, deletePersisted: true }) };
    const run = method(kind === 'application' ? 'purchase-application.service.ts' : 'purchase-workflow.gateway.ts', kind === 'application' ? 'ensureOnlineLinkFields' : 'ensureManagerApprovalFields', {
      invalidateBitableRecordCache: cache.invalidateBitableRecordCache, fieldsUrl: () => 'https://synthetic.invalid/fields', requestConfig: () => ({}),
      clean: (v: any) => String(v || ''), assertFeishuSuccess: () => undefined, assertManagerApprovalFieldCompatible: () => undefined,
      PURCHASE_MANAGER_APPROVAL_FIELD_DEFINITIONS: [{ name: 'synthetic field', payload: {} }],
    });
    const result = run.call(gateway, target.appToken, target.tableId, 2, 'token');
    if (outcome === 'success') await result; else await expect(result).rejects.toThrow('lost schema');
    expect(write).toHaveBeenCalledTimes(1);
    expect(await cache.readLatestPersistedBitableRecordSnapshot({ ...target, directOnly: true })).toBeNull();
  });
  it.each(['alarm', 'outbound', 'threshold', 'attendance'].flatMap(kind => ['unknown', 'unconfirmed'].map(outcome => ({ kind, outcome }))))('$kind $outcome write invalidates before failed verification', async ({ kind, outcome }) => {
    const target = await seed(`synthetic-${kind}-${outcome}`, 'table');
    const write = jest.fn(async () => { if (outcome === 'unknown') throw new Error('lost response'); return { data: { code: 0, data: {} } }; });
    const bindings = { invalidateBitableRecordCache: cache.invalidateBitableRecordCache,
      assertFeishuSuccess: () => { throw new Error('partial result'); }, BadGatewayException: Error, ServiceUnavailableException: Error,
      recordsUrl: () => 'https://synthetic.invalid', requestConfig: () => ({}), clone: (x: unknown) => x,
      normalizeFeishuOperationError: (x: unknown) => x, safeErrorMessage: () => 'synthetic', InventoryOutboundApprovalSyncUnconfirmedException: Error,
      getTenantAccessToken: async () => 'token', THRESHOLD_APPROVAL_BASE: target.appToken, THRESHOLD_APPROVAL_TABLE: target.tableId,
      buildReviewFields: () => ({}), reviewVersion: () => 'v1', reviewMatches: () => false, ConflictException: Error };
    let run: Promise<unknown>;
    if (kind === 'alarm') {
      const read = jest.fn().mockResolvedValueOnce({ data: { code: 0, data: { record: { record_id: 'rec', fields: {} } } } }).mockRejectedValueOnce(new Error('readback unavailable'));
      run = method('../bitable-sync/alarm-review.gateway.ts', 'syncRecord', bindings).call({ target: async () => ({ ...target, url: 'https://synthetic.invalid', token: 'token' }), http: { axiosRef: { put: write, get: read } } }, 'rec', 'confirmed', 'ou_synthetic', 'v1', '');
    } else if (kind === 'outbound') {
      run = method('../inventory-outbound-approval/inventory-outbound-approval.gateway.ts', 'updateAndVerify', bindings).call({ outboundConfig: () => target, getTenantAccessToken: async () => 'token', httpService: { axiosRef: { put: write } }, readOutboundRecord: async () => { throw new Error('readback unavailable'); } }, 'rec', {}, [], 'synthetic');
    } else if (kind === 'threshold') {
      const request = jest.fn(async () => { await write(); return { data: { code: 1255000 } }; });
      run = method('../threshold-management/threshold-adjustment.gateway.ts', 'request', bindings).call({ http: { axiosRef: { request } } }, 'put', 'table/records/rec', {});
    } else {
      run = method('../duty-schedule/attendance-automation-feishu.gateway.ts', 'postBitableBatch', bindings).call({ httpService: { axiosRef: { post: write } } }, 'https://synthetic.invalid/batch_update', {}, 'token', target);
    }
    await expect(run).rejects.toThrow(); expect(write).toHaveBeenCalledTimes(1);
    expect(await cache.readLatestPersistedBitableRecordSnapshot({ ...target, directOnly: true })).toBeNull();
  });
  it.each(['outbound', 'threshold'])('%s token rejection preserves the old snapshot without a write', async kind => {
    const target = await seed(`synthetic-${kind}-preflight`, 'table'), write = jest.fn();
    const token = async () => { throw new Error('preflight rejected'); };
    const bindings = { getTenantAccessToken: token, invalidateBitableRecordCache: cache.invalidateBitableRecordCache };
    const run = kind === 'outbound'
      ? method('../inventory-outbound-approval/inventory-outbound-approval.gateway.ts', 'updateAndVerify', bindings).call({ outboundConfig: () => target, getTenantAccessToken: token, httpService: { axiosRef: { put: write } } }, 'rec', {}, [], 'synthetic')
      : method('../threshold-management/threshold-adjustment.gateway.ts', 'request', bindings).call({ http: { axiosRef: { request: write } } }, 'put', 'table/records/rec', {});
    await expect(run).rejects.toThrow('preflight rejected'); expect(write).not.toHaveBeenCalled();
    expect(await cache.readLatestPersistedBitableRecordSnapshot({ ...target, directOnly: true })).not.toBeNull();
  });
  it('attendance duplicate cleanup invalidates a partial deletion and preserves its original error', async () => {
    const target = await seed('synthetic-attendance-partial-delete', 'table');
    const file = join(process.cwd(), 'server/modules/duty-schedule/attendance-automation-feishu.gateway.ts');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    let loop: ts.ForOfStatement | undefined;
    const visit = (node: ts.Node) => { if (ts.isForOfStatement(node) && node.expression.getText(source).includes('reconciliation.duplicates')) loop = node; else ts.forEachChild(node, visit); };
    visit(source); expect(loop).toBeDefined();
    const code = ts.transpileModule(`export const work = async function() { ${loop!.getText(source)} };`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    const write = jest.fn(async () => ({ data: { code: 0, data: { records: [{ record_id: 'a', deleted: true }, { record_id: 'b', deleted: false }] } } }));
    const env = { ...target, token: 'synthetic', reconciliation: { duplicates: [{ record_id: 'a' }, { record_id: 'b' }] },
      getRecordId: (v: any) => v.record_id, chunks: (v: any[]) => [v], recordsUrl: () => 'https://synthetic.invalid', invalidateBitableRecordCache: cache.invalidateBitableRecordCache };
    const run = new Function('exports', ...Object.keys(env), `${code};return exports.work;`)({}, ...Object.values(env));
    await expect(run.call({ httpService: { axiosRef: { post: write } } })).rejects.toThrow('飞书考勤重复行删除未全部确认');
    expect(write).toHaveBeenCalledTimes(1);
    expect(await cache.readLatestPersistedBitableRecordSnapshot({ ...target, directOnly: true })).toBeNull();
  });
});
