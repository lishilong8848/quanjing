import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  PurchaseOnlineApprovalAcceptedResponse,
  PurchaseOnlineApprovalDecision,
  PurchaseOnlineApprovalRequest,
  PurchaseOnlineApprovalResponse,
  PurchaseOnlineApprovalTask,
  PurchaseOnlineApprovalTaskStatusResponse,
} from '../../../shared/purchase-inventory.interface';
import type { PurchaseWorkflowMethod } from '../../../shared/purchase-workflow.interface';
import { PurchaseWorkflowGateway } from './purchase-workflow.gateway';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { businessAuthorizationIdentityKey } from '../../../shared/business-permissions';
import { PurchaseWorkflowService, type PurchaseWebApprovalAuthority, type PurchaseWorkflowSession } from './purchase-workflow.service';

const RECORD_ID_PATTERN = /^rec[A-Za-z0-9_-]+$/;
const PURCHASE_METHOD_FIELD = '1️⃣物品采购方式';
const WORKFLOW_STATUS_FIELD = '采购流程';
const MAX_RETAINED_TASKS = 200;
const MAX_SYNC_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 1_000] as const;
const APPROVED_METHODS = new Set<PurchaseWorkflowMethod>([
  '综合采购',
  '需求自采',
  '需求自采（楼内）',
]);

@Injectable()
export class PurchaseOnlineApprovalService {
  private readonly logger = new Logger(PurchaseOnlineApprovalService.name);
  private readonly recordDecisionTails = new Map<string, Promise<void>>();
  private readonly decisionTasks = new Map<string, PurchaseOnlineApprovalTask>();
  private readonly taskBuildingScopes = new Map<string, string>();
  private readonly taskAuthorities = new Map<string, PurchaseWebApprovalAuthority>();

  constructor(private readonly gateway: PurchaseWorkflowGateway, @Optional() private readonly workflow?: PurchaseWorkflowService) {}

  async acceptAuthorizedDecision(recordIdValue: string, input: PurchaseOnlineApprovalRequest, session: PurchaseWorkflowSession): Promise<PurchaseOnlineApprovalAcceptedResponse> {
    const recordId = normalizeRecordId(recordIdValue), decision = normalizeDecision(input?.decision);
    if (!this.workflow || !session.permissionPrincipal?.accountId) throw new ForbiddenException('采购审批登录身份不可用');
    const prior = [...this.decisionTasks.values()].reverse().find(task => task.recordId === recordId && ['pending', 'running', 'completed'].includes(task.status));
    if (prior) {
      this.assertTaskOwner(prior.id, session.permissionPrincipal, session.openId);
      if (prior.decision !== decision) throw new ConflictException('该采购申请已有相反审批决定');
      return accepted(prior);
    }
    const authority = await this.workflow.prepareWebApprovalAuthority(recordId, session);
    return this.acceptDecision(recordId, input, authority.scope.building, authority);
  }

  getAuthorizedDecisionTaskStatus(taskId: string, principal: AccessPrincipal): PurchaseOnlineApprovalTaskStatusResponse {
    const normalized = clean(taskId);
    this.assertTaskOwner(normalized, principal);
    return this.getDecisionTaskStatus(normalized);
  }

  private assertTaskOwner(taskId: string, principal: AccessPrincipal, actorOpenId?: string): void {
    const authority = this.taskAuthorities.get(taskId);
    if (!authority || !principal.accountId || businessAuthorizationIdentityKey(authority.principal) !== businessAuthorizationIdentityKey(principal) ||
      actorOpenId !== undefined && actorOpenId !== authority.actorOpenId) throw new ForbiddenException('审批后台任务不存在或无权访问');
  }

