import { createHash } from 'node:crypto';
import type { AliMonthlyReportGenerateResponse } from '../../shared/api.interface';
import { AliMonthlyReportService } from '../../server/modules/ali-monthly-report/ali-monthly-report.service';
import type { AliMonthlyReportAutomationSummary } from '../../server/modules/ali-monthly-report/ali-monthly-report-task-state';

type RuntimeConfigForTest = {
  configPath: string;
  downloadFolder: string;
  outputDir: string;
  outputDirLabel: string;
  feishuChatId: string;
  feishuChatIds: string[];
  automationFeishuChatId: string;
  defaultEmailRecipient: string;
  publicBaseUrl: string;
  downloadSigningRoot: string;
  values: Record<string, string>;
};

type ServiceInternals = {
  getRuntimeConfig: () => RuntimeConfigForTest;
  attachFeishuNotification: (
    runtime: RuntimeConfigForTest,
    response: AliMonthlyReportGenerateResponse,
  ) => Promise<AliMonthlyReportGenerateResponse>;
};

const primaryChatId = 'oc_9961bb057de8bd715447559c5e63c4f2';
const additionalChatId = 'oc_3bc648b9b761f24a65366a9b04b32eb2';
const recordUrl =
  'https://vnet.feishu.cn/base/MliKbC3fXa8PXrsndKscmxjdn1g?table=tblAGQeQ7tpV8tWt&view=vewrHJHl3v&recordId=recvrcnAMSKGO9';

const runtime: RuntimeConfigForTest = {
  configPath: '',
  downloadFolder: 'D:\\temp\\ali-monthly-report',
  outputDir: 'D:\\temp\\ali-monthly-report',
  outputDirLabel: 'output/ali-monthly-report',
  feishuChatId: primaryChatId,
  feishuChatIds: [primaryChatId, additionalChatId],
  automationFeishuChatId: additionalChatId,
  defaultEmailRecipient: '',
  publicBaseUrl: '',
  downloadSigningRoot: '',
  values: {
    FEISHU_APP_ID: 'test-app-id',
    FEISHU_APP_SECRET: 'test-app-secret',
  },
};

const generatedResponse: AliMonthlyReportGenerateResponse = {
  success: true,
  reportType: 'alarm_analysis',
  year: 2026,
  month: 7,
  message: '月度告警分析已生成并上传',
  files: [
    {
      id: 'alarm-file',
      name: 'EA118机房2026年7月告警分析表.xlsx',
      size: '886.3KB',
      downloadUrl: '/api/ali-monthly-report/files/alarm-file',
    },
  ],
  logs: ['生成完成'],
  bitableRecordUrls: [recordUrl],
};

function createService(messageResults: Array<'success' | 'failure'>) {
  let messageIndex = 0;
  const fakePost = jest.fn(
    async (url: string, payload?: Record<string, unknown>) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return {
          data: {
            code: 0,
            msg: 'success',
            tenant_access_token: 'test-tenant-token',
            expire: 7200,
          },
        };
      }
      const result = messageResults[messageIndex++];
      if (result === 'failure') throw new Error('message failed');
      return {
        data: {
          code: 0,
          msg: 'success',
          data: {
            message_id: `om_${String(payload?.receive_id || messageIndex)}`,
          },
        },
      };
    },
  );
  const service = new AliMonthlyReportService({
    axiosRef: { post: fakePost },
  } as never);
  return {
    service,
    fakePost,
    internals: service as unknown as ServiceInternals,
  };
}

