import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getChinaWorkCalendarSnapshot } from '../../shared/china-work-calendar';
import {
  readChinaWorkCalendarStateFile,
  resolveChinaWorkCalendarStatePath,
  writeChinaWorkCalendarStateFile,
  type ChinaWorkCalendarPersistedState,
} from '../../server/modules/duty-schedule/china-work-calendar-state-store';

describe('china work calendar persistent state', () => {
  let root = '';
  const originalStatePath = process.env.CHINA_WORK_CALENDAR_STATE_PATH;
  const originalStatePathAlias =
    process.env.DUTY_CHINA_WORK_CALENDAR_STATE_PATH;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'china-work-calendar-state-'));
    delete process.env.CHINA_WORK_CALENDAR_STATE_PATH;
    delete process.env.DUTY_CHINA_WORK_CALENDAR_STATE_PATH;
  });

  afterEach(() => {
    if (originalStatePath === undefined) {
      delete process.env.CHINA_WORK_CALENDAR_STATE_PATH;
    } else {
      process.env.CHINA_WORK_CALENDAR_STATE_PATH = originalStatePath;
    }
    if (originalStatePathAlias === undefined) {
      delete process.env.DUTY_CHINA_WORK_CALENDAR_STATE_PATH;
    } else {
      process.env.DUTY_CHINA_WORK_CALENDAR_STATE_PATH = originalStatePathAlias;
    }
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses release-local data in development and shared state in production', () => {
    expect(
      resolveChinaWorkCalendarStatePath({
        cwd: join(root, 'development-release'),
        nodeEnv: 'development',
      }),
    ).toBe(
      join(
        root,
        'development-release',
        'data',
        'china-work-calendar-state.json',
      ),
    );

    expect(
      resolveChinaWorkCalendarStatePath({
        cwd: join(root, 'production-release'),
        nodeEnv: 'production',
      }),
    ).toBe(
      join(root, 'nantong-schedule-state', 'china-work-calendar-state.json'),
    );
  });

  it('honors an explicit path and the legacy environment alias', () => {
    const explicitPath = join(root, 'explicit', 'calendar.json');
    expect(
      resolveChinaWorkCalendarStatePath({
        cwd: join(root, 'ignored'),
        explicitPath,
      }),
    ).toBe(explicitPath);

    const aliasPath = join(root, 'alias', 'calendar.json');
    process.env.DUTY_CHINA_WORK_CALENDAR_STATE_PATH = aliasPath;
    expect(
      resolveChinaWorkCalendarStatePath({ cwd: join(root, 'ignored') }),
    ).toBe(aliasPath);
  });

  it('returns null when the state file does not exist', () => {
    expect(
      readChinaWorkCalendarStateFile({
        explicitPath: join(root, 'missing.json'),
      }),
    ).toBeNull();
  });

  it('round-trips a validated last-known-good snapshot', () => {
    const options = { explicitPath: join(root, 'nested', 'calendar.json') };
    const state: ChinaWorkCalendarPersistedState = {
      schemaVersion: 1,
      snapshot: getChinaWorkCalendarSnapshot(),
      lastCheckedAt: '2026-08-03T03:20:00.000Z',
      lastSuccessAt: '2026-08-03T03:20:01.000Z',
      nextCheckAt: '2026-09-02T03:20:00.000Z',
      yearChecks: {
        '2026': {
          lastCheckedAt: '2026-08-03T03:20:00.000Z',
          lastSuccessAt: '2026-08-03T03:20:01.000Z',
          consecutiveFailures: 0,
        },
        '2027': {
          lastCheckedAt: '2026-08-03T03:20:00.000Z',
          notPublished: true,
          consecutiveFailures: 0,
        },
      },
    };

    writeChinaWorkCalendarStateFile(state, options);

    expect(readChinaWorkCalendarStateFile(options)).toEqual(state);
    expect(readdirSync(dirname(options.explicitPath))).toEqual([
      'calendar.json',
    ]);
  });

  it('rejects corrupt JSON with a clear state-file error', () => {
    const explicitPath = join(root, 'corrupt.json');
    writeFileSync(explicitPath, '{broken', 'utf8');

    expect(() => readChinaWorkCalendarStateFile({ explicitPath })).toThrow(
      '中国法定节假日历状态文件损坏',
    );
  });

  it('rejects a persisted state containing an invalid snapshot', () => {
    const explicitPath = join(root, 'invalid-snapshot.json');
    writeFileSync(
      explicitPath,
      JSON.stringify({
        schemaVersion: 1,
        snapshot: {},
      }),
      'utf8',
    );

    expect(() => readChinaWorkCalendarStateFile({ explicitPath })).toThrow(
      '中国法定节假日历状态文件损坏',
    );
  });

  it('validates before writing and never leaves a temporary file', () => {
    const explicitPath = join(root, 'atomic', 'calendar.json');
    mkdirSync(dirname(explicitPath), { recursive: true });

    expect(() =>
      writeChinaWorkCalendarStateFile(
        {
          schemaVersion: 1,
          snapshot: {},
        } as unknown as ChinaWorkCalendarPersistedState,
        { explicitPath },
      ),
    ).toThrow('中国法定节假日历状态无效');

    expect(existsSync(explicitPath)).toBe(false);
    expect(
      readdirSync(dirname(explicitPath)).filter((name) =>
        name.endsWith('.tmp'),
      ),
    ).toEqual([]);
  });
});
