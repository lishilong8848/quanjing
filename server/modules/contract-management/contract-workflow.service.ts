import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { cancelHotfixInitialization, runHotfixInitialization } from '../../common/hotfix-runtime-activation';
import { createHash } from 'node:crypto';
import type {
  ContractCreateKind,
  ContractCreateNotificationResult,
  ContractExpiryDispositionAction,
  ContractPaymentFollowUpAction,
  ContractWorkflowCode,
  ContractWorkflowRunResult,
  ContractWorkflowTrigger,
} from '../../../shared/contract-management.interface';
import { readEnv } from '../../common/config/external-services.config';
import { getAccessConfigurationStore, type ConfigurationState } from '../../common/access/access-configuration.store';
import { resolveCurrentPersonnelDutyMembers } from '../../common/access/personnel-duty-current';
import {
  extractDisplayText,
  extractNumberValue,
  getRecordId,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import {
  ContractWorkflowGateway,
  type ContractWorkflowSource,
} from './contract-workflow.gateway';
import {
  buildContractWorkflowCandidates,
  type ContractWorkflowRecord,
} from './contract-workflow.rules';
import { ContractWorkflowStore, type ContractRoleNotification, type ContractRoleNotificationInput } from './contract-workflow.store';
import { paymentDigestDeliveryKey, type ContractPaymentDigestCandidate, type ContractPaymentDigestJob } from './contract-payment-digest';

const CONTRACT_TABLE_ID = 'tbl1171c5349e996';
const FRAMEWORK_TABLE_ID = 'tbl033c8ec63ff1b';
const CONTRACT_VIEW_ID = 'vewgPPCOHp';
const PAYMENT_TABLE_ID = 'tbl277d0db09de0f';

export interface ContractCreatedNotificationInput {
  kind: ContractCreateKind;
  recordId: string;
  name: string;
  code: string;
  supplier: string;
  ownerNames: string[];
  ownerOpenIds: string[];
  specialty: string;
  amount: number;
  startDate: string;
  endDate: string;
  selfTest: boolean;
}

export interface ContractPaymentFollowUpNotificationInput {
  action: ContractPaymentFollowUpAction;
  contractRecordId: string;
  contractCode: string;
  contractName: string;
  paymentRecordId: string;
  paymentLabel: string;
  period: string;
  plannedAmount: number;
  actualAmount: number;
  plannedPaymentDate: string;
  paymentDate: string;
  ownerOpenIds: string[];
  ownerNames: string[];
}

export interface ContractLifecycleNotificationInput {
  specialty?: string;
  action: ContractExpiryDispositionAction;
  recordId: string;
  name: string;
  code: string;
  endDate: string;
  ownerNames: string[];
  ownerOpenIds: string[];
}

@Injectable()
export class ContractWorkflowService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ContractWorkflowService.name);
  private readonly running = new Set<ContractWorkflowCode>();
  private notificationWork = Promise.resolve();
  private notificationTimer?: NodeJS.Timeout;
  private notificationScheduled?: NodeJS.Immediate;
  private notificationRecovery?: Promise<void>;
  private notificationStopped = false;
  private readonly lastRuns = new Map<
    ContractWorkflowCode,
    ContractWorkflowRunResult
  >();

  constructor(
    private readonly gateway: ContractWorkflowGateway,
    private readonly store: ContractWorkflowStore,
  ) {}

  async onModuleInit(): Promise<void> {
    return runHotfixInitialization(this, async () => {
    await this.store.recoverRoleNotifications();
    await this.store.recoverPaymentDigests();
    this.scheduleNotificationFlush();
    this.notificationTimer=setInterval(()=>this.scheduleNotificationFlush(),30_000);
    this.notificationTimer.unref();
    });
  }

  async onModuleDestroy(): Promise<void> {
    await cancelHotfixInitialization(this);
    this.notificationStopped=true;
    if(this.notificationTimer)clearInterval(this.notificationTimer);
    if(this.notificationScheduled)clearImmediate(this.notificationScheduled);
    await this.notificationRecovery;
    await this.notificationWork;
  }

  private scheduleNotificationFlush(): void {
    if(this.notificationStopped||this.notificationScheduled||this.notificationRecovery)return;
    this.notificationScheduled=setImmediate(()=>{
      this.notificationScheduled=undefined;
      const recovery=(async()=>{await this.flushRoleNotifications();await this.flushPaymentDigests();})().catch(()=>this.logger.warn('合同通知恢复未完成，请核对原通知任务'));
      this.notificationRecovery=recovery;
      void recovery.finally(()=>{if(this.notificationRecovery===recovery)this.notificationRecovery=undefined;});
    });
  }

  async enqueueContractLifecycleChanged(input: ContractLifecycleNotificationInput, authorize?: () => void): Promise<ContractCreateNotificationResult> {
    const source=await this.readSourceWithRetry();
    const fallbackRecipients=dedupe([...managerOpenIds(source.organization),...input.ownerOpenIds]);
    await this.store.enqueueRoleNotification({key:`contract-lifecycle:${input.recordId}:${input.action}:${input.endDate}`,kind:'card',content:buildContractLifecycleCard(input,source.sourceUrl),fallbackRecipients,...(input.specialty?{specialty:input.specialty}:{})}, authorize);
    this.scheduleNotificationFlush();
    return {attempted:true,recipients:resolveContractNotificationRecipients(fallbackRecipients,input.specialty).length,sent:0,failed:0,message:'合同状态已更新，通知正在后台发送'};
  }

  flushRoleNotifications(key?: string, authorizeRetry?: () => void): Promise<{sent:number;failed:number}> {
    const operation = this.notificationWork.then(()=>this.flushNotificationQueue(key,authorizeRetry));
    this.notificationWork = operation.then(()=>undefined,()=>undefined);
    return operation;
  }

  flushPaymentDigests(authorizeRetry?:()=>void,key?:string):Promise<{sent:number;failed:number}> {
    const operation=this.notificationWork.then(()=>this.flushPaymentDigestQueue(authorizeRetry,key));
    this.notificationWork=operation.then(()=>undefined,()=>undefined);
    return operation;
  }

  private async flushPaymentDigestQueue(authorizeRetry?:()=>void,key?:string):Promise<{sent:number;failed:number}> {
    let sent=0,failed=0;
    for(let count=0;count<200&&!this.notificationStopped;count++){
      const delivery=await this.store.claimPaymentDigest(paymentNotificationRecipients(),buildPaymentDueDigestCard,new Date(),authorizeRetry,key);
      if(!delivery)break;
      let messageId:string;
      try{messageId=await this.gateway.sendInteractiveCard(delivery.receiverOpenId,delivery.content,delivery.uuid);}
      catch{await this.store.settlePaymentDigest(delivery,null,paymentNotificationRecipients());failed++;this.logger.warn('付款汇总尚未送达，保留原投递编号等待恢复');break;}
      await this.store.settlePaymentDigest(delivery,messageId,paymentNotificationRecipients());sent++;
    }
    return {sent,failed};
  }

  private async flushNotificationQueue(key?: string, authorizeRetry?: () => void): Promise<{sent:number;failed:number}> {
    let sent=0,failed=0;
    for(let count=0;count<200&&!this.notificationStopped;count++) {
      const delivery = await this.store.claimRoleNotification(roleNotificationRecipients(),new Date(),key,authorizeRetry);
      if(!delivery)break;
      let messageId:string;
      try {
        messageId = delivery.kind==='card'
          ? await this.gateway.sendInteractiveCard(delivery.receiverOpenId,delivery.content as Record<string,unknown>,delivery.uuid)
          : await this.gateway.sendText(delivery.receiverOpenId,delivery.content as string,delivery.uuid);
      } catch {
        await this.store.settleRoleNotification(delivery,null,roleNotificationRecipients());
        failed++;
        this.logger.warn('合同通知尚未送达，保留原投递编号等待恢复');
        break;
      }
      await this.store.settleRoleNotification(delivery,messageId,roleNotificationRecipients());
      sent++;
    }
    return {sent,failed};
  }

  private async notifyRole(input:ContractRoleNotificationInput, success:(count:number)=>string, failure:(count:number)=>string):Promise<ContractCreateNotificationResult> {
    await this.store.enqueueRoleNotification(input);
    await this.flushRoleNotifications(input.key);
    return this.roleNotificationResult(input.key,success,failure);
  }

  private async roleNotificationResult(key:string, success:(count:number)=>string, failure:(count:number)=>string):Promise<ContractCreateNotificationResult> {
    const job=await this.store.getRoleNotification(key);
    if(!job)throw new Error('合同通知正式任务缺失');
    const recipients=job.completedAt
      ? job.completedRecipients || Object.keys(job.deliveries).filter(receiver=>job.deliveries[receiver].status==='delivered')
      : resolveContractNotificationRecipients(job.fallbackRecipients,job.specialty);
    const sent=recipients.filter(receiver=>job.deliveries[receiver]?.status==='delivered').length,failed=recipients.length?recipients.length-sent:1;
    return {attempted:recipients.length>0,recipients:recipients.length,sent,failed,message:failed?failure(failed):success(sent)};
  }

  isRunning(code: ContractWorkflowCode): boolean {
    return this.running.has(code);
  }

  getLastRun(code: ContractWorkflowCode): ContractWorkflowRunResult | null {
    return this.lastRuns.get(code) || null;
  }

  listRecentLogs() {
    return this.store.recentLogs();
  }

  async notifyContractCreated(
    input: ContractCreatedNotificationInput,
  ): Promise<ContractCreateNotificationResult> {
    const source = await this.readSourceWithRetry();
    return this.notifyRole({key:`contract-created:${input.kind}:${input.recordId}`,kind:'card',content:buildContractCreatedCard(input,source.sourceUrl),fallbackRecipients:dedupe([...managerOpenIds(source.organization),...input.ownerOpenIds]),...(input.specialty?{specialty:input.specialty}:{})},count=>`合同通知已发送给 ${count} 人`,count=>`合同已创建，但 ${count} 位接收人的通知发送失败`);
  }

  async notifyContractLifecycleChanged(
    input: ContractLifecycleNotificationInput,
  ): Promise<ContractCreateNotificationResult> {
    await this.enqueueContractLifecycleChanged(input);
    const key=`contract-lifecycle:${input.recordId}:${input.action}:${input.endDate}`;
    await this.flushRoleNotifications(key);
    return this.roleNotificationResult(key,count=>`合同状态通知已发送给 ${count} 人`,count=>`合同状态已更新，但 ${count} 位接收人的通知发送失败`);
  }

  async notifyPaymentFollowUpChanged(
    input: ContractPaymentFollowUpNotificationInput,
  ): Promise<ContractCreateNotificationResult> {
    const source = await this.readSourceWithRetry();
    const key=`contract-payment:${createHash('sha256').update(JSON.stringify([input.action,input.contractRecordId,input.paymentRecordId,input.period,input.plannedAmount,input.actualAmount,input.plannedPaymentDate,input.paymentDate,[...input.ownerOpenIds].sort()])).digest('hex')}`;
    return this.notifyRole({key,kind:'text',content:buildPaymentFollowUpMessage(input,source.sourceUrl),fallbackRecipients:dedupe([...managerOpenIds(source.organization),...input.ownerOpenIds])},count=>`付款跟进通知已发送给 ${count} 人`,count=>`付款计划已更新，但 ${count} 位接收人的通知发送失败`);
  }

  async run(
    code: ContractWorkflowCode,
    options: { trigger: ContractWorkflowTrigger },
  ): Promise<ContractWorkflowRunResult> {
    if (this.running.has(code)) {
      throw new Error(`${workflowName(code)}正在运行，请稍后重试`);
    }
    this.running.add(code);
    const startedAt = new Date().toISOString();
    try {
      const result = await this.execute(code, options.trigger, startedAt);
      this.lastRuns.set(code, result);
      await this.store.appendRun(result);
      return result;
    } catch (error) {
      const result: ContractWorkflowRunResult = {
        code,
        trigger: options.trigger,
        startedAt,
        completedAt: new Date().toISOString(),
        scanned: 0,
        matched: 0,
        sent: 0,
        skipped: 0,
        failed: 1,
        message: safeMessage(error),
      };
      this.lastRuns.set(code, result);
      await this.store.appendRun(result);
      this.logger.error(`${workflowName(code)}执行失败：${result.message}`);
      throw error;
    } finally {
      this.running.delete(code);
    }
  }

  async selfTest(): Promise<{
    ok: true;
    checkedAt: string;
    contracts: number;
    payments: number;
    organization: number;
    managerReceivers: number;
    message: string;
  }> {
    const source = await this.readSourceWithRetry();
    return {
      ok: true,
      checkedAt: new Date().toISOString(),
      contracts: source.contracts.length,
      payments: source.payments.length,
      organization: source.organization.length,
      managerReceivers: managerOpenIds(source.organization).length,
      message: '数据源、关联关系与接收人解析正常；自检未发送消息',
    };
  }

  private async readSourceWithRetry(): Promise<ContractWorkflowSource> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.gateway.readSource();
      } catch (error) {
        lastError = error;
        if (!isFeishuDataNotReady(error) || attempt === 2) throw error;
        this.logger.warn(
          `飞书多维表数据暂未就绪，第 ${attempt + 1} 次读取将在 1 秒后重试`,
        );
        await delay(1_000);
      }
    }
    throw lastError;
  }

  private async execute(
    code: ContractWorkflowCode,
    trigger: ContractWorkflowTrigger,
    startedAt: string,
  ): Promise<ContractWorkflowRunResult> {
    const source = await this.readSourceWithRetry();
    const managers = managerOpenIds(source.organization);
    const contractRecords = source.contracts.map(mapContractWorkflowRecord);
    const contractIndex = new Map(
      contractRecords.map((record) => [record.recordId, record]),
    );
    const records =
      code === 'payment_due_reminder'
        ? source.payments.map((record) =>
            mapPaymentWorkflowRecord(record, contractIndex),
          )
        : contractRecords;
    const candidates = buildContractWorkflowCandidates({
      workflow: code,
      records,
      now: new Date(),
      baselineAt: null,
      processedKeys: await this.store.processedKeys(),
    });
    let sent = 0;
    let skipped = records.length - candidates.length;
    let failed = 0;

    if (code === 'payment_due_reminder') {
      if(candidates.length)await this.store.enqueuePaymentDigest({key:`payment-due:${createHash('sha256').update(JSON.stringify(candidates.map(candidate=>candidate.dedupeKey).sort())).digest('hex')}`,sourceUrl:source.sourceUrl,candidates:candidates.map(candidate=>({...candidate,fallbackRecipients:notificationRecipients(candidate.record,managers)}))});
      const delivery=await this.flushPaymentDigests();sent=delivery.sent;
      const processed=await this.store.processedKeys(),delivered=await this.store.deliveredKeys(),pendingReceivers=new Set<string>();
      for(const candidate of candidates){
        if(processed.has(candidate.dedupeKey))continue;
        const recipients=resolveContractNotificationRecipients(notificationRecipients(candidate.record,managers),candidate.record.specialty);
        if(!recipients.length)pendingReceivers.add(`unconfigured:${candidate.dedupeKey}`);
        for(const receiver of recipients)if(!delivered.has(paymentDigestDeliveryKey(candidate.dedupeKey,receiver)))pendingReceivers.add(receiver);
      }
      failed=Math.max(delivery.failed,pendingReceivers.size);
      return buildResult(code, trigger, startedAt, {
        scanned: records.length,
        matched: candidates.length,
        sent,
        skipped,
        failed,
        message: `扫描 ${records.length} 条，命中 ${candidates.length} 条，汇总发送 ${sent} 张，未完成 ${failed} 项（含待恢复任务）`,
      });
    }

    for (const candidate of candidates) {
      try {
        const key=`contract-reminder:${candidate.dedupeKey}`;
        const result=await this.notifyRole({key,kind:code==='contract_expiry_reminder'?'card':'text',content:code==='contract_expiry_reminder'?buildContractExpiryReminderCard(candidate.record,source.sourceUrl):buildMessage(code,candidate.record,source.sourceUrl),fallbackRecipients:notificationRecipients(candidate.record,managers),...(candidate.record.specialty?{specialty:candidate.record.specialty}:{})},count=>`通知已送达 ${count} 人`,count=>`${count} 位接收人尚未送达`);
        if(result.failed){failed++;continue;}
        const job=await this.store.getRoleNotification(key);
        if(!job?.completedAt)throw new Error('合同到期提醒尚无完整回执');
        const messageIds=(job.completedRecipients || []).map(receiver=>job.deliveries[receiver].messageId!);
        await this.store.markProcessed(candidate.dedupeKey,messageIds);
        sent++;
      } catch(error) {
        failed++;
        this.logger.warn(`${workflowName(code)}发送失败：${safeMessage(error)}`);
      }
    }

    return buildResult(code, trigger, startedAt, {
      scanned: records.length,
      matched: candidates.length,
      sent,
      skipped,
      failed,
      message: `扫描 ${records.length} 条，命中 ${candidates.length} 条，成功 ${sent} 条，失败 ${failed} 条`,
    });
  }
}