  acceptDecision(
    recordIdValue: string,
    input: PurchaseOnlineApprovalRequest,
    requiredBuilding?: string,
    authority?: PurchaseWebApprovalAuthority,
  ): PurchaseOnlineApprovalAcceptedResponse {
    const recordId = normalizeRecordId(recordIdValue);
    const decision = normalizeDecision(input?.decision);
    const activeTask = [...this.decisionTasks.values()].find(
      (task) =>
        task.recordId === recordId &&
        (task.status === 'pending' || task.status === 'running'),
    );
    if (activeTask) {
      if (authority) this.assertTaskOwner(activeTask.id, authority.principal, authority.actorOpenId);
      if (activeTask.decision !== decision) {
        throw new ConflictException('该采购申请已有相反审批决定正在同步');
      }
      return accepted(activeTask);
    }

    const task: PurchaseOnlineApprovalTask = {
      id: `purchase-approval-${randomUUID()}`,
      recordId,
      decision,
      status: 'pending',
      message: '审批操作已受理，正在后台同步飞书多维表',
      createdAt: new Date().toISOString(),
    };
    this.decisionTasks.set(task.id, task);
    if (authority) this.taskAuthorities.set(task.id, structuredClone(authority));
    if (requiredBuilding) this.taskBuildingScopes.set(task.id, requiredBuilding);
    this.pruneDecisionTasks();
    setImmediate(() => void this.executeDecisionTask(task.id));
    return accepted(task);
  }

  getDecisionTaskStatus(
    taskIdValue: string,
  ): PurchaseOnlineApprovalTaskStatusResponse {
    const task = this.decisionTasks.get(clean(taskIdValue));
    if (!task) {
      return {
        success: false,
        message: '审批后台任务不存在或已过期',
      };
    }
    return { success: true, task: cloneTask(task) };
  }

  async decide(
    recordIdValue: string,
    input: PurchaseOnlineApprovalRequest,
    requiredBuilding?: string,
    authority?: PurchaseWebApprovalAuthority,
  ): Promise<PurchaseOnlineApprovalResponse> {
    const startedAt = Date.now();
    const recordId = normalizeRecordId(recordIdValue);
    const decision = normalizeDecision(input?.decision);
    return this.runSerialized(recordId, () =>
      this.decideCurrentRecord(recordId, decision, startedAt, requiredBuilding, authority),
    );
  }

  private async decideCurrentRecord(
    recordId: string,
    decision: PurchaseOnlineApprovalDecision,
    startedAt: number,
    requiredBuilding?: string,
    authority?: PurchaseWebApprovalAuthority,
  ): Promise<PurchaseOnlineApprovalResponse> {
    const record = await this.gateway.getExecutionRecordAsApp(recordId);
    if (requiredBuilding && record.building !== requiredBuilding) {
      throw new ForbiddenException('无权审批其他楼栋采购记录');
    }
    const currentDecision = resolveCompletedDecision(
      record.status,
      record.approvalCompleted,
      record.purchaseMethod,
    );

    if (currentDecision) {
      if (currentDecision !== decision) {
        throw new ConflictException('该采购申请已完成相反的审批决定，不能覆盖');
      }
      return result(recordId, decision, true, startedAt);
    }

    if (decision === 'approved' && record.purchaseMethod === '驳回') {
      throw new ConflictException('该采购申请已标记为驳回，不能改为审批通过');
    }

    const purchaseMethod =
      decision === 'rejected'
        ? '驳回'
        : normalizeApprovedMethod(record.purchaseMethod);
    const fields: Record<string, unknown> = {
      [PURCHASE_METHOD_FIELD]: purchaseMethod,
      [WORKFLOW_STATUS_FIELD]:
        decision === 'rejected' ? '驳回申请' : '审批通过（待下单）',
    };
    // Recheck after acquiring the record queue and reading the current record,
    // immediately before the first write. A completed matching result above is
    // a read-only reconciliation of this already accepted command.
    if (authority) {
      if (!this.workflow) throw new ForbiddenException('采购审批当前授权端口未配置');
      this.workflow.assertWebApprovalAuthority(authority, record);
    }
    await this.gateway.updateExecutionRecordAsApp(recordId, fields);

    return result(recordId, decision, false, startedAt);
  }

