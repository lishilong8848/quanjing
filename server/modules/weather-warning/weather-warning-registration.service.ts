import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  WeatherGuardRegistrationOptions,
  WeatherGuardRegistrationPersonOption,
  WeatherGuardRegistrationRequest,
  WeatherGuardRegistrationResponse,
  WeatherWarningDisplayWarning,
  WeatherWarningBuilding,
  WeatherWarningGuardLevel,
  WeatherWarningSnapshot,
} from '@shared/api.interface';
import type { BitableRecordItem } from '@server/common/feishu/bitable-direct-read';
import { BitableSyncService } from '@server/modules/bitable-sync/bitable-sync.service';
import type {
  ActivePersonnelBuilding,
  ActivePersonnelDirectory,
} from '@server/modules/bitable-sync/active-personnel-directory';
import {
  loadWeatherWarningRegistrationRuntimeConfig,
  type WeatherWarningRegistrationFields,
} from './weather-warning-registration.config';
import {
  WEATHER_WARNING_REGISTRATION_ACCEPTED_IMAGE_TYPES,
  WEATHER_WARNING_REGISTRATION_MAX_IMAGE_BYTES,
  WeatherWarningRegistrationGateway,
  validateWeatherWarningRegistrationUploadFile,
  type WeatherWarningRegistrationGatewayRequestOptions,
  type WeatherWarningRegistrationUploadFile,
} from './weather-warning-registration.gateway';
import {
  WEATHER_GUARD_BUILDINGS,
  buildWeatherGuardRegistrationFields,
  validateWeatherGuardRegistration,
  type WeatherGuardRegistrationFields as CanonicalRegistrationFields,
  type WeatherGuardRegistrationValidationIssue,
} from './weather-warning-registration.rules';
import { resolveWeatherWarningCheckScope } from './weather-warning-check-scope';
import { WeatherWarningSnapshotService } from './weather-warning-snapshot.service';
import {
  isWeatherWarningTestSimulationId,
  verifyWeatherWarningTestSimulationId,
} from './weather-warning-test-simulation';

type EvidenceInput =
  | WeatherWarningRegistrationUploadFile
  | readonly WeatherWarningRegistrationUploadFile[];

export interface WeatherWarningRegistrationSubmitFiles {
  deviceEvidence?: EvidenceInput;
  disasterEvidence?: EvidenceInput;
  environmentEvidence?: EvidenceInput;
}

export interface WeatherWarningRegistrationSubmitInput {
  payload: WeatherGuardRegistrationRequest;
  files: WeatherWarningRegistrationSubmitFiles;
}

interface NormalizedEvidenceFiles {
  deviceEvidence?: WeatherWarningRegistrationUploadFile;
  disasterEvidence?: WeatherWarningRegistrationUploadFile;
  environmentEvidence?: WeatherWarningRegistrationUploadFile;
}

interface ActiveRegistrationContext {
  snapshot: WeatherWarningSnapshot;
  warning: WeatherWarningDisplayWarning;
  guardLevel: WeatherWarningGuardLevel;
  tag: string;
  simulation: boolean;
}

interface CandidatePerson {
  key: string;
  name: string;
  openId: string;
  position: string;
  buildings: WeatherWarningBuilding[];
}

interface CandidateCatalog {
  options: WeatherGuardRegistrationPersonOption[];
  byKey: Map<string, CandidatePerson>;
}

interface CandidateCatalogs {
  checkers: CandidateCatalog;
  managerOpenIds: string[];
  personnelSyncedAt: string;
  personnelStale: boolean;
}

interface InFlightRegistration {
  fingerprint: string;
  promise: Promise<WeatherGuardRegistrationResponse>;
}

interface CompletedRegistration {
  fingerprint: string;
  expiresAt: number;
  result: WeatherGuardRegistrationResponse;
}

interface RegistrationAttemptPlan {
  registrationFields: WeatherWarningRegistrationFields;
  guardLevel: WeatherWarningGuardLevel;
  tag: string;
  simulation: boolean;
  checkerOpenIds: string[];
  managerOpenIds: string[];
  needsEnvironment: boolean;
}

type RegistrationEvidenceCategory = 'device' | 'disaster' | 'environment';

