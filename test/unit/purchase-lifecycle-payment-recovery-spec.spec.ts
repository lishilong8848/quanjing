import { projectLifecyclePaymentRecovery, type LifecyclePaymentRecoveryRow } from '../../server/modules/purchase-inventory/purchase-lifecycle-payment-recovery-spec';

const query = Object.freeze({ appId: 'cli_app', actorOpenId: 'ou_actor', approvalBatchId: 'purchase-batch-1', executionRecordId: 'rec_1' });
const authorize = () => true as const;
function row(status: LifecyclePaymentRecoveryRow['entry']['status']): LifecyclePaymentRecoveryRow {
  return { ...query, entry: { status } };
}
describe('isolated cross-device payment recovery projection contract', () => {
  it.each(['prepared', 'dispatching', 'uploaded', 'manual_reconciliation'] as const)('redacts sensitive details and blocks new uploads for %s', state => {
    const withSecrets = { ...row(state), requestId: 'secret-uuid', generation: 42, entry: { status: state, tokens: ['secret-token'], fingerprint: 'secret-hash' } };
    const result = projectLifecyclePaymentRecovery(query, [withSecrets], authorize);
    expect(result).toEqual({ state: 'pending', mayStartNewUpload: false });
    expect(JSON.stringify(result)).not.toMatch(/secret|uuid|token|hash|42/);
    expect(Object.isFrozen(result)).toBe(true);
  });
  it('never treats an empty or terminal-only list as proof that delayed requests are fenced', () => {
    for (const rows of [[], [row('committed')], [row('cancelled')]]) {
      expect(projectLifecyclePaymentRecovery(query, rows, authorize)).toEqual({ state: 'none_verified', mayStartNewUpload: false });
    }
  });
  it('reports only the authenticated actor and exact app and order, with no cross-user disclosure', () => {
    const others = [
      { ...row('dispatching'), actorOpenId: 'ou_other' }, { ...row('prepared'), appId: 'cli_other' },
      { ...row('uploaded'), approvalBatchId: 'purchase-other' }, { ...row('dispatching'), executionRecordId: 'rec_other' },
    ];
    expect(projectLifecyclePaymentRecovery(query, others, authorize)).toEqual({ state: 'none_verified', mayStartNewUpload: false });
  });
  it('rejects unauthorized, failed or asynchronous authorization and malformed records', () => {
    expect(() => projectLifecyclePaymentRecovery(query, [row('prepared')], () => false as never)).toThrow();
    expect(() => projectLifecyclePaymentRecovery(query, [], () => Promise.resolve(true) as never)).toThrow();
    expect(() => projectLifecyclePaymentRecovery(query, [], () => { throw new Error('revoked'); })).toThrow();
    expect(() => projectLifecyclePaymentRecovery(query, [{ ...row('prepared'), entry: { status: 'unknown' } } as never], authorize)).toThrow();
  });
});