  private async runSerialized<T>(
    recordId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previousTail =
      this.recordDecisionTails.get(recordId) ?? Promise.resolve();
    let release = () => undefined;
    const currentLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const nextTail = previousTail
      .catch(() => undefined)
      .then(() => currentLock);
    this.recordDecisionTails.set(recordId, nextTail);

    await previousTail.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.recordDecisionTails.get(recordId) === nextTail) {
        this.recordDecisionTails.delete(recordId);
      }
    }
  }

  private async executeDecisionTask(taskId: string): Promise<void> {
    const task = this.decisionTasks.get(taskId);
    if (!task) return;
    task.status = 'running';
    task.message = '审批操作正在后台同步飞书多维表';

    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
      try {
        task.result = await this.decide(task.recordId, {
          decision: task.decision,
        }, this.taskBuildingScopes.get(task.id), this.taskAuthorities.get(task.id));
        task.status = 'completed';
        task.message = `采购申请${task.result.resultLabel}`;
        task.completedAt = new Date().toISOString();
        return;
      } catch (error) {
        if (attempt < MAX_SYNC_ATTEMPTS && isRetryable(error)) {
          task.message = `飞书同步暂时失败，正在进行第 ${attempt + 1} 次尝试`;
          await delay(RETRY_DELAYS_MS[attempt - 1] ?? 1_000);
          continue;
        }
        task.status = 'failed';
        task.message = approvalErrorMessage(error);
        task.completedAt = new Date().toISOString();
        this.logger.error(
          `采购审批后台同步失败: task=${task.id}, record=${task.recordId}, message=${task.message}`,
        );
        return;
      }
    }
  }

  private pruneDecisionTasks(): void {
    if (this.decisionTasks.size <= MAX_RETAINED_TASKS) return;
    for (const [taskId, task] of this.decisionTasks) {
      if (task.status === 'pending' || task.status === 'running') continue;
      this.decisionTasks.delete(taskId);
      this.taskBuildingScopes.delete(taskId);
      this.taskAuthorities.delete(taskId);
      if (this.decisionTasks.size <= MAX_RETAINED_TASKS) return;
    }
  }
}

function accepted(
  task: PurchaseOnlineApprovalTask,
): PurchaseOnlineApprovalAcceptedResponse {
  return {
    pending: true,
    taskId: task.id,
    message: task.message,
  };
}

function cloneTask(task: PurchaseOnlineApprovalTask): PurchaseOnlineApprovalTask {
  return {
    ...task,
    ...(task.result ? { result: { ...task.result } } : {}),
  };
}

function isRetryable(error: unknown): boolean {
  return !(error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException);
}

function approvalErrorMessage(error: unknown): string {
  const message =
    error instanceof Error && error.message.trim()
      ? error.message.trim()
      : '未知错误';
  return `审批同步飞书多维表失败：${message}`;
}

function delay(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function normalizeRecordId(value: unknown): string {
  const recordId = clean(value);
  if (!RECORD_ID_PATTERN.test(recordId)) {
    throw new BadRequestException('采购进行表记录 ID 格式错误');
  }
  return recordId;
}

function normalizeDecision(value: unknown): PurchaseOnlineApprovalDecision {
  if (value !== 'approved' && value !== 'rejected') {
    throw new BadRequestException('请选择有效的审批结果');
  }
  return value;
}

function normalizeApprovedMethod(
  value: PurchaseWorkflowMethod,
): PurchaseWorkflowMethod {
  if (!APPROVED_METHODS.has(value)) {
    throw new BadRequestException('采购申请未填写有效的采购方式，无法审批通过');
  }
  return value;
}

function resolveCompletedDecision(
  status: string,
  approvalCompleted: boolean,
  purchaseMethod: PurchaseWorkflowMethod,
): PurchaseOnlineApprovalDecision | null {
  if (status === '驳回申请' || status === '已终止') return 'rejected';
  if (
    status === '审批通过（待库房确认）' ||
    status === '审批通过（待下单）' ||
    status === '库房确认（待下单）' ||
    status === '下单完成（待签收）' ||
    status === '到货已签收（待入库）' ||
    status === '物品签收（待入库）' ||
    status === '物品签收已入库' ||
    status === '采购完成（已入库）'
  ) {
    return 'approved';
  }
  if (!approvalCompleted) return null;
  return purchaseMethod === '驳回' ? 'rejected' : 'approved';
}

function result(
  recordId: string,
  decision: PurchaseOnlineApprovalDecision,
  idempotent: boolean,
  startedAt: number,
): PurchaseOnlineApprovalResponse {
  return {
    recordId,
    decision,
    resultLabel: decision === 'approved' ? '审批通过' : '已驳回',
    idempotent,
    durationMs: Date.now() - startedAt,
  };
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
