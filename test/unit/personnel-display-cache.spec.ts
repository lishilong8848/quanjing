import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HttpService } from '@nestjs/axios';
import { PersonnelDisplayCache, PERSONNEL_DISPLAY_MAX_AGE_MS } from '../../server/common/access/personnel-display-cache';
import { AccessConfigurationDirectory } from '../../server/common/access/access-configuration.directory';

describe('personnel display cache is not an authorization directory', () => {
  const original = { ...process.env };
  let directory: string;
  const snapshot = (sourceKey = 'source-one', snapshotAt = Date.now()) => ({ schemaVersion: 1 as const, sourceKey, appId: 'cli_display_test', snapshotAt, people: [{ openId: 'ou_display_person', name: '合成人员' }] });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'personnel-display-only-'));
    process.env.ACCESS_CONFIGURATION_FILE = join(directory, 'access.json');
    process.env.FEISHU_APP_ID = 'cli_display_test';
  });
  afterEach(() => { jest.restoreAllMocks(); process.env = { ...original }; rmSync(directory, { recursive: true, force: true }); });
  it('persists only the minimal projection and survives restart', () => {
    const value = { ...snapshot(), externalEmployees: [{ password: 'MUST_NOT_PERSIST' }], people: [{ ...snapshot().people[0], idCard: 'MUST_NOT_PERSIST' }] };
    new PersonnelDisplayCache().write(value);
    const raw = readFileSync(join(directory, 'personnel-display-cache.json'), 'utf8');
    expect(raw).not.toContain('MUST_NOT_PERSIST');
    expect(new PersonnelDisplayCache().read('source-one')).toEqual(snapshot('source-one', value.snapshotAt));
  });
  it('rejects changed sources, expired data, corruption and duplicate identities', () => {
    const store = new PersonnelDisplayCache(); store.write(snapshot());
    expect(new PersonnelDisplayCache().read('source-two')).toBeUndefined();
    expect(store.read('source-one', Date.now() + PERSONNEL_DISPLAY_MAX_AGE_MS + 1)).toBeUndefined();
    const file = join(directory, 'personnel-display-cache.json');
    writeFileSync(file, '{broken'); expect(new PersonnelDisplayCache().read('source-one')).toBeUndefined();
    writeFileSync(file, JSON.stringify({ ...snapshot(), people: [snapshot().people[0], snapshot().people[0]] }));
    expect(new PersonnelDisplayCache().read('source-one')).toBeUndefined();
  });
  it('returns cached display names immediately while one shared refresh is pending; strict reads still fail closed', async () => {
    const first = new AccessConfigurationDirectory(new HttpService());
    const live = { appId: 'cli_display_test', people: snapshot().people, employees: [], snapshotAt: Date.now(), personnelComplete: true, externalEmployees: [{ passwordHash: 'MUST_NOT_PERSIST' }] };
    jest.spyOn(first, 'read').mockResolvedValue(live as never);
    await first.readForDisplay();
    expect(readFileSync(join(directory, 'personnel-display-cache.json'), 'utf8')).not.toContain('passwordHash');
    const restarted = new AccessConfigurationDirectory(new HttpService());
    let resolve!: (v: any) => void;
    const strict = jest.spyOn(restarted, 'read').mockReturnValue(new Promise(done => { resolve = done; }));
    const [a, b] = await Promise.all([restarted.readForDisplay(), restarted.readForDisplay()]);
    expect(a).toMatchObject({ people: snapshot().people, personnelComplete: false, displayCache: { stale: true, refreshing: true, displayOnly: true } });
    expect(a.personnelAuthority).toBeUndefined(); expect(b.people).toEqual(a.people); expect(strict).toHaveBeenCalledTimes(1);
    resolve(live); await Promise.resolve(); await Promise.resolve();
    strict.mockRejectedValue(new Error('source not available'));
    await expect(restarted.read(true)).rejects.toThrow('source not available');
    await restarted.onModuleDestroy();
  });
  it('does not replace a good display snapshot with incomplete source data', async () => {
    const service = new AccessConfigurationDirectory(new HttpService());
    const live = { appId: 'cli_display_test', people: snapshot().people, employees: [], snapshotAt: Date.now(), personnelComplete: true };
    jest.spyOn(service, 'read').mockResolvedValueOnce(live).mockResolvedValue({ ...live, people: [], personnelComplete: false });
    await service.readForDisplay();
    const before = readFileSync(join(directory, 'personnel-display-cache.json'));
    await (service as any).refreshDisplay();
    expect(readFileSync(join(directory, 'personnel-display-cache.json'))).toEqual(before);
  });
  it('does not persist a late response after shutdown', async () => {
    const service = new AccessConfigurationDirectory(new HttpService());
    let resolve!: (v: any) => void;
    jest.spyOn(service, 'read').mockReturnValue(new Promise(done => { resolve = done; }));
    const request = service.readForDisplay(); await service.onModuleDestroy();
    resolve({ appId: 'cli_display_test', people: snapshot().people, employees: [], snapshotAt: Date.now(), personnelComplete: true });
    await request;
    expect(new PersonnelDisplayCache().read((service as any).displaySourceKey())).toBeUndefined();
  });
  it('never returns the old source when a read is pending during a table or view switch', async () => {
    const service = new AccessConfigurationDirectory(new HttpService());
    let resolve!: (v: any) => void;
    const base = { appId: 'cli_display_test', employees: [], snapshotAt: Date.now(), personnelComplete: true };
    const reader = jest.spyOn(service, 'read').mockReturnValueOnce(new Promise(done => { resolve = done; }))
      .mockResolvedValue({ ...base, people: [{ openId: 'ou_new_source', name: '新来源人员' }] });
    const first = service.readForDisplay();
    const rejected = expect(first).rejects.toThrow('人员数据源已变更');
    const keyBefore = (service as any).displaySourceKey();
    process.env.FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID = 'tblNewDisplaySource';
    process.env.FEISHU_ORG_VIEW_ID = 'vewNewDisplaySource';
    expect((service as any).displaySourceKey()).not.toBe(keyBefore);
    const second = service.readForDisplay();
    resolve({ ...base, people: snapshot().people });
    await rejected;
    await expect(second).resolves.toMatchObject({ people: [{ openId: 'ou_new_source', name: '新来源人员' }] });
    expect(reader).toHaveBeenCalledTimes(2);
    expect(new PersonnelDisplayCache().read(keyBefore)).toBeUndefined();
  });
});
