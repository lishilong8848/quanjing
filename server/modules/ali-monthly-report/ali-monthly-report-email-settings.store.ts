import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { validMonthlyReportAuthCode, validMonthlyReportSender, type AliMonthlyReportEmailSettings, type SaveAliMonthlyReportEmailSettings } from '../../../shared/ali-monthly-report-email-settings';
import { createProcessLockOwner, normalizeProcessLockOwner, processLockOwnerMayBeAlive } from '../../common/process-lock-owner';

export const EMAIL_SETTINGS_UNAVAILABLE = '邮件发件配置不可用，已保留原文件，请联系管理员检查';
const KEY_UNAVAILABLE = '当前服务未配置安全保存密钥，暂不能保存发件配置';
const MAX_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
type ServerEmail = { senderEmail: string; authCode: string };
type StoredEmail = {
  schemaVersion: 1;
  revision: string;
  senderEmail: string;
  updatedAt: string;
  encryptedAuthCode: { iv: string; tag: string; ciphertext: string };
  lastMutation: { id: string; fingerprint: string };
};
export type ResolvedEmailSettings = ServerEmail & { settings: AliMonthlyReportEmailSettings; blockingIssue?: string };

/** Only this application's two sender fields are persisted. Legacy configuration remains read-only. */
export class AliMonthlyReportEmailSettingsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private persisted = false;
  readonly filePath: string;

  constructor(filePath = process.env.ALI_MONTHLY_REPORT_EMAIL_SETTINGS_FILE || join(process.cwd(), '.runtime', 'ali-monthly-report-email-settings.json'),
    private readonly secret: () => string = () => process.env.LOCAL_ACCESS_SESSION_SECRET?.trim() || process.env.LOCAL_ADMIN_SESSION_SECRET?.trim() || '') {
    // Path validation is deferred so a broken mail setting cannot prevent report generation or startup.
    this.filePath = filePath;
  }

  resolve(server: ServerEmail): ResolvedEmailSettings {
    try {
      const stored = this.read();
      const key = this.key();
      if (!stored) return { ...server, settings: { senderEmail: server.senderEmail || '', authCodeConfigured: Boolean(server.authCode), source: 'server',
        revision: 'server', updatedAt: null, canSave: Boolean(key), ...(!key ? { issue: KEY_UNAVAILABLE } : {}) } };
      if (!key) throw new Error('key');
      const authCode = decrypt(stored, key);
      return { senderEmail: stored.senderEmail, authCode, settings: safeSettings(stored) };
    } catch {
      return { senderEmail: '', authCode: '', blockingIssue: EMAIL_SETTINGS_UNAVAILABLE,
        settings: { senderEmail: '', authCodeConfigured: false, source: 'page', revision: 'unavailable', updatedAt: null, canSave: false, issue: EMAIL_SETTINGS_UNAVAILABLE } };
    }
  }

  async save(payload: SaveAliMonthlyReportEmailSettings, server: ServerEmail): Promise<AliMonthlyReportEmailSettings> {
    const request = normalize(payload);
    const operation = this.queue.then(() => {
      const key = this.key();
      if (!key) throw new ServiceUnavailableException(KEY_UNAVAILABLE);
      let lock: number | undefined;
      let owner: ReturnType<typeof createProcessLockOwner> | undefined;
      let temporary: string | undefined;
      const lockPath = `${this.filePath}.lock`;
      try {
        assertOrdinaryPath(this.filePath);
        mkdirSync(dirname(this.filePath), { recursive: true });
        assertOrdinaryPath(this.filePath);
        assertOrdinaryPath(lockPath);
        lock = acquireLock(lockPath);
        owner = createProcessLockOwner(randomUUID());
        writeFileSync(lock, JSON.stringify(owner));
        const current = this.read();
        const fingerprint = createHmac('sha256', key).update('email-settings-mutation-v1\0').update(JSON.stringify(request)).digest('hex');
        if (current?.lastMutation.id === request.clientMutationId) {
          if (current.lastMutation.fingerprint !== fingerprint) throw new ConflictException('请求标识已用于其他发件配置，请刷新后重试');
          decrypt(current, key);
          return safeSettings(current);
        }
        if (request.expectedRevision !== (current?.revision || 'server')) throw new ConflictException('发件配置已被其他管理员修改，已保留本次输入，请刷新后核对');
        const previous = current ? { senderEmail: current.senderEmail, authCode: decrypt(current, key) } : server;
        if (!request.authCode && request.senderEmail.toLowerCase() !== previous.senderEmail.trim().toLowerCase()) {
          throw new BadRequestException('更换发件邮箱时必须填写该邮箱的新授权码');
        }
        const authCode = request.authCode || previous.authCode;
        if (!validMonthlyReportAuthCode(authCode)) throw new BadRequestException('请填写 16 位 QQ 邮箱授权码');
        const stored: StoredEmail = { schemaVersion: 1, revision: randomUUID(), senderEmail: request.senderEmail, updatedAt: new Date().toISOString(),
          lastMutation: { id: request.clientMutationId, fingerprint }, encryptedAuthCode: { iv: '', tag: '', ciphertext: '' } };
        const nonce = randomBytes(12);
        const encryptor = createCipheriv('aes-256-gcm', key, nonce);
        encryptor.setAAD(aad(stored));
        const ciphertext = Buffer.concat([encryptor.update(authCode, 'utf8'), encryptor.final()]);
        stored.encryptedAuthCode = { iv: nonce.toString('base64'), tag: encryptor.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
        temporary = `${this.filePath}.${owner.token}.tmp`;
        assertOrdinaryPath(temporary);
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify(stored)); fsyncSync(fd); } finally { closeSync(fd); }
        assertOrdinaryPath(this.filePath);
        renameSync(temporary, this.filePath);
        temporary = undefined;
        this.persisted = true;
        return safeSettings(stored);
      } catch (error) {
        if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
        throw new ServiceUnavailableException(EMAIL_SETTINGS_UNAVAILABLE);
      } finally {
        try {
          if (temporary && existsSync(temporary)) unlinkSync(temporary);
          if (lock !== undefined) closeSync(lock);
          if (owner && readLock(lockPath)?.token === owner.token) unlinkSync(lockPath);
        } catch { throw new ServiceUnavailableException(EMAIL_SETTINGS_UNAVAILABLE); }
      }
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private key(): Buffer | null {
    const secret = this.secret();
    return secret ? createHmac('sha256', secret).update('nantong/ali-monthly-report/email-settings/aes-256-gcm/v1').digest() : null;
  }

  private read(): StoredEmail | null {
    try {
      assertOrdinaryPath(this.filePath);
      if (!existsSync(this.filePath)) { if (this.persisted) throw new Error('missing'); return null; }
      this.persisted = true;
      const value: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!validStored(value)) throw new Error('schema');
      return value;
    } catch { throw new ServiceUnavailableException(EMAIL_SETTINGS_UNAVAILABLE); }
  }
}

