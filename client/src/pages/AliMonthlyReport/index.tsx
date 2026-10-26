import React, { useEffect, useMemo, useRef, useState } from 'react';
import { logger } from '@lark-apaas/client-toolkit/logger';
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  Download,
  ExternalLink,
  FileSpreadsheet,
  FolderOpen,
  Loader2,
  Mail,
  RefreshCw,
  Settings,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  bundleAliMonthlyReportFiles,
  generateAliMonthlyReport,
  getAliMonthlyReportConfig,
  openAliMonthlyReportFile,
  revealAliMonthlyReportFile,
  sendAliMonthlyReportEmail,
} from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import type {
  AliMonthlyReportConfigResponse,
  AliMonthlyReportEmailResponse,
  AliMonthlyReportFile,
  AliMonthlyReportGenerateResponse,
  AliMonthlyReportType,
} from '@shared/api.interface';

import { scrollGeneratedFilesIntoView } from './result-navigation';

type TaskState = 'idle' | 'running' | 'done' | 'warning';

const selectClassName =
  'h-12 w-full rounded-lg border border-slate-200 bg-white px-3 text-base text-slate-900 outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-50';
const inputClassName =
  'h-12 w-full rounded-lg border border-slate-200 bg-white px-3 text-base text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:bg-slate-50';

const currentYear = new Date().getFullYear();
const fallbackConfig: AliMonthlyReportConfigResponse = {
  reportTypes: [
    {
      key: 'alarm_analysis',
      name: '月度告警分析',
      description: '从告警源多维表生成 EA118 月度告警分析 Excel。',
    },
  ],
  defaultYear: currentYear,
  defaultMonth: new Date().getMonth() + 1,
  outputDir: '',
  outputDirLabel: '',
  defaultFeishuChatId: '',
  defaultEmailRecipient: '',
  emailReady: false,
  emailAppDirLabel: '',
  toolReady: false,
  templateReady: false,
  pythonCommand: 'python',
  configPathReady: false,
  missingConfigKeys: [],
  missingAttachmentConfigKeys: [],
  missingEmailConfigKeys: [],
};

function getErrorMessage(error: unknown): string {
  const maybeError = error as {
    response?: { data?: { message?: string | string[] } };
    message?: string;
  };
  const message = maybeError?.response?.data?.message || maybeError?.message;
  if (Array.isArray(message)) return message.join('；');
  return message || '阿里月报生成失败';
}

type FeishuDeliveryPresentation = {
  chatId?: string;
  targetId?: string;
  sent: boolean;
  recipientType?: 'chat' | 'user';
  targetType?: 'chat' | 'user';
  recipientName?: string;
  targetName?: string;
};

function getFeishuDeliveryLabel(delivery: FeishuDeliveryPresentation): string {
  const recipientType = delivery.recipientType ?? delivery.targetType;
  const recipientName = delivery.recipientName ?? delivery.targetName;
  const recipientId = delivery.chatId ?? delivery.targetId ?? '';

  if (recipientType === 'user') {
    return recipientName || '示例人员020';
  }
  if (recipientType === 'chat') {
    return recipientName || `会话群 ${recipientId}`;
  }
  return recipientName || recipientId;
}

function createClientMutationId(): string {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }
  return `ali-monthly-bundle-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}`;
}

function getFeishuNotificationPresentation(
  message: NonNullable<AliMonthlyReportGenerateResponse['feishuMessage']>,
): { title: string; description: string } {
  const targetChatIds = message.chatIds?.join('、') || message.chatId;
  const deliveredChatIds =
    message.deliveries
      ?.filter((delivery) => delivery.sent)
      .map((delivery) => delivery.chatId)
      .join('、') || '';
  const deliveries = message.deliveries as
    | FeishuDeliveryPresentation[]
    | undefined;
  const targetLabels =
    deliveries?.map(getFeishuDeliveryLabel).filter(Boolean).join('、') ||
    `会话群 ${targetChatIds}`;
  const deliveredLabels =
    deliveries
      ?.filter((delivery) => delivery.sent)
      .map(getFeishuDeliveryLabel)
      .filter(Boolean)
      .join('、') || `会话群 ${deliveredChatIds}`;
  const partiallySent = Boolean(
    !message.sent && message.deliveries?.some((delivery) => delivery.sent),
  );

  if (message.sent) {
    return {
      title: '飞书通知已发送',
      description: `已发送到 ${targetLabels}`,
    };
  }
  if (partiallySent) {
    return {
      title: '飞书通知部分失败',
      description: `已发送到 ${deliveredLabels}；${
        message.error || '其余接收方发送失败，请检查飞书应用配置'
      }`,
    };
  }
  return {
    title: '飞书通知失败',
    description: message.error || '请检查飞书应用配置',
  };
}

