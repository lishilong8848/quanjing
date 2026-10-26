import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('阿里月报服务器邮件桥接', () => {
  const serviceSource = readFileSync(
    resolve(
      process.cwd(),
      'server/modules/ali-monthly-report/ali-monthly-report.service.ts',
    ),
    'utf8',
  );
  const bridgeStart = serviceSource.indexOf(
    'const EMAIL_BRIDGE_SCRIPT = String.raw`',
  );
  const bridgeEnd = serviceSource.indexOf(
    'const LEGACY_GENERATE_BRIDGE_SCRIPT',
    bridgeStart,
  );
  const emailBridgeSource = serviceSource.slice(bridgeStart, bridgeEnd);

  it('超功耗正文只附加同一个超功耗工作簿', () => {
    expect(emailBridgeSource).toContain(
      'temp_power_file = app.import_file_to_temp(power_file)',
    );
    expect(emailBridgeSource).toContain(
      'recipient_text = app.send_report_email(\n        temp_power_file,',
    );
    expect(emailBridgeSource).not.toContain('temp_alarm_file');
    expect(emailBridgeSource).not.toContain('attachment_path=');
    expect(emailBridgeSource).not.toContain('download_report_attachments(\n');
  });

  it('服务响应把超功耗文件标记为邮件附件', () => {
    expect(emailBridgeSource).toContain(
      '"file": app.generated_file_payload(power_file)',
    );
    expect(emailBridgeSource).toContain('超功耗邮件已发送到');
    expect(emailBridgeSource).not.toContain('告警分析邮件已发送到');
  });
});
