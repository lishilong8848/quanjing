import { accessBuildings, canAccessBuilding, buildingScopeKey } from '@shared/building-access';
import type {
  PurchaseApplicationBatchRequest,
  PurchaseApplicationItemInput,
  PurchaseApplicationSharedInput,
  PurchaseApplicationSubmissionResponse,
  PurchaseApplicationValidationIssue,
  PurchaseBuilding,
  ProcurementForm,
} from '@shared/purchase-application.interface';
import type {
  AccessPrincipal,
} from '@shared/access-control.interface';

const PURCHASE_APPLICATION_DRAFT_KEY_PREFIX =
  'purchase-inventory.application-draft.v2';
const PURCHASE_APPLICATION_SUBMISSION_JOURNAL_KEY_PREFIX =
  'purchase-inventory.application-submission.v1';

type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type JournalPrincipal = AccessPrincipal & {
  principalFingerprint?: string | null;
};

export interface PurchaseApplicationAttachmentManifest {
  name: string;
  type: string;
  size: number;
  sha256: string;
}

export interface PurchaseApplicationSubmissionJournal {
  version: 1;
  mutationId: string;
  fingerprint: string;
  request: PurchaseApplicationBatchRequest;
  attachments: PurchaseApplicationAttachmentManifest[];
  status: 'submitting' | 'accepted' | 'uncertain';
  taskId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PurchaseApplicationFingerprintFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface GroupedValidationIssues {
  shared: Record<string, string>;
  items: Record<string, Record<string, string>>;
  general: string[];
}

let fallbackLineSequence = 0;

export function createBlankDraft(
  purchaseBuilding: PurchaseBuilding | null = null,
): PurchaseApplicationBatchRequest {
  return {
    shared: {
      applicantRecordId: '',
      applicantOpenId: '',
      applicantName: '',
      applicantEmployeeNo: '',
      applicantPosition: '',
      applicantBuilding: '',
      building: purchaseBuilding || 'H楼',
      specialty: '其他',
      purchaseMethod: '综合采购',
      purchaseChannel: '线下',
      supplier: '',
      onlineUrl: '',
      procurementForm: '三方比价',
      comparisonSatisfied: '是',
      singleReason: '',
      requirementSummary: '',
      expectedDeliveryDate: '',
      immediateOutbound: false,
      notes: '',
    },
    items: [createBlankItem()],
  };
}

export function createBlankItem(): PurchaseApplicationItemInput {
  return {
    lineId: createLineId(),
    mode: 'existing',
    catalogRecordId: '',
    sku: '',
    primaryCategory: '',
    secondaryCategory: '',
    itemName: '',
    specification: '',
    brand: '',
    quantity: 1,
    unit: '',
    unitPrice: 0,
    shippingFee: 0,
    discount: 0,
    onlineUrls: [''],
  };
}

export function changePurchaseChannel(
  shared: PurchaseApplicationSharedInput,
  purchaseChannel: PurchaseApplicationSharedInput['purchaseChannel'],
): PurchaseApplicationSharedInput {
  return {
    ...shared,
    purchaseChannel,
    onlineUrl: purchaseChannel === '线上' ? shared.onlineUrl : '',
  };
}

export function changeProcurementForm(
  shared: PurchaseApplicationSharedInput,
  procurementForm: ProcurementForm,
): PurchaseApplicationSharedInput {
  return {
    ...shared,
    procurementForm,
    comparisonSatisfied: procurementForm === '单一采购' ? '否' : '是',
    singleReason: procurementForm === '单一采购' ? shared.singleReason : '',
  };
}

export function selectPurchaseComparisonFiles<T>(
  procurementForm: ProcurementForm,
  files: readonly T[],
): T[] {
  return procurementForm === '三方比价' ? [...files] : [];
}

export function applyProcurementFormSelection<T>(
  shared: PurchaseApplicationSharedInput,
  files: readonly T[],
  procurementForm: ProcurementForm,
) {
  return {
    nextShared: changeProcurementForm(shared, procurementForm),
    nextFiles: selectPurchaseComparisonFiles(procurementForm, files),
    clearedErrorFields: [
      'procurementForm',
      'singleReason',
      'comparisonAttachment',
      'comparisonSatisfied',
    ] as const,
  };
}

export function buildPurchaseApplicationRetryDraft(
  submissionDraft: PurchaseApplicationBatchRequest,
  failedLineIds: readonly string[],
): PurchaseApplicationBatchRequest {
  const failedIds = new Set(failedLineIds.filter((lineId) => lineId.trim()));
  const failedItems = submissionDraft.items.filter((item) =>
    failedIds.has(item.lineId),
  );
  return failedItems.length
    ? { ...submissionDraft, items: failedItems }
    : submissionDraft;
}

export function duplicateItem(
  items: PurchaseApplicationItemInput[],
  lineId: string,
): PurchaseApplicationItemInput[] {
  const index = items.findIndex((item) => item.lineId === lineId);
  if (index < 0 || items.length >= 20) return items;
  const duplicate = {
    ...items[index],
    lineId: createLineId(),
    onlineUrls: [...(items[index].onlineUrls || [])],
  };
  return [...items.slice(0, index + 1), duplicate, ...items.slice(index + 1)];
}

export function removeItem(
  items: PurchaseApplicationItemInput[],
  lineId: string,
): PurchaseApplicationItemInput[] {
  if (items.length <= 1) return items;
  return items.filter((item) => item.lineId !== lineId);
}

export function calculateDraftTotals(items: PurchaseApplicationItemInput[]) {
  const goodsAmount = items.reduce(
    (sum, item) => sum + finite(item.quantity) * finite(item.unitPrice),
    0,
  );
  const shippingFee = items.reduce(
    (sum, item) => sum + finite(item.shippingFee),
    0,
  );
  const discount = items.reduce((sum, item) => sum + finite(item.discount), 0);
  return {
    itemKinds: items.length,
    quantity: items.reduce((sum, item) => sum + finite(item.quantity), 0),
    goodsAmount: money(goodsAmount),
    shippingFee: money(shippingFee),
    discount: money(discount),
    total: money(goodsAmount + shippingFee - discount),
  };
}

export function normalizePurchaseQuantityInput(value: string | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

export function isUncertainPurchaseSubmissionError(error: unknown): boolean {
  if (!isRecord(error) || !isRecord(error.response)) return true;
  const status = Number(error.response.status);
  return (
    !Number.isFinite(status) ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

export type PurchaseApplicationAcceptanceReconnectResult =
  | {
      kind: 'accepted';
      accepted: PurchaseApplicationSubmissionResponse;
    }
  | {
      kind: 'definitely-not-written' | 'uncertain';
      message: string;
    };

export async function reconnectPurchaseApplicationAcceptance(options: {
  reconnect: () => Promise<PurchaseApplicationSubmissionResponse>;
  delaysMs?: readonly number[];
  wait?: (durationMs: number) => Promise<void>;
}): Promise<PurchaseApplicationAcceptanceReconnectResult> {
  const delaysMs = options.delaysMs?.length
    ? options.delaysMs
    : [0, 400, 1_200, 2_400];
  const wait = options.wait || waitForReconnectDelay;
  let lastMessage = '原采购申请受理结果仍未确认';
  for (const delayMs of delaysMs) {
    if (delayMs > 0) await wait(delayMs);
    try {
      const accepted = await options.reconnect();
      if (
        accepted?.pending === true &&
        typeof accepted.taskId === 'string' &&
        accepted.taskId.trim()
      ) {
        return { kind: 'accepted', accepted };
      }
      lastMessage = '原采购申请受理响应格式无效';
    } catch (error) {
      const response =
        isRecord(error) && isRecord(error.response) ? error.response : {};
      const data = isRecord(response.data) ? response.data : {};
      const responseMessage =
        typeof data.message === 'string' && data.message.trim()
          ? data.message.trim()
          : error instanceof Error && error.message.trim()
            ? error.message.trim()
            : lastMessage;
      if (data.definitelyNotWritten === true) {
        return {
          kind: 'definitely-not-written',
          message: responseMessage,
        };
      }
      if (!isUncertainPurchaseSubmissionError(error)) {
        return { kind: 'uncertain', message: responseMessage };
      }
      lastMessage = responseMessage;
    }
  }
  return { kind: 'uncertain', message: lastMessage };
}

function waitForReconnectDelay(durationMs: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, durationMs));
}

export async function buildPurchaseApplicationSubmissionFingerprint(
  payload: PurchaseApplicationBatchRequest,
  files: readonly PurchaseApplicationFingerprintFile[],
): Promise<{
  fingerprint: string;
  attachments: PurchaseApplicationAttachmentManifest[];
}> {
  const attachments = await Promise.all(
    files.map(async (file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      sha256: await sha256Hex(await file.arrayBuffer()),
    })),
  );
  const fingerprint = await sha256Hex(
    new TextEncoder().encode(
      stableSerializePurchaseSubmission({ payload, attachments }),
    ),
  );
  return { fingerprint, attachments };
}

export function matchesPurchaseApplicationAttachmentManifest(
  files: readonly Pick<
    PurchaseApplicationFingerprintFile,
    'name' | 'type' | 'size'
  >[],
  attachments: readonly PurchaseApplicationAttachmentManifest[],
): boolean {
  return (
    files.length === attachments.length &&
    files.every((file, index) => {
      const attachment = attachments[index];
      return (
        file.name === attachment.name &&
        file.type === attachment.type &&
        file.size === attachment.size
      );
    })
  );
}

export function savePurchaseApplicationSubmissionJournal(
  journal: PurchaseApplicationSubmissionJournal,
  principal: JournalPrincipal,
  storage: DraftStorage = window.localStorage,
): void {
  storage.setItem(
    getPurchaseApplicationSubmissionJournalKey(principal),
    JSON.stringify({
      ...journal,
      request: scopePurchaseApplicationDraft(principal, journal.request),
    }),
  );
}

export function loadPurchaseApplicationSubmissionJournal(
  principal: JournalPrincipal,
  storage: DraftStorage = window.localStorage,
): PurchaseApplicationSubmissionJournal | null {
  const serialized = storage.getItem(
    getPurchaseApplicationSubmissionJournalKey(principal),
  );
  if (!serialized) return null;
  try {
    const value: unknown = JSON.parse(serialized);
    if (!isValidPurchaseApplicationSubmissionJournal(value)) return null;
    const request = normalizePersistedPurchaseDraft(value.request, principal);
    if (!request) return null;
    return {
      ...value,
      request,
      attachments: value.attachments.map((attachment) => ({ ...attachment })),
    };
  } catch {
    return null;
  }
}

export function clearPurchaseApplicationSubmissionJournal(
  principal: JournalPrincipal,
  storage: DraftStorage = window.localStorage,
): void {
  storage.removeItem(getPurchaseApplicationSubmissionJournalKey(principal));
}

export function getPurchaseApplicationSubmissionJournalKey(
  principal: JournalPrincipal,
): string {
  const subject =
    principal.role === 'purchase_applicant'
      ? `${principal.role}.${buildingScopeKey(principal) || 'unassigned'}`
      : principal.role;
  const session = encodeURIComponent(
    principal.principalFingerprint?.trim() || 'session-unavailable',
  );
  return `${PURCHASE_APPLICATION_SUBMISSION_JOURNAL_KEY_PREFIX}.${subject}.${session}`;
}

export function saveDraft(
  draft: PurchaseApplicationBatchRequest,
  principal: AccessPrincipal,
  storage: DraftStorage = window.localStorage,
): void {
  storage.setItem(
    getPurchaseApplicationDraftKey(principal),
    JSON.stringify(scopePurchaseApplicationDraft(principal, draft)),
  );
}

export function loadDraft(
  principal: AccessPrincipal,
  storage: DraftStorage = window.localStorage,
): PurchaseApplicationBatchRequest | null {
  const serialized = storage.getItem(getPurchaseApplicationDraftKey(principal));
  if (!serialized) return null;
  try {
    return normalizePersistedPurchaseDraft(JSON.parse(serialized), principal);
  } catch {
    return null;
  }
}

export function clearDraft(
  principal: AccessPrincipal,
  storage: DraftStorage = window.localStorage,
): void {
  storage.removeItem(getPurchaseApplicationDraftKey(principal));
}

export function getPurchaseApplicationDraftKey(
  principal: AccessPrincipal,
): string {
  const subject =
    principal.role === 'purchase_applicant'
      ? `${principal.role}.${buildingScopeKey(principal) || 'unassigned'}`
      : principal.role;
  return `${PURCHASE_APPLICATION_DRAFT_KEY_PREFIX}.${subject}`;
}

export function scopePurchaseApplicationDraft(
  principal: AccessPrincipal,
  draft: PurchaseApplicationBatchRequest,
): PurchaseApplicationBatchRequest {
  if ((principal.role !== 'purchase_applicant' && principal.role !== 'building_admin') || canAccessBuilding(principal, draft.shared.building)) {
    return draft;
  }
  return {
    ...draft,
    shared: {
      ...draft.shared,
      building: (accessBuildings(principal)?.[0] || principal.purchaseBuilding) as PurchaseBuilding,
    },
  };
}

export function groupValidationIssues(
  issues: PurchaseApplicationValidationIssue[],
): GroupedValidationIssues {
  const grouped: GroupedValidationIssues = {
    shared: {},
    items: {},
    general: [],
  };
  for (const issue of issues) {
    if (issue.lineId) {
      const fields = (grouped.items[issue.lineId] ||= {});
      fields[lastPathSegment(issue.path)] ||= issue.message;
    } else if (issue.path.startsWith('shared.')) {
      grouped.shared[lastPathSegment(issue.path)] ||= issue.message;
    } else {
      grouped.general.push(issue.message);
    }
  }
  return grouped;
}

export function validatePurchaseApplicationForUi(
  draft: PurchaseApplicationBatchRequest,
  fileCount: number,
): PurchaseApplicationValidationIssue[] {
  const issues: PurchaseApplicationValidationIssue[] = [];
  const requiredShared: Array<[keyof PurchaseApplicationSharedInput, string]> =
    [
      ['applicantName', '请从在职人员表选择申请人'],
      ['building', '请选择申请楼栋'],
      ['specialty', '请选择专业'],
      ['purchaseMethod', '请选择采购方式'],
      ['purchaseChannel', '请选择采购渠道'],
      ['supplier', '请填写供应商'],
      ['requirementSummary', '请填写需求简述'],
      ['expectedDeliveryDate', '请选择期望交付时间'],
    ];
  requiredShared.forEach(([key, message]) => {
    if (!String(draft.shared[key] ?? '').trim()) {
      issues.push({ code: 'REQUIRED', path: `shared.${key}`, message });
    }
  });
  if (!isProcurementForm(draft.shared.procurementForm)) {
    issues.push({
      code: 'REQUIRED',
      path: 'shared.procurementForm',
      message: '请选择采购形式',
    });
  }
  if (
    draft.shared.procurementForm === '单一采购' &&
    !draft.shared.singleReason.trim()
  ) {
    issues.push({
      code: 'REQUIRED',
      path: 'shared.singleReason',
      message: '请填写单一采购原因',
    });
  }
  if (
    draft.shared.procurementForm === '三方比价' &&
    draft.shared.purchaseChannel === '线下' &&
    fileCount === 0
  ) {
    issues.push({
      code: 'REQUIRED_COMPARISON_ATTACHMENT',
      path: 'shared.comparisonAttachment',
      message: '线下采购必须上传三方比价单',
    });
  }
  draft.items.forEach((item) => {
    const add = (path: string, message: string) =>
      issues.push({ code: 'INVALID_ITEM', path, message, lineId: item.lineId });
    if (!item.primaryCategory) add('primaryCategory', '请选择一级分类');
    if (!item.secondaryCategory) add('secondaryCategory', '请选择二级分类');
    if (!item.itemName || (item.mode === 'existing' && !item.catalogRecordId)) {
      add(
        'itemName',
        item.mode === 'existing'
          ? '请从目录选择已有物品'
          : '请填写新增物品名称',
      );
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      add('quantity', '数量必须为正整数');
    }
    if (!item.unit.trim()) add('unit', '请填写单位');
    if (draft.shared.purchaseChannel === '线上') {
      const links = (item.onlineUrls || [])
        .map((url) => url.trim())
        .filter(Boolean);
      if (!links.length) {
        add('onlineUrls', '每个物品至少填写 1 个采购链接');
      } else if (links.length > 3) {
        add('onlineUrls', '每个物品最多 3 个采购链接');
      } else if (links.some((url) => !/^https?:\/\//i.test(url))) {
        add('onlineUrls', '请填写有效的 http 或 https 链接');
      }
    }
    if (item.unitPrice < 0) add('unitPrice', '单价不得为负数');
    if (item.shippingFee < 0) add('shippingFee', '运费不得为负数');
    if (
      item.discount < 0 ||
      item.discount > item.quantity * item.unitPrice + item.shippingFee
    ) {
      add('discount', '减免金额无效');
    }
  });
  return issues;
}

function createLineId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  fallbackLineSequence += 1;
  return `purchase-line-${Date.now()}-${fallbackLineSequence}`;
}

function lastPathSegment(path: string): string {
  return path.split('.').filter(Boolean).pop() || path;
}

function isProcurementForm(value: unknown): value is ProcurementForm {
  return value === '三方比价' || value === '单一采购';
}

function normalizePersistedPurchaseDraft(
  value: unknown,
  principal: AccessPrincipal,
): PurchaseApplicationBatchRequest | null {
  if (!isRecord(value) || !isRecord(value.shared)) return null;
  if (!Array.isArray(value.items) || !value.items.length) return null;
  const draft = value as unknown as PurchaseApplicationBatchRequest;
  const persistedShared =
    value.shared as Partial<PurchaseApplicationSharedInput> &
      Record<string, unknown>;
  const hasPersistedProcurementForm = Object.prototype.hasOwnProperty.call(
    persistedShared,
    'procurementForm',
  );
  const procurementForm: ProcurementForm = hasPersistedProcurementForm
    ? isProcurementForm(persistedShared.procurementForm)
      ? persistedShared.procurementForm
      : '三方比价'
    : persistedShared.comparisonSatisfied === '否'
      ? '单一采购'
      : '三方比价';
  const restored: PurchaseApplicationBatchRequest = {
    ...draft,
    shared: {
      ...createBlankDraft().shared,
      ...draft.shared,
      procurementForm,
      comparisonSatisfied: procurementForm === '单一采购' ? '否' : '是',
      singleReason:
        procurementForm === '单一采购' &&
        typeof persistedShared.singleReason === 'string'
          ? persistedShared.singleReason
          : '',
    },
    items: value.items.map(normalizePersistedPurchaseItem),
  };
  if (
    (principal.role === 'purchase_applicant' || principal.role === 'building_admin') &&
    !canAccessBuilding(principal, restored.shared.building)
  ) {
    return null;
  }
  return scopePurchaseApplicationDraft(principal, restored);
}

function isValidPurchaseApplicationSubmissionJournal(
  value: unknown,
): value is PurchaseApplicationSubmissionJournal {
  if (!isRecord(value) || value.version !== 1) return false;
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(value.mutationId || ''))) {
    return false;
  }
  if (!/^[a-f0-9]{64}$/.test(String(value.fingerprint || ''))) return false;
  if (!['submitting', 'accepted', 'uncertain'].includes(String(value.status))) {
    return false;
  }
  if (
    value.taskId !== null &&
    (typeof value.taskId !== 'string' ||
      !/^[A-Za-z0-9_-]{1,200}$/.test(value.taskId))
  ) {
    return false;
  }
  if (
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    return false;
  }
  if (!Array.isArray(value.attachments) || value.attachments.length > 5) {
    return false;
  }
  return value.attachments.every(
    (attachment) =>
      isRecord(attachment) &&
      typeof attachment.name === 'string' &&
      typeof attachment.type === 'string' &&
      Number.isInteger(attachment.size) &&
      Number(attachment.size) >= 0 &&
      typeof attachment.sha256 === 'string' &&
      /^[a-f0-9]{64}$/.test(attachment.sha256),
  );
}

