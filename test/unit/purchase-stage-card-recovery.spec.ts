import { PurchaseStageCardRecoveryService } from '../../server/modules/purchase-inventory/purchase-stage-card-recovery.service';
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';
import { readEnv } from '../../server/common/config/external-services.config';
import { currentHotfixActivation, runHotfixInitialization } from '../../server/common/hotfix-runtime-activation';
import { purchaseLifecycleNewApplicationsEnabled } from '../../server/modules/purchase-inventory/purchase-lifecycle-composition';

jest.mock('../../server/common/config/external-services.config', () => ({ readEnv: jest.fn() }));
jest.mock('../../server/common/hotfix-runtime-activation', () => ({
  currentHotfixActivation: jest.fn(), runHotfixInitialization: jest.fn(), cancelHotfixInitialization: jest.fn(),
}));
jest.mock('../../server/modules/purchase-inventory/purchase-lifecycle-composition', () => ({ purchaseLifecycleNewApplicationsEnabled: jest.fn() }));

describe('staged procurement recovery coordinator', () => {
  const originalEnvironment = process.env.NODE_ENV;
  const originalSmoke = process.env.NANTONG_HOTFIX_SMOKE_MODE;
  const candidate = { approvalBatchId: 'batch-001', appId: 'cli_test', batchRevision: 4, recordIds: ['recOne'],
    replicas: [{ recipientOpenId: 'ou_manager', messageId: 'om_original', generation: 1, appliedRevision: 4, sentAtMs: 1000, managerApproval: true }] };
  const make = (updateLifecycleCard?: PurchaseWorkflowGateway['updateLifecycleCard']) => {
    const store = {
      listLifecycleStageCardTransitionCandidates: jest.fn().mockResolvedValue([candidate]),
      transitionLifecycleBatchToStageCards: jest.fn().mockResolvedValue({ changed: true }),
      listStageCardRetirementTargets: jest.fn().mockResolvedValue([]), markStageCardReplicaRetired: jest.fn(),
    };
    const gateway = { readLifecycleCardForStageTransition: jest.fn().mockResolvedValue(undefined),
      readRecordsForStageTransition: jest.fn().mockResolvedValue({ records: [{ recordId: 'recOne', status: '待下单' }], missingRecordIds: [] }),
      updateLifecycleCard };
    const manager = { isEnabled: () => true, requeueFailedMigratedOrderCards: jest.fn().mockResolvedValue(undefined) };
    return { store, gateway, manager, service: new PurchaseStageCardRecoveryService(store as never, gateway as never, manager as never) };
  };
  beforeEach(() => {
    jest.clearAllMocks(); process.env.NODE_ENV = 'production'; delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
    jest.mocked(readEnv).mockReturnValue('cli_test');
    jest.mocked(currentHotfixActivation).mockReturnValue({ isAcceptingNewWork: () => true } as never);
    jest.mocked(purchaseLifecycleNewApplicationsEnabled).mockReturnValue(false);
  });
  afterAll(() => {
    if (originalEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = originalEnvironment;
    if (originalSmoke === undefined) delete process.env.NANTONG_HOTFIX_SMOKE_MODE; else process.env.NANTONG_HOTFIX_SMOKE_MODE = originalSmoke;
  });
  it('reconciles original messages and source before the same-batch transition', async () => {
    const { service, store, gateway } = make();
    await service.runPending();
    expect(gateway.readLifecycleCardForStageTransition).toHaveBeenCalledWith('cli_test', 'om_original', 1000);
    expect(store.transitionLifecycleBatchToStageCards).toHaveBeenCalledWith(expect.objectContaining({
      ...candidate, records: [{ recordId: 'recOne', status: '待下单' }], missingRecordIds: [], verifiedAt: expect.any(Number),
    }));
  });
  it('cannot transition when original message verification fails', async () => {
    const { service, store, gateway } = make(); gateway.readLifecycleCardForStageTransition.mockRejectedValue(new Error('read failed'));
    await service.runPending(); expect(store.transitionLifecycleBatchToStageCards).not.toHaveBeenCalled();
  });
  it('cannot transition if the application changes during source reads', async () => {
    const { service, store, gateway } = make();
    gateway.readRecordsForStageTransition.mockImplementation(async () => {
      jest.mocked(readEnv).mockReturnValue('cli_other'); return { records: [], missingRecordIds: ['recOne'] };
    });
    await service.runPending(); expect(store.transitionLifecycleBatchToStageCards).not.toHaveBeenCalled();
  });
  it('does not recover business state in smoke mode or before runtime activation', async () => {
    const { service, store, manager } = make(); process.env.NANTONG_HOTFIX_SMOKE_MODE = 'true';
    await service.runPending(); delete process.env.NANTONG_HOTFIX_SMOKE_MODE;
    jest.mocked(currentHotfixActivation).mockReturnValue({ isAcceptingNewWork: () => false } as never);
    await service.runPending(); expect(store.listLifecycleStageCardTransitionCandidates).not.toHaveBeenCalled();
    expect(manager.requeueFailedMigratedOrderCards).not.toHaveBeenCalled();
  });
  it('registers during initialization and waits for acceptance before processing', async () => {
    jest.useFakeTimers();
    const { service, store, manager } = make(); let accepting = false;
    jest.mocked(currentHotfixActivation).mockReturnValue({ isAcceptingNewWork: () => accepting } as never);
    jest.mocked(runHotfixInitialization).mockImplementation(async (_owner, initialize) => { await initialize(); });
    try {
      await service.onModuleInit(); expect(store.listLifecycleStageCardTransitionCandidates).not.toHaveBeenCalled();
      accepting = true; await jest.advanceTimersByTimeAsync(30_000);
      expect(store.transitionLifecycleBatchToStageCards).toHaveBeenCalledTimes(1);
      expect(manager.requeueFailedMigratedOrderCards).toHaveBeenCalledWith('cli_test');
    } finally { await service.onModuleDestroy(); jest.useRealTimers(); }
  });
  it('merges concurrent scans and retains the original mutation identity', async () => {
    const { service, store, gateway } = make(); let release!: () => void;
    gateway.readLifecycleCardForStageTransition.mockReturnValue(new Promise<void>(resolve => { release = resolve; }));
    const first = service.runPending(); const second = service.runPending(); expect(first).toBe(second);
    await Promise.resolve(); release(); await first;
    expect(store.transitionLifecycleBatchToStageCards).toHaveBeenCalledTimes(1);
  });
  it('marks an obsolete replica retired only after a confirmed read-only card patch', async () => {
    const patch = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const transport = new PurchaseWorkflowGateway({ axiosRef: { patch } } as never);
    jest.spyOn(transport as never, 'getTenantAccessToken' as never).mockResolvedValue('test-token' as never);
    const { service, store, gateway } = make(transport.updateLifecycleCard.bind(transport));
    store.listLifecycleStageCardTransitionCandidates.mockResolvedValue([]);
    store.listStageCardRetirementTargets.mockResolvedValue([{ approvalBatchId: 'batch-001', appId: 'cli_test', messageId: 'om_observer', sentAtMs: 2000 }] as never);
    await service.runPending();
    expect(gateway.readLifecycleCardForStageTransition).toHaveBeenCalledWith('cli_test', 'om_observer', 2000);
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith('https://open.feishu.cn/open-apis/im/v1/messages/om_observer',
      { content: expect.any(String) }, expect.any(Object));
    expect(JSON.parse(patch.mock.calls[0][1].content)).toEqual({
      schema: '2.0',
      config: { update_multi: true, enable_forward: false },
      header: { template: 'grey', title: { tag: 'plain_text', content: '采购已恢复分阶段办理' } },
      body: { elements: [{ tag: 'markdown', content: '此全流程卡片已结束。审批、下单、签收和入库将使用各环节独立卡片，已有办理结果已保留。' }] },
    });
    expect(store.markStageCardReplicaRetired).toHaveBeenCalledWith('batch-001', 'cli_test', 'om_observer');
    expect(gateway.readLifecycleCardForStageTransition.mock.invocationCallOrder[0]).toBeLessThan(patch.mock.invocationCallOrder[0]);
    expect(patch.mock.invocationCallOrder[0]).toBeLessThan(store.markStageCardReplicaRetired.mock.invocationCallOrder[0]);

    patch.mockResolvedValue({ data: { code: 230099, msg: 'rejected card' } });
    store.markStageCardReplicaRetired.mockClear();
    await service.runPending(); expect(store.markStageCardReplicaRetired).not.toHaveBeenCalled();
  });
});

describe('procurement stage recovery message evidence', () => {
  it('accepts explicit absence but refuses forbidden or incomplete purchase source results', async () => {
    jest.mocked(readEnv).mockReturnValue('cli_test');
    const post = jest.fn().mockResolvedValue({ data: { code: 0, data: { records: [], absent_record_ids: ['recOne'], forbidden_record_ids: [] } } });
    const gateway = new PurchaseWorkflowGateway({ axiosRef: { post } } as never);
    jest.spyOn(gateway as never, 'getTenantAccessToken' as never).mockResolvedValue('test-token' as never);
    jest.spyOn(gateway as never, 'config' as never).mockReturnValue({ appToken: 'app_test', executionTableId: 'tbl_test' } as never);
    await expect(gateway.readRecordsForStageTransition('cli_test', ['recOne'])).resolves.toEqual({ records: [], missingRecordIds: ['recOne'] });
    post.mockResolvedValue({ data: { code: 0, data: { records: [], absent_record_ids: [], forbidden_record_ids: ['recOne'] } } });
    await expect(gateway.readRecordsForStageTransition('cli_test', ['recOne'])).rejects.toThrow();
    post.mockResolvedValue({ data: { code: 0, data: { records: [], absent_record_ids: [], forbidden_record_ids: [] } } });
    await expect(gateway.readRecordsForStageTransition('cli_test', ['recOne'])).rejects.toThrow();
  });
  it('rejects a different app, deleted card or changed original message timestamp', async () => {
    jest.mocked(readEnv).mockReturnValue('cli_test');
    const message = { message_id: 'om_original', msg_type: 'interactive', deleted: false,
      sender: { id: 'cli_test', id_type: 'app_id', sender_type: 'app' }, create_time: '1000' };
    const get = jest.fn().mockResolvedValue({ data: { code: 0, data: { items: [message] } } });
    const gateway = new PurchaseWorkflowGateway({ axiosRef: { get } } as never);
    jest.spyOn(gateway as never, 'getTenantAccessToken' as never).mockResolvedValue('test-token' as never);
    await expect(gateway.readLifecycleCardForStageTransition('cli_test', 'om_original', 1000)).resolves.toBeUndefined();
    message.deleted = true;
    await expect(gateway.readLifecycleCardForStageTransition('cli_test', 'om_original', 1000)).rejects.toThrow();
    message.deleted = false; message.sender.id = 'cli_other';
    await expect(gateway.readLifecycleCardForStageTransition('cli_test', 'om_original', 1000)).rejects.toThrow();
    message.sender.id = 'cli_test'; message.create_time = '1001';
    await expect(gateway.readLifecycleCardForStageTransition('cli_test', 'om_original', 1000)).rejects.toThrow();
  });
});
