import type {
  WeatherGuardRegistrationRequest,
  WeatherGuardRegistrationStatus,
  WeatherWarningBuilding,
} from '@shared/api.interface';

export const WEATHER_GUARD_REGISTRATION_DRAFT_VERSION = 2 as const;
export const WEATHER_GUARD_REGISTRATION_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const WEATHER_GUARD_REGISTRATION_ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
] as const;

export interface WeatherGuardRegistrationEvidenceConstraints {
  acceptedImageTypes: readonly string[];
  maxImageBytes: number;
}

export const DEFAULT_WEATHER_GUARD_REGISTRATION_EVIDENCE_CONSTRAINTS: WeatherGuardRegistrationEvidenceConstraints =
  {
    acceptedImageTypes: WEATHER_GUARD_REGISTRATION_ACCEPTED_IMAGE_TYPES,
    maxImageBytes: WEATHER_GUARD_REGISTRATION_MAX_IMAGE_BYTES,
  };

const RFC_4122_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WEATHER_GUARD_BUILDINGS = new Set<string>([
  'A楼',
  'B楼',
  'C楼',
  'D楼',
  'E楼',
  'H楼',
  '110站',
]);

export interface WeatherGuardRegistrationDraft {
  version: typeof WEATHER_GUARD_REGISTRATION_DRAFT_VERSION;
  warningId: string;
  clientMutationId: string;
  building: WeatherWarningBuilding | null;
  checkerKeys: string[];
  deviceStatus: WeatherGuardRegistrationStatus | null;
  deviceAbnormalDescription: string;
  disasterStatus: WeatherGuardRegistrationStatus | null;
  disasterAbnormalDescription: string;
  environmentStatus: WeatherGuardRegistrationStatus | null;
  environmentAbnormalDescription: string;
  materialsStatus: WeatherGuardRegistrationStatus | null;
  materialsAbnormalDescription: string;
  contactsStatus: WeatherGuardRegistrationStatus | null;
  contactsAbnormalDescription: string;
}

export type WeatherGuardRegistrationEvidenceField =
  | 'deviceEvidence'
  | 'disasterEvidence'
  | 'environmentEvidence';

export interface WeatherGuardRegistrationEvidence {
  deviceEvidence: File | null;
  disasterEvidence: File | null;
  environmentEvidence: File | null;
}

export interface WeatherGuardRegistrationEvidenceIssue {
  field: WeatherGuardRegistrationEvidenceField;
  code: 'required' | 'count' | 'empty' | 'size' | 'type';
  message: string;
}

export interface WeatherGuardRegistrationDraftStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

export interface RestoredWeatherGuardRegistrationDraft {
  draft: WeatherGuardRegistrationDraft;
  evidenceMustBeReselected: true;
}

export interface WeatherGuardRegistrationSubmissionToken {
  clientMutationId: string;
  revision: number;
}

export interface WeatherGuardRegistrationSubmissionGate {
  tryStart: (
    draft: Pick<WeatherGuardRegistrationDraft, 'clientMutationId'>,
    revision: number,
  ) => WeatherGuardRegistrationSubmissionToken | null;
  finish: (token: WeatherGuardRegistrationSubmissionToken) => void;
}

const submissionTokenActivity = new WeakMap<
  WeatherGuardRegistrationSubmissionToken,
  () => boolean
>();

export class WeatherGuardRegistrationEvidenceValidationError extends Error {
  constructor(
    public readonly issues: readonly WeatherGuardRegistrationEvidenceIssue[],
  ) {
    super(issues.map(({ message }) => message).join('；'));
    this.name = 'WeatherGuardRegistrationEvidenceValidationError';
  }
}

export interface WeatherGuardRegistrationDeepLink {
  warningId: string;
  source: 'feishu-card' | 'test-card' | 'page';
}

export interface WeatherGuardRegistrationValidationIssue {
  field: keyof WeatherGuardRegistrationDraft;
  message: string;
}