function mapContractWorkflowRecord(
  record: BitableRecordItem,
): ContractWorkflowRecord {
  const fields = record.fields || {};
  return {
    recordId: getRecordId(record),
    kind: 'contract',
    name: extractDisplayText(fields['合同名称']),
    code: extractDisplayText(fields['合同编号']),
    ownerNames: extractNames(fields['跟进人']),
    ownerOpenIds: extractOpenIds(fields['跟进人']),
    specialty: extractDisplayText(fields['专业类别']),
    specialtyManagerOpenIds: extractOpenIds(fields['专业示例人员001']),
    amount: extractNumberValue(fields['合同金额']) || 0,
    startDate: dateKey(fields['合同开始日期']),
    endDate: dateKey(fields['合同结束日期']),
    attachmentCount: Array.isArray(fields['合同附件'])
      ? fields['合同附件'].length
      : 0,
    createdAt: recordTimeToIso(record.created_time),
    paymentPlanCount: linkedRecordIds(fields['付款计划']).length,
  };
}

function mapPaymentWorkflowRecord(
  record: BitableRecordItem,
  contractIndex: Map<string, ContractWorkflowRecord>,
): ContractWorkflowRecord {
  const fields = record.fields || {};
  const contract = contractIndex.get(
    linkedRecordIds(fields['合同编号'])[0] || '',
  );
  return {
    recordId: getRecordId(record),
    kind: 'payment',
    name: extractDisplayText(fields['付款计划']) || '付款计划',
    code: contract?.code || extractDisplayText(fields['合同编号']),
    ownerNames: contract?.ownerNames.length
      ? contract.ownerNames
      : extractNames(fields['跟进人']),
    ownerOpenIds: contract?.ownerOpenIds.length
      ? contract.ownerOpenIds
      : extractOpenIds(fields['跟进人']),
    specialty: contract?.specialty || '',
    specialtyManagerOpenIds: contract?.specialtyManagerOpenIds || [],
    amount: extractNumberValue(fields['计划付款金额']) || 0,
    startDate: null,
    endDate: dateKey(fields['计划付款日期']),
    attachmentCount: 0,
    createdAt: recordTimeToIso(record.created_time),
    paymentStatus: extractDisplayText(fields['付款状态']),
    actualAmount: extractNumberValue(fields['实际付款金额']) || 0,
    paymentPlanCount: 0,
  };
}

