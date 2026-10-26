import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireWeatherWarningAutomationLease,
  readWeatherWarningAutomationStateFile,
  resolveWeatherWarningAutomationStatePath,
  writeWeatherWarningAutomationStateFile,
} from '../../server/modules/weather-warning/weather-warning-automation-state-store';

describe('weather warning automation state store', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'weather-warning-automation-state-'));
  });

  afterEach(() => {
    if (root && existsSync(root))
      rmSync(root, { recursive: true, force: true });
  });

  it('uses an independent default file and restores hashed delivery state after restart', () => {
    const statePath = resolveWeatherWarningAutomationStatePath({ cwd: root });
    expect(statePath).toBe(
      join(root, 'data', 'weather-warning-automation-state.json'),
    );
    expect(readWeatherWarningAutomationStateFile({ cwd: root })).toEqual({
      version: 3,
      entries: {},
      eventSequence: 0,
      activeEvent: null,
      pendingResolvedEvents: {},
    });

    const deliveryKey =
      'auto:initial:event-0123456789abcdef:target-fedcba9876543210';
    writeWeatherWarningAutomationStateFile(
      {
        version: 3,
        entries: {
          [deliveryKey]: {
            clientMutationId: deliveryKey,
            messageId: 'om_automation_initial',
            sentAt: '2026-08-08T00:00:00.000Z',
            uuid: '0123456789abcdef0123456789abcdef',
            snapshotSignature: 'sha256:automation-snapshot',
          },
        },
        eventSequence: 1,
        activeEvent: {
          eventHash: '0123456789abcdef01234567',
          openedAt: '2026-08-08T00:00:00.000Z',
          guardLevel: '三级戒备',
          highestGuardLevel: '三级戒备',
          revision: 1,
          warningFingerprint:
            'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          firstNotifiedAt: '2026-08-08T00:00:05.000Z',
          primaryWarning: {
            id: 'typhoon-blue-20260808',
            title: '江苏省气象台发布台风蓝色预警',
            type: '台风',
            color: 'blue',
            startTime: '2026-08-07T23:30:00.000Z',
            pubTime: '2026-08-07T23:31:00.000Z',
          },
        },
        pendingResolvedEvents: {},
      },
      { cwd: root },
    );

    expect(readWeatherWarningAutomationStateFile({ cwd: root })).toEqual({
      version: 3,
      entries: {
        [deliveryKey]: expect.objectContaining({
          clientMutationId: deliveryKey,
          sentAt: '2026-08-08T00:00:00.000Z',
        }),
      },
      eventSequence: 1,
      activeEvent: expect.objectContaining({
        eventHash: '0123456789abcdef01234567',
        openedAt: '2026-08-08T00:00:00.000Z',
        highestGuardLevel: '三级戒备',
        revision: 1,
        firstNotifiedAt: '2026-08-08T00:00:05.000Z',
        primaryWarning: {
          id: 'typhoon-blue-20260808',
          title: '江苏省气象台发布台风蓝色预警',
          type: '台风',
          color: 'blue',
          startTime: '2026-08-07T23:30:00.000Z',
          pubTime: '2026-08-07T23:31:00.000Z',
        },
      }),
      pendingResolvedEvents: {},
    });
    const persisted = readFileSync(statePath, 'utf8');
    expect(persisted).toContain('event-0123456789abcdef');
    expect(persisted).toContain('target-fedcba9876543210');
    expect(persisted).not.toContain('oc_private_group');
    expect(persisted).not.toContain('ou_private_owner');
  });

  it('fails closed for unknown or invalid persisted warning-summary fields', () => {
    const statePath = resolveWeatherWarningAutomationStatePath({ cwd: root });
    mkdirSync(join(root, 'data'), { recursive: true });
    const baseEvent = {
      eventHash: '0123456789abcdef01234567',
      openedAt: '2026-08-08T00:00:00.000Z',
      guardLevel: '三级戒备',
      highestGuardLevel: '三级戒备',
      revision: 1,
      warningFingerprint:
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      primaryWarning: {
        id: 'typhoon-blue-20260808',
        title: '江苏省气象台发布台风蓝色预警',
        type: '台风',
        color: 'blue',
      },
    };

    for (const activeEvent of [
      {
        ...baseEvent,
        primaryWarning: { ...baseEvent.primaryWarning, secret: 'must-reject' },
      },
      {
        ...baseEvent,
        primaryWarning: {
          ...baseEvent.primaryWarning,
          startTime: 'not-a-timestamp',
        },
      },
      {
        ...baseEvent,
        primaryWarning: { ...baseEvent.primaryWarning, color: 'violet' },
      },
    ]) {
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 3,
          entries: {},
          eventSequence: 1,
          activeEvent,
          pendingResolvedEvents: {},
        }),
        'utf8',
      );
      expect(() =>
        readWeatherWarningAutomationStateFile({ cwd: root }),
      ).toThrow('天气预警自动化状态文件损坏');
    }
  });

  it('restores a pending resolved event without exposing recipient identifiers', () => {
    writeWeatherWarningAutomationStateFile(
      {
        version: 3,
        entries: {},
        eventSequence: 2,
        activeEvent: null,
        pendingResolvedEvents: {
          abcdef0123456789abcdef01: {
            eventHash: 'abcdef0123456789abcdef01',
            openedAt: '2026-08-08T00:00:00.000Z',
            closedAt: '2026-08-08T06:00:00.000Z',
            highestGuardLevel: '一级戒备',
            firstNotifiedAt: '2026-08-08T00:00:05.000Z',
            notifiedTargetHashes: ['fedcba9876543210'],
            primaryWarning: {
              id: 'typhoon-red-20260808',
              title: '江苏省气象台发布台风红色预警',
              type: '台风',
              color: 'red',
            },
          },
        },
      },
      { cwd: root },
    );

    expect(readWeatherWarningAutomationStateFile({ cwd: root })).toMatchObject({
      version: 3,
      eventSequence: 2,
      activeEvent: null,
      pendingResolvedEvents: {
        abcdef0123456789abcdef01: {
          closedAt: '2026-08-08T06:00:00.000Z',
          notifiedTargetHashes: ['fedcba9876543210'],
        },
      },
    });
    const persisted = readFileSync(
      resolveWeatherWarningAutomationStatePath({ cwd: root }),
      'utf8',
    );
    expect(persisted).not.toContain('oc_private_group');
    expect(persisted).not.toContain('ou_private_owner');
  });

  it('migrates the existing version-one delivery ledger without losing entries', () => {
    const statePath = resolveWeatherWarningAutomationStatePath({ cwd: root });
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      statePath,
      JSON.stringify({ version: 1, entries: {} }),
      'utf8',
    );

    expect(readWeatherWarningAutomationStateFile({ cwd: root })).toEqual({
      version: 3,
      entries: {},
      eventSequence: 0,
      activeEvent: null,
      pendingResolvedEvents: {},
    });
  });

  it('migrates an open version-two event but does not backfill an already closed event', () => {
    const statePath = resolveWeatherWarningAutomationStatePath({ cwd: root });
    mkdirSync(join(root, 'data'), { recursive: true });
    const event = {
      eventHash: '0123456789abcdef01234567',
      openedAt: '2026-08-08T00:00:00.000Z',
      guardLevel: '三级戒备',
      revision: 1,
      warningFingerprint:
        'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        entries: {},
        eventSequence: 1,
        activeEvent: event,
      }),
      'utf8',
    );
    expect(readWeatherWarningAutomationStateFile({ cwd: root })).toMatchObject({
      version: 3,
      activeEvent: {
        eventHash: event.eventHash,
        highestGuardLevel: '三级戒备',
      },
      pendingResolvedEvents: {},
    });

    writeFileSync(
      statePath,
      JSON.stringify({
        version: 2,
        entries: {},
        eventSequence: 1,
        activeEvent: {
          ...event,
          closedAt: '2026-08-08T01:00:00.000Z',
        },
      }),
      'utf8',
    );
    expect(readWeatherWarningAutomationStateFile({ cwd: root })).toMatchObject({
      version: 3,
      activeEvent: null,
      pendingResolvedEvents: {},
    });
  });

  it('serializes concurrent automation runs with the existing fenced lease', () => {
    const first = acquireWeatherWarningAutomationLease({ cwd: root });

    expect(first).not.toBeNull();
    expect(acquireWeatherWarningAutomationLease({ cwd: root })).toBeNull();

    first?.release();
    const afterRelease = acquireWeatherWarningAutomationLease({ cwd: root });
    expect(afterRelease).not.toBeNull();
    afterRelease?.release();
  });
});