export function getWeatherGuardRegistrationErrorMessage(
  error: unknown,
): string {
  const response =
    error !== null && typeof error === 'object'
      ? (error as { response?: unknown }).response
      : undefined;
  const data = isPlainRecord(response) ? response.data : undefined;
  const businessMessage = isPlainRecord(data) ? data.message : undefined;

  if (typeof businessMessage === 'string' && businessMessage.trim()) {
    return businessMessage.trim();
  }
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return '服务暂时不可用，请稍后重试。';
}

export class WeatherGuardRegistrationValidationError extends Error {
  constructor(
    public readonly issues: readonly WeatherGuardRegistrationValidationIssue[],
  ) {
    super(issues.map(({ message }) => message).join('；'));
    this.name = 'WeatherGuardRegistrationValidationError';
  }
}

export function readWeatherGuardRegistrationDeepLink(
  searchParams: URLSearchParams,
): WeatherGuardRegistrationDeepLink | null {
  if (searchParams.get('weatherGuardRegistration') !== '1') return null;

  const warningId = searchParams.get('warningId');
  if (!warningId || warningId !== warningId.trim()) return null;

  const source = searchParams.get('source');
  if (source === null) {
    return { warningId, source: 'page' };
  }
  if (source !== 'page' && source !== 'feishu-card' && source !== 'test-card') {
    return null;
  }
  return {
    warningId,
    source,
  };
}

export function clearWeatherGuardRegistrationDeepLink(
  searchParams: URLSearchParams,
): URLSearchParams {
  const cleared = new URLSearchParams(searchParams);
  cleared.delete('weatherGuardRegistration');
  cleared.delete('warningId');
  cleared.delete('source');
  return cleared;
}

export function createWeatherGuardRegistrationDraft(
  warningId: string,
  randomUUID: () => string = getCryptoRandomUUID,
): WeatherGuardRegistrationDraft {
  if (!warningId || warningId !== warningId.trim()) {
    throw new Error('天气预警 ID 无效');
  }
  const clientMutationId = randomUUID();
  if (!RFC_4122_UUID_PATTERN.test(clientMutationId)) {
    throw new Error('登记操作 UUID 无效');
  }

  return {
    version: WEATHER_GUARD_REGISTRATION_DRAFT_VERSION,
    warningId,
    clientMutationId,
    building: null,
    checkerKeys: [],
    deviceStatus: null,
    deviceAbnormalDescription: '',
    disasterStatus: null,
    disasterAbnormalDescription: '',
    environmentStatus: null,
    environmentAbnormalDescription: '',
    materialsStatus: null,
    materialsAbnormalDescription: '',
    contactsStatus: null,
    contactsAbnormalDescription: '',
  };
}

export function validateWeatherGuardRegistrationDraft(
  draft: WeatherGuardRegistrationDraft,
  environmentRequired: boolean,
): WeatherGuardRegistrationValidationIssue[] {
  const issues: WeatherGuardRegistrationValidationIssue[] = [];
  if (draft.version !== WEATHER_GUARD_REGISTRATION_DRAFT_VERSION) {
    issues.push({ field: 'version', message: '登记草稿版本已失效' });
  }
  if (!isExactNonBlankString(draft.warningId)) {
    issues.push({ field: 'warningId', message: '天气预警 ID 无效' });
  }
  if (!RFC_4122_UUID_PATTERN.test(draft.clientMutationId)) {
    issues.push({ field: 'clientMutationId', message: '登记操作 UUID 无效' });
  }
  if (!draft.building || !WEATHER_GUARD_BUILDINGS.has(draft.building)) {
    issues.push({ field: 'building', message: '请选择楼栋' });
  }
  if (
    !Array.isArray(draft.checkerKeys) ||
    draft.checkerKeys.length === 0 ||
    !draft.checkerKeys.every(isNonBlankString)
  ) {
    issues.push({ field: 'checkerKeys', message: '请选择检查人' });
  }
  validateStatusAndDescription(
    issues,
    draft,
    'deviceStatus',
    'deviceAbnormalDescription',
  );
  validateStatusAndDescription(
    issues,
    draft,
    'disasterStatus',
    'disasterAbnormalDescription',
  );
  if (environmentRequired) {
    validateStatusAndDescription(
      issues,
      draft,
      'environmentStatus',
      'environmentAbnormalDescription',
    );
  }
  validateStatusAndDescription(
    issues,
    draft,
    'materialsStatus',
    'materialsAbnormalDescription',
  );
  validateStatusAndDescription(
    issues,
    draft,
    'contactsStatus',
    'contactsAbnormalDescription',
  );
  return issues;
}

