import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {assertInventoryManagerNotificationCapacity,inventoryManagerNotificationGeneration,inventoryManagerNotificationRecipients,inventoryManagerNotificationState,normalizeInventoryManagerNotificationInput,normalizeInventoryManagerNotificationHandovers} from './inventory-manager-notification-route';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import { assertSameOutboundApprovalRequest } from './inventory-outbound-approval.validation';
import { inventoryNotificationBatchId } from './inventory-batch-notification-id';
import type {
  InventoryPendingHandover,
  InventoryPendingHandoverInput,
  InventoryManagerNotificationHandoverInput,
  InventoryManagerNotificationHandover,
  InventoryOutboundApprovalApprover,
  InventoryOutboundApprovalBaseSync,
  InventoryOutboundApprovalCardDelivery,
  InventoryOutboundApprovalCardPatch,
  InventoryOutboundApprovalClaimedWorkRef,
  InventoryOutboundApprovalDecision,
  InventoryOutboundApprovalDecisionClaimResult,
  InventoryOutboundApprovalDecisionInput,
  InventoryOutboundApprovalEntry,
  InventoryOutboundApprovalResultNotification,
  InventoryOutboundApprovalRegistration,
  InventoryOutboundApprovalSnapshot,
  InventoryOutboundApprovalWork,
  InventoryOutboundApprovalWorkClaimResult,
  InventoryOutboundApprovalWorkCompletionInput,
  InventoryOutboundApprovalWorkFailureInput,
  InventoryOutboundApprovalWorkKind,
  InventoryOutboundApprovalWorkRef,
  InventoryOutboundApprovalWorkState,
  InventoryOutboundApprovalWorkStatus,
} from './inventory-outbound-approval.types';
import type {
  InventoryOutboundApprovalRecoveredDelivery,
  InventoryOutboundApprovalRecoveredResultDelivery,
  InventoryOutboundApprovalRecoveryResult,
} from './inventory-outbound-approval.recovery';

export const INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH =
  'INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH';
export const INVENTORY_OUTBOUND_APPROVAL_LEDGER_OPTIONS =
  'INVENTORY_OUTBOUND_APPROVAL_LEDGER_OPTIONS';

const LEDGER_VERSION = 1;
const LEGACY_LEDGER_VERSION = 0;
const OWNER_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_STALE_LOCK_MS = 30_000;
const DEFAULT_LOCK_RETRY_DELAY_MS = 10;
const DEFAULT_LOCK_RELEASE_RETRY_WINDOW_MS = 250;
const DEFAULT_LEDGER_PERSIST_RETRY_WINDOW_MS = 500;
const MAX_DEFERRED_LOCK_RELEASE_DELAY_MS = 1_000;
const DEFAULT_WORK_LEASE_MS = 60_000;
const DEFAULT_RETENTION_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_MAX_FILE_BYTES = 16 * 1_024 * 1_024;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;
const REJECTION_REASON_CONTROL_CHARACTER_PATTERN =
  /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MESSAGE_ID_PATTERN = /^om_[A-Za-z0-9_-]{3,256}$/u;
const PROCESS_STARTED_AT_MS = Math.round(Date.now() - process.uptime() * 1_000);
const EXPIRED_WORK_MESSAGE = '处理进程租约已失效，等待使用原幂等标识重试';
const SUPERSEDED_WORK_PREFIX = '审批版本已失效，已由版本 ';

interface Owner {
  version: 1;
  token: string;
  pid: number;
  processStartedAtMs: number;
  acquiredAt: string;
  instanceToken?: string;
  leaseExpiresAt?: string;
}

type PersistedWork<T extends InventoryOutboundApprovalWorkState> = T & {
  owner?: Owner;
};

type PersistedApprovalCard =
  PersistedWork<InventoryOutboundApprovalCardDelivery>;
type PersistedBaseSync = PersistedWork<InventoryOutboundApprovalBaseSync>;
type PersistedCardPatch = PersistedWork<InventoryOutboundApprovalCardPatch>;
type PersistedResultNotification =
  PersistedWork<InventoryOutboundApprovalResultNotification>;
type AnyPersistedWork =
  | PersistedApprovalCard
  | PersistedBaseSync
  | PersistedCardPatch
  | PersistedResultNotification;

interface PersistedEntry extends Omit<
  InventoryOutboundApprovalEntry,
  'approvalCards' | 'baseSync' | 'cardPatches' | 'resultNotifications'
> {
  approvalCards: PersistedApprovalCard[];
  baseSync?: PersistedBaseSync;
  cardPatches: PersistedCardPatch[];
  resultNotifications: PersistedResultNotification[];
}

interface PersistedLedger {
  version: 1;
  updatedAt: string;
  entries: PersistedEntry[];
}

interface LoadedLedger {
  entries: PersistedEntry[];
  changed: boolean;
}

export interface InventoryOutboundApprovalStoreOptions {
  now?: () => Date;
  retentionTtlMs?: number;
  maxEntries?: number;
  maxFileBytes?: number;
  lockTimeoutMs?: number;
  staleLockMs?: number;
  lockRetryDelayMs?: number;
  workLeaseMs?: number;
}

@Injectable()
export class InventoryOutboundApprovalStore {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly now: () => Date;
  private readonly retentionTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxFileBytes: number;
  private readonly lockTimeoutMs: number;
  private readonly staleLockMs: number;
  private readonly lockRetryDelayMs: number;
  private readonly workLeaseMs: number;
  private readonly instanceToken = randomUUID();
  private readonly claimedWorkLeases = new Map<string, string>();
  private deferredLockRelease: Owner | null = null;
  private deferredLockReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private deferredLockReleaseAttempt = 0;
  private failed: ServiceUnavailableException | null = null;

  constructor(
    @Optional()
    @Inject(INVENTORY_OUTBOUND_APPROVAL_LEDGER_PATH)
    ledgerPathValue?: string,
    @Optional()
    @Inject(INVENTORY_OUTBOUND_APPROVAL_LEDGER_OPTIONS)
    options: InventoryOutboundApprovalStoreOptions = {},
  ) {
    this.ledgerPath = resolve(
      clean(ledgerPathValue) ||
        join(
          process.cwd(),
          '.runtime',
          'inventory-outbound-approval-ledger.json',
        ),
    );
    this.lockPath = `${this.ledgerPath}.lock`;
    this.now = options.now || (() => new Date());
    this.retentionTtlMs = positiveInteger(
      options.retentionTtlMs,
      DEFAULT_RETENTION_TTL_MS,
    );
    this.maxEntries = positiveInteger(options.maxEntries, DEFAULT_MAX_ENTRIES);
    this.maxFileBytes = positiveInteger(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
    );
    this.lockTimeoutMs = positiveInteger(
      options.lockTimeoutMs,
      DEFAULT_LOCK_TIMEOUT_MS,
    );
    this.staleLockMs = positiveInteger(
      options.staleLockMs,
      DEFAULT_STALE_LOCK_MS,
    );
    this.lockRetryDelayMs = positiveInteger(
      options.lockRetryDelayMs,
      DEFAULT_LOCK_RETRY_DELAY_MS,
    );
    this.workLeaseMs = positiveInteger(
      options.workLeaseMs,
      DEFAULT_WORK_LEASE_MS,
    );
  }