function managerOpenIds(records: BitableRecordItem[]): string[] {
  return dedupe(
    records.flatMap((record) => {
      const fields = record.fields || {};
      const position = extractDisplayText(fields['职位']);
      return /机房经理|副经理|综合管理/.test(position)
        ? extractOpenIds(fields['示例人员001'])
        : [];
    }),
  );
}

function notificationRecipients(
  record: ContractWorkflowRecord,
  managers: string[],
): string[] {
  const specialtyReceivers = /土建|其他/.test(record.specialty)
    ? []
    : record.specialtyManagerOpenIds;
  return dedupe([...managers, ...specialtyReceivers, ...record.ownerOpenIds]);
}

function resolveContractNotificationRecipients(fallback: string[], specialty?: string): string[] {
  return createContractNotificationRecipientResolver()(fallback,specialty);
}

function createContractNotificationRecipientResolver() {
  let state:ConfigurationState|undefined,appId='',configured:string[]|undefined;
  const managedBySpecialty=new Map<string,ReturnType<typeof resolveCurrentPersonnelDutyMembers>>();
  return (fallback:string[],value?:string):string[]=>{
    if(!state){state=getAccessConfigurationStore().read();appId=process.env.FEISHU_APP_ID?.trim()||'';}
    const specialty=value?.trim()||undefined,key=specialty||'';
    if(!managedBySpecialty.has(key))managedBySpecialty.set(key,resolveCurrentPersonnelDutyMembers(state,appId,'contract_notify',{building:null,specialty}));
    const managed=managedBySpecialty.get(key)!;
    if(managed!==null)return dedupe(managed.map(person=>person.openId));
    configured ||= readEnv('FEISHU_CONTRACT_NOTIFICATION_RECEIVER_OPEN_IDS').split(/[，,;；\s]+/).map(value=>value.trim()).filter(value=>/^ou_[A-Za-z0-9]+$/.test(value));
    return configured.length?dedupe(configured):dedupe(fallback);
  };
}
function roleNotificationRecipients() {
  const read=createContractNotificationRecipientResolver();return (job:ContractRoleNotification)=>read(job.fallbackRecipients,job.specialty);
}
function paymentNotificationRecipients() {
  const read=createContractNotificationRecipientResolver();return (candidate:ContractPaymentDigestCandidate)=>read(candidate.fallbackRecipients,candidate.record.specialty);
}

