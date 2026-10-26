import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChangeAdjustmentRequest } from '../../../shared/change-adjustment';
import {
  CHANGE_ADJUSTMENT_FIELDS,
  ChangeAdjustmentService,
  type ChangeAdjustmentExecutionPorts,
  type ChangeAdjustmentRecordSnapshot,
  type ChangeAdjustmentStoredFile,
} from './change-adjustment.service';

const MUTATION_ID = 'change-adjustment-123e4567-e89b-42d3-a456-426614174000';
const OTHER_MUTATION_ID =
  'change-adjustment-223e4567-e89b-42d3-a456-426614174001';
const THIRD_MUTATION_ID =
  'change-adjustment-323e4567-e89b-42d3-a456-426614174002';
const FOURTH_MUTATION_ID =
  'change-adjustment-423e4567-e89b-42d3-a456-426614174003';

const OLD_TOKEN_1 = 'old-scheme-token-1';
const OLD_TOKEN_2 = 'old-scheme-token-2';
const OLD_EVIDENCE_TOKEN = 'old-evidence-token-1';

function sourceRecord(
  overrides: Partial<ChangeAdjustmentRecordSnapshot> = {},
): ChangeAdjustmentRecordSnapshot {
  const documents = [
    {
      fileToken: OLD_TOKEN_1,
      name: 'old-1.pdf',
      url: 'https://files.example.test/old-1.pdf',
    },
    {
      fileToken: OLD_TOKEN_2,
      name: 'old-2.pdf',
      url: 'https://files.example.test/old-2.pdf',
    },
  ];
  return {
    recordId: 'rec-change-1',
    publicRecord: {
      id: 'rec-change-1',
      bitableRecordId: 'rec-change-1',
      title: '测试变更',
      startDate: '2026-08-10T01:00:00.000Z',
      endDate: '2026-08-10T10:00:00.000Z',
      actualStartDate: null,
      actualEndDate: null,
      plannedDelayStartDate: null,
      plannedDelayEndDate: null,
      level: '二级',
      type: '计划变更',
      progress: '未开始',
      executor: '示例人员020',
      scheduleStatus: 'not-started',
      planDocuments: documents,
      delayReason: null,
      delayEvidence: [],
      buildings: ['H楼'],
      riskSummary: '测试风险',
      isKey: false,
      recordUrl: 'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
      createdAt: '2026-08-08T01:00:00.000Z',
      updatedAt: '2026-08-09T01:00:00.000Z',
    },
    version: 7,
    updatedAt: '2026-08-09T01:00:00.000Z',
    plannedStartAt: '2026-08-10T09:00:00+08:00',
    plannedEndAt: '2026-08-10T18:00:00+08:00',
    plannedDelayStartAt: null,
    plannedDelayEndAt: null,
    reason: null,
    documents,
    evidence: [],
    adjustmentMutationId: null,
    adjustmentFingerprint: null,
    ...overrides,
  };
}

function request(
  overrides: Partial<ChangeAdjustmentRequest> = {},
): ChangeAdjustmentRequest {
  return {
    clientMutationId: MUTATION_ID,
    recordId: 'rec-change-1',
    expectedVersion: 7,
    expectedUpdatedAt: '2026-08-09T01:00:00.000Z',
    plannedDelayStartDate: '2026-08-10T10:00',
    plannedDelayEndDate: '2026-08-10T20:00',
    reason: '上游供电切换窗口延后',
    retainedDocumentTokens: [OLD_TOKEN_1],
    removedDocumentTokens: [OLD_TOKEN_2],
    newSchemeDocuments: [
      {
        name: 'client-forged.exe',
        size: 1,
        type: 'application/octet-stream',
        objectStorage: {
          id: 'scheme-storage-1',
          filePath: 'client/forged/path',
          bucketId: 'client-forged-bucket',
          url: '/api/duty-schedules/change-attachments/scheme-storage-1/download',
        },
      },
    ],
    evidenceDocuments: [
      {
        name: 'client-forged.txt',
        size: 1,
        type: 'text/plain',
        objectStorage: {
          id: 'evidence-storage-1',
          filePath: 'client/forged/path',
          bucketId: 'client-forged-bucket',
          url: '/api/duty-schedules/change-attachments/evidence-storage-1/download',
        },
      },
    ],
    ...overrides,
  };
}