interface RegistrationAttempt {
  fingerprint: string;
  expiresAt: number;
  submittedAt: Date;
  payload: WeatherGuardRegistrationRequest;
  plan?: RegistrationAttemptPlan;
  attachmentTokens: {
    device?: string;
    disaster?: string;
    environment?: string;
  };
  uploadPromises: Partial<
    Record<RegistrationEvidenceCategory, Promise<string>>
  >;
  fields?: Record<string, unknown>;
  recordId?: string;
  recordConfirmed?: boolean;
}

interface RegistrationWorkControl {
  options: WeatherWarningRegistrationGatewayRequestOptions;
  dispose: () => void;
}

const COMPLETED_RESULT_TTL_MS = 10 * 60 * 1000;
const MAX_COMPLETED_RESULTS = 256;
const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 256;
const REGISTRATION_REQUEST_DEADLINE_MS = 50_000;
const ALLOWED_FILE_KEYS = new Set([
  'deviceEvidence',
  'disasterEvidence',
  'environmentEvidence',
]);
const COLOR_LABELS: Record<string, string> = {
  red: '红色',
  orange: '橙色',
  yellow: '黄色',
  blue: '蓝色',
};
const WEATHER_GUARD_TAG_PATTERN =
  /^(?:暴雨|暴雪|台风|洪水|雷电|冰雹|寒潮|霜冻|高温)(?:红色|橙色|黄色|蓝色)$/u;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]+$/u;
@Injectable()
export class WeatherWarningRegistrationService {
  private readonly logger = new Logger(WeatherWarningRegistrationService.name);
  private readonly inFlightByMutation = new Map<string, InFlightRegistration>();
  private readonly completedByMutation = new Map<
    string,
    CompletedRegistration
  >();
  private readonly attemptsByMutation = new Map<string, RegistrationAttempt>();

  constructor(
    private readonly snapshotService: WeatherWarningSnapshotService,
    private readonly gateway: WeatherWarningRegistrationGateway,
    private readonly bitableSyncService: BitableSyncService,
  ) {}

  async getOptions(
    warningId: string,
    signal?: AbortSignal,
  ): Promise<WeatherGuardRegistrationOptions> {
    const requestOptions = createRequestOptions(signal);
    const context = await this.requireActivePrimaryWarning(
      warningId,
      requestOptions,
    );
    const candidates = await this.loadCandidateCatalogs();
    const environmentRequired = getContextEnvironmentRequired(context);
    return {
      warning: toPublicWarning(context.warning),
      dataUpdatedAt:
        context.snapshot.lastSuccessAt || context.snapshot.snapshotAt,
      guardLevel: context.guardLevel,
      environmentRequired,
      buildings: [...WEATHER_GUARD_BUILDINGS],
      checkers: candidates.checkers.options,
      personnelSyncedAt: candidates.personnelSyncedAt,
      personnelStale: candidates.personnelStale,
      acceptedImageTypes: [
        ...WEATHER_WARNING_REGISTRATION_ACCEPTED_IMAGE_TYPES,
      ],
      maxImageBytes: WEATHER_WARNING_REGISTRATION_MAX_IMAGE_BYTES,
    };
  }

  async submit(
    input: WeatherWarningRegistrationSubmitInput,
    signal?: AbortSignal,
  ): Promise<WeatherGuardRegistrationResponse> {
    const callerRequestOptions = createRequestOptions(signal);
    const files = normalizeEvidenceFiles(input?.files);
    const payload = input?.payload;
    assertValidByRules(payload, '二级戒备', files, false);
    validateEvidenceFiles(files);

    const mutationId = payload.clientMutationId;
    const fingerprint = buildSubmissionFingerprint(payload, files);
    this.pruneRegistrationState();

    const completed = this.completedByMutation.get(mutationId);
    if (completed) {
      if (completed.fingerprint !== fingerprint) {
        throw mutationConflict();
      }
      this.completedByMutation.delete(mutationId);
      this.completedByMutation.set(mutationId, completed);
      return completed.result;
    }

    const existingAttempt = this.attemptsByMutation.get(mutationId);
    if (existingAttempt && existingAttempt.fingerprint !== fingerprint) {
      throw mutationConflict();
    }

    const active = this.inFlightByMutation.get(mutationId);
    if (active) {
      if (active.fingerprint !== fingerprint) {
        throw mutationConflict();
      }
      return waitForServiceRequest(active.promise, callerRequestOptions);
    }

    const attempt =
      existingAttempt ?? this.createAttempt(mutationId, fingerprint, payload);
    const workControl = createRegistrationWorkControl();
    const promise = this.runSubmission(attempt, files, workControl.options)
      .then((result) => {
        this.rememberCompletedResult(mutationId, fingerprint, result);
        if (this.attemptsByMutation.get(mutationId) === attempt) {
          this.attemptsByMutation.delete(mutationId);
        }
        return result;
      })
      .finally(workControl.dispose);
    this.inFlightByMutation.set(mutationId, { fingerprint, promise });
    const clear = () => {
      if (this.inFlightByMutation.get(mutationId)?.promise === promise) {
        this.inFlightByMutation.delete(mutationId);
      }
    };
    void promise.then(clear, clear);
    return waitForServiceRequest(promise, callerRequestOptions);
  }

