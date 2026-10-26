import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { finalizeFailedChangeSummarySelfTestLedgers } from './change-summary-report-failed-self-test-cleanup';

const SUMMARY_MUTATION_ID =
  'change-summary-report-123e4567-e89b-42d3-a456-426614174000';
const CHANGE_MUTATION_ID =
  'change-request-523e4567-e89b-42d3-a456-426614174004';
const CHANGE_RECORD_ID = 'recChange12345678';
const SUMMARY_MARKER = 'CODEX-SELFTEST-CHANGE-SUMMARY-1786424400000-deadbeef';
const SUBMITTER_NAME = '测试提交人';
const FINGERPRINT = 'a'.repeat(64);
const CHANGE_OBJECT_IDS = ['storage-change-1'] as const;
const SUMMARY_OBJECT_IDS = ['storage-summary-1', 'storage-summary-2'] as const;
const NOW = new Date('2026-08-12T10:00:00+08:00');

describe('finalizeFailedChangeSummarySelfTestLedgers', () => {
  let rootDir: string;
  let summaryLedgerDir: string;
  let changeRequestLedgerDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'vnet-failed-summary-cleanup-'));
    summaryLedgerDir = join(rootDir, 'summary');
    changeRequestLedgerDir = join(rootDir, 'change-request');
    await Promise.all([
      mkdir(summaryLedgerDir, { recursive: true }),
      mkdir(changeRequestLedgerDir, { recursive: true }),
    ]);
    await writeFailedSummaryLedger();
    await writeChangeRequestLedger();
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('atomically tombstones both exact ledgers, preserves unrelated files, and is idempotent', async () => {
    const unrelatedSummary =
      'change-summary-report-223e4567-e89b-42d3-a456-426614174001.json';
    const unrelatedChange =
      'change-request-623e4567-e89b-42d3-a456-426614174005.completed.json';
    await writeFile(join(summaryLedgerDir, unrelatedSummary), '{}');
    await writeFile(join(changeRequestLedgerDir, unrelatedChange), '{}');

    const first = await finalizeFailedChangeSummarySelfTestLedgers(input());
    const second = await finalizeFailedChangeSummarySelfTestLedgers(input());

    expect(first).toEqual({
      alreadyFinalized: false,
      changeRequestAlreadyScrubbed: false,
    });
    expect(second).toEqual({
      alreadyFinalized: true,
      changeRequestAlreadyScrubbed: true,
    });

    const summaryFiles = await readdir(summaryLedgerDir);
    const changeFiles = await readdir(changeRequestLedgerDir);
    expect(summaryFiles).toContain(unrelatedSummary);
    expect(changeFiles).toContain(unrelatedChange);
    expect(
      summaryFiles.some((name) => name.startsWith(`${SUMMARY_MUTATION_ID}.`)),
    ).toBe(false);
    expect(
      changeFiles.some((name) => name.startsWith(`${CHANGE_MUTATION_ID}.`)),
    ).toBe(false);

    const summaryTombstone = summaryFiles.find((name) =>
      /^self-test-cleaned-[0-9a-f]{64}\.json$/.test(name),
    );
    expect(summaryTombstone).toBeTruthy();
    const tombstoneText = await readFile(
      join(summaryLedgerDir, summaryTombstone!),
      'utf8',
    );
    const tombstone = JSON.parse(tombstoneText) as Record<string, unknown>;
    expect(Object.keys(tombstone).sort()).toEqual([
      'cleanedAt',
      'mutationHash',
      'proofDigests',
      'state',
      'version',
    ]);
    expect(tombstone.proofDigests).toEqual([
      expect.stringMatching(/^[0-9a-f]{64}$/),
    ]);
    expect(tombstoneText).not.toMatch(
      /change-summary-report-|change-request-|recChange|CODEX-SELFTEST|storage-(?:change|summary)|测试提交人/,
    );
  });

  it('atomically migrates the first-release failed-cleanup tombstone to the canonical shape', async () => {
    await finalizeFailedChangeSummarySelfTestLedgers(input());
    const mutationHash = createHash('sha256')
      .update(SUMMARY_MUTATION_ID)
      .digest('hex');
    const tombstonePath = join(
      summaryLedgerDir,
      `self-test-cleaned-${mutationHash}.json`,
    );
    const canonical = JSON.parse(
      await readFile(tombstonePath, 'utf8'),
    ) as Record<string, unknown>;
    const identityHash = (canonical.proofDigests as string[])[0];
    await writeFile(
      tombstonePath,
      JSON.stringify({
        version: 1,
        state: 'self-test-cleaned',
        cleanupKind: 'failed-change-summary',
        mutationHash,
        identityHash,
        proofDigests: [],
        cleanedAt: canonical.cleanedAt,
      }),
    );

    await expect(
      finalizeFailedChangeSummarySelfTestLedgers(input()),
    ).resolves.toEqual({
      alreadyFinalized: true,
      changeRequestAlreadyScrubbed: true,
    });
    const migrated = JSON.parse(
      await readFile(tombstonePath, 'utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(migrated).sort()).toEqual([
      'cleanedAt',
      'mutationHash',
      'proofDigests',
      'state',
      'version',
    ]);
    expect(migrated.proofDigests).toEqual([identityHash]);
  });

  it('resumes exact active-file deletion after the summary tombstone is durable', async () => {
    await finalizeFailedChangeSummarySelfTestLedgers(input());
    await writeFailedSummaryLedger();

    await expect(
      finalizeFailedChangeSummarySelfTestLedgers(input()),
    ).resolves.toEqual({
      alreadyFinalized: true,
      changeRequestAlreadyScrubbed: true,
    });
    expect(
      (await readdir(summaryLedgerDir)).some((name) =>
        name.startsWith(`${SUMMARY_MUTATION_ID}.`),
      ),
    ).toBe(false);
  });

  it('rejects an unknown same-prefix file before touching either ledger', async () => {
    const unknown = `${SUMMARY_MUTATION_ID}.unexpected.json`;
    await writeFile(join(summaryLedgerDir, unknown), '{}');

    await expect(
      finalizeFailedChangeSummarySelfTestLedgers(input()),
    ).rejects.toThrow('未知文件');
    expect(await readdir(summaryLedgerDir)).toContain(unknown);
    expect(await readdir(changeRequestLedgerDir)).toContain(
      `${CHANGE_MUTATION_ID}.completed.json`,
    );
  });

  it('rejects an invalid cleanup clock before touching either ledger', async () => {
    await expect(
      finalizeFailedChangeSummarySelfTestLedgers(
        input({ now: () => new Date(Number.NaN) }),
      ),
    ).rejects.toThrow('时间无效');
    expect(await readdir(summaryLedgerDir)).toContain(
      `${SUMMARY_MUTATION_ID}.json`,
    );
    expect(await readdir(changeRequestLedgerDir)).toContain(
      `${CHANGE_MUTATION_ID}.completed.json`,
    );
  });

  it.each([
    ['an empty change object set', []],
    ['duplicate change objects', [CHANGE_OBJECT_IDS[0], CHANGE_OBJECT_IDS[0]]],
    ['an invalid change object', ['short']],
    ['an object shared with summary files', [SUMMARY_OBJECT_IDS[0]]],
  ])(
    'rejects %s before touching either ledger',
    async (_label, changeObjectIds) => {
      await expect(
        finalizeFailedChangeSummarySelfTestLedgers(input({ changeObjectIds })),
      ).rejects.toThrow('对象');
      expect(await readdir(summaryLedgerDir)).toContain(
        `${SUMMARY_MUTATION_ID}.json`,
      );
      expect(await readdir(changeRequestLedgerDir)).toContain(
        `${CHANGE_MUTATION_ID}.completed.json`,
      );
    },
  );

  it('rejects change object ids that drift from the change-request ledger', async () => {
    await expect(
      finalizeFailedChangeSummarySelfTestLedgers(
        input({ changeObjectIds: ['storage-change-other'] }),
      ),
    ).rejects.toThrow();
    expect(await readdir(summaryLedgerDir)).toContain(
      `${SUMMARY_MUTATION_ID}.json`,
    );
    expect(await readdir(changeRequestLedgerDir)).toContain(
      `${CHANGE_MUTATION_ID}.completed.json`,
    );
  });

  it('scrubs a failed summary ledger with a strictly bound but unattached upload token', async () => {
    await writeFailedSummaryLedger({
      uploaded: [
        {
          storageId: SUMMARY_OBJECT_IDS[0],
          fileToken: 'file-token-summary-1',
        },
      ],
    });

    await expect(
      finalizeFailedChangeSummarySelfTestLedgers(input()),
    ).resolves.toEqual({
      alreadyFinalized: false,
      changeRequestAlreadyScrubbed: false,
    });
  });

  it.each([
    ['version', { version: 2 }],
    ['phase', { phase: 'accepted' }],
    ['report id', { summaryReportRecordId: 'recSummary12345678' }],
    [
      'uploaded file',
      {
        uploaded: [{ storageId: 'storage-summary-other', fileToken: 'token' }],
      },
    ],
    ['mutation', { clientMutationId: `${SUMMARY_MUTATION_ID}x` }],
    ['change record', { changeRecordId: 'recOther123456789' }],
    ['fingerprint', { fingerprint: 'b'.repeat(64) }],
  ])(
    'rejects a failed summary ledger with drifting %s',
    async (_label, patch) => {
      await writeFailedSummaryLedger(patch);

      await expect(
        finalizeFailedChangeSummarySelfTestLedgers(input()),
      ).rejects.toThrow('身份不一致');
      expect(await readdir(summaryLedgerDir)).toContain(
        `${SUMMARY_MUTATION_ID}.json`,
      );
      expect(await readdir(changeRequestLedgerDir)).toContain(
        `${CHANGE_MUTATION_ID}.completed.json`,
      );
    },
  );

  it.each([
    [
      'submitter',
      (ledger: Record<string, any>) => {
        ledger.request.submitterName = '示例人员004';
      },
    ],
    [
      'request mutation',
      (ledger: Record<string, any>) => {
        ledger.request.clientMutationId =
          'change-summary-report-223e4567-e89b-42d3-a456-426614174001';
      },
    ],
    [
      'object set',
      (ledger: Record<string, any>) => {
        ledger.request.summaryDocuments[1].objectStorage.id =
          'storage-summary-other';
      },
    ],
    [
      'resolved source object set',
      (ledger: Record<string, any>) => {
        ledger.sourceFiles = [{ id: SUMMARY_OBJECT_IDS[0] }];
      },
    ],
  ])(
    'rejects a failed summary request with drifting %s',
    async (_label, mutate) => {
      const ledger = failedSummaryLedger();
      mutate(ledger);
      await writeFile(
        join(summaryLedgerDir, `${SUMMARY_MUTATION_ID}.json`),
        JSON.stringify(ledger),
      );

      await expect(
        finalizeFailedChangeSummarySelfTestLedgers(input()),
      ).rejects.toThrow('身份不一致');
      expect(await readdir(changeRequestLedgerDir)).toContain(
        `${CHANGE_MUTATION_ID}.completed.json`,
      );
    },
  );

  it('rejects a failed summary ledger without a submitter before touching the change-request ledger', async () => {
    const ledger = failedSummaryLedger();
    delete ledger.request.submitterName;
    await writeFile(
      join(summaryLedgerDir, `${SUMMARY_MUTATION_ID}.json`),
      JSON.stringify(ledger),
    );

    await expect(
      finalizeFailedChangeSummarySelfTestLedgers(input()),
    ).rejects.toThrow('提交人');
    expect(await readdir(changeRequestLedgerDir)).toContain(
      `${CHANGE_MUTATION_ID}.completed.json`,
    );
  });

  it('rejects different submitters across active durable summary ledgers', async () => {
    const backup = failedSummaryLedger();
    backup.request.submitterName = '示例人员004';
    await writeFile(
      join(summaryLedgerDir, `${SUMMARY_MUTATION_ID}.json.bak`),
      JSON.stringify(backup),
    );

    await expect(
      finalizeFailedChangeSummarySelfTestLedgers(input()),
    ).rejects.toThrow('提交人不一致');
    expect(await readdir(changeRequestLedgerDir)).toContain(
      `${CHANGE_MUTATION_ID}.completed.json`,
    );
  });

  it('uses the change-request scrubber to validate the marker before writing a summary tombstone', async () => {
    const drifted = input({
      summaryMarker: 'CODEX-SELFTEST-CHANGE-SUMMARY-1786424400000-cafebabe',
    });

    await expect(
      finalizeFailedChangeSummarySelfTestLedgers(drifted),
    ).rejects.toThrow('身份不一致');
    expect(await readdir(summaryLedgerDir)).toContain(
      `${SUMMARY_MUTATION_ID}.json`,
    );
    expect(
      (await readdir(summaryLedgerDir)).some((name) =>
        name.startsWith('self-test-cleaned-'),
      ),
    ).toBe(false);
  });

  it('rejects a tampered tombstone and leaves a recreated active ledger intact', async () => {
    await finalizeFailedChangeSummarySelfTestLedgers(input());
    const mutationHash = createHash('sha256')
      .update(SUMMARY_MUTATION_ID)
      .digest('hex');
    await writeFile(
      join(summaryLedgerDir, `self-test-cleaned-${mutationHash}.json`),
      JSON.stringify({
        version: 1,
        state: 'self-test-cleaned',
        mutationHash,
        identityHash: '0'.repeat(64),
      }),
    );
    await writeFailedSummaryLedger();

    await expect(
      finalizeFailedChangeSummarySelfTestLedgers(input()),
    ).rejects.toThrow('墓碑损坏');
    expect(await readdir(summaryLedgerDir)).toContain(
      `${SUMMARY_MUTATION_ID}.json`,
    );
  });

  function input(
    patch: Partial<
      Parameters<typeof finalizeFailedChangeSummarySelfTestLedgers>[0]
    > = {},
  ) {
    return {
      summaryLedgerDir,
      changeRequestLedgerDir,
      clientMutationId: SUMMARY_MUTATION_ID,
      changeRequestMutationId: CHANGE_MUTATION_ID,
      changeRecordId: CHANGE_RECORD_ID,
      summaryMarker: SUMMARY_MARKER,
      fingerprint: FINGERPRINT,
      changeObjectIds: [...CHANGE_OBJECT_IDS],
      summaryObjectIds: [...SUMMARY_OBJECT_IDS],
      now: () => NOW,
      ...patch,
    };
  }

  async function writeFailedSummaryLedger(
    patch: Record<string, unknown> = {},
  ): Promise<void> {
    await writeFile(
      join(summaryLedgerDir, `${SUMMARY_MUTATION_ID}.json`),
      JSON.stringify({ ...failedSummaryLedger(), ...patch }),
    );
  }

  async function writeChangeRequestLedger(): Promise<void> {
    const prefix = join(changeRequestLedgerDir, CHANGE_MUTATION_ID);
    await writeFile(`${prefix}.sha256`, `${FINGERPRINT}\n`);
    await writeFile(
      `${prefix}.upload.0.json`,
      JSON.stringify({
        version: 1,
        state: 'uploaded',
        clientMutationId: CHANGE_MUTATION_ID,
        fingerprint: FINGERPRINT,
        index: 0,
        document: {
          fileToken: 'file-token-change-1',
          storageId: CHANGE_OBJECT_IDS[0],
          name: 'self-test.pdf',
          size: 128,
        },
      }),
    );
    await writeFile(
      `${prefix}.record.json`,
      JSON.stringify({
        version: 1,
        state: 'record-created',
        clientMutationId: CHANGE_MUTATION_ID,
        fingerprint: FINGERPRINT,
        recordId: CHANGE_RECORD_ID,
      }),
    );
    await writeFile(
      `${prefix}.completed.json`,
      JSON.stringify({
        version: 1,
        state: 'completed',
        clientMutationId: CHANGE_MUTATION_ID,
        fingerprint: FINGERPRINT,
        recordId: CHANGE_RECORD_ID,
        response: {
          success: true,
          clientMutationId: CHANGE_MUTATION_ID,
          record: {
            id: CHANGE_RECORD_ID,
            bitableRecordId: CHANGE_RECORD_ID,
            title: SUMMARY_MARKER,
            submitterName: SUBMITTER_NAME,
          },
        },
      }),
    );
  }
});

function failedSummaryLedger(): Record<string, any> {
  return {
    version: 1,
    clientMutationId: SUMMARY_MUTATION_ID,
    fingerprint: FINGERPRINT,
    changeRecordId: CHANGE_RECORD_ID,
    request: {
      clientMutationId: SUMMARY_MUTATION_ID,
      submitterName: SUBMITTER_NAME,
      changeRecordId: CHANGE_RECORD_ID,
      summaryDocuments: SUMMARY_OBJECT_IDS.map((id, index) => ({
        name: `summary-${index + 1}.pdf`,
        type: 'application/pdf',
        size: 128,
        objectStorage: {
          id,
          filePath: `change-summary-reports/${id}.pdf`,
          bucketId: 'default-bucket',
          url: `/api/storage/${id}`,
        },
      })),
    },
    phase: 'failed',
    sourceFiles: [],
    uploaded: [],
    error: '严格验证失败',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}
