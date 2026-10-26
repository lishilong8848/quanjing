import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readEnv } from '../../common/config/external-services.config';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import {
  TRAINING_TABLE_CONFIGS,
  getTrainingTableId,
  type TrainingSourceKey,
} from './training-dashboard.fields';
import type { TrainingDashboardSources } from './training-dashboard.mapper';

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILE_NAME = 'training-dashboard-sources-v1.json';

interface TrainingDashboardSourceSnapshot {
  version: 1;
  savedAt: string;
  configSignature: string;
  sources: TrainingDashboardSources;
}

let writeTail: Promise<void> = Promise.resolve();
let tempFileSequence = 0;

export function writeTrainingDashboardSourceSnapshot(
  sources: TrainingDashboardSources,
): Promise<void> {
  let payload: string;
  try {
    if (!isCompleteSources(sources)) {
      throw new Error('invalid training dashboard source snapshot');
    }
    payload = JSON.stringify({
      version: SNAPSHOT_VERSION,
      savedAt: new Date().toISOString(),
      configSignature: buildConfigSignature(),
      sources,
    } satisfies TrainingDashboardSourceSnapshot);
  } catch {
    return Promise.reject(
      new Error('training dashboard source snapshot serialization failed'),
    );
  }

  const operation = writeTail.then(() => persistSnapshot(payload));
  writeTail = operation.catch(() => undefined);
  return operation;
}

export async function readTrainingDashboardSourceSnapshot(): Promise<TrainingDashboardSources | null> {
  try {
    const payload = JSON.parse(
      await readFile(getSnapshotPath(), 'utf8'),
    ) as unknown;
    if (!isValidSnapshot(payload)) return null;
    return payload.sources;
  } catch {
    return null;
  }
}

async function persistSnapshot(payload: string): Promise<void> {
  const cacheDirectory = getCacheDirectory();
  const snapshotPath = join(cacheDirectory, SNAPSHOT_FILE_NAME);
  const tempPath = join(
    cacheDirectory,
    `${SNAPSHOT_FILE_NAME}.tmp-${process.pid}-${Date.now()}-${(tempFileSequence += 1)}`,
  );
  await mkdir(cacheDirectory, { recursive: true });
  try {
    await writeFile(tempPath, payload, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, snapshotPath);
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}

function getSnapshotPath(): string {
  return join(getCacheDirectory(), SNAPSHOT_FILE_NAME);
}

function getCacheDirectory(): string {
  const configured = readEnv('FEISHU_LOCAL_CACHE_DIR');
  return resolve(
    configured || join(process.cwd(), 'data', 'feishu-bitable-cache'),
  );
}

function buildConfigSignature(): string {
  return JSON.stringify(
    TRAINING_TABLE_CONFIGS.map((config) => ({
      key: config.key,
      tableId: getTrainingTableId(config),
      fieldNames: normalizeFieldNames(config.fieldNames),
    })).sort((left, right) => left.key.localeCompare(right.key)),
  );
}

function normalizeFieldNames(fieldNames: readonly string[]): string[] {
  return [
    ...new Set(fieldNames.map((fieldName) => fieldName.trim()).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right));
}

function isValidSnapshot(
  value: unknown,
): value is TrainingDashboardSourceSnapshot {
  if (!isPlainObject(value)) return false;
  return (
    value.version === SNAPSHOT_VERSION &&
    typeof value.savedAt === 'string' &&
    Number.isFinite(Date.parse(value.savedAt)) &&
    value.configSignature === buildConfigSignature() &&
    isCompleteSources(value.sources)
  );
}

function isCompleteSources(value: unknown): value is TrainingDashboardSources {
  if (!isPlainObject(value)) return false;
  const expectedKeys = TRAINING_TABLE_CONFIGS.map(({ key }) => key).sort();
  const actualKeys = Object.keys(value).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    return false;
  }
  return expectedKeys.every((key) => {
    const records = value[key as TrainingSourceKey];
    return Array.isArray(records) && records.every(isBitableRecordItem);
  });
}

function isBitableRecordItem(value: unknown): value is BitableRecordItem {
  if (!isPlainObject(value)) return false;
  if (value.id !== undefined && typeof value.id !== 'string') return false;
  if (value.record_id !== undefined && typeof value.record_id !== 'string') {
    return false;
  }
  if (value.fields !== undefined && !isPlainObject(value.fields)) return false;
  if (
    value.created_time !== undefined &&
    (typeof value.created_time !== 'number' ||
      !Number.isFinite(value.created_time))
  ) {
    return false;
  }
  if (
    value.last_modified_time !== undefined &&
    (typeof value.last_modified_time !== 'number' ||
      !Number.isFinite(value.last_modified_time))
  ) {
    return false;
  }
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