export function buildWeatherGuardRegistrationPayload(
  draft: WeatherGuardRegistrationDraft,
  environmentRequired: boolean,
): WeatherGuardRegistrationRequest {
  const issues = validateWeatherGuardRegistrationDraft(
    draft,
    environmentRequired,
  );
  if (issues.length > 0) {
    throw new WeatherGuardRegistrationValidationError(issues);
  }

  const payload: WeatherGuardRegistrationRequest = {
    clientMutationId: draft.clientMutationId,
    warningId: draft.warningId,
    building: draft.building!,
    checkerKeys: [...draft.checkerKeys],
    deviceStatus: draft.deviceStatus!,
    disasterStatus: draft.disasterStatus!,
    materialsStatus: draft.materialsStatus!,
    contactsStatus: draft.contactsStatus!,
  };
  appendAbnormalDescription(
    payload,
    draft.deviceStatus,
    'deviceAbnormalDescription',
    draft.deviceAbnormalDescription,
  );
  appendAbnormalDescription(
    payload,
    draft.disasterStatus,
    'disasterAbnormalDescription',
    draft.disasterAbnormalDescription,
  );
  appendAbnormalDescription(
    payload,
    draft.materialsStatus,
    'materialsAbnormalDescription',
    draft.materialsAbnormalDescription,
  );
  appendAbnormalDescription(
    payload,
    draft.contactsStatus,
    'contactsAbnormalDescription',
    draft.contactsAbnormalDescription,
  );

  if (environmentRequired) {
    payload.environmentStatus = draft.environmentStatus!;
    appendAbnormalDescription(
      payload,
      draft.environmentStatus,
      'environmentAbnormalDescription',
      draft.environmentAbnormalDescription,
    );
  }
  return payload;
}

export function validateWeatherGuardRegistrationEvidence(
  evidence: WeatherGuardRegistrationEvidence,
  environmentRequired: boolean,
  constraints: WeatherGuardRegistrationEvidenceConstraints = DEFAULT_WEATHER_GUARD_REGISTRATION_EVIDENCE_CONSTRAINTS,
): WeatherGuardRegistrationEvidenceIssue[] {
  const issues: WeatherGuardRegistrationEvidenceIssue[] = [];
  validateEvidenceField(
    issues,
    'deviceEvidence',
    evidence?.deviceEvidence,
    constraints,
  );
  validateEvidenceField(
    issues,
    'disasterEvidence',
    evidence?.disasterEvidence,
    constraints,
  );
  if (environmentRequired) {
    validateEvidenceField(
      issues,
      'environmentEvidence',
      evidence?.environmentEvidence,
      constraints,
    );
  }
  return issues;
}

export function buildWeatherGuardRegistrationFormData(
  draft: WeatherGuardRegistrationDraft,
  environmentRequired: boolean,
  evidence: WeatherGuardRegistrationEvidence,
  constraints: WeatherGuardRegistrationEvidenceConstraints = DEFAULT_WEATHER_GUARD_REGISTRATION_EVIDENCE_CONSTRAINTS,
): FormData {
  const payload = buildWeatherGuardRegistrationPayload(
    draft,
    environmentRequired,
  );
  const issues = validateWeatherGuardRegistrationEvidence(
    evidence,
    environmentRequired,
    constraints,
  );
  if (issues.length > 0) {
    throw new WeatherGuardRegistrationEvidenceValidationError(issues);
  }

  const formData = new FormData();
  formData.append('payload', JSON.stringify(payload));
  appendEvidence(formData, 'deviceEvidence', evidence.deviceEvidence!);
  appendEvidence(formData, 'disasterEvidence', evidence.disasterEvidence!);
  if (environmentRequired) {
    appendEvidence(
      formData,
      'environmentEvidence',
      evidence.environmentEvidence!,
    );
  }
  return formData;
}

