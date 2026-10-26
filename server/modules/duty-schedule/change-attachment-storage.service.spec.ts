import { createHash } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Logger } from '@nestjs/common';
import {
  CHANGE_ATTACHMENT_MAX_BYTES,
  CHANGE_ATTACHMENT_MUTATION_MAX_BYTES,
  CHANGE_ATTACHMENT_MUTATION_MAX_FILES,
  ChangeAttachmentStorageService,
  type ChangeAttachmentAccessContext,
  type ChangeAttachmentCosClient,
} from './change-attachment-storage.service';

interface StoredObject {
  body: Buffer;
  contentType?: string;
}

class FakeCos implements ChangeAttachmentCosClient {
  readonly objects = new Map<string, StoredObject>();
  readonly uploadCalls: Array<Record<string, unknown>> = [];
  readonly putCalls: Array<Record<string, unknown>> = [];
  readonly sliceCalls: Array<Record<string, unknown>> = [];
  readonly getCalls: Array<Record<string, unknown>> = [];
  readonly deleteCalls: Array<Record<string, unknown>> = [];
  readonly signedCalls: Array<Record<string, unknown>> = [];
  failDelete = false;
  deleteError: unknown = null;
  failUpload = false;
  failPut = false;
  failGet = false;
  failSign = false;
  beforeUpload?: (params: Record<string, unknown>) => Promise<void> | void;
  beforeDelete?: (params: Record<string, unknown>) => Promise<void> | void;

  async sliceUploadFile(params: Record<string, unknown>) {
    this.sliceCalls.push(params);
    throw new Error('sliceUploadFile must not be called');
  }

  async putObject(params: Record<string, unknown>) {
    this.uploadCalls.push(params);
    this.putCalls.push(params);
    const body = params.Body as Readable;
    await this.beforeUpload?.(params);
    if (this.failUpload) {
      body.destroy();
      throw new Error('Authorization=secret-upload-signature');
    }
    if (this.failPut) {
      body.destroy();
      throw new Error('SecretKey=secret-put-signature');
    }
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    this.objects.set(String(params.Key), {
      body: Buffer.concat(chunks),
      contentType: String(params.ContentType || ''),
    });
    return { ETag: 'fake-put-etag', Location: 'private.invalid' };
  }

  async getObject(params: Record<string, unknown>) {
    this.getCalls.push(params);
    if (this.failGet) throw new Error('SecretKey=secret-read-key');
    const stored = this.objects.get(String(params.Key));
    if (!stored) throw new Error('NoSuchKey');
    const range =
      typeof params.Range === 'string'
        ? params.Range.match(/^bytes=(\d+)-(\d+)$/)
        : null;
    const body = range
      ? stored.body.subarray(Number(range[1]), Number(range[2]) + 1)
      : stored.body;
    if (params.Output) {
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < body.length; offset += 1024 * 1024) {
        chunks.push(body.subarray(offset, offset + 1024 * 1024));
      }
      await pipeline(Readable.from(chunks), params.Output as Writable);
      return { ETag: 'fake-etag' };
    }
    return { Body: Buffer.from(body), ETag: 'fake-etag' };
  }

  async deleteObject(params: Record<string, unknown>) {
    this.deleteCalls.push(params);
    await this.beforeDelete?.(params);
    if (this.deleteError) throw this.deleteError;
    if (this.failDelete) throw new Error('SecretKey=must-not-leak');
    this.objects.delete(String(params.Key));
    return {};
  }

  getObjectUrl(params: Record<string, unknown>) {
    this.signedCalls.push(params);
    if (this.failSign) throw new Error('signature=secret-download-signature');
    return `https://signed.example.test/${String(params.Key)}?signature=test`;
  }
}

