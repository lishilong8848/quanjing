import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveDutyDailyReportStateFilePath } from './duty-daily-report-state-path';

function archiveStatePath(name: string): string {
  return resolveDutyDailyReportStateFilePath({
    fileName: name,
    configuredDirectory:
      process.env.ATTENDANCE_AUTOMATION_STATE_DIR ||
      process.env.DUTY_DAILY_REPORT_STATE_DIR,
  });
}

let archiveWriteTail: Promise<void> = Promise.resolve();

export async function withAttendanceArchiveClaim<T>(
  write: () => Promise<T>,
): Promise<T> {
  const previous = archiveWriteTail;
  let releaseTurn!: () => void;
  archiveWriteTail = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  await previous;
  try {
    const releaseLock = claimAttendanceArchive();
    try {
      return await write();
    } finally {
      releaseLock();
    }
  } finally {
    releaseTurn();
  }
}

/** Snapshot is outside runtime dist and survives both deployment and a failed remote delete. */
export function persistAttendanceDedupBackup(snapshot: unknown): string {
  const bytes = `${JSON.stringify(snapshot)}\n`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const directory = archiveStatePath('attendance-dedup-backups');
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, `${sha256}.json`);
  if (!existsSync(destination)) {
    const temporary = `${destination}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    renameSync(temporary, destination);
  }
  if (
    createHash('sha256').update(readFileSync(destination)).digest('hex') !==
    sha256
  ) {
    throw new Error('考勤去重备份校验失败，未删除任何重复记录');
  }
  return destination;
}

export function claimAttendanceArchive(): () => void {
  const lockPath = archiveStatePath('attendance-archive-write.lock');
  const owner = { pid: process.pid, id: randomUUID() };
  mkdirSync(dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const previousBytes = readFileSync(lockPath, 'utf8');
    const previous = JSON.parse(previousBytes) as { pid: number };
    if (!Number.isSafeInteger(previous.pid) || previous.pid <= 0)
      throw new Error('考勤归档锁无效，已停止写入');
    try {
      process.kill(previous.pid, 0);
      throw new Error('已有考勤归档正在写入，本次未执行，请待该任务结束后重试');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    // Do not remove another writer's replacement lock.
    if (readFileSync(lockPath, 'utf8') !== previousBytes)
      throw new Error('考勤归档锁已变化，请稍后重试');
    unlinkSync(lockPath);
  }
  writeFileSync(lockPath, JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  return () => {
    if (
      existsSync(lockPath) &&
      JSON.parse(readFileSync(lockPath, 'utf8')).id === owner.id
    )
      unlinkSync(lockPath);
  };
}
