import { HttpService } from '@nestjs/axios';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { isValidIdentityNumber } from '../../modules/bitable-sync/employee-onboarding.rules';
import { AccessConfigurationService } from './access-configuration.service';
import type { StoredAccount } from './access-configuration.store';
import { buildExternalEmployeeCredentials } from './external-employee-directory';
import { parsePersonnelPasswordHash, verifyPersonnelPassword } from './personnel-password';
import { PersonnelCredentialsGateway, type PersonnelCredentialRecord } from './personnel-credentials.gateway';
import { PersonnelSecurityStore, personnelFingerprint, type PersonnelPasswordIntent } from './personnel-security.store';

export interface PersonnelPasswordChange {
  currentPassword: string; newPassword: string; confirmPassword: string; clientMutationId: string;
}
export interface PersonnelPasswordReset {
  employeeName: string; identityNumber: string; newPassword: string; confirmPassword: string; clientMutationId: string;
}

@Injectable()
export class PersonnelCredentialsService {
  private active = 0;
  private waiting: Array<() => void> = [];
  private attempts = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    // Retained as an explicit dependency for the access module; gateway owns all outbound requests.
    private readonly http: HttpService,
    private readonly configuration: AccessConfigurationService,
    private readonly security: PersonnelSecurityStore,
    private readonly gateway: PersonnelCredentialsGateway,
  ) {}

  async authenticateLogin(principal: AccessPrincipal, password: string, source = 'internal'): Promise<AccessPrincipal> {
    const sourceKey = `login-ip:${personnelFingerprint(String(source).slice(0, 256))}`;
    const accountKey = `login-account:${personnelFingerprint(principal.accountId || 'unknown')}`;
    return this.bounded(async () => {
      this.checkRate(sourceKey, 40); this.checkRate(accountKey, 10);
      let account: StoredAccount;
      try { account = this.eligible(principal, false).account; } catch (error) {
        if (!(error instanceof ForbiddenException)) throw error;
        this.rate(sourceKey, 40); this.rate(accountKey, 10); throw invalidLogin();
      }
      return this.security.withAccountLock(account.id, async () => {
        this.checkRate(sourceKey, 40); this.checkRate(accountKey, 10);
        const current = this.local(account.id);
        const record = await this.source(current).catch(error => {
          if (error instanceof UnauthorizedException) { this.rate(sourceKey, 40); this.rate(accountKey, 10); }
          throw error;
        });
        if (!await this.matchesSource(password, record)) {
          this.rate(sourceKey, 40); this.rate(accountKey, 10); throw invalidLogin();
        }
        const initial = isInitial(record);
        let result = principal;
        let newHash = record.password;
        const pending = Object.entries(this.security.read().intents).find(([, item]) => item.accountId === current.id &&
          ['prepared', 'written'].includes(item.status) && item.newHash === record.password);
        if (!parsePersonnelPasswordHash(newHash)) {
          // Preserve the directory's stable per-record scrypt derivation for legacy and initial credentials.
          const credentials = await buildExternalEmployeeCredentials([{ record_id: record.recordId, fields: {
            姓名: record.name, 密码: record.password, 身份证号: record.identityNumber, '离职/异动情况': false,
          } }], record.appId, record.appToken, record.tableId);
          newHash = credentials[0]?.passwordHash || '';
          if (!newHash) throw invalidLogin();
        }
        if (pending) {
          // A previous response may have been lost after the remote write. A fresh successful
          // login with that new password can finish the same local transaction safely.
          result = await this.configuration.commitPersonnelPassword(current.id, current.passwordHash || '', newHash, pending[1].mutationId);
          this.security.update(state => { state.intents[pending[0]].status = 'completed'; });
        } else if (current.passwordHash !== newHash) {
          result = await this.configuration.commitPersonnelPassword(current.id, current.passwordHash || '', newHash,
            `source-${personnelFingerprint(JSON.stringify([current.id, current.version, newHash]))}`);
        } else {
          result = this.configuration.currentPrincipal(current.id, current.version) || (() => { throw invalidLogin(); })();
        }
        this.setRequired(current.id, initial);
        this.attempts.delete(accountKey);
        return result;
      });
    });
  }

  async checkLogin(principal: AccessPrincipal, password: string): Promise<void> {
    await this.authenticateLogin(principal, password);
  }

  requiresPasswordChange(principal: AccessPrincipal): boolean {
    const raw = principal.accountId ? this.configuration.getPersonnelCredentialAccount(principal.accountId) : null;
    const id = raw?.kind === 'feishu' ? raw.personnelIdentity : raw?.loginMethod === 'personnel-password' ? raw.id : undefined;
    // Shared recovery administrators are not personnel password accounts. Their
    // sessions must remain available to repair a damaged personnel-only ledger.
    return !!id && /^local-external-[a-f0-9]{64}$/.test(id) && this.security.read().accounts[id]?.requiresPasswordChange === true;
  }

  async profile(principal: AccessPrincipal): Promise<{ canChangePassword: boolean; requiresPasswordChange: boolean }> {
    if (principal.impersonation) return { canChangePassword: false, requiresPasswordChange: false };
    try {
      this.eligible(principal);
      return { canChangePassword: true, requiresPasswordChange: this.requiresPasswordChange(principal) };
    } catch (error) {
      if (error instanceof ForbiddenException) return { canChangePassword: false, requiresPasswordChange: false };
      throw error;
    }
  }

  async changePassword(principal: AccessPrincipal, request: PersonnelPasswordChange): Promise<AccessPrincipal> {
    validateRequest(request);
    const { account } = this.eligible(principal);
    this.rate(`change:${account.id}`, 10);
    return this.bounded(() => this.security.withAccountLock(account.id, async () => {
      const { account: current, raw } = this.eligible(principal);
      const source = await this.source(current);
      const result = await this.execute(current, source, 'change', request, async () => {
        if (!await this.matchesSource(request.currentPassword, source)) throw new BadRequestException('当前密码不正确');
      });
      if (raw.id === current.id) return result;
      const refreshed = this.configuration.getPersonnelCredentialAccount(raw.id);
      const principalNow = refreshed && this.configuration.currentPrincipal(raw.id, refreshed.version);
      if (!principalNow) throw new ForbiddenException('账号状态已变化，请重新登录');
      return principalNow;
    }));
  }

  async resetPassword(request: PersonnelPasswordReset, source: string): Promise<void> {
    if (!request || typeof request.employeeName !== 'string' || typeof request.identityNumber !== 'string' ||
      typeof source !== 'string' || !source || source.length > 256) throw invalidReset();
    const name = request.employeeName.trim();
    this.rate(`reset-ip:${personnelFingerprint(source)}`, 30);
    this.rate(`reset-name:${personnelFingerprint(name)}`, 8);
    validateRequest(request);
    const identity = request.identityNumber.trim().toUpperCase();
    if (!name || name.length > 100 || !isValidIdentityNumber(identity)) throw invalidReset();
    await this.bounded(async () => {
      const record = await this.gateway.findActive(name);
      if (!record || !safeEqual(record.identityNumber, identity)) throw invalidReset();
      let account: StoredAccount;
      try { account = this.local(record.accountId); } catch { throw invalidReset(); }
      await this.security.withAccountLock(account.id, async () => {
        let fresh = await this.gateway.findActive(name);
        if (!fresh || fresh.accountId !== account.id || !safeEqual(fresh.identityNumber, identity)) throw invalidReset();
        let current: StoredAccount;
        try { current = this.local(account.id); } catch { throw invalidReset(); }
        fresh = await this.reconcileForVerifiedReset(current, fresh, request);
        // Completing an earlier remote write can advance the local credential version.
        try { current = this.local(account.id); } catch { throw invalidReset(); }
        await this.execute(current, fresh, 'reset', request, async () => undefined);
      });
    });
  }

  /** Only called after full identity/source verification, while holding the account lock. */
  private async reconcileForVerifiedReset(account: StoredAccount, source: PersonnelCredentialRecord,
    request: PersonnelPasswordReset): Promise<PersonnelCredentialRecord> {
    const state = this.security.read(), ownKey = personnelFingerprint(`${account.id}\0${request.clientMutationId}`);
    const own = state.intents[ownKey];
    if (own && (own.kind !== 'reset' || own.status === 'conflict' ||
      own.requestFingerprint !== requestFingerprint(own.newHash, 'reset', account.id, request))) {
      throw new ConflictException('原请求标识已用于不同内容或已结束，请重新提交');
    }
    // A replay resumes only itself; it must not terminate a newer unrelated reset.
    if (own) return source;
    const pending = Object.entries(state.intents).filter(([key, intent]) => key !== ownKey &&
      intent.accountId === account.id && ['prepared', 'written'].includes(intent.status));
    if (!pending.length) return source;
    const fresh = await this.gateway.fresh(source);
    for (const [key, intent] of pending) {
      const current = this.local(account.id);
      if (fresh.password === intent.newHash) {
        // Finish the confirmed prior write with its original receipt before starting a new reset.
        await this.configuration.commitPersonnelPassword(current.id, current.passwordHash || '', intent.newHash, intent.mutationId);
        this.security.update(next => {
          next.intents[key].status = 'completed';
          next.accounts[account.id] = { requiresPasswordChange: false, updatedAt: Date.now() };
        });
      } else {
        // A fresh source value (whether unchanged or changed elsewhere) supersedes the
        // unresolved request. Never restore its previous value or replay its remote PUT.
        this.security.update(next => { next.intents[key].status = 'conflict'; });
      }
    }
    return fresh;
  }

  private async execute(account: StoredAccount, source: PersonnelCredentialRecord, kind: 'change' | 'reset',
    request: PersonnelPasswordChange | PersonnelPasswordReset, authenticate: () => Promise<void>): Promise<AccessPrincipal> {
    const key = personnelFingerprint(`${account.id}\0${request.clientMutationId}`);
    let intent = this.security.read().intents[key];
    if (intent) {
      if (intent.kind !== kind || intent.requestFingerprint !== requestFingerprint(intent.newHash, kind, account.id, request)) {
        throw new ConflictException('原请求标识已用于不同内容，请重新提交');
      }
      if (intent.status === 'conflict') throw new ConflictException('密码来源已变化，请核对后使用新请求重新提交');
    } else {
      // Never let another mutation overwrite an unresolved remote write/local commit.
      if (Object.values(this.security.read().intents).some(item => item.accountId === account.id && ['prepared', 'written'].includes(item.status))) {
        throw new ConflictException('上次密码处理结果待核对，请使用原请求重试');
      }
      await authenticate();
      if (await this.matchesSource(request.newPassword, source) ||
        safeEqual(request.newPassword.trim().toUpperCase(), source.identityNumber) ||
        (isValidIdentityNumber(source.identityNumber) && safeEqual(request.newPassword.trim().toUpperCase(), source.identityNumber.slice(-6)))) {
        throw new BadRequestException('新密码不能与当前密码或身份证号码相同');
      }
      const newHash = await hashPassword(request.newPassword);
      intent = {
        accountId: account.id, mutationId: request.clientMutationId, kind,
        requestFingerprint: requestFingerprint(newHash, kind, account.id, request),
        expectedLocalHashFingerprint: personnelFingerprint(account.passwordHash || ''),
        previousSourceFingerprint: sourcePasswordFingerprint(source.password), newHash, status: 'prepared', createdAt: Date.now(),
      };
      this.security.update(state => { state.intents[key] = intent; });
    }
    const current = this.local(account.id);
    if (personnelFingerprint(current.passwordHash || '') !== intent.expectedLocalHashFingerprint && current.passwordHash !== intent.newHash) {
      this.conflict(key);
    }
    let fresh = await this.gateway.fresh(source);
    if (intent.status === 'completed') {
      if (fresh.password !== intent.newHash || current.passwordHash !== intent.newHash) throw new ConflictException('密码已再次变更，请使用当前密码重新登录');
      return this.configuration.currentPrincipal(current.id, current.version) || (() => { throw invalidLogin(); })();
    }
    if (fresh.password !== intent.newHash) {
      if (intent.status === 'written' || sourcePasswordFingerprint(fresh.password) !== intent.previousSourceFingerprint) this.conflict(key);
      this.local(account.id); // Recheck current revocation immediately before external write.
      try { await this.gateway.writePassword(fresh, intent.newHash); }
      catch { /* An upstream timeout is not proof of failure: always read back before retrying. */ }
      fresh = await this.gateway.fresh(source);
      if (fresh.password !== intent.newHash) {
        if (sourcePasswordFingerprint(fresh.password) !== intent.previousSourceFingerprint) this.conflict(key);
        throw new ServiceUnavailableException('密码更新结果尚未确认，请保留原请求重试');
      }
    }
    this.security.update(state => { state.intents[key].status = 'written'; });
    const eligible = this.local(account.id);
    if (personnelFingerprint(eligible.passwordHash || '') !== intent.expectedLocalHashFingerprint && eligible.passwordHash !== intent.newHash) this.conflict(key);
    const result = await this.configuration.commitPersonnelPassword(account.id, eligible.passwordHash || '', intent.newHash, request.clientMutationId);
    this.security.update(state => {
      state.intents[key].status = 'completed';
      state.accounts[account.id] = { requiresPasswordChange: false, updatedAt: Date.now() };
    });
    return result;
  }

  private eligible(principal: AccessPrincipal, checkVersion = true): { account: StoredAccount; raw: StoredAccount } {
    if (principal.impersonation || !principal.accountId) throw forbidden();
    const raw = this.configuration.getPersonnelCredentialAccount(principal.accountId);
    if (!raw || !this.configuration.personnelCredentialEligible(raw.id) ||
      !raw.enabled || raw.deleted || raw.personnelActive === false || raw.reactivationRequired || raw.personnelSuspended ||
      (checkVersion && principal.authorizationVersion !== raw.version)) throw forbidden();
    const id = raw.kind === 'feishu' ? raw.personnelIdentity : raw.id;
    if (!id) throw forbidden();
    return { account: this.local(id), raw };
  }
  private local(id: string): StoredAccount {
    const account = this.configuration.getPersonnelCredentialAccount(id);
    if (!account || !/^local-external-[a-f0-9]{64}$/.test(account.id) || account.kind !== 'local' ||
      account.loginMethod !== 'personnel-password' || !account.enabled || account.deleted || account.personnelActive === false ||
      account.reactivationRequired || account.personnelSuspended || !this.configuration.personnelCredentialEligible(id)) throw forbidden();
    return account;
  }
  private async source(account: StoredAccount): Promise<PersonnelCredentialRecord> {
    const source = await this.gateway.findActive(account.name);
    if (!source || source.accountId !== account.id || (account.personnelAppId && account.personnelAppId !== source.appId)) throw invalidLogin();
    return source;
  }
  private async matchesSource(password: unknown, record: PersonnelCredentialRecord): Promise<boolean> {
    if (typeof password !== 'string' || Array.from(password).length > 128 || Buffer.from(password).toString('utf8') !== password) return false;
    if (parsePersonnelPasswordHash(record.password)) return verifyPersonnelPassword(password, record.password);
    // Malformed encoded credentials never fall back to the identity number or plain text.
    if (/^[A-Za-z0-9_]+\$/u.test(record.password.trimStart())) return false;
    if (isInitial(record)) return safeEqual(password.trim().toUpperCase(), record.identityNumber.slice(-6));
    if (Array.from(record.password).length === 6) return false;
    return record.password.length > 0 && safeEqual(password, record.password);
  }
  private setRequired(accountId: string, required: boolean): void {
    if (this.security.read().accounts[accountId]?.requiresPasswordChange === required) return;
    this.security.update(state => { state.accounts[accountId] = { requiresPasswordChange: required, updatedAt: Date.now() }; });
  }
  private conflict(key: string): never {
    this.security.update(state => { state.intents[key].status = 'conflict'; });
    throw new ConflictException('密码来源已变化，请核对后重新提交');
  }
  private rate(key: string, limit: number): void {
    this.checkRate(key, limit);
    const now = Date.now();
    const bucket = this.attempts.get(key) || { count: 0, expiresAt: now + 15 * 60_000 };
    bucket.count++;
    this.attempts.set(key, bucket);
  }
  private checkRate(key: string, limit: number): void {
    const now = Date.now();
    for (const [storedKey, bucket] of this.attempts) if (bucket.expiresAt <= now) this.attempts.delete(storedKey);
    if ((this.attempts.get(key)?.count || 0) >= limit || (!this.attempts.has(key) && this.attempts.size >= 10_000)) throw new HttpException('尝试次数较多，请稍后重试', 429);
  }
  private async bounded<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= 2) {
      if (this.waiting.length >= 20) throw new HttpException('密码服务繁忙，请稍后重试', 429);
      await new Promise<void>((resolve, reject) => {
        const resume = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          const index = this.waiting.indexOf(resume);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new HttpException('密码服务等待超时，请保留原请求重试', 429));
        }, 15_000);
        this.waiting.push(resume);
      });
    } else this.active++;
    try { return await work(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
}
function validateRequest(request: PersonnelPasswordChange | PersonnelPasswordReset): void {
  if (!request || typeof request.newPassword !== 'string' || typeof request.confirmPassword !== 'string' ||
    typeof request.clientMutationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(request.clientMutationId)) throw new BadRequestException('密码请求格式无效');
  if (request.newPassword !== request.confirmPassword) throw new BadRequestException('两次输入的新密码不一致');
  if (Array.from(request.newPassword.trim()).length < 8 || Array.from(request.newPassword).length > 128 ||
    Buffer.from(request.newPassword).toString('utf8') !== request.newPassword) throw new BadRequestException('新密码需为 8 至 128 个字符');
  if ('currentPassword' in request && typeof request.currentPassword !== 'string') throw new BadRequestException('请输入当前密码');
}
function isInitial(record: PersonnelCredentialRecord): boolean {
  if (!isValidIdentityNumber(record.identityNumber)) return false;
  return record.password === '' || (/^[0-9]{5}[0-9Xx]$/.test(record.password) && record.password.toUpperCase() === record.identityNumber.slice(-6));
}
function safeEqual(a: string, b: string): boolean {
  const first = Buffer.from(a), second = Buffer.from(b);
  return first.length === second.length && timingSafeEqual(first, second);
}
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => pbkdf2(password, salt, 600000, 32, 'sha256', (error, key) => error ? reject(error) : resolve(key)));
  const encode = (bytes: Buffer) => bytes.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  return `pbkdf2_sha256$600000$${encode(salt)}$${encode(derived)}`;
}
function requestFingerprint(newHash: string, kind: string, accountId: string, request: PersonnelPasswordChange | PersonnelPasswordReset): string {
  return createHmac('sha256', fingerprintKey()).update(JSON.stringify([newHash, kind, accountId, request.clientMutationId, request.newPassword,
    'currentPassword' in request ? request.currentPassword : [request.employeeName.trim(), request.identityNumber.trim().toUpperCase()]] )).digest('hex');
}
function sourcePasswordFingerprint(value: string): string {
  return createHmac('sha256', fingerprintKey()).update(`source-password\0${value}`).digest('hex');
}
function fingerprintKey(): Buffer {
  const encoded = (process.env.LOCAL_ACCESS_SESSION_SECRET || process.env.LOCAL_ADMIN_SESSION_SECRET || '').trim();
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) throw new ServiceUnavailableException('密码安全配置暂不可用');
  return key;
}
function invalidReset() { return new BadRequestException('人员身份核验未通过，暂不能重置密码'); }
function invalidLogin() { return new UnauthorizedException('登录凭据无效'); }
function forbidden() { return new ForbiddenException('当前账号不可修改人员密码'); }
