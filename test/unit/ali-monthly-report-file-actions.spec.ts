import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

jest.mock('@nestjs/common', () => {
  const decorator = () => () => undefined;
  return {
    BadRequestException: class BadRequestException extends Error {},
    Body: decorator,
    Controller: decorator,
    Get: decorator,
    Injectable: decorator,
    Logger: class Logger {
      log() {}
      warn() {}
      error() {}
    },
    Param: decorator,
    Post: decorator,
    Query: decorator,
    Res: decorator,
    SetMetadata: decorator,
  };
});

jest.mock('../../server/common/access/unified-access.decorators', () => ({
  AdminOnly: () => () => undefined,
  PublicAccess: () => () => undefined,
}));

import { AliMonthlyReportController } from '../../server/modules/ali-monthly-report/ali-monthly-report.controller';
import {
  deriveAliMonthlyReportDownloadSigningSecret,
  signAliMonthlyReportDownload,
} from '../../server/modules/ali-monthly-report/ali-monthly-report-feishu';
import * as serviceModule from '../../server/modules/ali-monthly-report/ali-monthly-report.service';

type ResultNavigationModule = {
  scrollGeneratedFilesIntoView: (
    target: {
      scrollIntoView(options: {
        behavior: 'auto' | 'smooth';
        block: 'start';
      }): void;
    } | null,
    prefersReducedMotion: boolean,
    scheduleFrame: (callback: () => void) => number,
  ) => number | null;
};

type FileAction = 'open' | 'reveal';
type FileActionCommand = {
  command: string;
  args: string[];
};
type CommandBuilder = (
  filePath: string,
  action: FileAction,
  platform?: NodeJS.Platform,
) => FileActionCommand;

const root = resolve(__dirname, '../..');
const controllerSource = readFileSync(
  resolve(
    root,
    'server/modules/ali-monthly-report/ali-monthly-report.controller.ts',
  ),
  'utf8',
);
const serviceSource = readFileSync(
  resolve(
    root,
    'server/modules/ali-monthly-report/ali-monthly-report.service.ts',
  ),
  'utf8',
);
const apiSource = readFileSync(
  resolve(root, 'client/src/api/index.ts'),
  'utf8',
);
const pageSource = readFileSync(
  resolve(root, 'client/src/pages/AliMonthlyReport/index.tsx'),
  'utf8',
);

function getCommandBuilder(): CommandBuilder | undefined {
  return (
    serviceModule as unknown as {
      buildAliMonthlyReportFileActionCommand?: CommandBuilder;
    }
  ).buildAliMonthlyReportFileActionCommand;
}

function loadResultNavigationModule(): ResultNavigationModule | undefined {
  const targetPath =
    '../../client/src/pages/AliMonthlyReport/result-navigation';
  let resolvedPath: string;

  try {
    resolvedPath = require.resolve(targetPath);
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      error.code === 'MODULE_NOT_FOUND'
    ) {
      return undefined;
    }
    throw error;
  }

  return require(resolvedPath) as ResultNavigationModule;
}

function overrideProcessPlatform(platform: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  if (!descriptor) {
    throw new Error('无法读取 process.platform 属性');
  }
  Object.defineProperty(process, 'platform', {
    ...descriptor,
    value: platform,
  });
  return () => Object.defineProperty(process, 'platform', descriptor);
}

