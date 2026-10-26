import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  ContractWorkflowLogItem,
  ContractWorkflowRunResult,
  ContractExpiryDispositionRequest,
  ContractExpiryDispositionTask,
} from '../../../shared/contract-management.interface';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { PersonnelRecoveryActor, PersonnelRecoveryAudit, PersonnelRecoveryRequest } from '../../../shared/personnel-task-recovery.interface';
import { assertRecoveryRequest, validRecoveryAudits } from '../../common/access/personnel-task-recovery.validation';
import { enqueueContractPaymentDigest, claimContractPaymentDigest, settleContractPaymentDigest, recoverContractPaymentDigests, validContractPaymentDigests, type ContractPaymentDigestInput, type ContractPaymentDigestJob, type ContractPaymentDigestDispatch, type ContractPaymentDigestResolver, type ContractPaymentDigestRenderer } from './contract-payment-digest';

export const CONTRACT_WORKFLOW_LEDGER_PATH = Symbol('contract-workflow-ledger.path');
export interface ContractDispositionTaskEntry {
  appId: string;
  task: ContractExpiryDispositionTask;
  request: ContractExpiryDispositionRequest;
  now: string;
  principal?: AccessPrincipal;
  fingerprint: string;
  mutationId: string;
  claimToken?: string;
  uncertain?: boolean;
  recoveries?: PersonnelRecoveryAudit[];
}
export interface ContractDispositionTaskInput {
  recordId: string;
  request: ContractExpiryDispositionRequest;
  now: string;
  principal?: AccessPrincipal;
}
export interface ContractRoleNotificationInput {
  key: string;
  kind: 'card' | 'text';
  content: Record<string, unknown> | string;
  fallbackRecipients: string[];
  specialty?: string;
}
interface ContractNotificationDelivery {
  uuid: string;
  status: 'sending' | 'uncertain' | 'delivered';
  firstAttemptAt: string;
  attempts: number;
  claimToken?: string;
  messageId?: string;
}
export interface ContractRoleNotification extends ContractRoleNotificationInput {
  appId: string;
  fingerprint: string;
  createdAt: string;
  completedAt?: string;
  completedRecipients?: string[];
  deliveries: Record<string, ContractNotificationDelivery>;
}
export interface ClaimedContractNotification {
  key: string;
  receiverOpenId: string;
  uuid: string;
  claimToken: string;
  kind: 'card' | 'text';
  content: Record<string, unknown> | string;
}

interface ContractWorkflowLedger {
  version: 2;
  baselineAt: string | null;
  processed: Record<string, { completedAt: string; messageIds: string[] }>;
  deliveries: Record<string, { completedAt: string; messageId: string }>;
  logs: ContractWorkflowLogItem[];
  dispositionTasks?: Record<string, ContractDispositionTaskEntry>;
  roleNotifications?: Record<string, ContractRoleNotification>;
  paymentDigests?: Record<string,ContractPaymentDigestJob>;
}

const EMPTY_LEDGER: ContractWorkflowLedger = {
  version: 2,
  baselineAt: null,
  processed: {},
  deliveries: {},
  logs: [],
};

@Injectable()
export class ContractWorkflowStore {
  private readonly filePath: string;
  private writeQueue = Promise.resolve();

  constructor(@Optional() @Inject(CONTRACT_WORKFLOW_LEDGER_PATH) filePath?: string) {
    this.filePath = filePath || join(process.cwd(), '.runtime', 'contract-workflow-ledger.json');
  }

