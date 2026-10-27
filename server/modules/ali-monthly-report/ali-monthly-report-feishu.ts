import { createHmac, timingSafeEqual } from 'node:crypto';

const SIGNING_PURPOSE = 'ali-monthly-report-public-download-v1';
const MIN_SIGNING_ROOT_BYTES = 32;
const ALI_MONTHLY_REPORT_FAILURE_REASON_LIMIT = 160;
const INVALID_PUBLIC_BASE_URL_MESSAGE =
  '阿里月报公共下载地址必须是无凭据、查询参数和片段的 HTTPS 地址';
const ALI_MONTHLY_REPORT_CARD_MARKDOWN_ENTITIES: Readonly<
  Record<string, string>
> = {
  '&': '&#38;',
  '*': '&#42;',
  '~': '&#126;',
  '>': '&#62;',
  '<': '&#60;',
  '[': '&#91;',
  ']': '&#93;',
  '(': '&#40;',
  ')': '&#41;',
  '#': '&#35;',
  ':': '&#58;',
  _: '&#95;',
  '\\': '&#92;',
  '`': '&#96;',
  '{': '&#123;',
  '}': '&#125;',
  '!': '&#33;',
  '|': '&#124;',
  '+': '&#43;',
  '-': '&#45;',
};
const ALI_MONTHLY_REPORT_CARD_MARKDOWN_PATTERN = /[&*~><[\]()#:_\\`{}!|+-]/gu;
const ALI_MONTHLY_REPORT_SCHEDULED_AT_PATTERN =
  /^(?:\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]) (?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?(?: \(Asia\/Shanghai\))?|\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))$/u;
const ALI_MONTHLY_REPORT_TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;

function assertAliMonthlyReportFileId(fileId: string): void {
  const normalizedFileId = typeof fileId === 'string' ? fileId.trim() : '';
  if (
    !normalizedFileId ||
    normalizedFileId === '.' ||
    normalizedFileId === '..'
  ) {
    throw new Error('阿里月报下载文件标识无效');
  }
}

function hasAsciiControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function assertSingleLineText(value: string, fieldName: string): void {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    hasAsciiControlCharacters(value)
  ) {
    throw new Error(
      `阿里月报${fieldName}必须是非空且不含 ASCII 控制字符的单行文本`,
    );
  }
}

function assertFeishuFileUrl(url: string): void {
  if (typeof url === 'string' && hasAsciiControlCharacters(url)) {
    throw new Error('阿里月报文件下载地址不得包含 ASCII 控制字符');
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(typeof url === 'string' ? url.trim() : '');
  } catch {
    throw new Error('阿里月报文件下载地址必须是绝对 HTTPS URL');
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new Error('阿里月报文件下载地址必须是无凭据的绝对 HTTPS URL');
  }
}

export function deriveAliMonthlyReportDownloadSigningSecret(
  rootSecret: string,
): string {
  const normalizedRootSecret =
    typeof rootSecret === 'string' ? rootSecret.trim() : '';
  if (
    !normalizedRootSecret ||
    Buffer.byteLength(normalizedRootSecret, 'utf8') < MIN_SIGNING_ROOT_BYTES
  ) {
    throw new Error('阿里月报下载签名密钥至少需要 32 字节');
  }

  return createHmac('sha256', normalizedRootSecret)
    .update(SIGNING_PURPOSE)
    .digest('hex');
}

export function signAliMonthlyReportDownload(
  fileId: string,
  expires: number,
  signingSecret: string,
): string {
  assertAliMonthlyReportFileId(fileId);
  if (!Number.isSafeInteger(expires) || expires <= 0) {
    throw new Error('阿里月报下载链接有效期必须是正安全整数');
  }
  if (typeof signingSecret !== 'string' || !signingSecret.trim()) {
    throw new Error('缺少阿里月报下载签名密钥');
  }

  return createHmac('sha256', signingSecret)
    .update(`${SIGNING_PURPOSE}\n${fileId}\n${expires}`)
    .digest('base64url');
}

