import type { HttpService } from '@nestjs/axios';
import {
  LeaveWorkflowGateway,
  stableLeaveMessageUuid,
} from './leave-workflow.gateway';

describe('LeaveWorkflowGateway', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.FEISHU_APP_ID = 'cli_leave_app';
    process.env.FEISHU_APP_SECRET = 'leave-app-secret';
    process.env.FEISHU_LEAVE_REQUEST_APP_TOKEN = 'leave_app_token';
    process.env.FEISHU_LEAVE_REQUEST_TABLE_ID = 'tblf1bbd02a2b049';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses a stable valid UUID for idempotent leave-card delivery', () => {
    expect(stableLeaveMessageUuid('leave:rec_1:supervisor:ou_1')).toBe(
      stableLeaveMessageUuid('leave:rec_1:supervisor:ou_1'),
    );
    expect(stableLeaveMessageUuid('leave:rec_1:supervisor:ou_1')).toMatch(
      /^[A-Za-z0-9_-]{1,50}$/u,
    );
  });

  it('sends cards and reads or updates the leave Base record with finite timeouts', async () => {
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { message_id: 'om_leave_card_1' } },
      });
    const patch = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const get = jest.fn().mockResolvedValue({
      data: {
        code: 0,
        data: {
          record: { record_id: 'rec_leave_1', fields: { 标题: '测试' } },
        },
      },
    });
    const put = jest.fn().mockResolvedValue({ data: { code: 0 } });
    const gateway = new LeaveWorkflowGateway(
      { axiosRef: { post, patch, get, put } } as unknown as HttpService,
      jest.fn(),
    );

    await expect(
      gateway.sendInteractiveCard(
        'ou_leave_approver',
        { schema: '2.0' },
        'leave:rec_leave_1:supervisor:ou_leave_approver',
      ),
    ).resolves.toBe('om_leave_card_1');
    await gateway.patchInteractiveCard('om_leave_card_1', { schema: '2.0' });
    await expect(gateway.readLeaveRecord('rec_leave_1')).resolves.toEqual({
      recordId: 'rec_leave_1',
      fields: { 标题: '测试' },
    });
    await gateway.updateLeaveRecord('rec_leave_1', {
      请假工作流状态: '待示例人员001审批',
    });

    expect(post.mock.calls[1][1].uuid).toBe(
      stableLeaveMessageUuid('leave:rec_leave_1:supervisor:ou_leave_approver'),
    );
    expect(post.mock.calls[1][2]).toEqual(
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(patch.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(get.mock.calls[0][1]).toEqual(
      expect.objectContaining({ timeout: 15_000 }),
    );
    expect(put.mock.calls[0][2]).toEqual(
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it('preserves the Feishu response code and safe message when card delivery is rejected', async () => {
    const deliveryError = Object.assign(
      new Error('Request failed with status code 400'),
      {
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            code: 230099,
            msg: 'Failed to create card content: unknown property min_length',
          },
        },
      },
    );
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      })
      .mockRejectedValueOnce(deliveryError);
    const gateway = new LeaveWorkflowGateway(
      { axiosRef: { post } } as unknown as HttpService,
      jest.fn(),
    );

    await expect(
      gateway.sendInteractiveCard(
        'ou_leave_approver',
        { schema: '2.0' },
        'leave:rec_leave_1:supervisor:ou_leave_approver',
      ),
    ).rejects.toThrow(/230099.*min_length/u);
  });

  it('preserves the Feishu error code and cause when a card view PATCH is rejected', async () => {
    const error = Object.assign(new Error('Request failed with status code 400'), {
      isAxiosError: true,
      response: { status: 400, data: { code: 230099, msg: 'Invalid form button: form_action_type is required' } },
    });
    const gateway = new LeaveWorkflowGateway({ axiosRef: {
      post: jest.fn().mockResolvedValue({ data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 } }),
      patch: jest.fn().mockRejectedValue(error),
    } } as unknown as HttpService, jest.fn());

    await expect(gateway.patchInteractiveCard('om_leave_card_1', { schema: '2.0' }))
      .rejects.toThrow(/HTTP 400.*230099.*form_action_type/u);
  });

  it('does not hide a card PATCH transport failure', async () => {
    const error = new Error('socket closed');
    const gateway = new LeaveWorkflowGateway({ axiosRef: {
      post: jest.fn().mockResolvedValue({ data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 } }),
      patch: jest.fn().mockRejectedValue(error),
    } } as unknown as HttpService, jest.fn());

    await expect(gateway.patchInteractiveCard('om_leave_card_1', { schema: '2.0' })).rejects.toBe(error);
  });

  it('downloads the Base screenshot attachment and uploads it once as a Feishu message image', async () => {
    const imageBytes = Buffer.from('leave-screenshot');
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'tenant-token', expire: 7200 },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { image_key: 'img_v3_leave_evidence_1' } },
      });
    const get = jest
      .fn()
      .mockResolvedValueOnce({
        data: {
          code: 0,
          data: {
            tmp_download_urls: [
              {
                file_token: 'boxcn_leave_screenshot',
                tmp_download_url: 'https://internal.example/leave.png',
              },
            ],
          },
        },
      })
      .mockResolvedValueOnce({
        data: imageBytes,
        headers: { 'content-type': 'image/png' },
      });
    const gateway = new LeaveWorkflowGateway(
      { axiosRef: { post, get } } as unknown as HttpService,
      jest.fn(),
    );

    await expect(
      gateway.prepareLeaveApprovalScreenshotImages({
        流程截图: [
          {
            file_token: 'boxcn_leave_screenshot',
            name: '流程截图.png',
            type: 'image/png',
            tmp_url:
              'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=boxcn_leave_screenshot&extra=bitable-permission',
          },
        ],
      }),
    ).resolves.toEqual(['img_v3_leave_evidence_1']);

    expect(get.mock.calls[0][0]).toBe(
      'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=boxcn_leave_screenshot&extra=bitable-permission',
    );
    expect(get.mock.calls[1]).toEqual([
      'https://internal.example/leave.png',
      expect.objectContaining({ responseType: 'arraybuffer', timeout: 15_000 }),
    ]);
    expect(post.mock.calls[1][0]).toBe(
      'https://open.feishu.cn/open-apis/im/v1/images',
    );
    expect(post.mock.calls[1][2]).toEqual(
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it('finds exact leave records by leave code without using a stale cache', async () => {
    const reader = jest.fn().mockImplementation(async (_http, options) => {
      const code = options.filter.conditions[0].value[0];
      return [
        {
          record_id: code.includes('920') ? 'rec_leave_920' : 'rec_leave_921',
          fields: { 休假编号: code },
        },
      ];
    });
    const gateway = new LeaveWorkflowGateway(
      { axiosRef: {} } as unknown as HttpService,
      reader,
    );

    await expect(
      gateway.findLeaveRecordsByCodes(['XJ-920-刘小杏', 'XJ-921-刘小杏']),
    ).resolves.toEqual([
      expect.objectContaining({ recordId: 'rec_leave_920' }),
      expect.objectContaining({ recordId: 'rec_leave_921' }),
    ]);
    expect(reader).toHaveBeenCalledTimes(2);
    for (const call of reader.mock.calls) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          tableId: 'tblf1bbd02a2b049',
          fieldNames: expect.arrayContaining([
            '休假编号',
            '请求唯一ID',
            '请假工作流状态',
            '休假人员姓名（程序）',
            '请假驳回原因',
          ]),
          cacheTtlMs: 0,
          forceRefresh: true,
          strict: true,
        }),
      );
    }
  });
});
