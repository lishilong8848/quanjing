import {
  buildAliMonthlyReportFeishuText,
  buildAliMonthlyReportPublicDownloadUrl,
  deriveAliMonthlyReportDownloadSigningSecret,
  signAliMonthlyReportDownload,
  verifyAliMonthlyReportDownload,
} from '../../server/modules/ali-monthly-report/ali-monthly-report-feishu';
import { AliMonthlyReportService } from '../../server/modules/ali-monthly-report/ali-monthly-report.service';
import type { AliMonthlyReportGenerateResponse } from '../../shared/api.interface';

describe('阿里月报飞书下载通知工具', () => {
  const signingSecret = 'test-signing-secret';
  const expires = 1_800_000_000;

  it('使用固定用途稳定派生与根密钥不同的签名子密钥', () => {
    const rootSecret = '0123456789abcdef0123456789abcdef';
    const derived = deriveAliMonthlyReportDownloadSigningSecret(rootSecret);

    expect(derived).toBe(
      '9beac0ee298c514fe96e196c440150143d4035d70c75f05968f36263c5cd5f48',
    );
    expect(derived).toHaveLength(64);
    expect(derived).not.toBe(rootSecret);
    expect(deriveAliMonthlyReportDownloadSigningSecret(rootSecret)).toBe(
      derived,
    );
  });

  it.each(['   ', 'short-download-secret'])(
    '拒绝空或不足 32 字节的根密钥 %j',
    (rootSecret) => {
      expect(() =>
        deriveAliMonthlyReportDownloadSigningSecret(rootSecret),
      ).toThrow(/阿里月报.*签名密钥/);
    },
  );

  it('按固定用途、文件和有效期生成 base64url 签名', () => {
    expect(
      signAliMonthlyReportDownload('staff-file', expires, signingSecret),
    ).toBe('oVqxC6_rhWAHtz24ocM51DTGvzcBUpqegnTq2j5ytd0');
  });

  it.each([
    ['空文件标识', '   ', expires, signingSecret],
    ['空签名密钥', 'staff-file', expires, '   '],
    ['零有效期', 'staff-file', 0, signingSecret],
    ['负数有效期', 'staff-file', -1, signingSecret],
    ['非整数有效期', 'staff-file', expires + 0.5, signingSecret],
    [
      '非安全整数有效期',
      'staff-file',
      Number.MAX_SAFE_INTEGER + 1,
      signingSecret,
    ],
  ])('签名时拒绝%s', (_name, fileId, expiresValue, secretValue) => {
    expect(() =>
      signAliMonthlyReportDownload(fileId, expiresValue, secretValue),
    ).toThrow();
  });

  it('保留公共基址子路径并生成可验证的精确 HTTPS 下载链接', () => {
    const url = buildAliMonthlyReportPublicDownloadUrl({
      publicBaseUrl: 'https://portal.example.test/nantong/',
      fileId: 'staff-file',
      expires,
      signingSecret,
    });

    expect(url).toBe(
      'https://portal.example.test/nantong/api/ali-monthly-report/public-files/staff-file?expires=1800000000&signature=oVqxC6_rhWAHtz24ocM51DTGvzcBUpqegnTq2j5ytd0',
    );
    expect(
      verifyAliMonthlyReportDownload({
        fileId: 'staff-file',
        expires,
        signature: new URL(url).searchParams.get('signature') || '',
        signingSecret,
        nowSeconds: expires - 1,
      }),
    ).toBe(true);
  });

  it('把文件标识编码为单个路径段且签名仍可验证', () => {
    const fileId = 'staff/file +中文';
    const url = buildAliMonthlyReportPublicDownloadUrl({
      publicBaseUrl: 'https://portal.example.test/nantong',
      fileId,
      expires,
      signingSecret,
    });
    const parsed = new URL(url);

    expect(parsed.pathname).toBe(
      '/nantong/api/ali-monthly-report/public-files/staff%2Ffile%20%2B%E4%B8%AD%E6%96%87',
    );
    expect(
      verifyAliMonthlyReportDownload({
        fileId,
        expires,
        signature: parsed.searchParams.get('signature') || '',
        signingSecret,
        nowSeconds: expires - 1,
      }),
    ).toBe(true);
  });

  it.each(['.', '..'])('拒绝 URL 点段文件标识 %s', (fileId) => {
    expect(() =>
      buildAliMonthlyReportPublicDownloadUrl({
        publicBaseUrl: 'https://portal.example.test/nantong/',
        fileId,
        expires,
        signingSecret,
      }),
    ).toThrow(/文件标识/);
  });

  it.each([0, -1])('构造下载 URL 时拒绝非正有效期 %s', (expiresValue) => {
    expect(() =>
      buildAliMonthlyReportPublicDownloadUrl({
        publicBaseUrl: 'https://portal.example.test/nantong/',
        fileId: 'staff-file',
        expires: expiresValue,
        signingSecret,
      }),
    ).toThrow(/有效期/);
  });

  it.each([
    ['HTTP', 'http://portal.example.test/nantong/'],
    ['用户名密码', 'https://user:user-a1ad1416@example.com/nantong/'],
    ['查询参数', 'https://portal.example.test/nantong/?tenant=one'],
    ['片段', 'https://portal.example.test/nantong/#download'],
  ])('拒绝带%s的公共基址', (_name, publicBaseUrl) => {
    expect(() =>
      buildAliMonthlyReportPublicDownloadUrl({
        publicBaseUrl,
        fileId: 'staff-file',
        expires,
        signingSecret,
      }),
    ).toThrow(/HTTPS/);
  });

  it('拒绝过期、篡改和跨文件复用的签名', () => {
    const validSignature = signAliMonthlyReportDownload(
      'staff-file',
      expires,
      signingSecret,
    );
    const tamperedSignature = `${validSignature.slice(0, -1)}${
      validSignature.endsWith('A') ? 'B' : 'A'
    }`;

    expect(
      verifyAliMonthlyReportDownload({
        fileId: 'staff-file',
        expires,
        signature: validSignature,
        signingSecret,
        nowSeconds: expires,
      }),
    ).toBe(false);
    expect(
      verifyAliMonthlyReportDownload({
        fileId: 'staff-file',
        expires,
        signature: tamperedSignature,
        signingSecret,
        nowSeconds: expires - 1,
      }),
    ).toBe(false);
    expect(
      verifyAliMonthlyReportDownload({
        fileId: 'other-file',
        expires,
        signature: validSignature,
        signingSecret,
        nowSeconds: expires - 1,
      }),
    ).toBe(false);
  });

  it.each([
    [
      '空文件标识',
      {
        fileId: ' ',
        expires,
        signature: 'signature',
        signingSecret,
        nowSeconds: expires - 1,
      },
    ],
    [
      '空签名',
      {
        fileId: 'staff-file',
        expires,
        signature: ' ',
        signingSecret,
        nowSeconds: expires - 1,
      },
    ],
    [
      '空签名密钥',
      {
        fileId: 'staff-file',
        expires,
        signature: 'signature',
        signingSecret: ' ',
        nowSeconds: expires - 1,
      },
    ],
    [
      '非法有效期',
      {
        fileId: 'staff-file',
        expires: Number.NaN,
        signature: 'signature',
        signingSecret,
        nowSeconds: expires - 1,
      },
    ],
    [
      '非法当前时间',
      {
        fileId: 'staff-file',
        expires,
        signature: 'signature',
        signingSecret,
        nowSeconds: 1.5,
      },
    ],
  ])('校验遇到%s时返回 false', (_name, options) => {
    expect(verifyAliMonthlyReportDownload(options)).toBe(false);
  });

  it('校验遇到非法参数对象时返回 false', () => {
    expect(verifyAliMonthlyReportDownload(null as never)).toBe(false);
  });

  it('消息逐项对应两个文件名和下载链接', () => {
    const text = buildAliMonthlyReportFeishuText({
      year: 2026,
      month: 7,
      reportTypeLabel: '在职人员导出',
      files: [
        {
          name: '在职人员.xlsx',
          url: 'https://portal.example.test/download/one',
        },
        {
          name: '变动明细.xlsx',
          url: 'https://portal.example.test/download/two',
        },
      ],
    });

    expect(text).toBe(
      [
        '阿里月报已生成',
        '月份：2026年7月',
        '类型：在职人员导出',
        '文件：',
        '1. 在职人员.xlsx',
        '   https://portal.example.test/download/one',
        '2. 变动明细.xlsx',
        '   https://portal.example.test/download/two',
      ].join('\n'),
    );
  });

  it.each([
    ['低于范围的年份', 1999, 7],
    ['高于范围的年份', 2101, 7],
    ['非整数年份', 2026.5, 7],
    ['小于 1 的月份', 2026, 0],
    ['大于 12 的月份', 2026, 13],
    ['非整数月份', 2026, 7.5],
  ])('拒绝%s', (_name, year, month) => {
    expect(() =>
      buildAliMonthlyReportFeishuText({
        year,
        month,
        reportTypeLabel: '在职人员导出',
        files: [
          {
            name: '在职人员.xlsx',
            url: 'https://portal.example.test/download/one',
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    '   ',
    '在职人员\n伪造内容',
    '在职人员\r伪造内容',
    '在职人员\t伪造内容',
    '在职人员\u0000伪造内容',
    '在职人员\u007f伪造内容',
  ])('拒绝非法类型标签 %j', (reportTypeLabel) => {
    expect(() =>
      buildAliMonthlyReportFeishuText({
        year: 2026,
        month: 7,
        reportTypeLabel,
        files: [
          {
            name: '在职人员.xlsx',
            url: 'https://portal.example.test/download/one',
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    '   ',
    '在职人员\n伪造链接.xlsx',
    '在职人员\r伪造链接.xlsx',
    '在职人员\t伪造链接.xlsx',
    '在职人员\u0000伪造链接.xlsx',
    '在职人员\u007f伪造链接.xlsx',
  ])('拒绝非法文件名 %j', (name) => {
    expect(() =>
      buildAliMonthlyReportFeishuText({
        year: 2026,
        month: 7,
        reportTypeLabel: '在职人员导出',
        files: [
          {
            name,
            url: 'https://portal.example.test/download/one',
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    ['空 URL', '   '],
    ['HTTP URL', 'http://portal.example.test/download/one'],
    ['相对 URL', '/download/one'],
    ['带凭据 URL', 'https://user:user-a1ad1416@example.com/download/one'],
  ])('拒绝%s', (_name, url) => {
    expect(() =>
      buildAliMonthlyReportFeishuText({
        year: 2026,
        month: 7,
        reportTypeLabel: '在职人员导出',
        files: [{ name: '在职人员.xlsx', url }],
      }),
    ).toThrow();
  });

  it.each([
    ['CR', 'https://portal.example.test/download/\rone'],
    ['LF', 'https://portal.example.test/download/\none'],
    ['TAB', 'https://portal.example.test/download/\tone'],
    ['NUL', 'https://portal.example.test/download/\u0000one'],
    ['U+001F', 'https://portal.example.test/download/\u001fone'],
    ['DEL', 'https://portal.example.test/download/\u007fone'],
  ])('拒绝文件 URL 中的 %s 控制字符', (_name, url) => {
    expect(() =>
      buildAliMonthlyReportFeishuText({
        year: 2026,
        month: 7,
        reportTypeLabel: '在职人员导出',
        files: [{ name: '在职人员.xlsx', url }],
      }),
    ).toThrow(/控制字符/);
  });

  it('保留有效 HTTPS 文件 URL 的签名查询参数', () => {
    const url =
      'https://portal.example.test/download/one?expires=1800000000&signature=signed';

    expect(
      buildAliMonthlyReportFeishuText({
        year: 2000,
        month: 12,
        reportTypeLabel: '在职人员导出',
        files: [{ name: '在职人员.xlsx', url }],
      }),
    ).toContain(`   ${url}`);
  });

  it('拒绝构造没有文件的残缺消息', () => {
    expect(() =>
      buildAliMonthlyReportFeishuText({
        year: 2026,
        month: 7,
        reportTypeLabel: '在职人员导出',
        files: [],
      }),
    ).toThrow(/阿里月报.*文件/);
  });
});

describe('阿里月报生成后的飞书通知编排', () => {
  const targetChatId = 'oc_c79f407063dc9ca9f70cc76cb4059895';
  const generatedResponse: AliMonthlyReportGenerateResponse = {
    success: true,
    reportType: 'high_power_top5',
    year: 2026,
    month: 7,
    message: '高功率 TOP5 已生成',
    files: [
      {
        id: 'top5-file',
        name: '高功率TOP5.xlsx',
        size: '12KB',
        downloadUrl: '/api/ali-monthly-report/files/staff-file',
      },
    ],
    logs: ['生成完成'],
  };

  const runtime = {
    configPath: '',
    downloadFolder: 'D:\\temp\\ali-monthly-report',
    outputDir: 'D:\\temp\\ali-monthly-report',
    outputDirLabel: 'output/ali-monthly-report',
    feishuChatId: targetChatId,
    feishuChatIds: [targetChatId],
    automationFeishuChatId: targetChatId,
    feishuUserOpenId: 'ou_testmajinyu',
    feishuUserEmail: 'user-69255df9@example.com',
    feishuUserName: '示例人员020',
    defaultEmailRecipient: '',
    publicBaseUrl: 'https://portal.example.test/nantong/',
    downloadSigningRoot: '0123456789abcdef0123456789abcdef',
    values: {
      FEISHU_APP_ID: 'test-app-id',
      FEISHU_APP_SECRET: 'test-app-secret',
    },
  };

  type ServiceInternals = {
    ensurePythonDependencies: (...args: unknown[]) => Promise<void>;
    runReport: (
      ...args: unknown[]
    ) => Promise<AliMonthlyReportGenerateResponse>;
    runFourItemBundle: (
      ...args: unknown[]
    ) => Promise<AliMonthlyReportGenerateResponse>;
    getRuntimeConfig: () => unknown;
  };

  type PublicFileReader = {
    readPublicGeneratedFile: (
      fileId: string,
      expiresValue: unknown,
      signatureValue: unknown,
    ) => Promise<{
      buffer: Buffer;
      fileName: string;
      contentType: string;
    }>;
  };

  function createService(options?: {
    response?: AliMonthlyReportGenerateResponse;
    runtime?: typeof runtime;
  }) {
    const fakePost = jest
      .fn()
      .mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'test-tenant-token' },
      })
      .mockResolvedValueOnce({
        data: { code: 0, data: { message_id: 'om_test_message' } },
      });
    const service = new AliMonthlyReportService({
      axiosRef: { post: fakePost },
    } as never);
    const internals = service as unknown as ServiceInternals;
    jest
      .spyOn(internals, 'ensurePythonDependencies')
      .mockResolvedValue(undefined);
    jest
      .spyOn(internals, 'getRuntimeConfig')
      .mockReturnValue(options?.runtime || runtime);
    jest
      .spyOn(internals, 'runReport')
      .mockResolvedValue(options?.response || generatedResponse);
    jest.spyOn(internals, 'runFourItemBundle').mockResolvedValue(
      options?.response || {
        ...generatedResponse,
        reportType: 'four_item_bundle',
        message: '四项文件已打包',
        files: [
          {
            ...generatedResponse.files[0],
            id: 'bundle-file',
            name: '阿里月报四项文件.zip',
          },
        ],
      },
    );
    return { service, internals, fakePost };
  }

  it('单项月报生成成功后发送带签名下载链接的飞书消息', async () => {
    const { service, fakePost } = createService();
    const nowMs = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    let response: AliMonthlyReportGenerateResponse;

    try {
      response = await service.generate({
        reportType: 'staff_roster',
        year: 2026,
        month: 7,
      });
    } finally {
      nowSpy.mockRestore();
    }

    expect(fakePost).toHaveBeenCalledTimes(2);
    expect(fakePost.mock.calls[0][0]).toContain(
      '/auth/v3/tenant_access_token/internal',
    );
    expect(fakePost.mock.calls[1][1]).toMatchObject({
      receive_id: targetChatId,
      msg_type: 'text',
    });
    const message = JSON.parse(String(fakePost.mock.calls[1][1].content)) as {
      text: string;
    };
    expect(message.text).toContain('类型：月度高功率TOP5');
    expect(message.text).toContain('高功率TOP5.xlsx');
    expect(message.text).toContain(
      'https://portal.example.test/nantong/api/ali-monthly-report/public-files/top5-file?',
    );
    expect(message.text).toContain('expires=');
    expect(message.text).toContain('signature=');
    const downloadUrl = message.text
      .split(/\s+/)
      .find((value) => value.startsWith('https://portal.example.test/'));
    expect(downloadUrl).toBeDefined();
    expect(Number(new URL(downloadUrl || '').searchParams.get('expires'))).toBe(
      Math.floor(nowMs / 1_000) + 72 * 60 * 60,
    );
    expect(response.feishuMessage).toMatchObject({
      sent: true,
      chatId: targetChatId,
      messageId: 'om_test_message',
    });
  });

  it.each([
    ['月度告警分析', 'alarm_analysis' as const],
    ['月度超功耗', 'over_power' as const],
    ['在职人员导出', 'staff_roster' as const],
  ])('%s生成成功后只发送资料管理多维表链接', async (_name, reportType) => {
    const bitableRecordUrl =
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';
    const responseWithBitableLink = {
      ...generatedResponse,
      reportType,
      message: `${_name}已生成并上传`,
      bitableRecordUrls: [bitableRecordUrl],
    } as AliMonthlyReportGenerateResponse & { bitableRecordUrls: string[] };
    const { service, fakePost } = createService({
      response: responseWithBitableLink,
      runtime: {
        ...runtime,
        publicBaseUrl: '',
        downloadSigningRoot: '',
      },
    });

    const response = await service.generate({
      reportType,
      year: 2026,
      month: 7,
    });

    expect(fakePost).toHaveBeenCalledTimes(2);
    expect(fakePost.mock.calls[1][1]).toMatchObject({
      receive_id: targetChatId,
      msg_type: 'interactive',
    });
    const cardContent = String(fakePost.mock.calls[1][1].content);
    expect(JSON.parse(cardContent)).toMatchObject({ schema: '2.0' });
    expect(cardContent).toContain('打开多维表记录');
    expect(cardContent).toContain(bitableRecordUrl);
    expect(cardContent).not.toContain('/public-files/');
    expect(cardContent).not.toContain('expires=');
    expect(cardContent).not.toContain('signature=');
    expect(response.feishuMessage).toMatchObject({
      sent: true,
      chatId: targetChatId,
    });
  });

  it('告警分析缺少多维表记录链接时不回退发送本地下载链接', async () => {
    const alarmResponse = {
      ...generatedResponse,
      reportType: 'alarm_analysis' as const,
      message: '月度告警分析已生成并上传',
    };
    const { service, fakePost } = createService({ response: alarmResponse });

    const response = await service.generate({
      reportType: 'alarm_analysis',
      year: 2026,
      month: 7,
    });

    expect(fakePost).not.toHaveBeenCalled();
    expect(response.feishuMessage).toMatchObject({
      sent: false,
      chatId: targetChatId,
      error: expect.stringContaining('多维表记录链接'),
    });
  });

  it('月报生成失败时不调用飞书接口', async () => {
    const { service, internals, fakePost } = createService();
    jest
      .spyOn(internals, 'runReport')
      .mockRejectedValueOnce(new Error('生成失败'));

    await expect(
      service.generate({
        reportType: 'staff_roster',
        year: 2026,
        month: 7,
      }),
    ).rejects.toThrow('生成失败');
    expect(fakePost).not.toHaveBeenCalled();
  });

  it('飞书消息发送失败时保留生成结果并返回明确失败状态', async () => {
    const { service, fakePost } = createService();
    fakePost
      .mockReset()
      .mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'test-tenant-token' },
      })
      .mockRejectedValueOnce(new Error('message failed'));

    const response = await service.generate({
      reportType: 'staff_roster',
      year: 2026,
      month: 7,
    });

    expect(response.success).toBe(true);
    expect(response.files).toEqual(generatedResponse.files);
    expect(response.feishuMessage).toMatchObject({
      sent: false,
      chatId: targetChatId,
      error: expect.stringContaining('message failed'),
    });
  });

  it('飞书令牌获取失败时不调用消息接口且保留生成结果', async () => {
    const { service, fakePost } = createService();
    fakePost.mockReset().mockRejectedValueOnce(new Error('token failed'));

    const response = await service.generate({
      reportType: 'staff_roster',
      year: 2026,
      month: 7,
    });

    expect(fakePost).toHaveBeenCalledTimes(1);
    expect(response.success).toBe(true);
    expect(response.files).toEqual(generatedResponse.files);
    expect(response.feishuMessage).toMatchObject({
      sent: false,
      chatId: targetChatId,
      error: expect.stringContaining('token failed'),
    });
  });

  it('飞书成功码缺少消息 ID 时按通知失败处理', async () => {
    const { service, fakePost } = createService();
    fakePost
      .mockReset()
      .mockResolvedValueOnce({
        data: { code: 0, tenant_access_token: 'test-tenant-token' },
      })
      .mockResolvedValueOnce({ data: { code: 0, data: {} } });

    const response = await service.generate({
      reportType: 'staff_roster',
      year: 2026,
      month: 7,
    });

    expect(fakePost).toHaveBeenCalledTimes(2);
    expect(response.success).toBe(true);
    expect(response.files).toEqual(generatedResponse.files);
    expect(response.feishuMessage).toMatchObject({
      sent: false,
      chatId: targetChatId,
      error: expect.stringMatching(/message_id|消息 ID/i),
    });
  });

  it.each([
    [
      '缺少公共 HTTPS 基址',
      { ...runtime, publicBaseUrl: '' },
      generatedResponse,
    ],
    ['没有生成文件', runtime, { ...generatedResponse, files: [] }],
    [
      '缺少下载签名根密钥',
      {
        ...runtime,
        downloadSigningRoot: '',
        values: {
          ...runtime.values,
          FEISHU_APP_SECRET: '',
        },
      },
      generatedResponse,
    ],
  ])(
    '%s时不调用飞书接口并返回通知失败',
    async (_name, runtimeValue, responseValue) => {
      const { service, fakePost } = createService({
        runtime: runtimeValue,
        response: responseValue,
      });

      const response = await service.generate({
        reportType: 'staff_roster',
        year: 2026,
        month: 7,
      });

      expect(fakePost).not.toHaveBeenCalled();
      expect(response.success).toBe(true);
      expect(response.files).toEqual(responseValue.files);
      expect(response.feishuMessage).toMatchObject({
        sent: false,
        chatId: targetChatId,
        error: expect.any(String),
      });
    },
  );

  it('四项打包上传一次 ZIP，并把同一飞书文件发送到会话群和示例人员020', async () => {
    const { service, internals, fakePost } = createService();
    const readGeneratedFile = jest
      .spyOn(service, 'readGeneratedFile')
      .mockResolvedValue({
        buffer: Buffer.from('PK-test-zip-content'),
        fileName: '阿里月报四项文件.zip',
        contentType: 'application/zip',
      });

    const skipped = await service.bundleFourItems({
      year: 2026,
      month: 7,
      sendFeishu: false,
      clientMutationId: 'bundle-skip-test',
    });
    expect(fakePost).not.toHaveBeenCalled();
    expect(skipped.feishuMessage).toBeUndefined();
    expect(readGeneratedFile).not.toHaveBeenCalled();

    fakePost.mockReset().mockImplementation(async (url: string) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return {
          data: { code: 0, tenant_access_token: 'test-tenant-token' },
        };
      }
      if (url.includes('/im/v1/files')) {
        return { data: { code: 0, data: { file_key: 'file_test_bundle' } } };
      }
      if (url.includes('/im/v1/messages')) {
        return { data: { code: 0, data: { message_id: 'om_test_file' } } };
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const sent = await service.bundleFourItems({
      year: 2026,
      month: 7,
      sendFeishu: true,
      clientMutationId: 'bundle-2026-07-test',
    });
    expect(readGeneratedFile).toHaveBeenCalledWith(
      'bundle-file',
      30 * 1024 * 1024,
    );
    expect(internals.ensurePythonDependencies).not.toHaveBeenCalled();
    expect(fakePost).toHaveBeenCalledTimes(4);

    const uploadCall = fakePost.mock.calls.find(([url]) =>
      String(url).includes('/im/v1/files'),
    );
    expect(uploadCall).toBeDefined();
    const uploadForm = uploadCall?.[1] as {
      getBuffer: () => Buffer;
      getHeaders: () => Record<string, string>;
    };
    expect(uploadForm.getHeaders()['content-type']).toContain(
      'multipart/form-data; boundary=',
    );
    expect(uploadCall?.[2]).toMatchObject({
      maxBodyLength: Infinity,
      timeout: 60_000,
    });
    const uploadBody = uploadForm.getBuffer().toString('utf8');
    expect(uploadBody).toContain('name="file_type"');
    expect(uploadBody).toContain('stream');
    expect(uploadBody).toContain('name="file_name"');
    expect(uploadBody).toContain('阿里月报四项文件.zip');
    expect(uploadBody).toContain('PK-test-zip-content');

    const messageCalls = fakePost.mock.calls.filter(([url]) =>
      String(url).includes('/im/v1/messages'),
    );
    expect(messageCalls).toHaveLength(2);
    expect(String(messageCalls[0][0])).toContain('receive_id_type=chat_id');
    expect(String(messageCalls[1][0])).toContain('receive_id_type=open_id');
    expect(messageCalls[0][1]).toMatchObject({
      receive_id: targetChatId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: 'file_test_bundle' }),
      uuid: expect.stringMatching(/^amrb-/),
    });
    expect(messageCalls[1][1]).toMatchObject({
      receive_id: 'ou_testmajinyu',
      msg_type: 'file',
      content: JSON.stringify({ file_key: 'file_test_bundle' }),
      uuid: expect.stringMatching(/^amrb-/),
    });
    expect(sent.feishuMessage).toMatchObject({
      sent: true,
      chatId: targetChatId,
      deliveries: [
        {
          chatId: targetChatId,
          recipientType: 'chat',
          sent: true,
        },
        {
          chatId: 'ou_testmajinyu',
          recipientType: 'user',
          recipientName: '示例人员020',
          sent: true,
        },
      ],
    });
    expect(sent.message).toContain('会话群和示例人员020');
  });

  it('四项打包 ZIP 为空时不上传也不发送飞书文件', async () => {
    const { service, fakePost } = createService();
    jest.spyOn(service, 'readGeneratedFile').mockResolvedValue({
      buffer: Buffer.alloc(0),
      fileName: '阿里月报四项文件.zip',
      contentType: 'application/zip',
    });

    const response = await service.bundleFourItems({
      year: 2026,
      month: 7,
      sendFeishu: true,
      clientMutationId: 'bundle-empty-test',
    });

    expect(fakePost).not.toHaveBeenCalled();
    expect(response.feishuMessage).toMatchObject({
      sent: false,
      error: expect.stringContaining('不能为空'),
    });
  });

  it('四项 ZIP 群发送成功但示例人员020失败时保留 ZIP 并返回逐目标状态', async () => {
    const { service, fakePost } = createService();
    jest.spyOn(service, 'readGeneratedFile').mockResolvedValue({
      buffer: Buffer.from('PK-partial-delivery'),
      fileName: '阿里月报四项文件.zip',
      contentType: 'application/zip',
    });
    fakePost.mockReset().mockImplementation(async (url: string, body) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return {
          data: { code: 0, tenant_access_token: 'test-tenant-token' },
        };
      }
      if (url.includes('/im/v1/files')) {
        return { data: { code: 0, data: { file_key: 'file_partial' } } };
      }
      if (body?.receive_id === 'ou_testmajinyu') {
        return { data: { code: 230013, msg: 'user blocked bot' } };
      }
      return { data: { code: 0, data: { message_id: 'om_group' } } };
    });

    const response = await service.bundleFourItems({
      year: 2026,
      month: 7,
      sendFeishu: true,
      clientMutationId: 'bundle-partial-test',
    });

    expect(response.files).toHaveLength(1);
    expect(response.feishuMessage).toMatchObject({
      sent: false,
      deliveries: [
        { recipientType: 'chat', sent: true },
        {
          recipientType: 'user',
          recipientName: '示例人员020',
          sent: false,
          error: expect.stringContaining('user blocked bot'),
        },
      ],
    });
    expect(response.message).toContain('部分发送失败');
  });

  it('示例人员020未配置 open_id 时使用飞书邮箱发送同一个 ZIP', async () => {
    const { service, fakePost } = createService({
      runtime: { ...runtime, feishuUserOpenId: '' },
    });
    jest.spyOn(service, 'readGeneratedFile').mockResolvedValue({
      buffer: Buffer.from('PK-email-delivery'),
      fileName: '阿里月报四项文件.zip',
      contentType: 'application/zip',
    });
    fakePost.mockReset().mockImplementation(async (url: string) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return {
          data: { code: 0, tenant_access_token: 'test-tenant-token' },
        };
      }
      if (url.includes('/im/v1/files')) {
        return { data: { code: 0, data: { file_key: 'file_email' } } };
      }
      return { data: { code: 0, data: { message_id: 'om_file' } } };
    });

    await service.bundleFourItems({
      year: 2026,
      month: 7,
      sendFeishu: true,
      clientMutationId: 'bundle-email-test',
    });

    const directMessage = fakePost.mock.calls.find(([url]) =>
      String(url).includes('receive_id_type=email'),
    );
    expect(directMessage?.[1]).toMatchObject({
      receive_id: 'user-69255df9@example.com',
      msg_type: 'file',
      content: JSON.stringify({ file_key: 'file_email' }),
    });
  });

  it('相同 clientMutationId 的重复请求只打包、上传和投递一次', async () => {
    const { service, internals, fakePost } = createService();
    jest.spyOn(service, 'readGeneratedFile').mockResolvedValue({
      buffer: Buffer.from('PK-idempotent-delivery'),
      fileName: '阿里月报四项文件.zip',
      contentType: 'application/zip',
    });
    fakePost.mockReset().mockImplementation(async (url: string) => {
      if (url.includes('/auth/v3/tenant_access_token/internal')) {
        return {
          data: { code: 0, tenant_access_token: 'test-tenant-token' },
        };
      }
      if (url.includes('/im/v1/files')) {
        return { data: { code: 0, data: { file_key: 'file_idempotent' } } };
      }
      return { data: { code: 0, data: { message_id: 'om_file' } } };
    });
    const payload = {
      year: 2026,
      month: 7,
      sendFeishu: true,
      clientMutationId: 'bundle-idempotent-test',
    };

    const [first, second] = await Promise.all([
      service.bundleFourItems(payload),
      service.bundleFourItems(payload),
    ]);

    expect(first).toBe(second);
    expect(internals.runFourItemBundle).toHaveBeenCalledTimes(1);
    expect(fakePost).toHaveBeenCalledTimes(4);
  });

  it('同一 clientMutationId 被复用于不同月份时拒绝返回旧 ZIP', async () => {
    const { service } = createService();
    const mutationId = 'bundle-conflict-test';

    await service.bundleFourItems({
      year: 2026,
      month: 7,
      sendFeishu: false,
      clientMutationId: mutationId,
    });

    await expect(
      service.bundleFourItems({
        year: 2026,
        month: 8,
        sendFeishu: false,
        clientMutationId: mutationId,
      }),
    ).rejects.toThrow('已用于其他参数');
  });

  it('同年月并发请求即使 mutationId 不同也只执行一次打包', async () => {
    const { service, internals } = createService();
    let releaseBundle: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseBundle = resolve;
    });
    jest.spyOn(internals, 'runFourItemBundle').mockImplementation(async () => {
      await gate;
      return {
        ...generatedResponse,
        reportType: 'four_item_bundle',
        message: '四项文件已打包',
        files: [
          {
            ...generatedResponse.files[0],
            id: 'bundle-file',
            name: '阿里月报四项文件.zip',
          },
        ],
      };
    });

    const first = service.bundleFourItems({
      year: 2026,
      month: 7,
      sendFeishu: false,
      clientMutationId: 'bundle-tab-one',
    });
    const second = service.bundleFourItems({
      year: 2026,
      month: 7,
      sendFeishu: false,
      clientMutationId: 'bundle-tab-two',
    });
    releaseBundle?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(secondResult);
    expect(internals.runFourItemBundle).toHaveBeenCalledTimes(1);
  });

  it('公开文件读取先验签，篡改或过期时不读取，且拒绝非 XLSX/ZIP', async () => {
    const { service } = createService();
    const readGeneratedFile = jest
      .spyOn(service, 'readGeneratedFile')
      .mockResolvedValue({
        buffer: Buffer.from('xlsx'),
        fileName: '在职人员.xlsx',
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
    const expires = Math.floor(Date.now() / 1_000) + 3_600;
    const signingSecret = deriveAliMonthlyReportDownloadSigningSecret(
      runtime.downloadSigningRoot,
    );
    const signature = signAliMonthlyReportDownload(
      'staff-file',
      expires,
      signingSecret,
    );
    const publicReader = service as unknown as PublicFileReader;

    await expect(
      publicReader.readPublicGeneratedFile(
        'staff-file',
        String(expires),
        signature,
      ),
    ).resolves.toMatchObject({ fileName: '在职人员.xlsx' });
    expect(readGeneratedFile).toHaveBeenCalledTimes(1);

    readGeneratedFile.mockClear();
    await expect(
      publicReader.readPublicGeneratedFile(
        'staff-file',
        String(expires),
        `${signature.slice(0, -1)}x`,
      ),
    ).rejects.toThrow(/无效|过期/);
    await expect(
      publicReader.readPublicGeneratedFile(
        'staff-file',
        String(Math.floor(Date.now() / 1_000) - 1),
        signature,
      ),
    ).rejects.toThrow(/无效|过期/);
    expect(readGeneratedFile).not.toHaveBeenCalled();

    readGeneratedFile.mockResolvedValueOnce({
      buffer: Buffer.from('pdf'),
      fileName: '人员名单.pdf',
      contentType: 'application/pdf',
    });
    await expect(
      publicReader.readPublicGeneratedFile(
        'staff-file',
        String(expires),
        signature,
      ),
    ).rejects.toThrow(/XLSX|ZIP/);
  });
});