function storedFile(
  id: string,
  overrides: Partial<ChangeAdjustmentStoredFile> = {},
): ChangeAdjustmentStoredFile {
  const evidence = id.startsWith('evidence');
  return {
    id,
    filePath: `change-attachments/v1/${id}/${evidence ? 'proof.png' : 'scheme.pdf'}`,
    bucketId: 'server-private-bucket',
    url: `/api/duty-schedules/change-attachments/${id}/download`,
    name: evidence ? 'proof.png' : 'scheme.pdf',
    size: 1024,
    mimeType: evidence ? 'image/png' : 'application/pdf',
    sha256: evidence ? 'b'.repeat(64) : 'a'.repeat(64),
    ...overrides,
  };
}

interface FakePortsOptions {
  record?: ChangeAdjustmentRecordSnapshot;
  updateMode?: 'success' | 'commit-then-throw' | 'mismatched-readback';
  recoverWithMismatchedMarker?: boolean;
  failDeleteOnce?: boolean;
  updateDelayMs?: number;
}

function createFakePorts(options: FakePortsOptions = {}) {
  let current = options.record || sourceRecord();
  const events: string[] = [];
  const updates: Record<string, unknown>[] = [];
  const uploads: Array<{
    kind: string;
    file: ChangeAdjustmentStoredFile;
  }> = [];
  const binds: Array<{ id: string; recordId: string; fileToken: string }> = [];
  const deletes: Array<{ id: string; recordId: string }> = [];
  let updateCalls = 0;
  let readCalls = 0;
  let deleteFailed = false;
  let activeUpdates = 0;
  let maxActiveUpdates = 0;

  const storage = new Map<string, ChangeAdjustmentStoredFile>([
    ['scheme-storage-1', storedFile('scheme-storage-1')],
    ['scheme-storage-2', storedFile('scheme-storage-2')],
    ['evidence-storage-1', storedFile('evidence-storage-1')],
    [
      'old-storage-2',
      storedFile('old-storage-2', {
        boundRecordId: 'rec-change-1',
        fileToken: OLD_TOKEN_2,
      }),
    ],
    [
      'old-evidence-storage-1',
      storedFile('old-evidence-storage-1', {
        name: 'old-proof.png',
        mimeType: 'image/png',
        boundRecordId: 'rec-change-1',
        fileToken: OLD_EVIDENCE_TOKEN,
      }),
    ],
  ]);

  const ports: ChangeAdjustmentExecutionPorts = {
    readRecordStrict: async (recordId) => {
      events.push(`read:${recordId}`);
      readCalls += 1;
      if (current.recordId !== recordId) return null;
      const snapshot = structuredClone(current);
      if (options.recoverWithMismatchedMarker && updateCalls > 0) {
        snapshot.reason = '被外部自动化覆盖';
      }
      return snapshot;
    },
    updateRecord: async (recordId, fields) => {
      events.push(`update:${recordId}`);
      updateCalls += 1;
      activeUpdates += 1;
      maxActiveUpdates = Math.max(maxActiveUpdates, activeUpdates);
      if (options.updateDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, options.updateDelayMs),
        );
      }
      updates.push(structuredClone(fields));
      current = applyFields(current, fields, options.updateMode);
      activeUpdates -= 1;
      if (options.updateMode === 'commit-then-throw') {
        throw new Error('socket reset after write');
      }
    },
    resolveOwnedStorage: async (id, ownerMutationId) => {
      events.push(`resolve:${id}:${ownerMutationId}`);
      const file = storage.get(id);
      if (!file) throw new BadRequestException('附件不存在');
      return structuredClone(file);
    },
    uploadToBitable: async ({ kind, file }) => {
      events.push(`upload:${kind}:${file.id}`);
      uploads.push({ kind, file: structuredClone(file) });
      return kind === 'scheme'
        ? `new-scheme-token-${file.id}`
        : `new-evidence-token-${file.id}`;
    },
    bindStorageToRecord: async ({ id, recordId, fileToken }) => {
      events.push(`bind:${id}:${recordId}:${fileToken}`);
      binds.push({ id, recordId, fileToken });
    },
    findBoundStorageByFileToken: async (fileToken) => {
      events.push(`find-bound:${fileToken}`);
      const file = [...storage.values()].find(
        (candidate) => candidate.fileToken === fileToken,
      );
      return file ? structuredClone(file) : null;
    },
    deleteBoundStorage: async ({ id, recordId }) => {
      events.push(`delete:${id}:${recordId}`);
      deletes.push({ id, recordId });
      if (options.failDeleteOnce && !deleteFailed) {
        deleteFailed = true;
        throw new ServiceUnavailableException('对象清理待重试');
      }
      storage.delete(id);
    },
  };

  return {
    ports,
    events,
    updates,
    uploads,
    binds,
    deletes,
    get updateCalls() {
      return updateCalls;
    },
    get readCalls() {
      return readCalls;
    },
    get maxActiveUpdates() {
      return maxActiveUpdates;
    },
  };
}