  private async runSubmission(
    attempt: RegistrationAttempt,
    files: NormalizedEvidenceFiles,
    requestOptions: WeatherWarningRegistrationGatewayRequestOptions,
  ): Promise<WeatherGuardRegistrationResponse> {
    const payload = attempt.payload;
    const plan = await this.getOrCreateAttemptPlan(
      attempt,
      files,
      requestOptions,
    );
    const [deviceToken, disasterToken, environmentToken] = await Promise.all([
      this.getOrUploadAttemptImage(
        attempt,
        'device',
        files.deviceEvidence!,
        requestOptions,
      ),
      this.getOrUploadAttemptImage(
        attempt,
        'disaster',
        files.disasterEvidence!,
        requestOptions,
      ),
      plan.needsEnvironment
        ? this.getOrUploadAttemptImage(
            attempt,
            'environment',
            files.environmentEvidence!,
            requestOptions,
          )
        : Promise.resolve(undefined),
    ]);
    if (!attempt.fields) {
      const canonicalFields = buildWeatherGuardRegistrationFields(payload, {
        submittedAt: attempt.submittedAt,
        guardLevel: plan.guardLevel,
        tag: plan.tag,
        checkerOpenIds: plan.checkerOpenIds,
        managerOpenIds: plan.managerOpenIds,
        environmentRequired: plan.needsEnvironment,
        attachmentTokens: {
          device: deviceToken,
          disaster: disasterToken,
          ...(environmentToken ? { environment: environmentToken } : {}),
        },
      });
      attempt.fields = mapRegistrationFields(
        canonicalFields,
        plan.registrationFields,
        plan.needsEnvironment,
      );
    }
    if (!attempt.recordId) {
      attempt.recordId = await this.gateway.createRecord(
        attempt.fields,
        payload.clientMutationId,
        requestOptions,
      );
    }
    const recordId = attempt.recordId;
    if (!attempt.recordConfirmed) {
      const confirmed = await this.gateway.getRecord(recordId, requestOptions);
      assertConfirmedRecord(confirmed, {
        recordId,
        fields: plan.registrationFields,
        payload,
        guardLevel: plan.guardLevel,
        tag: plan.tag,
        checkerOpenIds: plan.checkerOpenIds,
        managerOpenIds: plan.managerOpenIds,
        deviceToken,
        disasterToken,
        environmentToken,
        needsEnvironment: plan.needsEnvironment,
        submittedAtMs: attempt.submittedAt.getTime(),
        simulation: plan.simulation,
      });
      attempt.recordConfirmed = true;
    }
    if (plan.simulation) {
      await this.gateway.deleteRecordAndConfirmAbsent(recordId, requestOptions);
    }
    await this.gateway.invalidateRegistrationCache(requestOptions);

    const result: WeatherGuardRegistrationResponse = {
      success: true,
      clientMutationId: payload.clientMutationId,
      syncStatus: 'confirmed',
      recordId,
      createdAt: attempt.submittedAt.toISOString(),
      building: payload.building,
      guardLevel: plan.guardLevel,
    };
    if (!plan.simulation) {
      void this.snapshotService
        .getSnapshot({ forceRefresh: true })
        .catch(() => {
          this.logger.warn('登记记录已确认，但登记后预警快照刷新失败');
        });
    }
    return result;
  }

