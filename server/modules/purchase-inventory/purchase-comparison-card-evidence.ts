import { BadRequestException } from '@nestjs/common';

export interface PurchaseComparisonCardEvidence {
  recordId: string;
  recordUrl: string;
  attachments: Array<{
    name: string;
    disposition: 'preview' | 'original';
    imageKey?: string;
  }>;
}

const RECORD_ID = /^[A-Za-z0-9_-]{1,100}$/u;
const IMAGE_KEY = /^img_[A-Za-z0-9_-]{1,300}$/u;
const MAX_ATTACHMENTS = 5;
const MAX_RECORDS = 20;
const MAX_CARD_BYTES = 30 * 1024;

/** The gateway supplies a verified record link, never a Bitable media token or temporary URL. */
export function normalizePurchaseComparisonCardEvidence(
  value: unknown,
  expectedRecordId?: string,
): PurchaseComparisonCardEvidence {
  if (!record(value) || !exactKeys(value, ['recordId', 'recordUrl', 'attachments']) ||
    typeof value.recordId !== 'string' || !RECORD_ID.test(value.recordId) ||
    (expectedRecordId !== undefined && value.recordId !== expectedRecordId) ||
    !Array.isArray(value.attachments) || value.attachments.length < 1 || value.attachments.length > MAX_ATTACHMENTS) throw invalid();
  const recordUrl = normalizeRecordUrl(value.recordUrl, value.recordId);
  const attachments = value.attachments.map(candidate => {
    if (!record(candidate) || typeof candidate.name !== 'string') throw invalid();
    const originalName = candidate.name.normalize('NFC').trim();
    if (!originalName || Array.from(originalName).length > 255 || /[\u0000-\u001f\u007f-\u009f]/u.test(originalName)) throw invalid();
    const name = originalName;
    if (candidate.disposition === 'preview') {
      if (!exactKeys(candidate, ['name', 'disposition', 'imageKey']) || typeof candidate.imageKey !== 'string' || !IMAGE_KEY.test(candidate.imageKey)) throw invalid();
      return { name, disposition: 'preview' as const, imageKey: candidate.imageKey };
    }
    if (candidate.disposition !== 'original' || !exactKeys(candidate, ['name', 'disposition'])) throw invalid();
    return { name, disposition: 'original' as const };
  });
  return { recordId: value.recordId, recordUrl, attachments };
}

export function normalizePurchaseComparisonBatchEvidence(
  value: unknown,
  allowedRecordIds: readonly string[],
): PurchaseComparisonCardEvidence[] {
  if (!Array.isArray(value) || value.length > MAX_RECORDS) throw invalid();
  const allowed = new Set(allowedRecordIds), seen = new Set<string>();
  let source: string | undefined;
  return value.map(raw => {
    const entry = normalizePurchaseComparisonCardEvidence(raw);
    if (!allowed.has(entry.recordId) || seen.has(entry.recordId)) throw invalid();
    seen.add(entry.recordId);
    const parsed = new URL(entry.recordUrl);
    const currentSource = `${parsed.origin}${parsed.pathname}?table=${parsed.searchParams.get('table')}`;
    if (source !== undefined && currentSource !== source) throw invalid();
    source = currentSource;
    return entry;
  });
}