describe('ChangeAttachmentStorageService', () => {
  let root: string;
  let indexPath: string;
  let sourcePath: string;
  let cos: FakeCos;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vnet-change-storage-test-'));
    indexPath = join(root, 'index.json');
    sourcePath = join(root, 'scheme.pdf');
    await writeFile(sourcePath, Buffer.from('0123456789', 'utf8'));
    cos = new FakeCos();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function createService(
    overrides: Partial<
      ConstructorParameters<typeof ChangeAttachmentStorageService>[0]
    > = {},
  ) {
    return new ChangeAttachmentStorageService({
      cos,
      indexPath,
      env: {
        COS_CHANGE_BUCKET: 'change-bucket-1234567890',
        COS_CHANGE_REGION: 'ap-beijing',
        COS_CHANGE_PREFIX: 'private/change-attachments/v1',
      },
      ...overrides,
    });
  }

  function ownerAccess(
    ownerMutationId = 'mutation-1',
  ): ChangeAttachmentAccessContext {
    return { ownerMutationId };
  }

  async function stage(
    service = createService(),
    ownerMutationId = 'mutation-1',
  ) {
    await service.onModuleInit();
    return service.stageFromDisk(
      {
        path: sourcePath,
        name: 'change-scheme.pdf',
        mimetype: 'application/pdf',
        size: 10,
      },
      ownerMutationId,
    );
  }

  it('uploads from a snapshot stream, computes sha256 and returns only an application URL', async () => {
    const service = createService();
    const result = await stage(service);

    expect(cos.uploadCalls).toHaveLength(1);
    expect(cos.uploadCalls[0]).toMatchObject({
      Bucket: 'change-bucket-1234567890',
      Region: 'ap-beijing',
      ContentLength: 10,
      ContentType: 'application/pdf',
    });
    expect(cos.uploadCalls[0]).not.toHaveProperty('ACL');
    expect(cos.uploadCalls[0].Body).toBeInstanceOf(Readable);
    expect(
      String((cos.uploadCalls[0].Body as Readable & { path?: string }).path),
    ).not.toBe(sourcePath);
    expect(String(cos.uploadCalls[0].Key)).toMatch(
      /^private\/change-attachments\/v1\/[A-Za-z0-9_-]+\/change-scheme\.pdf$/,
    );
    expect(result).toEqual({
      id: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
      filePath: cos.uploadCalls[0].Key,
      bucketId: 'change-bucket-1234567890',
      url: `/api/duty-schedules/change-attachments/${result.id}/download`,
      name: 'change-scheme.pdf',
      size: 10,
      mimeType: 'application/pdf',
      sha256: createHash('sha256').update('0123456789').digest('hex'),
    });
    expect(result.url).not.toContain('myqcloud.com');
  });

  it('rejects empty, oversized and declared-size-mismatched files at the 200 MiB boundary', async () => {
    const service = createService();
    await service.onModuleInit();

    await expect(
      service.stageFromDisk(
        {
          path: sourcePath,
          name: 'a.pdf',
          mimetype: 'application/pdf',
          size: 0,
        },
        'mutation-1',
      ),
    ).rejects.toThrow('附件不能为空');
    await expect(
      service.stageFromDisk(
        {
          path: sourcePath,
          name: 'a.pdf',
          mimetype: 'application/pdf',
          size: CHANGE_ATTACHMENT_MAX_BYTES + 1,
        },
        'mutation-1',
      ),
    ).rejects.toThrow('200MB');
    await expect(
      service.stageFromDisk(
        {
          path: sourcePath,
          name: 'a.pdf',
          mimetype: 'application/pdf',
          size: 9,
        },
        'mutation-1',
      ),
    ).rejects.toThrow('大小不一致');
  });

  it('rejects source paths that traverse a symlink or Windows junction', async () => {
    const service = createService();
    await service.onModuleInit();
    const linkedRoot = join(root, 'linked-root');
    await symlink(
      root,
      linkedRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(
      service.stageFromDisk(
        {
          path: join(linkedRoot, 'scheme.pdf'),
          name: 'scheme.pdf',
          mimetype: 'application/pdf',
          size: 10,
        },
        'mutation-link',
      ),
    ).rejects.toThrow('符号链接');
    expect(cos.uploadCalls).toHaveLength(0);
  });

  it('uploads an immutable service-owned snapshot and removes it afterwards', async () => {
    const service = createService();
    cos.beforeUpload = async () => {
      await writeFile(sourcePath, Buffer.from('changed-after-hash', 'utf8'));
    };

    const uploaded = await stage(service, 'mutation-snapshot');
    const uploadPath = String(
      (cos.uploadCalls[0].Body as Readable & { path?: string }).path,
    );
    const stored = cos.objects.get(uploaded.filePath);

    expect(uploadPath).not.toBe(sourcePath);
    expect(stored?.body).toEqual(Buffer.from('0123456789'));
    await expect(access(uploadPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uploads a 21 MiB attachment directly with a precise-length putObject stream', async () => {
    const largePath = join(root, 'scheme-21m.pdf');
    const size = 21 * 1024 * 1024;
    const handle = await open(largePath, 'w');
    await handle.truncate(size);
    await handle.close();
    const directCos = new FakeCos();
    directCos.sliceUploadFile = jest.fn(async () => {
      throw new Error('sliceUploadFile must not be called');
    });
    directCos.putObject = jest.fn(async (params: Record<string, unknown>) => {
      directCos.putCalls.push(params);
      for await (const _chunk of params.Body as Readable) {
        // Drain without retaining the attachment in memory.
      }
      return { ETag: 'fake-put-etag', Location: 'private.invalid' };
    });
    const service = createService({ cos: directCos });
    await service.onModuleInit();

    await expect(
      service.stageFromDisk(
        {
          path: largePath,
          name: 'scheme-21m.pdf',
          mimetype: 'application/pdf',
          size,
        },
        'mutation-21m-direct-put',
      ),
    ).resolves.toMatchObject({ size });
    expect(directCos.sliceUploadFile).not.toHaveBeenCalled();
    expect(directCos.putCalls).toHaveLength(1);
    expect(directCos.putCalls[0].Body).toBeInstanceOf(Readable);
    expect(directCos.putCalls[0].ContentLength).toBe(size);
  }, 30_000);

  it('cleans a failed direct putObject and never exposes its COS error', async () => {
    const service = createService();
    cos.failPut = true;

    let rejection: unknown;
    try {
      await stage(service, 'mutation-direct-put-failure');
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect(String((rejection as Error).message)).toContain(
      '变更附件对象存储操作失败',
    );
    expect(String((rejection as Error).message)).not.toContain(
      'secret-put-signature',
    );
    expect(cos.putCalls).toHaveLength(1);
    expect(cos.deleteCalls).toHaveLength(1);
    const stagedPath = String(
      (cos.putCalls[0].Body as Readable & { path?: string }).path,
    );
    await expect(access(stagedPath)).rejects.toMatchObject({ code: 'ENOENT' });
    const persisted = JSON.parse(await readFile(indexPath, 'utf8')) as {
      entries: Record<string, unknown>;
      journal: Record<string, unknown>;
    };
    expect(persisted.entries).toEqual({});
    expect(persisted.journal).toEqual({});
  });

  it('durably journals the object key before starting a COS upload', async () => {
    const service = createService();
    let journalObserved = false;
    cos.beforeUpload = async (params) => {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as {
        journal: Record<
          string,
          {
            operation: string;
            filePath: string;
            bucketId: string;
            region: string;
          }
        >;
      };
      const pending = Object.values(parsed.journal)[0];
      expect(pending).toMatchObject({
        operation: 'upload-cleanup',
        filePath: params.Key,
        bucketId: 'change-bucket-1234567890',
        region: 'ap-beijing',
        ownerMutationId: 'mutation-journal-before-upload',
        size: 10,
      });
      journalObserved = true;
    };

    await stage(service, 'mutation-journal-before-upload');
    expect(journalObserved).toBe(true);
    const settled = JSON.parse(await readFile(indexPath, 'utf8')) as {
      journal: Record<string, unknown>;
    };
    expect(settled.journal).toEqual({});
  });

  it('does not hold the global mutation lock while COS upload is in progress', async () => {
    const service = createService();
    const existing = await stage(service, 'mutation-existing');
    const slowPath = join(root, 'slow.pdf');
    await writeFile(slowPath, Buffer.from('abcdefghij', 'utf8'));
    let releaseUpload!: () => void;
    let markUploadStarted!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    cos.beforeUpload = async () => {
      markUploadStarted();
      await uploadGate;
    };

    const slowUpload = service.stageFromDisk(
      {
        path: slowPath,
        name: 'slow.pdf',
        mimetype: 'application/pdf',
        size: 10,
      },
      'mutation-slow-upload',
    );
    await uploadStarted;
    const bind = service.bindToRecord(
      existing.id,
      'record-during-upload',
      'token-during-upload',
      ownerAccess('mutation-existing'),
    );
    const outcome = await Promise.race([
      bind.then(() => 'bound' as const),
      new Promise<'blocked'>((resolve) =>
        setTimeout(() => resolve('blocked'), 1_000),
      ),
    ]);

    releaseUpload();
    await Promise.all([slowUpload, bind]);
    expect(outcome).toBe('bound');
  });

  it('bounds upload concurrency and rejects work beyond the configured queue before creating snapshots', async () => {
    const service = createService({
      env: {
        COS_CHANGE_BUCKET: 'change-bucket-1234567890',
        COS_CHANGE_REGION: 'ap-beijing',
        COS_CHANGE_PREFIX: 'private/change-attachments/v1',
        CHANGE_ATTACHMENT_UPLOAD_CONCURRENCY: '1',
        CHANGE_ATTACHMENT_UPLOAD_QUEUE_LIMIT: '1',
      },
    });
    await service.onModuleInit();
    let releaseUpload!: () => void;
    let markUploadStarted!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    cos.beforeUpload = async () => {
      if (cos.uploadCalls.length === 1) {
        markUploadStarted();
        await uploadGate;
      }
    };
    const upload = (mutationId: string) =>
      service.stageFromDisk(
        {
          path: sourcePath,
          name: `${mutationId}.pdf`,
          mimetype: 'application/pdf',
          size: 10,
        },
        mutationId,
      );

    const first = upload('mutation-queue-1');
    await uploadStarted;
    const second = upload('mutation-queue-2');
    await new Promise<void>((resolve) => setImmediate(resolve));
    const third = upload('mutation-queue-3');
    const thirdOutcome = await Promise.race([
      third.then(
        () => 'resolved' as const,
        () => 'rejected' as const,
      ),
      new Promise<'queued'>((resolve) =>
        setTimeout(() => resolve('queued'), 100),
      ),
    ]);
    const stagingDirectory = join(root, '.change-attachment-staging');
    const snapshotsBeforeRelease = await readdir(stagingDirectory);

    releaseUpload();
    const results = await Promise.allSettled([first, second, third]);
    expect(thirdOutcome).toBe('rejected');
    expect(results.map((result) => result.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
    ]);
    expect(snapshotsBeforeRelease).toHaveLength(1);
  });

  it('rejects and cleans up when the staging file changes or exceeds 200 MiB during upload', async () => {
    const mutatingCos = new FakeCos();
    mutatingCos.putObject = jest.fn(async (params: Record<string, unknown>) => {
      mutatingCos.uploadCalls.push(params);
      mutatingCos.putCalls.push(params);
      const body = params.Body as Readable & { path?: string };
      const snapshotPath = String(body.path);
      body.destroy();
      await chmod(snapshotPath, 0o600);
      const handle = await open(snapshotPath, 'r+');
      await handle.truncate(CHANGE_ATTACHMENT_MAX_BYTES + 1);
      await handle.close();
      mutatingCos.objects.set(String(params.Key), { body: Buffer.alloc(0) });
      return { ETag: 'fake-etag' };
    });
    const service = createService({ cos: mutatingCos });
    await service.onModuleInit();

    await expect(
      service.stageFromDisk(
        {
          path: sourcePath,
          name: 'scheme.pdf',
          mimetype: 'application/pdf',
          size: 10,
        },
        'mutation-mutated-stage',
      ),
    ).rejects.toThrow('200MB');
    expect(mutatingCos.deleteCalls).toHaveLength(1);
  });

  it('accepts exactly 200 MiB without reading it into a single Buffer', async () => {
    const largePath = join(root, 'large.bin');
    const handle = await open(largePath, 'w');
    await handle.truncate(CHANGE_ATTACHMENT_MAX_BYTES);
    await handle.close();
    const noBufferCos = new FakeCos();
    noBufferCos.putObject = jest.fn(async (params: Record<string, unknown>) => {
      noBufferCos.uploadCalls.push(params);
      noBufferCos.putCalls.push(params);
      for await (const _chunk of params.Body as Readable) {
        // Drain without retaining the attachment in memory.
      }
      return { ETag: 'fake-put-etag', Location: 'private.invalid' };
    });
    const service = createService({ cos: noBufferCos });
    await service.onModuleInit();

    await expect(
      service.stageFromDisk(
        {
          path: largePath,
          name: 'large.bin',
          mimetype: 'application/octet-stream',
          size: CHANGE_ATTACHMENT_MAX_BYTES,
        },
        'mutation-large',
      ),
    ).resolves.toMatchObject({ size: CHANGE_ATTACHMENT_MAX_BYTES });
    expect(noBufferCos.sliceCalls).toHaveLength(0);
    expect(noBufferCos.uploadCalls).toHaveLength(1);
    expect(noBufferCos.uploadCalls[0].Body).toBeInstanceOf(Readable);
    expect(noBufferCos.uploadCalls[0].ContentLength).toBe(
      CHANGE_ATTACHMENT_MAX_BYTES,
    );
    expect(noBufferCos.uploadCalls[0]).not.toHaveProperty('ACL');
    expect(
      String(
        (noBufferCos.uploadCalls[0].Body as Readable & { path?: string }).path,
      ),
    ).not.toBe(largePath);
  }, 30_000);

  it('normalizes user file names and rejects unsafe configured or recovered paths', async () => {
    const service = createService();
    const result = await service.stageFromDisk(
      {
        path: sourcePath,
        name: '../../scheme\r\n.pdf',
        mimetype: 'application/pdf',
        size: 10,
      },
      'mutation-1',
    );
    expect(result.filePath).toMatch(
      /^private\/change-attachments\/v1\/[A-Za-z0-9_-]+\/scheme__\.pdf$/,
    );

    expect(() =>
      createService({
        env: {
          COS_CHANGE_BUCKET: 'change-bucket-1234567890',
          COS_CHANGE_REGION: 'ap-beijing',
          COS_CHANGE_PREFIX: '../outside',
        },
      }),
    ).toThrow('存储前缀无效');

    const unsafeIndex = join(root, 'unsafe.json');
    await writeFile(
      unsafeIndex,
      JSON.stringify({
        version: 1,
        entries: {
          unsafe: {
            id: 'unsafe',
            filePath: 'outside-prefix/file.pdf',
            bucketId: 'change-bucket-1234567890',
            url: '/api/duty-schedules/change-attachments/unsafe/download',
            name: 'file.pdf',
            size: 10,
            mimeType: 'application/pdf',
            sha256: 'a'.repeat(64),
            ownerMutationId: 'mutation-1',
            state: 'staged',
            createdAt: '2026-08-09T00:00:00.000Z',
            updatedAt: '2026-08-09T00:00:00.000Z',
          },
        },
      }),
    );
    const recovered = createService({ indexPath: unsafeIndex });
    await expect(recovered.onModuleInit()).rejects.toThrow('索引内容不安全');
  });

  it('prevents a staged object from being referenced by a different mutation', async () => {
    const service = createService();
    const uploaded = await stage(service, 'mutation-owner');

    await expect(
      service.resolveOwned(uploaded.id, 'mutation-other'),
    ).rejects.toThrow('不属于当前请求');
    await expect(
      service.resolveOwned(uploaded.id, 'mutation-owner'),
    ).resolves.toEqual(uploaded);
  });

  it('requires and enforces an access context on every exposed attachment operation', async () => {
    type Access = { ownerMutationId: string } | { serverAccessToken: string };
    const service = createService();
    const uploaded = await stage(service, 'mutation-owner');
    const secured = service as unknown as {
      bindToRecord(
        id: string,
        recordId: string,
        fileToken: string,
        access: Access,
      ): Promise<unknown>;
      listByRecord(recordId: string, access: Access): Promise<unknown>;
      findByFileToken(fileToken: string, access: Access): Promise<unknown>;
      readRange(
        id: string,
        start: number,
        end: number,
        access: Access,
      ): Promise<unknown>;
      readAll(id: string, access: Access): Promise<unknown>;
      getSignedDownloadUrl(
        id: string,
        expiresSeconds: number,
        access: Access,
      ): Promise<unknown>;
      delete(id: string, access: Access): Promise<unknown>;
      cleanup(id: string, access: Access): Promise<unknown>;
    };
    const wrongOwner: Access = { ownerMutationId: 'mutation-other' };

    await expect(
      secured.readAll(uploaded.id, undefined as unknown as Access),
    ).rejects.toThrow('访问凭据无效');
    await expect(
      secured.bindToRecord(
        uploaded.id,
        'rec-denied',
        'token-denied',
        wrongOwner,
      ),
    ).rejects.toThrow('访问凭据无效');
    await expect(
      secured.readRange(uploaded.id, 0, 1, wrongOwner),
    ).rejects.toThrow('访问凭据无效');
    await expect(secured.readAll(uploaded.id, wrongOwner)).rejects.toThrow(
      '访问凭据无效',
    );
    await expect(
      secured.getSignedDownloadUrl(uploaded.id, 120, wrongOwner),
    ).rejects.toThrow('访问凭据无效');
    await expect(secured.delete(uploaded.id, wrongOwner)).rejects.toThrow(
      '访问凭据无效',
    );
    await expect(secured.cleanup(uploaded.id, wrongOwner)).rejects.toThrow(
      '访问凭据无效',
    );

    const owner: Access = { ownerMutationId: 'mutation-owner' };
    await secured.bindToRecord(uploaded.id, 'rec-owned', 'token-owned', owner);
    await expect(secured.listByRecord('rec-owned', wrongOwner)).rejects.toThrow(
      '访问凭据无效',
    );
    await expect(
      secured.findByFileToken('token-owned', wrongOwner),
    ).rejects.toThrow('访问凭据无效');
  });

  it('accepts only the configured trusted server access token', async () => {
    type Access = { serverAccessToken: string };
    const serverToken = 'server-token-0123456789abcdef';
    const service = createService({
      env: {
        COS_CHANGE_BUCKET: 'change-bucket-1234567890',
        COS_CHANGE_REGION: 'ap-beijing',
        COS_CHANGE_PREFIX: 'private/change-attachments/v1',
        CHANGE_ATTACHMENT_SERVER_ACCESS_TOKEN: serverToken,
      },
    });
    const uploaded = await stage(service, 'mutation-server-access');
    const secured = service as unknown as {
      readAll(id: string, access: Access): Promise<Buffer>;
    };

    await expect(
      secured.readAll(uploaded.id, {
        serverAccessToken: 'wrong-server-token-0123456789',
      }),
    ).rejects.toThrow('访问凭据无效');
    await expect(
      secured.readAll(uploaded.id, { serverAccessToken: serverToken }),
    ).resolves.toEqual(Buffer.from('0123456789'));
  });

  it('rejects duplicate file tokens at bind time', async () => {
    type Access = { ownerMutationId: string };
    const service = createService();
    const first = await stage(service, 'mutation-token-1');
    const secondPath = join(root, 'token-second.pdf');
    await writeFile(secondPath, Buffer.from('abcdefghij'));
    const second = await service.stageFromDisk(
      {
        path: secondPath,
        name: 'token-second.pdf',
        mimetype: 'application/pdf',
        size: 10,
      },
      'mutation-token-2',
    );
    const secured = service as unknown as {
      bindToRecord(
        id: string,
        recordId: string,
        fileToken: string,
        access: Access,
      ): Promise<unknown>;
    };
    await secured.bindToRecord(first.id, 'rec-token-1', 'duplicate-token', {
      ownerMutationId: 'mutation-token-1',
    });
    await expect(
      secured.bindToRecord(second.id, 'rec-token-2', 'duplicate-token', {
        ownerMutationId: 'mutation-token-2',
      }),
    ).rejects.toThrow('文件令牌已被其他附件使用');
  });

  it('enforces per-mutation attachment count and total-size quotas including pending uploads', async () => {
    expect(CHANGE_ATTACHMENT_MUTATION_MAX_FILES).toBe(5);
    expect(CHANGE_ATTACHMENT_MUTATION_MAX_BYTES).toBe(
      5 * CHANGE_ATTACHMENT_MAX_BYTES,
    );
    const service = createService();
    await service.onModuleInit();
    for (let index = 0; index < 5; index += 1) {
      await expect(
        service.stageFromDisk(
          {
            path: sourcePath,
            name: `quota-${index}.pdf`,
            mimetype: 'application/pdf',
            size: 10,
          },
          'mutation-quota-count',
        ),
      ).resolves.toBeDefined();
    }
    await expect(
      service.stageFromDisk(
        {
          path: sourcePath,
          name: 'quota-overflow.pdf',
          mimetype: 'application/pdf',
          size: 10,
        },
        'mutation-quota-count',
      ),
    ).rejects.toThrow('最多暂存 5 个附件');

    const byteLimited = createService({
      indexPath: join(root, 'byte-quota-index.json'),
      env: {
        COS_CHANGE_BUCKET: 'change-bucket-1234567890',
        COS_CHANGE_REGION: 'ap-beijing',
        COS_CHANGE_PREFIX: 'private/change-attachments/v1',
        CHANGE_ATTACHMENT_MUTATION_MAX_BYTES: '15',
      },
    });
    await byteLimited.onModuleInit();
    await expect(
      byteLimited.stageFromDisk(
        {
          path: sourcePath,
          name: 'byte-quota-first.pdf',
          mimetype: 'application/pdf',
          size: 10,
        },
        'mutation-quota-bytes',
      ),
    ).resolves.toBeDefined();
    await expect(
      byteLimited.stageFromDisk(
        {
          path: sourcePath,
          name: 'byte-quota-overflow.pdf',
          mimetype: 'application/pdf',
          size: 10,
        },
        'mutation-quota-bytes',
      ),
    ).rejects.toThrow('附件总量超过限制');
    await byteLimited.onModuleDestroy();
  });

  it('binds to a record and supports record and Feishu token lookup after restart', async () => {
    const service = createService();
    const uploaded = await stage(service);
    await expect(
      service.bindToRecord(
        uploaded.id,
        'rec-change-1',
        'file-token-1',
        ownerAccess(),
      ),
    ).resolves.toMatchObject(uploaded);
    await expect(
      service.listByRecord('rec-change-1', ownerAccess()),
    ).resolves.toEqual([expect.objectContaining({ id: uploaded.id })]);
    await expect(
      service.findByFileToken('file-token-1', ownerAccess()),
    ).resolves.toEqual(expect.objectContaining({ id: uploaded.id }));

    await service.onModuleDestroy();
    const restarted = createService();
    await restarted.onModuleInit();
    await expect(
      restarted.listByRecord('rec-change-1', ownerAccess()),
    ).resolves.toEqual([expect.objectContaining({ id: uploaded.id })]);
  });

  it('persists index writes serially and atomically without leaving temp files', async () => {
    const service = createService();
    const first = await stage(service, 'mutation-1');
    const secondPath = join(root, 'scheme-2.pdf');
    await writeFile(secondPath, Buffer.from('abcdefghij', 'utf8'));
    const second = await service.stageFromDisk(
      {
        path: secondPath,
        name: 'scheme-2.pdf',
        mimetype: 'application/pdf',
        size: 10,
      },
      'mutation-2',
    );
    await Promise.all([
      service.bindToRecord(first.id, 'rec-1', 'token-1', ownerAccess()),
      service.bindToRecord(
        second.id,
        'rec-2',
        'token-2',
        ownerAccess('mutation-2'),
      ),
    ]);

    const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as {
      entries: Record<string, { state: string }>;
    };
    expect(parsed.entries[first.id]?.state).toBe('bound');
    expect(parsed.entries[second.id]?.state).toBe('bound');
    expect(
      (await readdir(root)).filter((name) => name.includes('.tmp-')),
    ).toEqual([]);
  });

  it('serializes conflicting mutations for the same attachment', async () => {
    const service = createService();
    const uploaded = await stage(service);
    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    cos.beforeDelete = () => deleteGate;

    const deletePromise = service.delete(uploaded.id, ownerAccess());
    while (cos.deleteCalls.length === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    let bindSettled = false;
    const bindPromise = service
      .bindToRecord(
        uploaded.id,
        'rec-after-delete',
        'token-after-delete',
        ownerAccess(),
      )
      .finally(() => {
        bindSettled = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const settledBeforeDeleteFinished = bindSettled;
    releaseDelete();
    await expect(deletePromise).resolves.toBe(true);
    expect(settledBeforeDeleteFinished).toBe(false);
    await expect(bindPromise).rejects.toThrow('不存在');
  });

  it('does not expose an in-memory mutation when its atomic index write fails', async () => {
    const service = createService();
    const uploaded = await stage(service);
    await rm(indexPath, { force: true });
    await mkdir(indexPath);

    await expect(
      service.bindToRecord(
        uploaded.id,
        'rec-failed',
        'token-failed',
        ownerAccess(),
      ),
    ).rejects.toBeDefined();
    await expect(
      service.listByRecord('rec-failed', ownerAccess()),
    ).resolves.toEqual([]);
  });

  it('fails closed when another live service owns the same index lock', async () => {
    const first = createService();
    const second = createService();
    await first.onModuleInit();

    await expect(second.onModuleInit()).rejects.toThrow('索引已被另一实例占用');
  });

  it('keeps the lock format readable by the prior runtime while recording process identity', async () => {
    const service = createService();
    await service.onModuleInit();

    await expect(
      readFile(`${indexPath}.lock`, 'utf8').then((value) => JSON.parse(value)),
    ).resolves.toMatchObject({
      version: 1,
      pid: process.pid,
      processStartedAtMs: expect.any(Number),
      acquiredAt: expect.any(String),
    });
    await service.onModuleDestroy();
  });

  it('recovers a legacy index lock after its PID is reused by another process generation', async () => {
    const lockPath = `${indexPath}.lock`;
    await writeFile(
      lockPath,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token: 'legacy-reused-pid-token',
      }),
    );
    await utimes(lockPath, new Date(0), new Date(0));
    const service = createService();

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await service.onModuleDestroy();
  });

  it('recovers an identity-bearing index lock whose recorded process generation is stale', async () => {
    await writeFile(
      `${indexPath}.lock`,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        processStartedAtMs: 1,
        acquiredAt: '2026-09-11T00:00:00.000Z',
        token: 'versioned-reused-pid-token',
      }),
    );
    const service = createService();

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await service.onModuleDestroy();
  });

  it('reads inclusive ranges up to 4 MiB and refuses larger ranges', async () => {
    const service = createService();
    const uploaded = await stage(service);

    await expect(
      service.readRange(uploaded.id, 2, 5, ownerAccess()),
    ).resolves.toEqual(Buffer.from('2345'));
    expect(cos.getCalls[0]).toMatchObject({ Range: 'bytes=2-5' });
    await expect(
      service.readRange(uploaded.id, 0, 4 * 1024 * 1024, ownerAccess()),
    ).rejects.toThrow('4MB');
    await expect(
      service.readRange(uploaded.id, -1, 2, ownerAccess()),
    ).rejects.toThrow('读取范围无效');
  });

  it('only allows whole-object reads up to 20 MiB', async () => {
    const service = createService();
    const uploaded = await stage(service);
    await expect(service.readAll(uploaded.id, ownerAccess())).resolves.toEqual(
      Buffer.from('0123456789'),
    );

    const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as {
      entries: Record<string, { size: number }>;
    };
    parsed.entries[uploaded.id].size = 20 * 1024 * 1024 + 1;
    await writeFile(indexPath, JSON.stringify(parsed));
    await service.onModuleDestroy();
    const restarted = createService();
    await restarted.onModuleInit();
    await expect(restarted.readAll(uploaded.id, ownerAccess())).rejects.toThrow(
      '20MB',
    );
  });

  it('streams whole-object reads and aborts before retaining an oversized body', async () => {
    const service = createService();
    const uploaded = await stage(service);
    cos.objects.set(uploaded.filePath, {
      body: Buffer.alloc(20 * 1024 * 1024 + 1, 1),
    });

    await expect(service.readAll(uploaded.id, ownerAccess())).rejects.toThrow(
      '20MB',
    );
    expect(cos.getCalls.at(-1)?.Output).toBeDefined();
  });

  it('creates a short-lived signed private GET URL', async () => {
    const service = createService();
    const uploaded = await stage(service);

    await expect(
      service.getSignedDownloadUrl(uploaded.id, 120, ownerAccess()),
    ).resolves.toEqual(expect.stringContaining('signature=test'));
    expect(cos.signedCalls[0]).toMatchObject({
      Sign: true,
      Method: 'GET',
      Expires: 120,
      Key: uploaded.filePath,
    });
    await expect(
      service.getSignedDownloadUrl(uploaded.id, 3601, ownerAccess()),
    ).rejects.toThrow('有效期无效');
  });

  it('provides a purpose-limited trusted-server signing path without exposing a token', async () => {
    const service = createService();
    const uploaded = await stage(service);

    await expect(
      service.getSignedDownloadUrlForTrustedServer(uploaded.id, 120),
    ).resolves.toEqual(expect.stringContaining('signature=test'));
    expect(cos.signedCalls.at(-1)).toMatchObject({
      Sign: true,
      Method: 'GET',
      Expires: 120,
      Key: uploaded.filePath,
    });
  });

  it('provides purpose-limited trusted-server lookup and deletion without exposing a token', async () => {
    const service = createService();
    const uploaded = await stage(service, 'mutation-trusted-maintenance');
    await service.bindToRecord(
      uploaded.id,
      'record-trusted-maintenance',
      'token-trusted-maintenance',
      ownerAccess('mutation-trusted-maintenance'),
    );

    await expect(
      service.findByFileTokenForTrustedServer('token-trusted-maintenance'),
    ).resolves.toEqual(
      expect.objectContaining({
        id: uploaded.id,
        boundRecordId: 'record-trusted-maintenance',
        fileToken: 'token-trusted-maintenance',
      }),
    );
    await expect(service.deleteForTrustedServer(uploaded.id)).resolves.toBe(
      true,
    );
    await expect(
      service.findByFileTokenForTrustedServer('token-trusted-maintenance'),
    ).resolves.toBeNull();
  });

  it('deletes a bound self-test object only when every persisted binding matches', async () => {
    const service = createService();
    const uploaded = await stage(
      service,
      'change-adjustment-11111111-1111-4111-8111-111111111111',
    );
    await service.bindToRecord(
      uploaded.id,
      'recSelfTestExact',
      'token-self-test-exact',
      ownerAccess('change-adjustment-11111111-1111-4111-8111-111111111111'),
    );

    const exact = {
      id: uploaded.id,
      recordId: 'recSelfTestExact',
      fileToken: 'token-self-test-exact',
      ownerMutationId: 'change-adjustment-11111111-1111-4111-8111-111111111111',
    };
    for (const forged of [
      { ...exact, recordId: 'recOther' },
      { ...exact, fileToken: 'token-other' },
      {
        ...exact,
        ownerMutationId:
          'change-adjustment-22222222-2222-4222-8222-222222222222',
      },
    ]) {
      await expect(
        service.deleteBoundForTrustedSelfTest(forged),
      ).rejects.toThrow('绑定');
    }
    expect(cos.deleteCalls).toHaveLength(0);
    expect(cos.objects.has(uploaded.filePath)).toBe(true);

    await expect(
      service.findBoundByIdForTrustedSelfTest(uploaded.id),
    ).resolves.toMatchObject({
      id: uploaded.id,
      boundRecordId: exact.recordId,
      fileToken: exact.fileToken,
      ownerMutationId: exact.ownerMutationId,
    });
    await expect(service.deleteBoundForTrustedSelfTest(exact)).resolves.toBe(
      true,
    );
    expect(cos.objects.has(uploaded.filePath)).toBe(false);
  });

  it('allows an owner to delete only staged objects and reserves bound deletion for trusted server code', async () => {
    const service = createService();
    const uploaded = await stage(service, 'mutation-bound-delete');
    await service.bindToRecord(
      uploaded.id,
      'record-bound-delete',
      'token-bound-delete',
      ownerAccess('mutation-bound-delete'),
    );

    await expect(
      service.delete(uploaded.id, ownerAccess('mutation-bound-delete')),
    ).rejects.toThrow('已绑定附件只能由服务端删除');
    expect(cos.objects.has(uploaded.filePath)).toBe(true);
    await expect(service.deleteForTrustedServer(uploaded.id)).resolves.toBe(
      true,
    );
    expect(cos.objects.has(uploaded.filePath)).toBe(false);
  });

  it('resumes an exact trusted bound deletion from cleanup-pending without losing the COS object', async () => {
    const service = createService();
    const ownerMutationId =
      'change-summary-report-123e4567-e89b-42d3-a456-426614174000';
    const uploaded = await stage(service, ownerMutationId);
    const exact = {
      id: uploaded.id,
      recordId: 'recSummaryPending123',
      fileToken: 'file-token-summary-pending',
      ownerMutationId,
    };
    await service.bindToRecord(
      uploaded.id,
      exact.recordId,
      exact.fileToken,
      ownerAccess(ownerMutationId),
    );
    cos.failDelete = true;

    await expect(service.deleteBoundForTrustedSelfTest(exact)).rejects.toThrow(
      '删除失败',
    );
    expect(cos.objects.has(uploaded.filePath)).toBe(true);
    await expect(
      service.getDeletionStateForTrustedServer(uploaded.id),
    ).resolves.toBe('cleanup-pending');
    await expect(
      service.findBoundByIdForTrustedSelfTest(uploaded.id),
    ).resolves.toMatchObject({
      id: uploaded.id,
      boundRecordId: exact.recordId,
      fileToken: exact.fileToken,
      ownerMutationId,
    });

    cos.failDelete = false;
    await expect(service.deleteBoundForTrustedSelfTest(exact)).resolves.toBe(
      true,
    );
    expect(cos.objects.has(uploaded.filePath)).toBe(false);
    await expect(
      service.getDeletionStateForTrustedServer(uploaded.id),
    ).resolves.toBe('absent');
  });

  it('settles an exactly bound trusted deletion when COS reports NoSuchKey', async () => {
    const service = createService();
    const uploaded = await stage(service, 'change-summary-report-nosuchkey');
    await service.bindToRecord(
      uploaded.id,
      'recSummaryNoSuchKey',
      'file-token-summary-nosuchkey',
      ownerAccess('change-summary-report-nosuchkey'),
    );
    cos.objects.delete(uploaded.filePath);
    cos.deleteError = Object.assign(new Error('must-not-leak'), {
      code: 'NoSuchKey',
    });

    await expect(
      service.deleteBoundForTrustedSelfTest({
        id: uploaded.id,
        recordId: 'recSummaryNoSuchKey',
        fileToken: 'file-token-summary-nosuchkey',
        ownerMutationId: 'change-summary-report-nosuchkey',
      }),
    ).resolves.toBe(true);
    await expect(
      service.getDeletionStateForTrustedServer(uploaded.id),
    ).resolves.toBe('absent');
  });

  it('marks deletion failures for cleanup and removes them on the next startup', async () => {
    const service = createService();
    const uploaded = await stage(service);
    cos.failDelete = true;

    await expect(service.delete(uploaded.id, ownerAccess())).rejects.toThrow(
      '删除失败',
    );
    const failedIndexText = await readFile(indexPath, 'utf8');
    expect(failedIndexText).toContain('cleanup-pending');
    expect(failedIndexText).not.toContain('must-not-leak');

    cos.failDelete = false;
    await service.onModuleDestroy();
    const restarted = createService();
    await restarted.onModuleInit();
    await expect(
      restarted.resolveOwned(uploaded.id, 'mutation-1'),
    ).rejects.toThrow('附件不存在');
    expect(cos.deleteCalls.at(-1)).toMatchObject({ Key: uploaded.filePath });
  });

  it('persists a delete tombstone before calling COS', async () => {
    const service = createService();
    const uploaded = await stage(service);
    let tombstoneObserved = false;
    cos.beforeDelete = async (params) => {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as {
        entries: Record<string, { state: string }>;
        journal: Record<string, { operation: string; filePath: string }>;
      };
      expect(parsed.entries[uploaded.id]?.state).toBe('cleanup-pending');
      expect(parsed.journal[uploaded.id]).toMatchObject({
        operation: 'delete-cleanup',
        filePath: params.Key,
      });
      tombstoneObserved = true;
    };

    await expect(service.delete(uploaded.id, ownerAccess())).resolves.toBe(
      true,
    );
    expect(tombstoneObserved).toBe(true);
    const settled = JSON.parse(await readFile(indexPath, 'utf8')) as {
      entries: Record<string, unknown>;
      journal: Record<string, unknown>;
    };
    expect(settled.entries[uploaded.id]).toBeUndefined();
    expect(settled.journal[uploaded.id]).toBeUndefined();
  });

  it('recovers an orphan upload from a durable journal after restart', async () => {
    const service = createService();
    const uploaded = await stage(service, 'mutation-crashed-upload');
    await service.onModuleDestroy();
    const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as {
      version: 1;
      entries: Record<string, unknown>;
      journal?: Record<string, unknown>;
    };
    delete parsed.entries[uploaded.id];
    parsed.journal = {
      [uploaded.id]: {
        id: uploaded.id,
        operation: 'upload-cleanup',
        bucketId: uploaded.bucketId,
        region: 'ap-beijing',
        filePath: uploaded.filePath,
        createdAt: '2026-08-09T00:00:00.000Z',
      },
    };
    await writeFile(indexPath, JSON.stringify(parsed));

    const restarted = createService();
    await restarted.onModuleInit();

    expect(cos.objects.has(uploaded.filePath)).toBe(false);
    const recovered = JSON.parse(await readFile(indexPath, 'utf8')) as {
      journal: Record<string, unknown>;
    };
    expect(recovered.journal).toEqual({});
  });

  it('reclaims only expired staged objects and preserves newly staged objects on startup', async () => {
    let current = new Date('2026-08-09T00:00:00.000Z');
    const options = {
      now: () => new Date(current),
      env: {
        COS_CHANGE_BUCKET: 'change-bucket-1234567890',
        COS_CHANGE_REGION: 'ap-beijing',
        COS_CHANGE_PREFIX: 'private/change-attachments/v1',
        CHANGE_ATTACHMENT_STAGED_TTL_MS: String(60 * 60 * 1000),
      },
    };
    const service = createService(options);
    const expired = await stage(service, 'mutation-expired-staged');
    current = new Date('2026-08-09T01:30:00.000Z');
    const fresh = await service.stageFromDisk(
      {
        path: sourcePath,
        name: 'fresh.pdf',
        mimetype: 'application/pdf',
        size: 10,
      },
      'mutation-fresh-staged',
    );
    current = new Date('2026-08-09T02:00:00.000Z');
    await service.onModuleDestroy();

    const restarted = createService(options);
    await restarted.onModuleInit();
    await expect(
      restarted.resolveOwned(expired.id, 'mutation-expired-staged'),
    ).rejects.toThrow('附件不存在');
    await expect(
      restarted.resolveOwned(fresh.id, 'mutation-fresh-staged'),
    ).resolves.toMatchObject({ id: fresh.id });
    expect(cos.objects.has(expired.filePath)).toBe(false);
    expect(cos.objects.has(fresh.filePath)).toBe(true);
    await restarted.onModuleDestroy();
  });

  it('cleans only expired owned temp snapshots and never removes an active upload snapshot', async () => {
    let current = new Date('2026-08-09T12:00:00.000Z');
    const stagingDirectory = join(root, '.change-attachment-staging');
    await mkdir(stagingDirectory, { recursive: true });
    const orphanPath = join(stagingDirectory, `stage-123-${'a'.repeat(36)}`);
    const freshPath = join(stagingDirectory, `stage-456-${'b'.repeat(36)}`);
    const unrelatedPath = join(stagingDirectory, 'do-not-delete.txt');
    await Promise.all([
      writeFile(orphanPath, 'orphan'),
      writeFile(freshPath, 'fresh'),
      writeFile(unrelatedPath, 'unrelated'),
    ]);
    await utimes(
      orphanPath,
      new Date(current.getTime() - 2 * 60 * 60 * 1000),
      new Date(current.getTime() - 2 * 60 * 60 * 1000),
    );
    await utimes(freshPath, current, current);
    const service = createService({
      now: () => new Date(current),
      env: {
        COS_CHANGE_BUCKET: 'change-bucket-1234567890',
        COS_CHANGE_REGION: 'ap-beijing',
        COS_CHANGE_PREFIX: 'private/change-attachments/v1',
        CHANGE_ATTACHMENT_TEMP_SNAPSHOT_TTL_MS: String(60 * 60 * 1000),
      },
    });
    await service.onModuleInit();
    await expect(access(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(freshPath)).resolves.toBeUndefined();
    await expect(access(unrelatedPath)).resolves.toBeUndefined();

    let activePath = '';
    let releaseUpload!: () => void;
    let markUploadStarted!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const uploadStarted = new Promise<void>((resolve) => {
      markUploadStarted = resolve;
    });
    cos.beforeUpload = async (params) => {
      activePath = String((params.Body as Readable & { path?: string }).path);
      const activeSnapshot = await stat(activePath);
      current = new Date(activeSnapshot.mtimeMs + 2 * 60 * 60 * 1000);
      markUploadStarted();
      await uploadGate;
    };
    const upload = service.stageFromDisk(
      {
        path: sourcePath,
        name: 'active.pdf',
        mimetype: 'application/pdf',
        size: 10,
      },
      'mutation-active-snapshot',
    );
    await uploadStarted;
    await service.onModuleInit();
    const activeMetadata = await stat(activePath);
    releaseUpload();
    await upload;
    expect(activeMetadata.isFile()).toBe(true);
    await service.onModuleDestroy();
  });

  it('fails closed when the local index is corrupt instead of silently replacing it', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(indexPath, '{not-json');
    const service = createService();

    await expect(service.onModuleInit()).rejects.toThrow('索引损坏');
    await expect(readFile(indexPath, 'utf8')).resolves.toBe('{not-json');
  });

  it('fails closed for same-prefix key mismatches, foreign storage coordinates, unsafe fields and duplicate tokens', async () => {
    const createdAt = '2026-08-09T00:00:00.000Z';
    const createEntry = (id: string) => ({
      id,
      filePath: `private/change-attachments/v1/${id}/file.pdf`,
      bucketId: 'change-bucket-1234567890',
      region: 'ap-beijing',
      url: `/api/duty-schedules/change-attachments/${id}/download`,
      name: 'file.pdf',
      size: 10,
      mimeType: 'application/pdf',
      sha256: 'a'.repeat(64),
      ownerMutationId: 'mutation-safe',
      state: 'staged',
      createdAt,
      updatedAt: createdAt,
    });
    const id = 'SafeAttachment_123';
    const base = createEntry(id);
    const duplicateOne = {
      ...createEntry('DuplicateToken_One'),
      state: 'bound',
      recordId: 'rec-one',
      fileToken: 'same-token',
    };
    const duplicateTwo = {
      ...createEntry('DuplicateToken_Two'),
      state: 'bound',
      recordId: 'rec-two',
      fileToken: 'same-token',
    };
    const cases: Array<{ name: string; document: Record<string, unknown> }> = [
      {
        name: 'key-id-mismatch',
        document: {
          version: 1,
          entries: {
            [id]: {
              ...base,
              filePath:
                'private/change-attachments/v1/OtherAttachment_456/file.pdf',
            },
          },
          journal: {},
        },
      },
      {
        name: 'foreign-bucket',
        document: {
          version: 1,
          entries: { [id]: { ...base, bucketId: 'foreign-bucket-1234567890' } },
          journal: {},
        },
      },
      {
        name: 'unsafe-name',
        document: {
          version: 1,
          entries: {
            [id]: {
              ...base,
              name: 'unsafe\r\n.pdf',
              filePath: `private/change-attachments/v1/${id}/unsafe\r\n.pdf`,
            },
          },
          journal: {},
        },
      },
      {
        name: 'short-id',
        document: {
          version: 1,
          entries: { short: createEntry('short') },
          journal: {},
        },
      },
      {
        name: 'oversized-owner',
        document: {
          version: 1,
          entries: { [id]: { ...base, ownerMutationId: 'x'.repeat(201) } },
          journal: {},
        },
      },
      {
        name: 'unknown-entry-field',
        document: {
          version: 1,
          entries: { [id]: { ...base, unexpectedSecretField: 'value' } },
          journal: {},
        },
      },
      {
        name: 'duplicate-file-token',
        document: {
          version: 1,
          entries: {
            [duplicateOne.id]: duplicateOne,
            [duplicateTwo.id]: duplicateTwo,
          },
          journal: {},
        },
      },
      {
        name: 'unknown-index-field',
        document: {
          version: 1,
          entries: { [id]: base },
          journal: {},
          extra: true,
        },
      },
    ];

    for (const item of cases) {
      const candidatePath = join(root, `${item.name}.json`);
      await writeFile(candidatePath, JSON.stringify(item.document));
      const candidate = createService({ indexPath: candidatePath });
      await expect(candidate.onModuleInit()).rejects.toThrow('索引内容不安全');
    }
  });

  it('sanitizes every COS failure and never logs SDK messages or signatures', async () => {
    type Access = { ownerMutationId: string };
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = createService();
    cos.failUpload = true;
    cos.failDelete = true;
    try {
      await expect(stage(service, 'mutation-secret-error')).rejects.toThrow(
        '对象存储操作失败',
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(
        'secret-upload-signature',
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('must-not-leak');

      cos.failUpload = false;
      cos.failDelete = false;
      const uploaded = await stage(service, 'mutation-read-errors');
      const secured = service as unknown as {
        readRange(
          id: string,
          start: number,
          end: number,
          access: Access,
        ): Promise<Buffer>;
        readAll(id: string, access: Access): Promise<Buffer>;
        getSignedDownloadUrl(
          id: string,
          expiresSeconds: number,
          access: Access,
        ): Promise<string>;
      };
      const accessContext: Access = { ownerMutationId: 'mutation-read-errors' };
      cos.failGet = true;
      await expect(
        secured.readRange(uploaded.id, 0, 1, accessContext),
      ).rejects.toThrow('对象存储操作失败');
      await expect(secured.readAll(uploaded.id, accessContext)).rejects.toThrow(
        '对象存储操作失败',
      );
      cos.failGet = false;
      cos.failSign = true;
      await expect(
        secured.getSignedDownloadUrl(uploaded.id, 120, accessContext),
      ).rejects.toThrow('对象存储操作失败');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('honors change-specific env values before generic values and keeps contract defaults', async () => {
    const specific = createService({
      env: {
        COS_CHANGE_BUCKET: 'specific-bucket-1234567890',
        COS_BUCKET: 'generic-bucket-1234567890',
        COS_CHANGE_REGION: 'ap-chengdu',
        COS_REGION: 'ap-guangzhou',
        COS_CHANGE_PREFIX: 'change-attachments/v1',
      },
    });
    await stage(specific);
    expect(cos.uploadCalls.at(-1)).toMatchObject({
      Bucket: 'specific-bucket-1234567890',
      Region: 'ap-chengdu',
    });

    const fallbackCos = new FakeCos();
    const fallback = createService({
      cos: fallbackCos,
      indexPath: join(root, 'fallback-index.json'),
      env: {},
    });
    await fallback.stageFromDisk(
      {
        path: sourcePath,
        name: 'fallback.pdf',
        mimetype: 'application/pdf',
        size: 10,
      },
      'fallback-mutation',
    );
    expect(fallbackCos.uploadCalls[0]).toMatchObject({
      Bucket: 'jy-1421907124',
      Region: 'ap-shanghai',
      Key: expect.stringMatching(/^change-attachments\/v1\//),
    });
  });
});
