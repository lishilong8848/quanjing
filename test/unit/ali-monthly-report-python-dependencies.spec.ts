import { AliMonthlyReportService } from '../../server/modules/ali-monthly-report/ali-monthly-report.service';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type RuntimeConfigForTest = {
  configPath: string;
  downloadFolder: string;
  outputDir: string;
  outputDirLabel: string;
  feishuChatId: string;
  defaultEmailRecipient: string;
  publicBaseUrl: string;
  downloadSigningRoot: string;
  values: Record<string, string>;
};

type GenerateResponseForTest = {
  success: boolean;
  reportType:
    | 'staff_roster'
    | 'alarm_analysis'
    | 'over_power'
    | 'four_item_bundle';
  year: number;
  month: number;
  message: string;
  files: [];
  logs: [];
  bitableRecordUrls?: string[];
};

type ServiceInternals = {
  ensurePythonDependencies: (
    runtime: RuntimeConfigForTest,
    profile: 'core' | 'over_power' | 'legacy',
  ) => Promise<void>;
  getRuntimeConfig: () => RuntimeConfigForTest;
  runReport: (...args: unknown[]) => Promise<GenerateResponseForTest>;
  runLegacyGeneratedReport: (
    ...args: unknown[]
  ) => Promise<GenerateResponseForTest>;
  attachFeishuNotification: (
    runtime: RuntimeConfigForTest,
    response: GenerateResponseForTest,
  ) => Promise<GenerateResponseForTest>;
  runPython: (
    args: string[],
    runtimeEnv: Record<string, string>,
    options?: Record<string, unknown>,
  ) => Promise<{ stdout: string; stderr: string }>;
  getPythonCommand: () => string;
  getBundledPythonPackagesDir: () => string;
};

const runtime: RuntimeConfigForTest = {
  configPath: '',
  downloadFolder: 'D:\\temp\\ali-monthly-report',
  outputDir: 'D:\\temp\\ali-monthly-report',
  outputDirLabel: 'output/ali-monthly-report',
  feishuChatId: 'oc_test',
  defaultEmailRecipient: '',
  publicBaseUrl: 'https://portal.example.test/',
  downloadSigningRoot: '0123456789abcdef0123456789abcdef',
  values: {},
};

function createService(): {
  service: AliMonthlyReportService;
  internals: ServiceInternals;
} {
  const service = new AliMonthlyReportService({} as never);
  return {
    service,
    internals: service as unknown as ServiceInternals,
  };
}

describe('Ali monthly report Python command path', () => {
  it('resolves an explicitly configured relative Python path from the application root', () => {
    const previousPython = process.env.ALI_MONTHLY_REPORT_PYTHON;
    process.env.ALI_MONTHLY_REPORT_PYTHON =
      '.venv-ali-report\\Scripts\\python.exe';

    try {
      const { internals } = createService();
      expect(internals.getPythonCommand()).toBe(
        resolve(process.cwd(), '.venv-ali-report\\Scripts\\python.exe'),
      );
    } finally {
      if (previousPython === undefined) {
        delete process.env.ALI_MONTHLY_REPORT_PYTHON;
      } else {
        process.env.ALI_MONTHLY_REPORT_PYTHON = previousPython;
      }
    }
  });

  it('保留成功 JSON 中用于构造多维表链接的 app token', async () => {
    const { internals } = createService();
    const appToken = 'PUBLIC_EXAMPLE_FEISHU_DAILY_REPORT_APP_TOKEN';
    jest.spyOn(internals, 'getPythonCommand').mockReturnValue(process.execPath);

    const completed = await internals.runPython(
      [
        '-e',
        [
          'const token = process.env.FEISHU_APP_TOKEN;',
          'process.stdout.write(JSON.stringify({',
          'uploaded: {',
          'record_url: `https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE`',
          '}',
          '}));',
        ].join(''),
      ],
      { FEISHU_APP_TOKEN: appToken },
      { actionName: '测试月报生成' },
    );

    expect(JSON.parse(completed.stdout)).toMatchObject({
      uploaded: {
        record_url: `https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE`,
      },
    });
  });

  it('Python 子进程自动加载热包内预装依赖目录', async () => {
    const bundledPackagesDir = mkdtempSync(
      join(tmpdir(), 'ali-monthly-report-python-'),
    );
    writeFileSync(
      join(bundledPackagesDir, 'bundled_dependency_probe.py'),
      'VALUE = "bundled-runtime-ready"\n',
      'utf8',
    );

    const { internals } = createService();
    jest.spyOn(internals, 'getPythonCommand').mockReturnValue('python');
    internals.getBundledPythonPackagesDir = () => bundledPackagesDir;

    try {
      const completed = await internals.runPython(
        [
          '-c',
          'import bundled_dependency_probe; print(bundled_dependency_probe.VALUE)',
        ],
        {},
        { actionName: '测试预装 Python 依赖目录' },
      );

      expect(completed.stdout.trim()).toBe('bundled-runtime-ready');
    } finally {
      rmSync(bundledPackagesDir, { recursive: true, force: true });
    }
  });
});

