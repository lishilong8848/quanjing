import { BadRequestException, ConflictException, ForbiddenException, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { PERSONNEL_ARCHIVE_CORRECTION_FIELDS, type CreatePersonnelArchiveCorrection, type CancelPersonnelArchiveCorrection, type ReviewPersonnelArchiveCorrection, type PersonnelArchiveCorrection, type PersonnelArchiveCorrectionSummary } from '../../../shared/personnel-archive-correction.interface';
import { AccessConfigurationService } from './access-configuration.service';
import { getPersonnelArchiveCorrectionsStore, PersonnelArchiveCorrectionsStore, type ArchiveCorrectionsState, type StoredArchiveCorrection } from './personnel-archive-corrections.store';

@Injectable()
export class PersonnelArchiveCorrectionsService {
  private readonly store: PersonnelArchiveCorrectionsStore;
  constructor(private readonly configuration: AccessConfigurationService, @Optional() store?: PersonnelArchiveCorrectionsStore) { this.store = store || getPersonnelArchiveCorrectionsStore(); }

  listOwn(principal: AccessPrincipal): PersonnelArchiveCorrection[] {
    const owner = this.verify(principal);
    return this.rows(owner.identity);
  }
  listAdmin(principal: AccessPrincipal): PersonnelArchiveCorrection[] { this.verify(principal, true); return this.rows(); }
  summaryOwn(principal: AccessPrincipal): PersonnelArchiveCorrectionSummary { return this.summary(this.verify(principal).identity); }
  summaryAdmin(principal: AccessPrincipal): PersonnelArchiveCorrectionSummary { this.verify(principal, true); return this.summary(); }
  private rows(identity?: string): PersonnelArchiveCorrection[] {
    return Object.values(this.store.read().requests).filter(row => !identity || row.applicantIdentity === identity).map(present).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  }
  private summary(identity?: string): PersonnelArchiveCorrectionSummary {
    const state = this.store.read(), rows = Object.values(state.requests).filter(row => !identity || row.applicantIdentity === identity);
    return { total: rows.length, pending: rows.filter(row => row.status === 'pending').length, resolved: rows.filter(row => row.status === 'resolved').length,
      rejected: rows.filter(row => row.status === 'rejected').length, cancelled: rows.filter(row => row.status === 'cancelled').length, capacity: this.store.capacity(state) };
  }
  async create(principal: AccessPrincipal, input: CreatePersonnelArchiveCorrection): Promise<PersonnelArchiveCorrection> {
    if (!record(input) || !keys(input,['clientMutationId','fields','description']) || !mutation(input.clientMutationId) || !Array.isArray(input.fields) || !input.fields.length ||
      input.fields.length > PERSONNEL_ARCHIVE_CORRECTION_FIELDS.length || new Set(input.fields).size !== input.fields.length || !input.fields.every(field => PERSONNEL_ARCHIVE_CORRECTION_FIELDS.includes(field))) throw new BadRequestException('资料纠错内容无效');
    const description = prose(input.description), fields = PERSONNEL_ARCHIVE_CORRECTION_FIELDS.filter(field => input.fields.includes(field));
    const result = await this.store.mutate(state => {
      const owner = this.verify(principal), key = hash(['create',owner.accountId,input.clientMutationId]), fingerprint = hash({fields,description});
      const previous = replay(state,key,fingerprint); if (previous) return previous;
      const pending = Object.values(state.requests).filter(row => row.applicantIdentity === owner.identity && row.status === 'pending');
      const duplicate = pending.find(row => row.description === description && JSON.stringify(row.fields) === JSON.stringify(fields));
      if (duplicate) { state.mutations[key] = {fingerprint,requestId:duplicate.id}; return duplicate; }
      if (pending.length >= 10) throw new BadRequestException('已有较多待处理纠错，请等待管理员处理或撤回不再需要的申请');
      const now = new Date().toISOString(), row: StoredArchiveCorrection = { id:randomUUID(),version:1,accountId:owner.accountId,applicantIdentity:owner.identity,applicantName:owner.name,
        fields,description,status:'pending',createdAt:now,updatedAt:now };
      state.requests[row.id] = row; state.mutations[key] = {fingerprint,requestId:row.id};
      state.audit.push({requestId:row.id,actorId:owner.accountId,action:'create',at:now,version:1}); return row;
    }); return present(result);
  }
  async cancel(principal: AccessPrincipal, input: CancelPersonnelArchiveCorrection): Promise<PersonnelArchiveCorrection> {
    identityInput(input,['clientMutationId','requestId','expectedRequestVersion']);
    const result = await this.store.mutate(state => {
      const owner = this.verify(principal), row = ownRow(state,input.requestId);
      if (row.applicantIdentity !== owner.identity) throw new ForbiddenException('只能撤回本人的资料纠错');
      const key = hash(['cancel',owner.accountId,input.clientMutationId]), fingerprint = hash({requestId:input.requestId,expectedRequestVersion:input.expectedRequestVersion});
      const previous = replay(state,key,fingerprint); if (previous) return previous;
      pendingVersion(row,input.expectedRequestVersion); row.status = 'cancelled'; row.version++; row.updatedAt = new Date().toISOString();
      state.mutations[key] = {fingerprint,requestId:row.id}; state.audit.push({requestId:row.id,actorId:owner.accountId,action:'cancel',at:row.updatedAt,version:row.version}); return row;
    }); return present(result);
  }
  async review(principal: AccessPrincipal, input: ReviewPersonnelArchiveCorrection): Promise<PersonnelArchiveCorrection> {
    identityInput(input,['clientMutationId','requestId','expectedRequestVersion','decision','comment']);
    if (!['resolve','reject'].includes(input.decision)) throw new BadRequestException('资料纠错处理决定无效');
    const comment = prose(input.comment);
    const result = await this.store.mutate(state => {
      const actor = this.verify(principal,true), row = ownRow(state,input.requestId);
      if (actor.accountId === row.accountId || actor.identity === row.applicantIdentity) throw new ForbiddenException('不能处理本人或关联账号的资料纠错');
      const key = hash(['review',actor.accountId,input.clientMutationId]), fingerprint = hash({requestId:input.requestId,expectedRequestVersion:input.expectedRequestVersion,decision:input.decision,comment});
      const previous = replay(state,key,fingerprint); if (previous) return previous;
      pendingVersion(row,input.expectedRequestVersion);
      // Resolve records an administrator's explanation only. No personnel-source, role or credential writes.
      row.status = input.decision === 'resolve' ? 'resolved' : 'rejected'; row.version++; row.updatedAt = new Date().toISOString();
      row.reviewerAccountId = actor.accountId; row.reviewerName = actor.name; row.comment = comment;
      state.mutations[key] = {fingerprint,requestId:row.id}; state.audit.push({requestId:row.id,actorId:actor.accountId,action:input.decision,at:row.updatedAt,version:row.version}); return row;
    }); return present(result);
  }
  private verify(principal: AccessPrincipal, admin = false): {accountId:string;identity:string;name:string} {
    if (!principal || principal.impersonation) throw new ForbiddenException('代登录期间不能办理资料纠错');
    if (principal.requiresPasswordChange) throw new ForbiddenException('请先修改初始密码');
    const current = this.configuration.currentPrincipal(principal.accountId,principal.authorizationVersion);
    if (!current || current.role !== principal.role) throw new UnauthorizedException('登录权限已变化，请重新登录');
    if (current.requiresPasswordChange) throw new ForbiddenException('请先修改初始密码');
    if (admin && current.role !== 'admin') throw new ForbiddenException('仅系统管理员可以处理资料纠错');
    const snapshot = this.configuration.snapshot(), account = snapshot.accounts.find(row => row.id === current.accountId);
    if (!account || !account.enabled || account.deleted || account.reactivationRequired || account.permissionsRevoked || account.personnelActive === false) throw new ForbiddenException('账号当前不可办理资料纠错');
    const identity = account.personnelIdentity || (account.loginMethod === 'personnel-password' ? account.id : undefined);
    if (!admin && (!identity || (account.kind === 'local' && account.loginMethod !== 'personnel-password'))) throw new ForbiddenException('当前账号尚未关联本人档案，请联系管理员');
    return { accountId:account.id,name:account.name,identity:identity ? `${account.personnelAppId || account.appId || snapshot.appId}:${identity}` : `account:${account.id}` };
  }
}
function present({applicantIdentity:_identity,...row}:StoredArchiveCorrection):PersonnelArchiveCorrection {return structuredClone(row);}
function hash(value:unknown):string {return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function record(value:unknown):value is Record<string,unknown> {return !!value && typeof value === 'object' && !Array.isArray(value);}
function keys(value:object,allowed:string[]):boolean {return Object.getOwnPropertyNames(value).sort().join(',') === [...allowed].sort().join(',');}
function mutation(value:unknown):value is string {return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(value);}
function prose(value:unknown):string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new BadRequestException('纠错描述和处理说明需填写1至1000字');
  if (/(?<!\d)\d{17}[\dXx](?!\d)/u.test(value)) throw new BadRequestException('请勿填写完整身份证号，请仅说明需要核对的资料');
  return value.trim();
}
function identityInput(input:CancelPersonnelArchiveCorrection,allowed:string[]):void {
  if (!record(input) || !keys(input,allowed) || !mutation(input.clientMutationId) || typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId) || !Number.isSafeInteger(input.expectedRequestVersion) || input.expectedRequestVersion < 1) throw new BadRequestException('资料纠错请求无效');
}
function ownRow(state:ArchiveCorrectionsState,id:string):StoredArchiveCorrection {if (!Object.hasOwn(state.requests,id)) throw new BadRequestException('资料纠错不存在');return state.requests[id];}
function pendingVersion(row:StoredArchiveCorrection,version:number):void {if (row.status !== 'pending' || row.version !== version) throw new ConflictException('资料纠错已变化或已处理，请刷新后重试');}
function replay(state:ArchiveCorrectionsState,key:string,fingerprint:string):StoredArchiveCorrection|undefined {
  const previous = state.mutations[key];if(!previous) return undefined;
  if (previous.fingerprint !== fingerprint) throw new ConflictException('重复提交内容不一致，请重新发起');return state.requests[previous.requestId];
}
