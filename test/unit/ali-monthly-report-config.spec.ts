import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AliMonthlyReportService } from '../../server/modules/ali-monthly-report/ali-monthly-report.service';

type ConfigInternals = {
  resolveConfigPath: () => string;
  resolveEmailAppDir: () => string;
  getConfigFileValues: (path: string) => Record<string, string>;
  normalizeRecipient: (value: unknown) => string;
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
    'user-b54e355d@example.com; user-20a3f7b8@example.com';

  it('服务器未配置环境变量和本地配置时返回两名默认收件人', async () => {
    await withRecipientEnv({}, async () => {
      const config = await createConfigService().getConfig();

      expect(config.defaultEmailRecipient).toBe(expectedDefaultRecipients);
      expect(config.defaultEmailRecipient).not.toContain(
        'user-7e80d4ec@example.com',
      );
    });
  });

  it('服务器遗留单邮箱配置仍补齐新增默认收件人', async () => {
    await withRecipientEnv({}, async () => {
      const config = await createConfigService({
        recipient: 'user-b54e355d@example.com',
      }).getConfig();

      expect(config.defaultEmailRecipient).toBe(expectedDefaultRecipients);
    });
  });

  it('显式环境变量保留自定义邮箱并补齐两名默认收件人', async () => {
    await withRecipientEnv(
      { ALI_MONTHLY_REPORT_EMAIL_RECIPIENT: 'user-618fcdcd@example.com' },
      async () => {
        const config = await createConfigService().getConfig();

        expect(config.defaultEmailRecipient).toBe(
          `user-618fcdcd@example.com; ${expectedDefaultRecipients}`,
        );
      },
    );
  });

  it('遗留环境变量或手工发送列表中的示例人员014只保留在正文，不进入投递名单', async () => {
    await withRecipientEnv(
      {
        ALI_MONTHLY_REPORT_EMAIL_RECIPIENT:
          'user-b54e355d@example.com; user-adb19fdd@example.com; user-20a3f7b8@example.com',
      },
      async () => {
        const service = createConfigService();
        const config = await service.getConfig();
        const internals = service as unknown as ConfigInternals;

        expect(config.defaultEmailRecipient).toBe(expectedDefaultRecipients);
        expect(
          internals.normalizeRecipient(
            'user-b54e355d@example.com; user-7e80d4ec@example.com; user-20a3f7b8@example.com',
          ),
        ).toBe(expectedDefaultRecipients);
        expect(() =>
          internals.normalizeRecipient('user-7e80d4ec@example.com'),
        ).toThrow('收件人邮箱不能为空');
      },
    );
  });

  it('遗留文件配置中的示例人员014不会进入页面默认收件人', async () => {
    await withRecipientEnv({}, async () => {
      const config = await createConfigService({
        recipient: 'user-b54e355d@example.com; user-7e80d4ec@example.com',
      }).getConfig();

      expect(config.defaultEmailRecipient).toBe(expectedDefaultRecipients);
    });
  });

  it('旧邮件工具只在正文抄送行展示示例人员014，不加入默认收件人', () => {
    const emailAppSource = readFileSync(
      resolve(
        process.cwd(),
        'tools/ali-monthly-report-email/app.py',
      ),
      'utf8',
    );

    expect(emailAppSource).toContain(
      'DEFAULT_RECIPIENT = "user-b54e355d@example.com; user-20a3f7b8@example.com"',
    );
    expect(emailAppSource).toContain('user-20a3f7b8@example.com');
    expect(emailAppSource).toContain(
      "示例人员014 &lt;user-7e80d4ec@example.com&gt;",
    );
    expect(
      emailAppSource.match(/DEFAULT_RECIPIENT\s*=\s*"([^"]*)"/)?.[1],
    ).not.toContain('user-7e80d4ec@example.com');
  });
});