export function verifyAliMonthlyReportDownload(options: {
  fileId: string;
  expires: number;
  signature: string;
  signingSecret: string;
  nowSeconds?: number;
}): boolean {
  if (!options || typeof options !== 'object') {
    return false;
  }

  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (
    typeof options.fileId !== 'string' ||
    !options.fileId.trim() ||
    !Number.isSafeInteger(options.expires) ||
    typeof options.signature !== 'string' ||
    !options.signature.trim() ||
    typeof options.signingSecret !== 'string' ||
    !options.signingSecret.trim() ||
    !Number.isSafeInteger(nowSeconds) ||
    options.expires <= nowSeconds
  ) {
    return false;
  }

  try {
    const expected = signAliMonthlyReportDownload(
      options.fileId,
      options.expires,
      options.signingSecret,
    );
    const actualBuffer = Buffer.from(options.signature, 'utf8');
    const expectedBuffer = Buffer.from(expected, 'utf8');

    return (
      actualBuffer.length === expectedBuffer.length &&
      timingSafeEqual(actualBuffer, expectedBuffer)
    );
  } catch {
    return false;
  }
}

export function buildAliMonthlyReportPublicDownloadUrl(options: {
  publicBaseUrl: string;
  fileId: string;
  expires: number;
  signingSecret: string;
}): string {
  const publicBaseUrl =
    typeof options.publicBaseUrl === 'string'
      ? options.publicBaseUrl.trim()
      : '';
  let baseUrl: URL;

  try {
    baseUrl = new URL(publicBaseUrl);
  } catch {
    throw new Error(INVALID_PUBLIC_BASE_URL_MESSAGE);
  }

  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    publicBaseUrl.includes('?') ||
    publicBaseUrl.includes('#')
  ) {
    throw new Error(INVALID_PUBLIC_BASE_URL_MESSAGE);
  }

  baseUrl.pathname = `${baseUrl.pathname.replace(/\/+$/u, '')}/`;
  const url = new URL(
    `api/ali-monthly-report/public-files/${encodeURIComponent(options.fileId)}`,
    baseUrl,
  );
  url.searchParams.set('expires', String(options.expires));
  url.searchParams.set(
    'signature',
    signAliMonthlyReportDownload(
      options.fileId,
      options.expires,
      options.signingSecret,
    ),
  );

  return url.toString();
}

export function buildAliMonthlyReportFeishuText(options: {
  year: number;
  month: number;
  reportTypeLabel: string;
  files: Array<{ name: string; url: string }>;
  linkSectionLabel?: string;
}): string {
  if (
    !Number.isSafeInteger(options.year) ||
    options.year < 2_000 ||
    options.year > 2_100
  ) {
    throw new Error('阿里月报通知年份必须是 2000 至 2100 的安全整数');
  }
  if (
    !Number.isSafeInteger(options.month) ||
    options.month < 1 ||
    options.month > 12
  ) {
    throw new Error('阿里月报通知月份必须是 1 至 12 的安全整数');
  }
  assertSingleLineText(options.reportTypeLabel, '类型');
  if (!Array.isArray(options.files) || options.files.length === 0) {
    throw new Error('阿里月报通知缺少文件，无法构造飞书消息');
  }
  options.files.forEach((file) => {
    assertSingleLineText(file?.name, '文件名');
    assertFeishuFileUrl(file?.url);
  });
  const linkSectionLabel = options.linkSectionLabel?.trim() || '文件';
  assertSingleLineText(linkSectionLabel, '链接分区标题');

  const lines = [
    '阿里月报已生成',
    `月份：${options.year}年${options.month}月`,
    `类型：${options.reportTypeLabel}`,
    `${linkSectionLabel}：`,
  ];
  options.files.forEach((file, index) => {
    lines.push(`${index + 1}. ${file.name}`);
    lines.push(`   ${file.url}`);
  });

  return lines.join('\n');
}

