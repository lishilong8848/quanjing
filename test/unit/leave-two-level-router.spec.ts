import { FeishuCardActionRouter as BaseRouter } from '../../server/modules/purchase-inventory/feishu-card-action.router';
import { withSyntheticBusinessIdentity } from './synthetic-business-identity.fixture';
import { fixture, primary } from './fixtures/leave-two-level';
import { currentHotfixActivation } from '../../server/common/hotfix-runtime-activation';

const Router = withSyntheticBusinessIdentity(BaseRouter, 8);
const card = { schema: '2.0', header: { title: { tag: 'plain_text', content: '核对替班' } }, body: { elements: [] } };
describe('two-level leave navigation through the real callback router', () => {
  beforeEach(async () => {
    const activation = currentHotfixActivation();
    activation.completeBootstrap();
    await activation.refresh();
    expect(activation.isAcceptingNewWork()).toBe(true);
  });
  it('classifies review as leave, patches the current message and never returns a raw editing card', async () => {
    const leave = { isEnabled: () => true, renderApprovalCardView: jest.fn().mockResolvedValue(card), patchApprovalCardView: jest.fn().mockResolvedValue(undefined), acceptApprovalAction: jest.fn() };
    const unused = { isEnabled: () => false } as never;
    const router = new Router(unused, leave as never, unused, {} as never, unused, unused, unused);
    const data = fixture();
    const result = await router.handle({ event_type: 'card.action.trigger', operator: { open_id: 'ou_supervisor' }, context: { open_message_id: 'om_test_two_level' }, action: { tag: 'button', name: `leave_substitute_review_submit:${data.application.recordId}:supervisor:1:g1:r1`, form_value: { [`leave_shift_substitute_${Buffer.from(data.selection.shiftKey).toString('base64url')}`]: primary.personRecordId } } });
    expect(result.toast.type).toBe('info');
    expect(result.toast.content).toBe('正在更新替班核对结果');
    expect(result).not.toHaveProperty('card');
    expect(leave.renderApprovalCardView).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_test_two_level', view: 'substitute_review' }));
    expect(leave.patchApprovalCardView).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'om_test_two_level' }), card);
    expect(leave.acceptApprovalAction).not.toHaveBeenCalled();
  });
});
