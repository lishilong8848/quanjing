import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PurchaseInventoryModule } from '../../server/modules/purchase-inventory/purchase-inventory.module';
import { PURCHASE_LIFECYCLE_NEW_APPLICATIONS } from '../../server/modules/purchase-inventory/purchase-application.service';
import { PurchaseApplicationTaskLedgerStore, PURCHASE_APPLICATION_TASK_LEDGER_OPTIONS, PURCHASE_APPLICATION_TASK_LEDGER_PATH } from '../../server/modules/purchase-inventory/purchase-application-task-ledger.store';
import { GlobalExceptionFilter } from '../../server/common/filters/exception.filter';
import { isUncertainPurchaseSubmissionError, reconnectPurchaseApplicationAcceptance } from '../../client/src/pages/PurchaseInventoryManagement/purchase-application.logic';

let mockAdmissionSetting = '';
jest.mock('../../server/common/config/external-services.config', () => ({
  ...jest.requireActual('../../server/common/config/external-services.config'),
  readEnv: (key: string) => key === 'PURCHASE_LIFECYCLE_CARD_ENABLED' ? mockAdmissionSetting : '',
}));

describe('production purchase admission wiring', () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'purchase-admission-wiring-')); mockAdmissionSetting = ''; });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  async function ledger() {
    // Use the actual module registrations, not a test-only enabled store option.
    const providers = Reflect.getMetadata('providers', PurchaseInventoryModule).filter((p: any) =>
      p === PurchaseApplicationTaskLedgerStore || [PURCHASE_LIFECYCLE_NEW_APPLICATIONS, PURCHASE_APPLICATION_TASK_LEDGER_OPTIONS].includes(p.provide));
    const module = await Test.createTestingModule({ providers: [...providers,
      { provide: PURCHASE_APPLICATION_TASK_LEDGER_PATH, useValue: join(directory, 'applications.json') },
    ] }).compile();
    return module.get(PurchaseApplicationTaskLedgerStore);
  }
  const entry = (id = 'original-request-123', flowVersion: 'legacy' | 'lifecycle_v1' = 'lifecycle_v1') => ({
    building: 'H楼', principalFingerprint: 'synthetic-owner', idempotencyKey: id,
    requestFingerprint: '1'.repeat(64), submissionFingerprint: '2'.repeat(64), flowVersion,
    task: { id: 'purchase-application-' + id, status: 'pending' as const, message: 'synthetic', createdAt: new Date().toISOString() },
  });
  it.each(['', 'true', 'on', 'false'])('uses separate stage cards with a previous configuration value of %s', async setting => {
    mockAdmissionSetting = setting;
    const store = await ledger();
    expect(store.reserve(entry('legacy-request-123', 'legacy')).entry.flowVersion).toBe('legacy');
    expect(() => store.reserve(entry())).toThrow('采购全流程卡');
    expect(store.findByIdentity('H楼', 'synthetic-owner', 'original-request-123')).toBeUndefined();
  });
  it('drains existing reservations when disabled, but rejects a new reservation as definitely not written through the HTTP error contract', async () => {
    const previousVersion = new PurchaseApplicationTaskLedgerStore(join(directory, 'applications.json'), { allowLifecycleReservations: true });
    const original = entry(); previousVersion.reserve(original);
    mockAdmissionSetting = 'true';
    const disabled = await ledger();
    expect(disabled.reserve({ ...original, task: { ...original.task, id: 'must-not-create-a-second-task' } })).toMatchObject({
      created: false, entry: { task: { id: original.task.id } },
    });
    let failure: unknown;
    try { disabled.reserve(entry('new-request-456')); } catch (e) { failure = e; }
    expect(failure).toBeDefined();
    expect(disabled.findByIdentity('H楼', 'synthetic-owner', 'new-request-456')).toBeUndefined();
    let body: unknown;
    const response = { headersSent: false, status: jest.fn().mockReturnThis(), json: jest.fn(value => { body = value; }) };
    new GlobalExceptionFilter().catch(failure, { switchToHttp: () => ({ getResponse: () => response, getRequest: () => ({ method: 'POST', url: '/api/purchase-inventory/applications' }) }) } as any);
    expect(body).toMatchObject({ writeDisposition: 'definitely-not-written' });
    const error = { response: { status: 503, data: body } };
    expect(isUncertainPurchaseSubmissionError(error)).toBe(false);
    const reconnect = jest.fn().mockRejectedValue(error);
    expect((await reconnectPurchaseApplicationAcceptance({ reconnect, delaysMs: [0, 0] })).kind).toBe('definitely-not-written');
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(disabled.reserve(entry('legacy-request-789', 'legacy')).created).toBe(true);
  });
  it('keeps unknown outcomes locked rather than treating an ordinary 503 as proof of no write', () => {
    for (const data of [{}, { writeDisposition: 'unknown-result' }, { writeDisposition: 'unknown-result', definitelyNotWritten: true }]) {
      expect(isUncertainPurchaseSubmissionError({ response: { status: 503, data } })).toBe(true);
    }
  });
});