export interface AliMonthlyReportManualSuccessCardInput {
  year: number;
  month: number;
  reportTypeLabel: string;
  fileName: string;
  recordUrl: string;
  completedAt?: string;
}

export type AliMonthlyReportAutomationItemType =
  | 'alarm_analysis'
  | 'over_power'
  | 'staff_roster';

export interface AliMonthlyReportAutomationSuccessItem {
  type: AliMonthlyReportAutomationItemType;
  status: 'success';
  fileName: string;
  recordUrl: string;
}

export interface AliMonthlyReportAutomationFailureItem {
  type: AliMonthlyReportAutomationItemType;
  status: 'failed';
  failureReason: string;
  failureStage?: string;
}

export type AliMonthlyReportAutomationItem =
  | AliMonthlyReportAutomationSuccessItem
  | AliMonthlyReportAutomationFailureItem;

export interface AliMonthlyReportAutomationCardInput {
  year: number;
  month: number;
  scheduledAt: string;
  durationMs: number;
  taskId: string;
  items: readonly AliMonthlyReportAutomationItem[];
}

export interface AliMonthlyReportCardMarkdownElement {
  tag: 'markdown';
  content: string;
}

export interface AliMonthlyReportCardOpenUrlButtonElement {
  tag: 'button';
  type: 'primary';
  width: 'fill';
  text: { tag: 'plain_text'; content: string };
  behaviors: [{ type: 'open_url'; default_url: string }];
}

export interface AliMonthlyReportFeishuCard {
  schema: '2.0';
  config: {
    update_multi: boolean;
    wide_screen_mode: boolean;
    enable_forward: boolean;
  };
  header: {
    template: 'green' | 'yellow' | 'red';
    title: { tag: 'plain_text'; content: string };
  };
  body: {
    direction: 'vertical';
    padding: string;
    elements: Array<
      | AliMonthlyReportCardMarkdownElement
      | AliMonthlyReportCardOpenUrlButtonElement
    >;
  };
}

export function buildAliMonthlyReportManualSuccessCard(
  input: AliMonthlyReportManualSuccessCardInput,
): AliMonthlyReportFeishuCard {
  assertAliMonthlyReportCardYearMonth(input.year, input.month);
  assertSingleLineText(input.reportTypeLabel, '卡片月报类型');
  assertSingleLineText(input.fileName, '卡片文件名');
  const recordUrl = assertAliMonthlyReportBitableRecordUrl(input.recordUrl);
  if (input.completedAt !== undefined) {
    assertSingleLineText(input.completedAt, '卡片完成时间');
  }

  const details = [
    `统计月份：${input.year}年${input.month}月`,
    `月报类型：${escapeAliMonthlyReportCardMarkdown(input.reportTypeLabel)}`,
    `文件名称：${escapeAliMonthlyReportCardMarkdown(input.fileName)}`,
    '上传结果：已上传资料管理多维表',
    ...(input.completedAt
      ? [`完成时间：${escapeAliMonthlyReportCardMarkdown(input.completedAt)}`]
      : []),
  ].join('\n');

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: false,
    },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: '阿里月报上传成功' },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 16px 12px',
      elements: [
        { tag: 'markdown', content: details },
        buildAliMonthlyReportRecordButton('打开多维表记录', recordUrl),
      ],
    },
  };
}

const ALI_MONTHLY_REPORT_AUTOMATION_ITEM_META: Readonly<
  Record<
    AliMonthlyReportAutomationItemType,
    { label: string; buttonLabel: string }
  >
> = {
  alarm_analysis: {
    label: '告警分析',
    buttonLabel: '打开告警分析记录',
  },
  over_power: {
    label: '超功率',
    buttonLabel: '打开超功率记录',
  },
  staff_roster: {
    label: '人员变动',
    buttonLabel: '打开人员变动记录',
  },
};

