import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  acquireWeatherWarningDeliveryLease,
  readWeatherWarningDeliveryStateFile,
  writeWeatherWarningDeliveryStateFile,
  type WeatherWarningDeliveryState,
} from '../../server/modules/weather-warning/weather-warning-delivery-state-store';

const STATE_FILE_NAME = 'weather-warning-delivery-state.json';
const TEN_MINUTES_MS = 10 * 60 * 1000;

type WeatherWarningDeliveryStateStoreModule =
  typeof import('../../server/modules/weather-warning/weather-warning-delivery-state-store');

function createState(): WeatherWarningDeliveryState {
  return {
    version: 1,
    entries: {
      'weather-test-20260803-001': {
        clientMutationId: 'weather-test-20260803-001',
        messageId: 'om_weather_test_1',
        sentAt: '2026-08-03T08:00:00.000Z',
        uuid: 'weather-warning-test-uuid-1',
        snapshotSignature: 'sha256:weather-warning-snapshot',
      },
    },
  };
}

function leaseToken(pid: number, sequence: number): string {
  return `${pid}:550e8400-e29b-41d4-a716-${sequence
    .toString(16)
    .padStart(12, '0')}`;
}

function writeLeaseFence(path: string, token: string, acquiredAt: Date): void {
  writeFileSync(
    path,
    JSON.stringify({ token, acquiredAt: acquiredAt.toISOString() }),
    'utf8',
  );
}

function writeRecoveryClaim(
  lockPath: string,
  claimId: string,
  token: string,
  acquiredAt: Date,
): void {
  const claimPath = join(lockPath, `recovery-${claimId}.lease`);
  mkdirSync(claimPath);
  writeLeaseFence(join(claimPath, 'claim.json'), token, acquiredAt);
}

function mockProcessLiveness(
  livenessByPid: Record<number, 'dead' | 'alive' | 'unknown'>,
): () => void {
  const killSpy = jest.spyOn(process, 'kill').mockImplementation(((
    pid: number,
    signal?: number | NodeJS.Signals,
  ) => {
    const liveness = livenessByPid[pid];
    if (signal !== 0 || !liveness || liveness === 'alive') return undefined;
    throw Object.assign(new Error('process probe failed'), {
      code: liveness === 'dead' ? 'ESRCH' : 'EPERM',
    });
  }) as never);
  return () => killSpy.mockRestore();
}