describe('阿里月报生成文件本机操作', () => {
  it('使用默认程序打开文件且不经过命令行 shell', () => {
    const builder = getCommandBuilder();
    expect(typeof builder).toBe('function');
    if (!builder) return;

    expect(
      builder('D:\\reports\\monthly report.xlsx', 'open', 'win32'),
    ).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'D:\\reports\\monthly report.xlsx'],
    });
  });

  it('在资源管理器中定位文件', () => {
    const builder = getCommandBuilder();
    expect(typeof builder).toBe('function');
    if (!builder) return;

    expect(builder('D:\\reports\\monthly.xlsx', 'reveal', 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['/select,D:\\reports\\monthly.xlsx'],
    });
  });

  it('非 Windows 环境返回明确错误', () => {
    const builder = getCommandBuilder();
    expect(typeof builder).toBe('function');
    if (!builder) return;

    expect(() => builder('/tmp/monthly.xlsx', 'open', 'linux')).toThrow(
      '仅支持在 Windows 服务器上打开或定位文件',
    );
  });

  it('控制器把打开和定位动作委托给同一个安全服务入口', async () => {
    const performFileAction = jest
      .fn()
      .mockImplementation(async (fileId: string, action: FileAction) => ({
        success: true,
        action,
        fileId,
        fileName: 'monthly.xlsx',
        message: action === 'open' ? '已打开文件' : '已定位文件',
      }));
    const controller = new AliMonthlyReportController({
      performGeneratedFileAction: performFileAction,
    } as never);
    const controllerMethods = controller as unknown as {
      openGeneratedFile?: (fileId: string) => Promise<unknown>;
      revealGeneratedFile?: (fileId: string) => Promise<unknown>;
    };

    expect(typeof controllerMethods.openGeneratedFile).toBe('function');
    expect(typeof controllerMethods.revealGeneratedFile).toBe('function');
    if (
      !controllerMethods.openGeneratedFile ||
      !controllerMethods.revealGeneratedFile
    ) {
      return;
    }

    await controllerMethods.openGeneratedFile.call(controller, 'safe-file-id');
    await controllerMethods.revealGeneratedFile.call(
      controller,
      'safe-file-id',
    );

    expect(performFileAction).toHaveBeenNthCalledWith(
      1,
      'safe-file-id',
      'open',
    );
    expect(performFileAction).toHaveBeenNthCalledWith(
      2,
      'safe-file-id',
      'reveal',
    );
  });

  it('服务只操作输出目录内由文件 ID 指向的真实文件', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'ali-report-actions-'));
    const filePath = join(outputDir, 'monthly report.xlsx');
    const previousOutputDir = process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR;
    const restorePlatform = overrideProcessPlatform('win32');
    process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR = outputDir;
    writeFileSync(filePath, 'report');

    try {
      const service = new serviceModule.AliMonthlyReportService({} as never);
      const launchLocalFileAction = jest.fn().mockResolvedValue(undefined);
      (
        service as unknown as {
          launchLocalFileAction: typeof launchLocalFileAction;
        }
      ).launchLocalFileAction = launchLocalFileAction;
      const fileId = Buffer.from('monthly report.xlsx', 'utf8').toString(
        'base64url',
      );

      await expect(
        service.performGeneratedFileAction(fileId, 'open'),
      ).resolves.toMatchObject({
        success: true,
        action: 'open',
        fileId,
        fileName: 'monthly report.xlsx',
      });
      expect(launchLocalFileAction).toHaveBeenCalledWith('rundll32.exe', [
        'url.dll,FileProtocolHandler',
        resolve(filePath),
      ]);

      const traversalId = Buffer.from('..\\outside.xlsx', 'utf8').toString(
        'base64url',
      );
      await expect(
        service.performGeneratedFileAction(traversalId, 'open'),
      ).rejects.toThrow('下载文件标识不合法');
      expect(launchLocalFileAction).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
      if (previousOutputDir === undefined) {
        delete process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR;
      } else {
        process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR = previousOutputDir;
      }
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('有效签名可在无会话读取真实 XLSX，篡改签名会在读文件前失败', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'ali-report-public-read-'));
    const filePath = join(outputDir, '在职人员.xlsx');
    const previousOutputDir = process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR;
    const previousSigningSecret =
      process.env.ALI_MONTHLY_REPORT_DOWNLOAD_SIGNING_SECRET;
    const signingRoot = '0123456789abcdef0123456789abcdef';
    process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR = outputDir;
    process.env.ALI_MONTHLY_REPORT_DOWNLOAD_SIGNING_SECRET = signingRoot;
    writeFileSync(filePath, 'representative xlsx payload');

    try {
      const service = new serviceModule.AliMonthlyReportService({} as never);
      const fileId = Buffer.from('在职人员.xlsx', 'utf8').toString('base64url');
      const expires = Math.floor(Date.now() / 1_000) + 3_600;
      const signature = signAliMonthlyReportDownload(
        fileId,
        expires,
        deriveAliMonthlyReportDownloadSigningSecret(signingRoot),
      );

      await expect(
        service.readPublicGeneratedFile(fileId, String(expires), signature),
      ).resolves.toMatchObject({
        buffer: Buffer.from('representative xlsx payload'),
        fileName: '在职人员.xlsx',
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      await expect(
        service.readPublicGeneratedFile(
          fileId,
          String(expires),
          `${signature.slice(0, -1)}${signature.endsWith('A') ? 'B' : 'A'}`,
        ),
      ).rejects.toThrow('下载链接无效或已过期');
    } finally {
      if (previousOutputDir === undefined) {
        delete process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR;
      } else {
        process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR = previousOutputDir;
      }
      if (previousSigningSecret === undefined) {
        delete process.env.ALI_MONTHLY_REPORT_DOWNLOAD_SIGNING_SECRET;
      } else {
        process.env.ALI_MONTHLY_REPORT_DOWNLOAD_SIGNING_SECRET =
          previousSigningSecret;
      }
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it('拒绝通过目录联接逃出输出目录，也拒绝打开危险扩展', async () => {
    const outputDir = mkdtempSync(join(tmpdir(), 'ali-report-safe-root-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'ali-report-outside-'));
    const linkedDir = join(outputDir, 'linked');
    const outsideFile = join(outsideDir, 'outside.xlsx');
    const unsafeFile = join(outputDir, 'unsafe.cmd');
    const previousOutputDir = process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR;
    const hostPlatform = process.platform;
    process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR = outputDir;
    writeFileSync(outsideFile, 'outside');
    writeFileSync(unsafeFile, 'echo unsafe');
    mkdirSync(join(outputDir, 'safe'), { recursive: true });
    symlinkSync(
      outsideDir,
      linkedDir,
      hostPlatform === 'win32' ? 'junction' : 'dir',
    );

    const restorePlatform = overrideProcessPlatform('win32');
    try {
      const service = new serviceModule.AliMonthlyReportService({} as never);
      const launchLocalFileAction = jest.fn().mockResolvedValue(undefined);
      (
        service as unknown as {
          launchLocalFileAction: typeof launchLocalFileAction;
        }
      ).launchLocalFileAction = launchLocalFileAction;

      const linkedFileId = Buffer.from(
        join('linked', 'outside.xlsx'),
        'utf8',
      ).toString('base64url');
      await expect(
        service.performGeneratedFileAction(linkedFileId, 'open'),
      ).rejects.toThrow('文件不在阿里月报输出目录内');

      const unsafeFileId = Buffer.from('unsafe.cmd', 'utf8').toString(
        'base64url',
      );
      await expect(
        service.performGeneratedFileAction(unsafeFileId, 'open'),
      ).rejects.toThrow('仅支持打开或定位 XLSX、ZIP 文件');
      expect(launchLocalFileAction).not.toHaveBeenCalled();
    } finally {
      restorePlatform();
      if (previousOutputDir === undefined) {
        delete process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR;
      } else {
        process.env.ALI_MONTHLY_REPORT_OUTPUT_DIR = previousOutputDir;
      }
      rmSync(outputDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('路由只接收现有文件 ID，并复用下载白名单校验', () => {
    expect(controllerSource).toContain("@Post('files/:fileId/open')");
    expect(controllerSource).toContain("@Post('files/:fileId/reveal')");
    expect(controllerSource).toMatch(
      /@AdminOnly\(\)\s*@Post\('files\/:fileId\/open'\)/,
    );
    expect(controllerSource).toMatch(
      /@AdminOnly\(\)\s*@Post\('files\/:fileId\/reveal'\)/,
    );
    expect(serviceSource).toMatch(
      /performGeneratedFileAction[\s\S]*assertAllowedFile\(this\.decodeFileId\(fileId\)\)/,
    );
    expect(serviceSource).toContain('realpath');
    expect(serviceSource).toContain('已提交系统打开请求');
  });

  it('页面提供打开和定位按钮并在请求前立即进入处理中状态', () => {
    expect(apiSource).toContain('openAliMonthlyReportFile');
    expect(apiSource).toContain('revealAliMonthlyReportFile');
    expect(pageSource).toContain('打开文件');
    expect(pageSource).toContain('定位文件');
    expect(pageSource).toContain('fileActionInFlightRef.current');
    expect(pageSource).toMatch(
      /setFileActionKey\(actionKey\);[\s\S]*await actionRequest\(file\.id\)/,
    );
  });

  it('单项月报生成后按飞书通知结果显示成功或警告提示', () => {
    const generateHandler = pageSource.slice(
      pageSource.indexOf('const handleGenerate = async () =>'),
      pageSource.indexOf('const handleBundleFourItems = async () =>'),
    );

    expect(generateHandler).toContain(
      'data.feishuMessage && !data.feishuMessage.sent',
    );
    expect(generateHandler).toMatch(
      /data\.feishuMessage && !data\.feishuMessage\.sent[\s\S]*toast\.warning[\s\S]*else[\s\S]*toast\.success/,
    );
  });

  it('多群通知结果展示全部目标群并区分部分失败', () => {
    expect(pageSource).toContain("message.chatIds?.join('、')");
    expect(pageSource).toContain('飞书通知部分失败');
    expect(pageSource).toContain('message.deliveries?.some');
  });

  it('四项打包同步拦截重复点击并为请求生成唯一 mutation ID', () => {
    const bundleHandler = pageSource.slice(
      pageSource.indexOf('const handleBundleFourItems = async () =>'),
      pageSource.indexOf('const handleSendEmail = async () =>'),
    );

    expect(pageSource).toContain('const bundleInFlightRef = useRef(false);');
    expect(pageSource).toContain('crypto.randomUUID()');
    expect(bundleHandler).toMatch(
      /if \(bundleInFlightRef\.current\) \{\s*return;\s*\}/,
    );
    expect(bundleHandler).toMatch(
      /bundleInFlightRef\.current = true;[\s\S]*clientMutationId/,
    );
    expect(bundleHandler).toMatch(
      /finally \{[\s\S]*bundleInFlightRef\.current = false;[\s\S]*setBundling\(false\)/,
    );
  });

  it('四项打包失败时保留上一次成功结果并明确显示当前处理阶段', () => {
    const bundleHandler = pageSource.slice(
      pageSource.indexOf('const handleBundleFourItems = async () =>'),
      pageSource.indexOf('const handleSendEmail = async () =>'),
    );

    expect(bundleHandler).not.toContain('setResult(null)');
    expect(pageSource).toContain('正在下载并打包4项文件');
  });

  it('网络失败重试沿用同一 mutationId，服务端明确响应后才清除', () => {
    const bundleHandler = pageSource.slice(
      pageSource.indexOf('const handleBundleFourItems = async () =>'),
      pageSource.indexOf('const handleSendEmail = async () =>'),
    );

    expect(pageSource).toContain('const bundleMutationRef = useRef<');
    expect(bundleHandler).toContain('bundleMutationRef.current?.period');
    expect(bundleHandler).toContain('bundleMutationRef.current?.id');
    expect(bundleHandler).toMatch(
      /bundleMutationRef\.current = \{[\s\S]*period:[\s\S]*id: clientMutationId/,
    );
    expect(bundleHandler).toMatch(
      /const data = await bundleAliMonthlyReportFiles[\s\S]*bundleMutationRef\.current = null/,
    );
    const catchBlock = bundleHandler.slice(bundleHandler.indexOf('} catch'));
    expect(catchBlock).not.toContain('bundleMutationRef.current = null');
  });

  it('本次失败时任务状态为警告并明确标注展示的是最近成功结果', () => {
    const taskStateSource = pageSource.slice(
      pageSource.indexOf('const taskState = useMemo<TaskState>'),
      pageSource.indexOf('const fileState ='),
    );

    expect(
      taskStateSource.indexOf("if (error) return 'warning';"),
    ).toBeLessThan(taskStateSource.indexOf("if (result) return 'done';"));
    expect(pageSource).toContain('结果月份：{result.year}年{result.month}月');
    expect(pageSource).toContain('最近一次成功结果（本次操作失败）');
  });

  it('四项打包成功提示会话群和示例人员020且投递标签区分群与个人', () => {
    expect(pageSource).toContain('已发送会话群和示例人员020');
    expect(pageSource).toContain("recipientType === 'user'");
    expect(pageSource).toContain("recipientType === 'chat'");
    expect(pageSource).toContain('recipientName');
  });

  it('ZIP 结果只读展示四项打包来源及完整性计数', () => {
    const bundleItemsStart = pageSource.indexOf(
      '{result?.bundleItems?.length ? (',
    );
    const bundleItemsEnd = pageSource.indexOf(
      '{result?.files.length ?',
      bundleItemsStart,
    );

    expect(bundleItemsStart).toBeGreaterThanOrEqual(0);
    expect(bundleItemsEnd).toBeGreaterThan(bundleItemsStart);

    const bundleItemsSource = pageSource.slice(
      bundleItemsStart,
      bundleItemsEnd,
    );
    expect(bundleItemsSource).toContain(
      '打包内容（{result.bundleItems.length}/4）',
    );
    expect(bundleItemsSource).toContain('item.category');
    expect(bundleItemsSource).toContain('{item.name}');
    expect(bundleItemsSource).not.toContain('item.downloadUrl');
    expect(bundleItemsSource).not.toContain('handleFileAction');
    expect(bundleItemsSource).not.toContain('<Button');
  });

  it('非减少动态模式在下一帧平滑滚动到生成结果', () => {
    const navigation = loadResultNavigationModule();
    expect(navigation?.scrollGeneratedFilesIntoView).toBeDefined();
    if (!navigation) return;

    const target = {
      scrollIntoView: jest.fn(),
    };
    const scheduledCallbacks: Array<() => void> = [];
    const scheduleFrame = jest.fn((callback: () => void) =>
      scheduledCallbacks.push(callback),
    );

    const frameId = navigation.scrollGeneratedFilesIntoView(
      target,
      false,
      scheduleFrame,
    );

    expect(frameId).toBe(1);
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(scheduleFrame).toHaveBeenCalledTimes(1);
    expect(scheduledCallbacks).toHaveLength(1);

    scheduledCallbacks[0]();

    expect(target.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    });
  });

  it('减少动态模式在下一帧直接滚动到生成结果', () => {
    const navigation = loadResultNavigationModule();
    expect(navigation?.scrollGeneratedFilesIntoView).toBeDefined();
    if (!navigation) return;

    const target = {
      scrollIntoView: jest.fn(),
    };
    const scheduledCallbacks: Array<() => void> = [];
    const scheduleFrame = jest.fn((callback: () => void) =>
      scheduledCallbacks.push(callback),
    );

    const frameId = navigation.scrollGeneratedFilesIntoView(
      target,
      true,
      scheduleFrame,
    );

    expect(frameId).toBe(1);
    expect(target.scrollIntoView).not.toHaveBeenCalled();
    expect(scheduledCallbacks).toHaveLength(1);

    scheduledCallbacks[0]();

    expect(target.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'auto',
      block: 'start',
    });
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('生成结果目标不存在时不安排滚动帧', () => {
    const navigation = loadResultNavigationModule();
    expect(navigation?.scrollGeneratedFilesIntoView).toBeDefined();
    if (!navigation) return;

    const scheduleFrame = jest.fn((_callback: () => void) => 1);

    const frameId = navigation.scrollGeneratedFilesIntoView(
      null,
      false,
      scheduleFrame,
    );

    expect(frameId).toBeNull();
    expect(scheduleFrame).not.toHaveBeenCalled();
  });

  it('结果滚动帧在重复调度和页面卸载时被安全清理', () => {
    expect(pageSource).toMatch(
      /const resultScrollFrameRef = useRef<number \| null>\(null\);/,
    );

    const revealStart = pageSource.indexOf('const revealGeneratedFiles');
    const selectedReportTypeStart = pageSource.indexOf(
      'const selectedReportType',
      revealStart,
    );

    expect(revealStart).toBeGreaterThanOrEqual(0);
    expect(selectedReportTypeStart).toBeGreaterThan(revealStart);

    const revealSource = pageSource.slice(revealStart, selectedReportTypeStart);
    expect(revealSource).toMatch(
      /const target = resultCardRef\.current;[\s\S]*if \(resultScrollFrameRef\.current !== null\) \{\s*window\.cancelAnimationFrame\(resultScrollFrameRef\.current\);\s*resultScrollFrameRef\.current = null;\s*\}[\s\S]*resultScrollFrameRef\.current = scrollGeneratedFilesIntoView\(/,
    );
    expect(revealSource).toMatch(
      /window\.requestAnimationFrame\(\(\) => \{\s*resultScrollFrameRef\.current = null;\s*if \(resultCardRef\.current === target\) \{\s*callback\(\);\s*\}\s*\}\)/,
    );
    expect(revealSource.match(/callback\(\);/g) || []).toHaveLength(1);

    const effectsStart = pageSource.indexOf(
      'useEffect(() => {',
      pageSource.indexOf('const loadConfig'),
    );
    const handleGenerateStart = pageSource.indexOf('const handleGenerate');

    expect(effectsStart).toBeGreaterThanOrEqual(0);
    expect(handleGenerateStart).toBeGreaterThan(effectsStart);

    const effectsSource = pageSource.slice(effectsStart, handleGenerateStart);
    const cleanupEffects = [
      ...effectsSource.matchAll(
        /useEffect\(\(\) => \{[\s\S]*?\n  \}, \[\]\);/g,
      ),
    ].filter((match) => match[0].includes('cancelAnimationFrame'));

    expect(cleanupEffects).toHaveLength(1);
    expect(cleanupEffects[0][0]).toMatch(
      /return \(\) => \{\s*if \(resultScrollFrameRef\.current !== null\) \{\s*window\.cancelAnimationFrame\(resultScrollFrameRef\.current\);\s*resultScrollFrameRef\.current = null;\s*\}\s*\};/,
    );
    expect(effectsSource).toContain('return () => window.clearTimeout(timer);');
  });

  it('生成结果卡片前置并在两条成功路径接入结果导航', () => {
    const cardTitleMatches = [
      ...pageSource.matchAll(/<CardTitle\b[^>]*>[\s\S]*?<\/CardTitle>/g),
    ];
    const resultTitleMatch = cardTitleMatches.find((match) =>
      match[0].includes('生成结果'),
    );
    const emailTitleMatch = cardTitleMatches.find((match) =>
      match[0].includes('文件与邮件'),
    );

    expect(resultTitleMatch).toBeDefined();
    expect(emailTitleMatch).toBeDefined();
    if (!resultTitleMatch || !emailTitleMatch) return;

    const findNearestCardStart = (titleIndex: number): number => {
      const cardStarts = [
        ...pageSource.slice(0, titleIndex).matchAll(/<Card(?=\s|>)/g),
      ];
      const nearestCard = cardStarts[cardStarts.length - 1];
      return nearestCard?.index ?? -1;
    };
    const resultCardStart = findNearestCardStart(resultTitleMatch.index ?? -1);
    const emailCardStart = findNearestCardStart(emailTitleMatch.index ?? -1);

    expect(resultCardStart).toBeGreaterThanOrEqual(0);
    expect(emailCardStart).toBeGreaterThan(resultCardStart);

    const resultCardOpeningTagEnd = pageSource.indexOf('>', resultCardStart);
    expect(resultCardOpeningTagEnd).toBeGreaterThan(resultCardStart);
    const resultCardOpeningTag = pageSource.slice(
      resultCardStart,
      resultCardOpeningTagEnd + 1,
    );

    expect(resultCardOpeningTag).toContain('ref={resultCardRef}');
    expect(resultCardOpeningTag).toContain('scroll-mt-20');
    expect(pageSource).toMatch(
      /import\s*\{\s*scrollGeneratedFilesIntoView\s*\}\s*from\s*(['"])\.\/result-navigation\1\s*;?/,
    );

    const handleGenerateStart = pageSource.indexOf('const handleGenerate');
    const handleBundleFourItemsStart = pageSource.indexOf(
      'const handleBundleFourItems',
    );
    const handleSendEmailStart = pageSource.indexOf('const handleSendEmail');

    expect(handleGenerateStart).toBeGreaterThanOrEqual(0);
    expect(handleBundleFourItemsStart).toBeGreaterThan(handleGenerateStart);
    expect(handleSendEmailStart).toBeGreaterThan(handleBundleFourItemsStart);

    const handleGenerateSource = pageSource.slice(
      handleGenerateStart,
      handleBundleFourItemsStart,
    );
    const handleBundleFourItemsSource = pageSource.slice(
      handleBundleFourItemsStart,
      handleSendEmailStart,
    );

    expect(handleGenerateSource).toMatch(
      /setResult\(data\);\s*revealGeneratedFiles\(\);/,
    );
    expect(handleBundleFourItemsSource).toMatch(
      /setResult\(data\);\s*revealGeneratedFiles\(\);/,
    );
    expect(pageSource.match(/revealGeneratedFiles\(\);/g) || []).toHaveLength(
      2,
    );
  });
});
