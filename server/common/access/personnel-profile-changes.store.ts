import { PROFILE_CHANGE_PHOTO_MAX_BYTES } from '../../../shared/personnel-profile-change.interface';
import {
  Injectable,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import {
  createProcessLockOwner,
  normalizeProcessLockOwner,
  processLockOwnerMayBeAlive,
} from '../process-lock-owner';
import type {
  ProfileChange,
  ProfileChangeField,
} from '../../../shared/personnel-profile-change.interface';
export interface ProfileSource {
  appId: string;
  appToken: string;
  tableId: string;
  recordId: string;
}
export interface ProfileChangePhoto {
  name: string;
  type: string;
  sha256: string;
  size: number;
}
export interface StoredProfileChange extends ProfileChange {
  identity: string;
  source: ProfileSource;
  fields: Partial<Record<ProfileChangeField, string>>;
  baseline: Record<string, unknown>;
  desired?: Record<string, unknown>;
  photo?: ProfileChangePhoto;
  beforePhoto?: ProfileChangePhoto;
  photoToken?: string;
  reviewerAccountId?: string;
  reviewerVersion?: number;
}
export interface ProfileChangesState {
  schemaVersion: 1;
  revision: number;
  audit: { id: string; status: string; version: number; at: string }[];
  requests: Record<string, StoredProfileChange>;
  mutations: Record<string, { fingerprint: string; id: string }>;
}
@Injectable()
export class PersonnelProfileChangesStore {
  private queue: Promise<unknown> = Promise.resolve();
  private persisted = false;
  readonly path = resolve(
    dirname(
      process.env.ACCESS_CONFIGURATION_FILE ||
        join(process.cwd(), '.runtime', 'access-configuration.json'),
    ),
    'personnel-profile-changes.json',
  );
  read(): ProfileChangesState {
    try {
      ordinary(this.path);
      if (!existsSync(this.path)) {
        if (this.persisted) throw unavailable();
        return {
          schemaVersion: 1,
          revision: 0,
          audit: [],
          requests: {},
          mutations: {},
        };
      }
      this.persisted = true;
      if (lstatSync(this.path).size > 64 * 1024 * 1024) throw unavailable();
      const value = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!validState(value)) throw unavailable();
      return value;
    } catch {
      throw unavailable();
    }
  }
  savePhoto(
    id: string,
    slot: 'before' | 'after',
    buffer: Buffer,
    type: string,
  ): ProfileChangePhoto {
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      buffer.length < 1 ||
      buffer.length > PROFILE_CHANGE_PHOTO_MAX_BYTES
    )
      throw unavailable();
    const name = `${id}-${slot}`,
      path = join(this.path + '.attachments', name);
    ordinary(path);
    mkdirSync(dirname(path), { recursive: true });
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    if (existsSync(path)) {
      if (
        createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256
      )
        throw new ConflictException('原照片内容不一致');
    } else {
      const temporary = path + '.' + randomUUID() + '.tmp';
      const fd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(fd, buffer);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(temporary, path);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
    }
    return { name, type, sha256, size: buffer.length };
  }
  readPhoto(id: string, photo: ProfileChangePhoto): Buffer {
    if (
      ![`${id}-before`, `${id}-after`].includes(photo.name) ||
      photo.size > PROFILE_CHANGE_PHOTO_MAX_BYTES
    )
      throw unavailable();
    const path = join(this.path + '.attachments', photo.name);
    ordinary(path);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size !== photo.size) throw unavailable();
    const bytes = readFileSync(path);
    if (createHash('sha256').update(bytes).digest('hex') !== photo.sha256)
      throw unavailable();
    return bytes;
  }
  async exclusiveTask(id: string, run: () => Promise<void>): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw unavailable();
    mkdirSync(dirname(this.path), { recursive: true });
    const release = acquire(`${this.path}.${id}.task.lock`);
    try {
      await run();
    } finally {
      release();
    }
  }
  mutate<T>(change: (state: ProfileChangesState) => T): Promise<T> {
    const task = this.queue.then(() => {
      ordinary(this.path);
      mkdirSync(dirname(this.path), { recursive: true });
      const release = acquire(this.path + '.lock'),
        temp = this.path + '.' + randomUUID() + '.tmp';
      try {
        const state = this.read();
        const original = JSON.stringify(state);
        const versions = new Map(
          Object.values(state.requests).map((row) => [row.id, row.version]),
        );
        const result = change(state);
        if (JSON.stringify(state) === original) return structuredClone(result);
        for (const row of Object.values(state.requests))
          if (versions.get(row.id) !== row.version)
            state.audit.push({
              id: row.id,
              status: row.status,
              version: row.version,
              at: new Date().toISOString(),
            });
        state.revision++;
        if (!validState(state)) throw unavailable();
        const bytes = Buffer.from(JSON.stringify(state));
        if (
          bytes.length > 64 * 1024 * 1024 ||
          Object.keys(state.requests).length > 10000 ||
          Object.keys(state.mutations).length > 30000
        )
          throw unavailable();
        const fd = openSync(temp, 'wx', 0o600);
        try {
          writeFileSync(fd, bytes);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        renameSync(temp, this.path);
        this.persisted = true;
        return structuredClone(result);
      } finally {
        if (existsSync(temp)) unlinkSync(temp);
        release();
      }
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
function unavailable() {
  return new ServiceUnavailableException(
    '资料变更记录暂不可用，请保留原申请重试',
  );
}
function ordinary(path: string): void {
  if (!isAbsolute(path) || path.slice(parse(path).root.length).includes(':'))
    throw unavailable();
  let cursor = resolve(path);
  while (true) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink())
      throw unavailable();
    const parent = dirname(cursor);
    if (parent === cursor) return;
    cursor = parent;
  }
}
function owner(path: string) {
  try {
    return normalizeProcessLockOwner(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}
function acquire(path: string): () => void {
  ordinary(path);
  const currentOwner = createProcessLockOwner(randomUUID());
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw unavailable();
    const previous = owner(path);
    if (
      !previous ||
      processLockOwnerMayBeAlive(previous, lstatSync(path).mtimeMs)
    )
      throw new ConflictException('资料变更正在保存，请保留原请求重试');
    const recovery = `${path}.recovery`;
    ordinary(recovery);
    let guard: number;
    try {
      guard = openSync(recovery, 'wx', 0o600);
    } catch {
      throw new ConflictException('资料变更台账正在恢复，请稍后重试');
    }
    try {
      const latest = owner(path);
      if (
        !latest ||
        latest.token !== previous.token ||
        processLockOwnerMayBeAlive(latest, lstatSync(path).mtimeMs)
      )
        throw unavailable();
      unlinkSync(path);
      fd = openSync(path, 'wx', 0o600);
    } finally {
      closeSync(guard);
      unlinkSync(recovery);
    }
  }
  try {
    writeFileSync(fd, JSON.stringify(currentOwner));
    fsyncSync(fd);
  } catch {
    closeSync(fd);
    unlinkSync(path);
    throw unavailable();
  }
  return () => {
    closeSync(fd);
    if (owner(path)?.token === currentOwner.token) unlinkSync(path);
  };
}

function validState(state: any): boolean {
  const object = (v: any) => v && typeof v === 'object' && !Array.isArray(v);
  const text = (v: any, max = 512) =>
    typeof v === 'string' && v.length > 0 && v.length <= max;
  if (
    !object(state) ||
    Object.keys(state).some(
      (k) =>
        ![
          'schemaVersion',
          'revision',
          'audit',
          'requests',
          'mutations',
        ].includes(k),
    ) ||
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    !Array.isArray(state.audit) ||
    !object(state.requests) ||
    !object(state.mutations)
  )
    return false;
  const allowed = [
    'id',
    'clientMutationId',
    'version',
    'accountId',
    'applicantName',
    'createdAt',
    'updatedAt',
    'status',
    'changes',
    'before',
    'reviewerName',
    'comment',
    'message',
    'identity',
    'source',
    'fields',
    'baseline',
    'desired',
    'photo',
    'photoToken',
    'beforePhoto',
    'reviewerAccountId',
    'reviewerVersion',
  ];
  for (const [id, r] of Object.entries(state.requests) as [string, any][]) {
    if (
      !object(r) ||
      Object.keys(r).some((k) => !allowed.includes(k)) ||
      r.id !== id ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(r.clientMutationId) ||
      !/^[a-f0-9-]{36}$/.test(id) ||
      !text(r.accountId) ||
      !text(r.applicantName, 100) ||
      !/^local-external-[a-f0-9]{64}$/.test(r.identity) ||
      !Number.isSafeInteger(r.version) ||
      r.version < 1 ||
      ![
        'pending',
        'approved',
        'uploading',
        'writing',
        'completed',
        'rejected',
        'cancelled',
        'conflict',
        'reconciliation',
      ].includes(r.status) ||
      !text(r.createdAt) ||
      !Number.isFinite(Date.parse(r.createdAt)) ||
      !text(r.updatedAt) ||
      !Number.isFinite(Date.parse(r.updatedAt))
    )
      return false;
    if (
      !object(r.source) ||
      Object.keys(r.source).sort().join(',') !==
        'appId,appToken,recordId,tableId' ||
      !Object.values(r.source).every(
        (v) => text(v) && /^[A-Za-z0-9_-]+$/.test(v as string),
      ) ||
      !r.source.recordId.startsWith('rec')
    )
      return false;
    if (
      !object(r.changes) ||
      !object(r.fields) ||
      !object(r.before) ||
      !object(r.baseline)
    )
      return false;
    const keys = Object.keys(r.changes);
    if (
      !keys.length ||
      keys.some(
        (k) =>
          !['phone', 'email', 'photo'].includes(k) ||
          !text(r.changes[k], 254) ||
          !text(r.fields[k], 100),
      ) ||
      Object.keys(r.fields).sort().join(',') !== keys.sort().join(',') ||
      Object.keys(r.before).sort().join(',') !== keys.sort().join(',')
    )
      return false;
    const fieldNames = Object.values(r.fields).sort().join(',');
    if (
      Object.keys(r.baseline).sort().join(',') !== fieldNames ||
      (r.desired &&
        (!object(r.desired) ||
          Object.keys(r.desired).sort().join(',') !== fieldNames))
    )
      return false;
    for (const [slot, photo] of [
      ['after', r.photo],
      ['before', r.beforePhoto],
    ] as const)
      if (
        photo &&
        (!object(photo) ||
          photo.name !== `${id}-${slot}` ||
          !['image/png', 'image/jpeg', 'image/webp'].includes(photo.type) ||
          !Number.isSafeInteger(photo.size) ||
          photo.size < 1 ||
          photo.size > PROFILE_CHANGE_PHOTO_MAX_BYTES ||
          !/^[a-f0-9]{64}$/.test(photo.sha256))
      )
        return false;
    if (keys.includes('photo') !== !!r.photo) return false;
  }
  for (const [key, m] of Object.entries(state.mutations) as [string, any][]) {
    if (
      !/^[a-f0-9]{64}$/.test(key) ||
      !object(m) ||
      !/^[a-f0-9]{64}$/.test(m.fingerprint) ||
      !state.requests[m.id]
    )
      return false;
  }
  return state.audit.every(
    (a: any) =>
      object(a) &&
      state.requests[a.id] &&
      text(a.status) &&
      Number.isSafeInteger(a.version) &&
      text(a.at),
  );
}
