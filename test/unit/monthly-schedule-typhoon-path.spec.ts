import { readFileSync } from 'fs';
import { join } from 'path';

function getMonthlyScheduleSource(): string {
  return readFileSync(
    join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
    'utf8',
  );
}

function getApiSource(): string {
  return readFileSync(
    join(process.cwd(), 'client/src/api/index.ts'),
    'utf8',
  );
}

describe('MonthlySchedule typhoon path entry', () => {
  it('adds a typhoon path action and opens the official path page in a nearly fullscreen dialog', () => {
    const source = getMonthlyScheduleSource();
    const dialogSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/TyphoonPathDialog.tsx',
      ),
      'utf8',
    );
    const label = '\u53f0\u98ce\u8def\u5f84';

    expect(dialogSource).toContain("const TYPHOON_PATH_URL = 'https://typhoon.slt.zj.gov.cn/#/';");
    expect(source).toContain(`aria-label="\u6253\u5f00${label}"`);
    expect(source).toContain(label);
    expect(source).toContain('setTyphoonDialogOpen(true)');
    expect(source).toContain('<TyphoonPathDialog');
    expect(dialogSource).toContain('Dialog open={open}');
    expect(dialogSource).toContain('src={TYPHOON_PATH_URL}');
    expect(dialogSource).toContain('sandbox="allow-scripts allow-same-origin allow-forms allow-popups"');
    expect(dialogSource).toContain('w-[calc(100vw-1rem)]');
    expect(dialogSource).toContain('h-[calc(100vh-1rem)]');
    expect(dialogSource).toContain('className="sr-only"');
    expect(dialogSource).not.toContain('浙江省水利厅台风路径实时页面');
    expect(dialogSource).not.toContain('新窗口打开');
    expect(dialogSource).not.toContain('max-w-6xl');
    expect(dialogSource).not.toContain('h-[72vh]');
  });

  it('prechecks warnings and requires an explicit confirmation before group send', () => {
    const source = getMonthlyScheduleSource();
    const apiSource = getApiSource();
    const dialogSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/TyphoonPathDialog.tsx',
      ),
      'utf8',
    );

    expect(source).not.toContain('manualTyphoonScreenshotSending');
    expect(dialogSource).toContain('getTyphoonPathScreenshotPreview');
    expect(dialogSource).toContain('sendTyphoonPathGroupScreenshot');
    expect(dialogSource).toContain('AlertDialog');
    expect(dialogSource).toContain('FORCE_SEND_TYPHOON_PATH');
    expect(dialogSource).toContain('当前没有有效台风预警');
    expect(dialogSource).toContain('发送台风路径图');
    expect(dialogSource).toContain('正在检查预警');
    expect(dialogSource).toContain('正在发送');
    expect(dialogSource).toContain('submissionGateRef');
    expect(dialogSource).toContain('savePendingTyphoonPathRequest');
    expect(dialogSource).toContain('readPendingTyphoonPathMutationId');
    expect(dialogSource).toContain("if (!result.success)");
    expect(dialogSource).toContain("result.reason === 'monitor-in-flight'");
    expect(dialogSource).toContain('bottom-6 left-1/2');
    expect(dialogSource).toContain('-translate-x-1/2');
    expect(dialogSource).not.toContain('天气同步');
    expect(apiSource).toContain('sendTyphoonPathGroupScreenshot');
    expect(apiSource).toContain('getTyphoonPathScreenshotPreview');
    expect(apiSource).toContain("url: '/api/typhoon-path-screenshot/preview'");
    expect(apiSource).toContain("url: '/api/typhoon-path-screenshot/send-group'");
  });
});