function stableSerializePurchaseSubmission(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => stableSerializePurchaseSubmission(item))
      .join(',')}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort((left, right) => left.localeCompare(right))
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableSerializePurchaseSubmission(value[key])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function sha256Hex(value: BufferSource): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', value);
    return bytesToHex(new Uint8Array(digest));
  }
  const cryptoJsModule = await import('crypto-js');
  const CryptoJS = cryptoJsModule.default ?? cryptoJsModule;
  const bytes = toUint8Array(value);
  const words: number[] = [];
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const wordIndex = index >>> 2;
    words[wordIndex] =
      (words[wordIndex] || 0) | (bytes[index] << (24 - (index % 4) * 8));
  }
  const wordArray = CryptoJS.lib.WordArray.create(words, bytes.byteLength);
  return CryptoJS.SHA256(wordArray).toString(CryptoJS.enc.Hex);
}

function toUint8Array(value: BufferSource): Uint8Array {
  return value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function normalizePersistedPurchaseItem(
  value: unknown,
): PurchaseApplicationItemInput {
  const persisted = isRecord(value) ? value : {};
  const blank = createBlankItem();
  const lineId =
    typeof persisted.lineId === 'string' ? persisted.lineId.trim() : '';
  return {
    lineId: lineId || blank.lineId,
    mode:
      persisted.mode === 'new' || persisted.mode === 'custom'
        ? 'new'
        : 'existing',
    catalogRecordId: persistedString(persisted.catalogRecordId),
    sku: persistedString(persisted.sku),
    primaryCategory: persistedString(persisted.primaryCategory),
    secondaryCategory: persistedString(persisted.secondaryCategory),
    itemName: persistedString(persisted.itemName),
    specification: persistedString(persisted.specification),
    brand: persistedString(persisted.brand),
    quantity: persistedFiniteNumber(persisted.quantity, blank.quantity),
    unit: persistedString(persisted.unit),
    unitPrice: persistedFiniteNumber(persisted.unitPrice, blank.unitPrice),
    shippingFee: persistedFiniteNumber(
      persisted.shippingFee,
      blank.shippingFee,
    ),
    discount: persistedFiniteNumber(persisted.discount, blank.discount),
    onlineUrls: persistedStringArray(
      persisted.onlineUrls,
      blank.onlineUrls || [''],
    ),
  };
}

function persistedString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function persistedStringArray(
  value: unknown,
  fallback: readonly string[],
): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') return [value];
  return [...fallback];
}

function persistedFiniteNumber(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function money(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
