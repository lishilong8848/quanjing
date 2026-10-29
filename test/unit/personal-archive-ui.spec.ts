import type { ReactElement, ReactNode } from 'react';
const mockSlots: any[] = [];
let mockCursor = 0;
const mockEffects: (() => void)[] = [];
jest.mock('react', () => ({ ...jest.requireActual('react'),
  useState: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = typeof initial === 'function' ? initial() : initial; return [mockSlots[slot], (next: any) => { mockSlots[slot] = typeof next === 'function' ? next(mockSlots[slot]) : next; }]; },
  useRef: (initial: unknown) => { const slot = mockCursor++; if (!(slot in mockSlots)) mockSlots[slot] = { current: initial }; return mockSlots[slot]; },
  useCallback: (callback: unknown, dependencies: unknown[]) => { const slot = mockCursor++, previous = mockSlots[slot]; if (!previous || dependencies.some((value, index) => !Object.is(value, previous.dependencies[index]))) mockSlots[slot] = { callback, dependencies }; return mockSlots[slot].callback; },
  useEffect: (effect: () => any, dependencies: unknown[]) => { const slot = mockCursor++, previous = mockSlots[slot]; if (!previous || dependencies.some((value, at) => !Object.is(value, previous.dependencies[at]))) { const next = { dependencies, cleanup: previous?.cleanup }; mockSlots[slot] = next; mockEffects.push(() => { next.cleanup?.(); next.cleanup = effect(); }); } },
}));
jest.mock('../../client/src/api/personal-access', () => ({ getPersonalArchive: jest.fn(), getPersonalArchivePhoto: jest.fn() }));
import { isValidElement } from 'react';
import { getPersonalArchive, getPersonalArchivePhoto } from '../../client/src/api/personal-access';
import { personalArchiveIdentity, usePersonalArchive } from '../../client/src/pages/PersonalCenter/use-personal-archive';
import { archiveValue, PersonalArchivePanel, PersonalArchiveSummary } from '../../client/src/pages/PersonalCenter/PersonalArchivePanel';
import type { PersonalArchiveProfile, PersonalArchiveResponse } from '../../shared/personnel-archive.interface';

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const fixture = (name = '合成人员'): PersonalArchiveProfile => ({ name, employeeNo: 'TEST-007', photoUrl: '/api/access/personal/archive/photo', employmentStatus: 'active', position: '值班员', systemPosition: '运维', company: '合成单位', employmentType: '420', buildingsSpecialties: ['H楼'], team: 'A班', shift: '白', supervisorName: '合成主管', phone: '13800000000', email: 'synthetic@example.invalid', idCardMasked: '110105********002X', entryDate: '2026-01-01', departureDate: null, departureReason: null, education: '本科', school: '合成院校', major: '电气', graduationDate: '2025-06', hobbies: ['阅读'], vehiclePlate: null, specialties: ['电气'], mbti: 'ISTJ', profileScores: { responsibility: 0, stability: null, collaboration: null, growthPotential: null }, abilities: [{ key: 'electricalOperations', label: '电气运维', score: 0, benchmark: 0 }], employmentHistory: [], training: { completedCourses: 0, totalCourses: 0, completionRate: 0, averageScore: 0, attendanceRate: 0, finalScore: 0 }, drill: { annualCount: 0, latestRating: null, latestTitle: null, latestDate: null }, certificates: [], certificateSource: null, updatedAt: '2026-10-29T00:00:00.000Z' });
const ready = (name = '合成人员'): PersonalArchiveResponse => ({ status: 'ready', profile: fixture(name), snapshotAt: '2026-10-29T00:00:00.000Z' });
function render(identity = 'person-a') { mockCursor = 0; return usePersonalArchive(identity); }
function effects() { while (mockEffects.length) mockEffects.shift()!(); }
async function settle() { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); }
function cleanup() { for (const slot of mockSlots) slot?.cleanup?.(); mockSlots.length = 0; mockEffects.length = 0; }
function nodes(node: ReactNode): ReactElement<any>[] { if (Array.isArray(node)) return node.flatMap(nodes); return isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : []; }

