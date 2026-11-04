import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { AliMonthlyReportService } from '../../server/modules/ali-monthly-report/ali-monthly-report.service';

type Internals = {
  getRuntimeConfig: () => unknown;
  ensurePythonDependencies: (...args: unknown[]) => Promise<void>;
  runPython: (
    args: string[],
    ...rest: unknown[]
  ) => Promise<{ stdout: string; stderr: string }>;
  attachFeishuNotification: (...args: unknown[]) => Promise<unknown>;
};

describe('超功耗读取已有附件的实际服务入口', () => {
  let directory: string;
  let service: AliMonthlyReportService;
  let internals: Internals;
  let runPython: jest.SpyInstance;
  let dependencies: jest.SpyInstance;
  let payload: Record<string, unknown>;
  const recordUrl =
    'https://vnet.feishu.cn/base/base_test?table=tbl_test&recordId=rec_existing';

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nt-existing-monthly-'));
    const file = join(directory, 'EA118机柜超功耗告警统计10月份.xlsx');
    writeFileSync(file, 'synthetic-local-attachment');
    service = new AliMonthlyReportService({} as never);
    internals = service as unknown as Internals;
    jest.spyOn(internals, 'getRuntimeConfig').mockReturnValue({
      configPath: '',
      downloadFolder: directory,
      outputDir: directory,
      outputDirLabel: directory,
      values: { ALI_POWER_ALERT_CONFIG_PATH: '' },
    });
    dependencies = jest
      .spyOn(internals, 'ensurePythonDependencies')
      .mockResolvedValue(undefined);
    payload = {
      action: 'downloaded_existing_attachment',
      message: '月度超功耗已有附件已获取',
      files: [{ path: file, name: basename(file) }],
      reused_records: [{ record_id: 'rec_existing', record_url: recordUrl }],
    };
    runPython = jest
      .spyOn(internals, 'runPython')
      .mockImplementation(async (args) => {
        if (!args[0].endsWith('monthly_report_runner.py'))
          throw new Error('禁止调用生成上传桥接');
        return { stdout: JSON.stringify(payload), stderr: '' };
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    expect(resolve(directory).startsWith(resolve(tmpdir()) + sep)).toBe(true);
    expect(basename(directory).startsWith('nt-existing-monthly-')).toBe(true);
    rmSync(directory, { recursive: true, force: true });
  });

  it('配置路径为空时仍只读已有附件，保留原记录链接，不推送额外手工通知', async () => {
    const notify = jest.spyOn(internals, 'attachFeishuNotification');
    const response = await service.generateForAutomation(
      'over_power',
      2026,
      10,
    );
    expect(dependencies).toHaveBeenCalledWith(expect.anything(), 'core');
    expect(runPython).toHaveBeenCalledTimes(1);
    expect(runPython.mock.calls[0][0]).toEqual(
      expect.arrayContaining([
        '--type',
        'over_power',
        '--year',
        '2026',
        '--month',
        '10',
      ]),
    );
    expect(response).toMatchObject({
      success: true,
      action: 'downloaded_existing_attachment',
      bitableRecordUrls: [recordUrl],
    });
    expect(response.files).toHaveLength(1);
    expect(notify).not.toHaveBeenCalled();
  });

  it('相同来源链接只返回一次，拒绝不安全链接', async () => {
    payload.reused_records = [
      { record_url: recordUrl },
      { record_url: recordUrl },
      { record_url: 'http://vnet.feishu.cn/unsafe' },
      { record_url: 'https://user:secret@vnet.feishu.cn/unsafe' },
      {
        record_url:
          'https://example.test/base/base_test?table=tbl_test&recordId=rec_existing',
      },
      { record_url: 'https://vnet.feishu.cn/base/base_test?table=tbl_test' },
    ];
    expect(
      (await service.generateForAutomation('over_power', 2026, 10))
        .bitableRecordUrls,
    ).toEqual([recordUrl]);
  });

  it.each([
    ['没有文件', { files: [] }],
    ['没有来源记录', { reused_records: [] }],
    [
      '上传回执冒充来源记录',
      { reused_records: [], uploaded: { record_url: recordUrl } },
    ],
    ['并非复用结果', { action: 'generated_and_uploaded' }],
  ])('%s时不能记录为成功，也不回退生成或上传', async (_label, changed) => {
    Object.assign(payload, changed);
    await expect(
      service.generateForAutomation('over_power', 2026, 10),
    ).rejects.toThrow();
    expect(runPython).toHaveBeenCalledTimes(1);
  });

  it('读取失败直接保留失败，不尝试生成上传', async () => {
    runPython.mockRejectedValue(new Error('未找到2026年10月超功耗附件'));
    await expect(
      service.generateForAutomation('over_power', 2026, 10),
    ).rejects.toThrow('未找到2026年10月超功耗附件');
    expect(runPython).toHaveBeenCalledTimes(1);
  });
});
