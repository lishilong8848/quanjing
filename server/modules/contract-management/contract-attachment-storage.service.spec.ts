import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decryptContractBuffer,
  encryptContractBuffer,
} from './contract-attachment-crypto';

import type { ContractManagementDashboard } from '../../../shared/contract-management.interface';
import {
  acquireExclusiveProcessLock,
  assertPdfAttachment,
  buildContractAttachmentIndexKey,
  buildContractStorageIndexObjectKey,
  buildCosPublicObjectUrl,
  buildLocalProcessorEnvironment,
  buildRenderPreviewArguments,
  buildSafeAttachmentDto,
  buildSecureContractObjectKey,
  buildStartupRecoveryJobs,
  buildVersionedContractStorageIndex,
  canReuseContractAttachmentContent,
  ContractAttachmentStorageService,
  enqueueRecoverableWrite,
  extractFeishuAttachmentToken,
  isContractPreviewProcessorReady,
  isMigrationTombstone,
  isOfficialFeishuBatchDownloadUrl,
  isTrustedFeishuAttachmentUrl,
  normalizeSecureStorageIndexEntry,
  normalizeStorageIndexEntryForStartup,
  parseContractStorageIndex,
  resolveContractAttachmentIndexKey,
  selectContractStorageIndex,
  shouldQueueSecureAttachment,
  shouldRemoveStalePreviewDirectory,
} from './contract-attachment-storage.service';

async function withIsolatedIndexLoader(
  verify: (fixture: {
    service: ContractAttachmentStorageService;
    localPath: string;
    localBytes: string;
    key: Buffer;
    indexObjectKey: string;
    getObject: jest.Mock;
    putObject: jest.Mock;
    persistIndex: jest.SpyInstance;
    sdkCreated: boolean;
  }) => Promise<void>,
  enabledValue?: string,
) {
  const directory = await mkdtemp(join(tmpdir(), 'vnet-contract-index-read-'));
  const localPath = join(directory, 'index.json');
  const key = Buffer.alloc(32, 7);
  const localBytes = JSON.stringify(
    buildVersionedContractStorageIndex(
      {
        'contract:file-token': {
          version: 3,
          accessId: 'queued-attachment',
          storageId: 'storage-attachment',
          contractRecordId: 'contract',
          name: '合同.pdf',
          state: 'queued',
          pageCount: 0,
          pages: [],
          createdAt: '2026-07-14T05:46:04.443Z',
          updatedAt: '2026-07-14T05:46:04.443Z',
        },
      },
      11,
    ),
  );
  const originalEnv = process.env;
  try {
    await writeFile(localPath, localBytes, 'utf8');
    process.env = {
      ...originalEnv,
      COS_CONTRACT_INDEX_PATH: localPath,
      COS_CONTRACT_SECURE_PREFIX: 'test-contract-storage',
      COS_CONTRACT_INDEX_OBJECT_KEY: '',
      CONTRACT_ATTACHMENT_ENCRYPTION_KEY: key.toString('base64'),
      COS_SECRET_ID: 'test-only-cos-id',
      COS_SECRET_KEY: 'test-only-cos-key',
      COS_SESSION_TOKEN: '',
      TENCENTCLOUD_SESSION_TOKEN: '',
    };
    if (enabledValue === undefined)
      delete process.env.CONTRACT_ATTACHMENT_STORAGE_ENABLED;
    else process.env.CONTRACT_ATTACHMENT_STORAGE_ENABLED = enabledValue;
    const service = new ContractAttachmentStorageService({} as never);
    const internals = service as unknown as {
      cos: { getObject: jest.Mock; putObject: jest.Mock };
      indexObjectKey: string;
      persistIndex: () => Promise<void>;
      logger: {
        error: (message: string) => void;
        log: (message: string) => void;
      };
    };
    const getObject = jest.fn();
    const putObject = jest.fn().mockResolvedValue({});
    const sdkCreated = Boolean(internals.cos);
    internals.cos = { getObject, putObject };
    const persistIndex = jest.spyOn(internals, 'persistIndex');
    const errorLog = jest
      .spyOn(internals.logger, 'error')
      .mockImplementation(() => undefined);
    const fixtureLog = jest
      .spyOn(internals.logger, 'log')
      .mockImplementation(() => undefined);
    try {
      await verify({
        service,
        localPath,
        localBytes,
        key,
        indexObjectKey: internals.indexObjectKey,
        getObject,
        putObject,
        persistIndex,
        sdkCreated,
      });
    } finally {
      persistIndex.mockRestore();
      errorLog.mockRestore();
      fixtureLog.mockRestore();
      await service.onModuleDestroy();
    }
  } finally {
    process.env = originalEnv;
    await rm(directory, { recursive: true, force: true });
  }
}