describe('weather warning delivery state store', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'weather-warning-delivery-state-'));
  });

  afterEach(() => {
    if (root && existsSync(root)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns an empty version-one state until a validated state is written', () => {
    const explicitPath = join(root, 'nested', STATE_FILE_NAME);

    expect(readWeatherWarningDeliveryStateFile({ explicitPath })).toEqual({
      version: 1,
      entries: {},
    });

    const state = createState();
    writeWeatherWarningDeliveryStateFile(state, { explicitPath });

    expect(readWeatherWarningDeliveryStateFile({ explicitPath })).toEqual(
      state,
    );
  });

  it('persists only the allow-listed delivery entry fields and leaves no temporary file', () => {
    const explicitPath = join(root, 'atomic', STATE_FILE_NAME);
    const unsafeState = {
      ...createState(),
      recipientOpenId: 'ou_should_not_persist',
      entries: {
        'weather-test-20260803-001': {
          ...createState().entries['weather-test-20260803-001'],
          recipientOpenId: 'ou_should_not_persist',
          card: { elements: ['should not persist'] },
        },
      },
    } as unknown as WeatherWarningDeliveryState;

    writeWeatherWarningDeliveryStateFile(unsafeState, { explicitPath });

    expect(readWeatherWarningDeliveryStateFile({ explicitPath })).toEqual(
      createState(),
    );
    expect(readFileSync(explicitPath, 'utf8')).not.toContain(
      'ou_should_not_persist',
    );
    expect(readFileSync(explicitPath, 'utf8')).not.toContain(
      'should not persist',
    );
    expect(readdirSync(dirname(explicitPath))).toEqual([STATE_FILE_NAME]);
  });

  it('fails closed when the persisted state JSON is corrupt', () => {
    const explicitPath = join(root, 'corrupt.json');
    writeFileSync(explicitPath, '{broken', 'utf8');

    expect(() => readWeatherWarningDeliveryStateFile({ explicitPath })).toThrow(
      '天气预警测试发送状态文件损坏',
    );
  });

  it('does not treat a state-file I/O error as a missing delivery state', () => {
    const explicitPath = join(root, 'unreadable.json');
    const originalFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    let stateStore: WeatherWarningDeliveryStateStoreModule | undefined;

    jest.resetModules();
    jest.doMock('node:fs', () => ({
      ...originalFs,
      lstatSync: (...args: Parameters<typeof originalFs.lstatSync>) => {
        if (args[0] === explicitPath) {
          throw Object.assign(new Error('access denied'), { code: 'EACCES' });
        }
        return originalFs.lstatSync(...args);
      },
    }));

    try {
      jest.isolateModules(() => {
        stateStore =
          require('../../server/modules/weather-warning/weather-warning-delivery-state-store') as WeatherWarningDeliveryStateStoreModule;
      });

      expect(() =>
        stateStore.readWeatherWarningDeliveryStateFile({ explicitPath }),
      ).toThrow('天气预警测试发送状态文件损坏');
    } finally {
      jest.dontMock('node:fs');
      jest.resetModules();
    }
  });

  it('accepts only strict valid UTC timestamps for sentAt', () => {
    const explicitPath = join(root, 'strict-time.json');
    const entryKey = 'weather-test-20260803-001';
    const invalidTimestamps = [
      '2026-02-30T08:00:00Z',
      '2026-08-03T08:00:00+08:00',
      '1765180800000',
      '2026-08-03T08:00:00.1234Z',
    ];

    for (const sentAt of invalidTimestamps) {
      const invalidState = createState();
      invalidState.entries[entryKey] = {
        ...invalidState.entries[entryKey],
        sentAt,
      };

      expect(() =>
        writeWeatherWarningDeliveryStateFile(invalidState, { explicitPath }),
      ).toThrow('天气预警测试发送状态无效');

      writeFileSync(explicitPath, JSON.stringify(invalidState), 'utf8');
      expect(() =>
        readWeatherWarningDeliveryStateFile({ explicitPath }),
      ).toThrow('天气预警测试发送状态文件损坏');
    }
  });

  it('fails closed when a persisted messageId is not a Feishu message identifier', () => {
    const explicitPath = join(root, 'invalid-message-id.json');
    const entryKey = 'weather-test-20260803-001';
    const invalidState = createState();
    invalidState.entries[entryKey] = {
      ...invalidState.entries[entryKey],
      messageId: 'ou_should_never_be_replayed',
    };

    expect(() =>
      writeWeatherWarningDeliveryStateFile(invalidState, { explicitPath }),
    ).toThrow('天气预警测试发送状态无效');

    writeFileSync(explicitPath, JSON.stringify(invalidState), 'utf8');
    expect(() => readWeatherWarningDeliveryStateFile({ explicitPath })).toThrow(
      '天气预警测试发送状态文件损坏',
    );
  });

  it('uses an explicit path before a configured directory and resolves the cwd fallback safely', () => {
    const explicitPath = join(root, 'explicit', 'state.json');
    const configuredDirectory = join(root, 'configured');
    const cwd = join(root, 'working-directory');

    writeWeatherWarningDeliveryStateFile(createState(), {
      explicitPath,
      configuredDirectory,
      cwd,
    });
    expect(existsSync(explicitPath)).toBe(true);
    expect(existsSync(join(configuredDirectory, STATE_FILE_NAME))).toBe(false);

    writeWeatherWarningDeliveryStateFile(createState(), {
      configuredDirectory,
      cwd,
    });
    expect(existsSync(join(configuredDirectory, STATE_FILE_NAME))).toBe(true);

    writeWeatherWarningDeliveryStateFile(createState(), { cwd });
    expect(existsSync(join(resolve(cwd), 'data', STATE_FILE_NAME))).toBe(true);
  });

  it('returns null while an active lease is held and allows a new lease after release', () => {
    const explicitPath = join(root, 'lease', STATE_FILE_NAME);
    const first = acquireWeatherWarningDeliveryLease({ explicitPath });

    expect(first).not.toBeNull();
    expect(acquireWeatherWarningDeliveryLease({ explicitPath })).toBeNull();

    first?.release();
    const afterRelease = acquireWeatherWarningDeliveryLease({ explicitPath });
    expect(afterRelease).not.toBeNull();
    afterRelease?.release();
  });

  it('fails closed without inspecting a lock path reported as a symbolic link', () => {
    const explicitPath = join(root, 'symlinked-lock', STATE_FILE_NAME);
    const lockPath = `${explicitPath}.lock`;
    const now = new Date('2026-08-03T08:10:00.000Z');
    const originalFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    let stateStore: WeatherWarningDeliveryStateStoreModule | undefined;
    let inspectedLockTarget = false;

    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeLeaseFence(
      join(lockPath, 'owner-symlink.lease'),
      leaseToken(91_001, 1),
      new Date(now.getTime() - TEN_MINUTES_MS - 1),
    );
    utimesSync(
      lockPath,
      new Date(now.getTime() - TEN_MINUTES_MS - 1),
      new Date(now.getTime() - TEN_MINUTES_MS - 1),
    );

    jest.resetModules();
    jest.doMock('node:fs', () => ({
      ...originalFs,
      lstatSync: (...args: Parameters<typeof originalFs.lstatSync>) => {
        const details = originalFs.lstatSync(...args);
        if (args[0] === lockPath) {
          return Object.assign(Object.create(details), {
            isSymbolicLink: () => true,
          });
        }
        return details;
      },
      readdirSync: (...args: Parameters<typeof originalFs.readdirSync>) => {
        if (args[0] === lockPath) inspectedLockTarget = true;
        return originalFs.readdirSync(...args);
      },
    }));

    try {
      jest.isolateModules(() => {
        stateStore =
          require('../../server/modules/weather-warning/weather-warning-delivery-state-store') as WeatherWarningDeliveryStateStoreModule;
      });

      expect(
        stateStore.acquireWeatherWarningDeliveryLease({ explicitPath, now }),
      ).toBeNull();
      expect(inspectedLockTarget).toBe(false);
    } finally {
      jest.dontMock('node:fs');
      jest.resetModules();
    }
  });

  it('fails closed when a recovery fence is reported as a symbolic link', () => {
    const explicitPath = join(root, 'symlinked-fence', STATE_FILE_NAME);
    const lockPath = `${explicitPath}.lock`;
    const fencePath = join(
      lockPath,
      'recovery-550e8400-e29b-41d4-a716-446655440000.lease',
    );
    const now = new Date('2026-08-03T08:10:00.000Z');
    const originalFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    let stateStore: WeatherWarningDeliveryStateStoreModule | undefined;

    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeLeaseFence(
      join(lockPath, 'owner-symlink-fence.lease'),
      leaseToken(91_002, 1),
      new Date(now.getTime() - TEN_MINUTES_MS - 1),
    );
    mkdirSync(fencePath);
    utimesSync(
      lockPath,
      new Date(now.getTime() - TEN_MINUTES_MS - 1),
      new Date(now.getTime() - TEN_MINUTES_MS - 1),
    );

    jest.resetModules();
    jest.doMock('node:fs', () => ({
      ...originalFs,
      lstatSync: (...args: Parameters<typeof originalFs.lstatSync>) => {
        const details = originalFs.lstatSync(...args);
        if (args[0] === fencePath) {
          return Object.assign(Object.create(details), {
            isSymbolicLink: () => true,
          });
        }
        return details;
      },
    }));

    try {
      jest.isolateModules(() => {
        stateStore =
          require('../../server/modules/weather-warning/weather-warning-delivery-state-store') as WeatherWarningDeliveryStateStoreModule;
      });

      expect(
        stateStore.acquireWeatherWarningDeliveryLease({ explicitPath, now }),
      ).toBeNull();
    } finally {
      jest.dontMock('node:fs');
      jest.resetModules();
    }
  });

  it('recovers a stale sidecar lock after ten minutes', () => {
    const explicitPath = join(root, 'stale', STATE_FILE_NAME);
    const lockPath = `${explicitPath}.lock`;
    const now = new Date('2026-08-03T08:10:00.000Z');
    const deadPid = 92_001;
    const restoreProcessProbe = mockProcessLiveness({ [deadPid]: 'dead' });
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeLeaseFence(
      join(lockPath, 'owner-dead-process.lease'),
      leaseToken(deadPid, 1),
      new Date(now.getTime() - TEN_MINUTES_MS - 1),
    );

    try {
      const lease = acquireWeatherWarningDeliveryLease({ explicitPath, now });

      expect(lease).not.toBeNull();
      lease?.release();
    } finally {
      restoreProcessProbe();
    }
  });

  it('fails closed when a stale lock owner process is still live', () => {
    const explicitPath = join(root, 'live-stale-owner', STATE_FILE_NAME);
    const lockPath = `${explicitPath}.lock`;
    const now = new Date('2026-08-03T08:10:00.000Z');
    const livePid = 92_010;
    const restoreProcessProbe = mockProcessLiveness({ [livePid]: 'alive' });
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeLeaseFence(
      join(lockPath, 'owner-live.lease'),
      leaseToken(livePid, 10),
      new Date(now.getTime() - TEN_MINUTES_MS - 1),
    );

    try {
      expect(
        acquireWeatherWarningDeliveryLease({ explicitPath, now }),
      ).toBeNull();
    } finally {
      restoreProcessProbe();
    }
  });

  it('fails closed when a stale lock owner process cannot be probed', () => {
    const explicitPath = join(root, 'unknown-stale-owner', STATE_FILE_NAME);
    const lockPath = `${explicitPath}.lock`;
    const now = new Date('2026-08-03T08:10:00.000Z');
    const unknownPid = 92_011;
    const restoreProcessProbe = mockProcessLiveness({
      [unknownPid]: 'unknown',
    });
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeLeaseFence(
      join(lockPath, 'owner-unknown.lease'),
      leaseToken(unknownPid, 11),
      new Date(now.getTime() - TEN_MINUTES_MS - 1),
    );

    try {
      expect(
        acquireWeatherWarningDeliveryLease({ explicitPath, now }),
      ).toBeNull();
    } finally {
      restoreProcessProbe();
    }
  });

  it('recovers a valid recovery claim only after it has expired', () => {
    const explicitPath = join(root, 'expired-recovery', STATE_FILE_NAME);
    const lockPath = `${explicitPath}.lock`;
    const now = new Date('2026-08-03T08:10:00.000Z');
    const ownerPid = 92_002;
    const recoveryPid = 92_003;
    const restoreProcessProbe = mockProcessLiveness({
      [ownerPid]: 'dead',
      [recoveryPid]: 'dead',
    });
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeLeaseFence(
      join(lockPath, 'owner-crashed-recovery.lease'),
      leaseToken(ownerPid, 2),
      new Date(now.getTime() - 2 * TEN_MINUTES_MS),
    );
    writeRecoveryClaim(
      lockPath,
      '550e8400-e29b-41d4-a716-446655440002',
      leaseToken(recoveryPid, 3),
      new Date(now.getTime() - TEN_MINUTES_MS),
    );

    try {
      expect(
        acquireWeatherWarningDeliveryLease({ explicitPath, now }),
      ).toBeNull();

      const lease = acquireWeatherWarningDeliveryLease({
        explicitPath,
        now: new Date(now.getTime() + 1),
      });
      expect(lease).not.toBeNull();
      lease?.release();
    } finally {
      restoreProcessProbe();
    }
  });

  it('recovers after thirty expired recovery claims without extending a filename', () => {
    const explicitPath = join(root, 'many-expired-recoveries', STATE_FILE_NAME);
    const lockPath = `${explicitPath}.lock`;
    const now = new Date('2026-08-03T08:20:00.000Z');
    const ownerPid = 92_100;
    const deadProcesses: Record<number, 'dead'> = { [ownerPid]: 'dead' };
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeLeaseFence(
      join(lockPath, 'owner-crashed-recovery.lease'),
      leaseToken(ownerPid, 100),
      new Date(now.getTime() - 2 * TEN_MINUTES_MS),
    );
    for (let index = 0; index < 30; index += 1) {
      const pid = ownerPid + index + 1;
      deadProcesses[pid] = 'dead';
      writeRecoveryClaim(
        lockPath,
        `550e8400-e29b-41d4-a716-${(index + 101)
          .toString(16)
          .padStart(12, '0')}`,
        leaseToken(pid, index + 101),
        new Date(now.getTime() - TEN_MINUTES_MS - 1),
      );
    }
    const restoreProcessProbe = mockProcessLiveness(deadProcesses);

    try {
      const lease = acquireWeatherWarningDeliveryLease({ explicitPath, now });

      expect(lease).not.toBeNull();
      expect(readdirSync(lockPath)).not.toContainEqual(
        expect.stringMatching(/takeover/u),
      );
      lease?.release();
    } finally {
      restoreProcessProbe();
    }
  });

  it('migrates an expired legacy recovery fence without extending its takeover suffix', () => {
    const explicitPath = join(root, 'legacy-recovery', STATE_FILE_NAME);
    const lockPath = `${explicitPath}.lock`;
    const now = new Date('2026-08-03T08:20:00.000Z');
    const ownerPid = 92_200;
    const recoveryPid = 92_201;
    const originalFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const restoreProcessProbe = mockProcessLiveness({
      [ownerPid]: 'dead',
      [recoveryPid]: 'dead',
    });
    let stateStore: WeatherWarningDeliveryStateStoreModule | undefined;

    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeLeaseFence(
      join(lockPath, 'owner-legacy.lease'),
      leaseToken(ownerPid, 200),
      new Date(now.getTime() - 2 * TEN_MINUTES_MS),
    );
    writeLeaseFence(
      join(lockPath, '.recovery'),
      leaseToken(recoveryPid, 201),
      new Date(now.getTime() - TEN_MINUTES_MS - 1),
    );

    jest.resetModules();
    jest.doMock('node:fs', () => ({
      ...originalFs,
      openSync: (...args: Parameters<typeof originalFs.openSync>) => {
        if (
          typeof args[0] === 'string' &&
          args[0].includes('.recovery-takeover')
        ) {
          throw Object.assign(new Error('path too long'), {
            code: 'ENAMETOOLONG',
          });
        }
        return originalFs.openSync(...args);
      },
    }));

    try {
      jest.isolateModules(() => {
        stateStore =
          require('../../server/modules/weather-warning/weather-warning-delivery-state-store') as WeatherWarningDeliveryStateStoreModule;
      });

      const lease = stateStore.acquireWeatherWarningDeliveryLease({
        explicitPath,
        now,
      });
      expect(lease).not.toBeNull();
      lease?.release();
    } finally {
      jest.dontMock('node:fs');
      jest.resetModules();
      restoreProcessProbe();
    }
  });

  it('fails closed for a corrupt recovery-takeover fence', () => {
    const explicitPath = join(
      root,
      'corrupt-recovery-takeover',
      STATE_FILE_NAME,
    );
    const lockPath = `${explicitPath}.lock`;
    const now = new Date('2026-08-03T08:20:00.000Z');
    const ownerPid = 92_300;
    const recoveryPid = 92_301;
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeLeaseFence(
      join(lockPath, 'owner-corrupt-takeover.lease'),
      leaseToken(ownerPid, 300),
      new Date(now.getTime() - 2 * TEN_MINUTES_MS),
    );
    writeLeaseFence(
      join(lockPath, '.recovery'),
      leaseToken(recoveryPid, 301),
      new Date(now.getTime() - TEN_MINUTES_MS - 1),
    );
    writeFileSync(join(lockPath, '.recovery-takeover'), '{broken', 'utf8');

    expect(
      acquireWeatherWarningDeliveryLease({ explicitPath, now }),
    ).toBeNull();
    expect(readFileSync(join(lockPath, '.recovery-takeover'), 'utf8')).toBe(
      '{broken',
    );
  });

  it('fails closed for a corrupt recovery fence instead of deleting it', () => {
    const explicitPath = join(root, 'corrupt-recovery', STATE_FILE_NAME);
    const lockPath = `${explicitPath}.lock`;
    const now = new Date('2026-08-03T08:10:00.000Z');
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeLeaseFence(
      join(lockPath, 'owner-corrupt-recovery.lease'),
      leaseToken(92_400, 400),
      new Date(now.getTime() - 2 * TEN_MINUTES_MS),
    );
    writeFileSync(join(lockPath, '.recovery'), '{broken', 'utf8');

    expect(
      acquireWeatherWarningDeliveryLease({
        explicitPath,
        now,
      }),
    ).toBeNull();
    expect(readFileSync(join(lockPath, '.recovery'), 'utf8')).toBe('{broken');
  });

  it('treats a sidecar lock exactly ten minutes old as active and reclaims it only after the boundary', () => {
    const explicitPath = join(root, 'boundary', STATE_FILE_NAME);
    const lockPath = `${explicitPath}.lock`;
    const acquiredAt = new Date('2026-08-03T08:00:00.000Z');
    const deadPid = 92_500;
    const restoreProcessProbe = mockProcessLiveness({ [deadPid]: 'dead' });
    mkdirSync(dirname(lockPath), { recursive: true });
    mkdirSync(lockPath);
    writeLeaseFence(
      join(lockPath, 'owner-boundary.lease'),
      leaseToken(deadPid, 500),
      acquiredAt,
    );

    try {
      expect(
        acquireWeatherWarningDeliveryLease({
          explicitPath,
          now: new Date(acquiredAt.getTime() + TEN_MINUTES_MS),
        }),
      ).toBeNull();

      const reclaimed = acquireWeatherWarningDeliveryLease({
        explicitPath,
        now: new Date(acquiredAt.getTime() + TEN_MINUTES_MS + 1),
      });
      expect(reclaimed).not.toBeNull();
      reclaimed?.release();
    } finally {
      restoreProcessProbe();
    }
  });

  it('keeps a replacement lease intact when the old owner releases during replacement', () => {
    const explicitPath = join(root, 'safe-release', STATE_FILE_NAME);
    const lockPath = `${explicitPath}.lock`;
    const originalFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    let stateStore: WeatherWarningDeliveryStateStoreModule | undefined;
    let replaced = false;

    jest.resetModules();
    jest.doMock('node:fs', () => ({
      ...originalFs,
      readFileSync: (...args: Parameters<typeof originalFs.readFileSync>) => {
        const result = originalFs.readFileSync(...args);
        if (
          !replaced &&
          typeof args[0] === 'string' &&
          args[0].startsWith(lockPath)
        ) {
          replaced = true;
          originalFs.renameSync(lockPath, `${lockPath}.replaced`);
          originalFs.mkdirSync(lockPath);
          originalFs.writeFileSync(
            join(lockPath, 'owner-replacement.lease'),
            '{"token":"replacement-owner"}\n',
            'utf8',
          );
        }
        return result;
      },
    }));

    try {
      jest.isolateModules(() => {
        stateStore =
          require('../../server/modules/weather-warning/weather-warning-delivery-state-store') as WeatherWarningDeliveryStateStoreModule;
      });
      const oldLease = stateStore.acquireWeatherWarningDeliveryLease({
        explicitPath,
      });

      expect(oldLease).not.toBeNull();
      expect(() => oldLease?.release()).not.toThrow();
      expect(replaced).toBe(true);
      expect(existsSync(lockPath)).toBe(true);
      expect(readdirSync(lockPath)).toContain('owner-replacement.lease');
      expect(
        stateStore.acquireWeatherWarningDeliveryLease({ explicitPath }),
      ).toBeNull();
    } finally {
      jest.dontMock('node:fs');
      jest.resetModules();
    }
  });

  it('does not publish an unmarked lock directory during initial acquisition', () => {
    const explicitPath = join(
      root,
      'atomic-lease-publication',
      STATE_FILE_NAME,
    );
    const lockPath = `${explicitPath}.lock`;
    const originalFs = jest.requireActual<typeof import('node:fs')>('node:fs');
    let stateStore: WeatherWarningDeliveryStateStoreModule | undefined;
    let replacementPublished = false;

    jest.resetModules();
    jest.doMock('node:fs', () => ({
      ...originalFs,
      renameSync: (...args: Parameters<typeof originalFs.renameSync>) => {
        if (
          !replacementPublished &&
          typeof args[0] === 'string' &&
          args[0].startsWith(`${lockPath}.pending.`) &&
          args[1] === lockPath
        ) {
          replacementPublished = true;
          originalFs.mkdirSync(lockPath, { recursive: true });
          originalFs.writeFileSync(
            join(lockPath, 'owner-replacement.lease'),
            '{"token":"replacement-owner"}\n',
            'utf8',
          );
        }
        return originalFs.renameSync(...args);
      },
    }));

    try {
      jest.isolateModules(() => {
        stateStore =
          require('../../server/modules/weather-warning/weather-warning-delivery-state-store') as WeatherWarningDeliveryStateStoreModule;
      });

      expect(
        stateStore.acquireWeatherWarningDeliveryLease({ explicitPath }),
      ).toBeNull();
      expect(replacementPublished).toBe(true);
      expect(readdirSync(lockPath)).toContain('owner-replacement.lease');
      expect(readdirSync(dirname(lockPath))).not.toContainEqual(
        expect.stringMatching(
          /^weather-warning-delivery-state\.json\.lock\.pending\./u,
        ),
      );
    } finally {
      jest.dontMock('node:fs');
      jest.resetModules();
    }
  });
});
