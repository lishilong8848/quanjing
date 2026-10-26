import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PurchaseWorkflowReceiptAcceptedResponse, PurchaseWorkflowReceiptInput, PurchaseWorkflowReceiptTask, PurchaseWorkflowReceiptTaskStatusResponse } from '../../../shared/purchase-workflow.interface';
import { PurchaseWorkflowGateway, type PurchaseWorkflowUploadFile } from './purchase-workflow.gateway';
import { PurchaseWorkflowService, type PurchaseWorkflowSession } from './purchase-workflow.service';
import { PurchaseWorkflowStore, type PurchaseWorkflowNotificationEntry } from './purchase-workflow.store';
import { normalizeWebReceiptCommand, webReceiptFingerprint, webReceiptHash, webReceiptRecoveryVersion, type PurchaseWebReceiptCommand, type WebReceiptFile, type WebReceiptInput } from './purchase-web-receipt-command';
import type { PersonnelRecoveryActor, PersonnelRecoveryPreview, PersonnelRecoveryRequest, PersonnelRecoveryResult, PersonnelRecoveryTask } from '../../../shared/personnel-task-recovery.interface';
import {assertRecoveryRequest} from '../../common/access/personnel-task-recovery.validation';
import { PurchaseWebReceiptFiles } from './purchase-web-receipt-files';

type ReceiptSubmissionInput = Omit<PurchaseWorkflowReceiptInput, 'receiptPhotoTokens' | 'invoiceTokens'>;
export interface PurchaseWorkflowReceiptFiles { receiptPhotos: PurchaseWorkflowUploadFile[]; invoices: PurchaseWorkflowUploadFile[]; }
const acceptingReceipts = new Map<string, { requestKey: string; promise: Promise<PurchaseWorkflowReceiptAcceptedResponse> }>();

@Injectable()
export class PurchaseWorkflowReceiptTaskService {
  private readonly logger = new Logger(PurchaseWorkflowReceiptTaskService.name);
  private running = false;
  private readonly files: PurchaseWebReceiptFiles;

  constructor(private readonly gateway: PurchaseWorkflowGateway, private readonly workflowService: PurchaseWorkflowService, private readonly store: PurchaseWorkflowStore) {
    this.files = new PurchaseWebReceiptFiles(store.webReceiptSpoolDirectory());
  }

  async acceptReceipt(recordId: string, session: PurchaseWorkflowSession, input: ReceiptSubmissionInput, files: PurchaseWorkflowReceiptFiles): Promise<PurchaseWorkflowReceiptAcceptedResponse> {
    if (!/^rec[A-Za-z0-9_-]+$/.test(recordId)) throw new BadRequestException('采购记录标识无效');
    if (!input || typeof input.signer !== 'string' || !input.signer.trim()) throw new BadRequestException('请填写签收人');
    if (typeof input.signerOpenId !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(input.signerOpenId)) throw new BadRequestException('请选择签收人');
    if (!Number.isFinite(input.receiptTime) || input.receiptTime <= 0) throw new BadRequestException('请选择有效的签收时间');
    if (!files || !Array.isArray(files.receiptPhotos) || !files.receiptPhotos.length || !Array.isArray(files.invoices)) throw new BadRequestException('请上传签收照片');
    if (files.receiptPhotos.length + files.invoices.length > 20) throw new BadRequestException('签收附件最多20个');
    if (typeof input.note !== 'string' || input.note.length > 10_000 || input.signer.length > 200 || input.clientMutationId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(input.clientMutationId)) throw new BadRequestException('签收提交内容无效');
    const ownerId = owner(session), appId = process.env.FEISHU_APP_ID?.trim() || '';
    const receipt: WebReceiptInput = { signer: input.signer?.trim(), signerOpenId: input.signerOpenId?.trim(), receiptTime: input.receiptTime, note: input.note || '' };
    const metadata: WebReceiptFile[] = [];
    const uploads: PurchaseWorkflowUploadFile[] = [];
    for (const group of ['receiptPhotos', 'invoices'] as const) {
      for (const file of files[group]) {
        if (!Buffer.isBuffer(file.buffer) || file.size !== file.buffer.length || file.size < 1 || file.size > 20 * 1024 * 1024) throw new BadRequestException('签收附件内容无效或超过20MB');
        uploads.push(file);
        metadata.push({ group, name: file.originalname, mime: file.mimetype, size: file.size, sha256: createHash('sha256').update(file.buffer).digest('hex'), token: '', uploadStartedAt: '' });
      }
    }
    const mutationId = input.clientMutationId || webReceiptHash([recordId, ownerId, receipt, metadata]);
    const taskId = `purchase-receipt-${webReceiptHash([appId, ownerId, mutationId])}`;
    const requestKey = webReceiptHash([taskId, recordId, receipt, metadata]);
    const acceptanceKey = `${this.store.webReceiptSpoolDirectory()}:${taskId}`;
    const existingRequest = acceptingReceipts.get(acceptanceKey);
    if (existingRequest) {
      if (existingRequest.requestKey !== requestKey) throw new ConflictException('同一签收提交标识正在处理其他内容');
      return existingRequest.promise;
    }
    const request = this.accept(recordId, session, { taskId, ownerId, appId, mutationId, receipt, metadata }, uploads);
    acceptingReceipts.set(acceptanceKey, { requestKey, promise: request });
    try { return await request; } finally { if (acceptingReceipts.get(acceptanceKey)?.promise === request) acceptingReceipts.delete(acceptanceKey); }
  }

