import type {
  ConstructionAttachmentGroup,
  ConstructionAttachmentFile,
  ConstructionAttachmentManualReview,
  ConstructionOverviewItem,
} from '../../../../shared/api.interface';
import type { DailyFollowupStage } from './daily-progress';

export type DailyPermitStatus =
  | 'valid'
  | 'invalid'
  | 'pendingReview'
  | 'expiresTomorrow'
  | 'expiresToday'
  | 'expired'
  | 'notStarted'
  | 'unknown';

export interface DailyPermitDefinition {
  workType: string;
  fileKey: string;
  label: string;
  aliases: string[];
}

export interface DailyPermitVerification extends DailyPermitDefinition {
  status: DailyPermitStatus;
  expiryDate: string | null;
  daysUntilExpiry: number | null;
  sourceText: string | null;
  sourceFollowupRecordId: string | null;
  files: ConstructionAttachmentFile[];
  manualReview: DailyPermitManualReview;
  requiresRenewal: boolean;
  blocksProcess: boolean;
  message: string;
}

export type DailyPermitManualReviewStatus =
  | 'passed'
  | 'rejected'
  | 'pending'
  | 'stale';

export interface DailyPermitManualReview {
  status: DailyPermitManualReviewStatus;
  reviewed: boolean;
  matched: boolean;
  message: string;
  field: string | null;
  fingerprint: string | null;
  expectedFingerprint: string | null;
  validFrom: string | null;
  validUntil: string | null;
}

export interface DailyPermitInvalidDetails {
  reason: string;
  suggestion: string;
}

export interface DailyPermitAuditDetails {
  verificationDate: string;
  version: string;
  conclusion: string;
  expiry: string;
  description: string;
  issue: string;
  suggestion: string;
  rawText: string;
}

export interface DailyPermitChecklistItem {
  label: string;
  value: string;
  done: boolean;
  issue: boolean;
}

export type DailyPermitSummaryTone =
  | 'complete'
  | 'warning'
  | 'issue'
  | 'pending';
export type DailyPermitVerificationTone = 'valid' | 'attention' | 'danger';

