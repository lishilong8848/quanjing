import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessConfigurationStore } from './access-configuration.store';

describe('durable access configuration', () => {
  let directory: string;
  let file: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'vnet-access-config-')); file = join(directory, 'configuration.json'); });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('is read-only until a mutation, persists and restores one atomic result', async () => {
    const store = new AccessConfigurationStore(file);
    expect(store.read().revision).toBe(0);
    await store.mutate(0, 'test-mutation-0001', 'request-fingerprint-1', state => { state.legacySessionsRevoked = true; });
    expect(new AccessConfigurationStore(file).read()).toMatchObject({ revision: 1, legacySessionsRevoked: true });
    expect(JSON.parse(readFileSync(file, 'utf8')).mutations['test-mutation-0001']).toBeDefined();
  });
  it('replays identical mutations but rejects id reuse with different content', async () => {
    const store = new AccessConfigurationStore(file);
    const change = jest.fn();
    await store.mutate(0, 'test-mutation-0002', 'fingerprint-2', change);
    await store.mutate(0, 'test-mutation-0002', 'fingerprint-2', change);
    expect(change).toHaveBeenCalledTimes(1);
    await expect(store.mutate(1, 'test-mutation-0002', 'different', change)).rejects.toThrow('重复请求内容不一致');
  });
  it('serializes two stores and rejects stale versions without losing data', async () => {
    const a = new AccessConfigurationStore(file), b = new AccessConfigurationStore(file);
    await a.mutate(0, 'test-mutation-0003', 'fingerprint-3', state => { state.legacySessionsRevoked = true; });
    await expect(b.mutate(0, 'test-mutation-0004', 'fingerprint-4', () => {})).rejects.toThrow('配置已更新');
    expect(b.read().legacySessionsRevoked).toBe(true);
  });
  it('fails closed on corrupt or semantically invalid files', () => {
    const store = new AccessConfigurationStore(file);
    writeFileSync(file, '{broken');
    expect(() => store.read()).toThrow('权限配置文件无效');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: -1, accounts: {} }));
    expect(() => store.read()).toThrow('权限配置文件无效');
  });
  it('does not create a configuration when a transaction fails', async () => {
    const store = new AccessConfigurationStore(file);
    await expect(store.mutate(0, 'test-mutation-0005', 'fingerprint-5', () => { throw new Error('invalid grant'); })).rejects.toThrow('invalid grant');
    expect(store.read().revision).toBe(0);
  });
  it('refuses linked directories and alternate data stream paths without writing', async () => {
    const target = join(directory, 'target'), linked = join(directory, 'linked');
    require('node:fs').mkdirSync(target);
    symlinkSync(target, linked, 'junction');
    await expect(new AccessConfigurationStore(join(linked, 'configuration.json')).mutate(0, 'linked-mutation-001', 'test', () => {})).rejects.toThrow('不能使用链接');
    expect(existsSync(join(target, 'configuration.json'))).toBe(false);
    await expect(new AccessConfigurationStore(file + ':stream').mutate(0, 'stream-mutation-001', 'test', () => {})).rejects.toThrow('路径无效');
  });
  it('fails closed when a previously persisted configuration disappears or the lock is malformed', async () => {
    const store = new AccessConfigurationStore(file);
    await store.mutate(0, 'missing-mutation-001', 'test', () => {});
    unlinkSync(file);
    expect(() => store.read()).toThrow('权限配置文件无效');
    const other = new AccessConfigurationStore(join(directory, 'other.json'));
    writeFileSync(other.filePath + '.lock', '{malformed');
    await expect(other.mutate(0, 'locked-mutation-001', 'test', () => {})).rejects.toThrow('配置正在保存');
    expect(readFileSync(other.filePath + '.lock', 'utf8')).toBe('{malformed');
  });
});