function blockedDelivery(delivery: { status: string; attempts: number; firstAttemptAt: string }, now: number): boolean {
  return delivery.status === 'uncertain' && (delivery.attempts >= 3 || now - Date.parse(delivery.firstAttemptAt) >= 55 * 60_000 || now < Date.parse(delivery.firstAttemptAt));
}
export function contractNotificationBlocked(job: ContractRoleNotification, now = Date.now()): boolean {
  return resolveContractNotificationRecipients(job.fallbackRecipients, job.specialty).some(receiver => job.deliveries[receiver] && blockedDelivery(job.deliveries[receiver], now));
}
export function contractPaymentDigestBlocked(job: ContractPaymentDigestJob, processed: ReadonlySet<string>, now = Date.now()): boolean {
  return Object.values(job.messages).some(message => blockedDelivery(message, now) && job.candidates.some(candidate => !processed.has(candidate.dedupeKey) && message.candidateKeys.includes(candidate.dedupeKey) && resolveContractNotificationRecipients(candidate.fallbackRecipients, candidate.record.specialty).includes(message.receiverOpenId)));
}

function buildMessage(
  code: ContractWorkflowCode,
  record: ContractWorkflowRecord,
  sourceUrl: string,
): string {
  const title =
    code === 'payment_due_reminder'
      ? '付款即将到期提醒，付款将于明日到期'
      : '合同即将到期提醒，合同将于明日到期';
  const dateLabel =
    code === 'payment_due_reminder' ? '计划付款日期' : '合同结束日期';
  return [
    `【${title}】`,
    `合同名称：${record.name || '待补充'}`,
    `合同编号：${record.code || '待补充'}`,
    `跟进人：${record.ownerNames.join('、') || '待补充'}`,
    `专业类别：${record.specialty || '待补充'}`,
    `金额：${formatMoney(record.amount)}`,
    `${dateLabel}：${record.endDate || '待补充'}`,
    `查看详情：${contractDetailUrl(sourceUrl, record.recordId)}`,
  ].join('\n');
}