export function buildAliMonthlyReportAutomationCard(
  input: AliMonthlyReportAutomationCardInput,
): AliMonthlyReportFeishuCard {
  assertAliMonthlyReportCardYearMonth(input.year, input.month);
  assertAliMonthlyReportScheduledAt(input.scheduledAt);
  assertAliMonthlyReportTaskId(input.taskId);
  if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0) {
    throw new Error('阿里月报卡片耗时必须是非负安全整数毫秒');
  }
  assertAliMonthlyReportAutomationItems(input.items);
  const successCount = input.items.filter(
    (item) => item.status === 'success',
  ).length;
  input.items.forEach((item) => {
    if (item.status === 'success') {
      assertSingleLineText(item.fileName, '卡片文件名');
      assertAliMonthlyReportBitableRecordUrl(item.recordUrl);
      return;
    }
    assertSingleLineText(item.failureReason, '卡片失败原因');
    if (item.failureStage !== undefined) {
      assertSingleLineText(item.failureStage, '卡片失败阶段');
    }
  });

  const failureCount = input.items.length - successCount;
  const allSucceeded = failureCount === 0;
  const allFailed = successCount === 0;
  const summary = [
    `统计月份：${input.year}年${input.month}月`,
    `计划时间：${input.scheduledAt.trim()}`,
    `执行结果：${successCount}/${input.items.length} 成功${
      failureCount > 0 ? `，${failureCount}项失败` : ''
    }`,
    `总耗时：${formatAliMonthlyReportDuration(input.durationMs)}`,
  ].join('\n');
  const elements: AliMonthlyReportFeishuCard['body']['elements'] = [
    { tag: 'markdown', content: summary },
  ];

  input.items.forEach((item) => {
    const meta = ALI_MONTHLY_REPORT_AUTOMATION_ITEM_META[item.type];
    if (item.status === 'success') {
      elements.push({
        tag: 'markdown',
        content: `✅ ${meta.label}｜已上传\n文件名称：${escapeAliMonthlyReportCardMarkdown(
          item.fileName,
        )}`,
      });
      elements.push(
        buildAliMonthlyReportRecordButton(
          meta.buttonLabel,
          assertAliMonthlyReportBitableRecordUrl(item.recordUrl),
        ),
      );
      return;
    }

    elements.push({
      tag: 'markdown',
      content: [
        `❌ ${meta.label}｜${allFailed ? '执行失败' : '上传失败'}`,
        ...(item.failureStage
          ? [
              `失败阶段：${escapeAliMonthlyReportCardMarkdown(
                item.failureStage,
              )}`,
            ]
          : []),
        `失败原因：${escapeAliMonthlyReportCardMarkdown(
          abbreviateAliMonthlyReportFailureReason(item.failureReason),
        )}`,
      ].join('\n'),
    });
  });
  elements.push({
    tag: 'markdown',
    content: `任务编号：${input.taskId.trim()}`,
  });

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      wide_screen_mode: true,
      enable_forward: false,
    },
    header: {
      template: allSucceeded ? 'green' : allFailed ? 'red' : 'yellow',
      title: {
        tag: 'plain_text',
        content: allSucceeded
          ? '阿里月报自动任务｜全部成功'
          : allFailed
            ? '阿里月报自动任务｜执行失败'
            : '阿里月报自动任务｜部分失败',
      },
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 16px 12px',
      elements,
    },
  };
}

function assertAliMonthlyReportCardYearMonth(
  year: number,
  month: number,
): void {
  if (!Number.isSafeInteger(year) || year < 2_000 || year > 2_100) {
    throw new Error('阿里月报卡片年份必须是 2000 至 2100 的安全整数');
  }
  if (!Number.isSafeInteger(month) || month < 1 || month > 12) {
    throw new Error('阿里月报卡片月份必须是 1 至 12 的安全整数');
  }
}