  private async getOrCreateAttemptPlan(
    attempt: RegistrationAttempt,
    files: NormalizedEvidenceFiles,
    requestOptions: WeatherWarningRegistrationGatewayRequestOptions,
  ): Promise<RegistrationAttemptPlan> {
    if (attempt.plan) return attempt.plan;
    const payload = attempt.payload;
    const context = await this.requireActivePrimaryWarning(
      payload.warningId,
      requestOptions,
    );
    const needsEnvironment = getContextEnvironmentRequired(context);
    assertValidByRules(payload, context.guardLevel, files, needsEnvironment);
    const candidates = await this.loadCandidateCatalogs();
    const plan: RegistrationAttemptPlan = {
      registrationFields:
        loadWeatherWarningRegistrationRuntimeConfig().registrationFields,
      guardLevel: context.guardLevel,
      tag: context.tag,
      simulation: context.simulation,
      checkerOpenIds: resolveCheckerOpenIds(
        payload.checkerKeys,
        candidates.checkers,
      ),
      managerOpenIds: [...candidates.managerOpenIds],
      needsEnvironment,
    };
    attempt.plan = plan;
    return plan;
  }

  private getOrUploadAttemptImage(
    attempt: RegistrationAttempt,
    category: RegistrationEvidenceCategory,
    file: WeatherWarningRegistrationUploadFile,
    requestOptions: WeatherWarningRegistrationGatewayRequestOptions,
  ): Promise<string> {
    const existing = attempt.attachmentTokens[category];
    if (existing) return Promise.resolve(existing);
    const pending = attempt.uploadPromises[category];
    if (pending) return pending;

    const uploadPromise = this.gateway.uploadImage(file, requestOptions);
    attempt.uploadPromises[category] = uploadPromise;
    void uploadPromise.then(
      (token) => {
        if (attempt.uploadPromises[category] !== uploadPromise) return;
        attempt.attachmentTokens[category] = token;
        delete attempt.uploadPromises[category];
      },
      () => {
        if (attempt.uploadPromises[category] === uploadPromise) {
          delete attempt.uploadPromises[category];
        }
      },
    );
    return uploadPromise;
  }

  private async requireActivePrimaryWarning(
    warningId: string,
    requestOptions: WeatherWarningRegistrationGatewayRequestOptions,
  ): Promise<ActiveRegistrationContext> {
    if (
      typeof warningId !== 'string' ||
      warningId.length === 0 ||
      warningId !== warningId.trim()
    ) {
      throw new BadRequestException('预警 ID 不能为空');
    }

    if (isWeatherWarningTestSimulationId(warningId)) {
      let simulation;
      try {
        simulation = verifyWeatherWarningTestSimulationId(warningId);
      } catch {
        throw new ServiceUnavailableException('测试预警签名配置不可用');
      }
      if (!simulation) {
        throw new ConflictException('测试预警已失效，请重新发送测试卡片');
      }
      const snapshot = simulation.snapshot;
      const guardLevel = snapshot.guardLevel;
      const warning = snapshot.matchedWarnings[0];
      if (
        !isGuardLevel(guardLevel) ||
        !warning ||
        warning.id !== warningId ||
        warning.guardLevel !== guardLevel
      ) {
        throw new ConflictException('测试预警已失效，请重新发送测试卡片');
      }
      return {
        snapshot,
        warning,
        guardLevel,
        tag: simulation.tag,
        simulation: true,
      };
    }

    const snapshot = await waitForServiceRequest(
      this.snapshotService.getSnapshot({ forceRefresh: true }),
      requestOptions,
    );
    const guardLevel = snapshot.guardLevel;
    const warning = snapshot.matchedWarnings[0];
    if (
      snapshot.status !== 'active' ||
      snapshot.sourceState !== 'fresh' ||
      snapshot.guardDecisionState !== 'fresh' ||
      !isGuardLevel(guardLevel) ||
      !warning ||
      warning.id !== warningId ||
      warning.guardLevel !== guardLevel
    ) {
      throw new ConflictException('指定预警已过期或不是当前主预警');
    }
    return {
      snapshot,
      warning,
      guardLevel,
      tag: buildGuardTag(warning),
      simulation: false,
    };
  }