function buildContractCreatedCard(
  input: ContractCreatedNotificationInput,
  sourceUrl: string,
): Record<string, unknown> {
  const kindLabel = input.kind === 'framework' ? '框架合同' : '执行合同';
  return buildContractCard({
    title: `新建${kindLabel}已完成`,
    template: 'blue',
    fields: [
      ['合同名称', input.name || '待补充'],
      ['合同编号', input.code || '待补充'],
      ...(input.kind === 'execution'
        ? [
            ['供应商', input.supplier || '待补充'],
            ['跟进人', input.ownerNames.join('、') || '待补充'],
            ['专业类别', input.specialty || '待补充'],
            ['合同金额', formatMoney(input.amount)],
          ]
        : []),
      [
        '合同周期',
        `${input.startDate || '待补充'} 至 ${input.endDate || '待补充'}`,
      ],
    ],
    detailUrl: createdContractDetailUrl(sourceUrl, input),
    selfTest: input.selfTest,
  });
}

function buildContractLifecycleCard(
  input: ContractLifecycleNotificationInput,
  sourceUrl: string,
): Record<string, unknown> {
  const renewed = input.action === 'renew';
  return buildContractCard({
    title: renewed ? '合同续期已完成' : '合同已作废',
    template: renewed ? 'green' : 'red',
    fields: [
      ['合同名称', input.name || '待补充'],
      ['合同编号', input.code || '待补充'],
      ['跟进人', input.ownerNames.join('、') || '待补充'],
      [renewed ? '续期截止日期' : '原合同截止日期', input.endDate || '待补充'],
      ['处理结果', renewed ? '已完成续期' : '已确认作废'],
    ],
    detailUrl: contractDetailUrl(sourceUrl, input.recordId),
  });
}