  async acceptDispositionTask(value: ContractDispositionTaskInput, guard?: () => boolean): Promise<ContractDispositionTaskEntry> {
    const input = structuredClone(value);
    const appId=currentContractAppId();
    if (!input.recordId || input.recordId.length > 128 || !['renew','void'].includes(input.request?.action) || !Number.isFinite(Date.parse(input.now)) || JSON.stringify(input).length > 128_000) throw new BadRequestException('合同处置任务参数无效');
    if (input.request.idempotencyKey !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.request.idempotencyKey)) throw new BadRequestException('合同处置请求编号无效');
    const fingerprint = dispositionFingerprint(input,appId), mutationId = input.request.idempotencyKey || `legacy-${fingerprint}`;
    let result: ContractDispositionTaskEntry | undefined;
    await this.update(ledger => {
      const tasks = ledger.dispositionTasks || {}, prior = Object.values(tasks).find(entry => entry.mutationId === mutationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ConflictException('合同处置重复请求内容或人员不一致');
        result = structuredClone(prior); return ledger;
      }
      if (guard && guard() !== true) throw new ForbiddenException('当前合同处置权限已变化');
      if (Object.values(tasks).some(entry => entry.task.recordId === input.recordId && (['pending','running'].includes(entry.task.status) || entry.uncertain))) throw new ConflictException('该合同存在未完成或结果待核对的处置任务，请先核对原任务');
      if (Object.keys(tasks).length >= 2000) throw new ConflictException('合同处置任务台账已满，请先核对归档');
      const id = `contract-expiry-${randomUUID()}`;
      result = {appId,task:{id,recordId:input.recordId,action:input.request.action,status:'pending',message:'合同到期处置已提交后台同步',createdAt:new Date().toISOString()},request:input.request,now:input.now,...(input.principal?{principal:input.principal}:{}),fingerprint,mutationId};
      return {...ledger,dispositionTasks:{...tasks,[id]:structuredClone(result)}};
    });
    return result!;
  }

  async getDispositionTask(id: string): Promise<ContractDispositionTaskEntry | undefined> {
    const value = (await this.read()).dispositionTasks?.[id]; return value && structuredClone(value);
  }

  async listDispositionTasks(): Promise<ContractDispositionTaskEntry[]> {
    return Object.values((await this.read()).dispositionTasks || {}).map(entry => structuredClone(entry));
  }

  async confirmDispositionRecovery(input: PersonnelRecoveryRequest, expectedNativeVersion: string, actor: PersonnelRecoveryActor,
    evidence: { hash: string; recordIds: string[] }, authorize: () => void): Promise<void> {
    assertRecoveryRequest(input);
    const audit: PersonnelRecoveryAudit = { clientMutationId: input.clientMutationId, previousVersion: input.expectedVersion,
      actorId: actor.id, actorName: actor.name, authorizationVersion: actor.authorizationVersion, requestedAt: new Date().toISOString(), evidence };
    if (input.module !== 'contracts' || !validRecoveryAudits([audit])) throw new BadRequestException('合同恢复核对内容无效');
    await this.update(ledger => {
      authorize();
      const entry = ledger.dispositionTasks?.[input.taskId];
      if (!entry || entry.appId !== currentContractAppId()) throw new ConflictException('原合同任务或应用身份已变化');
      const prior = entry.recoveries?.find(row => row.clientMutationId === input.clientMutationId);
      if (prior) {
        if (prior.previousVersion !== input.expectedVersion || prior.actorId !== actor.id || prior.authorizationVersion !== actor.authorizationVersion || JSON.stringify(prior.evidence) !== JSON.stringify(evidence)) throw new ConflictException('合同恢复重复请求内容已变化');
        return ledger;
      }
      if (entry.task.status !== 'failed' || !entry.uncertain || contractDispositionRecoveryVersion(entry) !== expectedNativeVersion) throw new ConflictException('原合同任务状态已变化，请重新核对');
      if ((entry.recoveries?.length || 0) >= 20) throw new ConflictException('原合同任务恢复记录已满，请核对归档');
      const updated = { ...entry, task: { ...entry.task, status: 'completed' as const, message: '合同处置结果已核对，通知按原任务继续处理', completedAt: new Date().toISOString() }, uncertain: false, recoveries: [...entry.recoveries || [], audit] };
      delete updated.claimToken;
      return { ...ledger, dispositionTasks: { ...ledger.dispositionTasks, [input.taskId]: updated } };
    });
  }

  async claimDispositionTask(id: string): Promise<ContractDispositionTaskEntry | undefined> {
    let result: ContractDispositionTaskEntry | undefined;
    await this.update(ledger => {
      const entry = ledger.dispositionTasks?.[id]; if (!entry || entry.task.status !== 'pending') return ledger;
      if(entry.appId!==currentContractAppId())throw new ConflictException('合同任务所属飞书应用已变化，请核对原任务');
      result = {...entry,task:{...entry.task,status:'running',message:'合同到期处置正在后台同步'},claimToken:randomUUID()};
      return {...ledger,dispositionTasks:{...ledger.dispositionTasks,[id]:result}};
    });
    return result && structuredClone(result);
  }

  async settleDispositionTask(id: string, token: string, result: {status:'completed'|'failed';message:string;uncertain?:boolean}): Promise<void> {
    await this.update(ledger => {
      const entry = ledger.dispositionTasks?.[id]; if (!entry || entry.task.status !== 'running' || entry.claimToken !== token) throw new ConflictException('合同处置执行归属已变化');
      const updated = {...entry,task:{...entry.task,status:result.status,message:result.message,completedAt:new Date().toISOString()},uncertain:result.uncertain===true}; delete updated.claimToken;
      return {...ledger,dispositionTasks:{...ledger.dispositionTasks,[id]:updated}};
    });
  }

  async recoverDispositionTasks(): Promise<ContractDispositionTaskEntry[]> {
    let pending: ContractDispositionTaskEntry[] = [];
    await this.update(ledger => {
      const tasks = ledger.dispositionTasks || {}; pending = Object.values(tasks).filter(entry => entry.task.status === 'pending').map(entry => structuredClone(entry));
      const running = Object.values(tasks).filter(entry => entry.task.status === 'running'); if (!running.length) return ledger;
      const updated = {...tasks}; for (const entry of running) updated[entry.task.id] = {...entry,uncertain:true,task:{...entry.task,status:'failed',message:'上次合同处置结果尚未确认，请核对原合同与付款记录后处理',completedAt:new Date().toISOString()}};
      return {...ledger,dispositionTasks:updated};
    });
    return pending;
  }

  async enqueueRoleNotification(value: ContractRoleNotificationInput, authorize?: () => void): Promise<ContractRoleNotification> {
    const input = structuredClone(value);
    const appId=currentContractAppId();
    if (!validRoleNotificationInput(input)) throw new BadRequestException('合同通知内容、人员或大小无效');
    const fingerprint = notificationFingerprint(input,appId);
    let result: ContractRoleNotification | undefined;
    await this.update(ledger => {
      authorize?.();
      const jobs = ledger.roleNotifications || {}, prior = jobs[input.key];
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ConflictException('合同通知重复事件内容不一致');
        result = structuredClone(prior); return ledger;
      }
      if (Object.keys(jobs).length >= 5000) throw new ConflictException('合同通知台账已满，请核对归档');
      result = {...input,appId,fingerprint,createdAt:new Date().toISOString(),deliveries:{}};
      return {...ledger,roleNotifications:{...jobs,[input.key]:result}};
    });
    return result!;
  }

  async listRoleNotifications(): Promise<ContractRoleNotification[]> {
    return Object.values((await this.read()).roleNotifications || {}).map(job => structuredClone(job));
  }

  async getRoleNotification(key: string): Promise<ContractRoleNotification | undefined> {
    const job=(await this.read()).roleNotifications?.[key];return job&&structuredClone(job);
  }

  async claimRoleNotification(resolveRecipients: (job: ContractRoleNotification) => string[], now = new Date(), key?: string, authorizeRetry?: () => void): Promise<ClaimedContractNotification | undefined> {
    let result: ClaimedContractNotification | undefined;
    await this.update(ledger => {
      authorizeRetry?.();
      const jobs = ledger.roleNotifications || {};
      for (const job of Object.values(jobs)) {
        if (job.completedAt || key !== undefined && job.key !== key) continue;
        if(job.appId!==currentContractAppId())throw new ConflictException('合同通知所属飞书应用已变化，请核对原通知');
        const recipients = currentNotificationRecipients(resolveRecipients,job);
        for (const receiverOpenId of recipients) {
          const prior = job.deliveries[receiverOpenId];
          if (prior?.status === 'delivered' || prior?.status === 'sending') continue;
          if (!prior && Object.keys(job.deliveries).length >= 500) throw new ConflictException('合同通知投递记录已满，请核对原事件');
          if (prior && (prior.attempts >= (authorizeRetry ? 20 : 3) || now.getTime() - Date.parse(prior.firstAttemptAt) >= 55 * 60_000 || now.getTime() < Date.parse(prior.firstAttemptAt))) continue;
          const uuid = prior?.uuid || notificationUuid(job,receiverOpenId), claimToken = randomUUID();
          const delivery: ContractNotificationDelivery = {uuid,claimToken,status:'sending',firstAttemptAt:prior?.firstAttemptAt || now.toISOString(),attempts:(prior?.attempts || 0)+1};
          result = {key:job.key,receiverOpenId,uuid,claimToken,kind:job.kind,content:structuredClone(job.content)};
          return {...ledger,roleNotifications:{...jobs,[job.key]:{...job,deliveries:{...job.deliveries,[receiverOpenId]:delivery}}}};
        }
      }
      return ledger;
    });
    return result;
  }

  async settleRoleNotification(delivery: ClaimedContractNotification, messageId: string | null, resolveRecipients: (job: ContractRoleNotification) => string[]): Promise<void> {
    await this.update(ledger => {
      const job = ledger.roleNotifications?.[delivery.key], prior = job?.deliveries[delivery.receiverOpenId];
      if (!job || !prior || prior.status !== 'sending' || prior.claimToken !== delivery.claimToken || prior.uuid !== delivery.uuid) throw new ConflictException('合同通知投递归属已变化');
      if (messageId !== null && (!/^om_[A-Za-z0-9_-]+$/.test(messageId) || messageId.length > 160)) throw new BadRequestException('合同通知回执无效');
      const updated: ContractRoleNotification = {...job,deliveries:{...job.deliveries,[delivery.receiverOpenId]:{...prior,status:messageId?'delivered':'uncertain',...(messageId?{messageId}:{})}}};
      delete updated.deliveries[delivery.receiverOpenId].claimToken;
      const recipients = currentNotificationRecipients(resolveRecipients,updated);
      if (recipients.length && recipients.every(receiver => updated.deliveries[receiver]?.status === 'delivered')) {
        updated.completedAt = new Date().toISOString();
        updated.completedRecipients = recipients;
      }
      return {...ledger,roleNotifications:{...ledger.roleNotifications,[job.key]:updated}};
    });
  }

  async recoverRoleNotifications(): Promise<void> {
    await this.update(ledger => {
      let changed = false;
      const jobs = structuredClone(ledger.roleNotifications || {});
      for (const job of Object.values(jobs)) for (const delivery of Object.values(job.deliveries)) if (delivery.status === 'sending') {
        delivery.status = 'uncertain'; delete delivery.claimToken; changed = true;
      }
      return changed ? {...ledger,roleNotifications:jobs} : ledger;
    });
  }

  async enqueuePaymentDigest(input:ContractPaymentDigestInput):Promise<ContractPaymentDigestJob> {
    let result:ContractPaymentDigestJob|undefined;
    await this.update(ledger=>{const change=enqueueContractPaymentDigest(ledger,input,currentContractAppId());result=change.job;return change.changed?{...ledger}:ledger;});
    return result!;
  }

  async claimPaymentDigest(resolve:ContractPaymentDigestResolver,render:ContractPaymentDigestRenderer,now=new Date(),authorizeRetry?:()=>void,key?:string):Promise<ContractPaymentDigestDispatch|undefined> {
    let dispatch:ContractPaymentDigestDispatch|undefined;
    await this.update(ledger=>{authorizeRetry?.();const change=claimContractPaymentDigest(ledger,currentContractAppId(),resolve,render,now,!!authorizeRetry,key);dispatch=change.dispatch;return change.changed?{...ledger}:ledger;});
    return dispatch;
  }

  async settlePaymentDigest(dispatch:ContractPaymentDigestDispatch,messageId:string|null,resolve:ContractPaymentDigestResolver):Promise<void> {
    await this.update(ledger=>{settleContractPaymentDigest(ledger,dispatch,messageId,resolve);return {...ledger};});
  }

  async recoverPaymentDigests():Promise<void> {
    await this.update(ledger=>recoverContractPaymentDigests(ledger)?{...ledger}:ledger);
  }

  async listPaymentDigests():Promise<ContractPaymentDigestJob[]> {
    return Object.values((await this.read()).paymentDigests || {}).map(job=>structuredClone(job));
  }

  async getBaselineAt(): Promise<string | null> {
    return (await this.read()).baselineAt;
  }

  async ensureBaselineAt(value: string): Promise<string> {
    let baseline = value;
    await this.update((ledger) => {
      baseline = ledger.baselineAt || value;
      return { ...ledger, baselineAt: baseline };
    });
    return baseline;
  }

  async processedKeys(): Promise<Set<string>> {
    return new Set(Object.keys((await this.read()).processed));
  }

  async markProcessed(key: string, messageIds: string[]): Promise<void> {
    await this.update((ledger) => ({
      ...ledger,
      processed: {
        ...ledger.processed,
        [key]: { completedAt: new Date().toISOString(), messageIds },
      },
    }));
  }

  async deliveredKeys(): Promise<Set<string>> {
    return new Set(Object.keys((await this.read()).deliveries));
  }

  async markDelivered(key: string, messageId: string): Promise<void> {
    await this.update((ledger) => ({
      ...ledger,
      deliveries: {
        ...ledger.deliveries,
        [key]: { completedAt: new Date().toISOString(), messageId },
      },
    }));
  }

  async appendRun(result: ContractWorkflowRunResult): Promise<void> {
    await this.update((ledger) => ({
      ...ledger,
      logs: [{ id: randomUUID(), ...result }, ...ledger.logs].slice(0, 100),
    }));
  }

  async recentLogs(limit = 20): Promise<ContractWorkflowLogItem[]> {
    return (await this.read()).logs.slice(0, Math.max(1, Math.min(limit, 100)));
  }

  private async update(
    mutate: (ledger: ContractWorkflowLedger) => ContractWorkflowLedger,
  ): Promise<void> {
    const operation = this.writeQueue.then(async () => {
      const ledger = await this.read();
      const next = mutate(ledger);
      if (next === ledger) return;
      await mkdir(dirname(this.filePath), { recursive: true });
      const tempPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tempPath, JSON.stringify(next, null, 2), 'utf8');
      await rename(tempPath, this.filePath);
    });
    this.writeQueue = operation.catch(() => undefined);
    await operation;
  }

  private async read(): Promise<ContractWorkflowLedger> {
    try {
      const parsed = JSON.parse(
        await readFile(this.filePath, 'utf8'),
      ) as Partial<ContractWorkflowLedger>;
      if (parsed.dispositionTasks !== undefined && !validDispositionTasks(parsed.dispositionTasks)) throw new Error('合同处置任务台账无效，已保留原文件');
      if (parsed.roleNotifications !== undefined && !validRoleNotifications(parsed.roleNotifications)) throw new Error('合同通知台账无效，已保留原文件');
      if(!validContractPaymentDigests({paymentDigests:parsed.paymentDigests,processed:parsed.processed || {},deliveries:parsed.deliveries || {}}))throw new Error('付款汇总台账无效，已保留原文件');
      return {
        version: 2,
        baselineAt:
          typeof parsed.baselineAt === 'string' ? parsed.baselineAt : null,
        processed:
          parsed.processed && typeof parsed.processed === 'object'
            ? parsed.processed
            : {},
        deliveries:
          parsed.deliveries && typeof parsed.deliveries === 'object'
            ? parsed.deliveries
            : {},
        logs: Array.isArray(parsed.logs) ? parsed.logs : [],
        ...(parsed.dispositionTasks === undefined ? {} : {dispositionTasks:parsed.dispositionTasks}),
        ...(parsed.roleNotifications === undefined ? {} : {roleNotifications:parsed.roleNotifications}),
        ...(parsed.paymentDigests === undefined ? {} : {paymentDigests:parsed.paymentDigests}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { ...EMPTY_LEDGER, processed: {}, deliveries: {}, logs: [] };
      }
      throw error;
    }
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>[key,stableValue(item)]));
  return value;
}
function dispositionFingerprint(input: ContractDispositionTaskInput,appId:string): string {
  return createHash('sha256').update(JSON.stringify(stableValue([appId,input.recordId,input.request,input.principal?.accountId || null]))).digest('hex');
}
function validDispositionTasks(value: unknown): value is Record<string,ContractDispositionTaskEntry> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 2000) return false;
  if (!Object.values(value).every(entry => validRecoveryAudits(entry?.recoveries))) return false;
  return Object.entries(value).every(([id,entry]:[string,ContractDispositionTaskEntry])=>entry && validContractAppId(entry.appId) && entry.task?.id===id && /^contract-expiry-[a-f0-9-]{36}$/.test(id) && typeof entry.task.recordId==='string' && ['pending','running','completed','failed'].includes(entry.task.status) && ['renew','void'].includes(entry.request?.action) && entry.task.action===entry.request.action && typeof entry.task.message==='string' && Number.isFinite(Date.parse(entry.task.createdAt)) && Number.isFinite(Date.parse(entry.now)) && typeof entry.mutationId==='string' && /^[a-f0-9]{64}$/.test(entry.fingerprint) && dispositionFingerprint({recordId:entry.task.recordId,request:entry.request,principal:entry.principal,now:entry.now},entry.appId)===entry.fingerprint && (entry.task.status!=='running'||typeof entry.claimToken==='string') && (entry.uncertain===undefined||typeof entry.uncertain==='boolean'));
}
export function contractDispositionRecoveryVersion(entry: ContractDispositionTaskEntry): string {
  return createHash('sha256').update(JSON.stringify([entry.appId, entry.fingerprint, entry.task, entry.uncertain, entry.recoveries || []])).digest('hex');
}

