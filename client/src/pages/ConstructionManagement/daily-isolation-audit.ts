export interface DailyIsolationAuditDetail {
  label: string;
  value: string;
  tone: 'success' | 'issue' | 'neutral';
}

export interface DailyIsolationAuditSummary {
  tone: 'success' | 'issue';
  title: string;
  description: string;
  rawText: string;
  details: DailyIsolationAuditDetail[];
}

export function buildDailyIsolationAuditSummary(
  feedback?: string | null,
): DailyIsolationAuditSummary | null {
  const text = String(feedback || '').trim();
  if (!text) {
    return null;
  }

  const issue = isIsolationAuditIssue(text);
  const details = parseIsolationAuditDetails(text);
  return {
    tone: issue ? 'issue' : 'success',
    title: issue ? '挂牌隔离AI审核：需复核' : '挂牌隔离AI审核：通过',
    description: summarizeIsolationAuditFeedback(text, details),
    rawText: text,
    details,
  };
}

function parseIsolationAuditDetails(text: string): DailyIsolationAuditDetail[] {
  return text
    .split(/[｜|]/)
    .map((part) => part.trim())
    .map((part) => part.match(/^(结论|水印核验|现场核验)[:：]\s*(.*)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => normalizeIsolationAuditDetail(match[1], match[2].trim()))
    .filter(Boolean);
}

function normalizeIsolationAuditDetail(
  label: string,
  value: string,
): DailyIsolationAuditDetail {
  const normalizedValue = normalizeWatermarkAuditDisplayValue(label, value);
  return {
    label,
    value: normalizedValue,
    tone: getIsolationAuditDetailTone(normalizedValue),
  };
}

function normalizeWatermarkAuditDisplayValue(
  label: string,
  value: string,
): string {
  if (
    label === '水印核验' &&
    /^不通过/.test(value) &&
    hasOnlyContextWatermarkMissingItems(value)
  ) {
    return '通过';
  }

  return value;
}

function hasOnlyContextWatermarkMissingItems(value: string): boolean {
  const missingMatch = value.match(/缺失[:：]([^）)]*)/);
  if (!missingMatch) {
    return false;
  }

  const missingText = missingMatch[1];
  if (/世纪互联|VNET|logo|标识/i.test(missingText)) {
    return false;
  }

  return /项目|机房|标题|区域|工作内容|拍摄时间|时间|地点/.test(missingText);
}

function summarizeIsolationAuditFeedback(
  text: string,
  details: DailyIsolationAuditDetail[],
): string {
  const keyParts = details
    .map(
      (detail) => `${detail.label}：${stripIsolationAuditDetail(detail.value)}`,
    )
    .filter(Boolean);

  if (keyParts.length > 0) {
    return keyParts.slice(0, 3).join('；');
  }

  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function stripIsolationAuditDetail(value: string): string {
  return value.replace(/[（(].*$/, '').trim();
}

function getIsolationAuditDetailTone(
  value: string,
): DailyIsolationAuditDetail['tone'] {
  if (isIsolationAuditIssue(value)) {
    return 'issue';
  }
  if (/通过|已完成|正常|合格|无异常/.test(value)) {
    return 'success';
  }
  return 'neutral';
}

function isIsolationAuditIssue(text: string): boolean {
  return /不通过|需复核|缺失|未识别|异常|失败|无效/.test(text);
}
