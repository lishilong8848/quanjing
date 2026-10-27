import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import FormData = require('form-data');
import { createHash } from 'node:crypto';
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { mkdir, readFile, realpath, stat } from 'fs/promises';
import {
  basename,
  delimiter,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'path';
import type {
  AliMonthlyReportBundleRequest,
  AliMonthlyReportConfigResponse,
  AliMonthlyReportEmailRequest,
  AliMonthlyReportEmailResponse,
  AliMonthlyReportFile,
  AliMonthlyReportFileAction,
  AliMonthlyReportFileActionResponse,
  AliMonthlyReportGenerateRequest,
  AliMonthlyReportGenerateResponse,
  AliMonthlyReportType,
  AliMonthlyReportTypeOption,
} from '@shared/api.interface';
import { readEnv } from '@server/common/config/external-services.config';
import {
  buildAliMonthlyReportAutomationCard,
  buildAliMonthlyReportFeishuText,
  buildAliMonthlyReportManualSuccessCard,
  buildAliMonthlyReportPublicDownloadUrl,
  deriveAliMonthlyReportDownloadSigningSecret,
  verifyAliMonthlyReportDownload,
} from './ali-monthly-report-feishu';
import type { AliMonthlyReportAutomationSummary } from './ali-monthly-report-task-state';

const TOOL_DIR = join(process.cwd(), 'tools', 'ali-monthly-report');
const RUNNER_PATH = join(TOOL_DIR, 'monthly_report_runner.py');
const PYTHON_DEPENDENCY_PROBE_PATH = join(
  TOOL_DIR,
  'python_dependency_probe.py',
);
const FOUR_ITEM_BUNDLE_RUNNER_PATH = join(
  TOOL_DIR,
  'four_item_bundle_runner.py',
);
const DEFAULT_TEMPLATE_PATH = join(
  TOOL_DIR,
  'resources',
  'EA118机房2026年3月告警分析表.xlsx',
);
const DEFAULT_HIGH_POWER_SOURCE_URL =
  'https://vnet.feishu.cn/base/MliKbC3fXa8PXrsndKscmxjdn1g?table=tblkh6YCMYtS8nHa&view=vewrHJHl3v';
const DEFAULT_ALARM_ATTACHMENT_SOURCE_URL =
  'https://vnet.feishu.cn/base/MliKbC3fXa8PXrsndKscmxjdn1g?table=tblAGQeQ7tpV8tWt&view=vewrHJHl3v';
const DEFAULT_STAFF_REPORT_TABLE_ID = 'tbl3KED5CdvNSCwT';
const DEFAULT_STAFF_REPORT_VIEW_ID = 'vewrHJHl3v';
const DEFAULT_OUTPUT_DIR = join(process.cwd(), 'output', 'ali-monthly-report');
const GENERATE_TIMEOUT_MS = 10 * 60 * 1000;
const FOUR_ITEM_BUNDLE_TIMEOUT_MS = 4 * 60 * 1000;
const EMAIL_TIMEOUT_MS = 15 * 60 * 1000;
const PYTHON_DEPS_CHECK_TIMEOUT_MS = 120 * 1000;
const DOWNLOAD_LINK_TTL_SECONDS = 72 * 60 * 60;
const BUNDLE_REQUEST_CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_FEISHU_FILE_SIZE_BYTES = 30 * 1024 * 1024;
const LOCAL_FILE_ACTION_EXTENSIONS = new Set(['.xlsx', '.zip']);
const DEFAULT_FEISHU_CHAT_ID = 'oc_9961bb057de8bd715447559c5e63c4f2';
const DEFAULT_ADDITIONAL_FEISHU_CHAT_ID = 'oc_3bc648b9b761f24a65366a9b04b32eb2';
const DEFAULT_FEISHU_USER_EMAIL = 'ma.jinyu@vnet.com';
const DEFAULT_EMAIL_RECIPIENT =
  'ma.jinyu@vnet.com; liu.xiaoxing2-wb@sne.vnet.com';
const VISIBLE_ONLY_EMAIL_RECIPIENT = 'mei.bingbing@vnet.com';
const BUNDLED_PYTHON_PACKAGES_DIR = join(
  process.cwd(),
  'python',
  'ali-monthly-report-packages',
);
const FEISHU_TOKEN_URL =
  'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal';
const FEISHU_FILE_UPLOAD_URL = 'https://open.feishu.cn/open-apis/im/v1/files';
const FEISHU_MESSAGE_URL = 'https://open.feishu.cn/open-apis/im/v1/messages';
const DEFAULT_EMAIL_APP_DIR = join(
  process.cwd(),
  'tools',
  'ali-monthly-report-email',
);
const LOCAL_EMAIL_APP_DIR = 'D:\\ai\\codex\\阿里月报下载及邮件发送';

export function buildAliMonthlyReportFileActionCommand(
  filePath: string,
  action: AliMonthlyReportFileAction,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  if (platform !== 'win32') {
    throw new Error('仅支持在 Windows 服务器上打开或定位文件');
  }
  if (action === 'open') {
    return {
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', filePath],
    };
  }
  if (action === 'reveal') {
    return {
      command: 'explorer.exe',
      args: [`/select,${filePath}`],
    };
  }
  throw new Error('不支持的文件操作');
}

const EMAIL_BRIDGE_SCRIPT = String.raw`
import json
import os
import sys
import traceback

import app

logs = []


def add_log(message, level="info"):
    logs.append(f"[{level}] {message}")


def apply_env(config):
    env_map = {
        "download_folder": "DOWNLOAD_FOLDER",
        "feishu_app_id": "FEISHU_APP_ID",
        "feishu_app_secret": "FEISHU_APP_SECRET",
        "feishu_app_token": "FEISHU_APP_TOKEN",
        "qq_email": "QQ_EMAIL",
        "auth_code": "AUTH_CODE",
    }
    for key, env_name in env_map.items():
        value = os.environ.get(env_name, "").strip()
        if value:
            config[key] = value
    return config


try:
    recipient = sys.argv[1].strip()
    year = sys.argv[2].strip()
    month_number = int(sys.argv[3])
    subject = sys.argv[4].strip() or app.build_email_subject(year, month_number)
    if not recipient:
        raise ValueError("收件人邮箱不能为空")

    config = apply_env(app.load_config())
    app.require_config_values(
        config,
        [
            "download_folder",
            "feishu_app_id",
            "feishu_app_secret",
            "feishu_app_token",
            "qq_email",
            "auth_code",
        ],
    )

    add_log(f"开始发送阿里月报超功耗邮件: {year}年{month_number}月")
    power_result = app.fetch_existing_monthly_report_files(
        "over_power",
        year,
        month_number,
        config,
        add_log,
    )
    power_file = app.select_alarm_report_file(
        app.collect_result_file_paths(power_result),
        add_log,
    )

    temp_power_file = app.import_file_to_temp(power_file)
    recipient_text = app.send_report_email(
        temp_power_file,
        subject,
        recipient,
        year,
        month_number,
        config=config,
        external_log=add_log,
    )
    payload = {
        "success": True,
        "year": int(year),
        "month": month_number,
        "subject": subject,
        "recipient": recipient_text,
        "message": f"{year}年{month_number}月超功耗邮件已发送到：{recipient_text}",
        "logs": logs[-160:],
        "file": app.generated_file_payload(power_file),
    }
except Exception as exc:
    add_log(str(exc), "error")
    add_log(traceback.format_exc(), "error")
    payload = {
        "success": False,
        "error": str(exc),
        "logs": logs[-160:],
    }
finally:
    try:
        app.cleanup_runtime_cache(external_log=add_log)
    except Exception as cleanup_exc:
        add_log(f"清理临时文件失败: {cleanup_exc}", "warning")

print(json.dumps(payload, ensure_ascii=False, default=str))
`;

const LEGACY_GENERATE_BRIDGE_SCRIPT = String.raw`
import json
import os
import sys
import traceback

import app

logs = []


def add_log(message, level="info"):
    logs.append(f"[{level}] {message}")


def apply_env(config):
    env_map = {
        "download_folder": "DOWNLOAD_FOLDER",
        "feishu_app_id": "FEISHU_APP_ID",
        "feishu_app_secret": "FEISHU_APP_SECRET",
        "feishu_app_token": "FEISHU_APP_TOKEN",
        "ali_power_alert_config_path": "ALI_POWER_ALERT_CONFIG_PATH",
    }
    for key, env_name in env_map.items():
        value = os.environ.get(env_name, "").strip()
        if value:
            config[key] = value
    return config


_original_load_power_alert_config = app.load_power_alert_config
app.DEFAULT_ALI_POWER_TEMPLATE_PATH = ""


def load_power_alert_config_without_missing_template(config):
    power_config = _original_load_power_alert_config(config)
    template_path = str(power_config.get("template_path", "")).strip()
    if template_path:
        try:
            app.resolve_runtime_path(template_path)
        except Exception:
            add_log("Power report template is missing; generating with a new workbook.", "warning")
            power_config["template_path"] = ""
    return power_config


app.load_power_alert_config = load_power_alert_config_without_missing_template


try:
    report_type = sys.argv[1].strip()
    year = sys.argv[2].strip()
    month_number = int(sys.argv[3])
    config = apply_env(app.load_config())
    result = app.generate_ali_monthly_report(
        report_type,
        year,
        month_number,
        config,
        force_new_record=False,
        external_log=add_log,
    )
    payload = {
        "success": True,
        "result": result,
        "logs": logs[-200:],
    }
except Exception as exc:
    add_log(str(exc), "error")
    add_log(traceback.format_exc(), "error")
    payload = {
        "success": False,
        "error": str(exc),
        "logs": logs[-200:],
    }
finally:
    try:
        app.cleanup_runtime_cache(external_log=add_log)
    except Exception as cleanup_exc:
        add_log(f"cleanup failed: {cleanup_exc}", "warning")

print(json.dumps(payload, ensure_ascii=False, default=str))
`;

const REPORT_TYPES: AliMonthlyReportTypeOption[] = [
  {
    key: 'alarm_analysis',
    name: '月度告警分析',
    description: '从告警源生成 Excel，并同步到资料管理告警分析表。',
  },
  {
    key: 'over_power',
    name: '月度超功耗',
    description: '从高功率月报表获取超功率/超功耗附件，自动排除 TOP5。',
  },
  {
    key: 'high_power_top5',
    name: '月度高功率TOP5',
    description: '从高功率月报表自动获取对应月份的 TOP5 附件。',
  },
  {
    key: 'staff_roster',
    name: '在职人员导出',
    description: '从人员管理多维表导出在职人员和本月变动 Excel。',
  },
];

const RUNNER_REPORT_TYPE_KEYS = new Set<AliMonthlyReportType>([
  ...REPORT_TYPES.map((item) => item.key),
  'four_item_bundle',
]);
const AUTOMATION_REPORT_TYPE_KEYS = new Set<AliMonthlyReportType>([
  'alarm_analysis',
  'over_power',
  'staff_roster',
]);

type RunnerResult = {
  action?: string;
  message?: string;
  files?: Array<{
    name?: string;
    path?: string;
    size?: string;
    category?: string;
  }>;
  [key: string]: unknown;
};

type RuntimeConfig = {
  configPath: string;
  downloadFolder: string;
  outputDir: string;
  outputDirLabel: string;
  feishuChatId: string;
  feishuChatIds: string[];
  automationFeishuChatId: string;
  feishuUserOpenId: string;
  feishuUserEmail: string;
  feishuUserName: string;
  defaultEmailRecipient: string;
  publicBaseUrl: string;
  downloadSigningRoot: string;
  values: Record<string, string>;
};

type PythonDependencyProfile = 'core' | 'over_power' | 'legacy';
type FeishuReceiveIdType = 'chat_id' | 'open_id' | 'email';
type FeishuBundleDeliveryTarget = {
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  recipientType: 'chat' | 'user';
  recipientName: string;
};

export type GeneratedFileReadResult = {
  buffer: Buffer;
  fileName: string;
  contentType: string;
};

type BitableSourceParts = {
  appToken: string;
  tableId: string;
  viewId: string;
};

@Injectable()
export class AliMonthlyReportService {
  private readonly logger = new Logger(AliMonthlyReportService.name);
  private readonly pythonDependenciesReady = new Set<PythonDependencyProfile>();
  private readonly pythonDependenciesPromises = new Map<
    PythonDependencyProfile,
    Promise<void>
  >();
  private readonly bundleFourItemRequests = new Map<
    string,
    {
      expiresAt: number;
      requestFingerprint: string;
      promise: Promise<AliMonthlyReportGenerateResponse>;
    }
  >();
  private readonly activeBundleFourItemRequests = new Map<
    string,
    Promise<AliMonthlyReportGenerateResponse>
  >();

  constructor(private readonly httpService: HttpService) {}

  async getConfig(): Promise<AliMonthlyReportConfigResponse> {
    const runtime = this.getRuntimeConfig();
    const defaultPeriod = this.getPreviousYearMonth();
    const emailAppDir = this.resolveEmailAppDir();
    return {
      reportTypes: REPORT_TYPES,
      defaultYear: defaultPeriod.year,
      defaultMonth: defaultPeriod.month,
      outputDir: runtime.downloadFolder,
      outputDirLabel: runtime.outputDirLabel,
      defaultFeishuChatId: runtime.feishuChatId,
      defaultEmailRecipient: runtime.defaultEmailRecipient,
      emailReady: existsSync(join(emailAppDir, 'app.py')),
      emailAppDirLabel: this.getPathLabel(emailAppDir),
      toolReady: existsSync(RUNNER_PATH),
      templateReady: existsSync(runtime.values.ALI_ALARM_TEMPLATE_PATH),
      pythonCommand: this.getPythonCommand(),
      configPathReady: Boolean(runtime.configPath),
      missingConfigKeys: this.getMissingConfigKeys(runtime),
      missingAttachmentConfigKeys: this.getMissingAttachmentConfigKeys(runtime),
      missingEmailConfigKeys: this.getMissingEmailConfigKeys(runtime),
    };
  }

  async generate(
    payload: AliMonthlyReportGenerateRequest,
  ): Promise<AliMonthlyReportGenerateResponse> {
    const reportType = this.normalizeReportType(payload?.reportType);
    const year = this.normalizeYear(payload?.year);
    const month = this.normalizeMonth(payload?.month);
    const runtime = this.getRuntimeConfig();

    if (reportType !== 'four_item_bundle') {
      await this.ensurePythonDependencies(
        runtime,
        this.getPythonDependencyProfile(reportType),
      );
    }
    const response = await this.runReport(reportType, year, month, runtime);
    return this.attachFeishuNotification(runtime, response);
  }

  async generateForAutomation(
    reportTypeValue: AliMonthlyReportType,
    yearValue: number,
    monthValue: number,
  ): Promise<AliMonthlyReportGenerateResponse> {
    const reportType = this.normalizeReportType(reportTypeValue);
    if (!AUTOMATION_REPORT_TYPE_KEYS.has(reportType)) {
      throw new Error(`自动月报不支持该类型: ${reportType}`);
    }
    const year = this.normalizeYear(yearValue);
    const month = this.normalizeMonth(monthValue);
    const runtime = this.getRuntimeConfig();
    await this.ensurePythonDependencies(
      runtime,
      this.getPythonDependencyProfile(reportType),
    );
    return this.runReport(reportType, year, month, runtime);
  }

  async sendAutomationSummary(
    summary: AliMonthlyReportAutomationSummary,
  ): Promise<string> {
    const runtime = this.getRuntimeConfig();
    const chatId = runtime.automationFeishuChatId.trim();
    if (!chatId) {
      throw new Error('缺少阿里月报自动任务飞书群 chat_id');
    }
    const notificationFingerprint = summary.notificationFingerprint?.trim();
    if (!notificationFingerprint) {
      throw new Error('缺少阿里月报自动任务通知指纹');
    }
    const deliveryUuid = `amr-${createHash('sha256')
      .update(
        JSON.stringify([
          summary.year,
          summary.month,
          notificationFingerprint,
          chatId,
        ]),
      )
      .digest('hex')
      .slice(0, 46)}`;
    const startedAt = new Date(summary.startedAt);
    const finishedAt = new Date(summary.finishedAt);
    const durationMs = Math.max(
      0,
      finishedAt.getTime() - startedAt.getTime() || 0,
    );
    const scheduledAt = new Date(
      Date.UTC(summary.year, summary.month, 3, 9, 0, 0, 0) - 8 * 60 * 60 * 1000,
    );
    const card = buildAliMonthlyReportAutomationCard({
      year: summary.year,
      month: summary.month,
      scheduledAt: this.formatShanghaiDateTime(scheduledAt),
      durationMs,
      taskId: summary.taskId,
      items: summary.tasks.map((task) => {
        if (task.status === 'succeeded' && task.recordUrl) {
          return {
            type: task.reportType,
            status: 'success' as const,
            fileName: task.fileName || '月报文件',
            recordUrl: task.recordUrl,
          };
        }
        return {
          type: task.reportType,
          status: 'failed' as const,
          failureStage: '生成或上传',
          failureReason: task.error || '任务尚未完成',
        };
      }),
    });

    try {
      const token = await this.getTenantAccessToken(runtime);
      return await this.sendFeishuMessage(
        token,
        chatId,
        'interactive',
        JSON.stringify(card),
        deliveryUuid,
      );
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      throw new Error(this.maskSecrets(rawMessage, runtime.values));
    }
  }

  async bundleFourItems(
    payload: AliMonthlyReportBundleRequest,
  ): Promise<AliMonthlyReportGenerateResponse> {
    const year = this.normalizeYear(payload?.year);
    const month = this.normalizeMonth(payload?.month);
    const clientMutationId = this.normalizeClientMutationId(
      payload?.clientMutationId,
    );
    const now = Date.now();
    const requestFingerprint = JSON.stringify([
      year,
      month,
      payload?.sendFeishu !== false,
    ]);
    for (const [key, entry] of this.bundleFourItemRequests) {
      if (entry.expiresAt <= now) {
        this.bundleFourItemRequests.delete(key);
      }
    }
    const existing = this.bundleFourItemRequests.get(clientMutationId);
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint) {
        throw new Error('该一键打包请求标识已用于其他参数');
      }
      return existing.promise;
    }

    const promise = this.executeBundleFourItemsOnce(
      payload,
      year,
      month,
      clientMutationId,
      requestFingerprint,
    );
    this.bundleFourItemRequests.set(clientMutationId, {
      expiresAt: now + BUNDLE_REQUEST_CACHE_TTL_MS,
      requestFingerprint,
      promise,
    });
    void promise.catch(() => {
      const current = this.bundleFourItemRequests.get(clientMutationId);
      if (current?.promise === promise) {
        this.bundleFourItemRequests.delete(clientMutationId);
      }
    });
    return promise;
  }

  private executeBundleFourItemsOnce(
    payload: AliMonthlyReportBundleRequest,
    year: number,
    month: number,
    clientMutationId: string,
    requestFingerprint: string,
  ): Promise<AliMonthlyReportGenerateResponse> {
    const active = this.activeBundleFourItemRequests.get(requestFingerprint);
    if (active) {
      return active;
    }
    const promise = this.executeBundleFourItems(
      payload,
      year,
      month,
      clientMutationId,
    );
    this.activeBundleFourItemRequests.set(requestFingerprint, promise);
    void promise
      .finally(() => {
        if (
          this.activeBundleFourItemRequests.get(requestFingerprint) === promise
        ) {
          this.activeBundleFourItemRequests.delete(requestFingerprint);
        }
      })
      .catch(() => undefined);
    return promise;
  }

  private async executeBundleFourItems(
    payload: AliMonthlyReportBundleRequest,
    year: number,
    month: number,
    clientMutationId: string,
  ): Promise<AliMonthlyReportGenerateResponse> {
    const runtime = this.getRuntimeConfig();
    const response = await this.runFourItemBundle(year, month, runtime);

    if (payload?.sendFeishu === false) {
      return response;
    }
    return this.attachFeishuNotification(runtime, response, clientMutationId);
  }

  async sendEmail(
    payload: AliMonthlyReportEmailRequest,
  ): Promise<AliMonthlyReportEmailResponse> {
    const year = this.normalizeYear(payload?.year);
    const month = this.normalizeMonth(payload?.month);
    const subject = this.normalizeEmailSubject(payload?.subject, year, month);
    const recipient = this.normalizeRecipient(payload?.recipient);
    const runtime = this.getRuntimeConfig();
    const emailAppDir = this.resolveEmailAppDir();

    if (!existsSync(join(emailAppDir, 'app.py'))) {
      throw new Error(
        `阿里月报邮件发送逻辑不存在: ${this.getPathLabel(emailAppDir)}`,
      );
    }

    await this.ensurePythonDependencies(runtime, 'legacy');
    const { stdout, stderr } = await this.runPython(
      [
        '-c',
        EMAIL_BRIDGE_SCRIPT,
        recipient,
        String(year),
        String(month),
        subject,
      ],
      runtime.values,
      {
        cwd: emailAppDir,
        timeoutMs: EMAIL_TIMEOUT_MS,
        timeoutMessage: '阿里月报邮件发送超时',
      },
    );
    const result = this.parseRunnerResult(stdout) as RunnerResult & {
      success?: boolean;
      error?: string;
      subject?: string;
      recipient?: string;
      logs?: string[];
    };

    if (result.success === false) {
      throw new Error(result.error || '阿里月报邮件发送失败');
    }

    const logs = [
      ...(Array.isArray(result.logs) ? result.logs.map(String) : []),
      stderr.trim(),
    ].filter(Boolean);

    return {
      success: true,
      year,
      month,
      subject: String(result.subject || subject),
      recipient: String(result.recipient || recipient),
      message: result.message
        ? String(result.message)
        : `${year}年${month}月超功耗邮件已发送到：${recipient}`,
      logs: logs.length ? logs : ['阿里月报邮件发送完成'],
    };
  }

  async readGeneratedFile(
    fileId: string,
    maxSizeBytes?: number,
  ): Promise<GeneratedFileReadResult> {
    const filePath = await this.assertAllowedFile(this.decodeFileId(fileId));
    const fileStat = await stat(filePath);
    if (fileStat.size <= 0) {
      throw new Error('生成文件不能为空');
    }
    if (
      typeof maxSizeBytes === 'number' &&
      Number.isFinite(maxSizeBytes) &&
      fileStat.size > maxSizeBytes
    ) {
      throw new Error('四项月报 ZIP 文件超过飞书 30MB 上传上限');
    }
    return {
      buffer: await readFile(filePath),
      fileName: basename(filePath),
      contentType: this.getContentType(filePath),
    };
  }

  async readPublicGeneratedFile(
    fileId: string,
    expiresValue: unknown,
    signatureValue: unknown,
  ): Promise<GeneratedFileReadResult> {
    const runtime = this.getRuntimeConfig();
    const expires = Number(expiresValue);
    const signature = String(signatureValue || '').trim();
    let signingSecret: string;

    try {
      signingSecret = deriveAliMonthlyReportDownloadSigningSecret(
        runtime.downloadSigningRoot,
      );
    } catch {
      throw new Error('下载链接无效或已过期');
    }

    if (
      !verifyAliMonthlyReportDownload({
        fileId,
        expires,
        signature,
        signingSecret,
      })
    ) {
      throw new Error('下载链接无效或已过期');
    }

    const file = await this.readGeneratedFile(fileId);
    if (
      !LOCAL_FILE_ACTION_EXTENSIONS.has(extname(file.fileName).toLowerCase())
    ) {
      throw new Error('公开下载仅支持 XLSX、ZIP 文件');
    }
    return file;
  }

  async performGeneratedFileAction(
    fileId: string,
    action: AliMonthlyReportFileAction,
  ): Promise<AliMonthlyReportFileActionResponse> {
    const filePath = await this.assertAllowedFile(this.decodeFileId(fileId));
    if (!LOCAL_FILE_ACTION_EXTENSIONS.has(extname(filePath).toLowerCase())) {
      throw new Error('仅支持打开或定位 XLSX、ZIP 文件');
    }
    const { command, args } = buildAliMonthlyReportFileActionCommand(
      filePath,
      action,
    );
    await this.launchLocalFileAction(command, args);
    const fileName = basename(filePath);
    return {
      success: true,
      action,
      fileId,
      fileName,
      message:
        action === 'open'
          ? `已提交系统打开请求: ${fileName}`
          : `已提交资源管理器定位请求: ${fileName}`,
    };
  }

  private async runReport(
    reportType: AliMonthlyReportType,
    year: number,
    month: number,
    runtime: RuntimeConfig,
  ): Promise<AliMonthlyReportGenerateResponse> {
    if (reportType === 'over_power') {
      return this.runLegacyGeneratedReport(reportType, year, month, runtime);
    }
    if (reportType === 'four_item_bundle') {
      return this.runFourItemBundle(year, month, runtime);
    }

    if (!existsSync(RUNNER_PATH)) {
      throw new Error(`阿里月报生成逻辑不存在: ${RUNNER_PATH}`);
    }

    await mkdir(runtime.downloadFolder, { recursive: true });
    const args = [
      RUNNER_PATH,
      '--type',
      reportType,
      '--year',
      String(year),
      '--month',
      String(month),
    ];
    if (runtime.configPath) {
      args.push('--config', runtime.configPath);
    }

    const { stdout, stderr } = await this.runPython(args, runtime.values);
    const result = this.parseRunnerResult(stdout);
    const files = await this.normalizeGeneratedFiles(result.files || []);
    const logs = [
      ...this.buildLogs(result, stderr),
      ...this.buildBitableUploadLogs(result),
    ];

    return {
      success: true,
      reportType,
      year,
      month,
      action: result.action,
      message: result.message || '阿里月报生成完成',
      files,
      logs,
      bitableRecordUrls: this.collectBitableRecordUrls(result),
    };
  }

  private async runFourItemBundle(
    year: number,
    month: number,
    runtime: RuntimeConfig,
  ): Promise<AliMonthlyReportGenerateResponse> {
    if (!existsSync(FOUR_ITEM_BUNDLE_RUNNER_PATH)) {
      throw new Error(
        `阿里月报轻量打包逻辑不存在: ${this.getPathLabel(FOUR_ITEM_BUNDLE_RUNNER_PATH)}`,
      );
    }

    await mkdir(runtime.downloadFolder, { recursive: true });
    const { stdout, stderr } = await this.runPython(
      [
        FOUR_ITEM_BUNDLE_RUNNER_PATH,
        '--year',
        String(year),
        '--month',
        String(month),
      ],
      runtime.values,
      {
        cwd: TOOL_DIR,
        timeoutMs: FOUR_ITEM_BUNDLE_TIMEOUT_MS,
        timeoutMessage: '阿里月报四项资料打包超时',
        actionName: '阿里月报四项资料轻量打包',
      },
    );
    const bridgeResult = this.parseRunnerResult(stdout) as RunnerResult & {
      success?: boolean;
      error?: string;
      result?: RunnerResult;
      logs?: string[];
    };

    if (bridgeResult.success === false) {
      throw new Error(bridgeResult.error || '阿里月报四项资料打包失败');
    }

    const result = (bridgeResult.result || {}) as RunnerResult;
    const files = await this.normalizeGeneratedFiles(result.files || []);
    const sourceFiles = Array.isArray(result.source_files)
      ? (result.source_files as RunnerResult['files']) || []
      : [];
    const bundleItems = await this.normalizeGeneratedFiles(sourceFiles);
    const expectedCategories = ['超功率', 'TOP5', '告警分析', '人员变动'];
    const actualCategories = bundleItems.map((file) => file.category || '');
    if (
      files.length !== 1 ||
      extname(files[0]?.name || '').toLowerCase() !== '.zip' ||
      actualCategories.length !== expectedCategories.length ||
      actualCategories.some(
        (category, index) => category !== expectedCategories[index],
      )
    ) {
      throw new Error(
        `阿里月报四项资料校验失败：期望超功率、TOP5、告警分析、人员变动各 1 份，实际为 ${
          actualCategories.filter(Boolean).join('、') || '空'
        }`,
      );
    }
    const logs = [
      ...(Array.isArray(bridgeResult.logs)
        ? bridgeResult.logs.map(String)
        : []),
      stderr.trim(),
    ].filter(Boolean);

    return {
      success: true,
      reportType: 'four_item_bundle',
      year,
      month,
      action: result.action || 'four_item_bundle',
      message: result.message || '阿里月报四项资料打包完成',
      files,
      bundleItems,
      logs: logs.length ? logs : ['阿里月报四项资料打包完成'],
    };
  }

  private async runLegacyGeneratedReport(
    reportType: AliMonthlyReportType,
    year: number,
    month: number,
    runtime: RuntimeConfig,
  ): Promise<AliMonthlyReportGenerateResponse> {
    const emailAppDir = this.resolveEmailAppDir();
    if (!existsSync(join(emailAppDir, 'app.py'))) {
      throw new Error(
        `阿里月报上传逻辑不存在: ${this.getPathLabel(emailAppDir)}`,
      );
    }

    await mkdir(runtime.downloadFolder, { recursive: true });
    const { stdout, stderr } = await this.runPython(
      [
        '-c',
        LEGACY_GENERATE_BRIDGE_SCRIPT,
        reportType,
        String(year),
        String(month),
      ],
      runtime.values,
      {
        cwd: emailAppDir,
        timeoutMs: GENERATE_TIMEOUT_MS,
        timeoutMessage: '阿里月报生成并上传超时',
      },
    );
    const bridgeResult = this.parseRunnerResult(stdout) as RunnerResult & {
      success?: boolean;
      error?: string;
      result?: RunnerResult;
      logs?: string[];
    };

    if (bridgeResult.success === false) {
      throw new Error(bridgeResult.error || '阿里月报生成并上传失败');
    }

    const result = (bridgeResult.result || {}) as RunnerResult;
    const files = await this.normalizeGeneratedFiles(result.files || []);
    const logs = [
      ...(Array.isArray(bridgeResult.logs)
        ? bridgeResult.logs.map(String)
        : []),
      ...this.buildBitableUploadLogs(result),
      stderr.trim(),
    ].filter(Boolean);

    return {
      success: true,
      reportType,
      year,
      month,
      action: result.action,
      message: result.message || '阿里月报生成并上传完成',
      files,
      logs: logs.length ? logs : ['阿里月报生成并上传完成'],
      bitableRecordUrls: this.collectBitableRecordUrls(result),
    };
  }

  private collectBitableRecordUrls(result: RunnerResult): string[] {
    const urls: string[] = [];
    const seen = new Set<string>();
    const appendRecordUrl = (value: unknown): void => {
      if (!value || typeof value !== 'object') {
        return;
      }
      const rawUrl = (value as Record<string, unknown>).record_url;
      if (typeof rawUrl !== 'string') {
        return;
      }
      const normalizedUrl = rawUrl.trim();
      if (!normalizedUrl || seen.has(normalizedUrl)) {
        return;
      }
      try {
        const parsedUrl = new URL(normalizedUrl);
        if (
          parsedUrl.protocol !== 'https:' ||
          parsedUrl.username ||
          parsedUrl.password
        ) {
          return;
        }
      } catch {
        return;
      }
      seen.add(normalizedUrl);
      urls.push(normalizedUrl);
    };

    appendRecordUrl(result.uploaded);
    appendRecordUrl(result.updated);
    if (Array.isArray(result.updated_records)) {
      result.updated_records.forEach(appendRecordUrl);
    }
    return urls;
  }

  private buildBitableUploadLogs(result: RunnerResult): string[] {
    const logs: string[] = [];
    const recordUrls = this.collectBitableRecordUrls(result);
    if (recordUrls.length) {
      logs.push(`飞书多维表记录: ${recordUrls[0]}`);
    }
    const updatedRecords = Array.isArray(result.updated_records)
      ? result.updated_records
      : [];
    if (updatedRecords.length > 1) {
      logs.push(`已更新既有记录数: ${updatedRecords.length}`);
    }
    return logs;
  }

  private getPythonDependencyProfile(
    reportType: AliMonthlyReportType,
  ): PythonDependencyProfile {
    if (reportType === 'over_power') {
      return 'over_power';
    }
    return reportType === 'four_item_bundle' ? 'over_power' : 'core';
  }

  private async ensurePythonDependencies(
    runtime: RuntimeConfig,
    profile: PythonDependencyProfile,
  ): Promise<void> {
    if (this.pythonDependenciesReady.has(profile)) {
      return;
    }

    const existingPromise = this.pythonDependenciesPromises.get(profile);
    if (existingPromise) {
      return existingPromise;
    }

    const dependencyCheck = this.checkPythonDependencies(runtime, profile)
      .then(() => {
        this.pythonDependenciesReady.add(profile);
        if (profile === 'legacy') {
          this.pythonDependenciesReady.add('over_power');
          this.pythonDependenciesReady.add('core');
        } else if (profile === 'over_power') {
          this.pythonDependenciesReady.add('core');
        }
      })
      .catch((error: unknown) => {
        const profileLabel =
          profile === 'core'
            ? '核心'
            : profile === 'over_power'
              ? '超功耗'
              : '完整';
        const failureMessage =
          error instanceof Error ? error.message : String(error || '');
        const missingMatch = failureMessage.match(
          /(?:^|\r?\n)missing_or_broken=([^\r\n]+)/,
        );
        const failureDetail = missingMatch?.[1]
          ? `缺失或导入失败模块: ${missingMatch[1]
              .split(',')
              .map((item) => item.trim())
              .filter(Boolean)
              .join(', ')}`
          : failureMessage.includes('依赖预检超时')
            ? '依赖预检超时（上限 120 秒）'
            : '';
        const pythonCommand = this.getPythonCommand();
        this.logger.warn(
          `阿里月报${profileLabel} Python 依赖预检失败${failureDetail ? `: ${failureDetail}` : ''}`,
        );
        throw new Error(
          `阿里月报${profileLabel} Python 依赖未就绪。请在服务器执行 scripts/install-ali-monthly-report-python-deps.ps1 后重启服务并重试。${failureDetail ? ` ${failureDetail}。` : ''} 当前 Python: ${pythonCommand}。安装依赖时必须通过 -Python 参数使用同一个解释器。`,
        );
      })
      .finally(() => {
        this.pythonDependenciesPromises.delete(profile);
      });

    this.pythonDependenciesPromises.set(profile, dependencyCheck);
    return dependencyCheck;
  }

  private async checkPythonDependencies(
    runtime: RuntimeConfig,
    profile: PythonDependencyProfile,
  ): Promise<void> {
    const profileLabel =
      profile === 'core'
        ? '核心'
        : profile === 'over_power'
          ? '超功耗'
          : '完整';
    this.logger.log(`检查阿里月报${profileLabel} Python 依赖`);
    await this.runPython(
      [PYTHON_DEPENDENCY_PROBE_PATH, profile],
      runtime.values,
      {
        cwd: process.cwd(),
        timeoutMs: PYTHON_DEPS_CHECK_TIMEOUT_MS,
        timeoutMessage: `阿里月报${profileLabel} Python 依赖预检超时`,
        actionName: `阿里月报${profileLabel} Python 依赖预检`,
      },
    );
  }

  private runPython(
    args: string[],
    runtimeEnv: Record<string, string>,
    options: {
      cwd?: string;
      timeoutMs?: number;
      timeoutMessage?: string;
      actionName?: string;
    } = {},
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const pythonPath = this.buildPythonPath(runtimeEnv);
      const child = spawn(this.getPythonCommand(), args, {
        cwd: options.cwd || TOOL_DIR,
        env: {
          ...process.env,
          ...runtimeEnv,
          ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
          PYTHONIOENCODING: 'utf-8',
        },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(options.timeoutMessage || '阿里月报生成超时'));
      }, options.timeoutMs || GENERATE_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const safeStderr = this.maskSecrets(stderr, runtimeEnv);
        const safeStdout = this.maskSecrets(stdout, runtimeEnv);
        if (code !== 0) {
          const actionName = options.actionName || '阿里月报生成';
          this.logger.warn(`${actionName}失败，退出码 ${code}`);
          reject(
            new Error(
              safeStderr.trim() ||
                safeStdout.trim() ||
                `${actionName}失败，退出码 ${code}`,
            ),
          );
          return;
        }
        // 成功结果中的 Base app token 是可打开记录 URL 的组成部分。
        // 原始 stdout 仅在内存中解析，不写日志；错误路径仍使用脱敏文本。
        resolvePromise({ stdout, stderr: safeStderr });
      });
    });
  }

  private launchLocalFileAction(
    command: string,
    args: string[],
  ): Promise<void> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(command, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      let settled = false;
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once('spawn', () => {
        if (settled) return;
        settled = true;
        child.unref();
        resolvePromise();
      });
    });
  }

  private parseRunnerResult(stdout: string): RunnerResult {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start < 0 || end < start) {
      throw new Error('阿里月报生成结果不是有效 JSON');
    }
    try {
      return JSON.parse(stdout.slice(start, end + 1)) as RunnerResult;
    } catch (error) {
      throw new Error(
        `解析阿里月报生成结果失败: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async normalizeGeneratedFiles(
    files: NonNullable<RunnerResult['files']>,
  ): Promise<AliMonthlyReportFile[]> {
    const result: AliMonthlyReportFile[] = [];
    for (const file of files) {
      const rawPath = String(file.path || '').trim();
      if (!rawPath) continue;
      const requestedPath = resolve(rawPath);
      const filePath = await this.assertAllowedFile(requestedPath);
      const fileStat = await stat(filePath);
      const id = this.encodeFileId(requestedPath);
      result.push({
        id,
        name: String(file.name || basename(filePath)),
        size: file.size || this.formatSize(fileStat.size),
        downloadUrl: `/api/ali-monthly-report/files/${encodeURIComponent(id)}`,
        category: file.category,
      });
    }
    return result;
  }

  private buildLogs(result: RunnerResult, stderr: string): string[] {
    const logs = [
      result.message ? String(result.message) : '',
      stderr.trim(),
    ].filter(Boolean);
    return logs.length ? logs : ['阿里月报生成完成'];
  }

  private async attachFeishuNotification(
    runtime: RuntimeConfig,
    response: AliMonthlyReportGenerateResponse,
    clientMutationId = '',
  ): Promise<AliMonthlyReportGenerateResponse> {
    if (response.reportType === 'four_item_bundle') {
      return this.attachFeishuBundleFileNotification(
        runtime,
        response,
        clientMutationId,
      );
    }
    const chatId =
      typeof runtime.feishuChatId === 'string'
        ? runtime.feishuChatId.trim()
        : '';
    try {
      const configuredChatIds = Array.isArray(runtime.feishuChatIds)
        ? this.parseFeishuChatIds(runtime.feishuChatIds.join(','))
        : [];
      const chatIds = configuredChatIds.length
        ? configuredChatIds
        : this.parseFeishuChatIds(chatId);
      if (!chatIds.length) {
        throw new Error('缺少阿里月报飞书群 chat_id');
      }
      const reportTypeLabel = REPORT_TYPES.find(
        (item) => item.key === response.reportType,
      )?.name;
      if (!reportTypeLabel) {
        throw new Error(`缺少阿里月报类型名称: ${response.reportType}`);
      }
      const usesBitableRecordLinks =
        response.reportType === 'alarm_analysis' ||
        response.reportType === 'over_power' ||
        response.reportType === 'staff_roster';
      let messageType: 'text' | 'interactive';
      let messageContent: string;

      if (usesBitableRecordLinks) {
        const recordUrls = response.bitableRecordUrls || [];
        if (!recordUrls.length) {
          throw new Error(
            `${reportTypeLabel}未返回多维表记录链接，禁止回退发送服务器本地下载链接`,
          );
        }
        const generatedFileName =
          response.files[0]?.name || `${reportTypeLabel}记录`;
        messageType = 'interactive';
        messageContent = JSON.stringify(
          buildAliMonthlyReportManualSuccessCard({
            year: response.year,
            month: response.month,
            reportTypeLabel,
            fileName: generatedFileName,
            recordUrl: recordUrls[0],
            completedAt: this.formatShanghaiDateTime(new Date()),
          }),
        );
      } else {
        if (!response.files.length) {
          throw new Error('阿里月报未生成文件，无法发送飞书通知');
        }
        const signingSecret = deriveAliMonthlyReportDownloadSigningSecret(
          runtime.downloadSigningRoot,
        );
        const expires =
          Math.floor(Date.now() / 1_000) + DOWNLOAD_LINK_TTL_SECONDS;
        const notificationFiles = response.files.map((file) => ({
          name: file.name,
          url: buildAliMonthlyReportPublicDownloadUrl({
            publicBaseUrl: runtime.publicBaseUrl,
            fileId: file.id,
            expires,
            signingSecret,
          }),
        }));
        messageType = 'text';
        messageContent = JSON.stringify({
          text: buildAliMonthlyReportFeishuText({
            year: response.year,
            month: response.month,
            reportTypeLabel,
            files: notificationFiles,
          }),
        });
      }

      const token = await this.getTenantAccessToken(runtime);
      const settled = await Promise.allSettled(
        chatIds.map((targetChatId) =>
          this.sendFeishuMessage(
            token,
            targetChatId,
            messageType,
            messageContent,
          ),
        ),
      );
      const deliveries = settled.map((item, index) => {
        const targetChatId = chatIds[index];
        if (item.status === 'fulfilled') {
          return {
            chatId: targetChatId,
            sent: true,
            messageId: item.value,
          };
        }
        const rawError =
          item.reason instanceof Error
            ? item.reason.message
            : String(item.reason);
        return {
          chatId: targetChatId,
          sent: false,
          error: this.maskSecrets(rawError, runtime.values),
        };
      });
      const failedDeliveries = deliveries.filter((item) => !item.sent);
      const allSent = failedDeliveries.length === 0;
      const firstSuccess = deliveries.find((item) => item.sent);
      return {
        ...response,
        message: `${response.message}，${
          allSent
            ? `已通知 ${deliveries.length} 个飞书群`
            : `飞书群通知部分失败（${deliveries.length - failedDeliveries.length}/${deliveries.length}）`
        }`,
        logs: [
          ...response.logs,
          ...deliveries.map((item) =>
            item.sent
              ? `飞书群消息已发送: ${item.chatId}`
              : `飞书群消息发送失败: ${item.chatId} ${item.error}`,
          ),
        ],
        feishuMessage: {
          sent: allSent,
          chatId: chatIds[0],
          chatIds,
          messageId: firstSuccess?.messageId,
          error: failedDeliveries.length
            ? failedDeliveries
                .map((item) => `${item.chatId}: ${item.error}`)
                .join('；')
            : undefined,
          deliveries,
        },
      };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = this.maskSecrets(rawMessage, {
        ...runtime.values,
        ALI_MONTHLY_REPORT_DOWNLOAD_SIGNING_SECRET: runtime.downloadSigningRoot,
      });
      this.logger.warn(`阿里月报生成后发送飞书群消息失败: ${message}`);
      return {
        ...response,
        message: `${response.message}，飞书群消息发送失败`,
        logs: [...response.logs, `飞书群消息发送失败: ${message}`],
        feishuMessage: {
          sent: false,
          chatId,
          error: message,
        },
      };
    }
  }

  private async attachFeishuBundleFileNotification(
    runtime: RuntimeConfig,
    response: AliMonthlyReportGenerateResponse,
    clientMutationId: string,
  ): Promise<AliMonthlyReportGenerateResponse> {
    const chatIds = this.parseFeishuChatIds(
      Array.isArray(runtime.feishuChatIds)
        ? runtime.feishuChatIds.join(',')
        : runtime.feishuChatId,
    );
    const primaryChatId = chatIds[0] || runtime.feishuChatId || '';

    try {
      if (!chatIds.length) {
        throw new Error('缺少阿里月报飞书会话群 chat_id');
      }
      if (response.files.length !== 1) {
        throw new Error('四项月报必须且只能生成 1 个 ZIP 文件');
      }

      const bundleFile = response.files[0];
      const generatedFile = await this.readGeneratedFile(
        bundleFile.id,
        MAX_FEISHU_FILE_SIZE_BYTES,
      );
      if (extname(generatedFile.fileName).toLowerCase() !== '.zip') {
        throw new Error('四项月报生成结果不是 ZIP 文件');
      }
      if (generatedFile.buffer.length <= 0) {
        throw new Error('四项月报 ZIP 文件不能为空');
      }
      if (generatedFile.buffer.length > MAX_FEISHU_FILE_SIZE_BYTES) {
        throw new Error('四项月报 ZIP 文件超过飞书 30MB 上传上限');
      }

      const userOpenId = String(runtime.feishuUserOpenId || '').trim();
      const userEmail = String(runtime.feishuUserEmail || '').trim();
      const userName = String(runtime.feishuUserName || '马进宇').trim();
      let userTarget: FeishuBundleDeliveryTarget;
      if (userOpenId) {
        if (!/^ou_[A-Za-z0-9]+$/u.test(userOpenId)) {
          throw new Error('马进宇飞书 open_id 配置格式无效');
        }
        userTarget = {
          receiveId: userOpenId,
          receiveIdType: 'open_id',
          recipientType: 'user',
          recipientName: userName,
        };
      } else {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(userEmail)) {
          throw new Error('缺少有效的马进宇飞书邮箱或 open_id');
        }
        userTarget = {
          receiveId: userEmail,
          receiveIdType: 'email',
          recipientType: 'user',
          recipientName: userName,
        };
      }

      const targets: FeishuBundleDeliveryTarget[] = [
        ...chatIds.map((targetChatId, index) => ({
          receiveId: targetChatId,
          receiveIdType: 'chat_id' as const,
          recipientType: 'chat' as const,
          recipientName: `会话群${chatIds.length > 1 ? index + 1 : ''}`,
        })),
        userTarget,
      ];
      const token = await this.getTenantAccessToken(runtime);
      const fileKey = await this.uploadFeishuFile(
        token,
        generatedFile.buffer,
        generatedFile.fileName,
      );
      const deliveryKey = clientMutationId || bundleFile.id;
      const settled = await Promise.allSettled(
        targets.map((target) =>
          this.sendFeishuMessage(
            token,
            target.receiveId,
            'file',
            JSON.stringify({ file_key: fileKey }),
            this.buildBundleDeliveryUuid(deliveryKey, target),
            target.receiveIdType,
          ),
        ),
      );
      const deliveries = settled.map((item, index) => {
        const target = targets[index];
        if (item.status === 'fulfilled') {
          return {
            chatId: target.receiveId,
            recipientType: target.recipientType,
            recipientName: target.recipientName,
            sent: true,
            messageId: item.value,
          };
        }
        const rawError =
          item.reason instanceof Error
            ? item.reason.message
            : String(item.reason);
        return {
          chatId: target.receiveId,
          recipientType: target.recipientType,
          recipientName: target.recipientName,
          sent: false,
          error: this.maskSecrets(rawError, runtime.values),
        };
      });
      const failures = deliveries.filter((item) => !item.sent);
      const successes = deliveries.filter((item) => item.sent);
      const allSent = failures.length === 0;

      return {
        ...response,
        message: `${response.message}，${
          allSent
            ? `已发送 ${chatIds.length} 个会话群和马进宇`
            : `飞书文件部分发送失败（${successes.length}/${deliveries.length}）`
        }`,
        logs: [
          ...response.logs,
          ...deliveries.map((item) =>
            item.sent
              ? `飞书文件已发送: ${item.recipientName}`
              : `飞书文件发送失败: ${item.recipientName} ${item.error}`,
          ),
        ],
        feishuMessage: {
          sent: allSent,
          chatId: primaryChatId,
          chatIds,
          messageId: successes[0]?.messageId,
          error: failures.length
            ? failures
                .map((item) => `${item.recipientName}: ${item.error}`)
                .join('；')
            : undefined,
          deliveries,
        },
      };
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const message = this.maskSecrets(rawMessage, runtime.values);
      this.logger.warn(`阿里月报四项 ZIP 飞书文件发送失败: ${message}`);
      return {
        ...response,
        message: `${response.message}，飞书文件发送失败`,
        logs: [...response.logs, `飞书文件发送失败: ${message}`],
        feishuMessage: {
          sent: false,
          chatId: primaryChatId,
          chatIds,
          error: message,
        },
      };
    }
  }

  private async uploadFeishuFile(
    tenantAccessToken: string,
    fileBuffer: Buffer,
    fileName: string,
  ): Promise<string> {
    const form = new FormData();
    form.append('file_type', 'stream');
    form.append('file_name', fileName);
    form.append('file', fileBuffer, {
      filename: fileName,
      contentType: 'application/zip',
      knownLength: fileBuffer.length,
    });
    const response = await this.httpService.axiosRef.post(
      FEISHU_FILE_UPLOAD_URL,
      form,
      {
        headers: {
          Authorization: `Bearer ${tenantAccessToken}`,
          ...form.getHeaders(),
        },
        // 文件本体已在上传前限制为 30MB；multipart 边界会产生少量额外字节。
        maxBodyLength: Infinity,
        maxContentLength: MAX_FEISHU_FILE_SIZE_BYTES,
        timeout: 60_000,
      },
    );
    if (response.data?.code !== 0) {
      throw new Error(
        `上传飞书 ZIP 文件失败: ${response.data?.msg || response.data?.code}`,
      );
    }
    const fileKey = response.data?.data?.file_key;
    if (typeof fileKey !== 'string' || !fileKey.trim()) {
      throw new Error('上传飞书 ZIP 文件失败: 响应中缺少 file_key');
    }
    return fileKey.trim();
  }

  private buildBundleDeliveryUuid(
    deliveryKey: string,
    target: FeishuBundleDeliveryTarget,
  ): string {
    return `amrb-${createHash('sha256')
      .update(
        JSON.stringify([deliveryKey, target.receiveIdType, target.receiveId]),
      )
      .digest('hex')
      .slice(0, 45)}`;
  }

  private async getTenantAccessToken(runtime: RuntimeConfig): Promise<string> {
    const appId = runtime.values.FEISHU_APP_ID;
    const appSecret = runtime.values.FEISHU_APP_SECRET;
    if (!appId || !appSecret) {
      throw new Error(
        '缺少飞书开放平台配置：FEISHU_APP_ID / FEISHU_APP_SECRET',
      );
    }

    const response = await this.httpService.axiosRef.post(
      FEISHU_TOKEN_URL,
      {
        app_id: appId,
        app_secret: appSecret,
      },
      { timeout: 30000 },
    );

    if (response.data?.code !== 0) {
      throw new Error(
        `获取飞书 tenant_access_token 失败: ${
          response.data?.msg || response.data?.code
        }`,
      );
    }

    const token = response.data?.tenant_access_token;
    if (!token) {
      throw new Error('获取飞书 tenant_access_token 失败: 响应中缺少 token');
    }
    return token;
  }

  private async sendFeishuMessage(
    tenantAccessToken: string,
    receiveId: string,
    messageType: 'text' | 'interactive' | 'file',
    content: string,
    uuid?: string,
    receiveIdType: FeishuReceiveIdType = 'chat_id',
  ): Promise<string> {
    const response = await this.httpService.axiosRef.post(
      `${FEISHU_MESSAGE_URL}?receive_id_type=${receiveIdType}`,
      {
        receive_id: receiveId,
        msg_type: messageType,
        content,
        ...(uuid ? { uuid } : {}),
      },
      {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        timeout: 30000,
      },
    );

    if (response.data?.code !== 0) {
      throw new Error(
        `发送飞书消息失败: ${response.data?.msg || response.data?.code}`,
      );
    }

    const messageId = response.data?.data?.message_id;
    if (typeof messageId !== 'string' || !messageId.trim()) {
      throw new Error('发送飞书消息失败: 响应中缺少 message_id');
    }
    return messageId.trim();
  }

  private formatShanghaiDateTime(value: Date): string {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
      .format(value)
      .replaceAll('/', '-')
      .replace(',', '');
  }

  private normalizeReportType(value: unknown): AliMonthlyReportType {
    const reportType = String(value || '').trim() as AliMonthlyReportType;
    if (!RUNNER_REPORT_TYPE_KEYS.has(reportType)) {
      throw new Error('不支持的阿里月报类型');
    }
    return reportType;
  }

  private normalizeClientMutationId(value: unknown): string {
    const mutationId = String(value || '').trim();
    if (!mutationId) {
      throw new Error('一键打包请求标识不能为空');
    }
    if (
      mutationId.length < 8 ||
      mutationId.length > 100 ||
      !/^[A-Za-z0-9._:-]+$/u.test(mutationId)
    ) {
      throw new Error('一键打包请求标识格式无效');
    }
    return mutationId;
  }

  private normalizeYear(value: unknown): number {
    const year = Number(value);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new Error('年份不合法');
    }
    return year;
  }

  private normalizeMonth(value: unknown): number {
    const month = Number(value);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error('月份不合法');
    }
    return month;
  }

  private getPreviousYearMonth(): { year: number; month: number } {
    const now = new Date();
    const currentMonth = now.getMonth() + 1;
    if (currentMonth === 1) {
      return {
        year: now.getFullYear() - 1,
        month: 12,
      };
    }
    return {
      year: now.getFullYear(),
      month: currentMonth - 1,
    };
  }

  private getRuntimeConfig(): RuntimeConfig {
    const configPath = this.resolveConfigPath();
    const fileConfig = this.getConfigFileValues(configPath);
    const emailAppDir = this.resolveEmailAppDir();
    const emailFileConfig = this.getConfigFileValues(
      join(emailAppDir, 'config.json'),
    );
    const localEmailFileConfig =
      emailAppDir === LOCAL_EMAIL_APP_DIR
        ? {}
        : this.getConfigFileValues(join(LOCAL_EMAIL_APP_DIR, 'config.json'));
    const highPowerSource =
      readEnv('HIGH_POWER_SOURCE_URL') ||
      fileConfig.high_power_source_url ||
      DEFAULT_HIGH_POWER_SOURCE_URL;
    const alarmAttachmentSource =
      readEnv('ALI_ALARM_ATTACHMENT_SOURCE_URL') ||
      fileConfig.ali_alarm_attachment_source_url ||
      DEFAULT_ALARM_ATTACHMENT_SOURCE_URL;
    const highPowerParts = this.parseBitableSource(highPowerSource);
    const alarmAttachmentParts = this.parseBitableSource(alarmAttachmentSource);
    const configuredOutputDir = readEnv('ALI_MONTHLY_REPORT_OUTPUT_DIR', [
      'DOWNLOAD_FOLDER',
    ]);
    const configDownloadFolder = configuredOutputDir
      ? ''
      : this.resolveDownloadFolderValue(fileConfig.download_folder);
    const outputDir = resolve(
      configuredOutputDir || configDownloadFolder || DEFAULT_OUTPUT_DIR,
    );
    const downloadFolder = outputDir;
    const feishuAppSecret =
      readEnv('ALI_MONTHLY_REPORT_FEISHU_APP_SECRET', ['FEISHU_APP_SECRET']) ||
      fileConfig.feishu_app_secret ||
      emailFileConfig.feishu_app_secret ||
      localEmailFileConfig.feishu_app_secret;
    const configuredLegacyFeishuChatId = readEnv(
      'ALI_MONTHLY_REPORT_FEISHU_CHAT_ID',
      ['ALI_MONTHLY_REPORT_TARGET_CHAT_ID'],
    );
    const legacyFeishuChatId = configuredLegacyFeishuChatId
      ? this.parseFeishuChatIds(configuredLegacyFeishuChatId, true)[0]
      : DEFAULT_FEISHU_CHAT_ID;
    const configuredFeishuChatIdsValue = readEnv(
      'ALI_MONTHLY_REPORT_FEISHU_CHAT_IDS',
    );
    const configuredFeishuChatIds = this.parseFeishuChatIds(
      configuredFeishuChatIdsValue,
      Boolean(configuredFeishuChatIdsValue),
    );
    const feishuChatIds = configuredFeishuChatIds.length
      ? configuredFeishuChatIds
      : this.parseFeishuChatIds(
          `${legacyFeishuChatId},${DEFAULT_ADDITIONAL_FEISHU_CHAT_ID}`,
        );
    const configuredAutomationChatId = readEnv(
      'ALI_MONTHLY_REPORT_AUTOMATION_CHAT_ID',
    );
    const automationFeishuChatId = configuredAutomationChatId
      ? this.parseFeishuChatIds(configuredAutomationChatId, true)[0]
      : DEFAULT_ADDITIONAL_FEISHU_CHAT_ID;
    const feishuUserOpenId = readEnv(
      'ALI_MONTHLY_REPORT_FEISHU_MA_JINYU_OPEN_ID',
      ['ALI_MONTHLY_REPORT_FEISHU_USER_OPEN_ID'],
    );
    const feishuUserEmail =
      readEnv('ALI_MONTHLY_REPORT_FEISHU_MA_JINYU_EMAIL', [
        'ALI_MONTHLY_REPORT_FEISHU_USER_EMAIL',
      ]) || DEFAULT_FEISHU_USER_EMAIL;
    const configuredEmailRecipient = readEnv(
      'ALI_MONTHLY_REPORT_EMAIL_RECIPIENT',
      ['ALI_REPORT_EMAIL_RECIPIENT'],
    );
    const fileEmailRecipient =
      fileConfig.recipient ||
      emailFileConfig.recipient ||
      localEmailFileConfig.recipient;
    return {
      configPath,
      downloadFolder,
      outputDir,
      outputDirLabel: this.getOutputDirLabel(downloadFolder),
      feishuChatId: feishuChatIds[0] || legacyFeishuChatId,
      feishuChatIds,
      automationFeishuChatId,
      feishuUserOpenId,
      feishuUserEmail,
      feishuUserName:
        readEnv('ALI_MONTHLY_REPORT_FEISHU_MA_JINYU_NAME') || '马进宇',
      defaultEmailRecipient: this.mergeDefaultEmailRecipients(
        configuredEmailRecipient || fileEmailRecipient,
      ),
      publicBaseUrl: readEnv('ALI_MONTHLY_REPORT_PUBLIC_BASE_URL', [
        'PUBLIC_BASE_URL',
        'APP_PUBLIC_BASE_URL',
      ]),
      downloadSigningRoot:
        readEnv('ALI_MONTHLY_REPORT_DOWNLOAD_SIGNING_SECRET') ||
        feishuAppSecret,
      values: {
        DOWNLOAD_FOLDER: downloadFolder,
        FEISHU_APP_ID:
          readEnv('ALI_MONTHLY_REPORT_FEISHU_APP_ID', ['FEISHU_APP_ID']) ||
          fileConfig.feishu_app_id ||
          emailFileConfig.feishu_app_id ||
          localEmailFileConfig.feishu_app_id,
        FEISHU_APP_SECRET: feishuAppSecret,
        FEISHU_APP_TOKEN:
          readEnv('ALI_MONTHLY_REPORT_FEISHU_APP_TOKEN', [
            'FEISHU_APP_TOKEN',
          ]) ||
          fileConfig.feishu_app_token ||
          emailFileConfig.feishu_app_token ||
          localEmailFileConfig.feishu_app_token ||
          highPowerParts.appToken ||
          alarmAttachmentParts.appToken,
        ALI_ALARM_SOURCE_URL:
          readEnv('ALI_ALARM_SOURCE_URL') || fileConfig.ali_alarm_source_url,
        ALI_ALARM_ATTACHMENT_SOURCE_URL: alarmAttachmentSource,
        ALARM_REPORT_TABLE_ID:
          readEnv('ALARM_REPORT_TABLE_ID') ||
          fileConfig.alarm_report_table_id ||
          alarmAttachmentParts.tableId,
        ALARM_REPORT_VIEW_ID:
          readEnv('ALARM_REPORT_VIEW_ID') ||
          fileConfig.alarm_report_view_id ||
          alarmAttachmentParts.viewId,
        ALI_ALARM_TEMPLATE_PATH:
          readEnv('ALI_ALARM_TEMPLATE_PATH') ||
          fileConfig.ali_alarm_template_path ||
          DEFAULT_TEMPLATE_PATH,
        ALI_STAFF_SOURCE_URL:
          readEnv('ALI_STAFF_SOURCE_URL') || fileConfig.ali_staff_source_url,
        STAFF_REPORT_TABLE_ID:
          readEnv('STAFF_REPORT_TABLE_ID') ||
          fileConfig.staff_report_table_id ||
          DEFAULT_STAFF_REPORT_TABLE_ID,
        STAFF_REPORT_VIEW_ID:
          readEnv('STAFF_REPORT_VIEW_ID') ||
          fileConfig.staff_report_view_id ||
          DEFAULT_STAFF_REPORT_VIEW_ID,
        ALI_POWER_ALERT_CONFIG_PATH:
          readEnv('ALI_POWER_ALERT_CONFIG_PATH') ||
          fileConfig.ali_power_alert_config_path ||
          emailFileConfig.ali_power_alert_config_path ||
          localEmailFileConfig.ali_power_alert_config_path,
        HIGH_POWER_TABLE_ID:
          readEnv('HIGH_POWER_TABLE_ID') ||
          fileConfig.high_power_table_id ||
          highPowerParts.tableId,
        HIGH_POWER_VIEW_ID:
          readEnv('HIGH_POWER_VIEW_ID') ||
          fileConfig.high_power_view_id ||
          highPowerParts.viewId,
        HIGH_POWER_SOURCE_URL: highPowerSource,
        QQ_EMAIL:
          readEnv('ALI_MONTHLY_REPORT_QQ_EMAIL', ['QQ_EMAIL']) ||
          fileConfig.qq_email ||
          emailFileConfig.qq_email ||
          localEmailFileConfig.qq_email,
        AUTH_CODE:
          readEnv('ALI_MONTHLY_REPORT_QQ_AUTH_CODE', [
            'QQ_AUTH_CODE',
            'AUTH_CODE',
          ]) ||
          fileConfig.auth_code ||
          emailFileConfig.auth_code ||
          localEmailFileConfig.auth_code,
      },
    };
  }

  private resolveConfigPath(): string {
    const configured = readEnv('ALI_MONTHLY_REPORT_CONFIG', [
      'ALI_REPORT_CONFIG',
    ]);
    const candidate = configured
      ? resolve(configured)
      : join(TOOL_DIR, 'config.json');
    return existsSync(candidate) ? candidate : '';
  }

  private parseFeishuChatIds(value: unknown, rejectInvalid = false): string[] {
    const seen = new Set<string>();
    const parts = String(value || '')
      .split(/[\s,，;；]+/u)
      .map((item) => item.trim())
      .filter(Boolean);
    const invalidCount = parts.filter(
      (item) => !/^oc_[A-Za-z0-9]+$/u.test(item),
    ).length;
    if (rejectInvalid && invalidCount > 0) {
      throw new Error(`飞书群 chat_id 配置无效（${invalidCount} 项）`);
    }
    return parts
      .filter((item) => /^oc_[A-Za-z0-9]+$/u.test(item))
      .filter((item) => {
        if (seen.has(item)) return false;
        seen.add(item);
        return true;
      });
  }

  private getConfigFileValues(configPath: string): Record<string, string> {
    if (!configPath) return {};
    try {
      const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as Record<
        string,
        unknown
      >;
      return Object.fromEntries(
        Object.entries(parsed).map(([key, value]) => [
          key,
          String(value || '').trim(),
        ]),
      );
    } catch {
      return {};
    }
  }

  private getMissingConfigKeys(runtime: RuntimeConfig): string[] {
    return [
      ['FEISHU_APP_ID', runtime.values.FEISHU_APP_ID],
      ['FEISHU_APP_SECRET', runtime.values.FEISHU_APP_SECRET],
    ]
      .filter(([, value]) => !String(value || '').trim())
      .map(([key]) => key);
  }

  private getMissingAttachmentConfigKeys(runtime: RuntimeConfig): string[] {
    return [['FEISHU_APP_TOKEN', runtime.values.FEISHU_APP_TOKEN]]
      .filter(([, value]) => !String(value || '').trim())
      .map(([key]) => key);
  }

  private getMissingEmailConfigKeys(runtime: RuntimeConfig): string[] {
    return [
      ['FEISHU_APP_ID', runtime.values.FEISHU_APP_ID],
      ['FEISHU_APP_SECRET', runtime.values.FEISHU_APP_SECRET],
      ['FEISHU_APP_TOKEN', runtime.values.FEISHU_APP_TOKEN],
      ['ALI_MONTHLY_REPORT_QQ_EMAIL / QQ_EMAIL', runtime.values.QQ_EMAIL],
      ['ALI_MONTHLY_REPORT_QQ_AUTH_CODE / AUTH_CODE', runtime.values.AUTH_CODE],
    ]
      .filter(([, value]) => !String(value || '').trim())
      .map(([key]) => key);
  }

  private resolveDownloadFolderValue(value: unknown): string {
    const text = String(value || '').trim();
    if (!text) return '';
    return resolve(isAbsolute(text) ? text : join(TOOL_DIR, text));
  }

  private getOutputDirLabel(downloadFolder: string): string {
    const configuredLabel = readEnv('ALI_MONTHLY_REPORT_OUTPUT_LABEL');
    if (configuredLabel) return configuredLabel;
    return this.getPathLabel(downloadFolder);
  }

  private getPathLabel(pathValue: string): string {
    const relativePath = relative(process.cwd(), pathValue);
    if (
      relativePath &&
      !relativePath.startsWith('..') &&
      !isAbsolute(relativePath)
    ) {
      return relativePath.replace(/\\/g, '/');
    }
    return pathValue;
  }

  private resolveEmailAppDir(): string {
    const configured = readEnv('ALI_MONTHLY_REPORT_EMAIL_APP_DIR', [
      'ALI_MONTHLY_REPORT_LEGACY_APP_DIR',
    ]);
    if (configured) {
      return resolve(configured);
    }
    if (existsSync(join(DEFAULT_EMAIL_APP_DIR, 'app.py'))) {
      return DEFAULT_EMAIL_APP_DIR;
    }
    if (existsSync(join(LOCAL_EMAIL_APP_DIR, 'app.py'))) {
      return LOCAL_EMAIL_APP_DIR;
    }
    return DEFAULT_EMAIL_APP_DIR;
  }

  private parseBitableSource(value: string): BitableSourceParts {
    try {
      const url = new URL(value);
      const segments = url.pathname.split('/').filter(Boolean);
      const baseIndex = segments.indexOf('base');
      return {
        appToken: baseIndex >= 0 ? segments[baseIndex + 1] || '' : '',
        tableId: url.searchParams.get('table') || '',
        viewId: url.searchParams.get('view') || '',
      };
    } catch {
      return {
        appToken: '',
        tableId: '',
        viewId: '',
      };
    }
  }

  private getPythonCommand(): string {
    const configured = readEnv('ALI_MONTHLY_REPORT_PYTHON', ['PYTHON']);
    if (!configured) {
      return 'python';
    }
    if (isAbsolute(configured) || !/[\\/]/.test(configured)) {
      return configured;
    }
    return resolve(process.cwd(), configured);
  }

  private getBundledPythonPackagesDir(): string {
    return BUNDLED_PYTHON_PACKAGES_DIR;
  }

  private buildPythonPath(runtimeEnv: Record<string, string>): string {
    const existingValue = String(
      runtimeEnv.PYTHONPATH || process.env.PYTHONPATH || '',
    ).trim();
    const bundledPackagesDir = this.getBundledPythonPackagesDir();
    if (!existsSync(bundledPackagesDir)) {
      return existingValue;
    }

    const entries = [
      bundledPackagesDir,
      ...existingValue
        .split(delimiter)
        .map((item) => item.trim())
        .filter(Boolean),
    ];
    const seen = new Set<string>();
    return entries
      .filter((entry) => {
        const key =
          process.platform === 'win32' ? entry.toLowerCase() : entry;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join(delimiter);
  }

  private mergeDefaultEmailRecipients(value: string): string {
    return this.filterVisibleOnlyEmailRecipient(
      `${value || ''};${DEFAULT_EMAIL_RECIPIENT}`,
    );
  }

  private filterVisibleOnlyEmailRecipient(value: string): string {
    const recipients = String(value || '')
      .split(/[;,，；\s]+/)
      .map((item) => item.trim())
      .filter(Boolean);
    const seen = new Set<string>();
    return recipients
      .filter((recipient) => {
        const key = recipient.toLowerCase();
        if (key === VISIBLE_ONLY_EMAIL_RECIPIENT) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .join('; ');
  }

  private normalizeEmailSubject(
    value: unknown,
    year: number,
    month: number,
  ): string {
    const subject = String(value || '').trim();
    return subject || `机柜容量及列头柜容量超电风险【${year}年${month}月】`;
  }

  private normalizeRecipient(value: unknown): string {
    const recipient = this.filterVisibleOnlyEmailRecipient(String(value || ''));
    if (!recipient) {
      throw new Error('收件人邮箱不能为空');
    }
    return recipient;
  }

  private async assertAllowedFile(filePath: string): Promise<string> {
    let resolvedFilePath: string;
    try {
      resolvedFilePath = await realpath(resolve(filePath));
    } catch {
      throw new Error('生成文件不存在或已被移动');
    }

    const allowedRoots = (
      await Promise.all(
        this.getAllowedDownloadRoots().map(async (root) => {
          try {
            return await realpath(root);
          } catch {
            return null;
          }
        }),
      )
    ).filter((root): root is string => Boolean(root));
    const allowed = allowedRoots.some((root) => {
      const relativePath = relative(root, resolvedFilePath);
      return (
        relativePath &&
        !relativePath.startsWith('..') &&
        !isAbsolute(relativePath)
      );
    });
    if (!allowed) {
      throw new Error('文件不在阿里月报输出目录内');
    }
    const fileStat = await stat(resolvedFilePath);
    if (!fileStat.isFile()) {
      throw new Error('下载目标不是文件');
    }
    return resolvedFilePath;
  }

  private getAllowedDownloadRoots(): string[] {
    const runtime = this.getRuntimeConfig();
    return Array.from(
      new Set([
        resolve(runtime.downloadFolder),
        resolve(runtime.outputDir),
        resolve(DEFAULT_OUTPUT_DIR),
      ]),
    );
  }

  private encodeFileId(filePath: string): string {
    const root = this.getAllowedDownloadRoots().find((item) => {
      const relativePath = relative(item, filePath);
      return (
        relativePath &&
        !relativePath.startsWith('..') &&
        !isAbsolute(relativePath)
      );
    });
    if (!root) {
      throw new Error('文件不在阿里月报输出目录内');
    }
    return Buffer.from(relative(root, filePath), 'utf8').toString('base64url');
  }

  private decodeFileId(fileId: string): string {
    const relativePath = Buffer.from(fileId, 'base64url').toString('utf8');
    if (
      !relativePath ||
      relativePath.startsWith('..') ||
      isAbsolute(relativePath)
    ) {
      throw new Error('下载文件标识不合法');
    }
    return resolve(this.getRuntimeConfig().downloadFolder, relativePath);
  }

  private getContentType(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    if (ext === '.xlsx') {
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    }
    if (ext === '.zip') {
      return 'application/zip';
    }
    return 'application/octet-stream';
  }

  private formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) {
      return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
    }
    return `${(bytes / 1024).toFixed(1)}KB`;
  }

  private maskSecrets(
    text: string,
    runtimeEnv: Record<string, string>,
  ): string {
    let result = text;
    for (const key of [
      'FEISHU_APP_SECRET',
      'FEISHU_APP_TOKEN',
      'AUTH_CODE',
      'ALI_MONTHLY_REPORT_DOWNLOAD_SIGNING_SECRET',
    ]) {
      const value = runtimeEnv[key];
      if (value && value.length >= 6) {
        result = result.split(value).join('***');
      }
    }
    return result;
  }
}
