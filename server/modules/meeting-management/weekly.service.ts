import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { join } from 'node:path';
import type {
  GenerateWeeklyReport,
  SaveWeeklyMeeting,
  WeeklyWorkspace,
  EditMeetingAction,
  PreparedActionEdit,
  WeeklyAttachmentCommand,
} from '../../../shared/weekly-workspace.interface';
import {
  validWeeklyDate,
  validateWeeklyMeeting,
  weeklyPeriod,
  WEEKLY_TODO_FIELDS,
  weeklyTodoText,
  weeklyTodosEmpty,
  WEEKLY_EMPTY_TODOS_MESSAGE,
  nextMonthWeeklyPeriods,
} from '../../../shared/weekly-workspace.rules';
import { MeetingService } from './meeting.service';
import { mapWeeklyMeeting, summarizeMeeting } from './meeting.mapper';
import { WeeklyGateway } from './weekly.gateway';
import { WeeklyEngine, WeeklyEngineError } from './weekly.engine';
import {
  acquireWeeklyLock,
  canNotifyWeeklyReport,
  WeeklyReceipt,
  WeeklyStore,
} from './weekly.store';
import { prepareActionEdit, validateActionEdit } from './meeting.action-edit';
import {
  acceptWeeklyImages,
  syncWeeklyImages,
  cleanupWeeklyImages,
} from './weekly.attachments';