  private async loadCandidateCatalogs(): Promise<CandidateCatalogs> {
    const directory =
      await this.bitableSyncService.getCachedActivePersonnelDirectory();
    const checkers = buildCachedCandidateCatalog(directory);
    const managerOpenIds = directory.managers.map(({ openId }) => openId);
    const automaticManagersValid =
      directory.managers.length === 2 &&
      managerOpenIds.every((openId) => OPEN_ID_PATTERN.test(openId)) &&
      new Set(managerOpenIds).size === 2;
    if (checkers.options.length === 0 || !automaticManagersValid) {
      throw new ServiceUnavailableException(
        '登记候选人员不完整，当前无法提交登记',
      );
    }
    return {
      checkers,
      managerOpenIds,
      personnelSyncedAt: new Date(directory.snapshot.fetchedAt).toISOString(),
      personnelStale: directory.snapshot.stale,
    };
  }

  private rememberCompletedResult(
    mutationId: string,
    fingerprint: string,
    result: WeatherGuardRegistrationResponse,
  ): void {
    this.completedByMutation.delete(mutationId);
    this.completedByMutation.set(mutationId, {
      fingerprint,
      expiresAt: Date.now() + COMPLETED_RESULT_TTL_MS,
      result,
    });
    while (this.completedByMutation.size > MAX_COMPLETED_RESULTS) {
      const oldest = this.completedByMutation.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.completedByMutation.delete(oldest);
    }
  }

  private createAttempt(
    mutationId: string,
    fingerprint: string,
    payload: WeatherGuardRegistrationRequest,
  ): RegistrationAttempt {
    const attempt: RegistrationAttempt = {
      fingerprint,
      expiresAt: Date.now() + ATTEMPT_TTL_MS,
      submittedAt: new Date(),
      payload,
      attachmentTokens: {},
      uploadPromises: {},
    };
    this.attemptsByMutation.set(mutationId, attempt);
    while (this.attemptsByMutation.size > MAX_ATTEMPTS) {
      const oldest = this.attemptsByMutation.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.attemptsByMutation.delete(oldest);
    }
    return attempt;
  }

  private pruneRegistrationState(): void {
    const now = Date.now();
    for (const [mutationId, completed] of this.completedByMutation) {
      if (completed.expiresAt <= now) {
        this.completedByMutation.delete(mutationId);
      }
    }
    for (const [mutationId, attempt] of this.attemptsByMutation) {
      if (attempt.expiresAt <= now) {
        this.attemptsByMutation.delete(mutationId);
      }
    }
  }
}

function normalizeEvidenceFiles(
  rawFiles: WeatherWarningRegistrationSubmitFiles | undefined,
): NormalizedEvidenceFiles {
  if (!isPlainRecord(rawFiles)) {
    throw new BadRequestException('登记附件参数无效');
  }
  for (const key of Object.keys(rawFiles)) {
    if (!ALLOWED_FILE_KEYS.has(key)) {
      throw new BadRequestException(`不支持的登记附件字段：${key}`);
    }
  }
  const files = rawFiles as WeatherWarningRegistrationSubmitFiles;
  return {
    deviceEvidence: normalizeSingleEvidence(
      files.deviceEvidence,
      '设备安全检查附件',
    ),
    disasterEvidence: normalizeSingleEvidence(
      files.disasterEvidence,
      '灾害专项检查附件',
    ),
    environmentEvidence: normalizeSingleEvidence(
      files.environmentEvidence,
      '环境安全检查附件',
    ),
  };
}

function normalizeSingleEvidence(
  input: EvidenceInput | undefined,
  label: string,
): WeatherWarningRegistrationUploadFile | undefined {
  if (input === undefined || input === null) return undefined;
  const files = Array.isArray(input) ? input : [input];
  if (files.length > 1) {
    throw new BadRequestException(`${label}只能上传一份`);
  }
  return files[0];
}

function validateEvidenceFiles(files: NormalizedEvidenceFiles): void {
  for (const file of Object.values(files)) {
    if (file) validateWeatherWarningRegistrationUploadFile(file);
  }
}

function assertValidByRules(
  payload: unknown,
  guardLevel: WeatherWarningGuardLevel,
  files: NormalizedEvidenceFiles,
  environmentRequired: boolean,
): asserts payload is WeatherGuardRegistrationRequest {
  const issues = validateWeatherGuardRegistration(payload, {
    guardLevel,
    environmentRequired,
    attachmentCounts: {
      device: files.deviceEvidence ? 1 : 0,
      disaster: files.disasterEvidence ? 1 : 0,
      environment: files.environmentEvidence ? 1 : 0,
    },
  });
  if (issues.length > 0) {
    throwValidationIssues(issues);
  }
}