export function getWeatherGuardRegistrationDraftStorageKey(
  warningId: string,
): string {
  if (!warningId || warningId !== warningId.trim()) {
    throw new Error('天气预警 ID 无效');
  }
  return `nantong:weather-guard-registration:v${WEATHER_GUARD_REGISTRATION_DRAFT_VERSION}:${encodeURIComponent(
    warningId,
  )}`;
}

export function getWeatherGuardRegistrationPendingStorageKey(
  warningId: string,
): string {
  if (!isExactNonBlankString(warningId)) {
    throw new Error('天气预警 ID 无效');
  }
  return `nantong:weather-guard-registration-pending:v1:${encodeURIComponent(
    warningId,
  )}`;
}

export function saveWeatherGuardRegistrationPending(
  draft: Pick<WeatherGuardRegistrationDraft, 'warningId' | 'clientMutationId'>,
  storage?: WeatherGuardRegistrationDraftStorage,
): boolean {
  if (
    !isExactNonBlankString(draft?.warningId) ||
    !RFC_4122_UUID_PATTERN.test(draft?.clientMutationId ?? '')
  ) {
    return false;
  }
  const target = resolveDraftStorage(storage);
  if (!target) return false;
  try {
    target.setItem(
      getWeatherGuardRegistrationPendingStorageKey(draft.warningId),
      draft.clientMutationId,
    );
    return true;
  } catch {
    return false;
  }
}

export function readWeatherGuardRegistrationPending(
  warningId: string,
  storage?: WeatherGuardRegistrationDraftStorage,
): string | null {
  if (!isExactNonBlankString(warningId)) return null;
  const target = resolveDraftStorage(storage);
  if (!target) return null;
  try {
    const clientMutationId = target.getItem(
      getWeatherGuardRegistrationPendingStorageKey(warningId),
    );
    return clientMutationId && RFC_4122_UUID_PATTERN.test(clientMutationId)
      ? clientMutationId
      : null;
  } catch {
    return null;
  }
}

export function clearWeatherGuardRegistrationPending(
  warningId: string,
  storage?: WeatherGuardRegistrationDraftStorage,
): boolean {
  if (!isExactNonBlankString(warningId)) return false;
  const target = resolveDraftStorage(storage);
  if (!target) return false;
  try {
    target.removeItem(getWeatherGuardRegistrationPendingStorageKey(warningId));
    return true;
  } catch {
    return false;
  }
}

export function saveWeatherGuardRegistrationDraft(
  draft: WeatherGuardRegistrationDraft,
  storage?: WeatherGuardRegistrationDraftStorage,
): boolean {
  const normalized = normalizeStoredDraft(draft, draft?.warningId);
  const target = resolveDraftStorage(storage);
  if (!normalized || !target) return false;
  try {
    target.setItem(
      getWeatherGuardRegistrationDraftStorageKey(normalized.warningId),
      JSON.stringify(normalized),
    );
    return true;
  } catch {
    return false;
  }
}

export function readWeatherGuardRegistrationDraft(
  warningId: string,
  storage?: WeatherGuardRegistrationDraftStorage,
): RestoredWeatherGuardRegistrationDraft | null {
  if (!isExactNonBlankString(warningId)) return null;
  const target = resolveDraftStorage(storage);
  if (!target) return null;
  try {
    const raw = target.getItem(
      getWeatherGuardRegistrationDraftStorageKey(warningId),
    );
    if (!raw) return null;
    const draft = normalizeStoredDraft(JSON.parse(raw) as unknown, warningId);
    return draft ? { draft, evidenceMustBeReselected: true } : null;
  } catch {
    return null;
  }
}

export function clearWeatherGuardRegistrationDraft(
  warningId: string,
  storage?: WeatherGuardRegistrationDraftStorage,
): boolean {
  if (!isExactNonBlankString(warningId)) return false;
  const target = resolveDraftStorage(storage);
  if (!target) return false;
  try {
    target.removeItem(getWeatherGuardRegistrationDraftStorageKey(warningId));
    return true;
  } catch {
    return false;
  }
}