  private async accept(recordId: string, session: PurchaseWorkflowSession, submission: { taskId: string; ownerId: string; appId: string; mutationId: string; receipt: WebReceiptInput; metadata: WebReceiptFile[] }, uploads: PurchaseWorkflowUploadFile[]): Promise<PurchaseWorkflowReceiptAcceptedResponse> {
    const existing = await this.store.findWebReceipt(submission.taskId);
    if (existing?.webReceipt) {
      const saved = existing.webReceipt;
      const replay = { ...saved, input: submission.receipt, files: submission.metadata };
      if (existing.recordId !== recordId || saved.ownerId !== submission.ownerId || webReceiptFingerprint(replay) !== saved.fingerprint) throw new ConflictException('签收提交标识已用于其他内容');
      return accepted(existing);
    }
    const prepared = await this.workflowService.prepareReceiptSubmission(recordId, session, submission.receipt, submission.metadata.some(file => file.group === 'invoices'));
    if (prepared.appId !== submission.appId || prepared.actor.openId !== session.openId) throw new ConflictException('签收应用或办理人身份已变化，请重新核对');
    const { openId, name, positions, buildings, accessRole } = prepared.actor;
    const payload: PurchaseWebReceiptCommand = {
      recordId,
      taskId: submission.taskId, ownerId: submission.ownerId, appId: submission.appId, mutationId: submission.mutationId,
      fingerprint: '', actor: { openId, name, positions: [...positions], buildings: [...buildings], ...(accessRole ? { accessRole } : {}) },
      scope: prepared.scope, input: submission.receipt, files: submission.metadata, notificationWarnings: [], filesRemoved: false,
    };
    payload.fingerprint = webReceiptFingerprint(payload);
    normalizeWebReceiptCommand(payload);
    let task: PurchaseWorkflowNotificationEntry;
    try {
      await this.files.save(payload, uploads);
      task = await this.store.acceptWebReceipt(recordId, payload, () => this.workflowService.assertReceiptSubmissionCurrent(prepared, session));
    } catch (error) {
      if (!await this.store.findWebReceipt(payload.taskId)) {
        try { await this.files.remove(payload); } catch { this.logger.warn(`未受理签收附件待清理: ${payload.taskId}`); }
      }
      throw error;
    }
    setImmediate(() => { void this.runPendingTasks().catch(error => this.logger.error('签收后台任务执行失败', error)); });
    return accepted(task);
  }