function throwValidationIssues(
  issues: readonly WeatherGuardRegistrationValidationIssue[],
): never {
  throw new BadRequestException({
    message: '登记内容校验失败',
    issues: issues.map(({ field, message }) => ({ field, message })),
  });
}

function buildCachedCandidateCatalog(
  directory: ActivePersonnelDirectory,
): CandidateCatalog {
  const byKey = new Map<string, CandidatePerson>();
  const options: WeatherGuardRegistrationPersonOption[] = [];
  for (const entry of directory.personnel) {
    const name = entry.name.trim();
    const buildings = entry.buildings.map(toWeatherWarningBuilding);
    if (!name || !OPEN_ID_PATTERN.test(entry.openId)) continue;
    const key = opaqueCheckerKey(entry.openId);
    if (byKey.has(key)) {
      throw new ServiceUnavailableException('登记候选人员标识冲突');
    }
    const person: CandidatePerson = {
      key,
      name,
      openId: entry.openId,
      position:
        entry.position.trim() || entry.systemPosition.trim() || '在职人员',
      buildings,
    };
    byKey.set(key, person);
    options.push({
      key,
      name: person.name,
      position: person.position,
      buildings: [...buildings],
    });
  }
  return { options, byKey };
}

function toWeatherWarningBuilding(
  building: ActivePersonnelBuilding,
): WeatherWarningBuilding {
  return building === '110' ? '110站' : `${building}楼`;
}

function opaqueCheckerKey(openId: string): string {
  return createHash('sha256')
    .update(`weather-registration:v2:checker:${openId}`)
    .digest('base64url');
}

function resolveCheckerOpenIds(
  keys: readonly string[],
  catalog: CandidateCatalog,
): string[] {
  if (new Set(keys).size !== keys.length) {
    throw new BadRequestException('检查人选择存在重复项，请重新选择');
  }
  const openIds: string[] = [];
  for (const key of keys) {
    const person = catalog.byKey.get(key);
    if (!person) {
      throw new BadRequestException('检查人选择已失效，请重新选择');
    }
    openIds.push(person.openId);
  }
  return openIds;
}

function buildGuardTag(warning: WeatherWarningDisplayWarning): string {
  const type = clean(warning.type);
  const color = warning.color ? COLOR_LABELS[warning.color] : '';
  if (!type || !color) {
    throw new ConflictException('当前主预警缺少可用类型或颜色，无法登记');
  }
  return `${type}${color}`;
}

function getContextEnvironmentRequired(
  context: ActiveRegistrationContext,
): boolean {
  if (Array.isArray(context.snapshot.requiredCheckKeys)) {
    return context.snapshot.requiredCheckKeys.includes('environment');
  }
  return resolveWeatherWarningCheckScope(context.warning).environmentRequired;
}

function mapRegistrationFields(
  canonical: CanonicalRegistrationFields,
  fields: WeatherWarningRegistrationFields,
  includeEnvironment: boolean,
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    [fields.date]: canonical.日期,
    [fields.checker]: canonical.检查人,
    [fields.manager]: canonical.机房经理,
    [fields.guard]: canonical.重保戒备等级,
    [fields.device]: canonical.检查设备安全项,
    [fields.deviceImage]: canonical.设备安全检查纸质图片,
    [fields.deviceIssue]: canonical.设备异常描述,
    [fields.disaster]: canonical.检查灾害专项,
    [fields.disasterImage]: canonical.灾害专项检查纸质图片,
    [fields.disasterIssue]: canonical.灾害异常描述,
    [fields.materials]: canonical.检查重保物资清单正常,
    [fields.materialsIssue]: canonical.重保物资异常描述,
    [fields.contacts]: canonical.检查重保联络清单人员齐备,
    [fields.contactsIssue]: canonical.联络清单异常描述,
    [fields.building]: canonical.楼栋,
    [fields.tag]: canonical.重保标签,
    [fields.managerConfirmation]: canonical.机房经理确认,
  };
  if (includeEnvironment) {
    result[fields.environment] = canonical.检查环境安全项;
    result[fields.environmentImage] = canonical.环境安全检查纸质图片;
    result[fields.environmentIssue] = canonical.环境异常描述;
  }
  return result;
}