export interface DailyPermitSummary extends DailyPermitChecklistItem {
  description: string;
  tone: DailyPermitSummaryTone;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DAILY_PERMIT_REFRESH_GRACE_MS = 1000;
const CONCISE_MANUAL_PERMIT_AUDIT_SUMMARY = '需人工复核：票面信息待核验';

export const DAILY_PERMIT_DEFINITIONS: readonly DailyPermitDefinition[] = [
  {
    workType: '受限空间作业',
    fileKey: 'confinedSpacePermitFiles',
    label: '受限空间许可证',
    aliases: ['受限空间许可证', '受限空间作业许可证', '受限空间作业票'],
  },
  {
    workType: '动火作业',
    fileKey: 'hotWorkPermitFiles',
    label: '动火许可证',
    aliases: ['动火许可证', '动火作业许可证', '动火作业票'],
  },
  {
    workType: '临时用电作业',
    fileKey: 'temporaryPowerPermitFiles',
    label: '临时用电作业许可证',
    aliases: [
      '临时用电作业许可证',
      '临时用电许可证',
      '临时用电作业票',
      '临时用电票',
    ],
  },
  {
    workType: '高处作业',
    fileKey: 'heightWorkPermitFiles',
    label: '高处作业许可证',
    aliases: ['高处作业许可证', '高处作业票', '高处作业许可'],
  },
] as const;

export function getDailyPermitVerifications(
  item: ConstructionOverviewItem | null,
  referenceDate: Date = new Date(),
  confirmedWorkTypes?: readonly string[] | null,
  constructionAiAuditEnabled = false,
): DailyPermitVerification[] {
  if (!item) {
    return [];
  }

  const workTypes =
    confirmedWorkTypes && confirmedWorkTypes.length > 0
      ? confirmedWorkTypes
      : item.workTypes;

  return DAILY_PERMIT_DEFINITIONS.filter((definition) =>
    workTypes.some((workType) => workType.includes(definition.workType)),
  ).map((definition) =>
    buildPermitVerification(
      definition,
      item,
      referenceDate,
      constructionAiAuditEnabled,
    ),
  );
}

export function getDailyPermitNextRefreshDelay(now: Date = new Date()): number {
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  return Math.max(
    DAILY_PERMIT_REFRESH_GRACE_MS,
    nextMidnight.getTime() - now.getTime() + DAILY_PERMIT_REFRESH_GRACE_MS,
  );
}

export function getDailyPermitVerificationTone(
  verification: Pick<DailyPermitVerification, 'status'>,
): DailyPermitVerificationTone {
  if (
    verification.status === 'expired' ||
    verification.status === 'invalid' ||
    verification.status === 'notStarted'
  ) {
    return 'danger';
  }
  if (
    verification.status === 'valid' ||
    verification.status === 'expiresToday' ||
    verification.status === 'expiresTomorrow'
  ) {
    return 'valid';
  }
  return 'attention';
}

export function getDailyPermitDisplayMessage(
  verification: Pick<
    DailyPermitVerification,
    'label' | 'message' | 'status' | 'files' | 'manualReview'
  >,
  constructionAiAuditEnabled: boolean,
): string {
  if (constructionAiAuditEnabled) {
    return verification.message;
  }

  if (verification.manualReview.status === 'passed') {
    return `${verification.label}人工审核通过。`;
  }
  if (verification.manualReview.status === 'rejected') {
    return `${verification.label}人工审核驳回，请重新上传后再审核。`;
  }
  if (verification.manualReview.status === 'stale') {
    return `${verification.label}作业票已变更，请重新人工审核。`;
  }
  if (verification.status === 'expired') {
    return `${verification.label}已过期，请上传续期作业票后重新人工审核。`;
  }
  return verification.files.length > 0
    ? `${verification.label}已上传，待人工审核。`
    : `${verification.label}待上传并人工审核。`;
}

export function getBlockingDailyPermitIssues(
  verifications: readonly DailyPermitVerification[],
): DailyPermitVerification[] {
  return verifications.filter((item) => item.blocksProcess);
}

export function isDailyFollowupStageAllowedByPermits(
  stage: DailyFollowupStage,
  verifications: readonly DailyPermitVerification[],
): boolean {
  if (stage === 'prepare') {
    return true;
  }
  return getBlockingDailyPermitIssues(verifications).length === 0;
}

export function getDailyPermitRenewalFileFields(
  verifications: readonly DailyPermitVerification[],
): ReadonlyArray<readonly [string, string]> {
  const seen = new Set<string>();
  return verifications
    .filter((item) => item.requiresRenewal)
    .filter((item) => {
      if (seen.has(item.fileKey)) {
        return false;
      }
      seen.add(item.fileKey);
      return true;
    })
    .map((item) => [item.fileKey, `${item.label}新作业票`] as const);
}

export function getDailyPermitChecklistItems(
  verifications: readonly DailyPermitVerification[],
): DailyPermitChecklistItem[] {
  if (verifications.length === 0) {
    return [];
  }

  const summary = getDailyPermitSummary(verifications);

  return [
    {
      label: '作业票',
      value: summary.value,
      done: summary.done,
      issue: summary.issue,
    },
  ];
}

export function getDailyPermitSummary(
  verifications: readonly DailyPermitVerification[],
): DailyPermitSummary {
  if (verifications.length === 0) {
    return {
      label: '作业票校核',
      value: '无需校核',
      description: '当前项目未配置需要每日校核的作业票。',
      done: true,
      issue: false,
      tone: 'complete',
    };
  }

  const expiredCount = countPermitStatus(verifications, 'expired');
  const notStartedCount = countPermitStatus(verifications, 'notStarted');
  const invalidCount = countPermitStatus(verifications, 'invalid');
  const pendingReviewCount = countPermitStatus(verifications, 'pendingReview');
  const unknownCount = countPermitStatus(verifications, 'unknown');
  const renewalCount =
    countPermitStatus(verifications, 'expiresToday') +
    countPermitStatus(verifications, 'expiresTomorrow');
  const allValid = verifications.every((item) =>
    ['valid', 'expiresToday', 'expiresTomorrow'].includes(item.status),
  );
  const attentionMessages = verifications
    .filter((item) => item.status !== 'valid')
    .map((item) => item.message)
    .filter(Boolean);

  if (expiredCount > 0) {
    return {
      label: '作业票校核',
      value: `过期 ${expiredCount}项`,
      description: attentionMessages.join('；') || '存在已过期作业票。',
      done: false,
      issue: true,
      tone: 'issue',
    };
  }

  if (notStartedCount > 0) {
    return {
      label: '作业票校核',
      value: `未生效 ${notStartedCount}项`,
      description:
        attentionMessages.join('；') || '存在尚未进入有效期的作业票。',
      done: false,
      issue: true,
      tone: 'issue',
    };
  }

  if (invalidCount > 0) {
    return {
      label: '作业票校核',
      value: `无效 ${invalidCount}项`,
      description: attentionMessages.join('；') || '存在审核未通过作业票。',
      done: false,
      issue: true,
      tone: 'issue',
    };
  }

  if (pendingReviewCount > 0) {
    return {
      label: '作业票校核',
      value: `待审核 ${pendingReviewCount}项`,
      description: attentionMessages.join('；') || '存在待人工审核作业票。',
      done: false,
      issue: true,
      tone: 'pending',
    };
  }

  if (unknownCount > 0) {
    return {
      label: '作业票校核',
      value: `待核验 ${unknownCount}项`,
      description:
        attentionMessages.join('；') ||
        '存在未识别有效期的作业票，需人工核验。',
      done: false,
      issue: false,
      tone: 'pending',
    };
  }

  if (renewalCount > 0) {
    return {
      label: '作业票校核',
      value: `有效（临期 ${renewalCount}项）`,
      description: attentionMessages.join('；') || '存在即将到期作业票。',
      done: true,
      issue: false,
      tone: 'complete',
    };
  }

  return {
    label: '作业票校核',
    value: allValid ? '有效' : '待核验',
    description: allValid
      ? verifications.map((item) => item.message).join('；')
      : '作业票状态待核验。',
    done: allValid,
    issue: false,
    tone: allValid ? 'complete' : 'pending',
  };
}

export function getRequiredDailyPermitRenewalFileKeys(
  verifications: readonly DailyPermitVerification[],
): string[] {
  return verifications
    .filter((item) => item.blocksProcess)
    .map((item) => item.fileKey);
}

export function getDailyFollowupStageRequiredFileKeys(
  _stage: 'prepare' | 'process' | 'close',
  baseRequiredFileKeys: readonly string[],
  _verifications: readonly DailyPermitVerification[],
): string[] {
  return Array.from(new Set(baseRequiredFileKeys));
}

export function getDailyPermitAuditSummary(
  verification: Pick<DailyPermitVerification, 'sourceText'>,
): string {
  const text = normalizeText(verification.sourceText || '');
  if (!text) {
    return '';
  }

  const segments = text
    .split(/[；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
  const conclusion =
    segments.find((item) => /^(结论|审核结果|视觉审核|状态)[:：]/.test(item)) ||
    '';
  const expiry = segments.find((item) => /^有效期至[:：]/.test(item)) || '';
  const issue =
    segments.find(
      (item) => /^(问题|问题清单)[:：]/.test(item) && !/[：:]\s*无$/.test(item),
    ) || '';
  const summary = segments.find((item) => /^(说明|摘要)[:：]/.test(item)) || '';
  const fallback = segments[0] || '';
  const genericManualReviewText = [issue, summary, text]
    .filter(Boolean)
    .join('；');

  if (
    /需人工复核/.test(conclusion || text) &&
    /视觉审核失败|票面信息(?:需人工核验|待核验)|需人工核验票面信息|有效期、审批签章或作业内容需人工确认/.test(
      genericManualReviewText,
    )
  ) {
    return CONCISE_MANUAL_PERMIT_AUDIT_SUMMARY;
  }

  if (!conclusion && /自动审核|核验要点|当前未完成视觉识别/.test(text)) {
    return CONCISE_MANUAL_PERMIT_AUDIT_SUMMARY;
  }

  return [conclusion || fallback, expiry, issue || summary]
    .filter(Boolean)
    .join('；');
}

export function getDailyPermitInvalidDetails(
  verification: Pick<
    DailyPermitVerification,
    'label' | 'status' | 'sourceText' | 'message'
  >,
): DailyPermitInvalidDetails | null {
  if (verification.status !== 'invalid') {
    return null;
  }

  const text = stripTechnicalAuditFailureText(
    normalizeText(verification.sourceText || ''),
  );
  const reason =
    sanitizeAuditDetail(
      extractAuditField(text, ['问题清单', '问题']) ||
        extractAuditField(text, ['说明', '摘要']) ||
        extractAuditField(text, ['审核结果', '视觉审核', '结论', '状态']) ||
        text.split(/[；;。]/)[0] ||
        verification.message,
    ) || `${verification.label}审核未通过`;
  const suggestion =
    sanitizeAuditDetail(extractAuditField(text, ['建议'])) ||
    `请重新上传清晰完整的${verification.label}`;

  return { reason, suggestion };
}

export function getDailyPermitAuditDetails(
  verification: Pick<DailyPermitVerification, 'sourceText'> &
    Partial<Pick<DailyPermitVerification, 'expiryDate'>>,
): DailyPermitAuditDetails | null {
  const rawText = stripTechnicalAuditFailureText(
    normalizeText(verification.sourceText || '').replace(/^AI审核[:：]\s*/, ''),
  );
  if (!rawText) {
    return null;
  }

  const issue = sanitizeAuditDetail(
    extractAuditField(rawText, ['问题清单', '问题']),
  );

  const details: DailyPermitAuditDetails = {
    verificationDate: sanitizeAuditDetail(
      extractAuditField(rawText, ['核验日期']),
    ),
    version: sanitizeAuditDetail(extractAuditField(rawText, ['核验版本'])),
    conclusion: sanitizeAuditDetail(
      extractAuditField(rawText, ['结论', '审核结果', '视觉审核', '状态']),
    ),
    expiry: sanitizeAuditDetail(
      verification.expiryDate ||
        extractAuditField(rawText, ['有效期至', '有效期']),
    ),
    description: sanitizeAuditDetail(
      extractAuditField(rawText, ['说明', '摘要']),
    ),
    issue: /^无$/.test(issue) ? '' : issue,
    suggestion: sanitizeAuditDetail(extractAuditField(rawText, ['建议'])),
    rawText,
  };

  return Object.values(details).some(Boolean) ? details : null;
}

function countPermitStatus(
  verifications: readonly DailyPermitVerification[],
  status: DailyPermitStatus,
): number {
  return verifications.filter((item) => item.status === status).length;
}

function buildPermitVerification(
  definition: DailyPermitDefinition,
  item: ConstructionOverviewItem,
  referenceDate: Date,
  constructionAiAuditEnabled: boolean,
): DailyPermitVerification {
  if (!constructionAiAuditEnabled) {
    return buildManualOnlyPermitVerification(definition, item, referenceDate);
  }

  const permitSources = getPermitSourceTexts(item, definition).map((source) => {
    const text = extractLatestPermitAuditText(source.text);
    return {
      ...source,
      text,
      approved: isAuditApproved(text),
      rejected: isAuditRejected(text),
      expiryDate: extractPermitExpiryDate(text, referenceDate),
    };
  });
  const fallbackFileSource = getLatestPermitFileSource(item, definition);
  const fallbackFiles = fallbackFileSource?.files || [];
  const latestSource = permitSources[0] || null;
  const latestManualReviewSource = getLatestPermitManualReviewSource(
    item,
    definition,
  );
  const rawFiles = latestSource?.files.length
    ? latestSource.files
    : fallbackFiles;
  const files = latestSource?.files.length
    ? getLatestPermitDisplayFiles(rawFiles)
    : fallbackFiles;
  const sourceManualReview =
    latestManualReviewSource?.manualReview ||
    latestSource?.manualReview ||
    fallbackFileSource?.manualReview ||
    null;
  const sourceFollowupRecordId =
    latestSource?.followupRecordId ||
    fallbackFileSource?.followupRecordId ||
    null;
  const manualExpiryDate = parsePermitDate(
    sourceManualReview?.validUntil || '',
    referenceDate,
  );
  const manualValidFromDate = parsePermitDate(
    sourceManualReview?.validFrom || '',
    referenceDate,
  );
  const sourceExpiryDate = manualExpiryDate || latestSource?.expiryDate || null;
  const manualReview = buildDailyPermitManualReview(
    sourceManualReview,
    buildDailyPermitManualReviewFingerprint(
      rawFiles,
      sourceExpiryDate,
      referenceDate,
      manualExpiryDate ? 'manual' : 'ai',
      manualValidFromDate,
    ),
    files.length > 0,
  );
  const manualReviewDrivenVerification =
    sourceManualReview && (files.length > 0 || Boolean(latestSource))
      ? buildManualReviewDrivenVerification({
          definition,
          sourceText: latestSource?.text || null,
          sourceFollowupRecordId,
          files,
          manualReview,
          validFromDate: manualValidFromDate,
          expiryDate: sourceExpiryDate,
          referenceDate,
        })
      : null;
  if (manualReviewDrivenVerification) {
    return manualReviewDrivenVerification;
  }

  if (latestSource?.rejected) {
    return {
      ...definition,
      status: 'invalid',
      expiryDate: null,
      daysUntilExpiry: null,
      sourceText: latestSource.text,
      sourceFollowupRecordId,
      files,
      manualReview: requireManualReviewForInvalidPermit(manualReview),
      requiresRenewal: true,
      blocksProcess: true,
      message: `${definition.label}审核未通过，请按审核要求重新上传。`,
    };
  }

  if (!latestSource && files.length > 0) {
    return {
      ...definition,
      status: 'invalid',
      expiryDate: null,
      daysUntilExpiry: null,
      sourceText: null,
      sourceFollowupRecordId,
      files,
      manualReview: requireManualReviewForInvalidPermit(manualReview),
      requiresRenewal: true,
      blocksProcess: true,
      message: `${definition.label}已上传，待人工审核。`,
    };
  }

  const expiryDate = sourceExpiryDate;
  if (!expiryDate) {
    return {
      ...definition,
      status: 'unknown',
      expiryDate: null,
      daysUntilExpiry: null,
      sourceText: latestSource?.text || null,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: true,
      blocksProcess: false,
      message: `未识别${definition.label}有效期，需人工核验。`,
    };
  }

  const daysUntilExpiry = getSignedDayDiff(expiryDate, referenceDate);
  const dateLabel = formatDateKey(expiryDate);
  if (daysUntilExpiry < 0) {
    return {
      ...definition,
      status: 'expired',
      expiryDate: dateLabel,
      daysUntilExpiry,
      sourceText: latestSource?.text || null,
      sourceFollowupRecordId,
      files,
      manualReview: requireManualReviewForInvalidPermit(manualReview),
      requiresRenewal: true,
      blocksProcess: true,
      message: `${definition.label}已过期（有效期至 ${formatMonthDay(expiryDate)}），请在准备阶段上传续期作业票。`,
    };
  }
  if (daysUntilExpiry === 0) {
    return {
      ...definition,
      status: 'expiresToday',
      expiryDate: dateLabel,
      daysUntilExpiry,
      sourceText: latestSource?.text || null,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: false,
      blocksProcess: false,
      message: `${definition.label}今日到期（有效期至 ${formatMonthDay(expiryDate)}），请尽快续期。`,
    };
  }
  if (daysUntilExpiry === 1) {
    return {
      ...definition,
      status: 'expiresTomorrow',
      expiryDate: dateLabel,
      daysUntilExpiry,
      sourceText: latestSource?.text || null,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: false,
      blocksProcess: false,
      message: `${definition.label}明天即将过期（有效期至 ${formatMonthDay(expiryDate)}），请提前续期。`,
    };
  }

  return {
    ...definition,
    status: 'valid',
    expiryDate: dateLabel,
    daysUntilExpiry,
    sourceText: latestSource?.text || null,
    sourceFollowupRecordId,
    files,
    manualReview,
    requiresRenewal: false,
    blocksProcess: false,
    message: `${definition.label}有效期至 ${formatMonthDay(expiryDate)}。`,
  };
}

function buildManualOnlyPermitVerification(
  definition: DailyPermitDefinition,
  item: ConstructionOverviewItem,
  referenceDate: Date,
): DailyPermitVerification {
  const fileSource = getLatestPermitFileSource(item, definition);
  const files = fileSource?.files || [];
  const manualReviewSource =
    getLatestPermitManualReviewSource(item, definition)?.manualReview ||
    fileSource?.manualReview ||
    null;
  const expiryDate = parsePermitDate(
    manualReviewSource?.validUntil || '',
    referenceDate,
  );
  const validFromDate = parsePermitDate(
    manualReviewSource?.validFrom || '',
    referenceDate,
  );
  const manualReview = buildDailyPermitManualReview(
    manualReviewSource,
    buildDailyPermitManualReviewFingerprint(
      files,
      expiryDate,
      referenceDate,
      'manual',
      validFromDate,
    ),
    files.length > 0,
  );
  const sourceFollowupRecordId = fileSource?.followupRecordId || null;

  if (files.length === 0) {
    return {
      ...definition,
      status: 'pendingReview',
      expiryDate: null,
      daysUntilExpiry: null,
      sourceText: null,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: true,
      blocksProcess: true,
      message: `${definition.label}待上传并人工审核。`,
    };
  }

  if (manualReview.status === 'rejected') {
    return {
      ...definition,
      status: 'invalid',
      expiryDate: expiryDate ? formatDateKey(expiryDate) : null,
      daysUntilExpiry: expiryDate
        ? getSignedDayDiff(expiryDate, referenceDate)
        : null,
      sourceText: null,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: true,
      blocksProcess: true,
      message: `${definition.label}人工审核驳回，请重新上传后再审核。`,
    };
  }

  if (manualReview.status === 'pending' || manualReview.status === 'stale') {
    return {
      ...definition,
      status: 'pendingReview',
      expiryDate: expiryDate ? formatDateKey(expiryDate) : null,
      daysUntilExpiry: expiryDate
        ? getSignedDayDiff(expiryDate, referenceDate)
        : null,
      sourceText: null,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: false,
      blocksProcess: true,
      message:
        manualReview.status === 'stale'
          ? `${definition.label}作业票已变更，请重新人工审核。`
          : `${definition.label}已上传，待人工审核。`,
    };
  }

  if (!expiryDate) {
    return {
      ...definition,
      status: 'pendingReview',
      expiryDate: null,
      daysUntilExpiry: null,
      sourceText: null,
      sourceFollowupRecordId,
      files,
      manualReview: {
        ...manualReview,
        status: 'pending',
        reviewed: false,
        matched: false,
        message: '人工审核已通过，待填写人工确认有效期',
      },
      requiresRenewal: false,
      blocksProcess: true,
      message: `${definition.label}人工审核已通过，待填写人工确认有效期。`,
    };
  }

  const daysUntilExpiry = getSignedDayDiff(expiryDate, referenceDate);
  const expiryDateLabel = formatDateKey(expiryDate);
  const daysUntilValidFrom = validFromDate
    ? getSignedDayDiff(validFromDate, referenceDate)
    : null;
  if (daysUntilValidFrom !== null && daysUntilValidFrom > 0) {
    return {
      ...definition,
      status: 'notStarted',
      expiryDate: expiryDateLabel,
      daysUntilExpiry,
      sourceText: null,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: true,
      blocksProcess: true,
      message: `${definition.label}尚未生效（有效期 ${formatMonthDay(validFromDate!)} 至 ${formatMonthDay(expiryDate)}）。`,
    };
  }
  if (daysUntilExpiry < 0) {
    return {
      ...definition,
      status: 'expired',
      expiryDate: expiryDateLabel,
      daysUntilExpiry,
      sourceText: null,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: true,
      blocksProcess: true,
      message: `${definition.label}人工确认有效期已过期（有效期至 ${formatMonthDay(expiryDate)}），请上传续期作业票。`,
    };
  }
  if (daysUntilExpiry === 0) {
    return {
      ...definition,
      status: 'expiresToday',
      expiryDate: expiryDateLabel,
      daysUntilExpiry,
      sourceText: null,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: false,
      blocksProcess: false,
      message: `${definition.label}人工审核通过，今日到期（有效期至 ${formatMonthDay(expiryDate)}）。`,
    };
  }
  if (daysUntilExpiry === 1) {
    return {
      ...definition,
      status: 'expiresTomorrow',
      expiryDate: expiryDateLabel,
      daysUntilExpiry,
      sourceText: null,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: false,
      blocksProcess: false,
      message: `${definition.label}人工审核通过，明日到期（有效期至 ${formatMonthDay(expiryDate)}）。`,
    };
  }

  return {
    ...definition,
    status: 'valid',
    expiryDate: expiryDateLabel,
    daysUntilExpiry,
    sourceText: null,
    sourceFollowupRecordId,
    files,
    manualReview,
    requiresRenewal: false,
    blocksProcess: false,
    message: `${definition.label}人工审核通过，有效期至 ${formatMonthDay(expiryDate)}。`,
  };
}

function extractLatestPermitAuditText(text: string): string {
  const normalized = normalizeText(text);
  const renewalParts = normalized
    .split(/(?:^|[；;])\s*续期审核[:：]\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (renewalParts.length > 1) {
    return renewalParts[renewalParts.length - 1];
  }
  return normalized;
}

function getLatestPermitDisplayFiles(
  files: ConstructionAttachmentFile[],
): ConstructionAttachmentFile[] {
  return files.length > 1 ? files.slice(-1) : files;
}

function getPermitSourceTexts(
  item: ConstructionOverviewItem,
  definition: DailyPermitDefinition,
): Array<{
  text: string;
  updatedAt: number;
  followupRecordId: string;
  files: ConstructionAttachmentFile[];
  manualReview: ConstructionAttachmentManualReview | null;
}> {
  return item.followups
    .flatMap((followup) =>
      followup.attachments
        .filter((group) => isPermitAttachmentGroup(group, definition))
        .map((group) => ({
          text: group.feedback || '',
          followupRecordId: followup.recordId,
          files: group.files,
          manualReview: group.manualReview || null,
          updatedAt: getDateTime(followup.updatedAt || followup.createdAt),
        })),
    )
    .map((source) => ({
      ...source,
      text: normalizeText(source.text),
    }))
    .filter((source) => Boolean(source.text))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function getLatestPermitFileSource(
  item: ConstructionOverviewItem,
  definition: DailyPermitDefinition,
): {
  followupRecordId: string;
  files: ConstructionAttachmentFile[];
  manualReview: ConstructionAttachmentManualReview | null;
  updatedAt: number;
} | null {
  return (
    item.followups
      .flatMap((followup) =>
        followup.attachments
          .filter((group) => isPermitAttachmentGroup(group, definition))
          .map((group) => ({
            followupRecordId: followup.recordId,
            files: group.files,
            manualReview: group.manualReview || null,
            updatedAt: getDateTime(followup.updatedAt || followup.createdAt),
          })),
      )
      .filter((source) => source.files.length > 0)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] || null
  );
}

function getLatestPermitManualReviewSource(
  item: ConstructionOverviewItem,
  definition: DailyPermitDefinition,
): {
  manualReview: ConstructionAttachmentManualReview;
  updatedAt: number;
} | null {
  return (
    item.followups
      .flatMap((followup) =>
        followup.attachments
          .filter((group) => isPermitAttachmentGroup(group, definition))
          .map((group) => ({
            manualReview: group.manualReview || null,
            updatedAt: getDateTime(followup.updatedAt || followup.createdAt),
          })),
      )
      .filter((source): source is {
        manualReview: ConstructionAttachmentManualReview;
        updatedAt: number;
      } => {
        if (!source.manualReview) {
          return false;
        }
        return (
          getManualReviewDecision(source.manualReview) !== 'pending' ||
          Boolean(normalizeText(source.manualReview.fingerprint || '')) ||
          Boolean(
            normalizeText(source.manualReview.expectedFingerprint || ''),
          )
        );
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)[0] || null
  );
}

function buildDailyPermitManualReview(
  source: ConstructionAttachmentManualReview | null,
  currentFingerprint: string | null,
  hasFiles: boolean,
): DailyPermitManualReview {
  const decision = getManualReviewDecision(source);
  const hasManualDecision = decision !== 'pending';
  const storedFingerprint = normalizeText(source?.fingerprint || '');
  const expectedFingerprint =
    currentFingerprint ||
    normalizeText(source?.expectedFingerprint || '') ||
    null;
  const matched =
    hasManualDecision &&
    (!storedFingerprint ||
      !expectedFingerprint ||
      storedFingerprint === expectedFingerprint);
  const status: DailyPermitManualReviewStatus =
    hasManualDecision && !matched ? 'stale' : decision;
  const message =
    status === 'passed'
      ? '人工审核通过'
      : status === 'rejected'
        ? '人工审核驳回'
      : status === 'stale'
        ? '作业票已变化，需重新人工审核'
        : hasFiles
          ? '待人工审核'
          : '待上传作业票';

  return {
    status,
    reviewed: hasManualDecision,
    matched,
    message,
    field: source?.field || null,
    fingerprint: storedFingerprint || null,
    expectedFingerprint,
    validFrom: source?.validFrom || null,
    validUntil: source?.validUntil || null,
  };
}

type ManualReviewDecision = 'passed' | 'rejected' | 'pending';

function getManualReviewDecision(
  source: ConstructionAttachmentManualReview | null,
): ManualReviewDecision {
  const text = normalizeText(source?.value || '');
  if (/驳回|退回|拒绝|否决|不通过|未通过|reject|rejected/i.test(text)) {
    return 'rejected';
  }
  if (
    source?.reviewed ||
    /^(true|1|yes|y|是|已审核|已人工审核|人员已审|人工已审|通过|已通过|pass|passed|approve|approved|✔️?|✓|☑|√)$/i.test(
      text,
    )
  ) {
    return 'passed';
  }
  return 'pending';
}

function requireManualReviewForInvalidPermit(
  manualReview: DailyPermitManualReview,
): DailyPermitManualReview {
  return {
    ...manualReview,
    status: 'pending',
    reviewed: false,
    matched: false,
    message: '作业票无效，需EHS人工审核',
  };
}

function requireManualReviewForExpiredPermit(
  manualReview: DailyPermitManualReview,
): DailyPermitManualReview {
  return {
    ...manualReview,
    status: 'pending',
    reviewed: false,
    matched: false,
    message: '作业票已过期，需今日重新人工审核',
  };
}

function isManualReviewPassed(manualReview: DailyPermitManualReview): boolean {
  return manualReview.status === 'passed';
}

function hasMatchedManualReviewFingerprint(
  manualReview: DailyPermitManualReview,
): boolean {
  const fingerprint = normalizeText(manualReview.fingerprint || '');
  const expectedFingerprint = normalizeText(
    manualReview.expectedFingerprint || '',
  );
  return Boolean(
    fingerprint && expectedFingerprint && fingerprint === expectedFingerprint,
  );
}

function buildManualReviewDrivenVerification({
  definition,
  sourceText,
  sourceFollowupRecordId,
  files,
  manualReview,
  validFromDate,
  expiryDate,
  referenceDate,
}: {
  definition: DailyPermitDefinition;
  sourceText: string | null;
  sourceFollowupRecordId: string | null;
  files: ConstructionAttachmentFile[];
  manualReview: DailyPermitManualReview;
  validFromDate: Date | null;
  expiryDate: Date | null;
  referenceDate: Date;
}): DailyPermitVerification | null {
  if (files.length === 0) {
    return null;
  }
  const expiryDateLabel = expiryDate ? formatDateKey(expiryDate) : null;
  const daysUntilExpiry = expiryDate
    ? getSignedDayDiff(expiryDate, referenceDate)
    : null;
  const needsExpiredPermitReview = Boolean(
    expiryDate && daysUntilExpiry !== null && daysUntilExpiry < 0,
  );

  if (
    needsExpiredPermitReview &&
    manualReview.status === 'passed' &&
    manualReview.validUntil
  ) {
    const expiredPermitDate = expiryDate ? formatMonthDay(expiryDate) : '';
    return {
      ...definition,
      status: 'expired',
      expiryDate: expiryDateLabel,
      daysUntilExpiry,
      sourceText,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: true,
      blocksProcess: true,
      message: `${definition.label}人工确认有效期已过期（有效期至 ${expiredPermitDate}），请上传续期作业票。`,
    };
  }

  if (
    needsExpiredPermitReview &&
    (manualReview.status === 'passed' || manualReview.status === 'stale') &&
    !hasMatchedManualReviewFingerprint(manualReview)
  ) {
    const expiredPermitDate = expiryDate ? formatMonthDay(expiryDate) : '';
    return {
      ...definition,
      status: 'pendingReview',
      expiryDate: expiryDateLabel,
      daysUntilExpiry,
      sourceText,
      sourceFollowupRecordId,
      files,
      manualReview: requireManualReviewForExpiredPermit(manualReview),
      requiresRenewal: false,
      blocksProcess: true,
      message: `${definition.label}已过期（有效期至 ${expiredPermitDate}），需今日重新人工审核。`,
    };
  }

  if (isManualReviewPassed(manualReview)) {
    const daysUntilValidFrom = validFromDate
      ? getSignedDayDiff(validFromDate, referenceDate)
      : null;
    if (daysUntilValidFrom !== null && daysUntilValidFrom > 0) {
      return {
        ...definition,
        status: 'notStarted',
        expiryDate: expiryDateLabel,
        daysUntilExpiry,
        sourceText,
        sourceFollowupRecordId,
        files,
        manualReview,
        requiresRenewal: true,
        blocksProcess: true,
        message: `${definition.label}尚未生效（有效期自 ${formatMonthDay(validFromDate!)} 起）。`,
      };
    }
    return buildManualReviewOverrideVerification({
      definition,
      sourceText,
      sourceFollowupRecordId,
      files,
      manualReview,
      expiryDate: expiryDateLabel,
      daysUntilExpiry,
    });
  }

  if (manualReview.status === 'rejected') {
    return {
      ...definition,
      status: 'invalid',
      expiryDate: expiryDateLabel,
      daysUntilExpiry,
      sourceText,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: true,
      blocksProcess: true,
      message: `${definition.label}人工审核驳回，请按审核要求重新上传。`,
    };
  }

  if (manualReview.status === 'pending' || manualReview.status === 'stale') {
    return {
      ...definition,
      status: 'pendingReview',
      expiryDate: expiryDateLabel,
      daysUntilExpiry,
      sourceText,
      sourceFollowupRecordId,
      files,
      manualReview,
      requiresRenewal: false,
      blocksProcess: true,
      message:
        manualReview.status === 'stale'
          ? `${definition.label}作业票已变化，需重新人工审核。`
          : `${definition.label}待人工审核，请在页面选择结果并提交。`,
    };
  }

  return null;
}

function buildManualReviewOverrideVerification({
  definition,
  sourceText,
  sourceFollowupRecordId,
  files,
  manualReview,
  expiryDate = null,
  daysUntilExpiry = null,
}: {
  definition: DailyPermitDefinition;
  sourceText: string | null;
  sourceFollowupRecordId: string | null;
  files: ConstructionAttachmentFile[];
  manualReview: DailyPermitManualReview;
  expiryDate?: string | null;
  daysUntilExpiry?: number | null;
}): DailyPermitVerification {
  return {
    ...definition,
    status: 'valid',
    expiryDate,
    daysUntilExpiry,
    sourceText,
    sourceFollowupRecordId,
    files,
    manualReview,
    requiresRenewal: false,
    blocksProcess: false,
    message: `${definition.label}人工审核通过。`,
  };
}

function buildDailyPermitManualReviewFingerprint(
  files: readonly ConstructionAttachmentFile[],
  expiryDate: Date | null,
  referenceDate: Date,
  source: 'ai' | 'manual' = 'ai',
  validFromDate: Date | null = null,
): string | null {
  const tokens = files
    .map((file) => normalizeText(file.fileToken))
    .filter(Boolean)
    .sort();
  const expiry = expiryDate ? formatDateKey(expiryDate) : '';
  const validFrom = validFromDate ? formatDateKey(validFromDate) : '';
  const reviewDate =
    expiryDate && getSignedDayDiff(expiryDate, referenceDate) < 0
      ? formatDateKey(referenceDate)
      : '';
  if (tokens.length === 0 && !expiry && !reviewDate) {
    return null;
  }
  if (source === 'manual' && expiry) {
    if (validFrom) {
      return `v3:${validFrom}:${expiry}:${hashDailyPermitManualReviewBasis(
        JSON.stringify({ tokens, validFrom, expiry }),
      )}`;
    }
    return `v2:${expiry}:${hashDailyPermitManualReviewBasis(
      JSON.stringify({ tokens, expiry }),
    )}`;
  }
  const basis = reviewDate
    ? { tokens, expiry, reviewDate }
    : { tokens, expiry };
  return `v1:${hashDailyPermitManualReviewBasis(
    JSON.stringify(basis),
  )}`;
}

function hashDailyPermitManualReviewBasis(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function isAuditApproved(text: string): boolean {
  if (isAuditRejected(text)) {
    return false;
  }
  return /(?:审核结果|视觉审核|结论|状态)[:：]\s*通过/.test(text);
}

function isAuditRejected(text: string): boolean {
  const businessText = stripTechnicalAuditFailureText(text);
  return /(?:审核结果|视觉审核|结论|状态)[:：]\s*(?:不通过|未通过)|无效|缺失|缺少|不符合|失败|驳回|异常|未识别[^。；，,、]*(?:许可证|作业票|作业证)/.test(
    businessText,
  );
}

const AUDIT_FIELD_LABELS = [
  '核验日期',
  '核验版本',
  '问题清单',
  '审核结果',
  '视觉审核',
  '有效期至',
  '有效期',
  '结论',
  '状态',
  '说明',
  '摘要',
  '建议',
  '问题',
  '审核对象',
  '要求',
  '视觉审核失败',
] as const;
const AUDIT_FIELD_BOUNDARY_PATTERN =
  AUDIT_FIELD_LABELS.map(escapeRegExp).join('|');

function extractAuditField(text: string, labels: readonly string[]): string {
  if (!text) {
    return '';
  }
  const labelPattern = labels.map(escapeRegExp).join('|');
  const match = new RegExp(
    `(?:^|[；;、，,]\\s*)(${labelPattern})[:：]\\s*`,
  ).exec(text);
  if (!match) {
    return '';
  }
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const nextLabelIndex = rest.search(
    new RegExp(`[；;、，,]\\s*(?:${AUDIT_FIELD_BOUNDARY_PATTERN})[:：]`),
  );
  return nextLabelIndex >= 0 ? rest.slice(0, nextLabelIndex) : rest;
}

function sanitizeAuditDetail(value: string): string {
  return stripTechnicalAuditFailureText(value)
    .replace(/^[:：\s]+/, '')
    .replace(/[；;、，,\s]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripTechnicalAuditFailureText(text: string): string {
  return text
    .replace(/(?:^|[；;、，,]\s*)视觉审核失败[:：][^；;。]*/g, '')
    .trim();
}

function isPermitAttachmentGroup(
  group: ConstructionAttachmentGroup,
  definition: DailyPermitDefinition,
): boolean {
  const text = normalizeText(`${group.field} ${group.label}`);
  return definition.aliases.some((alias) => text.includes(alias));
}

function extractPermitExpiryDate(
  text: string,
  referenceDate: Date,
): Date | null {
  const compactRangeDates = collectCompactRangeEndDates(text, referenceDate);
  if (compactRangeDates.length > 0) {
    return getLatestDate(compactRangeDates);
  }

  const contextualDates = collectContextualExpiryDates(text, referenceDate);
  if (contextualDates.length > 0) {
    return getLatestDate(contextualDates);
  }

  const allDates = collectDateMatches(
    text,
    referenceDate,
    /((?:\d{4}\s*[年./-]\s*)?\d{1,2}\s*(?:月|[./-])\s*\d{1,2}\s*(?:日|号)?)/g,
  );
  return getLatestDate(allDates);
}

function collectContextualExpiryDates(
  text: string,
  referenceDate: Date,
): Date[] {
  const normalized = normalizeDigits(text);
  const dates: Date[] = [];
  const keywordPattern =
    /(?:有效期|有效日期|有效时间|有效截止|许可期限|作业期限|截止日期|到期日期|到期)/g;

  for (const match of normalized.matchAll(keywordPattern)) {
    const startIndex = match.index ?? 0;
    const segment = normalized.slice(startIndex, startIndex + 96);
    dates.push(
      ...collectDateMatches(
        segment,
        referenceDate,
        /((?:\d{4}\s*[年./-]\s*)?\d{1,2}\s*(?:月|[./-])\s*\d{1,2}\s*(?:日|号)?)/g,
      ),
    );
  }

  return dates;
}

function collectDateMatches(
  text: string,
  referenceDate: Date,
  pattern: RegExp,
): Date[] {
  const normalized = normalizeDigits(text);
  const dates: Date[] = [];
  for (const match of normalized.matchAll(pattern)) {
    const parsed = parsePermitDate(match[1], referenceDate);
    if (parsed) {
      dates.push(parsed);
    }
  }
  return dates;
}

function collectCompactRangeEndDates(
  text: string,
  referenceDate: Date,
): Date[] {
  const normalized = normalizeDigits(text);
  const defaultYear = getDefaultYear(normalized, referenceDate);
  const dates: Date[] = [];
  for (const match of normalized.matchAll(
    /(?:(\d{4})\s*(?:年|[-/.])\s*)?(\d{1,2})\s*(?:月|[.])\s*(\d{1,2})\s*(?:日|号)?\s*(?:[-~～—–至到])\s*(?:(\d{4})\s*(?:年|[-/.])\s*)?(\d{1,2})\s*(?:月|[.])\s*(\d{1,2})\s*(?:日|号)?/g,
  )) {
    const year = Number(match[4] || match[1] || defaultYear);
    const parsed = parsePermitDate(`${year}-${match[5]}-${match[6]}`, referenceDate);
    if (parsed) {
      dates.push(parsed);
    }
  }
  return dates;
}

function getDefaultYear(text: string, referenceDate: Date): number {
  const match = /\d{4}/.exec(text);
  return match ? Number(match[0]) : referenceDate.getFullYear();
}

function parsePermitDate(value: string, referenceDate: Date): Date | null {
  const normalized = normalizeDigits(value).replace(/\s+/g, '');
  const match = normalized.match(
    /^(?:(\d{4})[年./-])?(\d{1,2})(?:月|[./-])(\d{1,2})(?:日|号)?$/,
  );
  if (!match) {
    return null;
  }
  const year = match[1] ? Number(match[1]) : referenceDate.getFullYear();
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isFinite(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function getLatestDate(dates: Date[]): Date | null {
  if (dates.length === 0) {
    return null;
  }
  return [...dates].sort((left, right) => right.getTime() - left.getTime())[0];
}

function getSignedDayDiff(later: Date, earlier: Date): number {
  return Math.round(
    (startOfDay(later).getTime() - startOfDay(earlier).getTime()) / MS_PER_DAY,
  );
}

function startOfDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function getDateTime(value?: string | null): number {
  if (!value) {
    return 0;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function formatDateKey(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatMonthDay(value: Date): string {
  return `${value.getMonth() + 1}/${value.getDate()}`;
}

function normalizeText(value: string): string {
  return normalizeDigits(String(value || '').trim());
}

function normalizeDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 48),
  );
}
