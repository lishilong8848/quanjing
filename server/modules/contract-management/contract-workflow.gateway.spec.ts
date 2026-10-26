jest.mock('../../common/config/external-services.config', () => ({
  getFeishuAuthPayload: () => ({ app_id: 'app-id', app_secret: 'app-secret' }),
  parseFeishuBitableLink: () => ({ appToken: 'app-contract', wikiToken: '' }),
  readEnv: () => '',
}));

jest.mock('../../common/feishu/bitable-direct-read', () => ({
  fetchBitableRecords: jest.fn(),
  resolveBitableAppToken: jest.fn(),
}));

import { ContractWorkflowGateway } from './contract-workflow.gateway';

describe('ContractWorkflowGateway', () => {
  it('将同一持久UUID写入实际HTTP消息体，网络重试不更换UUID',async()=>{
    const uuid='df180d4a-14cc-43ce-a7d5-219177bc9b73',axiosRef={post:jest.fn().mockResolvedValueOnce({data:{code:0,tenant_access_token:'synthetic-token',expire:7200}}).mockRejectedValueOnce(Object.assign(new Error('timeout'),{code:'ETIMEDOUT'})).mockResolvedValueOnce({data:{code:0,data:{message_id:'om_synthetic'}}})};
    const gateway=new ContractWorkflowGateway({axiosRef} as never);
    await expect(gateway.sendInteractiveCard('ou_receiver',{header:{title:{content:'合成卡片'}}},uuid)).resolves.toBe('om_synthetic');
    for(const call of axiosRef.post.mock.calls.slice(1))expect(call[1]).toMatchObject({uuid,receive_id:'ou_receiver',msg_type:'interactive'});
  });
  it('retries a transient network error before sending an interactive card', async () => {
    const timeout = Object.assign(new Error('connect ETIMEDOUT'), {
      code: 'ETIMEDOUT',
    });
    const axiosRef = {
      post: jest
        .fn()
        .mockResolvedValueOnce({
          data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
        })
        .mockRejectedValueOnce(timeout)
        .mockResolvedValueOnce({
          data: { code: 0, data: { message_id: 'om-card' } },
        }),
    };
    const gateway = new ContractWorkflowGateway({ axiosRef } as never);

    await expect(
      gateway.sendInteractiveCard('ou_receiver', {
        header: { title: { tag: 'plain_text', content: '合同测试卡片' } },
      }),
    ).resolves.toBe('om-card');

    expect(axiosRef.post).toHaveBeenCalledTimes(3);
    expect(axiosRef.post).toHaveBeenLastCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id',
      expect.objectContaining({ msg_type: 'interactive' }),
      expect.objectContaining({
        headers: { Authorization: 'Bearer tenant-token' },
      }),
    );
  });
});
