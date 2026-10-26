import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ThresholdStore } from '../../server/modules/threshold-management/threshold.store';
import { ThresholdController } from '../../server/modules/threshold-management/threshold.controller';
import {
  applyThresholdOverlay,
  type ThresholdRecord,
} from '../../shared/threshold-management.interface';

const input = {
  profession: '电气',
  device: 'UPS',
  section: '输出设定',
  parameter: '电压',
  building: 'A楼',
  location: '300K UPS',
  value: '220',
  unit: 'V',
  kind: '设定',
  enabled: '',
  note: '',
};
describe('阈值持久化与幂等', () => {
  let dir: string;
  let store: ThresholdStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nt-threshold-'));
    store = new ThresholdStore(join(dir, 'records.json'), []);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  test('游客不能读写，管理员和编辑人员均不能绕过审批变更阈值', () => {
    const controller = new ThresholdController(store);
    const request = (role: string) =>
      ({ accessPrincipal: { role, accountId: 'qa' } }) as never;
    expect(() => controller.list(request('guest'))).toThrow('权限');
    expect(() =>
      controller.mutate(
        { operation: 'create', clientMutationId: 'qa-guest-1', record: input },
        request('guest'),
      ),
    ).toThrow('权限');
    expect(() =>
      controller.mutate(
        {
          operation: 'delete',
          clientMutationId: 'qa-editor-1',
          id: 'missing',
          expectedVersion: 1,
        },
        request('editor'),
      ),
    ).toThrow('审批');
    expect(() =>
      controller.mutate(
        {
          operation: 'update',
          clientMutationId: 'qa-admin-direct',
          id: 'missing',
          expectedVersion: 1,
          record: input,
        },
        request('admin'),
      ),
    ).toThrow('审批');
    expect(controller.list(request('editor')).records).toHaveLength(0);
    expect(controller.list(request('admin')).records).toHaveLength(0);
  });
  test('新增、修改、删除在重启后保留；同一 mutation 重放不重复写入', () => {
    const command = {
      operation: 'create' as const,
      clientMutationId: 'test-create-1',
      record: input,
    };
    const created = store.mutate(command, 'admin');
    expect(store.mutate(command, 'admin')).toEqual(created);
    store = new ThresholdStore(join(dir, 'records.json'), []);
    expect(store.list().records).toHaveLength(1);
    const updated = store.mutate(
      {
        operation: 'update',
        clientMutationId: 'test-update-1',
        id: created.record!.id,
        expectedVersion: 1,
        record: { ...input, value: '230' },
      },
      'admin',
    );
    expect(updated.record?.version).toBe(2);
    expect(() =>
      store.mutate(
        {
          operation: 'update',
          clientMutationId: 'test-update-stale',
          id: created.record!.id,
          expectedVersion: 1,
          record: input,
        },
        'admin',
      ),
    ).toThrow('已被修改');
    store.mutate(
      {
        operation: 'delete',
        clientMutationId: 'test-delete-1',
        id: created.record!.id,
        expectedVersion: 2,
      },
      'admin',
    );
    expect(
      new ThresholdStore(join(dir, 'records.json'), []).list().records,
    ).toEqual([]);
  });
  test('同一 mutation 不得换内容或身份；越权、异常字段和口令拒绝写入', () => {
    store.mutate(
      { operation: 'create', clientMutationId: 'test-create-1', record: input },
      'admin',
    );
    expect(() =>
      store.mutate(
        {
          operation: 'create',
          clientMutationId: 'test-create-1',
          record: { ...input, value: '240' },
        },
        'admin',
      ),
    ).toThrow('标识');
    expect(() =>
      store.mutate(
        {
          operation: 'create',
          clientMutationId: 'test-create-1',
          record: input,
        },
        'editor:other',
      ),
    ).toThrow('标识');
    expect(() =>
      store.mutate(
        {
          operation: 'create',
          clientMutationId: 'test-invalid',
          record: { ...input, parameter: '' },
        },
        'admin',
      ),
    ).toThrow('参数');
    expect(() =>
      store.mutate(
        {
          operation: 'create',
          clientMutationId: 'test-password',
          record: { ...input, parameter: '密码' },
        },
        'admin',
      ),
    ).toThrow('口令');
  });
  test('文件损坏或锁占用不会被重置成种子数据', () => {
    writeFileSync(join(dir, 'records.json'), 'broken');
    expect(() => store.list()).toThrow('台账');
    writeFileSync(join(dir, 'records.json.lock'), '');
    expect(() =>
      store.mutate(
        { operation: 'create', clientMutationId: 'test-locked', record: input },
        'admin',
      ),
    ).toThrow('写入');
    expect(readFileSync(join(dir, 'records.json'), 'utf8')).toBe('broken');
  });
});
test('接入暖通时保留旧电气台账、删除记录和幂等回执，重启不重复导入', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-threshold-adoption-'));
  const path = join(dir, 'records.json');
  const electrical = ['edited', 'deleted'].map((id) => ({
    ...input,
    id,
    version: 1,
    updatedAt: '',
    source: null,
  })) as ThresholdRecord[];
  const warm = {
    ...electrical[0],
    id: 'hvac-qa',
    profession: '暖通',
    range: '18-24',
  };
  try {
    const old = new ThresholdStore(path, electrical);
    const command = {
      operation: 'update' as const,
      clientMutationId: 'adopt-edit-1',
      id: 'edited',
      expectedVersion: 1,
      record: { ...input, value: '230' },
    };
    const receipt = old.mutate(command, 'admin');
    old.mutate(
      {
        operation: 'delete',
        clientMutationId: 'adopt-delete-1',
        id: 'deleted',
        expectedVersion: 1,
      },
      'admin',
    );
    // Model a legacy ledger written before importedSeeds existed.
    const legacy = JSON.parse(readFileSync(path, 'utf8'));
    delete legacy.importedSeeds;
    writeFileSync(path, JSON.stringify(legacy));
    const batches = [{ key: 'hvac-initial-v1', records: [warm] }];
    const upgraded = new ThresholdStore(path, electrical, batches);
    expect(upgraded.list().records.map((r) => r.id)).toEqual([
      'edited',
      'hvac-qa',
    ]);
    expect(upgraded.list().records[0].value).toBe('230');
    expect(upgraded.mutate(command, 'admin')).toEqual(receipt);
    upgraded.mutate(
      {
        operation: 'delete',
        clientMutationId: 'hvac-delete-1',
        id: warm.id,
        expectedVersion: 1,
      },
      'admin',
    );
    const after = new ThresholdStore(path, electrical, batches).list();
    expect(after.records.map((r) => r.id)).toEqual(['edited']);
    expect(new ThresholdStore(path, electrical, batches).list().revision).toBe(
      after.revision,
    );
    expect(JSON.parse(readFileSync(path, 'utf8')).importedSeeds).toEqual([
      'hvac-initial-v1',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('暖通批次接入遇到锁或台账损坏时保留原字节；运行范围校验及持久化', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-threshold-adoption-'));
  const path = join(dir, 'records.json');
  try {
    const old = new ThresholdStore(path, []);
    old.mutate(
      {
        operation: 'create',
        clientMutationId: 'range-create-1',
        record: { ...input, range: '18-24' },
      },
      'admin',
    );
    const store = new ThresholdStore(
      path,
      [],
      [{ key: 'hvac-initial-v1', records: [] }],
    );
    const original = readFileSync(path, 'utf8');
    writeFileSync(`${path}.lock`, '');
    expect(() => store.list()).toThrow('正在写入');
    expect(readFileSync(path, 'utf8')).toBe(original);
    rmSync(`${path}.lock`);
    expect(store.list().records[0].range).toBe('18-24');
    const current = store.list().records[0];
    store.mutate(
      {
        operation: 'update',
        clientMutationId: 'legacy-range-update',
        id: current.id,
        expectedVersion: current.version,
        record: { ...input, value: '231' },
      },
      'admin',
    );
    expect(store.list().records[0].range).toBe('18-24');
    expect(() =>
      store.mutate(
        {
          operation: 'create',
          clientMutationId: 'range-invalid-1',
          record: { ...input, range: 123 } as never,
        },
        'admin',
      ),
    ).toThrow('运行范围');
    writeFileSync(path, 'broken');
    expect(() => store.list()).toThrow('原数据已保留');
    expect(readFileSync(path, 'utf8')).toBe('broken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('批次登记前已删除的来源记录不复活，首次写入也安全接管批次', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nt-threshold-adoption-'));
  const path = join(dir, 'records.json');
  const warm = {
    ...input,
    profession: '暖通',
    id: 'hvac-existing',
    version: 1,
    updatedAt: '',
    source: null,
  } as ThresholdRecord;
  const second = { ...warm, id: 'hvac-new' };
  try {
    new ThresholdStore(path, [warm]).mutate(
      {
        operation: 'delete',
        clientMutationId: 'before-batch-delete',
        id: warm.id,
        expectedVersion: 1,
      },
      'admin',
    );
    const store = new ThresholdStore(
      path,
      [],
      [{ key: 'hvac-initial-v1', records: [warm, second] }],
    );
    store.mutate(
      {
        operation: 'create',
        clientMutationId: 'during-batch-create',
        record: input,
      },
      'admin',
    );
    expect(store.list().records.map((r) => r.id)).not.toContain(warm.id);
    expect(store.list().records.filter((r) => r.id === second.id)).toHaveLength(
      1,
    );
    const adopted = JSON.parse(readFileSync(path, 'utf8'));
    expect(adopted.importedSeeds).toEqual(['hvac-initial-v1']);
    adopted.mutations.corrupt = { fingerprint: 'broken' };
    const bytes = JSON.stringify(adopted);
    writeFileSync(path, bytes);
    expect(() => store.list()).toThrow('原数据已保留');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('旧查询不覆盖同步中记录；删除覆盖层阻止旧快照复活记录', () => {
  const record = {
    ...input,
    id: 'one',
    version: 1,
    updatedAt: '',
    source: null,
  } as ThresholdRecord;
  const pending = { ...record, value: '230' };
  expect(
    applyThresholdOverlay([record], {
      one: { record: pending, mutationId: 'm1' },
    })[0].value,
  ).toBe('230');
  expect(
    applyThresholdOverlay([record], {
      one: { record: null, mutationId: 'm2' },
    }),
  ).toEqual([]);
});