function safeSettings(value: StoredEmail): AliMonthlyReportEmailSettings {
  return { senderEmail: value.senderEmail, authCodeConfigured: true, source: 'page', revision: value.revision, updatedAt: value.updatedAt, canSave: true };
}
function aad(value: StoredEmail): Buffer {
  return Buffer.from(JSON.stringify([value.schemaVersion, value.revision, value.senderEmail, value.updatedAt, value.lastMutation]));
}
function decrypt(value: StoredEmail, key: Buffer): string {
  const encrypted = value.encryptedAuthCode;
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAAD(aad(value));
  decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'));
  const authCode = Buffer.concat([decipher.update(Buffer.from(encrypted.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  if (!validMonthlyReportAuthCode(authCode)) throw new Error('decrypted-value');
  return authCode;
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, fields: string[]): boolean { return Object.getOwnPropertyNames(value).sort().join(',') === [...fields].sort().join(','); }
function validStored(value: unknown): value is StoredEmail {
  if (!record(value) || !exactKeys(value, ['schemaVersion', 'revision', 'senderEmail', 'updatedAt', 'encryptedAuthCode', 'lastMutation']) || value.schemaVersion !== 1 ||
    typeof value.revision !== 'string' || !UUID.test(value.revision) || !validMonthlyReportSender(value.senderEmail) ||
    typeof value.updatedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.updatedAt) || !Number.isFinite(Date.parse(value.updatedAt)) ||
    !record(value.encryptedAuthCode) || !exactKeys(value.encryptedAuthCode, ['iv', 'tag', 'ciphertext']) || !record(value.lastMutation) || !exactKeys(value.lastMutation, ['id', 'fingerprint'])) return false;
  const encrypted = value.encryptedAuthCode;
  return typeof value.lastMutation.id === 'string' && /^[A-Za-z0-9._:-]{8,100}$/.test(value.lastMutation.id) &&
    typeof value.lastMutation.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.lastMutation.fingerprint) &&
    [['iv', 12], ['tag', 16], ['ciphertext', 16]].every(([field, length]) => {
      const data = encrypted[String(field)];
      return typeof data === 'string' && Buffer.from(data, 'base64').length === length && Buffer.from(data, 'base64').toString('base64') === data;
    });
}
function normalize(value: unknown): SaveAliMonthlyReportEmailSettings {
  if (!record(value) || Object.getOwnPropertyNames(value).some(key => !['senderEmail', 'authCode', 'expectedRevision', 'clientMutationId'].includes(key)) ||
    !['senderEmail', 'expectedRevision', 'clientMutationId'].every(key => Object.hasOwn(value, key)) || typeof value.senderEmail !== 'string' ||
    typeof value.expectedRevision !== 'string' || (value.expectedRevision !== 'server' && !UUID.test(value.expectedRevision)) ||
    typeof value.clientMutationId !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(value.clientMutationId)) throw new BadRequestException('发件配置请求格式无效，请刷新页面后重试');
  const senderEmail = value.senderEmail.trim().toLowerCase();
  if (!validMonthlyReportSender(senderEmail)) throw new BadRequestException('请填写有效的发件邮箱');
  if (Object.hasOwn(value, 'authCode') && value.authCode !== undefined && typeof value.authCode !== 'string') throw new BadRequestException('请填写 16 位 QQ 邮箱授权码');
  const authCode = typeof value.authCode === 'string' ? value.authCode.trim() : '';
  if (authCode && !validMonthlyReportAuthCode(authCode)) throw new BadRequestException('请填写 16 位 QQ 邮箱授权码');
  return { senderEmail, ...(authCode ? { authCode } : {}), expectedRevision: value.expectedRevision, clientMutationId: value.clientMutationId };
}
function assertOrdinaryPath(file: string): void {
  if (!isAbsolute(file) || file.slice(parse(file).root.length).includes(':') || /[\x00-\x1f]/.test(file)) throw new Error('path');
  const full = resolve(file);
  for (let current = full; ; current = dirname(current)) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() || realpathSync.native(current).toLowerCase() !== current.toLowerCase()) throw new Error('link');
      if (current === full ? !info.isFile() || info.nlink !== 1 || info.size > MAX_BYTES : !info.isDirectory()) throw new Error('file');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (dirname(current) === current) break;
  }
}
function readLock(file: string) {
  try { assertOrdinaryPath(file); return normalizeProcessLockOwner(JSON.parse(readFileSync(file, 'utf8'))); } catch { return null; }
}
function acquireLock(file: string): number {
  try { return openSync(file, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = readLock(file);
    if (!owner || processLockOwnerMayBeAlive(owner, lstatSync(file).mtimeMs)) throw new ConflictException('发件配置正在保存，请稍后重试');
    const recovery = `${file}.recovery`;
    assertOrdinaryPath(recovery);
    let guard: number;
    try { guard = openSync(recovery, 'wx', 0o600); } catch { throw new ConflictException('发件配置锁正在恢复，请稍后重试'); }
    try {
      const current = readLock(file);
      if (!current || current.token !== owner.token || processLockOwnerMayBeAlive(current, lstatSync(file).mtimeMs)) throw new ConflictException('发件配置正在保存，请稍后重试');
      unlinkSync(file);
      return openSync(file, 'wx', 0o600);
    } finally { closeSync(guard); unlinkSync(recovery); }
  }
}