  async getReceiptTaskStatus(taskId: string, session: PurchaseWorkflowSession): Promise<PurchaseWorkflowReceiptTaskStatusResponse> {
    if (!/^purchase-receipt-[a-f0-9]{64}$/.test(taskId)) return { success: false, message: '签收后台任务不存在或已过期' };
    const task = await this.store.findWebReceipt(taskId), payload = task?.webReceipt;
    if (!task || !payload || payload.appId !== process.env.FEISHU_APP_ID?.trim() || (payload.ownerId !== owner(session) && session.accessRole !== 'admin')) return { success: false, message: '签收后台任务不存在或已过期' };
    this.workflowService.assertReceiptTaskReadable(payload.scope, session);
    return { success: true, task: publicTask(task) };
  }

  async listRecoveryTasks():Promise<PersonnelRecoveryTask[]>{
    return(await this.store.listNotifications({kind:'web_receipt_command'})).filter(task=>task.status==='failed'||!!task.webReceipt?.recoveries?.length).map(task=>({module:'purchase',id:task.webReceipt!.taskId,recordId:task.recordId,title:'采购到货签收',actorName:task.webReceipt!.actor.name,createdAt:task.createdAt,status:publicTask(task).status,message:publicTask(task).message,version:webReceiptRecoveryVersion(task),actionLabel:'恢复签收',available:task.webReceipt!.appId===process.env.FEISHU_APP_ID?.trim(),hint:'仅补传未确认附件，保留已完成步骤。未收到回执的上传可能留有未关联文件。'}));
  }

  async previewRecoveryTask(input: PersonnelRecoveryRequest): Promise<PersonnelRecoveryPreview> {
    assertRecoveryRequest(input);
    const original = await this.store.findWebReceipt(input.taskId);
    if (input.module !== 'purchase' || !original?.webReceipt || original.webReceipt.appId !== process.env.FEISHU_APP_ID?.trim()) throw new ConflictException('原签收任务或应用身份已变化');
    const task = (await this.listRecoveryTasks()).find(task => task.id === input.taskId);
    if (!task) throw new ConflictException('原签收任务无需恢复，请核对进度');
    return { task, version: webReceiptRecoveryVersion(original),
      facts: original.webReceipt.files.map(file => ({ label: file.group === 'invoices' ? '发票' : '签收照片', value: `${file.name} · ${file.token ? '上传已确认' : file.uploadStartedAt ? '上传结果待核对' : '待上传'}` })),
      choices: [], canConfirm: task.available && original.status === 'failed',
      ...(original.status === 'failed' ? {} : { message: task.message }),
      acknowledgement: '我已核对附件，允许补传尚未确认的文件；已确认的文件保留' };
  }

  async recoverTask(input:PersonnelRecoveryRequest,actor:PersonnelRecoveryActor,authorize:()=>void):Promise<PersonnelRecoveryResult>{
    assertRecoveryRequest(input);authorize();
    if (input.selections?.length) throw new BadRequestException('签收恢复不接受付款计划选择');
    const original=await this.store.findWebReceipt(input.taskId);
    if(!original?.webReceipt||original.webReceipt.appId!==process.env.FEISHU_APP_ID?.trim())throw new ConflictException('原签收任务或应用身份已变化');
    if(original.status==='failed')for(let index=0;index<original.webReceipt.files.length;index++)if(!original.webReceipt.files[index].token)await this.files.read(original.webReceipt,index);
    const task=await this.store.recoverWebReceipt(input,actor,authorize);
    if(task.status==='completed')return{status:'completed',message:'原签收任务已完成'};
    setImmediate(()=>{void this.runPendingTasks().catch(error=>this.logger.error('签收恢复未完成',error));});
    return{status:'pending',message:'原签收任务已受理恢复，正在后台处理'};
  }

