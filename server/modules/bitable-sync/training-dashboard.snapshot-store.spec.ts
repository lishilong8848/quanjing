import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import {
  TRAINING_TABLE_CONFIGS,
  type TrainingSourceKey,
} from './training-dashboard.fields';
import type { TrainingDashboardSources } from './training-dashboard.mapper';
import {
  readTrainingDashboardSourceSnapshot,
  writeTrainingDashboardSourceSnapshot,
} from './training-dashboard.snapshot-store';

const SNAPSHOT_FILE_NAME = 'training-dashboard-sources-v1.json';

function completeSources(label: string): TrainingDashboardSources {
  return Object.fromEntries(
    TRAINING_TABLE_CONFIGS.map(({ key }) => [
      key,
      [
        {
          record_id: `rec-${label}-${key}`,
          fields: { marker: label },
          last_modified_time: 1_752_796_800_000,
        } satisfies BitableRecordItem,
      ],
    ]),
  ) as Record<TrainingSourceKey, BitableRecordItem[]>;
}

describe('training-dashboard.snapshot-store', () => {
  const originalCacheDir = process.env.FEISHU_LOCAL_CACHE_DIR;
  let cacheDir: string;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'training-dashboard-store-'));
    process.env.FEISHU_LOCAL_CACHE_DIR = cacheDir;
  });

  afterEach(async () => {
    if (originalCacheDir === undefined) {
      delete process.env.FEISHU_LOCAL_CACHE_DIR;
    } else {
      process.env.FEISHU_LOCAL_CACHE_DIR = originalCacheDir;
    }
    await rm(cacheDir, { recursive: true, force: true });
  });

  it('round-trips one complete nine-source snapshot', async () => {
    const sources = completeSources('roundtrip');

    await writeTrainingDashboardSourceSnapshot(sources);

    await expect(readTrainingDashboardSourceSnapshot()).resolves.toEqual({
      sources,
      savedAt: expect.any(String),
    });
    const persisted = JSON.parse(
      await readFile(join(cacheDir, SNAPSHOT_FILE_NAME), 'utf8'),
    ) as Record<string, unknown>;
    expect(persisted).toEqual(
      expect.objectContaining({
        version: 1,
        savedAt: expect.any(String),
        configSignature: expect.any(String),
        sources,
      }),
    );
  });

  it('returns null for corrupt JSON, an incomplete source set, or a stale config signature', async () => {
    const snapshotPath = join(cacheDir, SNAPSHOT_FILE_NAME);
    await writeFile(snapshotPath, '{broken-json', 'utf8');
    await expect(readTrainingDashboardSourceSnapshot()).resolves.toBeNull();

    await writeTrainingDashboardSourceSnapshot(completeSources('partial'));
    const incomplete = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
      sources: Partial<Record<TrainingSourceKey, BitableRecordItem[]>>;
    };
    delete incomplete.sources.activeStats;
    await writeFile(snapshotPath, JSON.stringify(incomplete), 'utf8');
    await expect(readTrainingDashboardSourceSnapshot()).resolves.toBeNull();

    await writeTrainingDashboardSourceSnapshot(completeSources('signature'));
    const config = TRAINING_TABLE_CONFIGS[0];
    const previousTableId = process.env[config.envKey];
    process.env[config.envKey] = 'tbl-signature-changed';
    try {
      await expect(readTrainingDashboardSourceSnapshot()).resolves.toBeNull();
    } finally {
      if (previousTableId === undefined) delete process.env[config.envKey];
      else process.env[config.envKey] = previousTableId;
    }
  });

  it('serializes concurrent writes so the final file is one complete bundle with no temp residue', async () => {
    const first = completeSources('first');
    const second = completeSources('second');

    await Promise.all([
      writeTrainingDashboardSourceSnapshot(first),
      writeTrainingDashboardSourceSnapshot(second),
    ]);

    const stored = await readTrainingDashboardSourceSnapshot();
    expect([first, second]).toContainEqual(stored?.sources);
    expect(stored && Object.keys(stored.sources).sort()).toEqual(
      TRAINING_TABLE_CONFIGS.map(({ key }) => key).sort(),
    );
    expect(
      (await readdir(cacheDir)).filter((name) => name.includes('.tmp')),
    ).toEqual([]);
  });

  it('keeps the successful sync timestamp and accepts only the exact legacy employee-field signature', async () => {
    const sources = completeSources('legacy');
    const savedAt = '2026-10-14T19:10:19.940Z';
    await writeTrainingDashboardSourceSnapshot(sources, savedAt);
    const file = join(cacheDir, SNAPSHOT_FILE_NAME);
    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    const signature = JSON.parse(snapshot.configSignature) as Array<{
      key: string;
      tableId: string;
      fieldNames: string[];
    }>;
    const scores = signature.find((entry) => entry.key === 'activeScores')!;
    expect(scores.fieldNames).toContain('员工 （文本）');
    scores.fieldNames = scores.fieldNames
      .map((field) => (field === '员工 （文本）' ? '员工' : field))
      .sort((a, b) => a.localeCompare(b));
    snapshot.configSignature = JSON.stringify(signature);
    await writeFile(file, JSON.stringify(snapshot));
    await expect(readTrainingDashboardSourceSnapshot()).resolves.toEqual({
      sources,
      savedAt,
    });

    scores.tableId = 'tbl-another-source';
    snapshot.configSignature = JSON.stringify(signature);
    await writeFile(file, JSON.stringify(snapshot));
    await expect(readTrainingDashboardSourceSnapshot()).resolves.toBeNull();
  });

  it('rejects a legacy signature with another field change and invalid saved timestamps', async () => {
    await writeTrainingDashboardSourceSnapshot(completeSources('different'));
    const file = join(cacheDir, SNAPSHOT_FILE_NAME);
    const original = JSON.parse(await readFile(file, 'utf8'));
    const changed = JSON.parse(JSON.stringify(original));
    const entries = JSON.parse(changed.configSignature);
    const scores = entries.find(
      (entry: { key: string }) => entry.key === 'activeScores',
    );
    scores.fieldNames = scores.fieldNames.filter(
      (name: string) => name !== '课程',
    );
    changed.configSignature = JSON.stringify(entries);
    await writeFile(file, JSON.stringify(changed));
    await expect(readTrainingDashboardSourceSnapshot()).resolves.toBeNull();

    original.savedAt = 'not-a-date';
    await writeFile(file, JSON.stringify(original));
    await expect(readTrainingDashboardSourceSnapshot()).resolves.toBeNull();
    await expect(
      writeTrainingDashboardSourceSnapshot(completeSources('invalid'), ''),
    ).rejects.toThrow();
  });
});