/** Read-only evidence elements add no callbacks, forms or approval actions. */
export function renderPurchaseComparisonCardEvidence(
  value: readonly PurchaseComparisonCardEvidence[],
  recordLabels: Readonly<Record<string, string>> = {},
  options: { previewLimit?: number; nameLimit?: number } = {},
): Record<string, unknown>[] {
  if (!value.length) return [];
  const evidence = normalizePurchaseComparisonBatchEvidence(value, value.map(entry => entry.recordId));
  const groups = new Map<string, PurchaseComparisonCardEvidence[]>();
  for (const entry of evidence) {
    // A filename does not identify an original-only attachment. Only image keys
    // establish identical resources across records; retain every original link.
    const fingerprint = entry.attachments.every(attachment => attachment.disposition === 'preview')
      ? JSON.stringify(entry.attachments) : entry.recordId;
    const existing = groups.get(fingerprint);
    if (existing) existing.push(entry);
    else groups.set(fingerprint, [entry]);
  }
  const previewLimit = Math.max(0, Math.min(12, options.previewLimit ?? 12));
  const nameLimit = Math.max(8, Math.min(120, options.nameLimit ?? 120));
  const shortenedNames = evidence.some(entry => entry.attachments.some(attachment => attachment.name.endsWith('…') || Array.from(attachment.name).length > nameLimit));
  const elements: Record<string, unknown>[] = [{ tag: 'markdown', content: (previewLimit ? '**三方比价附件**' : '**三方比价附件清单**\n其余附件请打开原件查看。') +
    (shortenedNames ? '\n文件名有省略，请在原采购单查看完整名称。' : '') }];
  const displayedImages = new Set<string>();
  for (const entries of groups.values()) {
    const first = entries[0]!;
    const links = entries.map(entry => {
      const label = recordLabels[entry.recordId];
      return `[${label ? `${escapeMarkdown(label)} · ` : ''}在原采购单查看](${entry.recordUrl})`;
    });
    if (!previewLimit) {
      elements.push({ tag: 'markdown', content: `${links.join('　')}\n${first.attachments.map((attachment, index) =>
        `${index + 1}. ${escapeMarkdown(displayName(attachment.name, nameLimit))}`).join('\n')}` });
      continue;
    }
    elements.push({ tag: 'markdown', content: `${links.join('　')}${entries.length > 1 ? '\n相同附件仅展示一次，适用于以上采购明细。' : ''}` });
    for (const attachment of first.attachments) {
      const name = displayName(attachment.name, nameLimit);
      const alreadyShown = attachment.imageKey && displayedImages.has(attachment.imageKey);
      const preview = attachment.disposition === 'preview' && !alreadyShown && displayedImages.size < previewLimit;
      elements.push({ tag: 'markdown', content: preview ? escapeMarkdown(name)
        : `${escapeMarkdown(name)} · ${alreadyShown ? '图片已在上方展示' : attachment.disposition === 'original'
          ? '需在原采购单打开原件' : '其余附件请打开原件查看'}` });
      if (preview) {
        displayedImages.add(attachment.imageKey!);
        elements.push({ tag: 'img', img_key: attachment.imageKey,
          alt: { tag: 'plain_text', content: name } });
      }
    }
  }
  return elements;
}

/** Keep the complete original approval controls; only evidence presentation shrinks. */
export function withPurchaseComparisonCardEvidence(
  card: Record<string, unknown>,
  evidence: readonly PurchaseComparisonCardEvidence[],
  recordLabels: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  if (!evidence.length) return card;
  if (!record(card.body) || !Array.isArray(card.body.elements)) throw invalid();
  const elements = card.body.elements;
  for (const [previewLimit, nameLimit] of [[12, 120], [0, 120], [0, 64], [0, 32], [0, 16], [0, 8]]) {
    const attachmentElements = renderPurchaseComparisonCardEvidence(evidence, recordLabels, { previewLimit, nameLimit });
    const result = { ...card, body: { ...card.body, elements: [elements[0], ...attachmentElements, ...elements.slice(1)] } };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_CARD_BYTES) return result;
  }
  throw new BadRequestException('采购卡片内容过长，无法保留全部比价附件关联，请核对采购明细');
}

function normalizeRecordUrl(value: unknown, recordId: string): string {
  if (typeof value !== 'string' || value.length > 600) throw invalid();
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw invalid(); }
  if (parsed.protocol !== 'https:' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.feishu\.cn$/u.test(parsed.hostname) ||
    parsed.hostname === 'open.feishu.cn' || parsed.username || parsed.password || parsed.port || parsed.hash ||
    !/^\/base\/[A-Za-z0-9_-]{8,128}$/u.test(parsed.pathname) ||
    parsed.searchParams.size !== 2 || parsed.searchParams.getAll('table').length !== 1 || parsed.searchParams.getAll('record').length !== 1 ||
    !/^tbl[A-Za-z0-9_-]{1,100}$/u.test(parsed.searchParams.get('table') || '') || parsed.searchParams.get('record') !== recordId) throw invalid();
  const canonical = `${parsed.origin}${parsed.pathname}?table=${parsed.searchParams.get('table')}&record=${recordId}`;
  if (value !== canonical) throw invalid();
  return canonical;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return JSON.stringify(Object.getOwnPropertyNames(value).sort()) === JSON.stringify([...fields].sort());
}
function escapeMarkdown(value: string): string {
  return value.replace(/[&*~><[\]()#:_\\`{}!|+\-]/gu, character => `&#${character.charCodeAt(0)};`);
}
function displayName(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length > limit ? `${characters.slice(0, limit - 1).join('')}…` : value;
}
function invalid(): BadRequestException { return new BadRequestException('采购比价附件卡片快照无效'); }