describe('secure contract attachment object storage', () => {
  it.each(['false', '0', 'off', 'no', ' FALSE ', ' Off '])(
    'explicitly disables contract storage with %j despite valid inherited credentials',
    async (enabledValue) => {
      await withIsolatedIndexLoader(
        async ({
          service,
          sdkCreated,
          localPath,
          localBytes,
          getObject,
          putObject,
          persistIndex,
        }) => {
          expect(service.getStatus().configured).toBe(false);
          expect(sdkCreated).toBe(false);
          await service.onModuleInit();
          await expect(
            service.getManifest('queued-attachment'),
          ).resolves.toMatchObject({
            accessId: 'queued-attachment',
            previewStatus: 'failed',
            pageCount: 0,
            originalAvailable: false,
            unavailableReason: 'storage_not_configured',
          });
          const internals = service as unknown as {
            queue: unknown[];
            releaseMigrationLock: unknown;
            ensureIndexLoaded: () => Promise<void>;
            accessIndex: Map<string, unknown>;
            pageCache: Map<string, unknown>;
          };
          internals.accessIndex.set('queued-attachment', {
            state: 'ready',
            pages: [{ page: 1, objectKey: 'cached-page' }],
            objectKey: 'cached-original',
            sha256: 'digest',
          });
          internals.pageCache.set('queued-attachment:1', {
            buffer: Buffer.from('test-only-cached-page'),
            expiresAt: Date.now() + 60_000,
          });
          await expect(
            service.getOriginal('queued-attachment'),
          ).rejects.toThrow('合同附件存储已禁用');
          await expect(
            service.getPreviewPage('queued-attachment', 1),
          ).rejects.toThrow('合同附件存储已禁用');
          await internals.ensureIndexLoaded();
          expect(internals.releaseMigrationLock).toBeNull();
          expect(internals.queue).toHaveLength(0);
          expect(getObject).not.toHaveBeenCalled();
          expect(putObject).not.toHaveBeenCalled();
          expect(persistIndex).not.toHaveBeenCalled();
          expect(await readFile(localPath, 'utf8')).toBe(localBytes);
          await expect(
            readFile(`${localPath}.migration.lock`),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        },
        enabledValue,
      );
    },
  );

  it.each([undefined, '', 'true', '1', 'on', 'yes', 'unknown'])(
    'keeps the default storage behavior for %j',
    async (enabledValue) => {
      await withIsolatedIndexLoader(async ({ service, sdkCreated }) => {
        expect(service.getStatus().configured).toBe(true);
        expect(sdkCreated).toBe(true);
      }, enabledValue);
    },
  );

  it('rejects direct encrypted IO even if a disabled instance retains valid key and SDK state', async () => {
    await withIsolatedIndexLoader(
      async ({ service, key, getObject, putObject }) => {
        const internals = service as unknown as {
          encryptionKey: Buffer;
          readEncryptedObject: (path: string) => Promise<Buffer>;
          putEncryptedObject: (path: string, bytes: Buffer) => Promise<void>;
        };
        internals.encryptionKey = key;
        expect(service.getStatus().configured).toBe(false);
        await expect(
          internals.readEncryptedObject('test-only-object'),
        ).rejects.toThrow('合同附件存储已禁用');
        await expect(
          internals.putEncryptedObject(
            'test-only-object',
            Buffer.from('test-only-content'),
          ),
        ).rejects.toThrow('合同附件存储已禁用');
        expect(getObject).not.toHaveBeenCalled();
        expect(putObject).not.toHaveBeenCalled();
      },
      'false',
    );
  });

  it('prevents disabled storage from persisting dashboard enrichment or explicit mutations', async () => {
    await withIsolatedIndexLoader(
      async ({
        service,
        localPath,
        localBytes,
        getObject,
        putObject,
        persistIndex,
      }) => {
        expect(service.getStatus().configured).toBe(false);
        const dashboard = {
          contracts: [],
          contractRisks: [],
          paymentFollowUps: [],
        } as unknown as ContractManagementDashboard;
        const attachment = {
          name: '合同.pdf',
          file_token: 'test-file-token',
          url: 'https://open.feishu.cn/open-apis/drive/v1/medias/test-file-token/download',
        };
        await service.enrichAndSchedule(dashboard, [
          { record_id: 'contract', fields: { 合同附件: [attachment] } },
        ]);
        await expect(
          service.syncContractRecordAttachments('contract', [attachment]),
        ).rejects.toThrow();
        await expect(
          service.removeContractRecordAttachments('contract'),
        ).rejects.toThrow();
        expect(persistIndex).not.toHaveBeenCalled();
        const internals = service as unknown as {
          persistIndex: () => Promise<void>;
          persistIndexInBackground: () => void;
        };
        internals.persistIndexInBackground();
        expect(persistIndex).not.toHaveBeenCalled();
        await expect(internals.persistIndex()).rejects.toThrow();
        expect(getObject).not.toHaveBeenCalled();
        expect(putObject).not.toHaveBeenCalled();
        expect(await readFile(localPath, 'utf8')).toBe(localBytes);
      },
      'false',
    );
  });

  it.each(['', 'invalid-key'])(
    'returns an unavailable manifest rather than processing when the encryption key is %j',
    async (key) => {
      const originalEnv = process.env;
      process.env = {
        ...originalEnv,
        CONTRACT_ATTACHMENT_ENCRYPTION_KEY: key,
        COS_SECRET_ID: 'test-only-cos-id',
        COS_SECRET_KEY: 'test-only-cos-key',
        COS_SESSION_TOKEN: '',
        TENCENTCLOUD_SESSION_TOKEN: '',
      };
      try {
        const service = new ContractAttachmentStorageService({} as never);
        const entry = {
          version: 3,
          accessId: 'queued-attachment',
          storageId: 'storage-attachment',
          contractRecordId: 'rec_contract',
          name: '合同.pdf',
          state: 'queued',
          pageCount: 0,
          pages: [],
          createdAt: '2026-07-14T05:46:04.443Z',
          updatedAt: '2026-07-14T05:46:04.443Z',
        };
        const internals = service as unknown as {
          indexLoaded: Promise<void>;
          accessIndex: Map<string, unknown>;
        };
        internals.indexLoaded = Promise.resolve();
        internals.accessIndex.set(entry.accessId, entry);
        await expect(
          service.getManifest(entry.accessId),
        ).resolves.toMatchObject({
          previewStatus: 'failed',
          pageCount: 0,
          originalAvailable: false,
          unavailableReason: 'storage_not_configured',
        });
        expect(entry.state).toBe('queued');
      } finally {
        process.env = originalEnv;
      }
    },
  );

  it('keeps the migration lock readable by the prior runtime while recording process identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vnet-contract-lock-'));
    const lockPath = join(directory, 'migration.lock');
    try {
      const release = await acquireExclusiveProcessLock(lockPath);
      await expect(
        readFile(lockPath, 'utf8').then((value) => JSON.parse(value)),
      ).resolves.toMatchObject({
        version: 1,
        pid: process.pid,
        processStartedAtMs: expect.any(Number),
        acquiredAt: expect.any(String),
      });
      await release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers a legacy migration lock after its PID is reused by another process generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vnet-contract-lock-'));
    const lockPath = join(directory, 'migration.lock');
    try {
      await writeFile(
        lockPath,
        JSON.stringify({ pid: process.pid, token: 'legacy-lock-token' }),
      );
      await utimes(lockPath, new Date(0), new Date(0));

      const release = await acquireExclusiveProcessLock(lockPath);
      await release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers an identity-bearing migration lock whose recorded process generation is stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vnet-contract-lock-'));
    const lockPath = join(directory, 'migration.lock');
    try {
      await writeFile(
        lockPath,
        JSON.stringify({
          version: 1,
          pid: process.pid,
          processStartedAtMs: 1,
          acquiredAt: '2026-09-11T00:00:00.000Z',
          token: 'versioned-lock-token',
        }),
      );

      const release = await acquireExclusiveProcessLock(lockPath);
      await release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('waits for the configured preview readiness marker', () => {
    const readyFile = 'C:\\runtime\\contract-preview.ready';

    expect(isContractPreviewProcessorReady(readyFile, () => false)).toBe(false);
    expect(
      isContractPreviewProcessorReady(
        readyFile,
        (candidate) => candidate === readyFile,
      ),
    ).toBe(true);
    expect(isContractPreviewProcessorReady('', () => false)).toBe(true);
  });

  it('keeps attachment work queued until the preview processor is ready', async () => {
    const previousReadyFile = process.env.CONTRACT_PREVIEW_READY_FILE;
    process.env.CONTRACT_PREVIEW_READY_FILE = join(
      tmpdir(),
      `missing-contract-preview-ready-${process.pid}`,
    );
    const service = new ContractAttachmentStorageService({} as never);
    const internals = service as unknown as {
      queue: unknown[];
      drainQueue: () => void;
      sync: jest.Mock<Promise<void>, []>;
    };
    internals.sync = jest.fn().mockResolvedValue(undefined);
    internals.queue.push({ indexKey: 'queued-before-preview-ready' });

    try {
      internals.drainQueue();
      expect(internals.sync).not.toHaveBeenCalled();
      expect(internals.queue).toHaveLength(1);
    } finally {
      await service.onModuleDestroy();
      if (previousReadyFile === undefined) {
        delete process.env.CONTRACT_PREVIEW_READY_FILE;
      } else {
        process.env.CONTRACT_PREVIEW_READY_FILE = previousReadyFile;
      }
    }
  });

  it('keeps one stable index key when a Feishu temporary URL changes', () => {
    const firstUrl =
      'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=file-token-1&expires=100';
    const refreshedUrl =
      'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?expires=200&file_tokens=file-token-1';

    expect(extractFeishuAttachmentToken(firstUrl)).toBe('file-token-1');
    expect(
      buildContractAttachmentIndexKey(
        'contract-record-1',
        { name: '合同.pdf', url: firstUrl },
        0,
      ),
    ).toBe(
      buildContractAttachmentIndexKey(
        'contract-record-1',
        { name: '合同.pdf', url: refreshedUrl },
        0,
      ),
    );
  });

  it('uses a stable attachment slot only when no Feishu token is available', () => {
    const first = buildContractAttachmentIndexKey(
      'contract-record-1',
      { name: '合同.pdf', url: 'https://download.feishucdn.com/temporary-a' },
      0,
    );
    const refreshed = buildContractAttachmentIndexKey(
      'contract-record-1',
      { name: '合同.pdf', url: 'https://download.feishucdn.com/temporary-b' },
      0,
    );
    const replacement = buildContractAttachmentIndexKey(
      'contract-record-1',
      {
        name: '合同.pdf',
        url: 'https://download.feishucdn.com/temporary-c',
        fileToken: 'replacement-token',
      },
      0,
    );

    expect(first).toBe(refreshed);
    expect(replacement).not.toBe(first);
  });

  it('defers a legacy URL migration until the PDF digest matches', () => {
    const url =
      'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=same-token&expires=100';
    const legacyKey = `contract-record-1:${createHash('sha256')
      .update(url)
      .digest('hex')
      .slice(0, 32)}`;
    const digest = 'b'.repeat(64);
    const candidate = {
      contractRecordId: 'contract-record-1',
      name: '合同.pdf',
      state: 'ready',
      sha256: digest,
      objectKey: 'secure/storage/original.vnetc',
      pages: [{ page: 1 }],
    };

    expect(
      resolveContractAttachmentIndexKey(
        { [legacyKey]: candidate },
        'contract-record-1',
        { name: '合同.pdf', url },
        0,
      ),
    ).toEqual({
      indexKey: 'contract-record-1:same-token',
      previousKey: legacyKey,
    });
    expect(canReuseContractAttachmentContent(candidate, digest)).toBe(true);
    expect(canReuseContractAttachmentContent(candidate, 'c'.repeat(64))).toBe(
      false,
    );
  });

  it('matches a verified COS attachment when Feishu changes its token and removes the historical filename prefix', () => {
    const oldKey = 'contract-record-1:old-file-token';
    const candidate = {
      version: 3,
      accessId: 'verified-preview',
      storageId: 'private-storage-id-12345',
      contractRecordId: 'contract-record-1',
      name: 'ea7d7ed2abcd3424-V4892112P0038R002-消防维保合同.pdf',
      state: 'ready',
      objectKey: 'secure/storage/original.vnetc',
      sha256: 'b'.repeat(64),
      pageCount: 20,
      pages: [{ page: 1 }],
    };

    expect(
      resolveContractAttachmentIndexKey(
        { [oldKey]: candidate },
        'contract-record-1',
        {
          name: 'V4892112P0038R002-消防维保合同.pdf',
          url: 'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=new-file-token',
          fileToken: 'new-file-token',
        },
        0,
      ),
    ).toEqual({
      indexKey: 'contract-record-1:new-file-token',
      contentMatchKey: oldKey,
    });
  });

  it('maps the metadata index to a stable encrypted COS object', () => {
    expect(
      buildContractStorageIndexObjectKey(
        '/nantong-supply-chain/secure-contracts/',
      ),
    ).toBe(
      'nantong-supply-chain/secure-contracts/metadata/contract-index.vnetc',
    );
  });

  it('selects the newest versioned recovery index', () => {
    const remote = buildVersionedContractStorageIndex(
      { 'contract:remote': { version: 3 } },
      4,
    );
    const local = buildVersionedContractStorageIndex(
      { 'contract:local': { version: 3 } },
      5,
    );

    expect(selectContractStorageIndex(remote, local)).toEqual({
      index: local,
      source: 'local',
    });
    expect(selectContractStorageIndex(local, remote)).toEqual({
      index: local,
      source: 'cos',
    });
  });

  it('selects the authenticated COS revision 1036 over the report-like local revision 11 queued index', () => {
    const local = buildVersionedContractStorageIndex(
      {
        'contract:new-token': {
          version: 3,
          accessId: 'current-queued',
          state: 'queued',
          pages: [],
          pageCount: 0,
        },
      },
      11,
    );
    const cos = buildVersionedContractStorageIndex(
      {
        'contract:old-token': {
          version: 3,
          accessId: 'historical-ready',
          state: 'ready',
          pageCount: 2,
          pages: [{ page: 1 }, { page: 2 }],
        },
      },
      1036,
    );
    const beforeLocal = JSON.stringify(local);
    const beforeCos = JSON.stringify(cos);
    expect(selectContractStorageIndex(cos, local)).toEqual({
      index: cos,
      source: 'cos',
    });
    expect(JSON.stringify(local)).toBe(beforeLocal);
    expect(JSON.stringify(cos)).toBe(beforeCos);
  });

  it.each([
    { label: 'unauthorized', statusCode: 401, code: 'InvalidAccessKeyId' },
    { label: 'forbidden', statusCode: 403, code: 'AccessDenied' },
    { label: 'connection failure', code: 'ECONNRESET' },
    { label: 'TLS failure', code: 'CERT_HAS_EXPIRED' },
  ])(
    'never persists a local index after a COS $label read failure',
    async ({ label, ...details }) => {
      await withIsolatedIndexLoader(
        async ({
          service,
          localPath,
          localBytes,
          getObject,
          putObject,
          persistIndex,
        }) => {
          const failure = Object.assign(new Error(label), details);
          getObject.mockRejectedValue(failure);
          await expect(service.getManifest('queued-attachment')).rejects.toBe(
            failure,
          );
          expect(persistIndex).not.toHaveBeenCalled();
          expect(putObject).not.toHaveBeenCalled();
          expect(await readFile(localPath, 'utf8')).toBe(localBytes);
        },
      );
    },
  );

  it('never persists a local index when the COS index fails real GCM key verification', async () => {
    await withIsolatedIndexLoader(
      async ({
        service,
        localPath,
        localBytes,
        indexObjectKey,
        getObject,
        putObject,
        persistIndex,
      }) => {
        getObject.mockResolvedValue({
          Body: encryptContractBuffer(
            Buffer.from(localBytes),
            Buffer.alloc(32, 8),
            indexObjectKey,
          ),
        });
        await expect(service.getManifest('queued-attachment')).rejects.toThrow(
          '合同附件密文校验失败',
        );
        expect(persistIndex).not.toHaveBeenCalled();
        expect(putObject).not.toHaveBeenCalled();
        expect(await readFile(localPath, 'utf8')).toBe(localBytes);
      },
    );
  });

  it('recovers a local index only after a confirmed missing COS object and encrypts the next revision', async () => {
    await withIsolatedIndexLoader(
      async ({
        service,
        localPath,
        key,
        indexObjectKey,
        getObject,
        putObject,
        persistIndex,
      }) => {
        getObject.mockRejectedValue({ statusCode: 404, code: 'NoSuchKey' });
        await expect(
          service.getManifest('queued-attachment'),
        ).resolves.toMatchObject({ previewStatus: 'processing', pageCount: 0 });
        expect(persistIndex).toHaveBeenCalledTimes(1);
        expect(putObject).toHaveBeenCalledTimes(1);
        const uploaded = putObject.mock.calls[0][0];
        const decrypted = decryptContractBuffer(
          uploaded.Body,
          key,
          indexObjectKey,
        ).toString('utf8');
        expect(uploaded.Key).toBe(indexObjectKey);
        expect(decrypted).toBe(await readFile(localPath, 'utf8'));
        expect(
          JSON.parse(decrypted).__vnet_contract_storage_index_meta__.revision,
        ).toBe(12);
      },
    );
  });

  it('parses only object-shaped COS metadata indexes', () => {
    expect(
      parseContractStorageIndex(Buffer.from('{"contract:1":{"version":3}}')),
    ).toEqual({ 'contract:1': { version: 3 } });
    expect(() => parseContractStorageIndex(Buffer.from('[]'))).toThrow(
      /索引格式无效/,
    );
  });

  it('builds a safe local preview processor environment', () => {
    const environment = buildLocalProcessorEnvironment({
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      COS_SECRET_KEY: 'must-not-leak',
      FEISHU_APP_SECRET: 'must-not-leak',
    });

    expect(environment).toMatchObject({
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
    });
    expect(JSON.stringify(environment)).not.toContain('must-not-leak');
  });

  it('binds a leading-dash watermark id to its argparse option', () => {
    expect(
      buildRenderPreviewArguments('C:\\temp\\preview', '-opaque-id'),
    ).toEqual([
      '--output-dir',
      'C:\\temp\\preview',
      '--watermark-id=-opaque-id',
    ]);
  });

  it('builds opaque storage keys and safe public legacy URLs', () => {
    expect(
      buildSecureContractObjectKey(
        'nantong-supply-chain/secure-contracts',
        'random-storage-id-123',
        'original',
      ),
    ).toBe(
      'nantong-supply-chain/secure-contracts/random-storage-id-123/original.vnetc',
    );
    expect(
      buildCosPublicObjectUrl(
        'jy-1421907124',
        'ap-shanghai',
        'legacy/contracts/a b.pdf',
      ),
    ).toBe(
      'https://jy-1421907124.cos.ap-shanghai.myqcloud.com/legacy/contracts/a%20b.pdf',
    );
  });

  it('returns only opaque preview metadata to the frontend', () => {
    const dto = buildSafeAttachmentDto({
      accessId: 'opaque-token',
      name: '维保合同.pdf',
      state: 'ready',
      pageCount: 12,
      storageId: 'private-storage-id',
      objectKey: 'secure/original.vnetc',
    });

    expect(dto).toEqual({
      accessId: 'opaque-token',
      name: '维保合同.pdf',
      previewStatus: 'ready',
      pageCount: 12,
    });
    expect(JSON.stringify(dto)).not.toMatch(/https?:|objectKey|storageId/);
  });

  it('reports and serves a verified original while page previews are still processing', async () => {
    const service = new ContractAttachmentStorageService({} as never);
    const pdf = Buffer.from('%PDF-1.7\nverified original');
    const entry = {
      version: 3,
      accessId: 'processing-with-original',
      storageId: 'private-storage-id-12345',
      contractRecordId: 'contract-1',
      name: '维保合同.pdf',
      state: 'processing',
      objectKey: 'secure/private/original.vnetc',
      sha256: createHash('sha256').update(pdf).digest('hex'),
      bytes: pdf.length,
      pageCount: 0,
      pages: [],
      createdAt: '2026-09-22T00:00:00.000Z',
      updatedAt: '2026-09-22T00:00:00.000Z',
    };
    const internals = service as unknown as {
      indexLoaded: Promise<void>;
      accessIndex: Map<string, unknown>;
      readEncryptedObject: jest.Mock<Promise<Buffer>, [string]>;
    };
    internals.indexLoaded = Promise.resolve();
    internals.accessIndex.set(entry.accessId, entry);
    internals.readEncryptedObject = jest.fn().mockResolvedValue(pdf);

    await expect(service.getManifest(entry.accessId)).resolves.toMatchObject({
      previewStatus: 'processing',
      originalAvailable: true,
    });
    await expect(service.getOriginal(entry.accessId)).resolves.toMatchObject({
      buffer: pdf,
      name: '维保合同.pdf',
      contentType: 'application/pdf',
    });
    await service.onModuleDestroy();
  });

  it('refreshes cached dashboard attachment states from the latest secure index', () => {
    const service = new ContractAttachmentStorageService({} as never);
    const internals = service as unknown as {
      accessIndex: Map<string, unknown>;
    };
    internals.accessIndex.set('latest-ready', {
      accessId: 'latest-ready',
      name: '合同原件.pdf',
      state: 'ready',
      pageCount: 12,
    });
    const stale = {
      contracts: [
        {
          recordId: 'contract-1',
          attachments: [
            {
              accessId: 'latest-ready',
              name: '合同原件.pdf',
              previewStatus: 'processing',
              pageCount: 0,
            },
          ],
        },
      ],
      unsignedContracts: [],
      contractRisks: [],
      paymentFollowUps: [],
    } as unknown as ContractManagementDashboard;

    const refreshed = service.refreshDashboardAttachmentStates(stale);

    expect(refreshed.contracts[0].attachments[0]).toMatchObject({
      previewStatus: 'ready',
      pageCount: 12,
    });
    expect(refreshed).not.toBe(stale);
  });

  it('rebinds a cached processing attachment to the newest verified preview for the same contract and business filename', () => {
    const service = new ContractAttachmentStorageService({} as never);
    const internals = service as unknown as {
      accessIndex: Map<string, unknown>;
    };
    internals.accessIndex.set('verified-preview', {
      accessId: 'verified-preview',
      contractRecordId: 'recv3xlXrJaJ1X',
      name: 'ea7d7ed2abcd3424-V4892112P0038R002-消防维保合同.pdf',
      state: 'ready',
      pageCount: 20,
      pages: [{ page: 1 }],
      updatedAt: '2026-07-13T01:53:02.410Z',
    });
    const shadowEntry = {
      accessId: 'shadow-processing',
      contractRecordId: 'recv3xlXrJaJ1X',
      name: 'V4892112P0038R002-消防维保合同.pdf',
      state: 'processing',
      pageCount: 0,
      pages: [],
      updatedAt: '2026-09-23T00:00:00.000Z',
    };
    internals.accessIndex.set('shadow-processing', shadowEntry);
    const cached = {
      contracts: [
        {
          recordId: 'recv3xlXrJaJ1X',
          attachments: [
            {
              accessId: 'shadow-processing',
              name: 'V4892112P0038R002-消防维保合同.pdf',
              previewStatus: 'processing',
              pageCount: 0,
            },
          ],
        },
      ],
      unsignedContracts: [],
      contractRisks: [],
      paymentFollowUps: [],
    } as unknown as ContractManagementDashboard;

    const refreshed = service.refreshDashboardAttachmentStates(cached);

    expect(refreshed.contracts[0].attachments[0]).toEqual({
      accessId: 'verified-preview',
      name: 'V4892112P0038R002-消防维保合同.pdf',
      previewStatus: 'ready',
      pageCount: 20,
    });

    Object.assign(shadowEntry, {
      state: 'ready',
      pageCount: 20,
      pages: [{ page: 1 }],
      updatedAt: '2026-09-23T01:00:00.000Z',
    });
    const switched = service.refreshDashboardAttachmentStates(refreshed);
    expect(switched.contracts[0].attachments[0]).toEqual({
      accessId: 'shadow-processing',
      name: 'V4892112P0038R002-消防维保合同.pdf',
      previewStatus: 'ready',
      pageCount: 20,
    });
  });

  it('rejects non-PDF content and recognizes protected legacy tombstones', () => {
    expect(() => assertPdfAttachment(Buffer.from('not a pdf'))).toThrow(
      /不是有效 PDF/,
    );
    expect(() => assertPdfAttachment(Buffer.from('%PDF-1.7\n'))).not.toThrow();
    expect(
      isMigrationTombstone(
        Buffer.from(
          'This object has been migrated to protected contract storage.',
        ),
      ),
    ).toBe(true);
  });

  it('sends credentials only to trusted Feishu HTTPS endpoints', () => {
    expect(
      isOfficialFeishuBatchDownloadUrl(
        'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=token',
      ),
    ).toBe(true);
    expect(
      isOfficialFeishuBatchDownloadUrl(
        'https://open.feishu.cn.evil.test/open-apis/drive/v1/medias/batch_get_tmp_download_url',
      ),
    ).toBe(false);
    expect(
      isTrustedFeishuAttachmentUrl(
        'https://download.feishucdn.com/signed/contract.pdf',
      ),
    ).toBe(true);
    expect(isTrustedFeishuAttachmentUrl('https://127.0.0.1/file')).toBe(false);
  });

  it('requeues incomplete protection and migration work', () => {
    expect(
      shouldQueueSecureAttachment({
        state: 'ready',
        legacyObjectKey: 'legacy/plain.pdf',
      }),
    ).toBe(true);
    expect(
      shouldQueueSecureAttachment({
        state: 'ready',
        legacyObjectKey: 'legacy/plain.pdf',
        legacyProtectedAt: '2026-07-12T00:00:00.000Z',
      }),
    ).toBe(false);
    expect(shouldQueueSecureAttachment({ state: 'queued' })).toBe(true);
    expect(shouldQueueSecureAttachment({ state: 'failed' })).toBe(false);
  });

  it('upgrades old secure entries without treating ciphertext as legacy PDF', () => {
    const normalized = normalizeSecureStorageIndexEntry({
      version: 2,
      accessId: 'old-public-access-id',
      contractRecordId: 'contract-1',
      name: '合同原件.pdf',
      state: 'ready',
      objectKey: 'secure/old-access/original.vnetc',
      sha256: 'a'.repeat(64),
      pageCount: 1,
      pages: [
        {
          page: 1,
          objectKey: 'secure/old-access/pages/0001.vnetc',
          width: 800,
          height: 1100,
          bytes: 1234,
        },
      ],
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    });

    expect(normalized).toMatchObject({
      version: 3,
      accessId: 'old-public-access-id',
      state: 'queued',
      obsoleteObjectKeys: [
        'secure/old-access/original.vnetc',
        'secure/old-access/pages/0001.vnetc',
      ],
    });
    expect(normalized?.storageId).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  });

  it('upgrades a plaintext legacy index entry during startup', () => {
    const normalized = normalizeStorageIndexEntryForStartup(
      'contract-record-1:file-token',
      {
        objectKey: 'legacy/contracts/original.pdf',
        url: 'https://bucket.example/legacy/contracts/original.pdf',
        syncedAt: '2026-07-11T00:00:00.000Z',
      },
    );

    expect(normalized).toMatchObject({
      version: 3,
      contractRecordId: 'contract-record-1',
      state: 'queued',
      legacyObjectKey: 'legacy/contracts/original.pdf',
    });
    expect(normalized).not.toHaveProperty('url');
  });

  it('continues serialized index writes after one operation rejects', async () => {
    const writes: string[] = [];
    const first = enqueueRecoverableWrite(Promise.resolve(), async () => {
      writes.push('first');
      throw new Error('temporary file lock');
    });
    await expect(first.operation).rejects.toThrow('temporary file lock');

    const second = enqueueRecoverableWrite(first.continuation, async () => {
      writes.push('second');
    });
    await expect(second.operation).resolves.toBeUndefined();
    expect(writes).toEqual(['first', 'second']);
  });

  it('allows only one process owner for an index migration', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'contract-lock-test-'));
    const lockPath = join(directory, 'migration.lock');
    try {
      const releaseFirst = await acquireExclusiveProcessLock(lockPath);
      await expect(acquireExclusiveProcessLock(lockPath)).rejects.toThrow(
        /正在由另一个进程处理/,
      );
      await releaseFirst();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('recovers only jobs that can continue without a dashboard request', () => {
    const recoverable = {
      version: 3,
      accessId: 'public-id-1',
      storageId: 'private-storage-id-12345',
      contractRecordId: 'contract-1',
      name: '合同原件.pdf',
      state: 'ready',
      objectKey: 'secure/private/original.vnetc',
      legacyObjectKey: 'legacy/public.pdf',
      sha256: 'a'.repeat(64),
      pageCount: 1,
      pages: [],
      createdAt: '2026-07-11T00:00:00.000Z',
      updatedAt: '2026-07-11T00:00:00.000Z',
    };

    expect(buildStartupRecoveryJobs({ a: recoverable })).toEqual([
      {
        indexKey: 'a',
        source: { name: '合同原件.pdf', url: '' },
      },
    ]);
  });

  it('cleans only abandoned preview directories', () => {
    const now = Date.parse('2026-07-13T12:00:00.000Z');
    expect(
      shouldRemoveStalePreviewDirectory(
        'vnet-contract-preview-999999-old',
        now - 2 * 60 * 60 * 1000,
        now,
        () => false,
      ),
    ).toBe(true);
    expect(
      shouldRemoveStalePreviewDirectory(
        `vnet-contract-preview-${process.pid}-live`,
        now - 2 * 60 * 60 * 1000,
        now,
        () => true,
      ),
    ).toBe(false);
  });

  it('maps COS preview attachments onto expired payment follow-up items', async () => {
    const service = new ContractAttachmentStorageService({} as never);
    const internals = service as unknown as {
      indexLoaded: Promise<void>;
      persistIndex: jest.Mock<Promise<void>, []>;
    };
    internals.indexLoaded = Promise.resolve();
    internals.persistIndex = jest.fn().mockResolvedValue(undefined);
    const dashboard = {
      contracts: [],
      contractRisks: [],
      paymentFollowUps: [
        {
          contractRecordId: 'expired-contract',
          contractName: '到期合同',
          contractCode: 'HT-001',
          owner: '负责人',
          contractAmount: 100,
          contractEndDate: '2026-07-01',
          reason: 'missing_plan',
          planCount: 0,
          unpaidPlanCount: 0,
          plannedAmount: 0,
          paidAmount: 0,
          pendingAmount: 100,
          attachments: [],
        },
      ],
    } as ContractManagementDashboard;

    const result = await service.enrichAndSchedule(dashboard, [
      {
        record_id: 'expired-contract',
        fields: {
          合同附件: [
            {
              name: '到期合同.pdf',
              tmp_url:
                'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=file-token',
            },
          ],
        },
      },
    ]);

    expect(result.paymentFollowUps[0].attachments).toEqual([
      expect.objectContaining({
        name: '到期合同.pdf',
        accessId: expect.any(String),
        previewStatus: 'processing',
      }),
    ]);
    await service.onModuleDestroy();
  });

  it('keeps a verified COS preview visible while a renamed-token source is verified in the background', async () => {
    const service = new ContractAttachmentStorageService({} as never);
    const oldKey = 'recv3xlXrJaJ1X:old-file-token';
    const oldEntry = {
      version: 3,
      accessId: 'verified-preview',
      storageId: 'private-storage-id-12345',
      contractRecordId: 'recv3xlXrJaJ1X',
      name: 'ea7d7ed2abcd3424-V4892112P0038R002-消防维保合同.pdf',
      state: 'ready',
      objectKey: 'secure/storage/original.vnetc',
      sha256: 'b'.repeat(64),
      bytes: 43_481_687,
      pageCount: 20,
      pages: [{ page: 1 }],
      createdAt: '2026-07-13T01:53:02.410Z',
      updatedAt: '2026-07-13T01:53:02.410Z',
    };
    const internals = service as unknown as {
      indexLoaded: Promise<void>;
      index: Record<string, unknown>;
      accessIndex: Map<string, unknown>;
      persistIndex: jest.Mock<Promise<void>, []>;
      enqueue: jest.Mock<void, [unknown[]]>;
    };
    internals.indexLoaded = Promise.resolve();
    internals.index[oldKey] = oldEntry;
    internals.accessIndex.set(oldEntry.accessId, oldEntry);
    internals.persistIndex = jest.fn().mockResolvedValue(undefined);
    internals.enqueue = jest.fn();
    const dashboard = {
      contracts: [
        {
          recordId: 'recv3xlXrJaJ1X',
          attachments: [],
        },
      ],
      contractRisks: [],
      paymentFollowUps: [],
    } as ContractManagementDashboard;

    const result = await service.enrichAndSchedule(dashboard, [
      {
        record_id: 'recv3xlXrJaJ1X',
        fields: {
          合同附件: [
            {
              name: 'V4892112P0038R002-消防维保合同.pdf',
              file_token: 'new-file-token',
              tmp_url:
                'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=new-file-token',
            },
          ],
        },
      },
    ]);

    expect(result.contracts[0].attachments).toEqual([
      {
        accessId: 'verified-preview',
        name: 'V4892112P0038R002-消防维保合同.pdf',
        previewStatus: 'ready',
        pageCount: 20,
      },
    ]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(internals.enqueue).toHaveBeenCalledWith([
      expect.objectContaining({
        indexKey: 'recv3xlXrJaJ1X:new-file-token',
        contentMatchKey: oldKey,
      }),
    ]);
    await service.onModuleDestroy();
  });

  it('does not block dashboard enrichment on index persistence', async () => {
    const service = new ContractAttachmentStorageService({} as never);
    const internals = service as unknown as {
      indexLoaded: Promise<void>;
      persistIndex: jest.Mock<Promise<void>, []>;
    };
    internals.indexLoaded = Promise.resolve();
    internals.persistIndex = jest.fn(() => new Promise<void>(() => undefined));
    const dashboard = {
      contracts: [{ recordId: 'dashboard-contract', attachments: [] }],
      contractRisks: [],
      paymentFollowUps: [],
    } as ContractManagementDashboard;

    const outcome = await Promise.race([
      service
        .enrichAndSchedule(dashboard, [
          {
            record_id: 'dashboard-contract',
            fields: {
              合同附件: [
                {
                  name: '新附件.pdf',
                  file_token: 'dashboard-attachment',
                  tmp_url:
                    'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=dashboard-attachment',
                },
              ],
            },
          },
        ])
        .then(() => 'resolved' as const),
      new Promise<'blocked'>((resolve) =>
        setImmediate(() => resolve('blocked')),
      ),
    ]);

    expect(outcome).toBe('resolved');
    expect(internals.persistIndex).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('waits for a newly created contract attachment to reach ready', async () => {
    const service = new ContractAttachmentStorageService({} as never);
    const internals = service as unknown as {
      indexLoaded: Promise<void>;
      index: Record<string, Record<string, unknown>>;
      persistIndex: jest.Mock<Promise<void>, []>;
      sync: jest.Mock<Promise<void>, [{ indexKey: string }]>;
    };
    internals.indexLoaded = Promise.resolve();
    internals.persistIndex = jest.fn().mockResolvedValue(undefined);
    internals.sync = jest.fn(async (job) => {
      Object.assign(internals.index[job.indexKey], {
        state: 'ready',
        objectKey:
          'nantong-supply-chain/secure-contracts/storage-new/original.vnetc',
        sha256: 'a'.repeat(64),
        pageCount: 1,
        pages: [
          {
            page: 1,
            objectKey:
              'nantong-supply-chain/secure-contracts/storage-new/pages/0001.vnetc',
            width: 800,
            height: 1100,
            bytes: 1024,
          },
        ],
      });
    });

    const result = await service.syncContractRecordAttachments(
      'rec-new-contract',
      [
        {
          name: '新合同.pdf',
          file_token: 'box-new-contract',
          tmp_url:
            'https://open.feishu.cn/open-apis/drive/v1/medias/batch_get_tmp_download_url?file_tokens=box-new-contract',
        },
      ],
    );

    expect(internals.sync).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      expect.objectContaining({
        name: '新合同.pdf',
        accessId: expect.any(String),
        previewStatus: 'ready',
        pageCount: 1,
      }),
    ]);
    await service.onModuleDestroy();
  });

  it('removes only one contract secure objects and index entries', async () => {
    const service = new ContractAttachmentStorageService({} as never);
    const ownEntry = {
      version: 3,
      accessId: 'access-own',
      storageId: 'storage-own',
      contractRecordId: 'rec-own',
      name: '自测合同.pdf',
      state: 'ready',
      objectKey:
        'nantong-supply-chain/secure-contracts/storage-own/original.vnetc',
      sha256: 'a'.repeat(64),
      pageCount: 1,
      pages: [
        {
          page: 1,
          objectKey:
            'nantong-supply-chain/secure-contracts/storage-own/pages/0001.vnetc',
          width: 800,
          height: 1100,
          bytes: 1024,
        },
      ],
      obsoleteObjectKeys: ['outside-prefix/must-not-delete.vnetc'],
      createdAt: '2026-07-13T00:00:00.000Z',
      updatedAt: '2026-07-13T00:00:00.000Z',
    };
    const otherEntry = {
      ...ownEntry,
      accessId: 'access-other',
      storageId: 'storage-other',
      contractRecordId: 'rec-other',
      objectKey:
        'nantong-supply-chain/secure-contracts/storage-other/original.vnetc',
      pages: [],
      pageCount: 0,
    };
    const deleteObject = jest.fn().mockResolvedValue(undefined);
    const internals = service as unknown as {
      indexLoaded: Promise<void>;
      index: Record<string, unknown>;
      accessIndex: Map<string, unknown>;
      pageCache: Map<string, unknown>;
      cos: { deleteObject: typeof deleteObject };
      persistIndex: jest.Mock<Promise<void>, []>;
    };
    internals.indexLoaded = Promise.resolve();
    internals.index = { own: ownEntry, other: otherEntry };
    internals.accessIndex.set(ownEntry.accessId, ownEntry);
    internals.accessIndex.set(otherEntry.accessId, otherEntry);
    internals.pageCache.set('access-own:1', {
      buffer: Buffer.from('page'),
      expiresAt: Date.now() + 1000,
    });
    internals.cos = { deleteObject };
    internals.persistIndex = jest.fn().mockResolvedValue(undefined);

    await expect(
      service.removeContractRecordAttachments('rec-own'),
    ).resolves.toBe(1);

    expect(deleteObject.mock.calls.map(([value]) => value.Key)).toEqual([
      'nantong-supply-chain/secure-contracts/storage-own/original.vnetc',
      'nantong-supply-chain/secure-contracts/storage-own/pages/0001.vnetc',
    ]);
    expect(internals.index).toEqual({ other: otherEntry });
    expect(internals.accessIndex.has('access-own')).toBe(false);
    expect(internals.accessIndex.has('access-other')).toBe(true);
    expect(internals.pageCache.has('access-own:1')).toBe(false);
    expect(internals.persistIndex).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });
});