function buildContractExpiryReminderCard(
  record: ContractWorkflowRecord,
  sourceUrl: string,
): Record<string, unknown> {
  return buildContractCard({
    title: '合同即将到期提醒',
    template: 'orange',
    fields: [
      ['合同名称', record.name || '待补充'],
      ['合同编号', record.code || '待补充'],
      ['跟进人', record.ownerNames.join('、') || '待补充'],
      ['合同金额', formatMoney(record.amount)],
      ['合同结束日期', record.endDate || '待补充'],
    ],
    detailUrl: contractDetailUrl(sourceUrl, record.recordId),
  });
}

function buildPaymentDueDigestCard(
  records: ContractWorkflowRecord[],
  sourceUrl: string,
): Record<string, unknown> {
  const ordered = [...records].sort((left, right) =>
    `${left.code}:${left.name}:${left.recordId}`.localeCompare(
      `${right.code}:${right.name}:${right.recordId}`,
      'zh-CN',
    ),
  );
  const totalAmount = ordered.reduce((sum, record) => sum + record.amount, 0);
  const rows = ordered
    .slice(0, 20)
    .map(
      (record, index) =>
        `**${index + 1}. ${escapeCardMarkdown(record.name || record.code || '付款计划')}**\n${escapeCardMarkdown(record.code || '合同编号待补充')}　｜　${escapeCardMarkdown(record.ownerNames.join('、') || '跟进人待补充')}　｜　**${escapeCardMarkdown(formatMoney(record.amount))}**`,
    );
  if (ordered.length > rows.length) {
    rows.push(`另有 ${ordered.length - rows.length} 项，请进入多维表查看。`);
  }
  return {
    schema: '2.0',
    config: { wide_screen_mode: true, enable_forward: false },
    header: {
      template: 'orange',
      title: {
        tag: 'plain_text',
        content: `明日付款提醒 · ${ordered.length}项`,
      },
    },
    body: {
      direction: 'vertical',
      padding: '12px',
      vertical_spacing: '8px',
      elements: [
        {
          tag: 'markdown',
          content: `**计划付款日期　${escapeCardMarkdown(ordered[0]?.endDate || '待补充')}**\n共 **${ordered.length}** 项　｜　合计 **${escapeCardMarkdown(formatMoney(totalAmount))}**`,
        },
        { tag: 'hr' },
        { tag: 'markdown', content: rows.join('\n\n') },
        {
          tag: 'button',
          type: 'primary',
          width: 'fill',
          text: { tag: 'plain_text', content: '查看合同与采购管理' },
          behaviors: [
            {
              type: 'open_url',
              default_url: paymentDetailUrl(sourceUrl, ''),
            },
          ],
        },
      ],
    },
  };
}