interface ConfirmationExpectation {
  recordId: string;
  fields: WeatherWarningRegistrationFields;
  payload: WeatherGuardRegistrationRequest;
  guardLevel: WeatherWarningGuardLevel;
  tag: string;
  checkerOpenIds: readonly string[];
  managerOpenIds: readonly string[];
  deviceToken: string;
  disasterToken: string;
  environmentToken?: string;
  needsEnvironment: boolean;
  submittedAtMs: number;
  simulation: boolean;
}

function assertConfirmedRecord(
  record: BitableRecordItem,
  expected: ConfirmationExpectation,
): void {
  const actual = isPlainRecord(record?.fields) ? record.fields : null;
  if (!actual) throw confirmationMismatch();
  const names = expected.fields;
  const statusesMatch =
    fieldText(actual[names.device]) === expected.payload.deviceStatus &&
    fieldText(actual[names.disaster]) === expected.payload.disasterStatus &&
    fieldText(actual[names.materials]) === expected.payload.materialsStatus &&
    fieldText(actual[names.contacts]) === expected.payload.contactsStatus;
  const descriptionsMatch =
    fieldText(actual[names.deviceIssue]) ===
      clean(expected.payload.deviceAbnormalDescription) &&
    fieldText(actual[names.disasterIssue]) ===
      clean(expected.payload.disasterAbnormalDescription) &&
    fieldText(actual[names.materialsIssue]) ===
      clean(expected.payload.materialsAbnormalDescription) &&
    fieldText(actual[names.contactsIssue]) ===
      clean(expected.payload.contactsAbnormalDescription);
  const environmentMatches = expected.needsEnvironment
    ? fieldText(actual[names.environment]) ===
        expected.payload.environmentStatus &&
      sameSingleToken(
        actual[names.environmentImage],
        expected.environmentToken,
      ) &&
      fieldText(actual[names.environmentIssue]) ===
        clean(expected.payload.environmentAbnormalDescription)
    : !fieldText(actual[names.environment]) &&
      attachmentTokens(actual[names.environmentImage]).length === 0 &&
      !fieldText(actual[names.environmentIssue]);
  const confirmedTag = fieldText(actual[names.tag]);
  const tagMatches =
    confirmedTag === expected.tag ||
    (expected.simulation && WEATHER_GUARD_TAG_PATTERN.test(confirmedTag));
  if (
    recordIdentifier(record) !== expected.recordId ||
    fieldMilliseconds(actual[names.date]) !== expected.submittedAtMs ||
    fieldText(actual[names.building]) !== expected.payload.building ||
    fieldText(actual[names.guard]) !== expected.guardLevel ||
    !tagMatches ||
    !samePeople(actual[names.checker], expected.checkerOpenIds) ||
    !samePeople(actual[names.manager], expected.managerOpenIds) ||
    !statusesMatch ||
    !descriptionsMatch ||
    !environmentMatches ||
    !sameSingleToken(actual[names.deviceImage], expected.deviceToken) ||
    !sameSingleToken(actual[names.disasterImage], expected.disasterToken) ||
    fieldText(actual[names.managerConfirmation]) !== '已确认'
  ) {
    throw confirmationMismatch();
  }
}

function fieldMilliseconds(value: unknown): number | null {
  const normalized =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^-?\d+$/u.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  return Number.isSafeInteger(normalized) ? normalized : null;
}

function recordIdentifier(record: BitableRecordItem): string {
  return clean(record.record_id) || clean(record.id);
}

function attachmentTokens(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (typeof item === 'string') {
      const token = clean(item);
      return token ? [token] : [];
    }
    if (!isPlainRecord(item)) return [];
    const token = clean(item.file_token);
    return token ? [token] : [];
  });
}

function sameSingleToken(value: unknown, expected: unknown): boolean {
  const normalizedExpected = clean(expected);
  const actual = attachmentTokens(value);
  return (
    Boolean(normalizedExpected) &&
    actual.length === 1 &&
    actual[0] === normalizedExpected
  );
}

