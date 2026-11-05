jest.mock('../../server/common/feishu-card-copy/transport', () => ({
  observedCardPost: jest.fn(),
  observedCardPatch: jest.fn(),
  observedCardTokenUpdate: jest.fn(),
}));
jest.mock('../../server/common/config/external-services.config', () => ({
  ...jest.requireActual('../../server/common/config/external-services.config'),
  readEnv: jest.fn((name: string) => name === 'FEISHU_APP_ID' ? 'cli_flow_test' : ''),
}));

import { observedCardPost, observedCardPatch } from '../../server/common/feishu-card-copy/transport';
import { PurchaseWorkflowGateway } from '../../server/modules/purchase-inventory/purchase-workflow.gateway';

const card = { schema: '2.0', config: { update_multi: true }, body: { elements: [] } };
const uuid = 'flow_test_uuid_01';
const appId = 'cli_flow_test';
const sentAt = 1793772000000;

function setup() {
  const axiosRef = {
    post: jest.fn().mockResolvedValue({ status: 200, data: { code: 0, data: { message_id: 'om_flow_1' } } }),
    get: jest.fn().mockResolvedValue({ status: 200, data: { code: 0, data: { items: [{ message_id: 'om_flow_1', msg_type: 'interactive', create_time: String(sentAt), deleted: false, sender: { id: appId } }] } } }),
    patch: jest.fn().mockResolvedValue({ status: 200, data: { code: 0 } }),
  };
  const gateway = new PurchaseWorkflowGateway({ axiosRef } as never);
  jest.spyOn(gateway as unknown as { getTenantAccessToken(): Promise<string> }, 'getTenantAccessToken').mockResolvedValue('test-token');
  return { gateway, axiosRef };
}

describe('purchase lifecycle dedicated transport', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns a receipt only after the sent message and time are read back', async () => {
    const { gateway, axiosRef } = setup();
    await expect(gateway.sendLifecycleCard('ou_recipient', card, uuid, appId)).resolves.toEqual({ source: 'feishu_message_readback', uuid, messageId: 'om_flow_1', sentAtMs: sentAt });
    expect(axiosRef.post).toHaveBeenCalledWith(expect.stringContaining('/im/v1/messages?receive_id_type=open_id'), expect.objectContaining({ receive_id: 'ou_recipient', uuid, content: JSON.stringify(card) }), expect.any(Object));
    expect(axiosRef.get).toHaveBeenCalledWith(expect.stringContaining('/im/v1/messages/om_flow_1'), expect.any(Object));
    expect(observedCardPost).not.toHaveBeenCalled();
  });

  it.each([
    { items: [] },
    { items: [{ message_id: 'om_other', msg_type: 'interactive', create_time: String(sentAt) }] },
    { items: [{ message_id: 'om_flow_1', msg_type: 'text', create_time: String(sentAt) }] },
    { items: [{ message_id: 'om_flow_1', msg_type: 'interactive', create_time: 'bad' }] },
    { items: [{ message_id: 'om_flow_1', msg_type: 'interactive', create_time: String(sentAt), deleted: true }] },
    { items: [{ message_id: 'om_flow_1', msg_type: 'interactive', create_time: String(sentAt), deleted: false, sender: { id: 'cli_other' } }] },
  ])('refuses an unverified message receipt without retrying the send', async ({ items }) => {
    const { gateway, axiosRef } = setup();
    axiosRef.get.mockResolvedValue({ status: 200, data: { code: 0, data: { items } } });
    await expect(gateway.sendLifecycleCard('ou_recipient', card, uuid, appId)).rejects.toThrow();
    expect(axiosRef.post).toHaveBeenCalledTimes(1);
  });

  it('updates only the specified valid message without triggering generic copying', async () => {
    const { gateway, axiosRef } = setup();
    await gateway.updateLifecycleCard('om_flow_1', card, appId);
    expect(axiosRef.patch).toHaveBeenCalledWith(expect.stringContaining('/im/v1/messages/om_flow_1'), { content: JSON.stringify(card) }, expect.any(Object));
    expect(observedCardPatch).not.toHaveBeenCalled();
    await expect(gateway.updateLifecycleCard('invalid', card, appId)).rejects.toThrow();
    expect(axiosRef.patch).toHaveBeenCalledTimes(1);
  });

  it('does not resend when message readback times out after a successful send', async () => {
    const { gateway, axiosRef } = setup();
    axiosRef.get.mockRejectedValue(new Error('readback timeout'));
    await expect(gateway.sendLifecycleCard('ou_recipient', card, uuid, appId)).rejects.toThrow();
    expect(axiosRef.post).toHaveBeenCalledTimes(1);
    expect(axiosRef.get).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid recipient, uuid and non-updatable cards before sending', async () => {
    const { gateway, axiosRef } = setup();
    await expect(gateway.sendLifecycleCard('invalid', card, uuid, appId)).rejects.toThrow();
    await expect(gateway.sendLifecycleCard('ou_recipient', card, '', appId)).rejects.toThrow();
    await expect(gateway.sendLifecycleCard('ou_recipient', card, undefined as never, appId)).rejects.toThrow();
    await expect(gateway.sendLifecycleCard('ou_recipient', card, uuid, 'cli_other')).rejects.toThrow();
    await expect(gateway.sendLifecycleCard('ou_recipient', { schema: '2.0', config: { update_multi: false } }, uuid, appId)).rejects.toThrow();
    expect(axiosRef.post).not.toHaveBeenCalled();
  });
});