@Injectable()
export class WeeklyService implements OnModuleInit, OnModuleDestroy {
  readonly store = new WeeklyStore(
    join(
      process.env.WEEKLY_WORKSPACE_DIR ||
        join(
          process.env.FEISHU_LOCAL_CACHE_DIR || join(process.cwd(), '.cache'),
          'weekly-workspace',
        ),
      'ledger.json',
    ),
  );
  private timer?: ReturnType<typeof setInterval>;
  private working = false;
  private peopleCache: WeeklyWorkspace['people'] = [];
  private peopleError: string | null = null;
  private peopleLoaded = 0;
  private loadingPeople: Promise<void> | null = null;
  private readonly logger = new Logger(WeeklyService.name);
  private scheduleMessage: string | null = null;
  private creationScheduleMessage: string | null = null;
  private documentEditors(): string[] {
    const configured = (process.env.NANTONG_WEEKLY_EDITOR_OPEN_IDS || '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    // This confirmed user mapping is only valid for the application named in AGENTS.md.
    const defaults =
      (process.env.FEISHU_APP_ID || process.env.LARK_APP_ID) ===
      'cli_a9d1c9fe9d381cee'
        ? ['ou_a6644e62a43b916c6bc26148cf74f208']
        : [];
    const editors = configured.length ? configured : defaults;
    if (
      !editors.length ||
      editors.some((id) => !/^ou_[A-Za-z0-9]{10,100}$/.test(id))
    )
      throw new BadRequestException('请配置当前飞书应用下的周报编辑人员');
    return editors;
  }
  constructor(
    private readonly gateway: WeeklyGateway,
    private readonly engine: WeeklyEngine,
    private readonly meetings: MeetingService,
  ) {}
  onModuleInit() {
    this.meetings.setOwnerLookup?.(() => this.store.actionOwners());
    this.meetings.setDocumentPeopleLookup?.(async () => {
      await this.people();
      return this.peopleCache;
    });
    void this.engine.check();
    this.timer = setInterval(() => void this.tick(), 15000);
    this.timer.unref();
    void this.tick();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  private people() {
    if (!this.loadingPeople && this.peopleLoaded + 300000 < Date.now())
      this.loadingPeople = this.gateway
        .people()
        .then((data) => {
          this.peopleCache = data;
          this.peopleError = null;
          this.peopleLoaded = Date.now();
        })
        .catch(() => {
          this.peopleError = '人员列表暂时不可用，已有责任人保留；稍后重试';
          this.peopleLoaded = Date.now() - 240000;
        })
        .finally(() => {
          this.loadingPeople = null;
        });
    return this.loadingPeople;
  }
  async snapshot(recheck = false): Promise<WeeklyWorkspace> {
    if (recheck) this.engine.requestCheck();
    if (!this.peopleLoaded) await this.people();
    else void this.people();
    return {
      ...this.store.list(),
      people: this.peopleCache,
      peopleError: this.peopleError,
      writeAccess: { enabled: true, message: null },
      runtime: this.engine.status(),
      schedule: {
        enabled: process.env.NANTONG_WEEKLY_SCHEDULE_ENABLED === 'true',
        time: '08:30',
        weekday: 4,
        timezone: 'Asia/Shanghai',
        message: this.scheduleMessage,
      },
      creationSchedule: {
        enabled: process.env.NANTONG_WEEKLY_PRECREATE_ENABLED === 'true',
        time: '02:00',
        timezone: 'Asia/Shanghai',
        message: this.creationScheduleMessage,
      },
    };
  }
  async save(command: SaveWeeklyMeeting, actor: string) {
    const error = validateWeeklyMeeting(command?.meeting);
    if (error) throw new BadRequestException(error);
    if (
      !Number.isSafeInteger(command.expectedVersion) ||
      command.expectedVersion < 0 ||
      typeof command.expectedText !== 'string' ||
      command.expectedText.length > 100000
    )
      throw new BadRequestException('会议版本或原文无效');
    const meeting = command.meeting;
    const existingMeeting = this.store
      .list()
      .meetings.find(
        (entry) =>
          entry.targetRecordId === meeting.targetRecordId &&
          entry.kind === meeting.kind,
      );
    const normalized: SaveWeeklyMeeting = {
      clientMutationId: command.clientMutationId,
      expectedVersion: command.expectedVersion,
      expectedText: command.expectedText,
      ...(command.todoOnly === true ? { todoOnly: true } : {}),
      meeting: {
        targetRecordId: meeting.targetRecordId,
        kind: meeting.kind,
        plannedDate: meeting.plannedDate,
        actualDate: ['planned', 'cancelled'].includes(meeting.status)
          ? ''
          : meeting.actualDate,
        status: meeting.status,
        note: meeting.note,
        ...(meeting.rawText !== undefined ? { rawText: meeting.rawText } : {}),
        todos: meeting.todos.map((todo) => ({
          id: todo.id,
          content: todo.content,
          ownerOpenId: todo.ownerOpenId,
          ownerName: todo.ownerName,
          dueDate: todo.dueDate,
          status: todo.status,
        })),
      },
    };
    if (command.todoOnly === true && existingMeeting)
      Object.assign(normalized.meeting, {
        plannedDate: existingMeeting.plannedDate,
        actualDate: existingMeeting.actualDate,
        status: existingMeeting.status,
        note: existingMeeting.note,
      });
    const replay = this.store.replay('meeting', normalized, actor);
    if (replay) return replay;
    await this.people();
    const previous = this.store
      .list()
      .meetings.find(
        (entry) =>
          entry.targetRecordId === meeting.targetRecordId &&
          entry.kind === meeting.kind,
      );
    for (const todo of meeting.todos)
      if (
        todo.ownerOpenId &&
        !this.peopleCache.some(
          (p) => p.openId === todo.ownerOpenId && p.name === todo.ownerName,
        ) &&
        !(
          this.peopleError &&
          previous?.todos.some(
            (old) =>
              old.ownerOpenId === todo.ownerOpenId &&
              old.ownerName === todo.ownerName,
          )
        )
      )
        throw new BadRequestException('责任人不在当前人员列表，请重新选择');
    await this.meetings.detail(meeting.targetRecordId, false);
    const job = this.store.accept('meeting', normalized, actor);
    setImmediate(() => void this.tick());
    return job;
  }
  async generate(command: GenerateWeeklyReport, actor: string) {
    if (
      !command ||
      !(
        command.targetRecordId === 'new' ||
        /^rec[A-Za-z0-9]{1,100}$/.test(command.targetRecordId)
      ) ||
      !validWeeklyDate(command.startDate) ||
      !validWeeklyDate(command.endDate) ||
      command.startDate > command.endDate
    )
      throw new BadRequestException('周报记录或起止日期无效');
    if (
      (new Date(command.endDate).getTime() -
        new Date(command.startDate).getTime()) /
        86400000 >
      366
    )
      throw new BadRequestException('生成周期不能超过一年');
    const normalized: GenerateWeeklyReport = {
      clientMutationId: command.clientMutationId,
      targetRecordId: command.targetRecordId,
      startDate: command.startDate,
      endDate: command.endDate,
      expectedDocumentUrl: command.expectedDocumentUrl,
      createOnly: command.createOnly === true,
      ...(command.confirmedNoTodos === true ? { confirmedNoTodos: true } : {}),
    };
    const replay = this.store.replay('generate', normalized, actor);
    if (replay) return replay;
    if (!normalized.createOnly && command.targetRecordId === 'new')
      throw new BadRequestException(
        '生成周报请先选择已有条目；新建条目使用独立按钮',
      );
    const { meeting } =
      command.targetRecordId === 'new'
        ? {
            meeting: { date: command.endDate, documentUrl: null, sections: [] },
          }
        : await this.formRecord(command.targetRecordId);
    if (meeting.date !== command.endDate)
      throw new BadRequestException(
        '结束日期须与所选周报日期一致，请切换目标条目',
      );
    if (command.expectedDocumentUrl !== meeting.documentUrl)
      throw new ConflictException('周报文档已变化，请重新打开');
    if (
      !normalized.createOnly &&
      weeklyTodosEmpty(meeting.sections) &&
      !normalized.confirmedNoTodos
    )
      throw new BadRequestException(WEEKLY_EMPTY_TODOS_MESSAGE);
    if (!normalized.createOnly && !this.engine.status().ready)
      throw new BadRequestException(
        this.engine.status().message || '周报引擎未就绪',
      );
    if (!normalized.createOnly && !command.expectedDocumentUrl)
      this.documentEditors();
    if (normalized.createOnly && command.targetRecordId !== 'new')
      throw new BadRequestException('新建条目不能覆盖现有记录');
    const job = this.store.accept('generate', normalized, actor);
    setImmediate(() => void this.tick());
    return job;
  }
  async editAction(input: EditMeetingAction, actor: string) {
    const command: EditMeetingAction = {
      clientMutationId: input?.clientMutationId,
      targetRecordId: input?.targetRecordId,
      actionId: input?.actionId,
      expectedContent: input?.expectedContent,
      content: input?.content,
      ...(input?.assignee
        ? {
            assignee:
              input.assignee.kind === 'unassigned'
                ? { kind: 'unassigned' }
                : input.assignee.kind === 'employee'
                  ? {
                      kind: 'employee',
                      openId: input.assignee.openId,
                      name: input.assignee.name,
                    }
                  : { kind: input.assignee.kind, name: input.assignee.name },
          }
        : {}),
    };
    const replay = this.store.actionReplay(command, actor);
    if (replay) return replay;
    validateActionEdit(command);
    const job = this.store.accept('action-edit', command, actor);
    setImmediate(() => void this.tick());
    return job;
  }
  job(id: string) {
    return this.store.get(id).job;
  }
  retryNotification(id: string, actor: string, admin = false) {
    const receipt = this.store.get(id);
    if (!admin && receipt.actor !== actor)
      throw new ConflictException('请使用提交该任务的账号重试');
    const notification = receipt.job.notification;
    if (
      !canNotifyWeeklyReport(receipt) ||
      !notification ||
      notification.status !== 'error'
    )
      throw new BadRequestException('该群提醒不能重试');
    if (
      notification.firstAttemptAt &&
      Date.now() - Date.parse(notification.firstAttemptAt) >= 45 * 60000
    )
      throw new BadRequestException(
        '发送结果超出去重窗口，请先核对群消息，不能重复发送',
      );
    const job = this.store.change(
      id,
      {},
      {
        notification: {
          ...notification,
          status: 'pending',
          attempts: 0,
          error: null,
        },
      },
    );
    setImmediate(() => void this.tick());
    return job;
  }
  attachImages(
    input: Omit<WeeklyAttachmentCommand, 'files'>,
    files: Express.Multer.File[],
    actor: string,
  ) {
    const job = acceptWeeklyImages(this.store, input, files, actor);
    setImmediate(() => void this.tick());
    return job;
  }
  async recoverImage(id: string, fileToken: string) {
    const receipt = this.store.get(id);
    const hash = receipt.attachmentState?.uploading;
    if (
      receipt.job.kind !== 'attachments' ||
      receipt.job.status !== 'uncertain' ||
      !hash ||
      typeof fileToken !== 'string' ||
      !/^[A-Za-z0-9_-]{5,200}$/.test(fileToken)
    )
      throw new BadRequestException('附件恢复参数无效');
    const command = receipt.command as WeeklyAttachmentCommand;
    const field = command.kind === 'ali' ? '阿里会议附件' : '属地周会附件';
    const files = (await this.gateway.record(command.targetRecordId))[field];
    if (
      !Array.isArray(files) ||
      !files.some(
        (file) =>
          file?.file_token === fileToken &&
          typeof file.name === 'string' &&
          file.name.startsWith(`${hash.slice(0, 12)}-`),
      )
    )
      throw new BadRequestException(
        '未在对应会议附件中找到匹配附件，请先核对并关联已上传附件',
      );
    const attachmentState = {
      ...receipt.attachmentState!,
      uploading: undefined,
      tokens: { ...receipt.attachmentState!.tokens, [hash]: fileToken },
    };
    const job = this.store.change(
      id,
      { attachmentState },
      { status: 'accepted', error: null },
    );
    setImmediate(() => void this.tick());
    return job;
  }
  async formRecord(id: string) {
    if (!/^rec[A-Za-z0-9]{1,100}$/.test(id))
      throw new BadRequestException('周报记录编号无效');
    return {
      snapshotId: 'form-read',
      meeting: mapWeeklyMeeting({
        record_id: id,
        fields: await this.gateway.record(id),
      }),
    };
  }
  retry(id: string, actor: string, admin = false) {
    const receipt = this.store.get(id);
    if (
      admin &&
      receipt.job.status === 'uncertain' &&
      receipt.job.targetRecordId === 'new' &&
      receipt.job.kind === 'generate'
    )
      return this.reconcileRow(id);
    const result = this.store.retry(
      id,
      admin ? this.store.get(id).actor : actor,
    );
    setImmediate(() => void this.tick());
    return result;
  }
  deleteTask(
    id: string,
    clientMutationId: string,
    actor: string,
    admin = false,
  ) {
    if (!admin) throw new ForbiddenException('仅管理员可删除任务');
    const job = this.store.deleteTask(id, clientMutationId, actor);
    setImmediate(() => void this.tick());
    return job;
  }
  restoreTask(
    id: string,
    clientMutationId: string,
    actor: string,
    admin = false,
  ) {
    if (!admin) throw new ForbiddenException('仅管理员可恢复任务');
    return this.store.restoreTask(id, clientMutationId, actor);
  }
  private async processTaskDeletion(receipt: WeeklyReceipt) {
    try {
      if (await this.gateway.findCreated(receipt.job.id))
        throw new Error('源表仍有本任务创建的条目，请先核对源表');
      await this.gateway.assertNoDate(receipt.job.endDate!);
    } catch (reason) {
      this.store.finishTaskDeletion(
        receipt.job.id,
        reason instanceof Error ? reason.message : '源表核对失败，请重试删除',
      );
      return;
    }
    this.store.finishTaskDeletion(receipt.job.id);
  }
  private async reconcileRow(id: string) {
    const target = await this.gateway.findCreated(id);
    if (!target)
      throw new BadRequestException(
        '未找到带有本任务生成标识的周报条目，原任务保留；请核对飞书记录，不会重复创建',
      );
    return this.recoverRow(id, target);
  }
  async recover(id: string, documentUrl: string) {
    const receipt = this.store.get(id);
    if (
      receipt.job.status !== 'uncertain' ||
      receipt.job.targetRecordId === 'new' ||
      !/^https:\/\/vnet\.feishu\.cn\/docx\/[A-Za-z0-9]+$/.test(documentUrl)
    )
      throw new BadRequestException('恢复任务或文档链接无效');
    // Updating the supplied document is explicit; never silently create a replacement.
    const result = this.store.change(
      id,
      {},
      { documentUrl, stage: 'document', status: 'accepted', error: null },
    );
    setImmediate(() => void this.tick());
    return result;
  }
  async recoverRow(id: string, targetRecordId: string) {
    const receipt = this.store.get(id);
    if (
      receipt.job.status !== 'uncertain' ||
      receipt.job.targetRecordId !== 'new' ||
      !/^rec[A-Za-z0-9]{1,100}$/.test(targetRecordId)
    )
      throw new BadRequestException('恢复条目无效');
    const fields = await this.gateway.record(targetRecordId);
    if (this.gateway.text(fields['周报生成标识']) !== id)
      throw new BadRequestException('所选条目不属于这个生成任务');
    await this.meetings.addWeeklyRecord(targetRecordId, fields);
    const result = this.store.change(
      id,
      {},
      { targetRecordId, stage: 'prepare', status: 'accepted', error: null },
    );
    setImmediate(() => void this.tick());
    return result;
  }
  private async process(receipt: WeeklyReceipt) {
    const { job } = receipt;
    if (job.status === 'running' && job.stage === 'create') {
      this.store.change(
        job.id,
        {},
        {
          status: 'uncertain',
          error: '文档创建结果未确认，请核对飞书文档并绑定已有链接继续',
        },
      );
      return;
    }
    this.store.change(
      job.id,
      {},
      { status: 'running', attempts: job.attempts + 1, error: null },
    );
    try {
      if (job.kind === 'attachments') {
        await syncWeeklyImages(this.store, this.gateway, job.id);
        return;
      }
      if (job.kind === 'generate' && job.targetRecordId === 'new') {
        await this.gateway.ensureCreationField();
        let target =
          receipt.createdRowId || (await this.gateway.findCreated(job.id));
        if (
          receipt.createdRowId &&
          this.gateway.text(
            (await this.gateway.record(target!))['周报生成标识'],
          ) !== job.id
        )
          throw new Error('已创建条目的生成标识不一致，原任务保留，请核对');
        if (!target && job.stage === 'row-create') {
          this.store.change(
            job.id,
            {},
            {
              status: 'uncertain',
              error: '周报条目创建未确认，请核对生成标识后联系管理员恢复',
            },
          );
          return;
        }
        if (!target) {
          await this.gateway.assertNoDate(job.endDate!);
          this.store.change(job.id, {}, { stage: 'row-create' });
          try {
            target = await this.gateway.createRow(
              job.endDate!,
              job.id,
              (id) => {
                this.store.change(job.id, { createdRowId: id }, {});
              },
            );
            this.store.change(job.id, { createdRowId: target }, {});
          } catch (error) {
            if (this.store.get(job.id).createdRowId) throw error;
            if ((error as { operationRejected?: boolean }).operationRejected) {
              this.store.change(job.id, {}, { stage: 'queued' });
              throw error;
            }
            target = await this.gateway.findCreated(job.id);
            if (!target) {
              this.store.change(
                job.id,
                {},
                {
                  status: 'uncertain',
                  error:
                    '周报条目创建结果尚未确认，请查找已创建条目；原任务已保留',
                },
              );
              return;
            }
          }
        }
        const fields = await this.gateway.record(target);
        const record = summarizeMeeting(
          mapWeeklyMeeting({ record_id: target, fields }),
        );
        await this.meetings.addWeeklyRecord(target, fields);
        this.store.change(
          job.id,
          {},
          { targetRecordId: target, stage: 'prepare', record },
        );
        receipt = this.store.get(job.id);
        job.targetRecordId = target;
      }
      if (
        job.kind === 'generate' &&
        (receipt.command as GenerateWeeklyReport).createOnly
      ) {
        this.store.completeGeneration(
          job.id,
          { status: 'success', stage: 'done' },
          'oc_ba4172984f3293d75bbe7e268d51ef40',
        );
        return;
      }
      if (job.kind === 'meeting') {
        const command = receipt.command as SaveWeeklyMeeting;
        const field = WEEKLY_TODO_FIELDS[command.meeting.kind];
        if (command.todoOnly || command.meeting.status === 'held') {
          const fields = { [field]: weeklyTodoText(command.meeting) };
          await this.gateway.update(
            job.targetRecordId,
            { [field]: command.expectedText },
            fields,
          );
          await this.meetings.applyWeeklyFields(job.targetRecordId, fields);
        }
        this.store.change(job.id, {}, { stage: 'done', status: 'success' });
        return;
      }
      if (job.kind === 'action-edit') {
        let command =
          receipt.preparedAction ||
          ('desiredText' in receipt.command
            ? (receipt.command as PreparedActionEdit)
            : undefined);
        if (!command) {
          const input = receipt.command as EditMeetingAction;
          const { meeting } = await this.formRecord(input.targetRecordId);
          const section = meeting.sections.find(
            (s) => s.key === input.actionId.split(':')[1] && s.isAction,
          );
          if (!section) throw new BadRequestException('未找到待办来源');
          command = prepareActionEdit(input, section.content);
          if (command.assignee?.kind === 'employee') {
            await this.people();
            const owner = command.assignee;
            if (
              !this.peopleCache.some(
                (p) => p.openId === owner.openId && p.name === owner.name,
              )
            )
              throw new BadRequestException(
                '责任人不在当前在职员工列表，请重新选择',
              );
          }
          this.store.change(job.id, { preparedAction: command }, {});
        }
        const fields = { [command.field]: command.desiredText };
        await this.gateway.update(
          job.targetRecordId,
          { [command.field]: command.expectedText },
          fields,
        );
        await this.meetings.applyWeeklyFields(job.targetRecordId, fields);
        this.store.change(
          job.id,
          {},
          {
            stage: 'done',
            status: 'success',
            actionResult: {
              actionId: command.actionId,
              content: command.desiredContent,
              ...(command.assignee ? { assignee: command.assignee } : {}),
            },
          },
        );
        return;
      }
      if (!receipt.artifact) {
        this.store.change(job.id, {}, { stage: 'prepare' });
        const { meeting } = await this.formRecord(job.targetRecordId);
        if (
          weeklyTodosEmpty(meeting.sections) &&
          !(receipt.command as GenerateWeeklyReport).confirmedNoTodos
        )
          throw new BadRequestException(WEEKLY_EMPTY_TODOS_MESSAGE);
        const artifact = (await this.engine.call({
          action: 'prepare',
          targetRecordId: job.targetRecordId,
          startDate: job.startDate,
          endDate: job.endDate,
        })) as WeeklyReceipt['artifact'];
        if (
          !artifact ||
          typeof artifact.xml !== 'string' ||
          !artifact.xml ||
          typeof artifact.professional !== 'string' ||
          typeof artifact.operations !== 'string' ||
          typeof artifact.title !== 'string'
        )
          throw new Error('生成内容无效');
        this.store.change(job.id, { artifact }, {});
        receipt = this.store.get(job.id);
      }
      const command = receipt.command as GenerateWeeklyReport;
      const artifact = receipt.artifact!;
      let documentUrl = receipt.job.documentUrl || command.expectedDocumentUrl;
      if (!documentUrl) {
        this.store.change(job.id, {}, { stage: 'create' });
        try {
          const result = await this.engine.call({
            action: 'create',
            xml: artifact.xml,
          });
          documentUrl = String(result.documentUrl || '');
          if (
            !/^https:\/\/vnet\.feishu\.cn\/docx\/[A-Za-z0-9]+$/.test(
              documentUrl,
            )
          )
            throw new Error();
        } catch (error) {
          this.store.change(
            job.id,
            error instanceof WeeklyEngineError
              ? { engineDiagnostic: error.diagnostic }
              : {},
            {
              status: 'uncertain',
              ...(error instanceof WeeklyEngineError && error.documentUrl
                ? { documentUrl: error.documentUrl }
                : {}),
              error: '文档创建结果未确认，请核对飞书文档并绑定已有链接继续',
            },
          );
          return;
        }
        this.store.change(job.id, {}, { documentUrl, stage: 'permissions' });
        await this.gateway.grantDocument(documentUrl, this.documentEditors());
        this.store.change(job.id, {}, { stage: 'archive' });
      } else if (receipt.job.stage === 'permissions') {
        await this.gateway.grantDocument(documentUrl, this.documentEditors());
        this.store.change(job.id, {}, { stage: 'archive' });
      } else if (receipt.job.stage !== 'archive') {
        this.store.change(job.id, {}, { stage: 'document', documentUrl });
        await this.engine.call({
          action: 'document',
          documentUrl,
          xml: artifact.xml,
        });
        if (!command.expectedDocumentUrl) {
          this.store.change(job.id, {}, { stage: 'permissions' });
          await this.gateway.grantDocument(documentUrl, this.documentEditors());
        }
        this.store.change(job.id, {}, { stage: 'archive' });
      }
      const fields = {
        链接: documentUrl,
        专业线: artifact.professional,
        运营线: artifact.operations,
      };
      await this.gateway.update(
        job.targetRecordId,
        { 链接: command.expectedDocumentUrl || '' },
        fields,
      );
      await this.meetings.applyWeeklyFields(job.targetRecordId, fields);
      const { meeting: confirmed } = await this.meetings.detail(
        job.targetRecordId,
        false,
      );
      this.store.completeGeneration(
        job.id,
        {
          stage: 'done',
          status: 'success',
          documentUrl,
          record: summarizeMeeting(confirmed),
        },
        'oc_ba4172984f3293d75bbe7e268d51ef40',
      );
    } catch (error) {
      if (this.store.get(job.id).job.status === 'success') {
        this.logger.warn('会议附件已同步，本地暂存清理失败，请检查暂存目录');
        return;
      }
      this.store.change(
        job.id,
        error instanceof WeeklyEngineError
          ? { engineDiagnostic: error.diagnostic }
          : {},
        {
          status: 'error',
          error:
            error instanceof Error ? error.message : '周会任务失败，请重试',
        },
      );
    }
  }
  private async scheduled() {
    const generationEnabled =
      process.env.NANTONG_WEEKLY_SCHEDULE_ENABLED === 'true';
    const creationEnabled =
      process.env.NANTONG_WEEKLY_PRECREATE_ENABLED === 'true';
    if (!generationEnabled && !creationEnabled) return;
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date());
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    const today = `${get('year')}-${get('month')}-${get('day')}`;
    const clock = `${get('hour')}:${get('minute')}`;
    const day = new Date(`${today}T00:00:00Z`);
    const monthEnd = new Date(
      Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 0),
    );
    if (
      creationEnabled &&
      day.getUTCDate() === monthEnd.getUTCDate() &&
      clock >= '02:00'
    ) {
      const periods = nextMonthWeeklyPeriods(today);
      const missing = periods.filter(
        (period) =>
          !this.store
            .list()
            .jobs.some(
              (job) =>
                job.id === `scheduled-row-${period.endDate}` &&
                job.status !== 'deleted',
            ),
      );
      if (missing.length) {
        try {
          const snapshot = await this.meetings.weeklySnapshot();
          for (const period of missing) {
            if (
              snapshot.records.some((record) => record.date === period.endDate)
            )
              continue;
            await this.generate(
              {
                clientMutationId: `scheduled-row-${period.endDate}`,
                targetRecordId: 'new',
                ...period,
                expectedDocumentUrl: null,
                createOnly: true,
              },
              'scheduler',
            );
          }
          this.creationScheduleMessage = null;
        } catch {
          this.creationScheduleMessage =
            '下月条目预建未完成，请查看任务状态或手动新建条目';
        }
      }
    }
    if (
      !generationEnabled ||
      !this.engine.status().ready ||
      day.getUTCDay() !== 4 ||
      clock < '08:30'
    )
      return;
    const period = weeklyPeriod(today);
    const id = `scheduled-${period.endDate}`;
    try {
      this.store.get(id);
      return;
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'NotFoundException')
        throw error;
    }
    const snapshot = await this.meetings.weeklySnapshot();
    const targets = snapshot.records.filter((r) => r.date === period.endDate);
    if (targets.length > 1) {
      this.scheduleMessage = `本期${period.endDate}有${targets.length}条周报，请准备唯一条目或手动选择目标生成`;
      return;
    }
    if (!targets.length) {
      this.scheduleMessage = `本期${period.endDate}尚无条目，请先新建条目`;
      return;
    }
    const target = targets[0];
    if (
      this.store
        .list()
        .jobs.some(
          (job) =>
            job.kind === 'generate' &&
            !job.createOnly &&
            job.targetRecordId === target.id &&
            job.status === 'success',
        )
    ) {
      this.scheduleMessage = null;
      return;
    }
    const { meeting } = await this.formRecord(target.id);
    if (weeklyTodosEmpty(meeting.sections)) {
      this.scheduleMessage = `本期${period.endDate}：${WEEKLY_EMPTY_TODOS_MESSAGE}`;
      return;
    }
    this.scheduleMessage = null;
    await this.generate(
      {
        clientMutationId: id,
        targetRecordId: target.id,
        ...period,
        expectedDocumentUrl: meeting.documentUrl,
      },
      'scheduler',
    );
  }
  private async tick() {
    if (this.working) return;
    const release = acquireWeeklyLock(`${this.store.path}.worker`);
    if (!release) return;
    this.working = true;
    try {
      for (const receipt of this.store
        .pending()
        .filter((r) => r.job.status === 'deleting'))
        await this.processTaskDeletion(receipt);
      await this.scheduled();
      for (const receipt of this.store
        .pending()
        .filter((r) => r.job.status !== 'deleting'))
        await this.process(receipt);
      for (const receipt of this.store.notifications())
        await this.sendNotification(receipt);
      for (const command of this.store.completedImages()) {
        try {
          cleanupWeeklyImages(this.store, command);
        } catch {
          this.logger.warn('已完成会议附件暂存清理失败，请检查暂存目录');
        }
      }
    } catch {
      this.scheduleMessage = '后台任务暂时无法推进，请检查周会台账和运行配置';
      this.logger.warn('周会后台任务失败，原台账保留');
    } finally {
      this.working = false;
      release();
    }
  }
  private async sendNotification(receipt: WeeklyReceipt) {
    if (!canNotifyWeeklyReport(receipt) || !receipt.job.notification) return;
    const { job } = receipt;
    const notification = job.notification!;
    if (
      notification.firstAttemptAt &&
      (!Number.isFinite(Date.parse(notification.firstAttemptAt)) ||
        Date.now() - Date.parse(notification.firstAttemptAt) >= 45 * 60000)
    ) {
      this.store.change(
        job.id,
        {},
        {
          notification: {
            ...notification,
            status: 'uncertain',
            error: '群提醒发送结果待核对，请检查群消息；不会重复发送',
          },
        },
      );
      return;
    }
    const sending = {
      ...notification,
      status: 'sending' as const,
      attempts: notification.attempts + 1,
      firstAttemptAt: notification.firstAttemptAt || new Date().toISOString(),
      error: null,
    };
    this.store.change(job.id, {}, { notification: sending });
    try {
      const link = job.documentUrl!;
      sending.link = link;
      this.store.change(job.id, {}, { notification: sending });
      const messageId = await this.gateway.sendWeeklyReport(
        notification.chatId,
        notification.uuid,
        `${job.endDate} · ${job.record?.title || receipt.artifact?.title || '南通运维周报'}`,
        link,
      );
      this.store.change(
        job.id,
        {},
        { notification: { ...sending, status: 'success', messageId } },
      );
    } catch (error) {
      const rejected = (error as { notificationRejected?: boolean })
        .notificationRejected;
      const mayHaveSent = sending.mayHaveSent || !rejected;
      this.store.change(
        job.id,
        {},
        {
          notification: {
            ...sending,
            status: rejected || sending.attempts >= 3 ? 'error' : 'pending',
            mayHaveSent,
            ...(rejected && !mayHaveSent ? { firstAttemptAt: undefined } : {}),
            error:
              rejected && error instanceof Error
                ? error.message
                : '群提醒暂未确认，周报已保存',
          },
        },
      );
    }
  }
}