export function createWeatherGuardRegistrationSubmissionGate(): WeatherGuardRegistrationSubmissionGate {
  const activeTokens = new Map<
    string,
    WeatherGuardRegistrationSubmissionToken
  >();
  return {
    tryStart: (draft, revision) => {
      if (activeTokens.has(draft.clientMutationId)) return null;
      const token = { clientMutationId: draft.clientMutationId, revision };
      activeTokens.set(token.clientMutationId, token);
      submissionTokenActivity.set(
        token,
        () => activeTokens.get(token.clientMutationId) === token,
      );
      return token;
    },
    finish: (token) => {
      if (activeTokens.get(token.clientMutationId) === token) {
        activeTokens.delete(token.clientMutationId);
      }
    },
  };
}

export function isCurrentWeatherGuardRegistrationSubmission(
  token: WeatherGuardRegistrationSubmissionToken,
  draft: Pick<WeatherGuardRegistrationDraft, 'clientMutationId'>,
  revision: number,
): boolean {
  const isActive = submissionTokenActivity.get(token);
  return (
    token.clientMutationId === draft.clientMutationId &&
    token.revision === revision &&
    (isActive?.() ?? false)
  );
}

function normalizeStoredDraft(
  value: unknown,
  expectedWarningId: unknown,
): WeatherGuardRegistrationDraft | null {
  if (!isPlainRecord(value) || !isExactNonBlankString(expectedWarningId)) {
    return null;
  }
  if (
    value.version !== WEATHER_GUARD_REGISTRATION_DRAFT_VERSION ||
    value.warningId !== expectedWarningId ||
    !RFC_4122_UUID_PATTERN.test(
      typeof value.clientMutationId === 'string' ? value.clientMutationId : '',
    ) ||
    !isNullableBuilding(value.building) ||
    !Array.isArray(value.checkerKeys) ||
    !value.checkerKeys.every(isNonBlankString) ||
    !isNullableRegistrationStatus(value.deviceStatus) ||
    typeof value.deviceAbnormalDescription !== 'string' ||
    !isNullableRegistrationStatus(value.disasterStatus) ||
    typeof value.disasterAbnormalDescription !== 'string' ||
    !isNullableRegistrationStatus(value.environmentStatus) ||
    typeof value.environmentAbnormalDescription !== 'string' ||
    !isNullableRegistrationStatus(value.materialsStatus) ||
    typeof value.materialsAbnormalDescription !== 'string' ||
    !isNullableRegistrationStatus(value.contactsStatus) ||
    typeof value.contactsAbnormalDescription !== 'string'
  ) {
    return null;
  }

  return {
    version: WEATHER_GUARD_REGISTRATION_DRAFT_VERSION,
    warningId: value.warningId as string,
    clientMutationId: value.clientMutationId as string,
    building: value.building as WeatherWarningBuilding | null,
    checkerKeys: [...(value.checkerKeys as string[])],
    deviceStatus: value.deviceStatus as WeatherGuardRegistrationStatus | null,
    deviceAbnormalDescription: value.deviceAbnormalDescription,
    disasterStatus:
      value.disasterStatus as WeatherGuardRegistrationStatus | null,
    disasterAbnormalDescription: value.disasterAbnormalDescription,
    environmentStatus:
      value.environmentStatus as WeatherGuardRegistrationStatus | null,
    environmentAbnormalDescription: value.environmentAbnormalDescription,
    materialsStatus:
      value.materialsStatus as WeatherGuardRegistrationStatus | null,
    materialsAbnormalDescription: value.materialsAbnormalDescription,
    contactsStatus:
      value.contactsStatus as WeatherGuardRegistrationStatus | null,
    contactsAbnormalDescription: value.contactsAbnormalDescription,
  };
}

function isNullableBuilding(
  value: unknown,
): value is WeatherWarningBuilding | null {
  return (
    value === null ||
    (typeof value === 'string' && WEATHER_GUARD_BUILDINGS.has(value))
  );
}

function isNullableRegistrationStatus(
  value: unknown,
): value is WeatherGuardRegistrationStatus | null {
  return value === null || value === '正常' || value === '异常';
}

