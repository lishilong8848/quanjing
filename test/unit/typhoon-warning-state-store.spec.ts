import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireTyphoonWarningMonitorLease,
  readTyphoonWarningSendStateFile,
  resolveTyphoonWarningStatePath,
  writeTyphoonWarningSendStateFile,
} from '../../server/modules/duty-schedule/typhoon-warning-state-store';

describe('typhoon warning persistent state', () => {
  let root = '';
  let releaseDirectory = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'typhoon-state-'));
    releaseDirectory = join(root, 'release-20260728');
    mkdirSync(releaseDirectory, { recursive: true });
  });

  afterEach(() => {
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses one shared production state path across timestamped releases', () => {
    expect(resolveTyphoonWarningStatePath({
      cwd: join(root, 'release-a'),
      nodeEnv: 'production',
    })).toBe(join(root, 'nantong-schedule-state', 'typhoon-warning-send-state.json'));
    expect(resolveTyphoonWarningStatePath({
      cwd: join(root, 'release-b'),
      nodeEnv: 'production',
    })).toBe(join(root, 'nantong-schedule-state', 'typhoon-warning-send-state.json'));
  });

  it('migrates the legacy release-local state before deciding whether to send', () => {
    const legacyDirectory = join(releaseDirectory, 'data');
    mkdirSync(legacyDirectory, { recursive: true });
    writeFileSync(
      join(legacyDirectory, 'typhoon-warning-send-state.json'),
      JSON.stringify({
        warningKey: 'existing-warning',
        level: 'yellow',
        lastSentAt: '2026-07-28T08:00:00.000Z',
      }),
      'utf8',
    );

    const state = readTyphoonWarningSendStateFile({
      cwd: releaseDirectory,
      nodeEnv: 'production',
    });
    const sharedPath = resolveTyphoonWarningStatePath({
      cwd: releaseDirectory,
      nodeEnv: 'production',
    });

    expect(state.warningKey).toBe('existing-warning');
    expect(existsSync(sharedPath)).toBe(true);
    expect(readTyphoonWarningSendStateFile({
      cwd: releaseDirectory,
      nodeEnv: 'production',
    })).toEqual(state);
  });

  it('writes atomically and refuses to treat corrupt state as never sent', () => {
    const options = {
      cwd: releaseDirectory,
      nodeEnv: 'production',
    };
    writeTyphoonWarningSendStateFile({
      warningKey: 'valid-warning',
      level: 'blue',
      lastSentAt: '2026-07-28T08:00:00.000Z',
    }, options);
    expect(readTyphoonWarningSendStateFile(options).warningKey)
      .toBe('valid-warning');

    writeFileSync(resolveTyphoonWarningStatePath(options), '{broken', 'utf8');
    expect(() => readTyphoonWarningSendStateFile(options))
      .toThrow('台风预警发送状态文件损坏');
  });

  it('allows only one process lease at a time and releases it safely', () => {
    const options = {
      cwd: releaseDirectory,
      nodeEnv: 'production',
    };
    const first = acquireTyphoonWarningMonitorLease(options);
    const second = acquireTyphoonWarningMonitorLease(options);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    first?.release();
    const afterRelease = acquireTyphoonWarningMonitorLease(options);
    expect(afterRelease).not.toBeNull();
    afterRelease?.release();
  });
});