function applyFields(
  record: ChangeAdjustmentRecordSnapshot,
  fields: Record<string, unknown>,
  mode: FakePortsOptions['updateMode'],
): ChangeAdjustmentRecordSnapshot {
  const attachmentTokens = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.flatMap((entry) => {
          const token = (entry as { file_token?: unknown })?.file_token;
          return typeof token === 'string' ? [token] : [];
        })
      : [];
  const documents = attachmentTokens(
    fields[CHANGE_ADJUSTMENT_FIELDS.documents],
  ).map((fileToken) => ({
    fileToken,
    name: `${fileToken}.pdf`,
    url: `https://files.example.test/${fileToken}`,
  }));
  const evidence = attachmentTokens(
    fields[CHANGE_ADJUSTMENT_FIELDS.evidence],
  ).map((fileToken) => ({
    fileToken,
    name: `${fileToken}.png`,
    url: `https://files.example.test/${fileToken}`,
  }));
  const plannedDelayStartAt = Object.prototype.hasOwnProperty.call(
    fields,
    CHANGE_ADJUSTMENT_FIELDS.plannedDelayStartAt,
  )
    ? (fields[CHANGE_ADJUSTMENT_FIELDS.plannedDelayStartAt] as number)
    : record.plannedDelayStartAt;
  const plannedDelayEndAt = fields[
    CHANGE_ADJUSTMENT_FIELDS.plannedDelayEndAt
  ] as number;
  const reason = String(fields[CHANGE_ADJUSTMENT_FIELDS.reason] || '');
  const next: ChangeAdjustmentRecordSnapshot = {
    ...record,
    updatedAt: '2026-08-09T01:01:00.000Z',
    version: 8,
    plannedDelayStartAt,
    plannedDelayEndAt,
    reason,
    documents,
    evidence,
    adjustmentMutationId: String(
      fields[CHANGE_ADJUSTMENT_FIELDS.requestUniqueId] || '',
    ),
    adjustmentFingerprint: String(
      fields[CHANGE_ADJUSTMENT_FIELDS.requestFingerprint] || '',
    ),
    publicRecord: {
      ...record.publicRecord,
      plannedDelayStartDate:
        plannedDelayStartAt === null || plannedDelayStartAt === undefined
          ? null
          : new Date(plannedDelayStartAt).toISOString(),
      plannedDelayEndDate: new Date(plannedDelayEndAt).toISOString(),
      delayReason: reason,
      planDocuments: documents,
      delayEvidence: evidence,
      updatedAt: '2026-08-09T01:01:00.000Z',
    },
  };
  if (mode === 'mismatched-readback') {
    next.reason = '被外部自动化覆盖';
  }
  return next;
}