  async registerPending(
    snapshotValue: InventoryOutboundApprovalSnapshot,
    options: { reuseExistingRequest?: boolean } = {},
  ): Promise<{
    created: boolean;
    entry: InventoryOutboundApprovalEntry;
  }> {
    const snapshot = normalizeSnapshot(snapshotValue);
    const snapshotFingerprint = fingerprintSnapshot(snapshot);
    const key = entryKey(snapshot.recordId, snapshot.version);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      const existing = loaded.entries.find(
        (entry) => entryKeyFor(entry) === key,
      );
      if (existing) {
        if (options.reuseExistingRequest === true) {
          assertSameOutboundApprovalRequest(snapshot, existing.snapshot);
          if (snapshot.policyVersion !== existing.snapshot.policyVersion) {
            throw new ConflictException('同一出库记录和审批版本的审批策略冲突');
          }
        } else if (existing.snapshotFingerprint !== snapshotFingerprint) {
          throw new ConflictException('同一出库记录和审批版本的审批快照冲突');
        }
        if (loaded.changed) await this.persistLocked(loaded.entries, key);
        return { created: false, entry: clonePublicEntry(existing) };
      }

      evictForCapacity(loaded.entries, this.maxEntries - 1, new Set([key]));
      if (loaded.entries.length >= this.maxEntries) {
        throw new ServiceUnavailableException(
          '出库审批账本容量已满，存在不能安全清理的活跃审批记录',
        );
      }
      const nowIso = this.now().toISOString();
      const entry: PersistedEntry = {
        snapshot,
        snapshotFingerprint,
        registeredAt: nowIso,
        updatedAt: nowIso,
        registration: createPendingRegistration(),
        approvalCards: createApprovalCardDeliveries(snapshot),
        cardPatches: [],
        resultNotifications: [],
      };
      loaded.entries.push(entry);
      await this.persistLocked(loaded.entries, key);
      return { created: true, entry: clonePublicEntry(entry) };
    });
  }

  async acceptPendingHandover(
    value: InventoryPendingHandoverInput,
  ): Promise<{ status: 'accepted' | 'already_completed'; version: number }> {
    const input = normalizePendingHandoverInput(value);
    const key = entryKey(input.recordId, input.expectedVersion);
    const fingerprint = pendingHandoverFingerprint(input);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      const entry = requireEntry(loaded.entries, key);
      const prior = entry.personnelHandover;
      if (prior) {
        if (prior.mutationId !== input.mutationId || prior.fingerprint !== fingerprint) {
          throw new ConflictException('出库交接回执身份或载荷不一致');
        }
        if (loaded.changed) await this.persistLocked(loaded.entries, key);
        return { status: 'accepted', version: prior.targetVersion };
      }
      if (!entry.snapshot.approvers.some(person => person.openId === input.sourceOpenId)) {
        throw new ConflictException('原负责人不在出库审批快照中');
      }
      if (entry.decision) return { status: 'already_completed', version: input.expectedVersion };
      if (entry.snapshot.applicantOpenId === input.target.openId) {
        throw new ConflictException('接任人不能审批自己的出库申请');
      }
      if (entry.registration.status !== 'ready' || supersededByVersion(entry)) {
        throw new ConflictException('原出库待审批状态尚未确认或已失效');
      }
      const chain = requireCompleteSupersessionChain(loaded.entries, input.recordId);
      if (chain[chain.length - 1] !== entry) throw new ConflictException('出库审批已存在新版本');
      if (entry.personnelHandoverFromVersion !== undefined) {
        const previous = requireEntry(loaded.entries, entryKey(input.recordId, entry.personnelHandoverFromVersion));
        if (previous.cardPatches.some(work => work.status !== 'completed')) throw new ConflictException('上一次出库交接尚未完成');
      }
      if (allWorks(entry).some(work => work.status === 'running' ||
        (work.kind === 'approvalCardDelivery' && work.status === 'error' && work.attemptCount > 0))) {
        throw new ServiceUnavailableException('原卡投递结果尚未明确，请先恢复原投递任务');
      }
      const targetVersion = input.expectedVersion + 1;
      const targetKey = entryKey(input.recordId, targetVersion);
      evictForCapacity(loaded.entries, this.maxEntries - 1, new Set([...chain.map(entryKeyFor), targetKey]));
      if (loaded.entries.length >= this.maxEntries) throw new ServiceUnavailableException('出库审批账本容量已满，不能安全交接');
      const nowIso = this.now().toISOString();
      const snapshot = normalizeSnapshot({ ...entry.snapshot, version: targetVersion,
        ...(entry.managerNotificationHandovers?.length ? {managerRecipients:inventoryManagerNotificationRecipients(entry).map(({openId,name})=>({openId,name}))} : {}),
        approvers: entry.snapshot.approvers.map(person => person.openId === input.sourceOpenId
          ? { openId: input.target.openId, name: input.target.name } : person),
      });
      entry.personnelHandover = { ...input, fingerprint, targetVersion, acceptedAt: nowIso };
      for (const card of entry.approvalCards) {
        if (card.status === 'completed' && card.messageId) entry.cardPatches.push(createCardPatch(card));
        else cancelWork(card, nowIso, `${SUPERSEDED_WORK_PREFIX}${targetVersion}`);
      }
      entry.updatedAt = nowIso;
      loaded.entries.push({ snapshot, snapshotFingerprint: fingerprintSnapshot(snapshot), registeredAt: nowIso,
        updatedAt: nowIso, registration: createPendingRegistration(), approvalCards: createApprovalCardDeliveries(snapshot),
        cardPatches: [], resultNotifications: [], personnelHandoverFromVersion: input.expectedVersion });
      await this.persistLocked(loaded.entries, targetKey);
      return { status: 'accepted', version: targetVersion };
    });
  }

  async acceptManagerNotificationHandover(value:InventoryManagerNotificationHandoverInput):Promise<{status:'accepted'|'already_completed';generation:number}> {
    const input=normalizeInventoryManagerNotificationInput(value);
    const fingerprint=createHash('sha256').update(JSON.stringify(input)).digest('hex'),key=entryKey(input.recordId,input.expectedVersion);
    return this.withLedgerLock(async()=>{
      const loaded=this.readLatestAndRecover(key),entry=requireEntry(loaded.entries,key),routes=entry.managerNotificationHandovers||[],prior=routes.find(route=>route.mutationId===input.mutationId);
      if(prior){if(prior.fingerprint!==fingerprint)throw new ConflictException('库房知会重复请求身份或载荷不一致');return {status:'accepted',generation:prior.targetGeneration};}
      if(entry.registration.status!=='ready'||supersededByVersion(entry))throw new ConflictException('原出库审批尚未确认或已失效');
      const generation=inventoryManagerNotificationGeneration(entry),source=inventoryManagerNotificationRecipients(entry).find(person=>person.openId===input.sourceOpenId);
      if(generation!==input.expectedGeneration||!source||'personRecordId' in source&&source.personRecordId!==input.sourcePersonRecordId)throw new ConflictException('库房知会岗位或代际已变化');
      const result=entry.resultNotifications.find(work=>work.recipientOpenId===input.sourceOpenId);
      const state = inventoryManagerNotificationState(entry, input.sourceOpenId);
      if(state==='terminal')return {status:'already_completed',generation};
      if(state==='reconcile')throw new ConflictException('原岗位通知投递结果未确认，请先对账');
      if(routes.length>=100)throw new ServiceUnavailableException('库房知会交接历史容量已满');
      const nowIso=this.now().toISOString();
      const nextRoutes=[...routes,{...input,targetGeneration:generation+1,fingerprint,acceptedAt:nowIso}];
      assertInventoryManagerNotificationCapacity(entry.snapshot,nextRoutes);
      entry.managerNotificationHandovers=nextRoutes;
      const keepsOriginalIdentity=entry.snapshot.applicantOpenId===input.sourceOpenId||entry.snapshot.approvers.some(person=>person.openId===input.sourceOpenId);
      if(result&&!keepsOriginalIdentity)cancelWork(result,nowIso,'库房岗位知会已转交，原未发送通知取消');
      if(entry.decision)ensureDecisionWork(entry,nowIso);
      entry.updatedAt=nowIso;refreshEntryCompletion(entry,nowIso);await this.persistLocked(loaded.entries,key);
      return {status:'accepted',generation:generation+1};
    });
  }

  async supersedeApprovedDecision(
    recordIdValue: string,
    versionValue: number,
    replacementValue: InventoryOutboundApprovalSnapshot,
  ): Promise<{
    created: boolean;
    entry: InventoryOutboundApprovalEntry;
  }> {
    const oldKey = normalizeEntryKey(recordIdValue, versionValue);
    const replacement = normalizeSnapshot(replacementValue);
    if (
      replacement.recordId !== clean(recordIdValue) ||
      replacement.version !== versionValue + 1
    ) {
      throw new BadRequestException('替代审批快照必须是同一出库记录的下一版本');
    }
    const replacementKey = entryKey(replacement.recordId, replacement.version);
    const replacementFingerprint = fingerprintSnapshot(replacement);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(oldKey);
      const oldEntry = requireEntry(loaded.entries, oldKey);
      if (oldEntry.decision?.action !== 'approve') {
        throw new ConflictException('仅历史审批通过决定可被重新路由');
      }
      const versionChain = requireCompleteSupersessionChain(
        loaded.entries,
        replacement.recordId,
      );
      let replacementEntry = loaded.entries.find(
        (candidate) => entryKeyFor(candidate) === replacementKey,
      );
      const alreadySuperseded =
        supersededByVersion(oldEntry) === replacement.version;
      if (replacementEntry) {
        if (replacementEntry.snapshotFingerprint !== replacementFingerprint) {
          throw new ConflictException('替代审批快照与已持久化版本冲突');
        }
        if (!alreadySuperseded) {
          throw new ConflictException('替代审批版本存在但旧决定尚未安全失效');
        }
        if (loaded.changed) {
          await this.persistLocked(loaded.entries, replacementKey);
        }
        return { created: false, entry: clonePublicEntry(replacementEntry) };
      }
      if (alreadySuperseded) {
        throw new ConflictException('旧审批已失效但替代审批版本缺失');
      }
      if (versionChain[versionChain.length - 1] !== oldEntry) {
        throw new ConflictException('仅允许从当前审批版本链尾重新路由');
      }
      if (allWorks(oldEntry).some((work) => work.status === 'running')) {
        throw new ServiceUnavailableException(
          '旧审批仍有后台步骤执行中，请稍后重试重新路由',
        );
      }

      evictForCapacity(
        loaded.entries,
        this.maxEntries - 1,
        new Set([
          ...versionChain.map((entry) => entryKeyFor(entry)),
          replacementKey,
        ]),
      );
      if (loaded.entries.length >= this.maxEntries) {
        throw new ServiceUnavailableException(
          '出库审批账本容量已满，无法安全创建替代审批版本',
        );
      }
      const nowIso = this.now().toISOString();
      ensureDecisionWork(oldEntry, nowIso);
      for (const card of oldEntry.approvalCards) {
        if (card.status === 'completed') continue;
        this.claimedWorkLeases.delete(workLocalKey(oldKey, card));
        cancelWork(
          card,
          nowIso,
          `${SUPERSEDED_WORK_PREFIX}${replacement.version}`,
        );
      }
      for (const patch of oldEntry.cardPatches) {
        this.claimedWorkLeases.delete(workLocalKey(oldKey, patch));
        resetWorkPending(patch);
      }
      for (const notification of oldEntry.resultNotifications) {
        if (notification.status === 'completed') continue;
        this.claimedWorkLeases.delete(workLocalKey(oldKey, notification));
        cancelWork(
          notification,
          nowIso,
          `${SUPERSEDED_WORK_PREFIX}${replacement.version}`,
        );
      }
      if (!oldEntry.baseSync) {
        throw new ConflictException('旧审批决定缺少持久 Base 同步步骤');
      }
      this.claimedWorkLeases.delete(workLocalKey(oldKey, oldEntry.baseSync));
      cancelWork(
        oldEntry.baseSync,
        nowIso,
        `${SUPERSEDED_WORK_PREFIX}${replacement.version}`,
      );
      oldEntry.updatedAt = nowIso;
      delete oldEntry.completedAt;

      replacementEntry = {
        snapshot: replacement,
        snapshotFingerprint: replacementFingerprint,
        registeredAt: nowIso,
        updatedAt: nowIso,
        registration: createPendingRegistration(),
        approvalCards: createApprovalCardDeliveries(replacement),
        cardPatches: [],
        resultNotifications: [],
      };
      loaded.entries.push(replacementEntry);
      await this.persistLocked(loaded.entries, replacementKey);
      return { created: true, entry: clonePublicEntry(replacementEntry) };
    });
  }

  async restoreFromBase(
    recoveryValue: Extract<
      InventoryOutboundApprovalRecoveryResult,
      { kind: 'pending' | 'decided' }
    >,
  ): Promise<{ created: boolean; entry: InventoryOutboundApprovalEntry }> {
    if (
      !isRecord(recoveryValue) ||
      (recoveryValue.kind !== 'pending' && recoveryValue.kind !== 'decided')
    ) {
      throw new BadRequestException('出库审批恢复数据无效');
    }
    const snapshot = normalizeSnapshot(recoveryValue.snapshot);
    const snapshotFingerprint = fingerprintSnapshot(snapshot);
    const deliveries = normalizeRecoveredDeliveries(
      recoveryValue.deliveries,
      snapshot,
    );
    const recoveredRoutes = normalizeInventoryManagerNotificationHandovers(
      recoveryValue.kind === 'decided' ? recoveryValue.managerNotificationHandovers : undefined,
      snapshot,
    );
    const key = entryKey(snapshot.recordId, snapshot.version);

    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      let entry = loaded.entries.find(
        (candidate) => entryKeyFor(candidate) === key,
      );
      const created = !entry;
      if (entry) {
        if (entry.snapshotFingerprint !== snapshotFingerprint) {
          throw new ConflictException('同一出库记录和审批版本的审批快照冲突');
        }
        if (entry.personnelHandover && recoveryValue.kind === 'decided') {
          throw new ConflictException('审批版本已失效，不能恢复旧决定');
        }
      } else {
        evictForCapacity(loaded.entries, this.maxEntries - 1, new Set([key]));
        if (loaded.entries.length >= this.maxEntries) {
          throw new ServiceUnavailableException(
            '出库审批账本容量已满，存在不能安全清理的活跃审批记录',
          );
        }
        const createdAt = this.now().toISOString();
        entry = {
          snapshot,
          snapshotFingerprint,
          registeredAt: createdAt,
          updatedAt: createdAt,
          registration: createPendingRegistration(),
          approvalCards: createApprovalCardDeliveries(snapshot),
          cardPatches: [],
          resultNotifications: [],
        };
        loaded.entries.push(entry);
      }

      const nowIso = this.now().toISOString();
      markRegistrationRecoveredReady(entry.registration, nowIso);
      for (const delivery of deliveries) {
        const card = entry.approvalCards.find(
          (candidate) => candidate.recipientOpenId === delivery.recipientOpenId,
        );
        if (!card) {
          throw new ConflictException('恢复的审批卡接收人不在审批快照中');
        }
        if (card.messageId && card.messageId !== delivery.messageId) {
          throw new ConflictException('恢复的审批卡消息编号与本地账本冲突');
        }
        this.claimedWorkLeases.delete(workLocalKey(key, card));
        markRecoveredCardCompleted(card, delivery.messageId, nowIso);
        if (entry.personnelHandover && !entry.cardPatches.some(patch => patch.recipientOpenId === card.recipientOpenId)) {
          entry.cardPatches.push(createCardPatch(card));
        }
      }

      if (recoveryValue.kind === 'decided') {
        const localRoutes = entry.managerNotificationHandovers || [];
        const commonLength = Math.min(localRoutes.length, recoveredRoutes.length);
        if (localRoutes.slice(0, commonLength).some((route, index) =>
          JSON.stringify(route) !== JSON.stringify(recoveredRoutes[index]))) {
          throw new ConflictException('恢复的库房知会交接记录与本地账本冲突');
        }
        if (recoveredRoutes.length > localRoutes.length) {
          entry.managerNotificationHandovers = recoveredRoutes;
        }
        const recoveredDecision = normalizeDecision(
          recoveryValue.decision,
          snapshot,
          entry.approvalCards,
        );
        assertRecoveredDecisionAvailable(
          loaded.entries,
          key,
          recoveredDecision,
        );
        const resultDeliveries = normalizeRecoveredResultDeliveries(
          recoveryValue.resultDeliveries,
          snapshot,
          recoveredDecision,
          recoveredRoutes,
        );
        assertRecoveredMessageIdsAvailable(
          loaded.entries,
          key,
          deliveries,
          resultDeliveries,
        );
        if (
          entry.decision &&
          JSON.stringify(entry.decision) !== JSON.stringify(recoveredDecision)
        ) {
          throw new ConflictException('恢复的审批决议与本地账本冲突');
        }
        entry.decision = recoveredDecision;
        for (const card of entry.approvalCards) {
          if (
            card.status === 'completed' ||
            card.status === 'running' ||
            (card.status === 'error' && card.attemptCount > 0)
          ) {
            continue;
          }
          this.claimedWorkLeases.delete(workLocalKey(key, card));
          markRecoveredCardCancelled(card, nowIso);
        }
        if (recoveryValue.requiresBusinessFinalization === true) {
          if (entry.baseSync) {
            this.claimedWorkLeases.delete(workLocalKey(key, entry.baseSync));
            resetWorkPending(entry.baseSync);
          } else {
            entry.baseSync = createPendingBaseSync();
          }
        } else if (entry.baseSync) {
          this.claimedWorkLeases.delete(workLocalKey(key, entry.baseSync));
          markRecoveredBaseSyncCompleted(entry.baseSync, nowIso);
        } else {
          entry.baseSync = {
            ...createPendingBaseSync(),
            status: 'completed',
            attemptCount: 1,
            lastAttemptAt: nowIso,
            completedAt: nowIso,
          };
        }
        ensureDecisionWork(entry, nowIso);
        for (const delivery of resultDeliveries) {
          const notification = entry.resultNotifications.find(
            (candidate) =>
              candidate.recipientOpenId === delivery.recipientOpenId,
          );
          if (!notification) {
            const historical = createResultNotification(entry, {
              openId: delivery.recipientOpenId, name: delivery.recipientName,
            });
            entry.resultNotifications.push(historical);
          }
          const recoveredNotification = notification || entry.resultNotifications.at(-1)!;
          if (
            recoveredNotification.messageId &&
            recoveredNotification.messageId !== delivery.messageId
          ) {
            throw new ConflictException(
              '恢复的审批结果通知消息编号与本地账本冲突',
            );
          }
          this.claimedWorkLeases.delete(workLocalKey(key, recoveredNotification));
          markRecoveredResultNotificationCompleted(
            recoveredNotification,
            delivery.messageId,
            nowIso,
          );
        }
      } else {
        assertRecoveredMessageIdsAvailable(loaded.entries, key, deliveries, []);
      }

      entry.updatedAt = nowIso;
      refreshEntryCompletion(entry, nowIso);
      await this.persistLocked(loaded.entries, key);
      return { created, entry: clonePublicEntry(entry) };
    });
  }

  async confirmPendingRegistration(
    recordIdValue: string,
    versionValue: number,
  ): Promise<InventoryOutboundApprovalEntry> {
    const key = normalizeEntryKey(recordIdValue, versionValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      const entry = requireEntry(loaded.entries, key);
      if (entry.registration.status === 'ready') {
        if (loaded.changed) await this.persistLocked(loaded.entries, key);
        return clonePublicEntry(entry);
      }
      if (entry.decision) {
        throw new ConflictException('已决议审批记录不能补录待审批 Base 确认');
      }
      const nowIso = this.now().toISOString();
      entry.registration.status = 'ready';
      entry.registration.attemptCount += 1;
      entry.registration.lastAttemptAt = nowIso;
      entry.registration.confirmedAt = nowIso;
      delete entry.registration.lastError;
      entry.updatedAt = nowIso;
      await this.persistLocked(loaded.entries, key);
      return clonePublicEntry(entry);
    });
  }

  async failPendingRegistration(
    recordIdValue: string,
    versionValue: number,
    errorValue: string,
  ): Promise<InventoryOutboundApprovalEntry> {
    const key = normalizeEntryKey(recordIdValue, versionValue);
    const error = requiredText(errorValue, '待审批 Base 写入错误', 2_000);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      const entry = requireEntry(loaded.entries, key);
      if (entry.registration.status === 'ready') {
        if (loaded.changed) await this.persistLocked(loaded.entries, key);
        return clonePublicEntry(entry);
      }
      if (entry.decision) {
        throw new ConflictException('已决议审批记录不能回退待审批 Base 状态');
      }
      const nowIso = this.now().toISOString();
      entry.registration.attemptCount += 1;
      entry.registration.lastAttemptAt = nowIso;
      entry.registration.lastError = error;
      delete entry.registration.confirmedAt;
      entry.updatedAt = nowIso;
      await this.persistLocked(loaded.entries, key);
      return clonePublicEntry(entry);
    });
  }

  async find(
    recordIdValue: string,
    versionValue: number,
  ): Promise<InventoryOutboundApprovalEntry | undefined> {
    const key = normalizeEntryKey(recordIdValue, versionValue);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      const entry = loaded.entries.find(
        (candidate) => entryKeyFor(candidate) === key,
      );
      if (loaded.changed) await this.persistLocked(loaded.entries, key);
      return entry ? clonePublicEntry(entry) : undefined;
    });
  }

  async retryHandoverWork(recordId: string, sourceVersion: number, mutationId: string, authorize: () => void): Promise<void> {
    const key=normalizeEntryKey(recordId,sourceVersion);
    await this.withLedgerLock(async()=>{
      const loaded=this.readLatestAndRecover(key),entry=requireEntry(loaded.entries,key);
      const handover=entry.personnelHandover?.mutationId===mutationId?entry.personnelHandover:undefined;
      const route=entry.managerNotificationHandovers?.find(row=>row.mutationId===mutationId);
      if(!handover&&!route)throw new ConflictException('原出库交接步骤不存在');
      const next=handover?requireEntry(loaded.entries,entryKey(recordId,handover.targetVersion)):entry;
      const works=handover?[...entry.cardPatches,...next.approvalCards]:[
        ...entry.resultNotifications.filter(work=>work.recipientOpenId===route!.target.openId),
        ...entry.cardPatches.filter(work=>work.recipientOpenId===route!.target.openId),
      ];
      authorize();let changed=false;const now=this.now().toISOString();
      for(const work of works){
        if(work.owner||work.status!=='error'&&!(work.status==='pending'&&work.lastError))continue;
        work.status='pending';work.lastError='';work.nextAttemptAt=now;delete work.completedAt;changed=true;
      }
      if(handover&&next.registration.status!=='ready'&&next.registration.lastError){next.registration.lastError='';changed=true;}
      if(changed){entry.updatedAt=now;next.updatedAt=now;}
      if(changed||loaded.changed)await this.persistLocked(loaded.entries,key);
    });
  }

  async listEntries(): Promise<InventoryOutboundApprovalEntry[]> {
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover();
      if (loaded.changed) await this.persistLocked(loaded.entries);
      return loaded.entries.map(clonePublicEntry);
    });
  }

  async claimWork(
    refValue: InventoryOutboundApprovalWorkRef,
  ): Promise<InventoryOutboundApprovalWorkClaimResult> {
    const ref = normalizeWorkRef(refValue);
    const key = entryKey(ref.recordId, ref.version);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      const entry = requireEntry(loaded.entries, key);
      if (supersededByVersion(entry) && ref.kind !== 'cardPatch') {
        throw new ConflictException('审批版本已失效');
      }
      const work = requireWork(entry, ref);
      if (ref.kind === 'approvalCardDelivery' && entry.personnelHandoverFromVersion !== undefined) {
        const previous = requireEntry(loaded.entries, entryKey(ref.recordId, entry.personnelHandoverFromVersion));
        if (previous.cardPatches.some(patch => patch.status !== 'completed')) {
          if (loaded.changed) await this.persistLocked(loaded.entries, key);
          return { claimed: false, work: clonePublicWork(work), entry: clonePublicEntry(entry) };
        }
      }
      const localKey = workLocalKey(key, work);
      const nowMs = this.now().getTime();
      const retryDue =
        !work.nextAttemptAt || Date.parse(work.nextAttemptAt) <= nowMs;
      const decidedCardCanBeReconciled =
        ref.kind === 'approvalCardDelivery' &&
        Boolean(entry.decision) &&
        work.status === 'error' &&
        work.attemptCount > 0;
      const anotherApprovalCardIsRunning =
        ref.kind === 'approvalCardDelivery' &&
        entry.approvalCards.some(
          (candidate) =>
            candidate !== work &&
            candidate.status === 'running' &&
            Boolean(candidate.owner),
        );
      const anotherResultNotificationIsRunning =
        ref.kind === 'resultNotification' &&
        entry.resultNotifications.some(
          (candidate) =>
            candidate !== work &&
            candidate.status === 'running' &&
            Boolean(candidate.owner),
        );
      if (
        (ref.kind === 'approvalCardDelivery' &&
          entry.registration.status !== 'ready') ||
        (ref.kind === 'approvalCardDelivery' &&
          Boolean(entry.decision) &&
          !decidedCardCanBeReconciled) ||
        !retryDue ||
        anotherApprovalCardIsRunning ||
        anotherResultNotificationIsRunning ||
        (work.status !== 'pending' && work.status !== 'error') ||
        work.owner ||
        this.claimedWorkLeases.has(localKey)
      ) {
        if (loaded.changed) await this.persistLocked(loaded.entries, key);
        return {
          claimed: false,
          work: clonePublicWork(work),
          entry: clonePublicEntry(entry),
        };
      }

      work.owner = this.createWorkOwner();
      const leaseToken = work.owner.token;
      work.status = 'running';
      work.attemptCount += 1;
      work.lastAttemptAt = this.now().toISOString();
      delete work.nextAttemptAt;
      entry.updatedAt = this.now().toISOString();
      await this.persistLocked(loaded.entries, key);
      this.claimedWorkLeases.set(localKey, leaseToken);
      return {
        claimed: true,
        leaseToken,
        work: clonePublicWork(work),
        entry: clonePublicEntry(entry),
      };
    });
  }

  async completeWork(
    inputValue: InventoryOutboundApprovalWorkCompletionInput,
  ): Promise<InventoryOutboundApprovalEntry> {
    const input = normalizeWorkCompletionInput(inputValue);
    const key = entryKey(input.recordId, input.version);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      const entry = requireEntry(loaded.entries, key);
      const work = requireWork(entry, input);
      this.assertOwnedWork(key, work, input.leaseToken);

      if (
        work.kind === 'approvalCardDelivery' ||
        work.kind === 'resultNotification'
      ) {
        const messageId = requireMessageId(input.messageId);
        assertMessageIdAvailable(loaded.entries, work, messageId);
        work.messageId = messageId;
      } else if (input.messageId !== undefined) {
        throw new BadRequestException('当前审批后台步骤不接受消息编号');
      }
      work.status = 'completed';
      work.completedAt = this.now().toISOString();
      delete work.owner;
      delete work.nextAttemptAt;
      delete work.lastError;
      entry.updatedAt = this.now().toISOString();
      if (entry.decision) ensureDecisionWork(entry, entry.updatedAt);
      refreshEntryCompletion(entry, this.now().toISOString());
      await this.persistLocked(loaded.entries, key);
      this.claimedWorkLeases.delete(workLocalKey(key, work));
      return clonePublicEntry(entry);
    });
  }

  async failWork(
    inputValue: InventoryOutboundApprovalWorkFailureInput,
  ): Promise<InventoryOutboundApprovalEntry> {
    const input = normalizeWorkFailureInput(inputValue);
    const key = entryKey(input.recordId, input.version);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      const entry = requireEntry(loaded.entries, key);
      const work = requireWork(entry, input);
      this.assertOwnedWork(key, work, input.leaseToken);

      delete work.owner;
      work.status = 'error';
      work.lastError = input.error;
      work.nextAttemptAt = input.nextAttemptAt || this.now().toISOString();
      delete work.completedAt;
      entry.updatedAt = this.now().toISOString();
      if (entry.decision) ensureDecisionWork(entry, entry.updatedAt);
      refreshEntryCompletion(entry, this.now().toISOString());
      await this.persistLocked(loaded.entries, key);
      this.claimedWorkLeases.delete(workLocalKey(key, work));
      return clonePublicEntry(entry);
    });
  }

  async renewWorkClaim(
    refValue: InventoryOutboundApprovalClaimedWorkRef,
  ): Promise<InventoryOutboundApprovalEntry> {
    const ref = normalizeClaimedWorkRef(refValue);
    const key = entryKey(ref.recordId, ref.version);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      const entry = requireEntry(loaded.entries, key);
      const work = requireWork(entry, ref);
      this.assertOwnedWork(key, work, ref.leaseToken);
      work.owner = this.extendWorkOwnerLease(work.owner!);
      entry.updatedAt = this.now().toISOString();
      await this.persistLocked(loaded.entries, key);
      return clonePublicEntry(entry);
    });
  }

  async abandonWorkClaim(
    refValue: InventoryOutboundApprovalClaimedWorkRef,
  ): Promise<boolean> {
    const ref = normalizeClaimedWorkRef(refValue);
    const key = entryKey(ref.recordId, ref.version);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      const entry = requireEntry(loaded.entries, key);
      const work = requireWork(entry, ref);
      const localKey = workLocalKey(key, work);
      this.assertOwnedWork(key, work, ref.leaseToken);
      delete work.owner;
      work.status = 'error';
      work.lastError = '任务租约已主动释放，等待幂等重试';
      work.nextAttemptAt = this.now().toISOString();
      delete work.completedAt;
      entry.updatedAt = this.now().toISOString();
      if (entry.decision) ensureDecisionWork(entry, entry.updatedAt);
      refreshEntryCompletion(entry, this.now().toISOString());
      await this.persistLocked(loaded.entries, key);
      this.claimedWorkLeases.delete(localKey);
      return true;
    });
  }

  async claimDecision(
    inputValue: InventoryOutboundApprovalDecisionInput,
  ): Promise<InventoryOutboundApprovalDecisionClaimResult> {
    const input = normalizeDecisionInput(inputValue);
    const key = entryKey(input.recordId, input.version);
    return this.withLedgerLock(async () => {
      const loaded = this.readLatestAndRecover(key);
      const eventEntry = loaded.entries.find(
        (entry) => entry.decision?.eventId === input.eventId,
      );
      if (eventEntry && entryKeyFor(eventEntry) !== key) {
        throw new ConflictException('审批事件标识已被其他审批载荷占用');
      }
      const entry = requireEntry(loaded.entries, key);
      if (supersededByVersion(entry)) {
        throw new ConflictException('审批版本已失效');
      }
      if (entry.registration.status !== 'ready') {
        throw new ConflictException(
          '待审批 Base 状态尚未确认，不能提交审批决定',
        );
      }
      if (entry.decision) {
        if (decisionMatchesInput(entry.decision, input)) {
          if (loaded.changed) await this.persistLocked(loaded.entries, key);
          return {
            claimed: false,
            idempotent: true,
            decision: clone(entry.decision),
            entry: clonePublicEntry(entry),
          };
        }
        if (entry.decision.eventId === input.eventId) {
          throw new ConflictException('审批事件标识已被不同载荷占用');
        }
        throw new ConflictException('该出库申请已经完成审批');
      }

      const approver = entry.snapshot.approvers.find(
        (candidate) => candidate.openId === input.actorOpenId,
      );
      if (!approver) {
        throw new ForbiddenException('当前人员不在审批人快照中');
      }
      const actorCard = entry.approvalCards.find(
        (card) => card.recipientOpenId === input.actorOpenId,
      );
      if (
        !actorCard ||
        actorCard.status !== 'completed' ||
        actorCard.messageId !== input.messageId
      ) {
        throw new ForbiddenException('审批消息不属于当前审批人');
      }

      const decidedAt = this.now().toISOString();
      const decision: InventoryOutboundApprovalDecision = {
        action: input.action,
        actorOpenId: input.actorOpenId,
        actorName: approver.name,
        messageId: input.messageId,
        eventId: input.eventId,
        decidedAt,
        reason: input.reason || '',
      };
      entry.decision = decision;
      entry.baseSync = createPendingBaseSync();
      for (const card of entry.approvalCards) {
        if (
          card.status === 'completed' ||
          card.status === 'running' ||
          (card.status === 'error' && card.attemptCount > 0)
        ) {
          continue;
        }
        this.claimedWorkLeases.delete(workLocalKey(key, card));
        delete card.owner;
        card.status = 'cancelled';
        card.completedAt = decidedAt;
        delete card.nextAttemptAt;
      }
      ensureDecisionWork(entry, decidedAt);
      entry.updatedAt = decidedAt;
      refreshEntryCompletion(entry, decidedAt);
      await this.persistLocked(loaded.entries, key);
      return {
        claimed: true,
        idempotent: false,
        decision: clone(decision),
        entry: clonePublicEntry(entry),
      };
    });
  }

  getLeaseHeartbeatIntervalMs(): number {
    return Math.max(50, Math.floor(this.workLeaseMs / 3));
  }

  private readLatestAndRecover(protectedKey?: string): LoadedLedger {
    if (this.failed) throw this.failed;
    try {
      if (!existsSync(this.ledgerPath)) return { entries: [], changed: false };
      if (statSync(this.ledgerPath).size > this.maxFileBytes) {
        throw new Error('出库审批账本超过允许的最大字节数');
      }
      const parsed = parseLedger(readFileSync(this.ledgerPath, 'utf8'));
      let changed = parsed.legacy;
      const now = this.now();
      const nowMs = now.getTime();
      const nowIso = now.toISOString();

      for (const entry of parsed.entries) {
        for (const work of allWorks(entry)) {
          if (work.status !== 'running') continue;
          if (work.owner && workOwnerIsActive(work.owner, nowMs)) continue;
          delete work.owner;
          this.claimedWorkLeases.delete(workLocalKey(entryKeyFor(entry), work));
          work.status = 'error';
          work.lastError = EXPIRED_WORK_MESSAGE;
          work.nextAttemptAt = nowIso;
          delete work.completedAt;
          changed = true;
        }
        if (entry.decision && ensureDecisionWork(entry, nowIso)) changed = true;
        if (refreshEntryCompletion(entry, nowIso)) changed = true;
      }

      const retained = parsed.entries.filter((entry) => {
        const key = entryKeyFor(entry);
        if (key === protectedKey || !entryIsEvictable(entry)) return true;
        const completedAt = Date.parse(entry.completedAt || '');
        const expired =
          Number.isFinite(completedAt) &&
          completedAt + this.retentionTtlMs <= nowMs;
        if (expired) changed = true;
        return !expired;
      });
      if (
        evictForCapacity(
          retained,
          this.maxEntries,
          protectedKey ? new Set([protectedKey]) : new Set(),
        )
      ) {
        changed = true;
      }
      if (retained.length > this.maxEntries) {
        throw new ServiceUnavailableException(
          '出库审批账本容量超限，存在不能安全清理的活跃审批记录',
        );
      }
      return { entries: retained, changed };
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error;
      throw this.failClosed(error);
    }
  }

  private createWorkOwner(): Owner {
    const now = this.now();
    return {
      version: OWNER_VERSION,
      token: randomUUID(),
      pid: process.pid,
      processStartedAtMs: PROCESS_STARTED_AT_MS,
      acquiredAt: now.toISOString(),
      instanceToken: this.instanceToken,
      leaseExpiresAt: new Date(now.getTime() + this.workLeaseMs).toISOString(),
    };
  }

  private extendWorkOwnerLease(owner: Owner): Owner {
    return {
      ...owner,
      leaseExpiresAt: new Date(
        this.now().getTime() + this.workLeaseMs,
      ).toISOString(),
    };
  }

  private ownsWork(owner: Owner): boolean {
    return (
      owner.instanceToken === this.instanceToken &&
      owner.pid === process.pid &&
      Math.abs(owner.processStartedAtMs - PROCESS_STARTED_AT_MS) < 5_000
    );
  }

  private assertOwnedWork(
    key: string,
    work: AnyPersistedWork,
    leaseToken: string,
  ): void {
    const localKey = workLocalKey(key, work);
    if (
      work.status !== 'running' ||
      !work.owner ||
      !this.ownsWork(work.owner) ||
      work.owner.token !== leaseToken ||
      this.claimedWorkLeases.get(localKey) !== leaseToken
    ) {
      throw new ServiceUnavailableException('审批后台步骤 lease 所有权已变更');
    }
  }

  private async persistLocked(
    entries: PersistedEntry[],
    protectedKey?: string,
  ): Promise<void> {
    if (this.failed) throw this.failed;
    const updatedAt = this.now().toISOString();
    let serialized = serializeLedger(entries, updatedAt);
    while (Buffer.byteLength(serialized, 'utf8') > this.maxFileBytes) {
      const candidate = oldestEvictableEntry(entries, protectedKey);
      if (!candidate) {
        throw new ServiceUnavailableException(
          '出库审批账本字节容量不足，存在不能安全清理的活跃或受保护记录',
        );
      }
      const index = entries.findIndex(
        (entry) => entryKeyFor(entry) === entryKeyFor(candidate),
      );
      if (index < 0) {
        throw new ServiceUnavailableException('出库审批账本字节容量不足');
      }
      entries.splice(index, 1);
      serialized = serializeLedger(entries, updatedAt);
    }

    const temporaryPath = `${this.ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    let primaryError: unknown;
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, serialized, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      await this.renameLedgerFile(temporaryPath);
    } catch (error) {
      primaryError = error;
    }
    const cleanupError = cleanupTemporaryFile(temporaryPath, descriptor);
    if (primaryError !== undefined) {
      if (isTransientLedgerPersistenceError(primaryError)) {
        const failure = new ServiceUnavailableException(
          `出库审批账本暂时被占用，将自动重试：${safeErrorMessage(primaryError)}`,
        );
        attachCleanupError(failure, cleanupError);
        throw failure;
      }
      const failure = this.failClosed(primaryError);
      attachCleanupError(failure, cleanupError);
      throw failure;
    }
    if (cleanupError !== undefined) {
      if (isTransientLedgerPersistenceError(cleanupError)) {
        throw new ServiceUnavailableException(
          `出库审批账本临时文件清理延后：${safeErrorMessage(cleanupError)}`,
        );
      }
      throw this.failClosed(cleanupError);
    }
  }

  private async renameLedgerFile(temporaryPath: string): Promise<void> {
    await this.renamePathWithWindowsRetry(
      temporaryPath,
      this.ledgerPath,
      DEFAULT_LEDGER_PERSIST_RETRY_WINDOW_MS,
    );
  }

  private async renamePathWithWindowsRetry(
    sourcePath: string,
    destinationPath: string,
    retryWindowMs: number,
  ): Promise<void> {
    const deadline =
      performance.now() + Math.min(this.lockTimeoutMs, retryWindowMs);
    while (true) {
      try {
        renameSync(sourcePath, destinationPath);
        return;
      } catch (error) {
        if (!isTransientLedgerPersistenceError(error)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw error;
        await delay(Math.min(this.lockRetryDelayMs, remaining));
      }
    }
  }

  private async removePathWithWindowsRetry(
    path: string,
    retryWindowMs: number,
  ): Promise<void> {
    const deadline =
      performance.now() + Math.min(this.lockTimeoutMs, retryWindowMs);
    while (true) {
      try {
        unlinkSync(path);
        return;
      } catch (error) {
        if (isFileMissingError(error)) return;
        if (!isTransientLockReleaseError(error)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw error;
        await delay(Math.min(this.lockRetryDelayMs, remaining));
      }
    }
  }

  private async withLedgerLock<T>(operation: () => T | Promise<T>): Promise<T> {
    if (this.failed) throw this.failed;
    const owner = await this.acquireLock();
    let result: T | undefined;
    let primaryError: unknown;
    try {
      result = await operation();
    } catch (error) {
      primaryError = error;
    }
    let cleanupError: unknown;
    try {
      await this.releaseLock(owner);
    } catch (error) {
      cleanupError = error;
    }
    if (
      cleanupError !== undefined &&
      isTransientLockReleaseError(cleanupError)
    ) {
      this.deferLockRelease(owner);
      cleanupError = undefined;
    }
    if (primaryError !== undefined) {
      if (primaryError instanceof Error) {
        attachCleanupError(primaryError, cleanupError);
      }
      if (cleanupError !== undefined) this.failClosed(cleanupError);
      throw primaryError;
    }
    if (cleanupError !== undefined) throw this.failClosed(cleanupError);
    return result as T;
  }

  private async acquireLock(): Promise<Owner> {
    await this.flushDeferredLockRelease();
    try {
      mkdirSync(dirname(this.ledgerPath), { recursive: true });
    } catch (error) {
      throw this.failClosed(error);
    }
    const deadline = performance.now() + this.lockTimeoutMs;
    while (true) {
      const owner: Owner = {
        version: OWNER_VERSION,
        token: randomUUID(),
        pid: process.pid,
        processStartedAtMs: PROCESS_STARTED_AT_MS,
        acquiredAt: this.now().toISOString(),
      };
      let descriptor: number | undefined;
      try {
        descriptor = openSync(this.lockPath, 'wx', 0o600);
        writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        return owner;
      } catch (error) {
        if (descriptor !== undefined) {
          const cleanupError = cleanupOwnedLockFile(this.lockPath, descriptor);
          if (cleanupError !== undefined) throw this.failClosed(error);
        }
        if (!isFileExistsError(error)) throw this.failClosed(error);
      }
      if (await this.reclaimStaleLock()) continue;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        throw new ServiceUnavailableException(
          `出库审批账本暂时繁忙：等待文件锁超时：${this.lockPath}`,
        );
      }
      await delay(Math.min(this.lockRetryDelayMs, remaining));
    }
  }

  private async reclaimStaleLock(): Promise<boolean> {
    const initial = this.inspectReclaimableLock();
    if (initial === 'missing') return true;
    if (initial !== 'reclaimable') return false;
    const recoveryOwner = await this.acquireRecoveryGuard();
    if (!recoveryOwner) return false;
    let result = false;
    let primaryError: unknown;
    try {
      const confirmed = this.inspectReclaimableLock();
      if (confirmed === 'missing') {
        result = true;
      } else if (confirmed === 'reclaimable') {
        const quarantinePath = `${this.lockPath}.${process.pid}.${randomUUID()}.stale`;
        try {
          await this.renamePathWithWindowsRetry(
            this.lockPath,
            quarantinePath,
            DEFAULT_LEDGER_PERSIST_RETRY_WINDOW_MS,
          );
          await this.removePathWithWindowsRetry(
            quarantinePath,
            DEFAULT_LOCK_RELEASE_RETRY_WINDOW_MS,
          );
          result = true;
        } catch (error) {
          if (isFileMissingError(error)) result = true;
          else primaryError = error;
        }
      }
    } catch (error) {
      primaryError = error;
    }
    let cleanupError: unknown;
    try {
      await this.releaseRecoveryGuard(recoveryOwner);
    } catch (error) {
      cleanupError = error;
    }
    if (primaryError !== undefined) {
      const failure = this.failClosed(primaryError);
      attachCleanupError(failure, cleanupError);
      throw failure;
    }
    if (cleanupError !== undefined) throw this.failClosed(cleanupError);
    return result;
  }

  private inspectReclaimableLock(): 'missing' | 'active' | 'reclaimable' {
    try {
      return inspectReclaimablePath(this.lockPath, this.staleLockMs);
    } catch (error) {
      throw this.failClosed(error);
    }
  }

  private async acquireRecoveryGuard(retried = false): Promise<Owner | null> {
    const guardPath = `${this.lockPath}.recovery`;
    const owner: Owner = {
      version: OWNER_VERSION,
      token: randomUUID(),
      pid: process.pid,
      processStartedAtMs: PROCESS_STARTED_AT_MS,
      acquiredAt: this.now().toISOString(),
    };
    let descriptor: number | undefined;
    try {
      descriptor = openSync(guardPath, 'wx', 0o600);
      writeFileSync(descriptor, `${JSON.stringify(owner)}\n`, 'utf8');
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      return owner;
    } catch (error) {
      if (descriptor !== undefined) cleanupOwnedLockFile(guardPath, descriptor);
      if (!isFileExistsError(error)) throw this.failClosed(error);
      if (retried) return null;
      const inspection = inspectReclaimablePath(guardPath, this.staleLockMs);
      if (inspection === 'missing') {
        return await this.acquireRecoveryGuard(true);
      }
      if (inspection === 'active') return null;
      const quarantinePath = `${guardPath}.${process.pid}.${randomUUID()}.stale`;
      try {
        await this.renamePathWithWindowsRetry(
          guardPath,
          quarantinePath,
          DEFAULT_LEDGER_PERSIST_RETRY_WINDOW_MS,
        );
        await this.removePathWithWindowsRetry(
          quarantinePath,
          DEFAULT_LOCK_RELEASE_RETRY_WINDOW_MS,
        );
      } catch (quarantineError) {
        if (!isFileMissingError(quarantineError)) {
          throw this.failClosed(quarantineError);
        }
      }
      return await this.acquireRecoveryGuard(true);
    }
  }

  private async releaseRecoveryGuard(owner: Owner): Promise<void> {
    await this.releaseOwnedPath(
      `${this.lockPath}.recovery`,
      owner,
      '出库审批账本文件锁恢复权已丢失',
    );
  }

  private async releaseLock(owner: Owner): Promise<void> {
    await this.releaseOwnedPath(
      this.lockPath,
      owner,
      '出库审批账本文件锁所有权已丢失',
    );
  }

  private async releaseOwnedPath(
    path: string,
    owner: Owner,
    ownershipError: string,
  ): Promise<void> {
    const deadline =
      performance.now() +
      Math.min(this.lockTimeoutMs, DEFAULT_LOCK_RELEASE_RETRY_WINDOW_MS);
    while (true) {
      try {
        const current = parseOwner(readFileSync(path, 'utf8'));
        if (!current || current.token !== owner.token) {
          throw new Error(ownershipError);
        }
        unlinkSync(path);
        return;
      } catch (error) {
        if (isFileMissingError(error)) return;
        if (!isTransientLockReleaseError(error)) throw error;
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw error;
        await delay(Math.min(this.lockRetryDelayMs, remaining));
      }
    }
  }

  private deferLockRelease(owner: Owner): void {
    this.deferredLockRelease = owner;
    this.deferredLockReleaseAttempt = 0;
    this.scheduleDeferredLockRelease();
  }

  private async flushDeferredLockRelease(): Promise<void> {
    const owner = this.deferredLockRelease;
    if (!owner) return;
    try {
      await this.releaseLock(owner);
      if (this.deferredLockRelease?.token === owner.token) {
        this.deferredLockRelease = null;
        this.deferredLockReleaseAttempt = 0;
      }
    } catch (error) {
      if (isTransientLockReleaseError(error)) {
        this.scheduleDeferredLockRelease();
        return;
      }
      if (this.deferredLockRelease?.token === owner.token) {
        this.deferredLockRelease = null;
        this.deferredLockReleaseAttempt = 0;
      }
    }
  }

  private scheduleDeferredLockRelease(): void {
    if (this.deferredLockReleaseTimer || !this.deferredLockRelease) return;
    const delayMs = Math.min(
      MAX_DEFERRED_LOCK_RELEASE_DELAY_MS,
      this.lockRetryDelayMs * 2 ** Math.min(this.deferredLockReleaseAttempt, 6),
    );
    this.deferredLockReleaseAttempt += 1;
    this.deferredLockReleaseTimer = setTimeout(() => {
      this.deferredLockReleaseTimer = null;
      void this.flushDeferredLockRelease();
    }, delayMs);
    this.deferredLockReleaseTimer.unref?.();
  }

  private failClosed(error: unknown): ServiceUnavailableException {
    if (!this.failed) {
      this.failed = new ServiceUnavailableException(
        `出库审批账本不可用：${safeErrorMessage(error)}`,
      );
    }
    return this.failed;
  }
}

function normalizeSnapshot(
  value: InventoryOutboundApprovalSnapshot,
): InventoryOutboundApprovalSnapshot {
  if (!isRecord(value)) throw new BadRequestException('出库审批快照无效');
  const recordId = requiredText(value.recordId, '出库记录编号', 256);
  const outboundNumber = requiredText(value.outboundNumber, '出库编号', 128);
  const version = positiveVersion(value.version);
  const policyVersion = requiredText(value.policyVersion, '审批策略版本', 128);
  const applicantOpenId = requiredText(
    value.applicantOpenId,
    '申请人 Open ID',
    256,
  );
  const applicantName = optionalText(value.applicantName, 128);
  const itemName = requiredText(value.itemName, '物品名称', 256);
  const sku = requiredText(value.sku, '物品类别号', 128);
  const specification = optionalText(value.specification, 512);
  const brand = optionalText(value.brand, 256);
  const unit = requiredText(value.unit, '计数单位', 64);
  const location = requiredText(value.location, '存放位置', 512);
  const reason = requiredText(value.reason, '出库原因', 2_000);
  if (
    !Number.isFinite(value.quantity) ||
    value.quantity <= 0 ||
    !Number.isFinite(value.availableStock) ||
    value.availableStock < 0
  ) {
    throw new BadRequestException('出库审批数量或库存快照无效');
  }
  if (!WAREHOUSE_BUILDINGS.includes(value.building)) {
    throw new BadRequestException('出库审批楼栋无效');
  }
  if (!validTimestamp(value.appliedAt)) {
    throw new BadRequestException('出库申请时间无效');
  }
  if (!Array.isArray(value.approvers) || value.approvers.length === 0) {
    throw new BadRequestException('出库审批人快照不能为空');
  }
  const approverMap = new Map<string, InventoryOutboundApprovalApprover>();
  for (const valueApprover of value.approvers) {
    if (!isRecord(valueApprover)) {
      throw new BadRequestException('出库审批人快照无效');
    }
    const openId = requiredText(valueApprover.openId, '审批人 Open ID', 256);
    const name = optionalText(valueApprover.name, 128);
    const existing = approverMap.get(openId);
    if (existing && existing.name !== name) {
      throw new BadRequestException('同一审批人 Open ID 对应多个姓名');
    }
    approverMap.set(openId, { openId, name });
  }
  const approvers = Array.from(approverMap.values()).sort((left, right) =>
    left.openId.localeCompare(right.openId),
  );
  let managerRecipients:
    | InventoryOutboundApprovalApprover[]
    | undefined;
  if (Object.prototype.hasOwnProperty.call(value, 'managerRecipients')) {
    if (!Array.isArray(value.managerRecipients)) {
      throw new BadRequestException('库房管理人知会快照无效');
    }
    const managerMap = new Map<string, InventoryOutboundApprovalApprover>();
    for (const valueManager of value.managerRecipients) {
      if (!isRecord(valueManager)) {
        throw new BadRequestException('库房管理人知会快照无效');
      }
      const openId = requiredText(
        valueManager.openId,
        '库房管理人 Open ID',
        256,
      );
      const name = optionalText(valueManager.name, 128);
      const existing = managerMap.get(openId);
      if (existing && existing.name !== name) {
        throw new BadRequestException('同一库房管理人 Open ID 对应多个姓名');
      }
      managerMap.set(openId, { openId, name });
    }
    managerRecipients = Array.from(managerMap.values()).sort((left, right) =>
      left.openId.localeCompare(right.openId),
    );
  }
  return {
    recordId,
    outboundNumber,
    version,
    policyVersion,
    applicantOpenId,
    applicantName,
    itemName,
    sku,
    specification,
    brand,
    quantity: value.quantity,
    unit,
    availableStock: value.availableStock,
    building: value.building,
    location,
    reason,
    appliedAt: value.appliedAt,
    approvers,
    ...(managerRecipients ? { managerRecipients } : {}),
  };
}

function normalizeDecisionInput(
  value: InventoryOutboundApprovalDecisionInput,
): InventoryOutboundApprovalDecisionInput & { reason: string } {
  if (!isRecord(value)) throw new BadRequestException('审批动作无效');
  const action = value.action;
  if (action !== 'approve' && action !== 'reject') {
    throw new BadRequestException('审批动作无效');
  }
  const reason = normalizeRejectionReason(value.reason);
  const reasonLength = Array.from(reason).length;
  if (action === 'reject' && (reasonLength < 2 || reasonLength > 500)) {
    throw new BadRequestException('驳回原因需填写 2–500 字');
  }
  if (action === 'approve' && reason) {
    throw new BadRequestException('同意动作不能填写驳回原因');
  }
  return {
    recordId: requiredText(value.recordId, '出库记录编号', 256),
    version: positiveVersion(value.version),
    actorOpenId: requiredText(value.actorOpenId, '审批人 Open ID', 256),
    messageId: requireMessageId(value.messageId),
    eventId: requiredText(value.eventId, '审批事件标识', 256),
    action,
    reason,
  };
}

function normalizeWorkRef(
  value: InventoryOutboundApprovalWorkRef,
): InventoryOutboundApprovalWorkRef {
  if (!isRecord(value)) throw new BadRequestException('审批后台步骤引用无效');
  const kinds: InventoryOutboundApprovalWorkKind[] = [
    'approvalCardDelivery',
    'baseSync',
    'cardPatch',
    'resultNotification',
  ];
  if (!kinds.includes(value.kind)) {
    throw new BadRequestException('审批后台步骤类型无效');
  }
  const recipientOpenId = optionalText(value.recipientOpenId, 256);
  if (value.kind === 'baseSync' && recipientOpenId) {
    throw new BadRequestException('Base 同步步骤不能包含接收人');
  }
  if (value.kind !== 'baseSync' && !recipientOpenId) {
    throw new BadRequestException('审批后台步骤缺少接收人');
  }
  return {
    recordId: requiredText(value.recordId, '出库记录编号', 256),
    version: positiveVersion(value.version),
    kind: value.kind,
    ...(recipientOpenId ? { recipientOpenId } : {}),
  };
}

function normalizeClaimedWorkRef(
  value: InventoryOutboundApprovalClaimedWorkRef,
): InventoryOutboundApprovalClaimedWorkRef {
  const ref = normalizeWorkRef(value);
  const leaseToken = requiredText(
    value.leaseToken,
    '审批后台步骤 lease token',
    64,
  );
  if (!UUID_PATTERN.test(leaseToken)) {
    throw new BadRequestException('审批后台步骤 lease token 无效');
  }
  return { ...ref, leaseToken };
}

function normalizeWorkCompletionInput(
  value: InventoryOutboundApprovalWorkCompletionInput,
): InventoryOutboundApprovalWorkCompletionInput {
  return {
    ...normalizeClaimedWorkRef(value),
    ...(value.messageId !== undefined
      ? { messageId: requireMessageId(value.messageId) }
      : {}),
  };
}

function normalizeWorkFailureInput(
  value: InventoryOutboundApprovalWorkFailureInput,
): InventoryOutboundApprovalWorkFailureInput {
  const ref = normalizeClaimedWorkRef(value);
  const error = requiredText(value.error, '审批后台步骤错误', 2_000);
  if (
    value.nextAttemptAt !== undefined &&
    !validTimestamp(value.nextAttemptAt)
  ) {
    throw new BadRequestException('审批后台步骤重试时间无效');
  }
  return {
    ...ref,
    error,
    ...(value.nextAttemptAt ? { nextAttemptAt: value.nextAttemptAt } : {}),
  };
}

function parseLedger(raw: string): {
  entries: PersistedEntry[];
  legacy: boolean;
} {
  if (!raw.trim()) return { entries: [], legacy: true };
  const parsed = JSON.parse(raw) as unknown;
  if (
    !isRecord(parsed) ||
    (parsed.version !== LEDGER_VERSION &&
      parsed.version !== LEGACY_LEDGER_VERSION) ||
    !validTimestamp(parsed.updatedAt) ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error('出库审批账本结构或版本无效');
  }
  const legacy = parsed.version === LEGACY_LEDGER_VERSION;
  const entries = parsed.entries.map((entry) =>
    normalizePersistedEntry(entry, legacy),
  );
  const keys = new Set<string>();
  const eventIds = new Set<string>();
  const messageIds = new Map<string, { entry: PersistedEntry; work: PersistedApprovalCard | PersistedResultNotification }>();
  for (const entry of entries) {
    const key = entryKeyFor(entry);
    if (keys.has(key)) throw new Error('出库审批账本存在重复记录版本');
    keys.add(key);
    if (entry.decision) {
      if (eventIds.has(entry.decision.eventId)) {
        throw new Error('出库审批账本存在重复审批事件');
      }
      eventIds.add(entry.decision.eventId);
    }
    for (const work of [...entry.approvalCards, ...entry.resultNotifications]) {
      if (!work.messageId) continue;
      const previous = messageIds.get(work.messageId);
      if (previous && !sameBatchMessageBinding(entry, work, previous.entry, previous.work)) {
        throw new Error('出库审批账本存在重复飞书消息编号');
      }
      messageIds.set(work.messageId, { entry, work });
    }
  }
  for (const entry of entries) {
    if (entry.personnelHandover) {
      const handover = entry.personnelHandover;
      const next = entries.find(candidate => candidate.snapshot.recordId === entry.snapshot.recordId && candidate.snapshot.version === handover.targetVersion);
      if (!next || next.personnelHandoverFromVersion !== entry.snapshot.version ||
        !next.snapshot.approvers.some(person => person.openId === handover.target.openId) ||
        next.snapshot.approvers.some(person => person.openId === handover.sourceOpenId)) throw new Error('出库交接版本链或人员证据不一致');
      assertSameOutboundApprovalRequest(entry.snapshot, next.snapshot);
      const expected = normalizeSnapshot({ ...entry.snapshot, version: handover.targetVersion,
        ...(entry.managerNotificationHandovers?.length ? {managerRecipients:inventoryManagerNotificationRecipients(entry).map(({openId,name})=>({openId,name}))} : {}),
        approvers: entry.snapshot.approvers.map(person => person.openId === handover.sourceOpenId
          ? { openId: handover.target.openId, name: handover.target.name } : person) });
      if (fingerprintSnapshot(expected) !== next.snapshotFingerprint) throw new Error('出库交接替代快照不一致');
    }
    if (entry.personnelHandoverFromVersion !== undefined && !entries.some(candidate => candidate.snapshot.recordId === entry.snapshot.recordId && candidate.snapshot.version === entry.personnelHandoverFromVersion && candidate.personnelHandover?.targetVersion === entry.snapshot.version)) throw new Error('出库交接缺少原版本证据');
  }
  return { entries, legacy };
}

function normalizePendingHandoverInput(value: InventoryPendingHandoverInput): InventoryPendingHandoverInput {
  if (!value || !value.target || !/^rec[A-Za-z0-9_]+$/u.test(value.recordId) ||
    !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1 || value.expectedVersion >= Number.MAX_SAFE_INTEGER ||
    !/^handover-[a-f0-9]{64}$/u.test(value.mutationId) || !/^rec[A-Za-z0-9_]+$/u.test(value.dutyRecordId) ||
    !/^rec[A-Za-z0-9_]+$/u.test(value.sourcePersonRecordId) || !/^rec[A-Za-z0-9_]+$/u.test(value.target.personRecordId) ||
    value.sourcePersonRecordId === value.target.personRecordId || !/^ou_[A-Za-z0-9_-]+$/u.test(value.sourceOpenId) ||
    !/^ou_[A-Za-z0-9_-]+$/u.test(value.target.openId) || value.sourceOpenId === value.target.openId ||
    !clean(value.target.name) || clean(value.target.name).length > 256 || CONTROL_CHARACTER_PATTERN.test(value.target.name)) {
    throw new BadRequestException('出库交接人员、职责或版本无效');
  }
  return { recordId: value.recordId, expectedVersion: value.expectedVersion, mutationId: value.mutationId,
    dutyRecordId: value.dutyRecordId, sourcePersonRecordId: value.sourcePersonRecordId, sourceOpenId: value.sourceOpenId,
    target: { personRecordId: value.target.personRecordId, openId: value.target.openId, name: clean(value.target.name) } };
}

function pendingHandoverFingerprint(value: InventoryPendingHandoverInput): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}


function normalizePendingHandover(value: unknown, snapshot: InventoryOutboundApprovalSnapshot): InventoryPendingHandover {
  if (!isRecord(value)) throw new Error('出库交接账本证据无效');
  const input = normalizePendingHandoverInput(value as unknown as InventoryPendingHandoverInput);
  if (input.recordId !== snapshot.recordId || input.expectedVersion !== snapshot.version ||
    value.targetVersion !== snapshot.version + 1 || value.fingerprint !== pendingHandoverFingerprint(input) ||
    !validTimestamp(value.acceptedAt) || !snapshot.approvers.some(person => person.openId === input.sourceOpenId)) throw new Error('出库交接账本指纹或版本不一致');
  return { ...input, targetVersion: snapshot.version + 1, fingerprint: value.fingerprint as string, acceptedAt: value.acceptedAt as string };
}

function normalizeHandoverFromVersion(value: unknown, version: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value !== version - 1) throw new Error('出库交接原版本无效');
  return value;
}

function normalizePersistedEntry(
  value: unknown,
  legacy: boolean,
): PersistedEntry {
  if (!isRecord(value)) throw new Error('出库审批账本条目无效');
  const snapshot = normalizeSnapshot(
    value.snapshot as InventoryOutboundApprovalSnapshot,
  );
  const expectedFingerprint = fingerprintSnapshot(snapshot);
  const storedFingerprint = clean(value.snapshotFingerprint);
  if (!legacy && !storedFingerprint) {
    throw new Error('出库审批账本快照缺少指纹');
  }
  if (storedFingerprint && storedFingerprint !== expectedFingerprint) {
    throw new Error('出库审批账本快照指纹不一致');
  }
  const registeredAt = validTimestamp(value.registeredAt)
    ? value.registeredAt
    : legacy
      ? snapshot.appliedAt
      : invalidTimestamp('出库审批注册时间无效');
  const updatedAt = validTimestamp(value.updatedAt)
    ? value.updatedAt
    : legacy
      ? registeredAt
      : invalidTimestamp('出库审批更新时间无效');
  const cards = Array.isArray(value.approvalCards)
    ? value.approvalCards.map((work) => normalizeApprovalCard(work, snapshot))
    : legacy
      ? createApprovalCardDeliveries(snapshot)
      : invalidArray('出库审批卡投递列表无效');
  assertApprovalCardSnapshot(cards, snapshot);
  const decision = value.decision
    ? normalizeDecision(value.decision, snapshot, cards)
    : undefined;
  const registration = normalizeRegistration(
    value.registration,
    legacy,
    registeredAt,
    cards,
    decision,
  );
  const baseSync = value.baseSync
    ? normalizeBaseSync(value.baseSync)
    : undefined;
  const cardPatches = Array.isArray(value.cardPatches)
    ? value.cardPatches.map((work) => normalizeCardPatch(work, snapshot, cards))
    : legacy
      ? []
      : invalidArray('出库审批卡更新列表无效');
  const managerNotificationHandovers=normalizeInventoryManagerNotificationHandovers(value.managerNotificationHandovers,snapshot);
  const historicalRecipients=resultRecipientsFor(snapshot);for(const route of managerNotificationHandovers)historicalRecipients.set(route.target.openId,route.target);
  const resultNotifications = Array.isArray(value.resultNotifications)
    ? value.resultNotifications.map((work) =>
          normalizeResultNotification(work, snapshot, decision, historicalRecipients),
      )
    : legacy
      ? []
      : invalidArray('出库审批结果通知列表无效');
  const entry: PersistedEntry = {
    snapshot,
    snapshotFingerprint: expectedFingerprint,
    registeredAt,
    updatedAt,
    registration,
    approvalCards: cards,
    ...(decision ? { decision } : {}),
    ...(baseSync ? { baseSync } : {}),
    cardPatches,
    resultNotifications,
    ...(value.managerNotificationHandovers!==undefined?{managerNotificationHandovers}:{}),
    ...(value.personnelHandover !== undefined ? { personnelHandover: normalizePendingHandover(value.personnelHandover, snapshot) } : {}),
    ...(value.personnelHandoverFromVersion !== undefined ? { personnelHandoverFromVersion: normalizeHandoverFromVersion(value.personnelHandoverFromVersion, snapshot.version) } : {}),
    ...(value.completedAt !== undefined
      ? {
          completedAt: validTimestamp(value.completedAt)
            ? value.completedAt
            : invalidTimestamp('出库审批完成时间无效'),
        }
      : {}),
  };
  if (!entry.decision) {
    if (
      entry.baseSync ||
      (entry.cardPatches.length > 0 && !entry.personnelHandover) ||
      entry.resultNotifications.length > 0 ||
      entry.completedAt
    ) {
      throw new Error('未决议审批记录包含终态后台步骤');
    }
  } else if (!entry.baseSync) {
    throw new Error('已决议审批记录缺少 Base 同步步骤');
  }
  if (entry.personnelHandover && (entry.decision || entry.baseSync || entry.resultNotifications.length ||
    entry.approvalCards.some(card => card.status !== 'completed' && card.status !== 'cancelled') ||
    entry.cardPatches.length !== entry.approvalCards.filter(card => card.status === 'completed' && card.messageId).length)) throw new Error('出库交接旧版本后台步骤不一致');
  if (entry.decision && entry.registration.status !== 'ready') {
    throw new Error('已决议审批记录的待审批 Base 状态未经确认');
  }
  if (
    entry.registration.status !== 'ready' &&
    approvalCardDeliveryEvidence(cards)
  ) {
    throw new Error('未确认待审批 Base 状态却已存在审批卡投递');
  }
  assertUniqueWorkRecipients(entry.cardPatches, '出库审批卡更新');
  assertUniqueWorkRecipients(entry.resultNotifications, '出库审批结果通知');
  return entry;
}

function normalizeRegistration(
  value: unknown,
  legacy: boolean,
  registeredAt: string,
  cards: PersistedApprovalCard[],
  decision: InventoryOutboundApprovalDecision | undefined,
): InventoryOutboundApprovalRegistration {
  if (!isRecord(value)) {
    if (!legacy) throw new Error('出库审批待审批 Base 注册状态无效');
    if (!decision && !approvalCardDeliveryEvidence(cards)) {
      return createPendingRegistration();
    }
    return {
      status: 'ready',
      attemptCount: 1,
      lastAttemptAt: registeredAt,
      confirmedAt: registeredAt,
    };
  }
  if (value.status !== 'pending_base' && value.status !== 'ready') {
    throw new Error('出库审批待审批 Base 注册状态无效');
  }
  if (
    !Number.isSafeInteger(value.attemptCount) ||
    Number(value.attemptCount) < 0
  ) {
    throw new Error('出库审批待审批 Base 尝试次数无效');
  }
  const attemptCount = Number(value.attemptCount);
  const lastAttemptAt = validTimestamp(value.lastAttemptAt)
    ? value.lastAttemptAt
    : undefined;
  const confirmedAt = validTimestamp(value.confirmedAt)
    ? value.confirmedAt
    : undefined;
  const lastError = clean(value.lastError);
  if (value.lastAttemptAt !== undefined && !lastAttemptAt) {
    throw new Error('出库审批待审批 Base 最近尝试时间无效');
  }
  if (value.confirmedAt !== undefined && !confirmedAt) {
    throw new Error('出库审批待审批 Base 确认时间无效');
  }
  if (lastError && optionalText(lastError, 2_000) !== lastError) {
    throw new Error('出库审批待审批 Base 错误信息无效');
  }
  if (value.status === 'ready') {
    if (attemptCount < 1 || !lastAttemptAt || !confirmedAt || lastError) {
      throw new Error('已确认待审批 Base 注册状态不完整');
    }
    return {
      status: 'ready',
      attemptCount,
      lastAttemptAt,
      confirmedAt,
    };
  }
  if (confirmedAt) {
    throw new Error('未确认待审批 Base 注册状态不能包含确认时间');
  }
  if (
    (attemptCount === 0 && (lastAttemptAt || lastError)) ||
    (attemptCount > 0 && (!lastAttemptAt || !lastError))
  ) {
    throw new Error('待重试待审批 Base 注册状态不完整');
  }
  return {
    status: 'pending_base',
    attemptCount,
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    ...(lastError ? { lastError } : {}),
  };
}

function approvalCardDeliveryEvidence(cards: PersistedApprovalCard[]): boolean {
  return cards.some(
    (card) =>
      card.attemptCount > 0 ||
      card.status === 'running' ||
      card.status === 'completed' ||
      card.status === 'error' ||
      Boolean(card.lastAttemptAt) ||
      Boolean(card.messageId),
  );
}

function normalizeApprovalCard(
  value: unknown,
  snapshot: InventoryOutboundApprovalSnapshot,
): PersistedApprovalCard {
  const work = normalizeWorkState(value, 'approvalCardDelivery');
  const record = value as Record<string, unknown>;
  const recipientOpenId = requiredText(
    record.recipientOpenId,
    '审批卡接收人',
    256,
  );
  const approver = snapshot.approvers.find(
    (candidate) => candidate.openId === recipientOpenId,
  );
  if (!approver) throw new Error('审批卡接收人不在审批快照中');
  const deliveryUuid = requiredText(record.deliveryUuid, '审批卡投递标识', 64);
  const expectedUuid = stableUuid(
    `inventory-outbound-approval-card:${snapshot.recordId}:${snapshot.version}:${recipientOpenId}`,
  );
  if (!UUID_PATTERN.test(deliveryUuid) || deliveryUuid !== expectedUuid) {
    throw new Error('审批卡稳定投递标识无效');
  }
  const messageId = optionalText(record.messageId, 300);
  if (messageId && !MESSAGE_ID_PATTERN.test(messageId)) {
    throw new Error('审批卡消息编号无效');
  }
  if (work.status === 'completed' && !messageId) {
    throw new Error('已完成审批卡投递缺少消息编号');
  }
  return {
    ...work,
    kind: 'approvalCardDelivery',
    recipientOpenId,
    recipientName: approver.name,
    deliveryUuid,
    ...(messageId ? { messageId } : {}),
  };
}

function normalizeBaseSync(value: unknown): PersistedBaseSync {
  const normalizedValue =
    isRecord(value) &&
    value.status === 'pending' &&
    value.nextAttemptAt === '' &&
    value.completedAt === ''
      ? { ...value, nextAttemptAt: undefined, completedAt: undefined }
      : value;
  const work = normalizeWorkState(normalizedValue, 'baseSync');
  if (work.id !== 'base-sync') throw new Error('Base 同步步骤编号无效');
  return { ...work, kind: 'baseSync' };
}

function normalizeCardPatch(
  value: unknown,
  snapshot: InventoryOutboundApprovalSnapshot,
  cards: PersistedApprovalCard[],
): PersistedCardPatch {
  const work = normalizeWorkState(value, 'cardPatch');
  const record = value as Record<string, unknown>;
  const recipientOpenId = requiredText(
    record.recipientOpenId,
    '审批卡更新接收人',
    256,
  );
  const messageId = requireMessageId(record.messageId);
  const approver = snapshot.approvers.find(
    (candidate) => candidate.openId === recipientOpenId,
  );
  const originalCard = cards.find(
    (candidate) =>
      candidate.recipientOpenId === recipientOpenId &&
      candidate.status === 'completed' &&
      candidate.messageId === messageId,
  );
  if (!approver || !originalCard) {
    throw new Error('审批卡更新与原审批卡消息不一致');
  }
  return {
    ...work,
    kind: 'cardPatch',
    recipientOpenId,
    recipientName: approver.name,
    messageId,
  };
}

function normalizeResultNotification(
  value: unknown,
  snapshot: InventoryOutboundApprovalSnapshot,
  decision: InventoryOutboundApprovalDecision | undefined,
  allowedRecipients?:Map<string,InventoryOutboundApprovalApprover>,
): PersistedResultNotification {
  const work = normalizeWorkState(value, 'resultNotification');
  const record = value as Record<string, unknown>;
  const recipientOpenId = requiredText(
    record.recipientOpenId,
    '审批结果接收人',
    256,
  );
  const deliveryUuid = requiredText(
    record.deliveryUuid,
    '审批结果投递标识',
    64,
  );
  if (!UUID_PATTERN.test(deliveryUuid)) {
    throw new Error('审批结果稳定投递标识无效');
  }
  if (!decision) throw new Error('审批结果通知缺少决议');
  const recipients = allowedRecipients||resultRecipientsFor(snapshot);
  const recipient = recipients.get(recipientOpenId);
  const expectedUuid = stableUuid(
    `inventory-outbound-approval-result:${snapshot.recordId}:${snapshot.version}:${decision.action}:${recipientOpenId}`,
  );
  if (!recipient || deliveryUuid !== expectedUuid) {
    throw new Error('审批结果通知与接收人或稳定投递标识不一致');
  }
  const messageId = optionalText(record.messageId, 300);
  if (messageId && !MESSAGE_ID_PATTERN.test(messageId)) {
    throw new Error('审批结果消息编号无效');
  }
  if (work.status === 'completed' && !messageId) {
    throw new Error('已完成审批结果通知缺少消息编号');
  }
  return {
    ...work,
    kind: 'resultNotification',
    recipientOpenId,
    recipientName: recipient.name,
    deliveryUuid,
    ...(messageId ? { messageId } : {}),
  };
}

function normalizeWorkState(
  value: unknown,
  expectedKind: InventoryOutboundApprovalWorkKind,
): PersistedWork<InventoryOutboundApprovalWorkState> {
  if (!isRecord(value) || value.kind !== expectedKind) {
    throw new Error('出库审批后台步骤结构无效');
  }
  const statuses: InventoryOutboundApprovalWorkStatus[] = [
    'pending',
    'running',
    'completed',
    'error',
    'cancelled',
  ];
  if (
    !statuses.includes(value.status as InventoryOutboundApprovalWorkStatus) ||
    !Number.isSafeInteger(value.attemptCount) ||
    Number(value.attemptCount) < 0
  ) {
    throw new Error('出库审批后台步骤状态无效');
  }
  const status = value.status as InventoryOutboundApprovalWorkStatus;
  const owner = normalizeWorkOwner(value.owner);
  if (status !== 'running' && value.owner !== undefined) {
    throw new Error('非运行审批步骤不能持有租约');
  }
  if (
    value.lastAttemptAt !== undefined &&
    !validTimestamp(value.lastAttemptAt)
  ) {
    throw new Error('审批步骤最近尝试时间无效');
  }
  if (
    value.nextAttemptAt !== undefined &&
    !validTimestamp(value.nextAttemptAt)
  ) {
    throw new Error('审批步骤下次重试时间无效');
  }
  if (value.completedAt !== undefined && !validTimestamp(value.completedAt)) {
    throw new Error('审批步骤完成时间无效');
  }
  if (
    (status === 'completed' || status === 'cancelled') &&
    !validTimestamp(value.completedAt)
  ) {
    throw new Error('审批步骤终态缺少完成时间');
  }
  if (status === 'error' && !clean(value.lastError)) {
    throw new Error('审批步骤错误态缺少错误信息');
  }
  return {
    id: requiredText(value.id, '审批步骤编号', 512),
    kind: expectedKind,
    status,
    attemptCount: Number(value.attemptCount),
    ...(validTimestamp(value.lastAttemptAt)
      ? { lastAttemptAt: value.lastAttemptAt }
      : {}),
    ...(validTimestamp(value.nextAttemptAt)
      ? { nextAttemptAt: value.nextAttemptAt }
      : {}),
    ...(clean(value.lastError)
      ? { lastError: optionalText(value.lastError, 2_000) }
      : {}),
    ...(validTimestamp(value.completedAt)
      ? { completedAt: value.completedAt }
      : {}),
    ...(owner ? { owner } : {}),
  };
}

function normalizeDecision(
  value: unknown,
  snapshot: InventoryOutboundApprovalSnapshot,
  cards: PersistedApprovalCard[],
): InventoryOutboundApprovalDecision {
  if (!isRecord(value)) throw new Error('出库审批决议无效');
  const input = normalizeDecisionInput({
    recordId: snapshot.recordId,
    version: snapshot.version,
    actorOpenId: String(value.actorOpenId || ''),
    messageId: String(value.messageId || ''),
    eventId: String(value.eventId || ''),
    action: value.action as 'approve' | 'reject',
    reason: String(value.reason || ''),
  });
  const approver = snapshot.approvers.find(
    (candidate) => candidate.openId === input.actorOpenId,
  );
  const card = cards.find(
    (candidate) =>
      candidate.recipientOpenId === input.actorOpenId &&
      candidate.messageId === input.messageId &&
      candidate.status === 'completed',
  );
  if (!approver || !card || !validTimestamp(value.decidedAt)) {
    throw new Error('出库审批决议与快照或消息不一致');
  }
  return {
    action: input.action,
    actorOpenId: input.actorOpenId,
    actorName: approver.name,
    messageId: input.messageId,
    eventId: input.eventId,
    decidedAt: value.decidedAt,
    reason: input.reason,
  };
}

function createApprovalCardDeliveries(
  snapshot: InventoryOutboundApprovalSnapshot,
): PersistedApprovalCard[] {
  return snapshot.approvers.map((approver) => ({
    ...pendingWork(`approval-card:${approver.openId}`, 'approvalCardDelivery'),
    kind: 'approvalCardDelivery',
    recipientOpenId: approver.openId,
    recipientName: approver.name,
    deliveryUuid: stableUuid(
      `inventory-outbound-approval-card:${snapshot.recordId}:${snapshot.version}:${approver.openId}`,
    ),
  }));
}

function createPendingBaseSync(): PersistedBaseSync {
  return { ...pendingWork('base-sync', 'baseSync'), kind: 'baseSync' };
}

function createCardPatch(card: PersistedApprovalCard): PersistedCardPatch {
  if (!card.messageId) throw new Error('审批卡更新缺少消息编号');
  return {
    ...pendingWork(`card-patch:${card.recipientOpenId}`, 'cardPatch'),
    kind: 'cardPatch',
    recipientOpenId: card.recipientOpenId,
    recipientName: card.recipientName,
    messageId: card.messageId,
  };
}

function createResultNotification(
  entry: PersistedEntry,
  recipient: InventoryOutboundApprovalApprover,
): PersistedResultNotification {
  if (!entry.decision) throw new Error('审批结果通知缺少决议');
  return {
    ...pendingWork(
      `result-notification:${recipient.openId}`,
      'resultNotification',
    ),
    kind: 'resultNotification',
    recipientOpenId: recipient.openId,
    recipientName: recipient.name,
    deliveryUuid: stableUuid(
      `inventory-outbound-approval-result:${entry.snapshot.recordId}:${entry.snapshot.version}:${entry.decision.action}:${recipient.openId}`,
    ),
  };
}

function pendingWork(
  id: string,
  kind: InventoryOutboundApprovalWorkKind,
): InventoryOutboundApprovalWorkState {
  return { id, kind, status: 'pending', attemptCount: 0 };
}

function createPendingRegistration(): InventoryOutboundApprovalRegistration {
  return { status: 'pending_base', attemptCount: 0 };
}

function normalizeRecoveredDeliveries(
  values: InventoryOutboundApprovalRecoveredDelivery[],
  snapshot: InventoryOutboundApprovalSnapshot,
): InventoryOutboundApprovalRecoveredDelivery[] {
  if (!Array.isArray(values)) {
    throw new BadRequestException('出库审批恢复投递台账无效');
  }
  const approvers = new Map(
    snapshot.approvers.map((approver) => [approver.openId, approver.name]),
  );
  const recipients = new Set<string>();
  const messageIds = new Set<string>();
  return values
    .map((value) => {
      if (!isRecord(value)) {
        throw new BadRequestException('出库审批恢复投递记录无效');
      }
      const recipientOpenId = requiredText(
        value.recipientOpenId,
        '审批卡接收人',
        256,
      );
      const recipientName = optionalText(value.recipientName, 128);
      const deliveryUuid = requiredText(
        value.deliveryUuid,
        '审批卡投递标识',
        64,
      );
      const messageId = requireMessageId(value.messageId);
      const expectedUuid = stableUuid(
        `inventory-outbound-approval-card:${snapshot.recordId}:${snapshot.version}:${recipientOpenId}`,
      );
      if (
        approvers.get(recipientOpenId) !== recipientName ||
        deliveryUuid !== expectedUuid ||
        !UUID_PATTERN.test(deliveryUuid)
      ) {
        throw new ConflictException('恢复的审批卡投递记录与审批快照不一致');
      }
      if (recipients.has(recipientOpenId) || messageIds.has(messageId)) {
        throw new ConflictException('恢复的审批卡投递台账存在重复记录');
      }
      recipients.add(recipientOpenId);
      messageIds.add(messageId);
      return {
        recipientOpenId,
        recipientName,
        deliveryUuid,
        messageId,
      };
    })
    .sort((left, right) =>
      left.recipientOpenId.localeCompare(right.recipientOpenId),
    );
}

function normalizeRecoveredResultDeliveries(
  values: InventoryOutboundApprovalRecoveredResultDelivery[],
  snapshot: InventoryOutboundApprovalSnapshot,
  decision: InventoryOutboundApprovalDecision,
  managerNotificationHandovers: InventoryManagerNotificationHandover[] = [],
): InventoryOutboundApprovalRecoveredResultDelivery[] {
  if (!Array.isArray(values)) {
    throw new BadRequestException('出库审批结果通知恢复台账无效');
  }
  const allowedRecipients = new Map(
    [...resultRecipientsFor(snapshot).values()].map(
      (recipient) => [recipient.openId, recipient.name] as const,
    ),
  );
  for (const { target } of managerNotificationHandovers) {
    if (!allowedRecipients.has(target.openId)) allowedRecipients.set(target.openId, target.name);
  }
  const recipients = new Set<string>();
  const messageIds = new Set<string>();
  return values
    .map((value) => {
      if (!isRecord(value)) {
        throw new BadRequestException('出库审批结果通知恢复记录无效');
      }
      const recipientOpenId = requiredText(
        value.recipientOpenId,
        '审批结果通知接收人',
        256,
      );
      const recipientName = optionalText(value.recipientName, 128);
      const deliveryUuid = requiredText(
        value.deliveryUuid,
        '审批结果通知投递标识',
        64,
      );
      const messageId = requireMessageId(value.messageId);
      const expectedUuid = stableUuid(
        `inventory-outbound-approval-result:${snapshot.recordId}:${snapshot.version}:${decision.action}:${recipientOpenId}`,
      );
      if (
        allowedRecipients.get(recipientOpenId) !== recipientName ||
        deliveryUuid !== expectedUuid ||
        !UUID_PATTERN.test(deliveryUuid)
      ) {
        throw new ConflictException(
          '恢复的审批结果通知投递记录与审批快照或决议不一致',
        );
      }
      if (recipients.has(recipientOpenId) || messageIds.has(messageId)) {
        throw new ConflictException('恢复的审批结果通知投递台账存在重复记录');
      }
      recipients.add(recipientOpenId);
      messageIds.add(messageId);
      return {
        recipientOpenId,
        recipientName,
        deliveryUuid,
        messageId,
      };
    })
    .sort((left, right) =>
      left.recipientOpenId.localeCompare(right.recipientOpenId),
    );
}

function assertRecoveredMessageIdsAvailable(
  entries: PersistedEntry[],
  recoveringKey: string,
  deliveries: InventoryOutboundApprovalRecoveredDelivery[],
  resultDeliveries: InventoryOutboundApprovalRecoveredResultDelivery[],
): void {
  const recovering = entries.find((candidate) => entryKeyFor(candidate) === recoveringKey);
  const recovered = new Map<
    string,
    {
      kind: 'approvalCardDelivery' | 'resultNotification';
      recipientOpenId: string;
    }
  >();
  for (const delivery of deliveries) {
    recovered.set(delivery.messageId, {
      kind: 'approvalCardDelivery',
      recipientOpenId: delivery.recipientOpenId,
    });
  }
  for (const delivery of resultDeliveries) {
    const previous = recovered.get(delivery.messageId);
    if (previous && (!recovering || !inventoryNotificationBatchId(recovering.snapshot.outboundNumber, 'outbound') || previous.recipientOpenId !== delivery.recipientOpenId)) {
      throw new ConflictException(
        '恢复的飞书消息编号同时出现在审批卡和结果通知台账中',
      );
    }
    recovered.set(delivery.messageId, {
      kind: 'resultNotification',
      recipientOpenId: delivery.recipientOpenId,
    });
  }
  for (const entry of entries) {
    for (const work of [...entry.approvalCards, ...entry.resultNotifications]) {
      if (!work.messageId || !recovered.has(work.messageId)) continue;
      const binding = recovered.get(work.messageId)!;
      const sameBinding =
        entryKeyFor(entry) === recoveringKey &&
        work.kind === binding.kind &&
        work.recipientOpenId === binding.recipientOpenId;
      const sameBatchResult = recovering &&
        (work.kind === 'approvalCardDelivery' || work.kind === 'resultNotification') &&
        work.recipientOpenId === binding.recipientOpenId &&
        sameNotificationBatch(entry, recovering);
      if (!sameBinding && !sameBatchResult) {
        throw new ConflictException('恢复的飞书消息编号已被其他审批任务占用');
      }
    }
  }
}

function assertRecoveredDecisionAvailable(
  entries: PersistedEntry[],
  recoveringKey: string,
  decision: InventoryOutboundApprovalDecision,
): void {
  const duplicate = entries.find(
    (entry) =>
      entryKeyFor(entry) !== recoveringKey &&
      entry.decision?.eventId === decision.eventId,
  );
  if (duplicate) {
    throw new ConflictException('恢复的审批事件标识已被其他审批任务占用');
  }
}

function markRegistrationRecoveredReady(
  registration: InventoryOutboundApprovalRegistration,
  nowIso: string,
): void {
  registration.status = 'ready';
  registration.attemptCount = Math.max(1, registration.attemptCount);
  registration.lastAttemptAt = registration.lastAttemptAt || nowIso;
  registration.confirmedAt = registration.confirmedAt || nowIso;
  delete registration.lastError;
}

function markRecoveredCardCompleted(
  card: PersistedApprovalCard,
  messageId: string,
  nowIso: string,
): void {
  delete card.owner;
  delete card.nextAttemptAt;
  delete card.lastError;
  card.status = 'completed';
  card.attemptCount = Math.max(1, card.attemptCount);
  card.lastAttemptAt = card.lastAttemptAt || nowIso;
  card.completedAt = card.completedAt || nowIso;
  card.messageId = messageId;
}

function markRecoveredCardCancelled(
  card: PersistedApprovalCard,
  nowIso: string,
): void {
  delete card.owner;
  delete card.nextAttemptAt;
  card.status = 'cancelled';
  card.completedAt = nowIso;
  card.lastError = '多维表已存在审批决议，取消未投递的可操作审批卡';
}

function markRecoveredBaseSyncCompleted(
  work: PersistedBaseSync,
  nowIso: string,
): void {
  delete work.owner;
  delete work.nextAttemptAt;
  delete work.lastError;
  work.status = 'completed';
  work.attemptCount = Math.max(1, work.attemptCount);
  work.lastAttemptAt = work.lastAttemptAt || nowIso;
  work.completedAt = work.completedAt || nowIso;
}

function markRecoveredResultNotificationCompleted(
  notification: PersistedResultNotification,
  messageId: string,
  nowIso: string,
): void {
  delete notification.owner;
  delete notification.nextAttemptAt;
  delete notification.lastError;
  notification.status = 'completed';
  notification.attemptCount = Math.max(1, notification.attemptCount);
  notification.lastAttemptAt = notification.lastAttemptAt || nowIso;
  notification.completedAt = notification.completedAt || nowIso;
  notification.messageId = messageId;
}

function ensureDecisionWork(entry: PersistedEntry, nowIso: string): boolean {
  if (!entry.decision) return false;
  let changed = false;
  if (!entry.baseSync) {
    entry.baseSync = createPendingBaseSync();
    changed = true;
  }
  const patchesByRecipient = new Map(
    entry.cardPatches.map((patch) => [patch.recipientOpenId, patch]),
  );
  const notificationsByRecipient = new Map(
    entry.resultNotifications.map((notification) => [
      notification.recipientOpenId,
      notification,
    ]),
  );
  for (const card of entry.approvalCards) {
    const notification = notificationsByRecipient.get(card.recipientOpenId);
    if (approvalCardCanStillDeliver(card)) {
      if (
        notification &&
        cancelRetryableWork(
          notification,
          nowIso,
          '原审批卡投递结果仍可恢复，取消冗余结果通知',
        )
      ) {
        changed = true;
      }
      continue;
    }
    if (card.status !== 'completed' || !card.messageId) continue;
    const existing = patchesByRecipient.get(card.recipientOpenId);
    if (
      notification?.status === 'completed' ||
      notification?.status === 'running'
    ) {
      if (
        existing &&
        cancelRetryableWork(
          existing,
          nowIso,
          '审批结果通知已发送或发送结果未知，取消冗余原卡更新',
        )
      ) {
        changed = true;
      }
      continue;
    }
    if (
      notification &&
      cancelRetryableWork(
        notification,
        nowIso,
        '原审批卡可更新，取消冗余结果通知',
      )
    ) {
      changed = true;
    }
    if (!existing) {
      const patch = createCardPatch(card);
      entry.cardPatches.push(patch);
      patchesByRecipient.set(card.recipientOpenId, patch);
      changed = true;
    } else if (existing.messageId !== card.messageId) {
      throw new Error('审批卡更新消息编号与原卡不一致');
    } else if (existing.status === 'cancelled') {
      existing.status = 'pending';
      delete existing.completedAt;
      delete existing.lastError;
      changed = true;
    }
  }

  const recipients = resultRecipientsFor({...entry.snapshot,managerRecipients:inventoryManagerNotificationRecipients(entry)});
  for (const recipient of recipients.values()) {
    const card = entry.approvalCards.find(
      (candidate) => candidate.recipientOpenId === recipient.openId,
    );
    if (card?.status === 'completed' && card.messageId) {
      continue;
    }
    if (card && approvalCardCanStillDeliver(card)) continue;
    if (!notificationsByRecipient.has(recipient.openId)) {
      const notification = createResultNotification(entry, recipient);
      entry.resultNotifications.push(notification);
      notificationsByRecipient.set(recipient.openId, notification);
      changed = true;
    } else {
      const existing=notificationsByRecipient.get(recipient.openId)!;
      if(existing.status==='cancelled'&&existing.attemptCount===0&&!existing.messageId){existing.status='pending';delete existing.completedAt;delete existing.lastError;changed=true;}
    }
  }
  entry.cardPatches.sort((left, right) =>
    left.recipientOpenId.localeCompare(right.recipientOpenId),
  );
  entry.resultNotifications.sort((left, right) =>
    left.recipientOpenId.localeCompare(right.recipientOpenId),
  );
  return changed;
}

function resultRecipientsFor(
  snapshot: InventoryOutboundApprovalSnapshot,
): Map<string, InventoryOutboundApprovalApprover> {
  const recipients = new Map<string, InventoryOutboundApprovalApprover>();
  const add = (recipient: InventoryOutboundApprovalApprover) => {
    const previous = recipients.get(recipient.openId);
    recipients.set(recipient.openId, {
      openId: recipient.openId,
      name: previous?.name || recipient.name,
    });
  };
  add({
    openId: snapshot.applicantOpenId,
    name: snapshot.applicantName,
  });
  snapshot.approvers.forEach(add);
  (snapshot.managerRecipients || []).forEach(add);
  return recipients;
}

function approvalCardCanStillDeliver(card: PersistedApprovalCard): boolean {
  return (
    card.status === 'running' ||
    (card.status === 'error' && card.attemptCount > 0)
  );
}

function cancelRetryableWork(
  work: AnyPersistedWork,
  nowIso: string,
  reason: string,
): boolean {
  if (work.status !== 'pending' && work.status !== 'error') return false;
  delete work.owner;
  delete work.nextAttemptAt;
  work.status = 'cancelled';
  work.completedAt = nowIso;
  work.lastError = reason;
  return true;
}

function cancelWork(
  work: AnyPersistedWork,
  nowIso: string,
  reason: string,
): void {
  delete work.owner;
  delete work.nextAttemptAt;
  work.status = 'cancelled';
  work.completedAt = nowIso;
  work.lastError = reason;
}

function resetWorkPending(work: AnyPersistedWork): void {
  delete work.owner;
  delete work.nextAttemptAt;
  delete work.lastError;
  delete work.completedAt;
  work.status = 'pending';
}

function supersededByVersion(entry: PersistedEntry): number | null {
  if (entry.personnelHandover) return entry.personnelHandover.targetVersion;
  const message = entry.baseSync?.lastError || '';
  if (!message.startsWith(SUPERSEDED_WORK_PREFIX)) return null;
  const version = Number(message.slice(SUPERSEDED_WORK_PREFIX.length));
  return Number.isSafeInteger(version) && version > entry.snapshot.version
    ? version
    : null;
}

function requireCompleteSupersessionChain(
  entries: PersistedEntry[],
  recordId: string,
): PersistedEntry[] {
  const chain = entries
    .filter((entry) => entry.snapshot.recordId === recordId)
    .sort((left, right) => left.snapshot.version - right.snapshot.version);
  if (chain.length === 0 || chain[0].snapshot.version !== 1) {
    throw new ConflictException('出库审批版本链断裂');
  }
  for (let index = 0; index < chain.length; index += 1) {
    const current = chain[index];
    if (current.snapshot.version !== index + 1) {
      throw new ConflictException('出库审批版本链断裂');
    }
    const next = chain[index + 1];
    if (!next) {
      if (supersededByVersion(current) !== null) {
        throw new ConflictException('出库审批版本链尾缺少替代版本');
      }
      continue;
    }
    if (
      (current.decision?.action !== 'approve' && !current.personnelHandover) ||
      supersededByVersion(current) !== next.snapshot.version
    ) {
      throw new ConflictException('出库审批版本链包含未授权分支');
    }
  }
  return chain;
}

function refreshEntryCompletion(
  entry: PersistedEntry,
  nowIso: string,
): boolean {
  const wasCompleted = Boolean(entry.completedAt);
  const complete =
    Boolean(entry.decision) &&
    entry.baseSync?.status === 'completed' &&
    entry.approvalCards.every((work) => isWorkTerminal(work.status)) &&
    entry.cardPatches.every((work) => isWorkTerminal(work.status)) &&
    entry.resultNotifications.every((work) => isWorkTerminal(work.status));
  if (complete && !entry.completedAt) entry.completedAt = nowIso;
  if (!complete && entry.completedAt) delete entry.completedAt;
  return wasCompleted !== Boolean(entry.completedAt);
}

function requireEntry(entries: PersistedEntry[], key: string): PersistedEntry {
  const entry = entries.find((candidate) => entryKeyFor(candidate) === key);
  if (!entry) throw new NotFoundException('出库审批记录不存在');
  return entry;
}

function requireWork(
  entry: PersistedEntry,
  ref: InventoryOutboundApprovalWorkRef,
): AnyPersistedWork {
  let work: AnyPersistedWork | undefined;
  switch (ref.kind) {
    case 'approvalCardDelivery':
      work = entry.approvalCards.find(
        (candidate) => candidate.recipientOpenId === ref.recipientOpenId,
      );
      break;
    case 'baseSync':
      work = entry.baseSync;
      break;
    case 'cardPatch':
      work = entry.cardPatches.find(
        (candidate) => candidate.recipientOpenId === ref.recipientOpenId,
      );
      break;
    case 'resultNotification':
      work = entry.resultNotifications.find(
        (candidate) => candidate.recipientOpenId === ref.recipientOpenId,
      );
      break;
  }
  if (!work) throw new NotFoundException('审批后台步骤不存在');
  return work;
}

function allWorks(entry: PersistedEntry): AnyPersistedWork[] {
  return [
    ...entry.approvalCards,
    ...(entry.baseSync ? [entry.baseSync] : []),
    ...entry.cardPatches,
    ...entry.resultNotifications,
  ];
}

function decisionMatchesInput(
  decision: InventoryOutboundApprovalDecision,
  input: InventoryOutboundApprovalDecisionInput & { reason: string },
): boolean {
  return (
    decision.eventId === input.eventId &&
    decision.actorOpenId === input.actorOpenId &&
    decision.messageId === input.messageId &&
    decision.action === input.action &&
    decision.reason === input.reason
  );
}

function assertMessageIdAvailable(
  entries: PersistedEntry[],
  current: AnyPersistedWork,
  messageId: string,
): void {
  const owner = entries.find((entry) => [...entry.approvalCards, ...entry.resultNotifications].some((work) => work === current));
  for (const entry of entries) {
    for (const work of [...entry.approvalCards, ...entry.resultNotifications]) {
      if (work !== current && work.messageId === messageId) {
        if (owner && (current.kind === 'approvalCardDelivery' || current.kind === 'resultNotification') &&
          sameBatchMessageBinding(owner, current, entry, work)) continue;
        throw new ConflictException('飞书消息编号已被其他审批投递占用');
      }
    }
  }
}

function sameBatchMessageBinding(
  leftEntry: PersistedEntry,
  leftWork: PersistedApprovalCard | PersistedResultNotification,
  rightEntry: PersistedEntry,
  rightWork: PersistedApprovalCard | PersistedResultNotification,
): boolean {
  return leftWork.recipientOpenId === rightWork.recipientOpenId &&
    sameNotificationBatch(leftEntry, rightEntry);
}

function sameNotificationBatch(left: PersistedEntry, right: PersistedEntry): boolean {
  const leftId = inventoryNotificationBatchId(left.snapshot.outboundNumber, 'outbound');
  return Boolean(leftId && leftId === inventoryNotificationBatchId(right.snapshot.outboundNumber, 'outbound'));
}

function assertApprovalCardSnapshot(
  cards: PersistedApprovalCard[],
  snapshot: InventoryOutboundApprovalSnapshot,
): void {
  const cardRecipients = cards.map((card) => card.recipientOpenId).sort();
  const approverRecipients = snapshot.approvers
    .map((approver) => approver.openId)
    .sort();
  if (
    cardRecipients.length !== approverRecipients.length ||
    cardRecipients.some(
      (recipient, index) => recipient !== approverRecipients[index],
    )
  ) {
    throw new Error('审批卡接收人与审批人快照不一致');
  }
}

function assertUniqueWorkRecipients(
  works: Array<{ recipientOpenId: string }>,
  label: string,
): void {
  const recipients = new Set<string>();
  for (const work of works) {
    if (recipients.has(work.recipientOpenId)) {
      throw new Error(`${label}存在重复接收人`);
    }
    recipients.add(work.recipientOpenId);
  }
}

function serializeLedger(entries: PersistedEntry[], updatedAt: string): string {
  const ledger: PersistedLedger = {
    version: LEDGER_VERSION,
    updatedAt,
    entries: entries.map(clonePersistedEntry),
  };
  return `${JSON.stringify(ledger, null, 2)}\n`;
}

function entryIsEvictable(entry: PersistedEntry): boolean {
  return (
    Boolean(entry.completedAt) &&
    validTimestamp(entry.completedAt) &&
    Boolean(entry.decision) &&
    entry.baseSync?.status === 'completed' &&
    entry.approvalCards.every((work) => isWorkTerminal(work.status)) &&
    entry.cardPatches.every((work) => isWorkTerminal(work.status)) &&
    entry.resultNotifications.every((work) => isWorkTerminal(work.status))
  );
}

function isWorkTerminal(status: InventoryOutboundApprovalWorkStatus): boolean {
  return status === 'completed' || status === 'cancelled';
}

function evictForCapacity(
  entries: PersistedEntry[],
  maximumEntries: number,
  protectedKeys: ReadonlySet<string>,
): boolean {
  if (entries.length <= maximumEntries) return false;
  const evictable = entries
    .filter(
      (entry) =>
        !protectedKeys.has(entryKeyFor(entry)) && entryIsEvictable(entry),
    )
    .sort((left, right) => terminalTimestamp(left) - terminalTimestamp(right));
  let changed = false;
  while (entries.length > maximumEntries && evictable.length > 0) {
    const candidate = evictable.shift()!;
    const index = entries.findIndex(
      (entry) => entryKeyFor(entry) === entryKeyFor(candidate),
    );
    if (index < 0) continue;
    entries.splice(index, 1);
    changed = true;
  }
  return changed;
}

function oldestEvictableEntry(
  entries: PersistedEntry[],
  protectedKey?: string,
): PersistedEntry | undefined {
  return entries
    .filter(
      (entry) => entryKeyFor(entry) !== protectedKey && entryIsEvictable(entry),
    )
    .sort(
      (left, right) => terminalTimestamp(left) - terminalTimestamp(right),
    )[0];
}

function terminalTimestamp(entry: PersistedEntry): number {
  const completedAt = Date.parse(entry.completedAt || '');
  return Number.isFinite(completedAt) ? completedAt : Number.MAX_SAFE_INTEGER;
}

function fingerprintSnapshot(
  snapshot: InventoryOutboundApprovalSnapshot,
): string {
  return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function stableUuid(seed: string): string {
  const bytes = createHash('sha256').update(seed).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function entryKey(recordId: string, version: number): string {
  return `${recordId}:${version}`;
}

function normalizeEntryKey(
  recordIdValue: string,
  versionValue: number,
): string {
  return entryKey(
    requiredText(recordIdValue, '出库记录编号', 256),
    positiveVersion(versionValue),
  );
}

function entryKeyFor(entry: PersistedEntry): string {
  return entryKey(entry.snapshot.recordId, entry.snapshot.version);
}

function workLocalKey(
  key: string,
  work: InventoryOutboundApprovalWorkState,
): string {
  return `${key}:${work.kind}:${work.id}`;
}

function clonePublicEntry(
  entry: PersistedEntry,
): InventoryOutboundApprovalEntry {
  const cloned = clonePersistedEntry(entry);
  for (const work of allWorks(cloned)) delete work.owner;
  return cloned as InventoryOutboundApprovalEntry;
}

function clonePublicWork(
  work: AnyPersistedWork,
): InventoryOutboundApprovalWork {
  const cloned = clone(work);
  delete cloned.owner;
  return cloned as InventoryOutboundApprovalWork;
}

function clonePersistedEntry(entry: PersistedEntry): PersistedEntry {
  return clone(entry);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeOwner(value: unknown): Owner | null {
  if (
    !isRecord(value) ||
    value.version !== OWNER_VERSION ||
    !clean(value.token) ||
    typeof value.pid !== 'number' ||
    !Number.isInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.processStartedAtMs !== 'number' ||
    !Number.isFinite(value.processStartedAtMs) ||
    !validTimestamp(value.acquiredAt)
  ) {
    return null;
  }
  return {
    version: OWNER_VERSION,
    token: clean(value.token),
    pid: value.pid,
    processStartedAtMs: value.processStartedAtMs,
    acquiredAt: value.acquiredAt,
    ...(clean(value.instanceToken) && validTimestamp(value.leaseExpiresAt)
      ? {
          instanceToken: clean(value.instanceToken),
          leaseExpiresAt: value.leaseExpiresAt,
        }
      : {}),
  };
}

function normalizeWorkOwner(value: unknown): Owner | null {
  const owner = normalizeOwner(value);
  return owner?.instanceToken && owner.leaseExpiresAt ? owner : null;
}

function parseOwner(value: string): Owner | null {
  try {
    return normalizeOwner(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function workOwnerIsActive(owner: Owner, nowMs: number): boolean {
  return Boolean(
    owner.instanceToken &&
    owner.leaseExpiresAt &&
    Date.parse(owner.leaseExpiresAt) > nowMs &&
    ownerMayBeAlive(owner),
  );
}

function ownerMayBeAlive(owner: Owner): boolean {
  if (owner.pid === process.pid) {
    return Math.abs(owner.processStartedAtMs - PROCESS_STARTED_AT_MS) < 5_000;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return !isNoSuchProcessError(error) && errorCode(error) !== 'EINVAL';
  }
}

function inspectReclaimablePath(
  path: string,
  staleAfterMs: number,
): 'missing' | 'active' | 'reclaimable' {
  try {
    const modifiedAt = statSync(path).mtimeMs;
    const owner = parseOwner(readFileSync(path, 'utf8'));
    if (owner) return ownerMayBeAlive(owner) ? 'active' : 'reclaimable';
    return Date.now() - modifiedAt < staleAfterMs ? 'active' : 'reclaimable';
  } catch (error) {
    if (isFileMissingError(error)) return 'missing';
    throw error;
  }
}

function cleanupTemporaryFile(
  temporaryPath: string,
  descriptor: number | undefined,
): unknown {
  let cleanupError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupError = error;
    }
  }
  return cleanupError ?? removeIfExists(temporaryPath);
}

function cleanupOwnedLockFile(lockPath: string, descriptor: number): unknown {
  let cleanupError: unknown;
  try {
    closeSync(descriptor);
  } catch (error) {
    cleanupError = error;
  }
  return cleanupError ?? removeIfExists(lockPath);
}

function removeIfExists(path: string): unknown {
  try {
    if (existsSync(path)) unlinkSync(path);
    return undefined;
  } catch (error) {
    return error;
  }
}

function attachCleanupError(primary: Error, cleanupError: unknown): void {
  if (cleanupError === undefined) return;
  Object.defineProperty(primary, 'cleanupError', {
    configurable: true,
    enumerable: false,
    value: cleanupError,
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, Math.max(1, milliseconds));
  });
}

function isFileExistsError(error: unknown): boolean {
  return errorCode(error) === 'EEXIST';
}

function isFileMissingError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isTransientLockReleaseError(error: unknown): boolean {
  return isTransientLedgerPersistenceError(error);
}

function isTransientLedgerPersistenceError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'EBUSY' || code === 'EACCES' || code === 'EPERM';
}

function isNoSuchProcessError(error: unknown): boolean {
  return errorCode(error) === 'ESRCH';
}

function errorCode(error: unknown): string {
  return isRecord(error) ? clean(error.code) : '';
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireMessageId(value: unknown): string {
  const messageId = requiredText(value, '飞书消息编号', 300);
  if (!MESSAGE_ID_PATTERN.test(messageId)) {
    throw new BadRequestException('飞书消息编号无效');
  }
  return messageId;
}

function requiredText(
  value: unknown,
  label: string,
  maxLength: number,
): string {
  const text = clean(value);
  if (
    !text ||
    text.length > maxLength ||
    CONTROL_CHARACTER_PATTERN.test(text)
  ) {
    throw new BadRequestException(`${label}无效`);
  }
  return text;
}

function optionalText(value: unknown, maxLength: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new BadRequestException('文本字段无效');
  const text = value.trim();
  if (text.length > maxLength || CONTROL_CHARACTER_PATTERN.test(text)) {
    throw new BadRequestException('文本字段无效');
  }
  return text;
}

function normalizeRejectionReason(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw new BadRequestException('驳回原因无效');
  }
  const normalized = value.normalize('NFC').replace(/\r\n?/gu, '\n');
  if (REJECTION_REASON_CONTROL_CHARACTER_PATTERN.test(normalized)) {
    throw new BadRequestException('驳回原因无效');
  }
  return normalized.trim();
}

function positiveVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new BadRequestException('审批版本无效');
  }
  return Number(value);
}

function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function invalidTimestamp(message: string): never {
  throw new Error(message);
}

function invalidArray(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}