function assertAliMonthlyReportScheduledAt(value: string): void {
  assertSingleLineText(value, '卡片计划时间');
  if (!ALI_MONTHLY_REPORT_SCHEDULED_AT_PATTERN.test(value.trim())) {
    throw new Error('阿里月报卡片计划时间格式无效');
  }
}

function assertAliMonthlyReportTaskId(value: string): void {
  assertSingleLineText(value, '卡片任务编号');
  if (!ALI_MONTHLY_REPORT_TASK_ID_PATTERN.test(value.trim())) {
    throw new Error('阿里月报卡片任务编号格式无效');
  }
}

function assertAliMonthlyReportAutomationItems(
  items: readonly AliMonthlyReportAutomationItem[],
): void {
  const requiredTypes: readonly AliMonthlyReportAutomationItemType[] = [
    'alarm_analysis',
    'over_power',
    'staff_roster',
  ];
  if (!Array.isArray(items) || items.length !== requiredTypes.length) {
    throw new Error(
      '阿里月报自动任务卡片必须包含告警分析、超功率和人员变动三项',
    );
  }

  const actualTypes = new Set(items.map((item) => item?.type));
  if (
    actualTypes.size !== requiredTypes.length ||
    requiredTypes.some((type) => !actualTypes.has(type))
  ) {
    throw new Error('阿里月报自动任务卡片三项类型缺失或重复');
  }
}

function formatAliMonthlyReportDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}分${String(seconds).padStart(
    2,
    '0',
  )}秒`;
}

function assertAliMonthlyReportBitableRecordUrl(value: string): string {
  if (typeof value !== 'string' || hasAsciiControlCharacters(value)) {
    throw new Error('阿里月报多维表记录地址必须是安全的飞书 HTTPS 地址');
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.trim());
  } catch {
    throw new Error('阿里月报多维表记录地址必须是安全的飞书 HTTPS 地址');
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== 'vnet.feishu.cn' ||
    parsedUrl.port ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.hash ||
    !/^\/base\/[A-Za-z0-9_-]+\/?$/u.test(parsedUrl.pathname) ||
    parsedUrl.searchParams.getAll('table').length !== 1 ||
    parsedUrl.searchParams.getAll('recordId').length !== 1 ||
    !/^[A-Za-z0-9_-]{1,100}$/u.test(
      parsedUrl.searchParams.get('table') || '',
    ) ||
    !/^[A-Za-z0-9_-]{1,100}$/u.test(
      parsedUrl.searchParams.get('recordId') || '',
    )
  ) {
    throw new Error(
      '阿里月报多维表记录地址必须使用 https://vnet.feishu.cn/base/',
    );
  }

  return parsedUrl.toString();
}

function buildAliMonthlyReportRecordButton(
  label: string,
  recordUrl: string,
): AliMonthlyReportCardOpenUrlButtonElement {
  return {
    tag: 'button',
    type: 'primary',
    width: 'fill',
    text: { tag: 'plain_text', content: label },
    behaviors: [{ type: 'open_url', default_url: recordUrl }],
  };
}

function escapeAliMonthlyReportCardMarkdown(value: string): string {
  return value
    .trim()
    .replace(
      ALI_MONTHLY_REPORT_CARD_MARKDOWN_PATTERN,
      (character) =>
        ALI_MONTHLY_REPORT_CARD_MARKDOWN_ENTITIES[character] || character,
    );
}

function abbreviateAliMonthlyReportFailureReason(value: string): string {
  const characters = Array.from(value.trim());
  if (characters.length <= ALI_MONTHLY_REPORT_FAILURE_REASON_LIMIT) {
    return characters.join('');
  }

  return `${characters
    .slice(0, ALI_MONTHLY_REPORT_FAILURE_REASON_LIMIT - 1)
    .join('')}…`;
}