describe('ChangeAdjustmentService', () => {
  let ledgerDir: string;

  beforeEach(async () => {
    ledgerDir = await mkdtemp(join(tmpdir(), 'vnet-change-adjustment-'));
  });

  afterEach(async () => {
    await rm(ledgerDir, { recursive: true, force: true });
  });

  function createService(now = '2026-08-09T02:00:00.000Z') {
    return new ChangeAdjustmentService({
      ledgerDir,
      now: () => new Date(now),
    });
  }

  it('writes authoritative dates, reason and attachments, then binds and cleans COS only after strict readback', async () => {
    const fake = createFakePorts();
    const result = await createService().execute(request(), fake.ports);

    expect(Object.keys(result).sort()).toEqual([
      'clientMutationId',
      'message',
      'record',
      'success',
    ]);
    expect(result).toMatchObject({
      success: true,
      clientMutationId: MUTATION_ID,
      record: {
        bitableRecordId: 'rec-change-1',
        scheduleStatus: 'not-started',
        delayReason: '上游供电切换窗口延后',
        planDocuments: [
          { fileToken: OLD_TOKEN_1 },
          { fileToken: 'new-scheme-token-scheme-storage-1' },
        ],
        delayEvidence: [{ fileToken: 'new-evidence-token-evidence-storage-1' }],
      },
    });
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]).toEqual({
      [CHANGE_ADJUSTMENT_FIELDS.plannedDelayStartAt]: Date.parse(
        '2026-08-10T10:00:00+08:00',
      ),
      [CHANGE_ADJUSTMENT_FIELDS.plannedDelayEndAt]: Date.parse(
        '2026-08-10T20:00:00+08:00',
      ),
      [CHANGE_ADJUSTMENT_FIELDS.reason]: '上游供电切换窗口延后',
      [CHANGE_ADJUSTMENT_FIELDS.evidence]: [
        { file_token: 'new-evidence-token-evidence-storage-1' },
      ],
      [CHANGE_ADJUSTMENT_FIELDS.documents]: [
        { file_token: OLD_TOKEN_1 },
        { file_token: 'new-scheme-token-scheme-storage-1' },
      ],
      [CHANGE_ADJUSTMENT_FIELDS.requestUniqueId]: MUTATION_ID,
      [CHANGE_ADJUSTMENT_FIELDS.requestFingerprint]:
        expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(fake.uploads.map(({ kind, file }) => [kind, file])).toEqual([
      ['scheme', expect.objectContaining({ name: 'scheme.pdf', size: 1024 })],
      ['evidence', expect.objectContaining({ name: 'proof.png', size: 1024 })],
    ]);
    expect(fake.uploads[0].file.filePath).not.toContain('forged');
    const updateIndex = fake.events.findIndex((event) =>
      event.startsWith('update:'),
    );
    const readbackIndex = fake.events.findIndex(
      (event, index) => index > updateIndex && event.startsWith('read:'),
    );
    const bindIndex = fake.events.findIndex((event) =>
      event.startsWith('bind:'),
    );
    const deleteIndex = fake.events.findIndex((event) =>
      event.startsWith('delete:'),
    );
    expect(readbackIndex).toBeGreaterThan(updateIndex);
    expect(bindIndex).toBeGreaterThan(readbackIndex);
    expect(deleteIndex).toBeGreaterThan(readbackIndex);
    expect(fake.binds).toEqual([
      {
        id: 'scheme-storage-1',
        recordId: 'rec-change-1',
        fileToken: 'new-scheme-token-scheme-storage-1',
      },
      {
        id: 'evidence-storage-1',
        recordId: 'rec-change-1',
        fileToken: 'new-evidence-token-evidence-storage-1',
      },
    ]);
    expect(fake.deletes).toEqual([
      { id: 'old-storage-2', recordId: 'rec-change-1' },
    ]);
  });

  it('derives in-progress status from authoritative effective dates and never writes a start adjustment', async () => {
    const fake = createFakePorts({
      record: sourceRecord({
        plannedDelayStartAt: '2026-08-09T09:00:00+08:00',
        plannedDelayEndAt: '2026-08-09T18:00:00+08:00',
      }),
    });
    const service = createService('2026-08-09T04:00:00.000Z');

    await expect(service.execute(request(), fake.ports)).rejects.toThrow(
      '进行中的变更不能调整开始时间',
    );
    expect(fake.updateCalls).toBe(0);

    const result = await service.execute(
      request({
        clientMutationId: OTHER_MUTATION_ID,
        plannedDelayStartDate: null,
        plannedDelayEndDate: '2026-08-09T21:00',
      }),
      fake.ports,
    );
    expect(result.record.scheduleStatus).toBe('in-progress');
    expect(fake.updates[0]).not.toHaveProperty(
      CHANGE_ADJUSTMENT_FIELDS.plannedDelayStartAt,
    );
  });

  it('treats an authoritative actual start as in-progress before the planned start', async () => {
    const fake = createFakePorts({
      record: sourceRecord({
        actualStartAt: '2026-08-09T01:30:00.000Z',
      }),
    });
    const service = createService('2026-08-09T02:00:00.000Z');

    await expect(service.execute(request(), fake.ports)).rejects.toThrow(
      '进行中的变更不能调整开始时间',
    );
    expect(fake.uploads).toHaveLength(0);
    expect(fake.updateCalls).toBe(0);
  });

  it('rejects an authoritative actual end even when the planned window has not started', async () => {
    const fake = createFakePorts({
      record: sourceRecord({
        actualStartAt: '2026-08-09T00:30:00.000Z',
        actualEndAt: '2026-08-09T01:30:00.000Z',
      }),
    });

    await expect(
      createService().execute(request(), fake.ports),
    ).rejects.toThrow('已结束的变更不能调整');
    expect(fake.uploads).toHaveLength(0);
    expect(fake.updateCalls).toBe(0);
  });

  it.each([
    {
      label: 'in-progress end at server now',
      record: sourceRecord({
        actualStartAt: '2026-08-09T01:00:00.000Z',
      }),
      payload: request({
        plannedDelayStartDate: null,
        plannedDelayEndDate: '2026-08-09T10:00',
      }),
    },
    {
      label: 'not-started adjusted interval entirely in the past',
      record: sourceRecord(),
      payload: request({
        plannedDelayStartDate: '2026-08-08T09:00',
        plannedDelayEndDate: '2026-08-08T18:00',
      }),
    },
  ])(
    'rejects $label using authoritative server time',
    async ({ record, payload }) => {
      const fake = createFakePorts({ record });

      await expect(
        createService('2026-08-09T02:00:00.000Z').execute(payload, fake.ports),
      ).rejects.toThrow('晚于当前时间');
      expect(fake.uploads).toHaveLength(0);
      expect(fake.updateCalls).toBe(0);
    },
  );

  it('replaces prior evidence and removes its bound object only after strict readback', async () => {
    const fake = createFakePorts({
      record: sourceRecord({
        evidence: [
          {
            fileToken: OLD_EVIDENCE_TOKEN,
            name: 'old-proof.png',
            url: 'https://files.example.test/old-proof.png',
          },
        ],
      }),
    });

    await createService().execute(request(), fake.ports);

    const updateIndex = fake.events.findIndex((event) =>
      event.startsWith('update:'),
    );
    const readbackIndex = fake.events.findIndex(
      (event, index) => index > updateIndex && event.startsWith('read:'),
    );
    const oldEvidenceDeleteIndex = fake.events.findIndex((event) =>
      event.startsWith('delete:old-evidence-storage-1:'),
    );
    expect(oldEvidenceDeleteIndex).toBeGreaterThan(readbackIndex);
    expect(fake.deletes).toContainEqual({
      id: 'old-evidence-storage-1',
      recordId: 'rec-change-1',
    });
  });

  it('rechecks lifecycle after slow uploads before allowing a start-time adjustment', async () => {
    const fake = createFakePorts();
    let now = '2026-08-09T02:00:00.000Z';
    const originalUpload = fake.ports.uploadToBitable;
    fake.ports.uploadToBitable = async (input) => {
      const token = await originalUpload(input);
      now = '2026-08-10T02:30:00.000Z';
      return token;
    };
    const service = new ChangeAdjustmentService({
      ledgerDir,
      now: () => new Date(now),
    });

    await expect(service.execute(request(), fake.ports)).rejects.toThrow(
      '进行中的变更不能调整开始时间',
    );
    expect(fake.updateCalls).toBe(0);
  });

  it('rejects finished changes before resolving or uploading files', async () => {
    const fake = createFakePorts();
    await expect(
      createService('2026-08-11T00:00:00.000Z').execute(request(), fake.ports),
    ).rejects.toThrow('已结束的变更不能调整');
    expect(fake.uploads).toHaveLength(0);
    expect(fake.updateCalls).toBe(0);
  });

  it('rejects stale versions and non-partition attachment token sets before uploading', async () => {
    const stale = createFakePorts();
    await expect(
      createService().execute(request({ expectedVersion: 6 }), stale.ports),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(stale.uploads).toHaveLength(0);

    const foreign = createFakePorts();
    await expect(
      createService().execute(
        request({
          clientMutationId: THIRD_MUTATION_ID,
          retainedDocumentTokens: ['foreign-token'],
        }),
        foreign.ports,
      ),
    ).rejects.toThrow('不属于当前记录');

    const incomplete = createFakePorts();
    await expect(
      createService().execute(
        request({
          clientMutationId: FOURTH_MUTATION_ID,
          removedDocumentTokens: [],
        }),
        incomplete.ports,
      ),
    ).rejects.toThrow('必须明确保留或删除');
    expect(incomplete.uploads).toHaveLength(0);
  });

  it('enforces authoritative 200 MiB scheme and 20 MiB evidence limits', async () => {
    const oversizedScheme = createFakePorts();
    oversizedScheme.ports.resolveOwnedStorage = async (id) =>
      storedFile(id, { size: 200 * 1024 * 1024 + 1 });
    await expect(
      createService().execute(request(), oversizedScheme.ports),
    ).rejects.toThrow('200 MiB');

    const oversizedEvidence = createFakePorts();
    oversizedEvidence.ports.resolveOwnedStorage = async (id) =>
      storedFile(id, {
        name: id.startsWith('evidence') ? 'proof.png' : 'scheme.pdf',
        mimeType: id.startsWith('evidence') ? 'image/png' : 'application/pdf',
        size: id.startsWith('evidence') ? 20 * 1024 * 1024 + 1 : 1024,
      });
    await expect(
      createService().execute(request(), oversizedEvidence.ports),
    ).rejects.toThrow('20 MiB');
  });

  it('rejects reuse of one staged object across scheme and evidence fields', async () => {
    const fake = createFakePorts();
    await expect(
      createService().execute(
        request({
          newSchemeDocuments: [
            {
              name: 'proof.png',
              size: 1024,
              type: 'image/png',
              objectStorage: {
                id: 'evidence-storage-1',
                filePath: 'ignored',
                bucketId: 'ignored',
                url: '/api/duty-schedules/change-attachments/evidence-storage-1/download',
              },
            },
          ],
        }),
        fake.ports,
      ),
    ).rejects.toThrow('对象存储附件不能重复');
    expect(fake.updateCalls).toBe(0);
  });

  it('joins duplicate in-flight requests and writes only once', async () => {
    const fake = createFakePorts({ updateDelayMs: 25 });
    const service = createService();

    const [left, right] = await Promise.all([
      service.execute(request(), fake.ports),
      service.execute(request(), fake.ports),
    ]);

    expect(left.record.planDocuments).toEqual(right.record.planDocuments);
    expect(fake.updateCalls).toBe(1);
    expect(fake.uploads).toHaveLength(2);
  });

  it('rejects the same mutation id with a different authoritative fingerprint', async () => {
    const fake = createFakePorts();
    const service = createService();
    await service.execute(request(), fake.ports);

    await expect(
      service.execute(request({ reason: '不同的调整理由' }), fake.ports),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(fake.updateCalls).toBe(1);
  });

  it('replays an unknown write by strict-reading the mutation marker without re-uploading or re-writing', async () => {
    const fake = createFakePorts({ updateMode: 'commit-then-throw' });
    const service = createService();

    await expect(service.execute(request(), fake.ports)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(fake.binds).toHaveLength(0);
    expect(fake.deletes).toHaveLength(0);

    const recovered = await service.execute(request(), fake.ports);
    expect(recovered.clientMutationId).toBe(MUTATION_ID);
    expect(fake.updateCalls).toBe(1);
    expect(fake.uploads).toHaveLength(2);
    expect(fake.binds).toHaveLength(2);
    expect(fake.deletes).toHaveLength(1);
  });

  it('keeps unknown-result semantics when the same mutation marker exists but strict readback differs', async () => {
    const fake = createFakePorts({
      updateMode: 'commit-then-throw',
      recoverWithMismatchedMarker: true,
    });
    const service = createService();

    await expect(service.execute(request(), fake.ports)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    try {
      await service.execute(request(), fake.ports);
      throw new Error('expected execute to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect(error).not.toBeInstanceOf(ConflictException);
      expect(
        (error as ServiceUnavailableException).getResponse(),
      ).toMatchObject({
        writeDisposition: 'unknown-result',
        clientMutationId: MUTATION_ID,
      });
      expect(
        JSON.stringify((error as ServiceUnavailableException).getResponse()),
      ).toContain('需核对');
    }
    expect(fake.updateCalls).toBe(1);
    expect(fake.binds).toHaveLength(0);
    expect(fake.deletes).toHaveLength(0);
  });

  it.each([
    ['array payload', []],
    ['object record id', { ...request(), recordId: { trim: 1 } }],
    [
      'object expected update time',
      { ...request(), expectedUpdatedAt: { trim: 1 } },
    ],
    [
      'object planned start',
      { ...request(), plannedDelayStartDate: { trim: 1 } },
    ],
    ['object reason', { ...request(), reason: { trim: 1 } }],
    [
      'object retained token collection',
      { ...request(), retainedDocumentTokens: { map: 1 } },
    ],
    [
      'object token inside collection',
      { ...request(), removedDocumentTokens: [{ trim: 1 }] },
    ],
    [
      'object scheme collection',
      { ...request(), newSchemeDocuments: { map: 1 } },
    ],
    ['null evidence entry', { ...request(), evidenceDocuments: [null] }],
  ])(
    'rejects malformed JSON type %s with BadRequest 400',
    async (_label, payload) => {
      const fake = createFakePorts();

      try {
        await createService().execute(
          payload as unknown as ChangeAdjustmentRequest,
          fake.ports,
        );
        throw new Error('expected execute to reject');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getStatus()).toBe(400);
        expect(error).not.toBeInstanceOf(TypeError);
      }
      expect(fake.uploads).toHaveLength(0);
      expect(fake.updateCalls).toBe(0);
    },
  );

  it('does not bind or delete objects when strict readback does not match the submitted fields', async () => {
    const fake = createFakePorts({ updateMode: 'mismatched-readback' });
    await expect(
      createService().execute(request(), fake.ports),
    ).rejects.toThrow('严格回读未通过');
    expect(fake.binds).toHaveLength(0);
    expect(fake.deletes).toHaveLength(0);
  });

  it('persists confirmed state and retries post-commit cleanup without another Feishu write', async () => {
    const fake = createFakePorts({ failDeleteOnce: true });
    const service = createService();

    await expect(service.execute(request(), fake.ports)).rejects.toThrow(
      '后置处理未完成',
    );
    expect(fake.updateCalls).toBe(1);

    const recovered = await service.execute(request(), fake.ports);
    expect(recovered.clientMutationId).toBe(MUTATION_ID);
    expect(fake.updateCalls).toBe(1);
    expect(fake.uploads).toHaveLength(2);
    expect(fake.deletes).toHaveLength(2);
  });

  it('fails closed when a durable confirmed ledger contains unsafe post-commit data', async () => {
    const fake = createFakePorts({ updateMode: 'commit-then-throw' });
    const service = createService();
    await expect(service.execute(request(), fake.ports)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const key = createHash('sha256').update(MUTATION_ID).digest('hex');
    const ledgerPath = join(ledgerDir, `${key}.json`);
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<
      string,
      unknown
    >;
    ledger.phase = 'confirmed';
    ledger.response = {
      success: true,
      clientMutationId: MUTATION_ID,
      syncStatus: 'synced',
    };
    ledger.deletes = [{ storageId: '' }];
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8');

    await expect(service.execute(request(), fake.ports)).rejects.toThrow(
      '幂等台账内容无效',
    );
    expect(fake.deletes).toHaveLength(0);
  });

  it('rejects a durable cleanup target that is not the removed Base attachment', async () => {
    const fake = createFakePorts({ failDeleteOnce: true });
    const service = createService();
    await expect(service.execute(request(), fake.ports)).rejects.toThrow(
      '后置处理未完成',
    );

    const key = createHash('sha256').update(MUTATION_ID).digest('hex');
    const ledgerPath = join(ledgerDir, `${key}.json`);
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<
      string,
      unknown
    >;
    ledger.deletes = [
      { storageId: 'unrelated-valid-storage-id', fileToken: OLD_TOKEN_1 },
    ];
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8');

    await expect(service.execute(request(), fake.ports)).rejects.toThrow(
      '幂等台账内容无效',
    );
    expect(fake.deletes).toEqual([
      { id: 'old-storage-2', recordId: 'rec-change-1' },
    ]);
  });

  it('rejects a durable cleanup target that points at the newly saved evidence', async () => {
    const fake = createFakePorts({ failDeleteOnce: true });
    const service = createService();
    await expect(service.execute(request(), fake.ports)).rejects.toThrow(
      '后置处理未完成',
    );

    const key = createHash('sha256').update(MUTATION_ID).digest('hex');
    const ledgerPath = join(ledgerDir, `${key}.json`);
    const ledger = JSON.parse(await readFile(ledgerPath, 'utf8')) as Record<
      string,
      unknown
    >;
    ledger.deletes = [
      {
        storageId: 'unrelated-valid-storage-id',
        fileToken: 'new-evidence-token-evidence-storage-1',
      },
    ];
    await writeFile(ledgerPath, JSON.stringify(ledger), 'utf8');

    await expect(service.execute(request(), fake.ports)).rejects.toThrow(
      '幂等台账内容无效',
    );
    expect(fake.deletes).toEqual([
      { id: 'old-storage-2', recordId: 'rec-change-1' },
    ]);
  });

  it('serializes different mutations for the same record', async () => {
    const fake = createFakePorts({ updateDelayMs: 20 });
    const service = createService();
    const second = request({
      clientMutationId: OTHER_MUTATION_ID,
      reason: '第二次调整',
      newSchemeDocuments: [
        {
          name: 'scheme-2.pdf',
          size: 1024,
          type: 'application/pdf',
          objectStorage: {
            id: 'scheme-storage-2',
            filePath: 'ignored',
            bucketId: 'ignored',
            url: '/api/duty-schedules/change-attachments/scheme-storage-2/download',
          },
        },
      ],
    });

    const settled = await Promise.allSettled([
      service.execute(request(), fake.ports),
      service.execute(second, fake.ports),
    ]);
    expect(fake.maxActiveUpdates).toBe(1);
    expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(
      1,
    );
    expect(fake.updateCalls).toBe(1);
  });
});
