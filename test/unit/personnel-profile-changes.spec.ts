import { randomUUID, createHash } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  realpathSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { PersonnelProfileChangesStore } from '../../server/common/access/personnel-profile-changes.store';
import { PersonnelProfileChangesService } from '../../server/common/access/personnel-profile-changes.service';
const hash = (v: unknown) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
describe('approved basic profile updates', () => {
  let dir: string,
    store: PersonnelProfileChangesStore,
    service: PersonnelProfileChangesService,
    gateway: any,
    config: any,
    directory: any,
    person: any,
    admin: any,
    accounts: any[],
    record: any;
  const source = {
    appId: 'cliTest',
    appToken: 'appTest',
    tableId: 'tblTest',
    recordId: 'recTest',
  };
  const submit = () => ({
    clientMutationId: randomUUID(),
    phone: '13800000001',
  });
  const decide = (row: any, decision = 'approve') =>
    ({
      requestId: row.id,
      expectedVersion: row.version,
      clientMutationId: randomUUID(),
      decision,
      comment: '核对通过',
    }) as any;
  const finish = async (id: string) => {
    await (service as any).running.get(id);
    return store.read().requests[id];
  };
  beforeEach(() => {
    dir = mkdtempSync(join(realpathSync(tmpdir()), 'nt-profile-change-'));
    store = new PersonnelProfileChangesStore();
    Object.defineProperty(store, 'path', { value: join(dir, 'changes.json') });
    const id =
      'local-external-' +
      hash([source.appId, source.appToken, source.tableId, source.recordId]);
    accounts = [
      {
        id,
        role: 'guest',
        version: 1,
        name: '合成员工',
        enabled: true,
        personnelActive: true,
        personnelAppId: source.appId,
      },
      {
        id: 'local-admin-all',
        role: 'admin',
        version: 1,
        name: '合成管理员',
        enabled: true,
      },
    ];
    const principal = (account: any) => ({
      accountId: account.id,
      role: account.role,
      displayName: account.name,
      authorizationVersion: account.version,
      purchaseBuilding: null,
    });
    person = principal(accounts[0]);
    admin = principal(accounts[1]);
    config = {
      getPersonnelCredentialAccount: jest.fn((id: string) =>
        accounts.find((a) => a.id === id),
      ),
      currentPrincipal: jest.fn((id: string, version: number) => {
        const a = accounts.find((a) => a.id === id);
        return a && a.enabled && a.version === version ? principal(a) : null;
      }),
    };
    record = {
      record_id: source.recordId,
      fields: {
        姓名: '合成员工',
        联系方式: '13800000000',
        电子邮箱: 'old@example.com',
        岗位: '工程师',
      },
    };
    directory = {
      photo: jest.fn().mockResolvedValue(null),
      read: jest.fn(async () => ({
        ...source,
        snapshotAt: new Date().toISOString(),
        records: [structuredClone(record)],
      })),
    };
    gateway = {
      read: jest.fn(async () => structuredClone(record)),
      fields: jest.fn(async (_s: any, keys: string[]) =>
        Object.fromEntries(
          keys.map((k) => [
            k,
            k === 'phone' ? '联系方式' : k === 'email' ? '电子邮箱' : '照片',
          ]),
        ),
      ),
      upload: jest.fn(async () => 'synthetic-photo-token'),
      write: jest.fn(async (_s: any, fields: any) => {
        Object.assign(record.fields, fields);
      }),
    };
    service = new PersonnelProfileChangesService(
      config,
      directory,
      gateway,
      store,
    );
  });
  afterEach(async () => {
    await service.onModuleDestroy();
    if (resolve(dirname(dir)) !== resolve(realpathSync(tmpdir())))
      throw new Error('outside temp');
    rmSync(dir, { recursive: true });
  });
  it('keeps submission source untouched and deduplicates original request', async () => {
    const input = submit();
    const row = await service.create(person, input);
    expect(row.status).toBe('pending');
    expect(gateway.write).not.toHaveBeenCalled();
    expect(await service.create(person, input)).toEqual(row);
    expect(Object.keys(store.read().requests)).toHaveLength(1);
    expect(row).not.toHaveProperty('source');
    expect(row).not.toHaveProperty('identity');
    await expect(
      service.create(person, { ...input, phone: '13800000002' }),
    ).rejects.toThrow('原请求内容已变化');
  });
  it('approves whole request, preserves other fields and requires readback', async () => {
    const row = await service.create(person, {
      ...submit(),
      email: 'new@example.com',
    });
    await service.review(admin, decide(row));
    const final = await finish(row.id);
    expect(final.status).toBe('completed');
    expect(gateway.write).toHaveBeenCalledTimes(1);
    expect(gateway.write.mock.calls[0][1]).toEqual({
      联系方式: '13800000001',
      电子邮箱: 'new@example.com',
    });
    expect(record.fields.岗位).toBe('工程师');
    expect(store.read().audit.length).toBeGreaterThan(2);
  });
  it('rejects with no source upload or write', async () => {
    const row = await service.create(person, submit());
    await service.review(admin, decide(row, 'reject'));
    expect(store.read().requests[row.id].status).toBe('rejected');
    expect(gateway.write).not.toHaveBeenCalled();
  });
  it('blocks impersonation, unsupported fields and self-linked admin review', async () => {
    await expect(
      service.create(
        { ...person, impersonation: { actorAccountId: admin.accountId } },
        submit(),
      ),
    ).rejects.toThrow('代登录');
    await expect(
      service.create(person, { ...submit(), role: 'admin' } as any),
    ).rejects.toThrow('申请格式');
    const row = await service.create(person, submit());
    accounts[1].personnelIdentity = person.accountId;
    await expect(service.review(admin, decide(row))).rejects.toThrow(
      '不能审核',
    );
  });
  it('refuses changed source baselines', async () => {
    const row = await service.create(person, submit());
    record.fields.联系方式 = '13900000000';
    await service.review(admin, decide(row));
    expect((await finish(row.id)).status).toBe('conflict');
    expect(gateway.write).not.toHaveBeenCalled();
  });
  it('reconciles a lost success receipt without repeating the write', async () => {
    const row = await service.create(person, submit());
    gateway.write.mockImplementation(async (_s: any, fields: any) => {
      Object.assign(record.fields, fields);
      throw new Error('timeout');
    });
    await service.review(admin, decide(row));
    expect((await finish(row.id)).status).toBe('reconciliation');
    await (service as any).run(row.id);
    expect(store.read().requests[row.id].status).toBe('completed');
    expect(gateway.write).toHaveBeenCalledTimes(1);
  });
  it('does not replay unknown writes when the old values remain', async () => {
    const row = await service.create(person, submit());
    gateway.write.mockRejectedValue(new Error('timeout'));
    await service.review(admin, decide(row));
    await finish(row.id);
    await (service as any).run(row.id);
    expect(store.read().requests[row.id].status).toBe('reconciliation');
    expect(gateway.write).toHaveBeenCalledTimes(1);
  });
  it('serializes concurrent approve and original retry into one business write', async () => {
    const row = await service.create(person, submit());
    const body = decide(row);
    await Promise.all([
      service.review(admin, body),
      service.review(admin, body),
    ]);
    await finish(row.id);
    expect(gateway.write).toHaveBeenCalledTimes(1);
  });
  it('persists photo before approval and never reuploads an unknown upload', async () => {
    const photo = { buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]) };
    const row = await service.create(
      person,
      { clientMutationId: randomUUID() },
      photo,
    );
    expect(gateway.upload).not.toHaveBeenCalled();
    expect(service.photo(person, row.id).buffer).toEqual(photo.buffer);
    gateway.upload.mockRejectedValue(new Error('unknown'));
    await service.review(admin, decide(row));
    await finish(row.id);
    await (service as any).run(row.id);
    expect(gateway.upload).toHaveBeenCalledTimes(1);
    expect(gateway.write).not.toHaveBeenCalled();
    expect(store.read().requests[row.id].status).toBe('reconciliation');
  });
  it('restores approved tasks from the independent ledger after restart', async () => {
    const row = await service.create(person, submit());
    await store.mutate((s) => {
      Object.assign(s.requests[row.id], {
        status: 'approved',
        reviewerAccountId: admin.accountId,
        reviewerVersion: 1,
      });
    });
    const restored = new PersonnelProfileChangesService(
      config,
      directory,
      gateway,
      store,
    );
    await (restored as any).run(row.id);
    expect(store.read().requests[row.id].status).toBe('completed');
    await restored.onModuleDestroy();
  });
  it('fails closed on corrupted persisted data', () => {
    writeFileSync(store.path, '{"schemaVersion":999}');
    expect(() => store.read()).toThrow('暂不可用');
  });
  it('withdraws only pending own requests and keeps retries idempotent', async () => {
    const row = await service.create(person, submit());
    const body = {
      requestId: row.id,
      expectedVersion: 1,
      clientMutationId: randomUUID(),
    };
    const first = await service.cancel(person, body);
    expect(first.status).toBe('cancelled');
    expect(await service.cancel(person, body)).toEqual(first);
    await expect(service.review(admin, decide(row))).rejects.toThrow(
      '状态已变化',
    );
    expect(gateway.write).not.toHaveBeenCalled();
  });
  it('allows explicit admin resume only after baseline reconciliation', async () => {
    const row = await service.create(person, submit());
    gateway.write.mockRejectedValueOnce(new Error('unknown'));
    await service.review(admin, decide(row));
    const pending = await finish(row.id);
    const body = {
      requestId: row.id,
      expectedVersion: pending.version,
      clientMutationId: randomUUID(),
      confirmUnchanged: true,
    };
    await service.recover(admin, body);
    expect((await finish(row.id)).status).toBe('completed');
    expect(gateway.write).toHaveBeenCalledTimes(2);
  });
  it('does not rewrite a changed source during explicit recovery', async () => {
    const row = await service.create(person, submit());
    gateway.write.mockRejectedValueOnce(new Error('unknown'));
    await service.review(admin, decide(row));
    const pending = await finish(row.id);
    record.fields.联系方式 = '13900000000';
    await expect(
      service.recover(admin, {
        requestId: row.id,
        expectedVersion: pending.version,
        clientMutationId: randomUUID(),
        confirmUnchanged: true,
      }),
    ).rejects.toThrow('来源数据已变化');
    expect(gateway.write).toHaveBeenCalledTimes(1);
  });
  it('repeated unresolved reconciliation does not grow the ledger or audit', async () => {
    const row = await service.create(person, submit());
    gateway.write.mockRejectedValue(new Error('unknown'));
    await service.review(admin, decide(row));
    await finish(row.id);
    await (service as any).run(row.id);
    const previous = readFileSync(store.path, 'utf8');
    await (service as any).run(row.id);
    expect(readFileSync(store.path, 'utf8')).toBe(previous);
  });
  it('stores both photos outside the ledger and checks file integrity', async () => {
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    record.fields.照片 = [{ file_token: 'old-photo-token' }];
    directory.photo.mockResolvedValue({
      buffer: bytes,
      contentType: 'image/png',
    });
    const row = await service.create(
      person,
      { clientMutationId: randomUUID() },
      { buffer: bytes },
    );
    expect(readFileSync(store.path, 'utf8')).not.toContain('base64');
    expect(service.photo(admin, row.id, true, true).buffer).toEqual(bytes);
    const saved = store.read().requests[row.id].photo!;
    writeFileSync(join(store.path + '.attachments', saved.name), 'corrupt');
    expect(() => service.photo(person, row.id)).toThrow('暂不可用');
  });
  it('does not permanently reconcile a known prewrite read failure', async () => {
    const row = await service.create(person, submit());
    const original = gateway.read.getMockImplementation();
    let reads = 0;
    gateway.read.mockImplementation(async () => {
      if (++reads === 2) throw new Error('temporary read failure');
      return original();
    });
    await service.review(admin, decide(row));
    expect((await finish(row.id)).status).toBe('approved');
    expect(gateway.write).not.toHaveBeenCalled();
    await (service as any).run(row.id);
    expect(store.read().requests[row.id].status).toBe('completed');
  });
  it('rejects missing ledger after it was previously observed', async () => {
    await service.create(person, submit());
    require('node:fs').unlinkSync(store.path);
    expect(() => store.read()).toThrow('暂不可用');
  });

  it('does not expose another employee request or either photo', async () => {
    const row = await service.create(person, submit());
    const other = {
      ...accounts[0],
      id: 'local-external-' + 'b'.repeat(64),
      name: '其他合成人员',
    };
    accounts.push(other);
    const principal = {
      ...person,
      accountId: other.id,
      displayName: other.name,
    };
    expect(service.list(principal)).toEqual([]);
    expect(() => service.photo(principal, row.id)).toThrow('不能读取');
  });
  it('waits for an in-flight submission during shutdown and prevents late acceptance', async () => {
    let release!: (v: any) => void;
    directory.read.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const creating = service.create(person, submit());
    const caught = creating.catch((error) => error);
    let stopped = false;
    const shutdown = service.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release({ ...source, records: [record] });
    expect(await caught).toBeInstanceOf(Error);
    await shutdown;
    expect(Object.keys(store.read().requests)).toHaveLength(0);
    expect(gateway.write).not.toHaveBeenCalled();
  });
  it('checks photo token content before resuming an unknown upload', async () => {
    const photo = { buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]) };
    const row = await service.create(
      person,
      { clientMutationId: randomUUID() },
      photo,
    );
    gateway.upload.mockRejectedValueOnce(new Error('unknown'));
    await service.review(admin, decide(row));
    const pending = await finish(row.id);
    gateway.verifyUploadedPhoto = jest.fn().mockResolvedValue(undefined);
    await service.recover(admin, {
      requestId: row.id,
      expectedVersion: pending.version,
      clientMutationId: randomUUID(),
      confirmUnchanged: true,
      uploadedPhotoToken: 'confirmed-photo-token',
    });
    expect((await finish(row.id)).status).toBe('completed');
    expect(gateway.verifyUploadedPhoto).toHaveBeenCalledTimes(1);
    expect(gateway.upload).toHaveBeenCalledTimes(1);
    expect(gateway.write.mock.calls[0][1]).toEqual({
      照片: [{ file_token: 'confirmed-photo-token' }],
    });
  });
});