function validRoleNotificationInput(input: ContractRoleNotificationInput): boolean {
  if (!input || typeof input.key !== 'string' || !/^[A-Za-z0-9:_-]{1,256}$/.test(input.key) || !['card','text'].includes(input.kind) || !Array.isArray(input.fallbackRecipients) || input.fallbackRecipients.length > 200 || input.fallbackRecipients.some(id => typeof id !== 'string' || !/^ou_[A-Za-z0-9]+$/.test(id)) || new Set(input.fallbackRecipients).size !== input.fallbackRecipients.length || input.specialty !== undefined && typeof input.specialty !== 'string') return false;
  if (input.kind === 'text' ? typeof input.content !== 'string' : !input.content || typeof input.content !== 'object' || Array.isArray(input.content)) return false;
  return Buffer.byteLength(JSON.stringify(input.content),'utf8') <= (input.kind === 'card' ? 28_000 : 145_000);
}
function notificationFingerprint(input: ContractRoleNotificationInput,appId:string): string {
  return createHash('sha256').update(JSON.stringify(stableValue([appId,input.key,input.kind,input.content,[...input.fallbackRecipients].sort(),input.specialty || null]))).digest('hex');
}
function notificationUuid(job: ContractRoleNotification, receiver: string): string {
  const hash = createHash('sha256').update(JSON.stringify([job.key,job.fingerprint,receiver])).digest('hex');
  return `${hash.slice(0,8)}-${hash.slice(8,12)}-5${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}`;
}
function currentNotificationRecipients(resolve: (job: ContractRoleNotification) => string[], job: ContractRoleNotification): string[] {
  const recipients = resolve(structuredClone(job));
  if (!Array.isArray(recipients) || recipients.length > 200 || recipients.some(id => typeof id !== 'string' || !/^ou_[A-Za-z0-9]+$/.test(id))) throw new ConflictException('合同通知当前岗位人员无效');
  return [...new Set(recipients)];
}
function validRoleNotifications(value: unknown): value is Record<string,ContractRoleNotification> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 5000) return false;
  return Object.entries(value).every(([key,job]:[string,ContractRoleNotification]) => job && validContractAppId(job.appId) && job.key === key && validRoleNotificationInput(job) && Number.isFinite(Date.parse(job.createdAt)) && (job.completedAt === undefined || Number.isFinite(Date.parse(job.completedAt))) && job.fingerprint === notificationFingerprint(job,job.appId) && job.deliveries && typeof job.deliveries === 'object' && !Array.isArray(job.deliveries) && Object.keys(job.deliveries).length <= 500 && validCompletedRecipients(job) && Object.entries(job.deliveries).every(([receiver,delivery]) => /^ou_[A-Za-z0-9]+$/.test(receiver) && delivery && delivery.uuid === notificationUuid(job,receiver) && ['sending','uncertain','delivered'].includes(delivery.status) && Number.isFinite(Date.parse(delivery.firstAttemptAt)) && Number.isSafeInteger(delivery.attempts) && delivery.attempts > 0 && delivery.attempts <= 20 && (delivery.status !== 'sending' || typeof delivery.claimToken === 'string') && (delivery.status !== 'delivered' || typeof delivery.messageId === 'string' && /^om_[A-Za-z0-9_-]+$/.test(delivery.messageId))));
}

function validCompletedRecipients(job:ContractRoleNotification):boolean {
  return job.completedRecipients===undefined || !!job.completedAt && Array.isArray(job.completedRecipients) && job.completedRecipients.length>0 && job.completedRecipients.length<=200 && new Set(job.completedRecipients).size===job.completedRecipients.length && job.completedRecipients.every(receiver=>typeof receiver==='string'&&job.deliveries[receiver]?.status==='delivered');
}
function validContractAppId(appId:unknown):appId is string {return typeof appId==='string'&&/^cli_[A-Za-z0-9_]+$/.test(appId);}
function currentContractAppId():string {
  const appId=process.env.FEISHU_APP_ID?.trim();if(!validContractAppId(appId))throw new ConflictException('合同任务的飞书应用未配置');return appId;
}