describe('personal archive state and presentation', () => {
  let createUrl: jest.SpyInstance, revokeUrl: jest.SpyInstance;
  beforeEach(() => {
    cleanup(); jest.clearAllMocks();
    (getPersonalArchive as jest.Mock).mockReset(); (getPersonalArchivePhoto as jest.Mock).mockReset();
    (getPersonalArchivePhoto as jest.Mock).mockResolvedValue(new Blob(['fixture'], { type: 'image/png' }));
    createUrl = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic-current-user');
    revokeUrl = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });
  afterEach(() => { cleanup(); createUrl.mockRestore(); revokeUrl.mockRestore(); });
  it('merges repeated refreshes and preserves the last successful same-person data on failure', async () => {
    const loading = deferred<PersonalArchiveResponse>(); (getPersonalArchive as jest.Mock).mockReturnValueOnce(loading.promise);
    let result = render(); effects();
    result.refresh(); result.refresh(); expect(getPersonalArchive).toHaveBeenCalledTimes(1);
    loading.resolve(ready()); await settle(); result = render(); effects(); await settle();
    expect(result.profile?.employeeNo).toBe('TEST-007');
    (getPersonalArchive as jest.Mock).mockRejectedValueOnce(new Error('源读取超时'));
    await result.refresh(); result = render();
    expect(result.profile?.name).toBe('合成人员'); expect(result.error).toBe('源读取超时'); expect(result.loading).toBe(false);
  });
  it('clears old-person data immediately and ignores the old response after a switch', async () => {
    const old = deferred<PersonalArchiveResponse>(), next = deferred<PersonalArchiveResponse>();
    (getPersonalArchive as jest.Mock).mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    render('person-a'); effects();
    const firstSignal = (getPersonalArchive as jest.Mock).mock.calls[0][0] as AbortSignal;
    let result = render('person-b'); expect(result.profile).toBeNull(); effects(); expect(firstSignal.aborted).toBe(true);
    old.resolve(ready('旧人员')); await settle(); result = render('person-b'); expect(result.profile).toBeNull();
    next.resolve(ready('新人员')); await settle(); result = render('person-b'); expect(result.profile?.name).toBe('新人员');
  });
  it('isolates identity, authorization version, fingerprint and impersonation owner', () => {
    const base = { role: 'guest' as const, purchaseBuilding: null, accountId: 'a', authorizationVersion: 1, principalFingerprint: 'one' };
    const key = personalArchiveIdentity(base);
    for (const change of [{ accountId: 'b' }, { authorizationVersion: 2 }, { principalFingerprint: 'two' }, { impersonation: { actorAccountId: 'admin', actorName: 'A', targetName: 'B', expiresAt: 1 } }]) expect(personalArchiveIdentity({ ...base, ...change })).not.toBe(key);
    expect(personalArchiveIdentity({ ...base, displayName: '更新展示名称' })).toBe(key);
  });
  it('revokes private blob URLs on identity changes and ignores late old photo responses', async () => {
    (getPersonalArchive as jest.Mock).mockResolvedValue(ready());
    render('person-a'); effects(); await settle(); render('person-a'); effects(); await settle();
    let result = render('person-a'); expect(result.photo.url).toBe('blob:synthetic-current-user');
    const late = deferred<Blob>(); (getPersonalArchivePhoto as jest.Mock).mockReturnValueOnce(late.promise);
    result.retryPhoto(); render('person-a'); effects(); expect(revokeUrl).toHaveBeenCalledWith('blob:synthetic-current-user');
    const photoSignal = (getPersonalArchivePhoto as jest.Mock).mock.calls[1][0] as AbortSignal;
    result = render('person-b'); expect(result.photo.url).toBeNull(); effects(); expect(photoSignal.aborted).toBe(true);
    late.resolve(new Blob(['old'], { type: 'image/png' })); await settle(); expect(createUrl).toHaveBeenCalledTimes(1);
  });
  it('never fetches a supplied foreign photo URL and allows retry after a local photo failure', async () => {
    const response = ready(); response.profile!.photoUrl = 'https://other.invalid/private.jpg';
    (getPersonalArchive as jest.Mock).mockResolvedValueOnce(response);
    render(); effects(); await settle(); render(); effects(); let result = render();
    expect(getPersonalArchivePhoto).not.toHaveBeenCalled(); expect(result.photo.error).toBe('照片暂不可用');
    (getPersonalArchive as jest.Mock).mockResolvedValueOnce(ready()); (getPersonalArchivePhoto as jest.Mock).mockRejectedValueOnce(new Error('network'));
    await result.refresh(); render(); effects(); await settle(); result = render(); expect(result.photo.error).toBe('照片读取失败');
    result.retryPhoto(); render(); effects(); await settle(); result = render(); expect(result.photo.url).toBe('blob:synthetic-current-user');
  });
  it('clears a previously loaded archive when the account becomes unbound', async () => {
    (getPersonalArchive as jest.Mock).mockResolvedValueOnce(ready()); render(); effects(); await settle(); let result = render(); effects(); await settle();
    (getPersonalArchive as jest.Mock).mockResolvedValueOnce({ status: 'unbound', profile: null, snapshotAt: null });
    await result.refresh(); result = render(); effects(); expect(result.profile).toBeNull(); expect(result.response?.status).toBe('unbound'); expect(result.photo.url).toBeNull();
  });
  it('retains valid zero values and numeric employment types instead of hiding them', () => {
    expect(archiveValue(0)).toBe('0'); expect(archiveValue('420')).toBe('420'); expect(archiveValue('102')).toBe('102'); expect(archiveValue(null)).toBe('未维护');
    const archive = { profile: fixture(), response: ready(), loading: false, error: '', photo: { url: null, loading: false, error: '' }, refresh: jest.fn(), retryPhoto: jest.fn(), photoFailed: jest.fn() } as any;
    const panel = nodes(PersonalArchivePanel({ archive }));
    expect(panel.find(node => node.props.label === '用工性质')?.props.value).toBe('420');
    expect(panel.find(node => node.props.label === '已完成课程')?.props.value).toBe(0);
    expect(panel.find(node => node.props.label === '培训完成率')?.props.value).toBe('0%');
    const summary = nodes(PersonalArchiveSummary({ archive, displayName: '账号名' }));
    expect(summary.find(node => node.props.label === '工号')?.props.value).toBe('TEST-007');
    expect(summary.find(node => node.props.label === '手机号')?.props.value).toBe('13800000000');
    expect(JSON.stringify(panel)).not.toContain('identityNumber');
  });
});
