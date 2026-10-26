import type { HttpService } from '@nestjs/axios';
import {
  DailyOperationsPatrolGateway,
  stableDailyOperationsPatrolMessageUuid,
} from './daily-operations-patrol.gateway';

describe('DailyOperationsPatrolGateway', () => {
  const previousEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...previousEnv };
    jest.restoreAllMocks();
  });

  it('builds a stable UUID from business date, chat and policy version', () => {
    const first = stableDailyOperationsPatrolMessageUuid(
      '2026-09-07',
      'oc_test_group',
    );
    const second = stableDailyOperationsPatrolMessageUuid(
      '2026-09-07',
      'oc_test_group',
    );

    expect(first).toBe(second);
    expect(first).toMatch(/^dop_[a-f0-9]{40}$/u);
    expect(
      stableDailyOperationsPatrolMessageUuid('2026-09-08', 'oc_test_group'),
    ).not.toBe(first);
    expect(
      stableDailyOperationsPatrolMessageUuid(
        '2026-09-07',
        'oc_test_group',
        'unified-full-v4',
      ),
    ).not.toBe(first);
  });

  it('sends exactly one interactive card by chat_id', async () => {
    process.env.FEISHU_APP_ID = 'cli_test_app';
    process.env.FEISHU_APP_SECRET = 'test_secret';
    process.env.NANTONG_DAILY_PATROL_CHAT_ID = 'oc_test_group';
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'tenant-test', expire: 7200 },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { message_id: 'om_test_message' } },
      });
    const gateway = new DailyOperationsPatrolGateway({
      axiosRef: { post },
    } as unknown as HttpService);

    const messageId = await gateway.sendCard(
      {
        schema: '2.0',
        header: { title: { tag: 'plain_text', content: '测试卡片' } },
      },
      '2026-09-07',
    );

    expect(messageId).toBe('om_test_message');
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1][0]).toContain('receive_id_type=chat_id');
    expect(post.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        receive_id: 'oc_test_group',
        msg_type: 'interactive',
        uuid: stableDailyOperationsPatrolMessageUuid(
          '2026-09-07',
          'oc_test_group',
        ),
      }),
    );
    expect(post.mock.calls[1][1]).not.toHaveProperty('open_id');
  });

  it('updates an existing daily card by message id', async () => {
    process.env.FEISHU_APP_ID = 'cli_test_app';
    process.env.FEISHU_APP_SECRET = 'test_secret';
    const post = jest.fn().mockResolvedValueOnce({
      data: { code: 0, tenant_access_token: 'tenant-test', expire: 7200 },
    });
    const patch = jest.fn().mockResolvedValueOnce({ data: { code: 0 } });
    const gateway = new DailyOperationsPatrolGateway({
      axiosRef: { post, patch },
    } as unknown as HttpService);
    const card = {
      schema: '2.0',
      header: { title: { tag: 'plain_text', content: '已恢复' } },
    };

    await gateway.updateCard('om_test_message', card);

    expect(patch).toHaveBeenCalledWith(
      'https://open.feishu.cn/open-apis/im/v1/messages/om_test_message',
      { content: JSON.stringify(card) },
      expect.objectContaining({ timeout: 15_000 }),
    );
  });

  it('uses the versioned delivery identity in the complete-card UUID', async () => {
    process.env.FEISHU_APP_ID = 'cli_test_app';
    process.env.FEISHU_APP_SECRET = 'test_secret';
    process.env.NANTONG_DAILY_PATROL_CHAT_ID = 'oc_test_group';
    const post = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'tenant-test', expire: 7200 },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { message_id: 'om_complete_message' } },
      });
    const gateway = new DailyOperationsPatrolGateway({
      axiosRef: { post },
    } as unknown as HttpService);

    await gateway.sendCard({ schema: '2.0' }, '2026-09-11', 'unified-full-v4');

    expect(post.mock.calls[1][1].uuid).toBe(
      stableDailyOperationsPatrolMessageUuid(
        '2026-09-11',
        'oc_test_group',
        'unified-full-v4',
      ),
    );
  });
});