function taskBadge(state: TaskState): { text: string; className: string } {
  if (state === 'running') {
    return {
      text: '执行中',
      className: 'border-blue-200 bg-blue-50 text-blue-700',
    };
  }
  if (state === 'done') {
    return {
      text: '已完成',
      className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    };
  }
  if (state === 'warning') {
    return {
      text: '待配置',
      className: 'border-amber-200 bg-amber-50 text-amber-700',
    };
  }
  return {
    text: '待执行',
    className: 'border-slate-200 bg-slate-50 text-slate-600',
  };
}

function TaskRow({
  icon: Icon,
  title,
  state,
}: {
  icon: React.ElementType;
  title: string;
  state: TaskState;
}) {
  const badge = taskBadge(state);
  return (
    <div className="flex items-center gap-4 py-4">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-blue-50 text-blue-600">
        <Icon className="h-5 w-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-base font-semibold text-slate-900">
          {title}
        </div>
      </div>
      <Badge className={`rounded-md border px-3 py-1 ${badge.className}`}>
        {badge.text}
      </Badge>
    </div>
  );
}

export default function AliMonthlyReportPage() {
  const [config, setConfig] =
    useState<AliMonthlyReportConfigResponse>(fallbackConfig);
  const [configLoading, setConfigLoading] = useState(true);
  const [reportType, setReportType] =
    useState<AliMonthlyReportType>('alarm_analysis');
  const [year, setYear] = useState(currentYear);
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [periodMode, setPeriodMode] = useState('month');
  const [forceNewRecord, setForceNewRecord] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [bundling, setBundling] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [emailRecipient, setEmailRecipient] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailResult, setEmailResult] =
    useState<AliMonthlyReportEmailResponse | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [result, setResult] = useState<AliMonthlyReportGenerateResponse | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [fileActionKey, setFileActionKey] = useState<string | null>(null);
  const fileActionInFlightRef = useRef<string | null>(null);
  const bundleInFlightRef = useRef(false);
  const bundleMutationRef = useRef<{ period: string; id: string } | null>(null);
  const resultCardRef = useRef<HTMLDivElement | null>(null);
  const resultScrollFrameRef = useRef<number | null>(null);
  const busy = generating || bundling || sendingEmail;

  const revealGeneratedFiles = () => {
    const target = resultCardRef.current;
    const prefersReducedMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (resultScrollFrameRef.current !== null) {
      window.cancelAnimationFrame(resultScrollFrameRef.current);
      resultScrollFrameRef.current = null;
    }

    resultScrollFrameRef.current = scrollGeneratedFilesIntoView(
      target,
      prefersReducedMotion,
      (callback) =>
        window.requestAnimationFrame(() => {
          resultScrollFrameRef.current = null;
          if (resultCardRef.current === target) {
            callback();
          }
        }),
    );
  };

  const selectedReportType = useMemo(
    () => config.reportTypes.find((item) => item.key === reportType),
    [config.reportTypes, reportType],
  );

  const yearOptions = useMemo(() => {
    const base = config.defaultYear || currentYear;
    return [base - 1, base, base + 1, base + 2];
  }, [config.defaultYear]);

  const defaultEmailSubject = useMemo(
    () => `机柜容量及列头柜容量超电风险【${year}年${month}月】`,
    [year, month],
  );

  const taskState = useMemo<TaskState>(() => {
    if (busy) return 'running';
    if (error) return 'warning';
    if (result) return 'done';
    if (!config.toolReady || config.missingConfigKeys.length > 0) {
      return 'warning';
    }
    return 'idle';
  }, [busy, config.missingConfigKeys.length, config.toolReady, error, result]);

  const fileState = result?.files.length ? 'done' : 'idle';
  const feishuState = result?.feishuMessage
    ? result.feishuMessage.sent
      ? 'done'
      : 'warning'
    : 'idle';
  const feishuPresentation = result?.feishuMessage
    ? getFeishuNotificationPresentation(result.feishuMessage)
    : null;
  const emailState: TaskState = sendingEmail
    ? 'running'
    : emailResult
      ? 'done'
      : config.emailReady === false
        ? 'warning'
        : 'idle';
  const attachmentMissingConfigKeys = config.missingAttachmentConfigKeys || [];
  const selectedReportNeedsAttachmentToken =
    reportType === 'alarm_analysis' ||
    reportType === 'over_power' ||
    reportType === 'high_power_top5';
  const displayLogs = emailResult?.logs.length
    ? emailResult.logs
    : result?.logs.length
      ? result.logs
      : ['系统就绪'];

  const loadConfig = async () => {
    setConfigLoading(true);
    try {
      const data = await getAliMonthlyReportConfig();
      setConfig(data);
      setYear(data.defaultYear);
      setMonth(data.defaultMonth);
      setEmailRecipient(data.defaultEmailRecipient || '');
      if (data.reportTypes[0]) {
        setReportType(data.reportTypes[0].key);
      }
    } catch (err) {
      logger.error('加载阿里月报配置失败', err);
      setError('阿里月报配置加载失败');
    } finally {
      setConfigLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadConfig();
    }, 200);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    return () => {
      if (resultScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(resultScrollFrameRef.current);
        resultScrollFrameRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    setEmailSubject(defaultEmailSubject);
  }, [defaultEmailSubject]);

  const handleGenerate = async () => {
    setGenerating(true);
    setError(null);
    setResult(null);
    setEmailResult(null);
    setEmailError(null);
    try {
      const data = await generateAliMonthlyReport({
        reportType,
        year,
        month,
      });
      setResult(data);
      revealGeneratedFiles();
      if (data.feishuMessage && !data.feishuMessage.sent) {
        toast.warning(data.message || '阿里月报已生成，飞书通知未发送成功');
      } else {
        toast.success(data.message || '阿里月报生成完成');
      }
    } catch (err) {
      const message = getErrorMessage(err);
      logger.error('阿里月报生成失败', err);
      setError(message);
      toast.error(message);
    } finally {
      setGenerating(false);
    }
  };

  const handleBundleFourItems = async () => {
    if (bundleInFlightRef.current) {
      return;
    }
    bundleInFlightRef.current = true;
    setBundling(true);
    setError(null);
    setEmailResult(null);
    setEmailError(null);
    try {
      const requestPeriod = `${year}-${String(month).padStart(2, '0')}`;
      const clientMutationId =
        bundleMutationRef.current?.period === requestPeriod &&
        bundleMutationRef.current?.id
          ? bundleMutationRef.current.id
          : createClientMutationId();
      bundleMutationRef.current = {
        period: requestPeriod,
        id: clientMutationId,
      };
      const bundleRequest = {
        year,
        month,
        sendFeishu: true,
        clientMutationId,
      };
      const data = await bundleAliMonthlyReportFiles(bundleRequest);
      bundleMutationRef.current = null;
      setResult(data);
      revealGeneratedFiles();
      if (data.feishuMessage?.sent) {
        toast.success('四项文件已打包并已发送会话群和示例人员020');
      } else {
        toast.warning(data.message || '四项文件已打包，飞书通知未发送成功');
      }
    } catch (err) {
      const message = getErrorMessage(err);
      logger.error('阿里月报四项文件打包失败', err);
      setError(message);
      toast.error(message);
    } finally {
      bundleInFlightRef.current = false;
      setBundling(false);
    }
  };

  const handleSendEmail = async () => {
    setSendingEmail(true);
    setEmailError(null);
    setEmailResult(null);
    try {
      const data = await sendAliMonthlyReportEmail({
        year,
        month,
        subject: emailSubject || defaultEmailSubject,
        recipient: emailRecipient,
      });
      setEmailResult(data);
      toast.success(data.message || '阿里月报邮件已发送');
    } catch (err) {
      const message = getErrorMessage(err).replace(
        '阿里月报生成失败',
        '阿里月报邮件发送失败',
      );
      logger.error('阿里月报邮件发送失败', err);
      setEmailError(message);
      toast.error(message);
    } finally {
      setSendingEmail(false);
    }
  };

  const handleFileAction = async (
    file: AliMonthlyReportFile,
    action: 'open' | 'reveal',
  ) => {
    if (fileActionInFlightRef.current) return;

    const actionKey = `${action}:${file.id}`;
    const actionLabel = action === 'open' ? '打开文件' : '定位文件';
    const actionRequest =
      action === 'open' ? openAliMonthlyReportFile : revealAliMonthlyReportFile;
    fileActionInFlightRef.current = actionKey;
    setFileActionKey(actionKey);
    toast.info(`${actionLabel}请求已发出`);

    try {
      const data = await actionRequest(file.id);
      toast.success(data.message || `${actionLabel}: ${file.name}`);
    } catch (err) {
      const message = getErrorMessage(err).replace(
        '阿里月报生成失败',
        `${actionLabel}失败`,
      );
      logger.error(`${actionLabel}失败`, err);
      toast.error(message);
    } finally {
      if (fileActionInFlightRef.current === actionKey) {
        fileActionInFlightRef.current = null;
      }
      setFileActionKey((current) => (current === actionKey ? null : current));
    }
  };

  return (
    <div className="min-h-[calc(100dvh-var(--global-navigation-height,0px))] bg-slate-50">
      <div
        className="text-white"
        style={{
          background:
            'linear-gradient(135deg, hsl(217, 91%, 50%) 0%, hsl(204, 86%, 56%) 100%)',
        }}
      >
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-6 lg:px-6">
          <div>
            <h1 className="text-2xl font-semibold tracking-normal md:text-3xl">
              阿里月度报告生成
            </h1>
            <p className="mt-2 text-sm text-blue-100">
              Alibaba Monthly Report Generator
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            className="border-white/40 bg-white/10 text-white hover:bg-white/20 hover:text-white"
            onClick={() => void loadConfig()}
            disabled={configLoading}
          >
            {configLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Settings className="h-4 w-4" />
            )}
            配置
          </Button>
        </div>
      </div>

      <div className="mx-auto grid max-w-7xl gap-6 px-4 py-6 lg:grid-cols-[24rem_1fr] lg:px-6">
        <Card className="rounded-lg border-slate-200 bg-white shadow-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl tracking-normal text-blue-700">
              <FileSpreadsheet className="h-5 w-5" />
              任务面板
            </CardTitle>
            <CardDescription>
              目标月份：{year}年{month}月
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="divide-y divide-slate-100">
              <TaskRow
                icon={FileSpreadsheet}
                title="月报生成"
                state={taskState}
              />
              <TaskRow icon={Download} title="文件下载" state={fileState} />
              <TaskRow icon={Mail} title="邮件发送" state={emailState} />
              <TaskRow icon={Mail} title="飞书通知" state={feishuState} />
            </div>
            <div className="mt-6 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
              <div className="font-medium text-slate-900">输出目录</div>
              <div className="mt-1 break-all">
                {config.outputDirLabel || config.outputDir || '未配置'}
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card className="rounded-lg border-slate-200 bg-white shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-4 text-xl tracking-normal text-slate-950">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-base font-semibold text-white shadow-md shadow-blue-200">
                  01
                </span>
                阿里月报生成
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {error ? (
                <Alert className="border-rose-200 bg-rose-50 text-rose-900">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>生成失败</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : null}

              {!config.toolReady ? (
                <Alert className="border-amber-200 bg-amber-50 text-amber-900">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>生成逻辑未就绪</AlertTitle>
                  <AlertDescription>
                    未找到 `tools/ali-monthly-report/monthly_report_runner.py`
                  </AlertDescription>
                </Alert>
              ) : null}

              {config.missingConfigKeys.length > 0 ? (
                <Alert className="border-amber-200 bg-amber-50 text-amber-900">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>缺少配置</AlertTitle>
                  <AlertDescription>
                    {config.missingConfigKeys.join('、')}
                  </AlertDescription>
                </Alert>
              ) : null}

              {selectedReportNeedsAttachmentToken &&
              attachmentMissingConfigKeys.length > 0 ? (
                <Alert className="border-amber-200 bg-amber-50 text-amber-900">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>资料管理附件配置缺失</AlertTitle>
                  <AlertDescription>
                    {attachmentMissingConfigKeys.join('、')}
                  </AlertDescription>
                </Alert>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <label className="space-y-2">
                  <span className="text-sm font-semibold text-slate-900">
                    月报类型
                  </span>
                  <select
                    className={selectClassName}
                    value={reportType}
                    onChange={(event) =>
                      setReportType(event.target.value as AliMonthlyReportType)
                    }
                    disabled={busy}
                  >
                    {config.reportTypes.map((item) => (
                      <option key={item.key} value={item.key}>
                        {item.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-semibold text-slate-900">
                    选择年份
                  </span>
                  <select
                    className={selectClassName}
                    value={year}
                    onChange={(event) => setYear(Number(event.target.value))}
                    disabled={busy}
                  >
                    {yearOptions.map((item) => (
                      <option key={item} value={item}>
                        {item}年
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-semibold text-slate-900">
                    选择月份
                  </span>
                  <select
                    className={selectClassName}
                    value={month}
                    onChange={(event) => setMonth(Number(event.target.value))}
                    disabled={busy}
                  >
                    {Array.from({ length: 12 }, (_, index) => index + 1).map(
                      (item) => (
                        <option key={item} value={item}>
                          {item}月
                        </option>
                      ),
                    )}
                  </select>
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-semibold text-slate-900">
                    选择日期
                  </span>
                  <select
                    className={selectClassName}
                    value={periodMode}
                    onChange={(event) => setPeriodMode(event.target.value)}
                    disabled={busy}
                  >
                    <option value="month">月度</option>
                  </select>
                </label>
              </div>

              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <label className="flex items-center gap-3 text-sm text-slate-600">
                  <Checkbox
                    checked={forceNewRecord}
                    onCheckedChange={(checked) =>
                      setForceNewRecord(checked === true)
                    }
                    disabled
                  />
                  同年月已存在时仍新增记录
                </label>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Button
                    type="button"
                    variant="outline"
                    className="h-12 min-w-48 border-blue-200 bg-white text-base font-semibold text-blue-700 hover:bg-blue-50 hover:text-blue-800"
                    disabled={busy || !config.toolReady}
                    onClick={handleBundleFourItems}
                  >
                    {bundling ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Archive className="h-4 w-4" />
                    )}
                    {bundling ? '正在下载并打包4项文件' : '一键打包4项文件'}
                  </Button>
                  <Button
                    type="button"
                    className="h-12 min-w-48 bg-blue-600 text-base font-semibold text-white hover:bg-blue-700"
                    disabled={busy || !config.toolReady}
                    onClick={handleGenerate}
                  >
                    {generating ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FileSpreadsheet className="h-4 w-4" />
                    )}
                    生成月报
                  </Button>
                </div>
              </div>

              {selectedReportType ? (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800">
                  {selectedReportType.description}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card
            ref={resultCardRef}
            className="scroll-mt-20 rounded-lg border-slate-200 bg-white shadow-sm"
          >
            <CardHeader>
              <CardTitle className="flex items-center gap-4 text-xl tracking-normal text-slate-950">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-base font-semibold text-white shadow-md shadow-blue-200">
                  02
                </span>
                生成结果
              </CardTitle>
              {result ? (
                <CardDescription className="flex flex-wrap items-center gap-2 text-sm text-slate-600">
                  <span>
                    结果月份：{result.year}年{result.month}月
                  </span>
                  {error ? (
                    <Badge className="border border-amber-200 bg-amber-50 text-amber-700">
                      最近一次成功结果（本次操作失败）
                    </Badge>
                  ) : result.year !== year || result.month !== month ? (
                    <Badge className="border border-slate-200 bg-slate-50 text-slate-600">
                      最近一次成功结果
                    </Badge>
                  ) : null}
                </CardDescription>
              ) : null}
            </CardHeader>
            <CardContent>
              {result?.feishuMessage ? (
                <Alert
                  className={
                    result.feishuMessage.sent
                      ? 'mb-4 border-emerald-200 bg-emerald-50 text-emerald-900'
                      : 'mb-4 border-amber-200 bg-amber-50 text-amber-900'
                  }
                >
                  {result.feishuMessage.sent ? (
                    <CheckCircle2 className="h-4 w-4" />
                  ) : (
                    <AlertTriangle className="h-4 w-4" />
                  )}
                  <AlertTitle>{feishuPresentation?.title}</AlertTitle>
                  <AlertDescription>
                    {feishuPresentation?.description}
                  </AlertDescription>
                </Alert>
              ) : null}
              {result?.bundleItems?.length ? (
                <div className="mb-4 rounded-lg border border-blue-100 bg-blue-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-blue-950">
                      打包内容（{result.bundleItems.length}/4）
                    </div>
                    <div className="text-xs text-blue-700">
                      ZIP 来源文件，只读核验
                    </div>
                  </div>
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {result.bundleItems.map((item) => (
                      <li
                        key={item.id}
                        className="flex min-w-0 items-center gap-2 rounded-md border border-blue-100 bg-white px-3 py-2"
                      >
                        <span className="shrink-0 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-800">
                          {item.category || '未标注类别'}
                        </span>
                        <span className="truncate text-sm text-slate-700">
                          {item.name}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {result?.files.length ? (
                <div className="space-y-3">
                  {result.files.map((file) => (
                    <div
                      key={file.id}
                      className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 md:flex-row md:items-center md:justify-between"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                          <span className="truncate">{file.name}</span>
                        </div>
                        <div className="mt-1 text-xs text-slate-500">
                          {file.size}
                          {file.category ? ` · ${file.category}` : ''}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button asChild variant="outline" className="bg-white">
                          <a href={file.downloadUrl}>
                            <Download className="h-4 w-4" />
                            下载
                          </a>
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="bg-white"
                          disabled={Boolean(fileActionKey)}
                          onClick={() => void handleFileAction(file, 'open')}
                        >
                          {fileActionKey === `open:${file.id}` ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ExternalLink className="h-4 w-4" />
                          )}
                          {fileActionKey === `open:${file.id}`
                            ? '正在打开'
                            : '打开文件'}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          className="bg-white"
                          disabled={Boolean(fileActionKey)}
                          onClick={() => void handleFileAction(file, 'reveal')}
                        >
                          {fileActionKey === `reveal:${file.id}` ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <FolderOpen className="h-4 w-4" />
                          )}
                          {fileActionKey === `reveal:${file.id}`
                            ? '正在定位'
                            : '定位文件'}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-8 text-center text-sm text-slate-500">
                  暂无生成文件
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-lg border-slate-200 bg-white shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-4 text-xl tracking-normal text-slate-950">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-base font-semibold text-white shadow-md shadow-blue-200">
                  03
                </span>
                文件与邮件
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5">
              {config.emailReady === false ? (
                <Alert className="border-amber-200 bg-amber-50 text-amber-900">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>邮件发送逻辑未就绪</AlertTitle>
                  <AlertDescription>
                    未找到{' '}
                    {config.emailAppDirLabel ||
                      'tools/ali-monthly-report-email'}
                  </AlertDescription>
                </Alert>
              ) : null}

              {emailError ? (
                <Alert className="border-rose-200 bg-rose-50 text-rose-900">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>邮件发送失败</AlertTitle>
                  <AlertDescription>{emailError}</AlertDescription>
                </Alert>
              ) : null}

              {emailResult ? (
                <Alert className="border-emerald-200 bg-emerald-50 text-emerald-900">
                  <CheckCircle2 className="h-4 w-4" />
                  <AlertTitle>邮件发送成功</AlertTitle>
                  <AlertDescription>{emailResult.message}</AlertDescription>
                </Alert>
              ) : null}

              <div className="grid gap-4 xl:grid-cols-2">
                <label className="space-y-2">
                  <span className="text-sm font-semibold text-slate-900">
                    邮件主题
                  </span>
                  <input
                    className={inputClassName}
                    value={emailSubject}
                    onChange={(event) => setEmailSubject(event.target.value)}
                    disabled={busy}
                  />
                </label>

                <label className="space-y-2">
                  <span className="text-sm font-semibold text-slate-900">
                    收件人邮箱（多个邮箱可用逗号或分号分隔）
                  </span>
                  <input
                    className={inputClassName}
                    value={emailRecipient}
                    onChange={(event) => setEmailRecipient(event.target.value)}
                    disabled={busy}
                  />
                </label>
              </div>

              <div className="flex justify-end">
                <Button
                  type="button"
                  className="h-12 min-w-48 bg-blue-600 text-base font-semibold text-white hover:bg-blue-700"
                  disabled={
                    busy || !config.emailReady || !emailRecipient.trim()
                  }
                  onClick={handleSendEmail}
                >
                  {sendingEmail ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Mail className="h-4 w-4" />
                  )}
                  发送邮件
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-lg border-slate-200 bg-white shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-4 text-xl tracking-normal text-slate-950">
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-600 text-base font-semibold text-white shadow-md shadow-blue-200">
                  04
                </span>
                执行日志
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="min-h-28 rounded-lg border border-slate-200 bg-slate-950 p-4 font-mono text-xs leading-6 text-slate-100">
                {displayLogs.map((item, index) => (
                  <div key={`${item}-${index}`}>{item}</div>
                ))}
                {busy ? (
                  <div className="flex items-center gap-2 text-blue-200">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    正在执行...
                  </div>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
