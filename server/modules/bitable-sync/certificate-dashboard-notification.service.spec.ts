import { ServiceUnavailableException } from '@nestjs/common';
import type {
  CampusCertificateDashboardResponse,
  CampusCertificateExpiryNotificationRequest,
} from '../../../shared/api.interface';
import {
  CertificateDashboardNotificationService,
  matchCertificateReminderRecipients,
} from './certificate-dashboard-notification.service';

const originalEnv = {
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  chatId: process.env.FEISHU_CERTIFICATE_REMINDER_CHAT_ID,
};

const dashboard: CampusCertificateDashboardResponse = {
  summary: {
    totalPeople: 3,
    compliantPeople: 3,
    nonCompliantPeople: 0,
    notApplicablePeople: 0,
    currentQualified: 90,
    targetQualified: 90,
    complianceRate: 100,
    totalCertificates: 3,
    averageComplianceRate: 100,
  },
  certificateMetrics: [
    { id: 'expiring', label: '证件90天内到期', value: 2, tone: 'orange' },
  ],
  buildingCompliance: [],
  nonCompliantPeople: [],
  people: [
    {
      id: 'person-a',
      name: '张 三',
      building: 'A楼',
      position: '值班员',
      team: 'A班',
      complianceStatus: '合规',
      missingCertificate: '',
      highVoltageValid: true,
      lowVoltageValid: true,
      heightWorkValid: false,
      highVoltageExpiryDate: '2026-08-05',
      lowVoltageExpiryDate: '2027-01-10',
      heightWorkExpiryDate: null,
      expiryReminder: '高压证将在18天后到期',
    },
    {
      id: 'person-b',
      name: '李四',
      building: 'B楼',
      position: '值班员',
      team: 'B班',
      complianceStatus: '合规',
      missingCertificate: '',
      highVoltageValid: true,
      lowVoltageValid: false,
      heightWorkValid: true,
      highVoltageExpiryDate: '2026-08-20',
      lowVoltageExpiryDate: null,
      heightWorkExpiryDate: '2026-09-01',
      expiryReminder: '两本证件临期',
    },
    {
      id: 'person-c',
      name: '王五',
      building: 'C楼',
      position: '值班员',
      team: 'C班',
      complianceStatus: '合规',
      missingCertificate: '',
      highVoltageValid: true,
      lowVoltageValid: false,
      heightWorkValid: false,
      highVoltageExpiryDate: '2028-01-01',
      lowVoltageExpiryDate: null,
      heightWorkExpiryDate: null,
      expiryReminder: '',
    },
  ],
  expiryEvents: [
    {
      id: 'event-a',
      personId: 'person-a',
      personName: '张 三',
      building: 'A楼',
      category: 'high-voltage',
      certificateName: '高压电工证',
      date: '2026-08-05',
    },
    {
      id: 'event-b1',
      personId: 'person-b',
      personName: '李四',
      building: 'B楼',
      category: 'high-voltage',
      certificateName: '高压电工证',
      date: '2026-08-20',
    },
    {
      id: 'event-b2',
      personId: 'person-b',
      personName: '李四',
      building: 'B楼',
      category: 'height-work',
      certificateName: '高处作业证',
      date: '2026-09-01',
    },
  ],
  sourceUpdatedAt: '2026-07-18T02:00:37.000Z',
  syncedAt: '2026-07-18T02:01:00.000Z',
  sourceStatus: 'fresh',
};

function createHttpMock(options?: {
  groupPages?: Array<Record<string, unknown>>;
  messageFailureName?: string;
  missingMessageIdName?: string;
}) {
  const groupPages = options?.groupPages ?? [
    {
      code: 0,
      data: {
        items: [
          {
            member_id: 'ou_zhang',
            member_id_type: 'open_id',
            name: '张三',
          },
          {
            member_id: 'ou_li',
            member_id_type: 'open_id',
            name: '李四',
          },
          {
            member_id: 'ou_ma',
            member_id_type: 'open_id',
            name: '马进宇',
          },
        ],
        has_more: false,
        page_token: '',
        trigger_security_conf_limit: false,
      },
    },
  ];
  let groupPageIndex = 0;
  const get = jest.fn(async () => ({
    data: groupPages[Math.min(groupPageIndex++, groupPages.length - 1)],
  }));
  const post = jest.fn(async (url: string, body: Record<string, unknown>) => {
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return {
        data: {
          code: 0,
          tenant_access_token: 'tenant-test-token',
          expire: 7200,
        },
      };
    }
    const content = JSON.parse(String(body.content || '{}')) as {
      text?: string;
    };
    if (
      options?.messageFailureName &&
      content.text?.includes(options.messageFailureName)
    ) {
      return { data: { code: 230035, msg: 'Send Message Permission deny' } };
    }
    if (
      options?.missingMessageIdName &&
      content.text?.includes(options.missingMessageIdName)
    ) {
      return { data: { code: 0, data: {} } };
    }
    return {
      data: {
        code: 0,
        data: { message_id: `om_${String(body.receive_id).slice(-4)}` },
      },
    };
  });

  return {
    httpService: { axiosRef: { get, post } } as never,
    get,
    post,
  };
}