describe('阿里月报双群互动卡片通知', () => {
  it('从复数环境变量解析、清理并去重通知群', () => {
    const previousChatIds = process.env.ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS;
    const previousStaffTableId = process.env.STAFF_REPORT_TABLE_ID;
    const previousStaffViewId = process.env.STAFF_REPORT_VIEW_ID;
    process.env.ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS = ` ${primaryChatId},${additionalChatId};${primaryChatId} `;
    process.env.STAFF_REPORT_TABLE_ID = 'tbl_staff_override';
    process.env.STAFF_REPORT_VIEW_ID = 'vew_staff_override';
    const { internals } = createService([]);

    try {
      const resolved = internals.getRuntimeConfig();
      expect(resolved.feishuChatIds).toEqual([primaryChatId, additionalChatId]);
      expect(resolved.feishuChatId).toBe(primaryChatId);
      expect(resolved.automationFeishuChatId).toBe(additionalChatId);
      expect(resolved.values.STAFF_REPORT_TABLE_ID).toBe('tbl_staff_override');
      expect(resolved.values.STAFF_REPORT_VIEW_ID).toBe('vew_staff_override');
    } finally {
      if (previousChatIds === undefined) {
        delete process.env.ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS;
      } else {
        process.env.ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS = previousChatIds;
      }
      if (previousStaffTableId === undefined) {
        delete process.env.STAFF_REPORT_TABLE_ID;
      } else {
        process.env.STAFF_REPORT_TABLE_ID = previousStaffTableId;
      }
      if (previousStaffViewId === undefined) {
        delete process.env.STAFF_REPORT_VIEW_ID;
      } else {
        process.env.STAFF_REPORT_VIEW_ID = previousStaffViewId;
      }
    }
  });

  it('显式群配置包含无效 chat_id 时直接失败而不是静默丢弃或回退默认群', () => {
    const previousChatIds = process.env.ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS;
    process.env.ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS = `${primaryChatId},not-a-chat-id`;
    const { internals } = createService([]);

    try {
      expect(() => internals.getRuntimeConfig()).toThrow(/chat_id.*无效/);
    } finally {
      if (previousChatIds === undefined) {
        delete process.env.ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS;
      } else {
        process.env.ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS = previousChatIds;
      }
    }
  });

  it('一次取 token 后并行向两个群发送可点击的互动卡片', async () => {
    const { fakePost, internals } = createService(['success', 'success']);

    const response = await internals.attachFeishuNotification(
      runtime,
      generatedResponse,
    );

    expect(fakePost).toHaveBeenCalledTimes(3);
    const messageCalls = fakePost.mock.calls.slice(1);
    expect(messageCalls.map((call) => call[1]?.receive_id)).toEqual(
      expect.arrayContaining([primaryChatId, additionalChatId]),
    );
    for (const call of messageCalls) {
      expect(call[1]).toMatchObject({ msg_type: 'interactive' });
      const card = JSON.parse(String(call[1]?.content)) as Record<
        string,
        unknown
      >;
      expect(JSON.stringify(card)).toContain('打开多维表记录');
      expect(JSON.stringify(card)).toContain(recordUrl);
    }
    expect(response.feishuMessage).toMatchObject({
      sent: true,
      chatIds: [primaryChatId, additionalChatId],
      deliveries: [
        { chatId: primaryChatId, sent: true },
        { chatId: additionalChatId, sent: true },
      ],
    });
  });

  it('一个群发送失败时保留另一个群的成功结果并返回部分失败', async () => {
    const { internals } = createService(['success', 'failure']);

    const response = await internals.attachFeishuNotification(
      runtime,
      generatedResponse,
    );

    expect(response.feishuMessage).toMatchObject({
      sent: false,
      chatIds: [primaryChatId, additionalChatId],
      deliveries: [
        { chatId: primaryChatId, sent: true },
        {
          chatId: additionalChatId,
          sent: false,
          error: expect.stringContaining('message failed'),
        },
      ],
    });
  });

  it('自动任务只向自动化群发送一张三项汇总卡片', async () => {
    const { service, fakePost, internals } = createService([
      'success',
      'success',
    ]);
    jest.spyOn(internals, 'getRuntimeConfig').mockReturnValue(runtime);
    const summary: AliMonthlyReportAutomationSummary = {
      taskId: 'AMR-202607-20260803090000',
      year: 2026,
      month: 7,
      startedAt: '2026-08-03T01:00:00.000Z',
      finishedAt: '2026-08-03T01:06:42.000Z',
      status: 'success',
      succeeded: 3,
      failed: 0,
      notificationFingerprint:
        '[["alarm_analysis","succeeded"],["over_power","succeeded"],["staff_roster","succeeded"]]',
      tasks: [
        {
          reportType: 'alarm_analysis',
          status: 'succeeded',
          attempts: 1,
          fileName: '告警分析.xlsx',
          recordUrl,
        },
        {
          reportType: 'over_power',
          status: 'succeeded',
          attempts: 1,
          fileName: '超功率.xlsx',
          recordUrl: recordUrl.replace('tblAGQeQ7tpV8tWt', 'tblkh6YCMYtS8nHa'),
        },
        {
          reportType: 'staff_roster',
          status: 'succeeded',
          attempts: 1,
          fileName: '人员变动.xlsx',
          recordUrl: recordUrl.replace('tblAGQeQ7tpV8tWt', 'tbl3KED5CdvNSCwT'),
        },
      ],
    };

    const automationService = service as unknown as {
      sendAutomationSummary: (
        value: AliMonthlyReportAutomationSummary,
      ) => Promise<string>;
    };
    const messageId = await automationService.sendAutomationSummary(summary);
    await automationService.sendAutomationSummary(summary);

    expect(messageId).toBe(`om_${additionalChatId}`);
    expect(fakePost).toHaveBeenCalledTimes(4);
    const expectedUuid = `amr-${createHash('sha256')
      .update(
        JSON.stringify([
          summary.year,
          summary.month,
          summary.notificationFingerprint,
          additionalChatId,
        ]),
      )
      .digest('hex')
      .slice(0, 46)}`;
    expect(fakePost.mock.calls[1][1]).toMatchObject({
      receive_id: additionalChatId,
      msg_type: 'interactive',
      uuid: expectedUuid,
    });
    expect(fakePost.mock.calls[3][1]).toMatchObject({ uuid: expectedUuid });
    expect(expectedUuid).toHaveLength(50);
    const card = JSON.parse(String(fakePost.mock.calls[1][1]?.content)) as {
      header?: { title?: { content?: string } };
    };
    expect(card.header?.title?.content).toBe('阿里月报自动任务｜全部成功');
  });
});