describe('阿里月报 Python 依赖准备', () => {
  it('本地依赖预检通过时不调用 pip 或访问网络', async () => {
    const { internals } = createService();
    const runPython = jest
      .spyOn(internals, 'runPython')
      .mockResolvedValue({ stdout: '{"ready": true}', stderr: '' });

    await internals.ensurePythonDependencies(runtime, 'core');

    expect(runPython).toHaveBeenCalledTimes(1);
    expect(runPython.mock.calls[0][0][0]).toContain(
      'python_dependency_probe.py',
    );
    expect(runPython.mock.calls[0][0][1]).toBe('core');
    expect(runPython.mock.calls[0][0]).not.toContain('pip');
  });

  it('预检发现缺包时不在生成请求内调用 pip', async () => {
    const { internals } = createService();
    jest
      .spyOn(internals, 'getPythonCommand')
      .mockReturnValue('C:\\Python312\\python.exe');
    const runPython = jest
      .spyOn(internals, 'runPython')
      .mockRejectedValueOnce(
        new Error(
          'missing_or_broken=pandas (ModuleNotFoundError),flask (ImportError)',
        ),
      );

    let caught: unknown;
    try {
      await internals.ensurePythonDependencies(runtime, 'legacy');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain(
      '缺失或导入失败模块: pandas (ModuleNotFoundError), flask (ImportError)',
    );
    expect(message).toContain('当前 Python: C:\\Python312\\python.exe');

    expect(runPython).toHaveBeenCalledTimes(1);
    expect(runPython.mock.calls[0][0][0]).toContain(
      'python_dependency_probe.py',
    );
    expect(runPython.mock.calls[0][0][1]).toBe('legacy');
    expect(runPython.mock.calls[0][0]).not.toContain('pip');
  });

  it('依赖预检超时时显示超时原因但不触发在线安装', async () => {
    const { internals } = createService();
    jest
      .spyOn(internals, 'runPython')
      .mockRejectedValueOnce(new Error('阿里月报完整 Python 依赖预检超时'));

    await expect(
      internals.ensurePythonDependencies(runtime, 'legacy'),
    ).rejects.toThrow('依赖预检超时');
  });

  it('依赖预检失败时不把 Python traceback 回传页面', async () => {
    const { internals } = createService();
    const traceback = [
      'Traceback (most recent call last):',
      '  File "pip/_vendor/urllib3/response.py", line 443',
      'pip._vendor.urllib3.exceptions.ReadTimeoutError:',
      "HTTPSConnectionPool(host='files.pythonhosted.org', port=443): Read timed out.",
    ].join('\n');
    jest
      .spyOn(internals, 'runPython')
      .mockRejectedValueOnce(new Error(traceback));

    let caught: unknown;
    try {
      await internals.ensurePythonDependencies(runtime, 'core');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : String(caught);
    expect(message).toContain(
      '阿里月报核心 Python 依赖未就绪。请在服务器执行 scripts/install-ali-monthly-report-python-deps.ps1 后重启服务并重试',
    );
    expect(message).not.toContain('Traceback');
  });

  it('在职人员生成只检查核心依赖档位', async () => {
    const { service, internals } = createService();
    const response = {
      success: true,
      reportType: 'staff_roster' as const,
      year: 2026,
      month: 7,
      message: '在职人员表已生成',
      files: [] as [],
      logs: [] as [],
    };
    jest.spyOn(internals, 'getRuntimeConfig').mockReturnValue(runtime);
    const ensureDependencies = jest
      .spyOn(internals, 'ensurePythonDependencies')
      .mockResolvedValue(undefined);
    jest.spyOn(internals, 'runReport').mockResolvedValue(response);
    jest
      .spyOn(internals, 'attachFeishuNotification')
      .mockResolvedValue(response);

    await service.generate({
      reportType: 'staff_roster',
      year: 2026,
      month: 7,
    });

    expect(ensureDependencies).toHaveBeenCalledWith(runtime, 'core');
  });

  it('四项打包通过通用生成入口时也跳过月报 Python 依赖预检', async () => {
    const { service, internals } = createService();
    const response: GenerateResponseForTest = {
      success: true,
      reportType: 'four_item_bundle',
      year: 2026,
      month: 7,
      message: '四项文件已打包',
      files: [],
      logs: [],
    };
    jest.spyOn(internals, 'getRuntimeConfig').mockReturnValue(runtime);
    const ensureDependencies = jest
      .spyOn(internals, 'ensurePythonDependencies')
      .mockResolvedValue(undefined);
    jest.spyOn(internals, 'runReport').mockResolvedValue(response);
    jest
      .spyOn(internals, 'attachFeishuNotification')
      .mockResolvedValue(response);

    await service.generate({
      reportType: 'four_item_bundle',
      year: 2026,
      month: 7,
    });

    expect(ensureDependencies).not.toHaveBeenCalled();
  });

  it('自动任务生成入口复用生成逻辑但不发送单项群通知', async () => {
    const { service, internals } = createService();
    const response: GenerateResponseForTest = {
      success: true,
      reportType: 'staff_roster',
      year: 2026,
      month: 7,
      message: '人员变动已生成并上传',
      files: [],
      logs: [],
      bitableRecordUrls: [
        'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
      ],
    };
    jest.spyOn(internals, 'getRuntimeConfig').mockReturnValue(runtime);
    const ensureDependencies = jest
      .spyOn(internals, 'ensurePythonDependencies')
      .mockResolvedValue(undefined);
    const runReport = jest
      .spyOn(internals, 'runReport')
      .mockResolvedValue(response);
    const attachNotification = jest
      .spyOn(internals, 'attachFeishuNotification')
      .mockResolvedValue(response);

    const automationService = service as unknown as {
      generateForAutomation: (
        reportType: 'staff_roster',
        year: number,
        month: number,
      ) => Promise<GenerateResponseForTest>;
    };
    const generated = await automationService.generateForAutomation(
      'staff_roster',
      2026,
      7,
    );

    expect(generated).toEqual(response);
    expect(ensureDependencies).toHaveBeenCalledWith(runtime, 'core');
    expect(runReport).toHaveBeenCalledWith('staff_roster', 2026, 7, runtime);
    expect(attachNotification).not.toHaveBeenCalled();
  });

  it('月度超功耗生成只检查专用依赖档位', async () => {
    const { service, internals } = createService();
    const response: GenerateResponseForTest = {
      success: true,
      reportType: 'over_power',
      year: 2026,
      month: 7,
      message: '月度超功耗附件已获取',
      files: [],
      logs: [],
    };
    jest.spyOn(internals, 'getRuntimeConfig').mockReturnValue(runtime);
    const ensureDependencies = jest
      .spyOn(internals, 'ensurePythonDependencies')
      .mockResolvedValue(undefined);
    jest.spyOn(internals, 'runReport').mockResolvedValue(response);
    jest
      .spyOn(internals, 'attachFeishuNotification')
      .mockResolvedValue(response);

    await service.generate({
      reportType: 'over_power',
      year: 2026,
      month: 7,
    });

    expect(ensureDependencies).toHaveBeenCalledWith(runtime, 'over_power');
  });

  it('月度超功耗继续使用旧版完整生成上传逻辑', async () => {
    const { internals } = createService();
    const response: GenerateResponseForTest = {
      success: true,
      reportType: 'over_power',
      year: 2026,
      month: 7,
      message: '月度超功耗已生成并上传',
      files: [],
      logs: [],
    };
    const runLegacy = jest
      .spyOn(internals, 'runLegacyGeneratedReport')
      .mockResolvedValue(response);
    const runPython = jest.spyOn(internals, 'runPython');

    await internals.runReport('over_power', 2026, 7, runtime);

    expect(runLegacy).toHaveBeenCalledWith('over_power', 2026, 7, runtime);
    expect(runPython).not.toHaveBeenCalled();
  });

  it('告警分析把核心生成器返回的多维表记录链接带到服务响应', async () => {
    const { internals } = createService();
    jest.spyOn(internals, 'runPython').mockResolvedValue({
      stdout: JSON.stringify({
        action: 'generated_and_uploaded',
        message: '月度告警分析已生成并上传',
        files: [],
        uploaded: {
          record_id: 'rec-alarm',
          record_url:
            'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
        },
      }),
      stderr: '',
    });

    const response = await internals.runReport(
      'alarm_analysis',
      2026,
      7,
      runtime,
    );

    expect(response.bitableRecordUrls).toEqual([
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
    ]);
  });

  it('超功耗把旧版生成器返回的全部多维表记录链接带到服务响应', async () => {
    const { internals } = createService();
    jest.spyOn(internals, 'runPython').mockResolvedValue({
      stdout: JSON.stringify({
        success: true,
        result: {
          action: 'generated_over_power_updated',
          message: '月度超功耗已生成并覆盖',
          files: [],
          updated: {
            record_id: 'rec-one',
            record_url:
              'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
          },
          updated_records: [
            {
              record_id: 'rec-one',
              record_url:
                'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
            },
            {
              record_id: 'rec-two',
              record_url:
                'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
            },
          ],
        },
        logs: [],
      }),
      stderr: '',
    });

    const response = await internals.runLegacyGeneratedReport(
      'over_power',
      2026,
      7,
      runtime,
    );

    expect(response.bitableRecordUrls).toEqual([
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
    ]);
  });
});

describe('阿里月报 Python 依赖部署契约', () => {
  const root = resolve(__dirname, '../..');
  const probePath = resolve(
    root,
    'tools/ali-monthly-report/python_dependency_probe.py',
  );
  const probeSource = existsSync(probePath)
    ? readFileSync(probePath, 'utf8')
    : '';
  const installerSource = readFileSync(
    resolve(root, 'scripts/install-ali-monthly-report-python-deps.ps1'),
    'utf8',
  );
  const compiledControllerSource = readFileSync(
    resolve(
      root,
      'dist/server/modules/ali-monthly-report/ali-monthly-report.controller.js',
    ),
    'utf8',
  );
  const compiledServiceSource = readFileSync(
    resolve(
      root,
      'dist/server/modules/ali-monthly-report/ali-monthly-report.service.js',
    ),
    'utf8',
  );
  const packagerSource = readFileSync(
    resolve(root, 'scripts/create-ali-monthly-report-hotfix-package.ps1'),
    'utf8',
  );

  it('安装脚本支持本地预检、离线 wheelhouse、有限重试和安装后复检', () => {
    expect(installerSource).toContain('Test-PythonDependencies');
    expect(installerSource).toContain('python_dependency_probe.py');
    expect(installerSource).toContain('[string]$Wheelhouse');
    expect(installerSource).toContain("'--no-input'");
    expect(installerSource).toContain("'--only-binary=:all:'");
    expect(installerSource).toContain("'--timeout', '120'");
    expect(installerSource).toContain("'--retries', '5'");
    expect(installerSource).toContain("'--no-index'");
    expect(installerSource).toContain("'--find-links'");
    expect(
      installerSource.match(/Test-PythonDependencies/g) || [],
    ).toHaveLength(3);
  });

  it('热包包含安装脚本和两份 requirements，并支持带入离线 wheelhouse', () => {
    expect(packagerSource).toContain(
      'scripts/install-ali-monthly-report-python-deps.ps1',
    );
    expect(packagerSource).toContain(
      'tools/ali-monthly-report/requirements.txt',
    );
    expect(packagerSource).toContain(
      'tools/ali-monthly-report/python_dependency_probe.py',
    );
    for (const runtimeFile of [
      'tools/ali-monthly-report/monthly_report_runner.py',
      'tools/ali-monthly-report/ali_monthly_reports/config.py',
      'tools/ali-monthly-report/ali_monthly_reports/feishu.py',
      'tools/ali-monthly-report/ali_monthly_reports/reports.py',
      'tools/ali-monthly-report/ali_monthly_reports/cli.py',
      'tools/ali-monthly-report-email/ali_alarm_report_generator.py',
      'tools/ali-monthly-report-email/ali_over_power_report_generator.py',
    ]) {
      expect(packagerSource).toContain(runtimeFile);
    }
    expect(packagerSource).toContain('sync_alarm_report_attachment');
    expect(packagerSource).toContain('generate_high_power_top5_report');
    expect(packagerSource).toContain("'over_power':");
    expect(packagerSource).toContain('bitableRecordUrls');
    expect(packagerSource).toContain('同步到资料管理告警分析表');
    expect(packagerSource).toContain('资料管理多维表');
    expect(packagerSource).toContain('ALI_POWER_ALERT_CONFIG_PATH');
    expect(packagerSource).toContain('资料管理附件配置缺失');
    expect(packagerSource).toContain(
      'tools/ali-monthly-report-email/requirements.txt',
    );
    expect(packagerSource).toContain('[string]$WheelhousePath');
    expect(packagerSource).toContain('python/wheelhouse');
    expect(packagerSource).toContain(
      "(Resolve-Path ''.venv-ali-report\\Scripts\\python.exe'').Path",
    );
    expect(packagerSource).toContain('绝对路径');
    expect(packagerSource).toContain("'process.cwd(), configured'");
    expect(packagerSource).toContain(
      "'../../common/config/external-services.config'",
    );
    expect(packagerSource).toContain("'openapi.ApiResponse'");
    expect(packagerSource).toContain('dependencyInstallRequired = $true');
  });

  it('生产编译产物保留 Nest 路径重写和 Swagger 元数据', () => {
    expect(compiledServiceSource).toContain(
      'require("../../common/config/external-services.config")',
    );
    expect(compiledServiceSource).not.toContain('require("@server/');
    expect(compiledControllerSource).toContain('require("@nestjs/swagger")');
    expect(compiledControllerSource).toContain('openapi.ApiResponse');
  });

  it('共享探针按核心、超功耗和完整档位验证真实导入', () => {
    expect(probeSource).toContain("'core':");
    expect(probeSource).toContain("'over_power':");
    expect(probeSource).toContain("'legacy':");
    expect(probeSource).toContain("'openpyxl'");
    expect(probeSource).toContain("'requests'");
    expect(probeSource).toContain("'pythoncom'");
    expect(probeSource).toContain('importlib.import_module');
  });
});
