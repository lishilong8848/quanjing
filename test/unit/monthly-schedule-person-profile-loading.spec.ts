import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';
import { beginLatestDutyOverviewRequest } from '../../client/src/pages/MonthlySchedule/screenshot-readiness';

const pageSource = readFileSync(
  join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'), 'utf8',
);
const dialogSource = readFileSync(
  join(process.cwd(), 'client/src/pages/MonthlySchedule/OvertimeRequestDialog.tsx'), 'utf8',
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function loader() {
  const source = pageSource.slice(
    pageSource.indexOf('  const loadPersonProfiles = useCallback('),
    pageSource.indexOf('  const loadTravelPersonProfiles = useCallback('),
  );
  const context = {
    useCallback: (fn: unknown) => fn,
    beginLatestDutyOverviewRequest,
    personProfileLoadAbortRef: { current: null as AbortController | null },
    personProfileLoadSeqRef: { current: 0 },
    canViewPrivateProfile: true,
    getPersonProfiles: jest.fn(),
    getPersonProfileDetails: jest.fn(),
    setPersonProfiles: jest.fn(),
    setChangeRequestSubmitterOptions: jest.fn(),
    setPersonProfileDetails: jest.fn(),
    setScreenshotSectionState: jest.fn(),
    logger: { warn: jest.fn(), error: jest.fn() },
  };
  const compiled = transpileModule(`${source}\nloadPersonProfiles;`, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText;
  const load = runInNewContext(compiled, context) as (force?: boolean) => Promise<void>;
  return { ...context, load };
}

const profiles = [
  { supervisorText: '程卓然', position: '运维值班员', shift: 'A班', buildingsSpecialties: ['E楼'] },
  { supervisorText: '葛滨', position: '运维值班员', shift: 'D班', buildingsSpecialties: ['C楼'] },
];
const tick = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

describe('排班人员名单独立就绪', () => {
  it('快速失败被批处理成相同状态时仍完成两次自动重试，随后停止', async () => {
    jest.useFakeTimers();
    try {
      const start = dialogSource.indexOf('  const personProfileRetryCountRef') >= 0
        ? dialogSource.indexOf('  const personProfileRetryCountRef')
        : dialogSource.indexOf('  const [personProfileRetryCount');
      const code = transpileModule(dialogSource.slice(start, dialogSource.indexOf('  const startAt =', start)), {
        compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
      }).outputText;
      let state = 0, pendingRender = false, previous: unknown[][] = [];
      const ref = { current: 0 };
      const retry = jest.fn(async () => {});
      const render = () => {
        let slot = 0;
        const effects: (() => void)[] = [];
        runInNewContext(code, {
          open: true, access: { isLoading: false, principalFingerprint: 'synthetic' },
          selectedProfile: null, memberName: '程卓然', personProfilesStatus: 'error',
          onRetryPersonProfiles: retry, window: { setTimeout, clearTimeout },
          useRef: () => ref,
          useState: () => [state, (next: number | ((previous: number) => number)) => {
            const value = typeof next === 'function' ? next(state) : next;
            if (value !== state) { state = value; pendingRender = true; }
          }],
          useEffect: (fn: () => void, deps: unknown[]) => {
            const old = previous[slot]; previous[slot++] = deps;
            if (!old || old.some((value, i) => !Object.is(value, deps[i]))) effects.push(fn);
          },
        });
        effects.forEach(fn => fn());
      };
      render();
      for (let i = 0; i < 8; i += 1) {
        jest.advanceTimersByTime(1000); await tick();
        if (pendingRender) { pendingRender = false; render(); }
      }
      expect(retry).toHaveBeenCalledTimes(2);
      expect(jest.getTimerCount()).toBe(0);
    } finally { jest.useRealTimers(); }
  });

  it('基础名单返回后即可匹配加班人员，不等待可选详情', async () => {
    const c = loader(), details = deferred<{ organizations: unknown[] }>();
    c.getPersonProfiles.mockResolvedValue({ organizations: profiles, changeRequestSubmitters: ['程卓然'] });
    c.getPersonProfileDetails.mockReturnValue(details.promise);
    const pending = c.load();
    await tick();
    try {
      expect(c.setPersonProfiles).toHaveBeenCalledWith(profiles);
      expect(c.setScreenshotSectionState).toHaveBeenLastCalledWith('personProfiles', 'ready');
    } finally {
      details.resolve({ organizations: [] }); await pending;
    }
  });

  it('名单失败与详情失败分离，并可用本地读取重试恢复', async () => {
    const c = loader();
    c.getPersonProfiles.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce({ organizations: profiles });
    c.getPersonProfileDetails.mockRejectedValue(new Error('optional details unavailable'));
    await c.load();
    expect(c.setScreenshotSectionState).toHaveBeenLastCalledWith('personProfiles', 'error');
    expect(c.setPersonProfiles).not.toHaveBeenCalled();
    await c.load();
    expect(c.getPersonProfiles).toHaveBeenLastCalledWith(false, 'leave', expect.any(AbortSignal));
    expect(c.setPersonProfiles).toHaveBeenCalledWith(profiles);
    expect(c.setScreenshotSectionState).toHaveBeenLastCalledWith('personProfiles', 'ready');
  });

  it('旧请求的名单与详情都不能覆盖新响应', async () => {
    const c = loader(), oldPublic = deferred<unknown>(), oldDetail = deferred<unknown>();
    c.getPersonProfiles.mockReturnValueOnce(oldPublic.promise).mockResolvedValueOnce({ organizations: profiles });
    c.getPersonProfileDetails.mockReturnValueOnce(oldDetail.promise).mockResolvedValueOnce({ organizations: [] });
    const old = c.load(); await c.load();
    oldPublic.resolve({ organizations: [{ supervisorText: '旧人员' }] });
    oldDetail.resolve({ organizations: [{ supervisorText: '旧详情' }] }); await old;
    expect(c.setPersonProfiles).toHaveBeenCalledTimes(1);
    expect(c.setPersonProfiles).toHaveBeenLastCalledWith(profiles);
    expect(c.setPersonProfileDetails).not.toHaveBeenCalledWith([{ supervisorText: '旧详情' }]);
  });

  it('名单失败时仍保留未结束详情的取消句柄，离开页面不再回填', async () => {
    const c = loader(), details = deferred<{ organizations: unknown[] }>();
    c.getPersonProfiles.mockRejectedValue(new Error('temporary'));
    c.getPersonProfileDetails.mockReturnValue(details.promise);
    const pending = c.load(); await tick();
    const controller = c.personProfileLoadAbortRef.current;
    try {
      expect(c.setScreenshotSectionState).toHaveBeenLastCalledWith('personProfiles', 'error');
      expect(controller).not.toBeNull();
      controller?.abort();
    } finally {
      details.resolve({ organizations: [{ supervisorText: '已离开页面' }] }); await pending;
    }
    expect(c.setPersonProfileDetails).not.toHaveBeenCalledWith([{ supervisorText: '已离开页面' }]);
  });

  it('C楼主管杨占山使用已有置顶加粗规则', () => {
    expect(/building_c:\s*\['杨占山'\]/u.test(pageSource)).toBe(true);
  });
});