function isExactNonBlankString(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value === value.trim()
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function resolveDraftStorage(
  storage?: WeatherGuardRegistrationDraftStorage,
): WeatherGuardRegistrationDraftStorage | undefined {
  if (storage) return storage;
  if (typeof window === 'undefined') return undefined;
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

function appendEvidence(
  formData: FormData,
  field: WeatherGuardRegistrationEvidenceField,
  file: File,
): void {
  formData.append(field, file, file.name);
}

function validateEvidenceField(
  issues: WeatherGuardRegistrationEvidenceIssue[],
  field: WeatherGuardRegistrationEvidenceField,
  file: unknown,
  constraints: WeatherGuardRegistrationEvidenceConstraints,
): void {
  if (file === null || file === undefined) {
    issues.push({ field, code: 'required', message: '请选择一份检查附件' });
    return;
  }
  if (Array.isArray(file)) {
    issues.push({ field, code: 'count', message: '每类只能选择一份检查附件' });
    return;
  }
  if (typeof file !== 'object') {
    issues.push({ field, code: 'type', message: '检查附件格式无效' });
    return;
  }

  const candidate = file as { name?: unknown; type?: unknown; size?: unknown };
  if (
    typeof candidate.size !== 'number' ||
    !Number.isInteger(candidate.size) ||
    candidate.size <= 0
  ) {
    issues.push({ field, code: 'empty', message: '检查附件不能为空' });
    return;
  }
  if (candidate.size > constraints.maxImageBytes) {
    issues.push({
      field,
      code: 'size',
      message: `检查附件不能超过 ${formatEvidenceByteLimit(constraints.maxImageBytes)}`,
    });
    return;
  }

  const fileName = typeof candidate.name === 'string' ? candidate.name : '';
  const mimeType = typeof candidate.type === 'string' ? candidate.type : '';
  const extension = /\.[^.]+$/u.exec(fileName.toLowerCase())?.[0] || '';
  const expectedMimeByExtension: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  };
  const acceptedImageTypes = new Set(
    constraints.acceptedImageTypes.map((acceptedType) =>
      acceptedType.trim().toLowerCase(),
    ),
  );
  if (
    !acceptedImageTypes.has(mimeType.toLowerCase()) ||
    expectedMimeByExtension[extension] !== mimeType.toLowerCase()
  ) {
    issues.push({
      field,
      code: 'type',
      message: '仅支持扩展名与 MIME 一致的 PNG、JPEG、WebP 图片或 PDF 扫描件',
    });
  }
}

function formatEvidenceByteLimit(maxImageBytes: number): string {
  if (maxImageBytes >= 1024 * 1024) {
    return `${(maxImageBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/u, '')} MiB`;
  }
  if (maxImageBytes >= 1024) {
    return `${Math.ceil(maxImageBytes / 1024)} KiB`;
  }
  return `${maxImageBytes} 字节`;
}

function appendAbnormalDescription(
  payload: WeatherGuardRegistrationRequest,
  status: WeatherGuardRegistrationStatus | null,
  field:
    | 'deviceAbnormalDescription'
    | 'disasterAbnormalDescription'
    | 'environmentAbnormalDescription'
    | 'materialsAbnormalDescription'
    | 'contactsAbnormalDescription',
  description: string,
): void {
  if (status === '异常') payload[field] = description.trim();
}

function validateStatusAndDescription(
  issues: WeatherGuardRegistrationValidationIssue[],
  draft: WeatherGuardRegistrationDraft,
  statusField:
    | 'deviceStatus'
    | 'disasterStatus'
    | 'environmentStatus'
    | 'materialsStatus'
    | 'contactsStatus',
  descriptionField:
    | 'deviceAbnormalDescription'
    | 'disasterAbnormalDescription'
    | 'environmentAbnormalDescription'
    | 'materialsAbnormalDescription'
    | 'contactsAbnormalDescription',
): void {
  const status = draft[statusField];
  if (status !== '正常' && status !== '异常') {
    issues.push({ field: statusField, message: '请选择检查状态' });
  } else if (status === '异常' && !isNonBlankString(draft[descriptionField])) {
    issues.push({ field: descriptionField, message: '请填写异常描述' });
  }
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function getCryptoRandomUUID(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new Error('当前浏览器不支持生成登记操作 UUID');
  }
  return globalThis.crypto.randomUUID();
}
