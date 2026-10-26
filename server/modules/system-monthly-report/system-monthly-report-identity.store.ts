import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export const SYSTEM_MONTHLY_REPORT_IDENTITY_TTL_MS = 12 * 60 * 60 * 1000;

interface IdentitySessionEntry {
  id: string;
  personId: string;
  tokenHash: string;
  issuedAt: number;
  expiresAt: number;
}

interface IdentitySessionFile {
  version: 1;
  sessions: IdentitySessionEntry[];
}

export interface SystemMonthlyReportIdentitySession {
  personId: string;
  principalFingerprint: string;
  legacyPrincipalFingerprints: string[];
  expiresAt: number;
}

export class SystemMonthlyReportIdentityStore {
  private sessions: IdentitySessionEntry[];

  constructor(private readonly filePath: string) {
    this.sessions = this.load();
  }

  issue(
    personId: string,
    now = Date.now(),
  ): {
    token: string;
    expiresAt: number;
    principalFingerprint: string;
  } {
    if (!/^person_[a-f0-9]{16,64}$/u.test(personId)) {
      throw new Error('体系月报人员标识无效');
    }
    this.prune(now);
    const token = randomBytes(32).toString('base64url');
    const tokenHash = sha256(token);
    const entry: IdentitySessionEntry = {
      id: randomUUID(),
      personId,
      tokenHash,
      issuedAt: now,
      expiresAt: now + SYSTEM_MONTHLY_REPORT_IDENTITY_TTL_MS,
    };
    this.sessions.push(entry);
    this.persist();
    return {
      token,
      expiresAt: entry.expiresAt,
      principalFingerprint: stableFingerprint(entry.personId),
    };
  }

  resolve(
    token: string,
    now = Date.now(),
  ): SystemMonthlyReportIdentitySession | null {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
    const tokenHash = sha256(token);
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((entry) => entry.expiresAt > now);
    if (this.sessions.length !== before) this.persist();
    const entry = this.sessions.find((candidate) =>
      secureEqual(candidate.tokenHash, tokenHash),
    );
    return entry
      ? {
          personId: entry.personId,
          principalFingerprint: stableFingerprint(entry.personId),
          legacyPrincipalFingerprints: this.sessions
            .filter((candidate) => candidate.personId === entry.personId)
            .map(legacyFingerprint),
          expiresAt: entry.expiresAt,
        }
      : null;
  }

  revoke(token: string): boolean {
    if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return false;
    const tokenHash = sha256(token);
    const before = this.sessions.length;
    this.sessions = this.sessions.filter(
      (entry) => !secureEqual(entry.tokenHash, tokenHash),
    );
    if (this.sessions.length === before) return false;
    this.persist();
    return true;
  }

  private prune(now: number): void {
    this.sessions = this.sessions.filter((entry) => entry.expiresAt > now);
  }

  private load(): IdentitySessionEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(
        readFileSync(this.filePath, 'utf8'),
      ) as IdentitySessionFile;
      return parsed.version === 1 && Array.isArray(parsed.sessions)
        ? parsed.sessions.filter(isIdentitySessionEntry)
        : [];
    } catch (error) {
      throw new Error(
        `无法读取体系月报人员会话：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporaryPath,
        JSON.stringify({
          version: 1,
          sessions: this.sessions,
        } satisfies IdentitySessionFile),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 },
      );
      renameSync(temporaryPath, this.filePath);
    } catch (error) {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
      throw error;
    }
  }
}

function legacyFingerprint(entry: IdentitySessionEntry): string {
  return `smr-person:${sha256(`${entry.id}\u001f${entry.personId}`).slice(0, 32)}`;
}

function stableFingerprint(personId: string): string {
  return `smr-person:${sha256(`stable\u001f${personId}`).slice(0, 32)}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function isIdentitySessionEntry(value: unknown): value is IdentitySessionEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<IdentitySessionEntry>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.personId === 'string' &&
    /^person_[a-f0-9]{16,64}$/u.test(entry.personId) &&
    typeof entry.tokenHash === 'string' &&
    /^[a-f0-9]{64}$/u.test(entry.tokenHash) &&
    typeof entry.issuedAt === 'number' &&
    Number.isFinite(entry.issuedAt) &&
    typeof entry.expiresAt === 'number' &&
    Number.isFinite(entry.expiresAt) &&
    entry.expiresAt > entry.issuedAt
  );
}
