import { PersonnelProfileNotificationsService } from './personnel-profile-notifications.service';
import { runHotfixInitialization, cancelHotfixInitialization } from '../hotfix-runtime-activation';
import { PROFILE_CHANGE_PHOTO_MAX_BYTES } from '../../../shared/personnel-profile-change.interface';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Optional,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type {
  CreateProfileChange,
  ReviewProfileChange,
  ProfileChange,
  ProfileChangeField,
  CancelProfileChange,
  RecoverProfileChange,
} from '../../../shared/personnel-profile-change.interface';
import { AccessConfigurationService } from './access-configuration.service';
import { PersonnelArchiveGateway } from './personnel-archive.gateway';
import {
  PersonnelProfileChangesGateway,
  profileValue,
} from './personnel-profile-changes.gateway';
import {
  PersonnelProfileChangesStore,
  type StoredProfileChange,
} from './personnel-profile-changes.store';
import {
  resolveSelfServicePersonnelRecord,
  matchesSelfServicePersonnelIdentity,
} from './self-service-applicant';
import {
  getRecordId,
  extractDisplayText,
  pickField,
} from '../feishu/bitable-direct-read';
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const mutation = (v: unknown) =>
  typeof v === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(v);
function present(row: StoredProfileChange): ProfileChange {
  const {
    identity,
    source,
    fields,
    baseline,
    desired,
    photo,
    photoToken,
    beforePhoto,
    reviewerAccountId,
    reviewerVersion,
    ...publicRow
  } = row;
  return structuredClone(publicRow);
}
function imageType(b: Buffer) {
  if (
    b.length >= 8 &&
    b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image/png';
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255)
    return 'image/jpeg';
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString() === 'RIFF' &&
    b.subarray(8, 12).toString() === 'WEBP'
  )
    return 'image/webp';
  throw new BadRequestException('照片仅支持PNG、JPEG或WebP');
}
@Injectable()
export class PersonnelProfileChangesService {
  private inFlight = new Set<Promise<unknown>>();
  private timer?: ReturnType<typeof setInterval>;
  private stopping = false;
  private running = new Map<string, Promise<void>>();
  private logger = new Logger(PersonnelProfileChangesService.name);
  constructor(
    private readonly configuration: AccessConfigurationService,
    private readonly directory: PersonnelArchiveGateway,
    private readonly gateway: PersonnelProfileChangesGateway,
    private readonly store: PersonnelProfileChangesStore,
    @Optional() private readonly notifications?: PersonnelProfileNotificationsService,
  ) {}
  async onModuleInit() {
    if(process.env.NODE_ENV!=='production'||/^(?:1|true|on|yes)$/iu.test(process.env.NANTONG_HOTFIX_SMOKE_MODE||''))return;
    await runHotfixInitialization(this,()=>{if(this.stopping)return;this.timer=setInterval(()=>this.resume(),30000);this.timer.unref();this.resume();});
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await cancelHotfixInitialization(this);
    await Promise.allSettled([...this.inFlight, ...this.running.values()]);
  }
  private resume() {
    if (this.stopping) return;
    try {
      for (const row of Object.values(this.store.read().requests))
        if (
          ['approved', 'writing', 'uploading', 'reconciliation'].includes(
            row.status,
          )
        )
          void this.run(row.id).catch(() =>
            this.logger.warn('资料变更恢复等待下次核对'),
          );
    } catch {
      this.logger.warn('资料变更台账暂不可读，未执行写入');
    }
  }
  private verify(principal: AccessPrincipal, admin = false) {
    if (!principal || principal.impersonation)
      throw new ForbiddenException('代登录期间不能办理资料变更');
    if (this.stopping)
      throw new ConflictException('系统更新中，请保留原申请重试');
    const current = this.configuration.currentPrincipal(
      principal.accountId,
      principal.authorizationVersion,
    );
    if (
      !current ||
      current.role !== principal.role ||
      current.requiresPasswordChange
    )
      throw new UnauthorizedException('登录状态已变化');
    const account = this.configuration.getPersonnelCredentialAccount(
      current.accountId!,
    );
    if (
      !account ||
      !account.enabled ||
      account.deleted ||
      account.reactivationRequired ||
      account.permissionsRevoked ||
      account.personnelActive === false ||
      account.personnelSuspended
    )
      throw new ForbiddenException('账号当前不可办理资料变更');
    if (admin && current.role !== 'admin')
      throw new ForbiddenException('仅管理员可以审核');
    if (!admin && !/^(feishu-|local-external-)/.test(account.id))
      throw new ForbiddenException('当前账号未关联个人档案');
    return { current, account };
  }
  list(principal: AccessPrincipal, admin = false) {
    const { account } = this.verify(principal, admin);
    return Object.values(this.store.read().requests)
      .filter(
        (r) =>
          admin ||
          r.accountId === account.id ||
          (!!account.personnelIdentity &&
            r.identity === account.personnelIdentity),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(present);
  }
  photo(principal: AccessPrincipal, id: string, admin = false, before = false) {
    this.verify(principal, admin);
    if (!this.list(principal, admin).some((r) => r.id === id))
      throw new ForbiddenException('不能读取其他人的照片');
    const row = this.store.read().requests[id];
    const photo = before ? row?.beforePhoto : row?.photo;
    if (!photo) throw new BadRequestException('暂无申请照片');
    return {
      buffer: this.store.readPhoto(id, photo),
      contentType: photo.type,
    };
  }
  private tracked<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping)
      return Promise.reject(
        new ConflictException('系统更新中，请保留原申请重试'),
      );
    const task = operation();
    void task.then(()=>this.notifications?.wake(),()=>undefined).catch(()=>undefined);
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task)).catch(() => undefined);
    return task;
  }
  create(
    principal: AccessPrincipal,
    input: CreateProfileChange,
    file?: { buffer: Buffer },
  ) {
    return this.tracked(() => this.createAccepted(principal, input, file));
  }
  private async createAccepted(
    principal: AccessPrincipal,
    input: CreateProfileChange,
    file?: { buffer: Buffer },
  ) {
    const { account } = this.verify(principal);
    if (
      !input ||
      Object.keys(input).some(
        (k) => !['clientMutationId', 'phone', 'email'].includes(k),
      ) ||
      !mutation(input.clientMutationId)
    )
      throw new BadRequestException('申请格式无效');
    const changes: StoredProfileChange['changes'] = {};
    if (input.phone !== undefined) {
      if (
        typeof input.phone !== 'string' ||
        !/^\+?[0-9 ()-]{6,30}$/.test(input.phone.trim())
      )
        throw new BadRequestException('请输入有效手机号');
      changes.phone = input.phone.trim();
    }
    if (input.email !== undefined) {
      if (
        typeof input.email !== 'string' ||
        input.email.length > 254 ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)
      )
        throw new BadRequestException('请输入有效邮箱');
      changes.email = input.email.trim();
    }
    let photoBytes: Buffer | undefined;
    let photoType: string | undefined;
    let photoHash: string | undefined;
    let photo: StoredProfileChange['photo'];
    if (file) {
      if (
        !Buffer.isBuffer(file.buffer) ||
        !file.buffer.length ||
        file.buffer.length > PROFILE_CHANGE_PHOTO_MAX_BYTES
      )
        throw new BadRequestException('照片最大10MB');
      photoBytes = file.buffer;
      photoType = imageType(file.buffer);
      photoHash = createHash('sha256').update(file.buffer).digest('hex');
      changes.photo = '已提交新照片';
    }
    if (!Object.keys(changes).length)
      throw new BadRequestException('请选择需要修改的资料');
    const key = hash(['create', account.id, input.clientMutationId]),
      fingerprint = hash([changes, photoHash]);
    const existing = this.store.read().mutations[key];
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw new ConflictException('原请求内容已变化');
      return present(this.store.read().requests[existing.id]);
    }
    const pendingRows = Object.values(this.store.read().requests);
    if (pendingRows.length >= 10000)
      throw new ConflictException('资料申请记录容量已满，请联系管理员');
    if (
      pendingRows.some(
        (row) =>
          (row.accountId === account.id ||
            (!!account.personnelIdentity &&
              row.identity === account.personnelIdentity)) &&
          [
            'pending',
            'approved',
            'uploading',
            'writing',
            'reconciliation',
          ].includes(row.status),
      )
    )
      throw new ConflictException('已有未完成的资料申请，请先处理原申请');
    const directory = await this.directory.read();
    const record = resolveSelfServicePersonnelRecord(
      principal,
      directory,
      directory.records,
    );
    const source = {
      appId: directory.appId,
      appToken: directory.appToken,
      tableId: directory.tableId,
      recordId: getRecordId(record),
    };
    const identity =
      'local-external-' +
      hash([source.appId, source.appToken, source.tableId, source.recordId]);
    if (account.personnelIdentity && account.personnelIdentity !== identity)
      throw new ForbiddenException('本人档案绑定已变化');
    if ((account.appId || account.personnelAppId) !== source.appId)
      throw new ForbiddenException('档案应用不一致');
    const fresh = await this.gateway.read(source);
    resolveSelfServicePersonnelRecord(principal, source, [fresh]);
    const keys = Object.keys(changes) as ProfileChangeField[];
    const fields = await this.gateway.fields(source, keys, fresh),
      baseline: Record<string, unknown> = {},
      before: StoredProfileChange['before'] = {};
    for (const field of keys) {
      baseline[fields[field]!] = profileValue(
        fresh.fields?.[fields[field]!],
        field === 'photo',
      );
      before[field] =
        field === 'photo'
          ? Array.isArray(baseline[fields[field]!]) &&
            (baseline[fields[field]!] as unknown[]).length
            ? '已有照片'
            : '暂无照片'
          : String(baseline[fields[field]!]);
    }
    const requestId = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}`;
    let beforePhoto: StoredProfileChange['beforePhoto'];
    if (photoBytes && photoType) {
      photo = this.store.savePhoto(requestId, 'after', photoBytes, photoType);
      const old = await this.directory.photo(directory, fresh);
      if (old)
        beforePhoto = this.store.savePhoto(
          requestId,
          'before',
          old.buffer,
          old.contentType,
        );
    }
    return present(
      await this.store.mutate((state) => {
        this.verify(principal);
        const previous = state.mutations[key];
        if (previous) {
          if (previous.fingerprint !== fingerprint)
            throw new ConflictException('原请求内容已变化');
          return state.requests[previous.id];
        }
        if (
          Object.values(state.requests).some(
            (r) =>
              r.identity === identity &&
              [
                'pending',
                'approved',
                'uploading',
                'writing',
                'reconciliation',
              ].includes(r.status),
          )
        )
          throw new ConflictException('已有未完成的资料申请，请先处理原申请');
        const now = new Date().toISOString(),
          row: StoredProfileChange = {
            id: requestId,
            clientMutationId: input.clientMutationId,
            version: 1,
            accountId: account.id,
            applicantName: account.name,
            identity,
            source,
            fields,
            baseline,
            before,
            changes,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
            ...(photo ? { photo } : {}),
            ...(beforePhoto ? { beforePhoto } : {}),
          };
        state.requests[row.id] = row;
        state.mutations[key] = { fingerprint, id: row.id };
        return row;
      }),
    );
  }
  private denySelf(
    actor: ReturnType<PersonnelProfileChangesService['verify']>,
    row: StoredProfileChange,
  ) {
    if (
      actor.account.id === row.accountId ||
      actor.account.personnelIdentity === row.identity ||
      actor.account.id === row.identity
    )
      throw new ForbiddenException('不能审核本人或关联账号的申请');
  }
  hasCardReviewReceipt(accountId:string,input:ReviewProfileChange):boolean{const state=this.store.read();const receipt=state.mutations[hash(['review',accountId,input.clientMutationId])];return !!receipt&&receipt.id===input.requestId&&receipt.fingerprint===hash(input)&&!!state.requests[input.requestId];}
  assertCardReview(principal:AccessPrincipal,requestId:string):{status:StoredProfileChange['status'];version:number}{const actor=this.verify(principal,true);const row=this.store.read().requests[requestId];if(!row)throw new BadRequestException('申请不存在');this.denySelf(actor,row);return {status:row.status,version:row.version};}
  review(principal: AccessPrincipal, input: ReviewProfileChange) {
    return this.tracked(() => this.reviewAccepted(principal, input));
  }
  private async reviewAccepted(
    principal: AccessPrincipal,
    input: ReviewProfileChange,
  ) {
    const actor = this.verify(principal, true);
    if (
      !input ||
      Object.keys(input).sort().join(',') !==
        [
          'requestId',
          'expectedVersion',
          'clientMutationId',
          'decision',
          'comment',
        ]
          .sort()
          .join(',') ||
      !mutation(input.clientMutationId) ||
      !Number.isSafeInteger(input.expectedVersion) ||
      !['approve', 'reject'].includes(input.decision) ||
      typeof input.comment !== 'string' ||
      input.comment.length > 1000
    )
      throw new BadRequestException('审核内容无效');
    let row = this.store.read().requests[input.requestId];
    if (!row) throw new BadRequestException('申请不存在');
    this.denySelf(actor, row);
    const key = hash(['review', actor.account.id, input.clientMutationId]),
      fingerprint = hash(input);
    const previous = this.store.read().mutations[key];
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ConflictException('原请求内容已变化');
      return present(this.store.read().requests[previous.id]);
    }
    // Verify the administrator's source identity as well as saved account linkage.
    const directory = await this.directory.read();
    let ownRecord;
    try {
      ownRecord = resolveSelfServicePersonnelRecord(
        principal,
        directory,
        directory.records,
      );
    } catch (error) {
      if (
        !actor.account.id.startsWith('feishu-') &&
        !actor.account.id.startsWith('local-external-')
      )
        ownRecord = undefined;
      else throw error;
    }
    if (
      ownRecord &&
      directory.appId === row.source.appId &&
      directory.appToken === row.source.appToken &&
      directory.tableId === row.source.tableId &&
      getRecordId(ownRecord) === row.source.recordId
    )
      throw new ForbiddenException('不能审核本人或关联账号的申请');
    row = await this.store.mutate((state) => {
      const current = this.verify(principal, true);
      const target = state.requests[input.requestId];
      this.denySelf(current, target);
      const old = state.mutations[key];
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new ConflictException('原请求内容已变化');
        return target;
      }
      if (
        target.version !== input.expectedVersion ||
        target.status !== 'pending'
      )
        throw new ConflictException('申请状态已变化，请刷新');
      target.status = input.decision === 'approve' ? 'approved' : 'rejected';
      target.reviewerAccountId = actor.account.id;
      target.reviewerVersion = principal.authorizationVersion;
      target.reviewerName = actor.account.name;
      target.comment = input.comment.trim();
      target.version++;
      target.updatedAt = new Date().toISOString();
      state.mutations[key] = { fingerprint, id: target.id };
      return target;
    });
    if (row.status === 'approved')
      void this.run(row.id).catch(() =>
        this.logger.warn('资料变更已受理，等待恢复'),
      );
    else if (row.status === 'rejected') {
      // Promptly notify the applicant of a rejection; the completed path is
      // woken from mark(). A notification failure must never alter the decision.
      try {
        this.notifications?.wake();
      } catch {
        /* result notification is best-effort */
      }
    }
    return present(row);
  }
  cancel(principal: AccessPrincipal, input: CancelProfileChange) {
    return this.tracked(async () => {
      const actor = this.verify(principal);
      if (
        !input ||
        Object.keys(input).sort().join(',') !==
          ['requestId', 'expectedVersion', 'clientMutationId']
            .sort()
            .join(',') ||
        !mutation(input.clientMutationId) ||
        !Number.isSafeInteger(input.expectedVersion)
      )
        throw new BadRequestException('撤回请求无效');
      const key = hash(['cancel', actor.account.id, input.clientMutationId]),
        fingerprint = hash(input);
      return present(
        await this.store.mutate((state) => {
          this.verify(principal);
          const row = state.requests[input.requestId];
          if (
            !row ||
            (row.accountId !== actor.account.id &&
              row.identity !== actor.account.personnelIdentity)
          )
            throw new ForbiddenException('只能撤回本人申请');
          const old = state.mutations[key];
          if (old) {
            if (old.fingerprint !== fingerprint)
              throw new ConflictException('原请求内容已变化');
            return row;
          }
          if (row.version !== input.expectedVersion || row.status !== 'pending')
            throw new ConflictException('仅待审核申请可以撤回');
          row.status = 'cancelled';
          row.version++;
          row.updatedAt = new Date().toISOString();
          state.mutations[key] = { fingerprint, id: row.id };
          return row;
        }),
      );
    });
  }
  recover(principal: AccessPrincipal, input: RecoverProfileChange) {
    return this.tracked(async () => {
      const actor = this.verify(principal, true);
      if (
        !input ||
        Object.keys(input).some(
          (k) =>
            ![
              'requestId',
              'expectedVersion',
              'clientMutationId',
              'confirmUnchanged',
              'uploadedPhotoToken',
            ].includes(k),
        ) ||
        !mutation(input.clientMutationId) ||
        !Number.isSafeInteger(input.expectedVersion) ||
        typeof input.confirmUnchanged !== 'boolean'
      )
        throw new BadRequestException('恢复请求无效');
      const key = hash(['recover', actor.account.id, input.clientMutationId]),
        fingerprint = hash(input);
      const known = this.store.read().mutations[key];
      if (known) {
        if (known.fingerprint !== fingerprint)
          throw new ConflictException('原请求内容已变化');
        return present(this.store.read().requests[known.id]);
      }
      let row = this.store.read().requests[input.requestId];
      if (!row) throw new BadRequestException('申请不存在');
      this.denySelf(actor, row);
      await this.store.exclusiveTask(row.id, async () => {
        row = this.store.read().requests[row.id];
        if (
          row.version !== input.expectedVersion ||
          row.status !== 'reconciliation'
        )
          throw new ConflictException('申请状态已变化');
        const fresh = await this.gateway.read(row.source);
        this.assertApplicant(row, fresh);
        this.denySourceSelf(principal, row, fresh);
        const actual = Object.fromEntries(
          Object.entries(row.fields).map(([key, name]) => [
            name!,
            profileValue(fresh.fields?.[name!], key === 'photo'),
          ]),
        );
        const completed = !!row.desired && same(actual, row.desired);
        let token = row.photoToken;
        if (!completed && input.confirmUnchanged) {
          if (!same(actual, row.baseline))
            throw new ConflictException('来源数据已变化，不能恢复原写入');
          if (row.photo && !token) {
            if (!input.uploadedPhotoToken)
              throw new ConflictException(
                '照片上传结果未确认，请提供已上传照片标识以核对，不能重复上传',
              );
            await this.gateway.verifyUploadedPhoto(
              row.source,
              input.uploadedPhotoToken,
              row.photo.sha256,
              row.photo.size,
            );
            token = input.uploadedPhotoToken;
          }
        }
        await this.store.mutate((state) => {
          this.verify(principal, true);
          const target = state.requests[row.id];
          this.denySelf(actor, target);
          if (
            target.version !== input.expectedVersion ||
            target.status !== 'reconciliation'
          )
            throw new ConflictException('申请状态已变化');
          if (completed) {
            target.status = 'completed';
            target.message = '已核对，资料已更新';
          } else if (input.confirmUnchanged) {
            target.status = 'approved';
            target.photoToken = token;
            target.reviewerAccountId = actor.account.id;
            target.reviewerVersion = principal.authorizationVersion;
            target.reviewerName = actor.account.name;
            target.message = '管理员已核对来源未改变，继续原申请';
          } else target.message = '来源尚未确认更新，未重复写入';
          target.version++;
          target.updatedAt = new Date().toISOString();
          state.mutations[key] = { fingerprint, id: target.id };
        });
      });
      row = this.store.read().requests[row.id];
      if (row.status === 'approved')
        void this.run(row.id).catch(() =>
          this.logger.warn('资料变更恢复等待处理'),
        );
      return present(row);
    });
  }
  private run(id: string): Promise<void> {
    const pending = this.running.get(id);
    if (pending) return pending;
    const task = this.store
      .exclusiveTask(id, () => this.process(id))
      .finally(() => this.running.delete(id));
    this.running.set(id, task);
    return task;
  }
  private async process(id: string) {
    let row = this.store.read().requests[id];
    if (
      !row ||
      !['approved', 'writing', 'uploading', 'reconciliation'].includes(
        row.status,
      ) ||
      this.stopping
    )
      return;
    try {
      const fresh = await this.gateway.read(row.source);
      this.assertApplicant(row, fresh);
      if (row.desired) {
        const actual = Object.fromEntries(
          Object.entries(row.fields).map(([key, name]) => [
            name!,
            profileValue(fresh.fields?.[name!], key === 'photo'),
          ]),
        );
        if (same(actual, row.desired)) {
          await this.mark(id, 'completed', '资料已更新');
          return;
        }
      }
      if (row.status === 'uploading' && row.photoToken) {
        await this.store.mutate((state) => {
          const target = state.requests[id];
          if (target.status === 'uploading' && target.photoToken)
            target.status = 'approved';
        });
        row = this.store.read().requests[id];
      }
      if (row.status !== 'approved') {
        await this.mark(
          id,
          'reconciliation',
          '上次处理结果尚未确认，已停止重复写入，请管理员核对',
        );
        return;
      }
      const principal = this.configuration.currentPrincipal(
        row.reviewerAccountId,
        row.reviewerVersion,
      );
      if (!principal || principal.role !== 'admin')
        throw new ConflictException('审核人权限已变化，请管理员核对');
      this.verify(principal, true);
      const account = this.configuration.getPersonnelCredentialAccount(
        row.accountId,
      );
      if (
        !account ||
        !account.enabled ||
        account.deleted ||
        account.personnelActive === false ||
        account.personnelSuspended ||
        (account.personnelIdentity &&
          account.personnelIdentity !== row.identity)
      )
        throw new ConflictException('申请人员身份已变化');
      const fields = await this.gateway.fields(
        row.source,
        Object.keys(row.changes) as ProfileChangeField[],
        fresh,
      );
      if (!same(fields, row.fields))
        throw new ConflictException('来源字段已变化');
      const baseline = Object.fromEntries(
        Object.entries(fields).map(([key, name]) => [
          name!,
          profileValue(fresh.fields?.[name!], key === 'photo'),
        ]),
      );
      if (!same(baseline, row.baseline))
        throw new ConflictException('原资料已被修改，请重新提交申请');
      const claimed = await this.store.mutate((state) => {
        const target = state.requests[id];
        if (target.status !== 'approved') return false;
        this.verify(principal, true);
        target.status =
          target.photo && !target.photoToken ? 'uploading' : 'approved';
        target.updatedAt = new Date().toISOString();
        target.version++;
        return true;
      });
      if (!claimed) return;
      if (row.photo && !row.photoToken) {
        const token = await this.gateway.upload(
          row.source,
          this.store.readPhoto(row.id, row.photo),
          row.photo.type,
        );
        await this.store.mutate((state) => {
          state.requests[id].photoToken = token;
          state.requests[id].status = 'approved';
          state.requests[id].version++;
          state.requests[id].updatedAt = new Date().toISOString();
          return true;
        });
        row = this.store.read().requests[id];
      }
      // Recheck source after a possibly slow upload; do not overwrite changes made while waiting.
      const before = await this.gateway.read(row.source);
      this.assertApplicant(row, before);
      const current = Object.fromEntries(
        Object.entries(row.fields).map(([key, name]) => [
          name!,
          profileValue(before.fields?.[name!], key === 'photo'),
        ]),
      );
      if (!same(current, row.baseline))
        throw new ConflictException('原资料已被修改，请重新提交申请');
      this.verify(principal, true);
      const desired: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row.changes))
        desired[row.fields[key as ProfileChangeField]!] =
          key === 'photo' ? [{ file_token: row.photoToken }] : value;
      await this.store.mutate((state) => {
        const target = state.requests[id];
        target.desired = desired;
        target.status = 'writing';
        target.version++;
        target.updatedAt = new Date().toISOString();
        return true;
      });
      await this.gateway.write(row.source, desired);
      const verified = await this.gateway.read(row.source);
      this.assertApplicant(row, verified);
      const actual = Object.fromEntries(
        Object.entries(row.fields).map(([key, name]) => [
          name!,
          profileValue(verified.fields?.[name!], key === 'photo'),
        ]),
      );
      await this.mark(
        id,
        same(actual, desired) ? 'completed' : 'reconciliation',
        same(actual, desired) ? '资料已更新' : '写入结果待核对，未重复写入',
      );
    } catch (error) {
      const latest = this.store.read().requests[id];
      await this.mark(
        id,
        this.stopping && latest.status === 'approved'
          ? 'approved'
          : error instanceof ConflictException
            ? 'conflict'
            : latest.status === 'approved'
              ? 'approved'
              : 'reconciliation',
        error instanceof ConflictException
          ? error.message
          : '处理结果待核对，原申请已保留',
      );
    }
  }
  private denySourceSelf(
    principal: AccessPrincipal,
    row: StoredProfileChange,
    record: any,
  ) {
    const ids = new Set<string>();
    const fields = record.fields || {};
    const users = pickField(fields, ['员工姓名', '员工', '人员']);
    if (Array.isArray(users))
      for (const user of users)
        if (typeof user?.id === 'string') ids.add(user.id);
    const explicit = extractDisplayText(
      pickField(fields, ['飞书 open_id', 'open_id', 'Open ID']),
    ).trim();
    if (explicit) ids.add(explicit);
    if (
      matchesSelfServicePersonnelIdentity(principal, {
        ...row.source,
        openId: ids.size === 1 ? [...ids][0] : undefined,
      })
    )
      throw new ForbiddenException('不能审核本人或关联账号的申请');
  }
  private assertApplicant(row: StoredProfileChange, record: any) {
    const account = this.configuration.getPersonnelCredentialAccount(
      row.accountId,
    );
    if (
      !account ||
      !account.enabled ||
      account.deleted ||
      account.personnelActive === false ||
      account.personnelSuspended ||
      account.reactivationRequired ||
      account.permissionsRevoked
    )
      throw new ConflictException('申请人员身份已变化');
    const principal = this.configuration.currentPrincipal(
      account.id,
      account.version,
    );
    if (
      !principal ||
      (account.personnelIdentity && account.personnelIdentity !== row.identity)
    )
      throw new ConflictException('申请人员绑定已变化');
    resolveSelfServicePersonnelRecord(principal, row.source, [record]);
  }
  private mark(
    id: string,
    status: StoredProfileChange['status'],
    message: string,
  ) {
    return this.store.mutate((state) => {
      const row = state.requests[id];
      if (
        row.status === 'completed' ||
        row.status === 'rejected' ||
        (row.status === status && row.message === message)
      )
        return;
      row.status = status;
      row.message = message;
      row.version++;
      row.updatedAt = new Date().toISOString();
    }).then(()=>{try{this.notifications?.wake();}catch{/* Notification recovery must never change a saved business result. */}});
  }
}