function createService(options?: Parameters<typeof createHttpMock>[0]) {
  const http = createHttpMock(options);
  const dashboardService = {
    getDashboard: jest.fn().mockResolvedValue(dashboard),
  };
  return {
    service: new CertificateDashboardNotificationService(
      http.httpService,
      dashboardService as never,
    ),
    dashboardService,
    ...http,
  };
}

describe('CertificateDashboardNotificationService', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-18T04:00:00.000Z'));
    process.env.FEISHU_APP_ID = 'cli_test_app';
    process.env.FEISHU_APP_SECRET = 'test-secret';
    process.env.FEISHU_CERTIFICATE_REMINDER_CHAT_ID =
      'oc_8402dd5799db4fba085334749bfbb635';
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalEnv.appId === undefined) delete process.env.FEISHU_APP_ID;
    else process.env.FEISHU_APP_ID = originalEnv.appId;
    if (originalEnv.appSecret === undefined)
      delete process.env.FEISHU_APP_SECRET;
    else process.env.FEISHU_APP_SECRET = originalEnv.appSecret;
    if (originalEnv.chatId === undefined)
      delete process.env.FEISHU_CERTIFICATE_REMINDER_CHAT_ID;
    else process.env.FEISHU_CERTIFICATE_REMINDER_CHAT_ID = originalEnv.chatId;
  });

  it('normalizes names, rejects ambiguous matches and never exposes open ids', () => {
    const result = matchCertificateReminderRecipients(
      dashboard.people.filter((person) => person.expiryReminder),
      [
        { openId: 'ou_zhang', name: '张三' },
        { openId: 'ou_li_1', name: ' 李 四 ' },
        { openId: 'ou_li_2', name: '李四' },
      ],
      dashboard.expiryEvents,
    );

    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]).toMatchObject({
      person: { id: 'person-a', name: '张 三' },
      certificates: [
        {
          certificateName: '高压电工证',
          expiryDate: '2026-08-05',
        },
      ],
    });
    expect(result.unmatchedNames).toEqual([]);
    expect(result.ambiguousNames).toEqual(['李四']);
    expect(JSON.stringify(result.publicPeople)).not.toContain('ou_');
  });

  it('previews all recipients without sending a message', async () => {
    const { service, get, post } = createService();

    const preview = await service.previewExpiryNotifications();

    expect(preview).toMatchObject({
      totalPeople: 2,
      matchedCount: 2,
      unmatchedNames: [],
      ambiguousNames: [],
      blocked: false,
      sourceUpdatedAt: dashboard.sourceUpdatedAt,
    });
    expect(preview.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(preview.people).toHaveLength(2);
    expect(JSON.stringify(preview)).not.toContain('ou_');
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining('/members/list'),
      expect.objectContaining({
        params: expect.objectContaining({
          member_id_type: 'open_id',
          member_types: 'user',
          page_size: 100,
        }),
      }),
    );
    expect(
      post.mock.calls.filter(([url]) =>
        String(url).includes('/im/v1/messages'),
      ),
    ).toHaveLength(0);
  });

  it('uses the requested reminder group as the runtime default', async () => {
    delete process.env.FEISHU_CERTIFICATE_REMINDER_CHAT_ID;
    const { service, get } = createService();

    await service.previewExpiryNotifications();

    expect(get).toHaveBeenCalledWith(
      expect.stringContaining(
        '/chats/oc_8402dd5799db4fba085334749bfbb635/members/list',
      ),
      expect.anything(),
    );
  });

  it('walks every member page and refuses a security-truncated directory', async () => {
    const firstPage = {
      code: 0,
      data: {
        items: [
          { member_id: 'ou_zhang', member_id_type: 'open_id', name: '张三' },
        ],
        has_more: true,
        page_token: 'next-page',
        trigger_security_conf_limit: false,
      },
    };
    const secondPage = {
      code: 0,
      data: {
        items: [
          { member_id: 'ou_li', member_id_type: 'open_id', name: '李四' },
        ],
        has_more: false,
        page_token: '',
        trigger_security_conf_limit: false,
      },
    };
    const paged = createService({ groupPages: [firstPage, secondPage] });

    const preview = await paged.service.previewExpiryNotifications();

    expect(preview.matchedCount).toBe(2);
    expect(paged.get).toHaveBeenCalledTimes(2);
    expect(paged.get.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        params: expect.objectContaining({ page_token: 'next-page' }),
      }),
    );

    const truncated = createService({
      groupPages: [
        {
          code: 0,
          data: {
            items: [],
            has_more: false,
            trigger_security_conf_limit: true,
          },
        },
      ],
    });
    await expect(
      truncated.service.previewExpiryNotifications(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('parses the current Feishu group member users response shape', async () => {
    const currentShape = createService({
      groupPages: [
        {
          code: 0,
          data: {
            users: [
              { member_id: 'ou_zhang', name: '张三' },
              { member_id: 'ou_li', name: '李四' },
              { member_id: 'ou_ma', name: '马进宇' },
            ],
            user_total: 3,
            bots: [],
            bot_total: 0,
            truncations: [],
            has_more: false,
            page_token: '',
          },
        },
      ],
    });

    await expect(
      currentShape.service.previewExpiryNotifications(),
    ).resolves.toMatchObject({
      totalPeople: 2,
      matchedCount: 2,
      unmatchedNames: [],
      ambiguousNames: [],
    });
  });

  it('refuses a truncated current-shape member directory', async () => {
    const truncated = createService({
      groupPages: [
        {
          code: 0,
          data: {
            users: [{ member_id: 'ou_zhang', name: '张三' }],
            user_total: 2,
            truncations: [{ member_id: 'ou_hidden' }],
            has_more: false,
            page_token: '',
          },
        },
      ],
    });

    await expect(
      truncated.service.previewExpiryNotifications(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('refuses a silently empty member directory with a positive user total', async () => {
    const silentlyEmpty = createService({
      groupPages: [
        {
          code: 0,
          data: {
            users: [],
            user_total: 79,
            truncations: [],
            has_more: false,
            page_token: '',
          },
        },
      ],
    });

    await expect(
      silentlyEmpty.service.previewExpiryNotifications(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('sends one combined direct message per matched person and reuses a batch result', async () => {
    const { service, post } = createService();
    const preview = await service.previewExpiryNotifications();
    const request: CampusCertificateExpiryNotificationRequest = {
      requestId: preview.requestId,
    };

    const first = await service.sendExpiryNotifications(request);
    const second = await service.sendExpiryNotifications(request);
    const messageCalls = post.mock.calls.filter(([url]) =>
      String(url).includes('/im/v1/messages'),
    );

    expect(first).toMatchObject({
      success: true,
      attemptedCount: 2,
      sentCount: 2,
      failedCount: 0,
      unmatchedNames: [],
      ambiguousNames: [],
    });
    expect(second).toEqual(first);
    expect(messageCalls).toHaveLength(2);
    for (const [, body, config] of messageCalls) {
      expect(body).toEqual(
        expect.objectContaining({
          receive_id: expect.stringMatching(/^ou_/),
          msg_type: 'text',
          content: expect.any(String),
          uuid: expect.stringMatching(/^[0-9a-f]{32}$/),
        }),
      );
      expect(String(body.uuid)).toHaveLength(32);
      expect(config).toEqual(
        expect.objectContaining({
          params: { receive_id_type: 'open_id' },
        }),
      );
      expect(JSON.parse(String(body.content))).toEqual({
        text: expect.stringContaining('证件到期提醒'),
      });
    }
    expect(
      messageCalls
        .map(([, body]) => JSON.parse(String(body.content)).text)
        .join('\n'),
    ).toContain('剩余18天');
    expect(JSON.stringify(first)).not.toContain('ou_');
    expect(JSON.stringify(first)).not.toContain('om_');
  });

  it('continues after a per-person send failure and reports a partial result', async () => {
    const { service } = createService({ messageFailureName: '李四' });
    const preview = await service.previewExpiryNotifications();

    const result = await service.sendExpiryNotifications({
      requestId: preview.requestId,
    });

    expect(result).toMatchObject({
      success: false,
      attemptedCount: 2,
      sentCount: 1,
      failedCount: 1,
    });
    expect(result.failures).toEqual([
      expect.objectContaining({ name: '李四' }),
    ]);
    expect(JSON.stringify(result)).not.toContain('tenant-test-token');
  });

  it('does not report success when Feishu omits the message id', async () => {
    const { service } = createService({ missingMessageIdName: '李四' });
    const preview = await service.previewExpiryNotifications();

    const result = await service.sendExpiryNotifications({
      requestId: preview.requestId,
    });

    expect(result).toMatchObject({
      success: false,
      attemptedCount: 2,
      sentCount: 1,
      failedCount: 1,
    });
    expect(result.failures).toEqual([
      expect.objectContaining({ name: '李四' }),
    ]);
  });

  it('blocks stale source data before reading the directory or sending', async () => {
    const { httpService, get, post } = createHttpMock();
    const service = new CertificateDashboardNotificationService(httpService, {
      getDashboard: jest.fn().mockResolvedValue({
        ...dashboard,
        sourceStatus: 'stale',
      }),
    } as never);

    const preview = await service.previewExpiryNotifications();

    expect(preview).toMatchObject({
      blocked: true,
      matchedCount: 0,
    });
    await expect(
      service.sendExpiryNotifications({ requestId: preview.requestId }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('can send the explicit success self-test to one uniquely matched person', async () => {
    const { service, post } = createService();

    const result = await service.sendSelfTestSuccess(
      '马进宇',
      'certificate-self-test-20260718',
    );
    const messageCalls = post.mock.calls.filter(([url]) =>
      String(url).includes('/im/v1/messages'),
    );

    expect(result).toMatchObject({
      success: true,
      name: '马进宇',
    });
    expect(messageCalls).toHaveLength(1);
    expect(JSON.parse(String(messageCalls[0]?.[1]?.content)).text).toContain(
      '园区持证看板飞书通知功能自测成功',
    );
  });
});