function samePeople(value: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(value) || value.length !== expected.length) return false;
  const actual: string[] = [];
  for (const cell of value) {
    if (!isPlainRecord(cell)) return false;
    const id = clean(cell.id);
    const openId = clean(cell.open_id);
    if (
      (id && !OPEN_ID_PATTERN.test(id)) ||
      (openId && !OPEN_ID_PATTERN.test(openId))
    ) {
      return false;
    }
    if (id && openId && id !== openId) return false;
    const resolved = id || openId;
    if (!resolved) return false;
    actual.push(resolved);
  }
  const sortedExpected = [...expected].sort();
  return actual
    .sort()
    .every((openId, index) => openId === sortedExpected[index]);
}

function fieldText(value: unknown): string {
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return clean(String(value));
  }
  if (Array.isArray(value)) {
    return value.map(fieldText).filter(Boolean).join('；');
  }
  if (!isPlainRecord(value)) return '';
  for (const key of ['text', 'name', 'value']) {
    const text = fieldText(value[key]);
    if (text) return text;
  }
  return '';
}

function buildSubmissionFingerprint(
  payload: WeatherGuardRegistrationRequest,
  files: NormalizedEvidenceFiles,
): string {
  const value = {
    payload,
    files: {
      deviceEvidence: fileFingerprint(files.deviceEvidence),
      disasterEvidence: fileFingerprint(files.disasterEvidence),
      environmentEvidence: fileFingerprint(files.environmentEvidence),
    },
  };
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function fileFingerprint(
  file: WeatherWarningRegistrationUploadFile | undefined,
): Record<string, unknown> | null {
  if (!file) return null;
  return {
    originalname: file.originalname,
    mimetype: file.mimetype,
    size: file.size,
    contentSha256: Buffer.isBuffer(file.buffer)
      ? createHash('sha256').update(file.buffer).digest('hex')
      : 'invalid-buffer',
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  if (isPlainRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function toPublicWarning(
  warning: WeatherWarningDisplayWarning,
): WeatherWarningDisplayWarning {
  return {
    id: warning.id,
    title: warning.title,
    type: warning.type,
    color: warning.color,
    guardLevel: warning.guardLevel,
    ...(warning.startTime ? { startTime: warning.startTime } : {}),
    ...(warning.endTime ? { endTime: warning.endTime } : {}),
    ...(warning.pubTime ? { pubTime: warning.pubTime } : {}),
    ...(warning.status ? { status: warning.status } : {}),
  };
}

function isGuardLevel(value: unknown): value is WeatherWarningGuardLevel {
  return value === '一级戒备' || value === '二级戒备' || value === '三级戒备';
}

function mutationConflict(): ConflictException {
  return new ConflictException('clientMutationId 已被不同的登记内容占用');
}

function createRequestOptions(
  signal?: AbortSignal,
): WeatherWarningRegistrationGatewayRequestOptions {
  const options = {
    signal,
    deadlineAt: Date.now() + REGISTRATION_REQUEST_DEADLINE_MS,
  };
  assertServiceRequestActive(options);
  return options;
}

function createRegistrationWorkControl(): RegistrationWorkControl {
  const controller = new AbortController();
  const deadlineAt = Date.now() + REGISTRATION_REQUEST_DEADLINE_MS;
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, deadlineAt - Date.now()),
  );
  timer.unref?.();
  return {
    options: { signal: controller.signal, deadlineAt },
    dispose: () => clearTimeout(timer),
  };
}

function assertServiceRequestActive(
  options: WeatherWarningRegistrationGatewayRequestOptions,
): void {
  if (
    options.signal?.aborted ||
    options.deadlineAt === undefined ||
    options.deadlineAt <= Date.now()
  ) {
    throw serviceRequestUnavailable();
  }
}

async function waitForServiceRequest<T>(
  promise: Promise<T>,
  options: WeatherWarningRegistrationGatewayRequestOptions,
): Promise<T> {
  assertServiceRequestActive(options);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(serviceRequestUnavailable()));

    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(
      () => finish(() => reject(serviceRequestUnavailable())),
      Math.max(1, options.deadlineAt! - Date.now()),
    );
    timer.unref?.();
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function serviceRequestUnavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException('登记请求已取消或超过处理时限');
}

function confirmationMismatch(): BadGatewayException {
  return new BadGatewayException('登记记录读回内容不一致，未确认提交成功');
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
