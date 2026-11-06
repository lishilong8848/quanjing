import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ts from 'typescript';
import {
  LeaveRequestPersonProfileStatus,
  LeaveRequestScheduleTimeFields,
} from '../../client/src/pages/MonthlySchedule/LeaveRequestScheduleTimeFields';
import { beginLatestDutyOverviewRequest } from '../../client/src/pages/MonthlySchedule/screenshot-readiness';

const pageText = readFileSync(join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'), 'utf8');
const page = ts.createSourceFile('MonthlySchedule.tsx', pageText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function findNode(root: ts.Node, matches: (node: ts.Node) => boolean): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node) => { if (found) return; if (matches(node)) found = node; else ts.forEachChild(node, visit); };
  visit(root);
  if (!found) throw new Error('Actual implementation entry was not found');
  return found;
}
function compile(text: string, bindings: Record<string, unknown>) {
  const output = ts.transpileModule(`export const work = ${text};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function('exports', ...Object.keys(bindings), `${output}; return exports.work;`)({}, ...Object.values(bindings));
}
function callback(name: string, bindings: Record<string, unknown>) {
  const declaration = findNode(page, node => ts.isVariableDeclaration(node) && node.name.getText(page) === name) as ts.VariableDeclaration;
  const call = declaration.initializer as ts.CallExpression;
  expect(ts.isCallExpression(call)).toBe(true);
  return compile(call.arguments[0].getText(page), bindings);
}
function effect(marker: string, bindings: Record<string, unknown>) {
  const call = findNode(page, node => ts.isCallExpression(node) && node.expression.getText(page) === 'useEffect' &&
    !!node.arguments[0]?.getText(page).includes(marker)) as ts.CallExpression;
  return compile(call.arguments[0].getText(page), bindings);
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function computed(name: string, bindings: Record<string, unknown>) {
  const declaration = findNode(page, node => ts.isVariableDeclaration(node) && node.name.getText(page) === name) as ts.VariableDeclaration;
  return compile(`() => (${declaration.initializer!.getText(page)})`, { useMemo: (read: () => unknown) => read(), ...bindings })();
}
function loaderFixture() {
  const old = { id: 'old-person', supervisorText: '合成人员' };
  const state = { profiles: [old], details: [{ phone: 'synthetic-only' }], submitters: ['合成人员'],
    snapshot: { fetchedAt: 1000 as number | null, stale: false, refreshing: false }, status: 'ready', pollVersion: 0 };
  const setter = (key: keyof typeof state) => jest.fn((value: any) => { (state as any)[key] = typeof value === 'function' ? value(state[key]) : value; });
  const env = {
    canReadPublicProfiles: true, canViewPrivateProfile: false, canRefreshPublicProfiles: false, canRefreshPrivateProfile: false,
    personProfileReadScope: 'principal-a:public', activePersonProfileReadScopeRef: { current: 'principal-a:public' },
    personProfileInFlightScopeRef: { current: null as string | null }, personProfileLoadAbortRef: { current: null as AbortController | null },
    personProfileLoadSeqRef: { current: 0 }, personProfileRefreshDeadlineRef: { current: null as number | null },
    beginLatestDutyOverviewRequest,
    getPersonProfiles: jest.fn(async () => ({ organizations: [old] })), getPersonProfileDetails: jest.fn(async () => ({ organizations: [] })),
    setPersonProfiles: setter('profiles'), setPersonProfileDetails: setter('details'), setChangeRequestSubmitterOptions: setter('submitters'),
    setPersonProfilePublishedScope: jest.fn(), setPersonProfileDetailScope: jest.fn(),
    travelProfileLoadSeqRef: { current: 0 }, travelProfileLoadAbortRef: { current: null as AbortController | null },
    travelProfileInFlightScopeRef: { current: null as string | null }, travelProfileRefreshDeadlineRef: { current: null as number | null },
    setTravelPersonProfiles: jest.fn(), setTravelProfilePublishedScope: jest.fn(), setTravelProfileSnapshot: jest.fn(), setTravelProfilesStatus: jest.fn(),
    setPersonProfileSnapshot: setter('snapshot'), setPersonProfilePollVersion: setter('pollVersion'),
    setScreenshotSectionState: jest.fn((_section, value) => { state.status = value; }),
    logger: { error: jest.fn(), warn: jest.fn() },
  };
  return { old, state, env, load: () => callback('loadPersonProfiles', env) as (force?: boolean) => Promise<void> };
}

describe('leave request reference loading and recovery (actual callbacks, no backend)', () => {
  it('keeps a previous public list while loading, marks a failed refresh stale and drops private details', async () => {
    const fixture = loaderFixture(), request = deferred<any>();
    fixture.env.getPersonProfiles.mockReturnValueOnce(request.promise);
    const pending = fixture.load()(false);
    expect(fixture.state.profiles).toEqual([fixture.old]); expect(fixture.state.status).toBe('loading');
    request.reject(new Error('synthetic read timeout')); await pending;
    expect(fixture.state.profiles).toEqual([fixture.old]); expect(fixture.state.details).toEqual([]);
    expect(fixture.state.snapshot).toEqual({ fetchedAt: 1000, stale: true, refreshing: false });
    expect(fixture.state.status).toBe('error'); expect(fixture.env.personProfileLoadAbortRef.current).toBeNull();
  });
  it('coalesces repeated retries and does not promote a normal reader to forced refresh', async () => {
    const fixture = loaderFixture(), request = deferred<any>();
    fixture.env.getPersonProfiles.mockReturnValueOnce(request.promise);
    const load = fixture.load(), first = load(true), repeated = load(true);
    expect(fixture.env.getPersonProfiles).toHaveBeenCalledTimes(1);
    expect(fixture.env.getPersonProfiles.mock.calls[0]).toEqual([false, 'leave', expect.any(AbortSignal)]);
    request.resolve({ organizations: [fixture.old], cache: { fetchedAt: 2000, stale: false, refreshing: false } });
    await Promise.all([first, repeated]);
    expect(fixture.state.snapshot).toEqual({ fetchedAt: 2000, stale: false, refreshing: false });
    expect(fixture.state.status).toBe('ready');
  });
  it.each(['success', 'failure'])('ignores an obsolete %s after identity or permission scope changes', async outcome => {
    const fixture = loaderFixture(), oldRequest = deferred<any>(), newRequest = deferred<any>();
    fixture.env.getPersonProfiles.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    const old = fixture.load()();
    fixture.env.activePersonProfileReadScopeRef.current = 'principal-b:public';
    fixture.env.personProfileReadScope = 'principal-b:public';
    const next = fixture.load()();
    const currentController = fixture.env.personProfileLoadAbortRef.current;
    if (outcome === 'success') oldRequest.resolve({ organizations: [{ id: 'forbidden-old-response' }] });
    else oldRequest.reject(new Error('old request failed'));
    await old;
    expect(fixture.env.personProfileLoadAbortRef.current).toBe(currentController);
    expect(fixture.state.status).toBe('loading');
    newRequest.resolve({ organizations: [{ id: 'current-person' }] }); await next;
    expect(fixture.state.profiles).toEqual([{ id: 'current-person' }]); expect(fixture.state.status).toBe('ready');
  });
  it('clears cached public and private profiles on permission withdrawal and ignores late reads', async () => {
    const fixture = loaderFixture(), request = deferred<any>();
    fixture.env.getPersonProfiles.mockReturnValueOnce(request.promise);
    const pending = fixture.load()();
    fixture.env.canReadPublicProfiles = false; fixture.env.activePersonProfileReadScopeRef.current = 'principal-a:revoked';
    effect('Published data is masked synchronously above', fixture.env)();
    expect(fixture.state.profiles).toEqual([]); expect(fixture.state.details).toEqual([]); expect(fixture.state.submitters).toEqual([]);
    expect(fixture.state.snapshot).toEqual({ fetchedAt: null, stale: false, refreshing: false });
    request.resolve({ organizations: [fixture.old] }); await pending;
    expect(fixture.state.profiles).toEqual([]); expect(fixture.env.personProfileLoadAbortRef.current).toBeNull();
  });
  it('retains metadata from a background cache and marks a stopped stale refresh as unavailable', async () => {
    const fixture = loaderFixture();
    fixture.env.getPersonProfiles.mockResolvedValueOnce({ organizations: [fixture.old], cache: { fetchedAt: 1000, stale: true, refreshing: true } } as any);
    await fixture.load()();
    expect(fixture.state.snapshot).toEqual({ fetchedAt: 1000, stale: true, refreshing: true });
    fixture.env.getPersonProfiles.mockResolvedValueOnce({ organizations: [fixture.old], cache: { fetchedAt: 1000, stale: true, refreshing: false } } as any);
    await fixture.load()(); expect(fixture.state.status).toBe('error'); expect(fixture.state.profiles).toEqual([fixture.old]);
  });
  it('retries within the existing dialog without clearing draft state or forcing a refresh', () => {
    const load = jest.fn(), env = { leaveRequestDraftLocked: false, personProfileLoadAbortRef: { current: null },
      personProfileRefreshDeadlineRef: { current: 5000 }, loadPersonProfiles: load };
    callback('handleRetryLeavePersonProfiles', env)();
    expect(load).toHaveBeenCalledWith(false); expect(env.personProfileRefreshDeadlineRef.current).toBeNull();
    env.leaveRequestDraftLocked = true; callback('handleRetryLeavePersonProfiles', env)(); expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('bounded background refresh while leave dialog is open', () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(1000); });
  afterEach(() => jest.useRealTimers());
  function fixture() {
    const env = { leaveRequestDialogOpen: true, canReadPublicProfiles: true, personProfileSnapshot: { refreshing: true },
      personProfileRefreshDeadlineRef: { current: null as number | null }, screenshotReadiness: { personProfiles: 'ready' },
      loadPersonProfiles: jest.fn(), setPersonProfileSnapshot: jest.fn(), setScreenshotSectionState: jest.fn(),
      window: { setTimeout, clearTimeout } };
    return { env, run: () => effect('const deadline = personProfileRefreshDeadlineRef.current', env)() };
  }
  it('polls only a normal local read, then stops after two minutes', async () => {
    const { env, run } = fixture(); const cleanup = run();
    expect(env.personProfileRefreshDeadlineRef.current).toBe(121000);
    await jest.advanceTimersByTimeAsync(5000); expect(env.loadPersonProfiles).toHaveBeenCalledWith(false); cleanup();
    jest.setSystemTime(121001); run();
    expect(env.setScreenshotSectionState).toHaveBeenCalledWith('personProfiles', 'error');
    const update = env.setPersonProfileSnapshot.mock.calls[0][0];
    expect(update({ fetchedAt: 1000, stale: true, refreshing: true })).toEqual({ fetchedAt: 1000, stale: true, refreshing: false });
    expect(jest.getTimerCount()).toBe(0);
  });
  it('cancels delayed polling on close and does not poll during an in-flight request', async () => {
    const { env, run } = fixture(); const cleanup = run(); cleanup();
    env.leaveRequestDialogOpen = false; run(); await jest.advanceTimersByTimeAsync(10000);
    expect(env.loadPersonProfiles).not.toHaveBeenCalled(); expect(env.personProfileRefreshDeadlineRef.current).toBeNull();
    env.leaveRequestDialogOpen = true; env.screenshotReadiness.personProfiles = 'loading'; run();
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('leave reference error and stale presentation', () => {
  const times = { startAt: '', endAt: '', startOptions: [], endOptions: [], disabled: false,
    loading: false, onStartAtChange: jest.fn(), onEndAtChange: jest.fn() };
  it.each([
    { ready: false, loading: true },
    { ready: false, error: '人员资料暂不可用，暂不能判断可申请的排班时段。' },
    { ready: false, error: '排班读取失败，暂不能判断可申请的排班时段。' },
    { ready: false },
  ])('never reports an empty schedule until reference data is ready: %j', state => {
    const html = renderToStaticMarkup(createElement(LeaveRequestScheduleTimeFields, { ...times, ...state }));
    expect(html).not.toContain('没有可请休假的排班时段');
    expect(html.match(/<select[^>]*disabled/g)).toHaveLength(4);
  });
  it('shows a genuine empty schedule only after successful data loading', () => {
    const html = renderToStaticMarkup(createElement(LeaveRequestScheduleTimeFields, { ...times, ready: true }));
    expect(html).toContain('当前人员没有可请休假的排班时段');
  });
  it('shows retained data with its timestamp and a retry in the same dialog', () => {
    const onRetry = jest.fn();
    const props = { status: 'error' as const, stale: true, refreshing: false, fetchedAt: Date.UTC(2026,10,5,1),
      hasProfile: true, hasSelection: true, disabled: false, onRetry };
    const html = renderToStaticMarkup(createElement(LeaveRequestPersonProfileStatus, props));
    expect(html).toContain('上次成功的数据'); expect(html).toContain('上次更新'); expect(html).not.toContain('关闭后重试');
    const nodes = (node: ReactNode): any[] => Array.isArray(node) ? node.flatMap(nodes) : isValidElement<any>(node) ? [node, ...nodes(node.props.children)] : [];
    const retry = nodes(LeaveRequestPersonProfileStatus(props)).find(node => node.type === 'button');
    expect(retry.props.disabled).toBe(false); retry.props.onClick(); expect(onRetry).toHaveBeenCalledTimes(1);
  });
  it('does not enable a new submission from a stale profile', () => {
    const declaration = findNode(page, node => ts.isVariableDeclaration(node) && node.name.getText(page) === 'isLeavePersonProfileReady') as ts.VariableDeclaration;
    const ready = (state: Record<string, unknown>) => compile(`() => (${declaration.initializer!.getText(page)})`, {
      canReadPublicProfiles: true, selectedLeaveStaffProfile: {}, screenshotReadiness: { personProfiles: 'ready' },
      personProfileSnapshot: { stale: false, refreshing: false }, ...state,
    })();
    expect(ready({})).toBe(true);
    expect(ready({ personProfileSnapshot: { stale: true, refreshing: false } })).toBe(false);
    expect(ready({ screenshotReadiness: { personProfiles: 'error' } })).toBe(false);
    expect(ready({ canReadPublicProfiles: false })).toBe(false);
    const handler = callback('handleSubmitLeaveRequest', {
      leaveApplicant: { mode: 'automatic', name: '合成人员' }, lockedLeaveRequestRetryBinding: null,
      canCreateLeaveRequest: true, leaveRequestSubmittingRef: { current: false }, leaveRequestSubmitting: false,
      leaveStaffName: '合成人员', leaveReason: '合成原因', selectedLeaveStaffProfile: {}, isLeavePersonProfileReady: false,
      toast: { warning: jest.fn() },
    });
    expect(() => handler()).not.toThrow();
  });
  it('keeps an already accepted unknown request recoverable without using a stale profile to authorize a new submission', () => {
    const persist = jest.fn(() => false), toast = { error: jest.fn() };
    const handler = callback('handleSubmitLeaveRequest', {
      leaveApplicant: { mode: 'automatic', name: '合成人员' },
      lockedLeaveRequestRetryBinding: { clientMutationId: 'original-accepted-id', snapshot: { staffName: '合成人员' } },
      canCreateLeaveRequest: true, leaveRequestSubmittingRef: { current: false }, leaveRequestSubmitting: false,
      isLeavePersonProfileReady: false, getLeaveRequestSessionStorage: () => null,
      persistLeaveRequestUnknownMutationId: persist, toast,
    });
    handler();
    expect(persist).toHaveBeenCalledWith(null, 'original-accepted-id');
    expect(toast.error).toHaveBeenCalledWith('浏览器无法保存本次申请标识，请检查存储设置后重试');
  });
});

describe('published personnel data isolation and travel recovery', () => {
  it('masks all previously published lists, private details and metadata before a new-principal effect runs', () => {
    const env: Record<string, unknown> = {
      canReadPublicProfiles: true, canViewPrivateProfile: true, personProfileReadScope: 'new',
      personProfilePublishedScope: 'old', personProfileDetailScope: 'old', travelProfilePublishedScope: 'old',
      storedPersonProfiles: [{ id: 'old' }], storedPersonProfileDetails: [{ phone: 'old-private' }],
      storedChangeRequestSubmitterOptions: ['old-name'], storedTravelPersonProfiles: [{ id: 'old-travel' }],
      storedPersonProfileSnapshot: { fetchedAt: 1, stale: false, refreshing: false },
      storedTravelProfileSnapshot: { fetchedAt: 1, stale: false, refreshing: false },
    };
    for (const name of ['personProfiles','personProfileDetails','changeRequestSubmitterOptions','travelPersonProfiles']) expect(computed(name, env)).toEqual([]);
    for (const name of ['personProfileSnapshot','travelProfileSnapshot']) expect(computed(name, env)).toEqual({ fetchedAt: null, stale: false, refreshing: false });
    env.personProfileReadScope = 'old'; expect(computed('personProfileDetails', env)).toEqual(env.storedPersonProfileDetails);
    env.canViewPrivateProfile = false; expect(computed('personProfileDetails', env)).toEqual([]);
  });
  function travelFixture() {
    const fixture = loaderFixture();
    const state = { profiles: [fixture.old], snapshot: { fetchedAt: 1000 as number | null, stale: false, refreshing: false }, status: 'ready', pollVersion: 0 };
    const setter = (key: keyof typeof state) => jest.fn((value: any) => { (state as any)[key] = typeof value === 'function' ? value(state[key]) : value; });
    const env = { ...fixture.env, setTravelPersonProfiles: setter('profiles'), setTravelProfileSnapshot: setter('snapshot'),
      setTravelProfilesStatus: setter('status'), setTravelProfilePollVersion: setter('pollVersion') };
    return { ...fixture, state, env, load: () => callback('loadTravelPersonProfiles', env) as (force?: boolean) => Promise<void> };
  }
  it('retains the travel list after failure and preserves stale background metadata, never treating it as fresh', async () => {
    const f = travelFixture(); f.env.getPersonProfiles.mockRejectedValueOnce(new Error('unavailable'));
    await f.load()(); expect(f.state.profiles).toEqual([f.old]); expect(f.state.status).toBe('error');
    expect(f.state.snapshot).toEqual({ fetchedAt: 1000, stale: true, refreshing: false });
    f.env.getPersonProfiles.mockResolvedValueOnce({ organizations: [f.old], cache: { fetchedAt: 1000, stale: true, refreshing: true } } as any);
    await f.load()(); expect(f.state.snapshot.refreshing).toBe(true);
    expect(computed('isTravelPersonProfileReady', { ...f.env, travelProfilePublishedScope: f.env.personProfileReadScope,
      travelProfilesStatus: f.state.status, travelProfileSnapshot: f.state.snapshot })).toBe(false);
  });
  it.each(['success','failure'])('ignores late travel %s on account change and merges repeated retries', async outcome => {
    const f = travelFixture(), read = deferred<any>(); f.env.getPersonProfiles.mockReturnValueOnce(read.promise);
    const work = f.load()(); await f.load()(); expect(f.env.getPersonProfiles).toHaveBeenCalledTimes(1);
    f.env.activePersonProfileReadScopeRef.current = 'other';
    if (outcome === 'success') read.resolve({ organizations: [{ id: 'should-not-publish' }] }); else read.reject(new Error('late'));
    await work; expect(f.state.profiles).toEqual([f.old]); expect(f.env.setTravelPersonProfiles).not.toHaveBeenCalled();
    expect(f.env.setTravelProfilePublishedScope).not.toHaveBeenCalled();
  });
  it('clears travel and aborts in-flight reads at a scope boundary, even if both accounts can read', async () => {
    const f = travelFixture(), read = deferred<any>(); f.env.getPersonProfiles.mockReturnValueOnce(read.promise);
    const work = f.load()(); const controller = f.env.travelProfileLoadAbortRef.current;
    effect('Published data is masked synchronously above', f.env)();
    expect(controller?.signal.aborted).toBe(true); expect(f.state.profiles).toEqual([]); expect(f.state.status).toBe('idle');
    read.resolve({ organizations: [f.old] }); await work; expect(f.state.profiles).toEqual([]);
  });
  it('retries travel in place with normal read and stops background polling on timeout or close', async () => {
    jest.useFakeTimers(); jest.setSystemTime(1000);
    try {
      const env = { personnelMovementDialogOpen: false, vacancyDialogOpen: true, staffAdjustmentMode: 'travel',
        canReadPublicProfiles: true, travelProfileSnapshot: { refreshing: true }, travelProfilesStatus: 'ready',
        travelProfileRefreshDeadlineRef: { current: null as number | null }, loadTravelPersonProfiles: jest.fn(),
        setTravelProfileSnapshot: jest.fn(), setTravelProfilesStatus: jest.fn(), window: { setTimeout, clearTimeout },
        travelSubmitting: false, personnelMovementSubmitting: false, travelProfileLoadAbortRef: { current: null } };
      callback('handleRetryTravelPersonProfiles', env)(); expect(env.loadTravelPersonProfiles).toHaveBeenCalledWith(false);
      const run = () => effect('const deadline = travelProfileRefreshDeadlineRef.current', env)();
      const cleanup = run(); await jest.advanceTimersByTimeAsync(5000); cleanup();
      jest.setSystemTime(121001); run(); expect(env.setTravelProfilesStatus).toHaveBeenCalledWith('error');
      env.vacancyDialogOpen = false; run(); expect(env.travelProfileRefreshDeadlineRef.current).toBeNull();
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });
  it('rejects a new travel submission while personnel are stale without any business write', async () => {
    const warning = jest.fn();
    await callback('handleSubmitTravelStaff', { canCreateMonthlySchedule: true, travelSubmitting: false,
      isTravelPersonProfileReady: false, toast: { warning } })();
    expect(warning).toHaveBeenCalledWith('人员资料尚未核验完成，请重新加载人员资料后提交');
  });
});

it('passes public projection cache metadata through the existing API mapping', async () => {
  const text = readFileSync(join(process.cwd(), 'client/src/api/index.ts'), 'utf8');
  const source = ts.createSourceFile('api.ts', text, ts.ScriptTarget.Latest, true);
  const declaration = findNode(source, node => ts.isFunctionDeclaration(node) && node.name?.text === 'getPersonProfiles');
  const cache = { fetchedAt: 1000, stale: true, refreshing: true };
  const read = compile(declaration.getText(source).replace(/^export\s+/, ''), {
    axiosForBackend: jest.fn(async () => ({ data: { organizations: [], cache } })), DUTY_PAGE_READ_TIMEOUT_MS: 60000,
    logger: { error: jest.fn() },
  });
  expect((await read(false, 'leave')).cache).toEqual(cache);
});
