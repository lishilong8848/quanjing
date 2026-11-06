import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dashboardSourceBindingKey, readDashboardSourceBinding, writeDashboardSourceBinding } from '../../server/common/feishu/dashboard-source-binding-cache';

describe('read-only dashboard source binding', () => {
  const source = { namespace: 'test-dashboard', appId: 'cli_synthetic', wikiToken: 'wikiSynthetic', tableId: 'tblSynthetic', fieldNames: ['姓名', '楼栋'] };
  const previous = process.env.FEISHU_LOCAL_CACHE_DIR;
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'nantong-dashboard-binding-'));
    process.env.FEISHU_LOCAL_CACHE_DIR = directory;
  });
  afterAll(async () => {
    if (previous === undefined) delete process.env.FEISHU_LOCAL_CACHE_DIR;
    else process.env.FEISHU_LOCAL_CACHE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  it('persists only the exact source mapping and normalizes field projection order', async () => {
    await writeDashboardSourceBinding(source, 'resolvedBase');
    expect(await readDashboardSourceBinding({ ...source, fieldNames: ['楼栋', '姓名', '姓名'] })).toBe('resolvedBase');
    const [file] = await readdir(directory);
    const payload = JSON.parse(await readFile(join(directory, file), 'utf8'));
    expect(Object.keys(payload).sort()).toEqual(['appToken', 'sourceKey', 'version']);
    expect(payload.sourceKey).toBe(dashboardSourceBindingKey(source));
  });
  it.each([
    { appId: 'cli_other' }, { wikiToken: 'otherWiki' }, { tableId: 'otherTable' },
    { namespace: 'authorization-not-shared' }, { appToken: 'configuredBase' },
    { viewId: 'otherView' }, { fieldNames: ['differentField'] },
  ])('does not reuse a different source %j', async changed => {
    expect(await readDashboardSourceBinding({ ...source, ...changed })).toBeNull();
  });
  it('does not accept a malformed or tampered source mapping', async () => {
    const [file] = await readdir(directory);
    await writeFile(join(directory, file), JSON.stringify({ version: 1, sourceKey: 'another source', appToken: 'otherBase' }));
    expect(await readDashboardSourceBinding(source)).toBeNull();
    await writeFile(join(directory, file), '{');
    expect(await readDashboardSourceBinding(source)).toBeNull();
  });
  it('does not record a resolved Base contradicting the explicitly configured Base', async () => {
    await expect(writeDashboardSourceBinding({ ...source, appToken: 'expectedBase' }, 'otherBase')).rejects.toThrow('mismatch');
  });
});