function buildContractCard(input: {
  title: string;
  template: 'blue' | 'green' | 'red' | 'orange';
  fields: string[][];
  detailUrl: string;
  selfTest?: boolean;
}): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: input.template,
      title: { tag: 'plain_text', content: input.title },
    },
    elements: [
      ...(input.selfTest
        ? [
            {
              tag: 'note',
              elements: [
                {
                  tag: 'plain_text',
                  content: '自测通知：对应测试数据将在验证完成后自动清理。',
                },
              ],
            },
          ]
        : []),
      {
        tag: 'div',
        fields: input.fields.map(([label = '', value = '']) => ({
          is_short: false,
          text: {
            tag: 'lark_md',
            content: `**${escapeCardText(label)}**\n${escapeCardText(value)}`,
          },
        })),
      },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            type: 'primary',
            text: { tag: 'plain_text', content: '查看合同详情' },
            url: input.detailUrl,
          },
        ],
      },
    ],
  };
}

function escapeCardText(value: string): string {
  return value.replace(/[\\`*_{}\[\]<>()#+.!|-]/g, '\\$&');
}

function buildContractCreatedMessage(
  input: ContractCreatedNotificationInput,
  sourceUrl: string,
): string {
  const kindLabel = input.kind === 'framework' ? '框架合同' : '执行合同';
  return [
    ...(input.selfTest ? ['【Codex 自测：数据核验后自动清理】'] : []),
    `【新增${kindLabel}已登记】`,
    `合同名称：${input.name || '待补充'}`,
    `合同编号：${input.code || '待补充'}`,
    ...(input.kind === 'execution'
      ? [
          `供应商：${input.supplier || '待补充'}`,
          `跟进人：${input.ownerNames.join('、') || '待补充'}`,
          `专业类别：${input.specialty || '待补充'}`,
          `合同金额：${formatMoney(input.amount)}`,
        ]
      : []),
    `合同周期：${input.startDate || '待补充'} 至 ${input.endDate || '待补充'}`,
    `查看详情：${createdContractDetailUrl(sourceUrl, input)}`,
  ].join('\n');
}

function buildPaymentFollowUpMessage(
  input: ContractPaymentFollowUpNotificationInput,
  sourceUrl: string,
): string {
  const action =
    input.action === 'create'
      ? '新增付款计划'
      : input.action === 'adjust'
        ? '调整付款计划'
        : '付款确认';
  return [
    `【付款跟进：${action}】`,
    `合同名称：${input.contractName || '待补充'}`,
    `合同编号：${input.contractCode || '待补充'}`,
    `付款计划：${input.paymentLabel || input.period || '待补充'}`,
    `付款周期：${input.period || '待补充'}`,
    `计划金额：${formatMoney(input.plannedAmount)}`,
    `实际金额：${formatMoney(input.actualAmount)}`,
    `计划付款日期：${input.plannedPaymentDate || '待补充'}`,
    ...(input.action === 'confirm'
      ? [`付款日期：${input.paymentDate || '待补充'}`]
      : []),
    `付款状态：${input.action === 'confirm' ? '已付款' : '未付款/保持原状态'}`,
    `跟进人：${input.ownerNames.join('、') || '待补充'}`,
    `查看详情：${paymentDetailUrl(sourceUrl, input.paymentRecordId)}`,
  ].join('\n');
}

function paymentDetailUrl(sourceUrl: string, recordId: string): string {
  try {
    const url = new URL(sourceUrl);
    url.searchParams.set('table', PAYMENT_TABLE_ID);
    url.searchParams.delete('view');
    if (recordId) url.searchParams.set('record', recordId);
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

function createdContractDetailUrl(
  sourceUrl: string,
  input: Pick<ContractCreatedNotificationInput, 'kind' | 'recordId'>,
): string {
  try {
    const url = new URL(sourceUrl);
    url.searchParams.set(
      'table',
      input.kind === 'framework' ? FRAMEWORK_TABLE_ID : CONTRACT_TABLE_ID,
    );
    url.searchParams.delete('view');
    if (input.kind === 'execution') {
      url.searchParams.set('view', CONTRACT_VIEW_ID);
    }
    if (input.recordId) url.searchParams.set('record', input.recordId);
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

function contractDetailUrl(sourceUrl: string, recordId: string): string {
  try {
    const url = new URL(sourceUrl);
    url.searchParams.set('table', CONTRACT_TABLE_ID);
    url.searchParams.set('view', CONTRACT_VIEW_ID);
    if (recordId) url.searchParams.set('record', recordId);
    return url.toString();
  } catch {
    return sourceUrl;
  }
}

function buildResult(
  code: ContractWorkflowCode,
  trigger: ContractWorkflowTrigger,
  startedAt: string,
  values: Partial<ContractWorkflowRunResult>,
): ContractWorkflowRunResult {
  return {
    code,
    trigger,
    startedAt,
    completedAt: new Date().toISOString(),
    scanned: 0,
    matched: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    message: '',
    ...values,
  };
}

function workflowName(code: ContractWorkflowCode): string {
  return {
    payment_due_reminder: '付款到期提醒',
    contract_expiry_reminder: '合同到期提醒',
  }[code];
}

function linkedRecordIds(value: unknown): string[] {
  if (Array.isArray(value)) return dedupe(value.flatMap(linkedRecordIds));
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  const groupedIds = ['link_record_ids', 'record_ids'].flatMap((key) =>
    Array.isArray(item[key]) ? (item[key] as unknown[]) : [],
  );
  const directIds = ['record_id', 'recordId', 'id'].map((key) => item[key]);
  return dedupe(
    [...groupedIds, ...directIds]
      .filter((recordId): recordId is string => typeof recordId === 'string')
      .map((recordId) => recordId.trim())
      .filter(Boolean),
  );
}

function extractOpenIds(value: unknown): string[] {
  if (Array.isArray(value)) return dedupe(value.flatMap(extractOpenIds));
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  const direct = Object.values(item).filter(
    (entry): entry is string =>
      typeof entry === 'string' && /^ou_[A-Za-z0-9]+$/.test(entry),
  );
  return dedupe([...direct, ...Object.values(item).flatMap(extractOpenIds)]);
}

function extractNames(value: unknown): string[] {
  if (Array.isArray(value)) return dedupe(value.flatMap(extractNames));
  if (!value || typeof value !== 'object') return [];
  const item = value as Record<string, unknown>;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  return dedupe([name, ...Object.values(item).flatMap(extractNames)]);
}

function dateKey(value: unknown): string | null {
  const raw =
    typeof value === 'number' ? value : Number(extractDisplayText(value));
  const date = Number.isFinite(raw)
    ? new Date(raw)
    : new Date(extractDisplayText(value));
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function recordTimeToIso(value: unknown): string {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) return '';
  return new Date(
    numberValue < 10_000_000_000 ? numberValue * 1_000 : numberValue,
  ).toISOString();
}

function formatMoney(value: number): string {
  return new Intl.NumberFormat('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    maximumFractionDigits: 2,
  }).format(value || 0);
}

function escapeCardMarkdown(value: string): string {
  return String(value)
    .replaceAll('&', '&#38;')
    .replaceAll('<', '&#60;')
    .replaceAll('>', '&#62;')
    .replaceAll('*', '&#42;')
    .replaceAll('_', '&#95;')
    .replace(/[\r\n]/gu, ' ')
    .trim();
}

function dedupe(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 300) : '未知错误';
}

function isFeishuDataNotReady(error: unknown): boolean {
  const payload = (error as { response?: { data?: unknown } })?.response
    ?.data as { code?: unknown; msg?: unknown } | undefined;
  return (
    Number(payload?.code) === 1254607 ||
    (typeof payload?.msg === 'string' && /data not ready/i.test(payload.msg))
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