  async runPendingTasks(now: Date | number = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const task of await this.store.listNotifications({ kind: 'web_receipt_command', status: 'completed' })) {
        if (task.webReceipt && !task.webReceipt.filesRemoved) await this.cleanup(task.webReceipt);
      }
      for (let index = 0; index < 10; index++) {
        const task = await this.store.takeNextNotification(now, 10 * 60_000, ['web_receipt_command']);
        if (!task) break;
        await this.executeTask(task);
      }
    } finally { this.running = false; }
  }

  private async executeTask(task: PurchaseWorkflowNotificationEntry): Promise<void> {
    const payload = normalizeWebReceiptCommand(task.webReceipt);
    try {
      if (payload.appId !== process.env.FEISHU_APP_ID?.trim()) throw new ConflictException('签收任务所属应用已变化，请核对原任务');
      const token = await this.gateway.getTenantAccessTokenAsApp();
      for (let index = 0; index < payload.files.length; index++) {
        const metadata = payload.files[index];
        if (metadata.token) continue;
        if (metadata.uploadStartedAt) throw new ConflictException('附件上传结果待核对，请联系管理员恢复原签收任务');
        const file = await this.files.read(payload, index);
        await this.store.updateWebReceipt(task.key, task.claimToken, saved => { saved.files[index].uploadStartedAt = new Date().toISOString(); });
        const fileToken = await this.gateway.uploadAttachment(file, token);
        await this.store.updateWebReceipt(task.key, task.claimToken, saved => { saved.files[index].token = fileToken; });
        metadata.token = fileToken;
      }
      const result = await this.workflowService.receiveAcceptedReceipt({ notificationKey: task.key, claimToken: task.claimToken });
      await this.store.updateWebReceipt(task.key, task.claimToken, saved => { saved.notificationWarnings = result.notificationWarnings.slice(0, 20).map(text => text.slice(0, 1000)); });
      await this.store.completeNotification(task.key, task.claimToken);
      await this.cleanup(payload);
    } catch (error) {
      if (task.attempts < 3 && !(error instanceof BadRequestException || error instanceof ConflictException || error instanceof ForbiddenException)) await this.store.rescheduleNotification(task.key, task.claimToken, '签收同步暂时失败，可恢复原任务', Date.now() + 1000);
      else await this.store.failNotification(task.key, task.claimToken, error instanceof ConflictException || error instanceof BadRequestException || error instanceof ForbiddenException ? error.message : '签收同步失败，请恢复原任务');
    }
  }

  private async cleanup(payload: PurchaseWebReceiptCommand): Promise<void> {
    try { await this.files.remove(payload); await this.store.markWebReceiptFilesRemoved(payload.taskId); }
    catch { this.logger.warn(`签收附件待清理: ${payload.taskId}`); }
  }
}

function owner(session: PurchaseWorkflowSession): string {
  const id = session.permissionPrincipal?.accountId || (!session.accessRole ? session.openId : '');
  if (!/^[A-Za-z0-9:_-]{1,180}$/.test(id)) throw new ForbiddenException('当前登录身份无法创建或查询签收任务');
  return id;
}
function accepted(task: PurchaseWorkflowNotificationEntry): PurchaseWorkflowReceiptAcceptedResponse {
  return { pending: true, taskId: task.webReceipt!.taskId, message: publicTask(task).message };
}
function publicTask(task: PurchaseWorkflowNotificationEntry): PurchaseWorkflowReceiptTask {
  return { id: task.webReceipt!.taskId, recordId: task.recordId, status: task.status === 'completed' ? 'completed' : task.status === 'failed' || task.status === 'manual_reconciliation' ? 'failed' : task.status === 'processing' ? 'running' : 'pending', createdAt: task.createdAt, ...(task.completedAt ? { completedAt: task.completedAt } : {}), notificationWarnings: [...task.webReceipt!.notificationWarnings], message: task.status === 'completed' ? '到货签收已完成' : task.status === 'failed' || task.status === 'manual_reconciliation' ? task.lastError || '签收同步待处理，请联系管理员' : '到货签收已受理，正在后台同步' };
}
