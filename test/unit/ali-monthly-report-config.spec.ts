import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AliMonthlyReportService } from '../../server/modules/ali-monthly-report/ali-monthly-report.service';

type ConfigInternals = {
  resolveConfigPath: () => string;
  resolveEmailAppDir: () => string;
  getConfigFileValues: (path: string) => Record<string, string>;
  normalizeRecipient: (value: unknown) => string;
  getRuntimeConfig: () => { publicBaseUrl: string };
};

const RECIPIENT_ENV_KEYS = [
  'ALI_MONTHLY_REPORT_EMAIL_RECIPIENT',
  'ALI_REPORT_EMAIL_RECIPIENT',
] as const;

function withRecipientEnv(
  values: Partial<Record<(typeof RECIPIENT_ENV_KEYS)[number], string>>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = Object.fromEntries(
    RECIPIENT_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  for (const key of RECIPIENT_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return run().finally(() => {
    for (const key of RECIPIENT_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

function createConfigService(
  fileConfig: Record<string, string> = {},
): AliMonthlyReportService {
  const service = new AliMonthlyReportService({} as never);
  const internals = service as unknown as ConfigInternals;
  jest.spyOn(internals, 'resolveConfigPath').mockReturnValue('');
  jest
    .spyOn(internals, 'resolveEmailAppDir')
    .mockReturnValue('D:\\server-without-local-ali-email-tool');
  jest.spyOn(internals, 'getConfigFileValues').mockReturnValue(fileConfig);
  return service;
}

describe('阿里月报默认邮件收件人', () => {
  const expectedDefaultRecipients =
    'ma.jinyu@vnet.com; liu.xiaoxing2-wb@sne.vnet.com';

  it('服务器未配置环境变量和本地配置时返回两名默认收件人', async () => {
    await withRecipientEnv({}, async () => {
      const config = await createConfigService().getConfig();

      expect(config.defaultEmailRecipient).toBe(expectedDefaultRecipients);
      expect(config.defaultEmailRecipient).not.toContain(
        'mei.bingbing@vnet.com',
      );
    });
  });

  it('服务器遗留单邮箱配置仍补齐新增默认收件人', async () => {
    await withRecipientEnv({}, async () => {
      const config = await createConfigService({
        recipient: 'ma.jinyu@vnet.com',
      }).getConfig();

      expect(config.defaultEmailRecipient).toBe(expectedDefaultRecipients);
    });
  });

  it('显式环境变量保留自定义邮箱并补齐两名默认收件人', async () => {
    await withRecipientEnv(
      { ALI_MONTHLY_REPORT_EMAIL_RECIPIENT: 'configured@vnet.com' },
      async () => {
        const config = await createConfigService().getConfig();

        expect(config.defaultEmailRecipient).toBe(
          `configured@vnet.com; ${expectedDefaultRecipients}`,
        );
      },
    );
  });

  it('遗留环境变量或手工发送列表中的梅冰冰只保留在正文，不进入投递名单', async () => {
    await withRecipientEnv(
      {
        ALI_MONTHLY_REPORT_EMAIL_RECIPIENT:
          'ma.jinyu@vnet.com; MEI.BINGBING@vnet.com; liu.xiaoxing2-wb@sne.vnet.com',
      },
      async () => {
        const service = createConfigService();
        const config = await service.getConfig();
        const internals = service as unknown as ConfigInternals;

        expect(config.defaultEmailRecipient).toBe(expectedDefaultRecipients);
        expect(
          internals.normalizeRecipient(
            'ma.jinyu@vnet.com; mei.bingbing@vnet.com; liu.xiaoxing2-wb@sne.vnet.com',
          ),
        ).toBe(expectedDefaultRecipients);
        expect(() =>
          internals.normalizeRecipient('mei.bingbing@vnet.com'),
        ).toThrow('收件人邮箱不能为空');
      },
    );
  });

  it('遗留文件配置中的梅冰冰不会进入页面默认收件人', async () => {
    await withRecipientEnv({}, async () => {
      const config = await createConfigService({
        recipient: 'ma.jinyu@vnet.com; mei.bingbing@vnet.com',
      }).getConfig();

      expect(config.defaultEmailRecipient).toBe(expectedDefaultRecipients);
    });
  });

  it('旧邮件工具只在正文抄送行展示梅冰冰，不加入默认收件人', () => {
    const emailAppSource = readFileSync(
      resolve(
        process.cwd(),
        'tools/ali-monthly-report-email/app.py',
      ),
      'utf8',
    );

    expect(emailAppSource).toContain(
      'DEFAULT_RECIPIENT = "ma.jinyu@vnet.com; liu.xiaoxing2-wb@sne.vnet.com"',
    );
    expect(emailAppSource).toContain('liu.xiaoxing2-wb@sne.vnet.com');
    expect(emailAppSource).toContain(
      "梅冰冰 &lt;mei.bingbing@vnet.com&gt;",
    );
    expect(
      emailAppSource.match(/DEFAULT_RECIPIENT\s*=\s*"([^"]*)"/)?.[1],
    ).not.toContain('mei.bingbing@vnet.com');
  });
});

describe('阿里月报站内下载地址', () => {
  const keys = ['PUBLIC_BASE_URL', 'ALI_MONTHLY_REPORT_PUBLIC_BASE_URL', 'APP_PUBLIC_BASE_URL', 'CLIENT_BASE_PATH'] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));

  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  it.each([
    {
      name: '统一地址补上与飞书回调相同的应用前缀',
      values: ['https://www.sm.sjhl.online:3001/gateway/', 'https://old.example.test/app', '', '/app/'],
      expected: 'https://www.sm.sjhl.online:3001/gateway/app',
    },
    {
      name: '统一公网地址优先于遗留专属地址',
      values: ['https://www.sm.sjhl.online:3001', 'https://sm.sjhl.online:3001', 'https://fallback.example.test'],
      expected: 'https://www.sm.sjhl.online:3001',
    },
    {
      name: '未配置统一公网地址时保留专属地址后备',
      values: ['', 'https://www.sm.sjhl.online:3001/app', 'https://fallback.example.test', '/app'],
      expected: 'https://www.sm.sjhl.online:3001/app',
    },
    {
      name: '前两项缺省时保留应用地址后备',
      values: ['', '', 'https://www.sm.sjhl.online:3001'],
      expected: 'https://www.sm.sjhl.online:3001',
    },
  ])('$name', ({ values, expected }) => {
    keys.forEach((key, index) => {
      if (values[index]) process.env[key] = values[index];
      else delete process.env[key];
    });
    // Reuse the file-read stubs so no local report or email configuration is read.
    const service = createConfigService() as unknown as ConfigInternals;
    expect(service.getRuntimeConfig().publicBaseUrl).toBe(expected);
  });
});
