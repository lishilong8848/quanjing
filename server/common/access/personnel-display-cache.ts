import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConfigurationPerson } from '../../../shared/access-configuration.interface';

/** A minimal display projection. Never load this file into authentication or personnel reconciliation. */
export interface PersonnelDisplaySnapshot {
  schemaVersion: 1;
  sourceKey: string;
  appId: string;
  snapshotAt: number;
  people: ConfigurationPerson[];
}
export const PERSONNEL_DISPLAY_REFRESH_MS = 15 * 60_000;
export const PERSONNEL_DISPLAY_MAX_AGE_MS = 24 * 60 * 60_000;

function project(value: unknown, sourceKey: string, now: number): PersonnelDisplaySnapshot | undefined {
  const v = value as PersonnelDisplaySnapshot;
  if (!v || v.schemaVersion !== 1 || v.sourceKey !== sourceKey || typeof v.appId !== 'string' ||
      !Number.isFinite(v.snapshotAt) || v.snapshotAt > now + 60_000 || now - v.snapshotAt > PERSONNEL_DISPLAY_MAX_AGE_MS ||
      !Array.isArray(v.people) || v.people.length > 20_000) return;
  const seen = new Set<string>(), people: ConfigurationPerson[] = [];
  for (const person of v.people) {
    if (!person || typeof person.openId !== 'string' || !/^ou_[A-Za-z0-9_-]+$/.test(person.openId) || person.openId.length > 128 ||
        typeof person.name !== 'string' || !person.name.trim() || person.name.length > 200 || seen.has(person.openId)) return;
    seen.add(person.openId); people.push({ openId: person.openId, name: person.name });
  }
  return { schemaVersion: 1, sourceKey, appId: v.appId, snapshotAt: v.snapshotAt, people };
}
function ordinaryParents(file: string): void {
  for (let p = resolve(file);;) {
    if (existsSync(p) && lstatSync(p).isSymbolicLink()) throw new Error('DISPLAY_CACHE_REPARSE_REJECTED');
    const parent = dirname(p); if (parent === p) break; p = parent;
  }
}
export class PersonnelDisplayCache {
  private memory?: PersonnelDisplaySnapshot;
  private file(): string {
    return join(dirname(resolve(process.env.ACCESS_CONFIGURATION_FILE || join(process.cwd(), '.runtime', 'access-configuration.json'))), 'personnel-display-cache.json');
  }
  read(sourceKey: string, now = Date.now()): PersonnelDisplaySnapshot | undefined {
    const cached = project(this.memory, sourceKey, now);
    if (cached) return cached;
    try {
      const file = this.file(); ordinaryParents(file);
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 5 * 1024 * 1024) return;
      const value = project(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')), sourceKey, now);
      if (value) this.memory = value;
      return value;
    } catch { return; }
  }
  write(value: PersonnelDisplaySnapshot): void {
    const safe = project(value, value.sourceKey, Date.now());
    if (!safe) throw new Error('DISPLAY_CACHE_INVALID');
    this.memory = safe;
    const file = this.file(); ordinaryParents(file); mkdirSync(dirname(file), { recursive: true }); ordinaryParents(file);
    if (existsSync(file)) { const stat = lstatSync(file); if (!stat.isFile() || stat.nlink !== 1) throw new Error('DISPLAY_CACHE_FILE_REJECTED'); }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { writeFileSync(temporary, JSON.stringify(safe), { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
}
