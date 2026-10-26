import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyOvertimeRequestSubmissionError,
  clearOvertimeRequestRecoveryCredential,
  coordinateOvertimeRequestPreparation,
  createOvertimeRequestSnapshotDigest,
  createOvertimeRequestPreparationLifecycle,
  createOvertimeRequestSubmissionSequence,
  createShanghaiOvertimeDateTime,
  createOvertimeDefaultRange,
  getOvertimeHistoryEarliestDate,
  getShanghaiTodayDate,
  isOvertimeRangeSelectable,
  isOvertimeScheduleRangeCovered,
  listOvertimeHistoryScheduleCoverageDates,
  listOvertimeEndDates,
  listOvertimeEndTimes,
  listOvertimeScheduleDates,
  markOvertimeRequestMutationFailure,
  persistOvertimeRequestRecoveryCredential,
  readOvertimeRequestRecoveryCredential,
  reconcileOvertimeRangeAfterStartChange,
  reconcileOvertimeRangeWithAvailability,
  resolveOvertimeAuthoritativeImpactAfterSchedulesChange,
  resolveOvertimeRequestMutationBinding,
  resolveOvertimeRequestSuccessResponse,
} from '../../client/src/pages/MonthlySchedule/overtime-request-submit';
import { getShanghaiBusinessDateKey } from '../../client/src/pages/MonthlySchedule/business-date';
import {
  normalizeLeaveRequestClipboardImage,
  normalizeRequestClipboardImageWithStableName,
} from '../../client/src/pages/MonthlySchedule/leave-request-screenshot';
import type { OvertimeRequestImpact } from '../../shared/overtime-request-impact';

function createImpact(
  overrides: Partial<OvertimeRequestImpact> = {},
): OvertimeRequestImpact {
  return {
    rawHours: 2,
    payableHours: 2,
    conflictingSchedules: [],
    isWholeHour: true,
    invalidRangeReason: null,
    canSubmit: true,
    ...overrides,
  };
}

function createSnapshot() {
  return {
    staffName: '示例人员020',
    startAt: '2026-08-10T19:00:00+08:00',
    endAt: '2026-08-10T21:00:00+08:00',
    reason: '设备应急处置',
    expectedImpact: createImpact(),
    screenshot: Object.freeze({ name: 'overtime.png' }) as unknown as File,
  };
}

const SNAPSHOT_DIGEST = `sha256:${'a'.repeat(64)}`;

function createStorage(initialValues: Record<string, string> = {}) {
  const values = new Map(Object.entries(initialValues));
  return {
    getItem: jest.fn((key: string) => values.get(key) ?? null),
    setItem: jest.fn((key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: jest.fn((key: string) => {
      values.delete(key);
    }),
    value: (key: string) => values.get(key) ?? null,
  };
}

describe('monthly schedule overtime request', () => {
  it('keeps an isolated v2 recovery credential without storing draft plaintext', () => {
    const storage = createStorage();
    const snapshot = createSnapshot();
    const resolution = resolveOvertimeRequestMutationBinding(
      null,
      snapshot,
      SNAPSHOT_DIGEST,
      () => 'overtime-request-unit-1',
    );

    expect(resolution.status).toBe('ready');
    if (resolution.status !== 'ready') throw new Error('expected ready');
    expect(Object.isFrozen(resolution.binding.snapshot)).toBe(true);
    expect(resolution.binding.clientMutationId).toBe('overtime-request-unit-1');
    expect(resolution.binding.snapshotDigest).toBe(SNAPSHOT_DIGEST);
    expect(
      persistOvertimeRequestRecoveryCredential(storage, {
        clientMutationId: resolution.binding.clientMutationId,
        snapshotDigest: resolution.binding.snapshotDigest,
      }),
    ).toBe(true);
    expect(storage.setItem).toHaveBeenCalledWith(
      'monthly-schedule.overtime-request.recovery.v2',
      JSON.stringify({
        clientMutationId: 'overtime-request-unit-1',
        snapshotDigest: SNAPSHOT_DIGEST,
      }),
    );
    const persisted = storage.value(
      'monthly-schedule.overtime-request.recovery.v2',
    );
    expect(persisted).not.toContain(snapshot.staffName);
    expect(persisted).not.toContain(snapshot.reason);
    expect(persisted).not.toContain(snapshot.startAt);
    expect(persisted).not.toContain('overtime.png');
    expect(readOvertimeRequestRecoveryCredential(storage)).toEqual({
      clientMutationId: 'overtime-request-unit-1',
      snapshotDigest: SNAPSHOT_DIGEST,
    });
    expect(clearOvertimeRequestRecoveryCredential(storage)).toBe(true);
    expect(
      storage.value('monthly-schedule.overtime-request.recovery.v2'),
    ).toBeNull();

    expect(
      persistOvertimeRequestRecoveryCredential(storage, {
        clientMutationId: 'leave-request-must-not-cross-contaminate',
        snapshotDigest: SNAPSHOT_DIGEST,
      }),
    ).toBe(false);
  });

  it('ignores the legacy v1 id instead of binding arbitrary new content to it', () => {
    const storage = createStorage({
      'monthly-schedule.overtime-request.unknown-mutation-id.v1':
        'overtime-request-legacy-1',
    });

    expect(readOvertimeRequestRecoveryCredential(storage)).toBeNull();
  });

  it('locks unknown results to the original id and exact frozen content', () => {
    const snapshot = createSnapshot();
    const initial = resolveOvertimeRequestMutationBinding(
      null,
      snapshot,
      SNAPSHOT_DIGEST,
      () => 'overtime-request-unknown-1',
    );
    if (initial.status !== 'ready') throw new Error('expected ready');

    const failed = markOvertimeRequestMutationFailure(initial.binding, {
      code: 'ETIMEDOUT',
      request: {},
    });
    expect(failed.state).toBe('unknown-result');
    const sameRetry = resolveOvertimeRequestMutationBinding(
      failed,
      snapshot,
      SNAPSHOT_DIGEST,
      () => 'must-not-create',
    );
    expect(sameRetry.status).toBe('ready');
    if (sameRetry.status !== 'ready') throw new Error('expected ready retry');
    expect(sameRetry.binding.clientMutationId).toBe(
      'overtime-request-unknown-1',
    );

    const changed = resolveOvertimeRequestMutationBinding(
      failed,
      { ...snapshot, reason: '已经改变的原因' },
      `sha256:${'b'.repeat(64)}`,
      () => 'must-not-create',
    );
    expect(changed.status).toBe('blocked');
    expect(classifyOvertimeRequestSubmissionError({ status: 502 })).toBe(
      'unknown-result',
    );
    expect(
      classifyOvertimeRequestSubmissionError({
        response: {
          status: 409,
          data: { writeDisposition: 'definitely-not-written' },
        },
      }),
    ).toBe('definitely-not-written');
  });

  it('strictly validates success identity and rejects stale/malformed responses', () => {
    const draft = {
      clientMutationId: 'overtime-request-response-1',
      expectedImpact: createImpact(),
    };
    const validResponse = {
      success: true,
      created: 1,
      recordId: 'rec-overtime-1',
      clientMutationId: draft.clientMutationId,
      requestFingerprint: 'fingerprint-1',
      impact: createImpact(),
      message: 'ok',
    };

    expect(resolveOvertimeRequestSuccessResponse(validResponse, draft)).toEqual(
      validResponse,
    );
    expect(() =>
      resolveOvertimeRequestSuccessResponse(
        { ...validResponse, clientMutationId: 'overtime-request-stale' },
        draft,
      ),
    ).toThrow(/当前请求不一致/);
    expect(() =>
      resolveOvertimeRequestSuccessResponse(
        { ...validResponse, impact: createImpact({ payableHours: 3 }) },
        draft,
      ),
    ).toThrow(/当前请求不一致/);
    expect(() =>
      resolveOvertimeRequestSuccessResponse(
        { ...validResponse, requestFingerprint: '' },
        draft,
      ),
    ).toThrow(/格式异常/);
    expect(() =>
      resolveOvertimeRequestSuccessResponse(
        { ...validResponse, message: '' },
        draft,
      ),
    ).toThrow(/格式异常/);
  });

  it('guards state changes from stale submission sequences', () => {
    const sequence = createOvertimeRequestSubmissionSequence();
    const first = sequence.next();
    expect(sequence.isCurrent(first)).toBe(true);
    const second = sequence.next();
    expect(sequence.isCurrent(first)).toBe(false);
    expect(sequence.isCurrent(second)).toBe(true);
    sequence.invalidate();
    expect(sequence.isCurrent(second)).toBe(false);
  });

  it('derives cached dates from the last 30 days and keeps the default in the present', () => {
    const schedules = [
      { scheduleDate: '2026-07-08' },
      { scheduleDate: '2026-07-09' },
      { scheduleDate: '2026-08-08' },
      { scheduleDate: '2026-08-09' },
      { scheduleDate: '2026-08-09' },
    ];
    expect(listOvertimeScheduleDates(schedules, '2026-08-08')).toEqual([
      '2026-07-09',
      '2026-08-08',
      '2026-08-09',
    ]);
    expect(getOvertimeHistoryEarliestDate('2026-08-08')).toBe('2026-07-09');
    expect(listOvertimeHistoryScheduleCoverageDates('2026-03-01')).toEqual(
      expect.arrayContaining(['2026-01-29', '2026-02-01', '2026-03-01']),
    );
    expect(
      createOvertimeDefaultRange(
        ['2026-08-08', '2026-08-09'],
        new Date('2026-08-08T02:25:00.000Z'),
      ),
    ).toEqual({
      startDate: '2026-08-08',
      startTime: '11:00',
      endDate: '2026-08-08',
      endTime: '12:00',
    });
    expect(createShanghaiOvertimeDateTime('2026-08-08', '11:00')).toBe(
      '2026-08-08T11:00:00+08:00',
    );
    expect(createShanghaiOvertimeDateTime('2026-08-08', '11:30')).toBeNull();
  });

  it('uses the Shanghai business-date boundary for overtime today', () => {
    expect(
      getShanghaiBusinessDateKey(new Date('2026-08-29T15:59:59.999Z')),
    ).toBe('2026-08-29');
    expect(getShanghaiBusinessDateKey(Date.parse('2026-08-29T16:00:00Z'))).toBe(
      '2026-08-30',
    );
    expect(getShanghaiTodayDate(new Date('2026-08-29T16:00:00Z'))).toBe(
      '2026-08-30',
    );

    const submitSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/overtime-request-submit.ts',
      ),
      'utf8',
    );
    const helperStart = submitSource.indexOf(
      'export function getShanghaiTodayDate',
    );
    const helperEnd = submitSource.indexOf(
      'export function createOvertimeDefaultRange',
      helperStart,
    );
    const helperSource = submitSource.slice(helperStart, helperEnd);

    expect(submitSource).toContain("from './business-date'");
    expect(helperSource).toContain('getShanghaiBusinessDateKey(now)');
  });

  it('defaults to Shanghai today or the next legal day and preserves a valid manual range', () => {
    const now = new Date('2026-08-08T02:25:00.000Z');
    expect(
      createOvertimeDefaultRange(['2026-08-08', '2026-08-09'], now),
    ).toEqual({
      startDate: '2026-08-08',
      startTime: '11:00',
      endDate: '2026-08-08',
      endTime: '12:00',
    });
    expect(createOvertimeDefaultRange(['2026-08-10'], now)).toEqual({
      startDate: '2026-08-10',
      startTime: '00:00',
      endDate: '2026-08-10',
      endTime: '01:00',
    });

    const manualRange = {
      startDate: '2026-08-08',
      startTime: '13:00',
      endDate: '2026-08-08',
      endTime: '14:00',
    };
    expect(
      reconcileOvertimeRangeWithAvailability(
        ['2026-08-08', '2026-08-09'],
        manualRange,
        now,
      ),
    ).toBe(manualRange);
  });

  it('refreshes overtime availability while open and never rebuilds a locked recovery draft', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/OvertimeRequestDialog.tsx',
      ),
      'utf8',
    );
    const clockEffectStart = source.indexOf(
      'useEffect(() => {\n    if (!open) return undefined;',
    );
    const clockEffectEnd = source.indexOf(
      '\n\n  const uniqueProfiles',
      clockEffectStart,
    );
    const clockEffect = source.slice(clockEffectStart, clockEffectEnd);
    const reconcileEffectStart = source.indexOf(
      'useEffect(() => {\n    if (!open || isLocked) return;',
    );
    const reconcileEffectEnd = source.indexOf(
      '\n\n  const invalidateSubmissionPreparation',
      reconcileEffectStart,
    );
    const reconcileEffect = source.slice(
      reconcileEffectStart,
      reconcileEffectEnd,
    );

    expect(clockEffectStart).toBeGreaterThan(-1);
    expect(clockEffect).toContain('setRangeClockMs(Date.now())');
    expect(clockEffect).toContain('}, 60_000)');
    expect(clockEffect).toContain('window.clearInterval(intervalId)');
    expect(clockEffect).toContain('}, [open])');
    expect(reconcileEffectStart).toBeGreaterThan(-1);
    expect(reconcileEffect).toContain(
      'reconcileOvertimeRangeWithAvailability(',
    );
    expect(reconcileEffect).toContain('new Date(rangeClockMs)');
    expect(reconcileEffect).toContain(
      '[availableDates, isLocked, open, rangeClockMs, recoveryState]',
    );
  });

  it('does not fall back to a past cached date after the last available day', () => {
    expect(
      createOvertimeDefaultRange(
        ['2026-08-08'],
        new Date('2026-08-08T15:30:00.000Z'),
      ),
    ).toEqual({ startDate: '', startTime: '', endDate: '', endTime: '' });
  });

  it('uses the next cached day when rounding crosses midnight', () => {
    expect(
      createOvertimeDefaultRange(
        ['2026-08-08', '2026-08-09'],
        new Date('2026-08-08T15:30:00.000Z'),
      ),
    ).toEqual({
      startDate: '2026-08-09',
      startTime: '00:00',
      endDate: '2026-08-09',
      endTime: '01:00',
    });
  });

  it('keeps an already exact Shanghai hour instead of rounding it again', () => {
    expect(
      createOvertimeDefaultRange(
        ['2026-08-08'],
        new Date('2026-08-08T02:00:00.000Z'),
      ),
    ).toEqual({
      startDate: '2026-08-08',
      startTime: '10:00',
      endDate: '2026-08-08',
      endTime: '11:00',
    });
  });

  it('syncs the end date when the start date changes', () => {
    expect(
      reconcileOvertimeRangeAfterStartChange(
        {
          startDate: '2026-08-10',
          startTime: '09:00',
          endDate: '2026-08-12',
          endTime: '12:00',
        },
        { startDate: '2026-08-11' },
      ),
    ).toEqual({
      startDate: '2026-08-11',
      startTime: '09:00',
      endDate: '2026-08-11',
      endTime: '12:00',
    });
  });

  it('keeps a valid same-day end time after a start change', () => {
    expect(
      reconcileOvertimeRangeAfterStartChange(
        {
          startDate: '2026-08-10',
          startTime: '09:00',
          endDate: '2026-08-10',
          endTime: '12:00',
        },
        { startTime: '10:00' },
      ).endTime,
    ).toBe('12:00');
  });

  it('moves an invalid same-day end time to the next whole hour', () => {
    expect(
      reconcileOvertimeRangeAfterStartChange(
        {
          startDate: '2026-08-10',
          startTime: '09:00',
          endDate: '2026-08-10',
          endTime: '10:00',
        },
        { startTime: '10:00' },
      ).endTime,
    ).toBe('11:00');
  });

  it('clears a same-day end time after selecting 23:00', () => {
    expect(
      reconcileOvertimeRangeAfterStartChange(
        {
          startDate: '2026-08-10',
          startTime: '22:00',
          endDate: '2026-08-10',
          endTime: '23:00',
        },
        { startTime: '23:00' },
      ).endTime,
    ).toBe('');
  });

  it('does not force a cross-day end date back when only start time changes', () => {
    expect(
      reconcileOvertimeRangeAfterStartChange(
        {
          startDate: '2026-08-10',
          startTime: '22:00',
          endDate: '2026-08-11',
          endTime: '01:00',
        },
        { startTime: '23:00' },
      ),
    ).toEqual({
      startDate: '2026-08-10',
      startTime: '23:00',
      endDate: '2026-08-11',
      endTime: '01:00',
    });
  });

  it('lists only valid end dates on or after the start date', () => {
    expect(
      listOvertimeEndDates(
        ['2026-08-12', 'invalid', '2026-08-10', '2026-08-11'],
        '2026-08-11',
      ),
    ).toEqual(['2026-08-11', '2026-08-12']);
  });

  it('lists only end times after the start time on the same date', () => {
    expect(
      listOvertimeEndTimes(
        ['09:00', '10:00', '11:00'],
        '2026-08-10',
        '10:00',
        '2026-08-10',
      ),
    ).toEqual(['11:00']);
  });

  it('keeps every end time for a later end date', () => {
    expect(
      listOvertimeEndTimes(
        ['00:00', '10:00', '23:00'],
        '2026-08-10',
        '23:00',
        '2026-08-11',
      ),
    ).toEqual(['00:00', '10:00', '23:00']);
  });

  it('digests all fields and actual screenshot bytes for safe refresh recovery', async () => {
    const firstScreenshot = new File(
      [new Uint8Array([1, 2, 3, 4])],
      'same.png',
      {
        type: 'image/png',
      },
    );
    const retryScreenshot = new File(
      [new Uint8Array([1, 2, 3, 4])],
      'same.png',
      {
        type: 'image/png',
      },
    );
    const differentScreenshot = new File(
      [new Uint8Array([4, 3, 2, 1])],
      'same.png',
      { type: 'image/png' },
    );
    const snapshot = { ...createSnapshot(), screenshot: firstScreenshot };
    const sameContentSnapshot = {
      ...snapshot,
      screenshot: retryScreenshot,
    };

    const digest = await createOvertimeRequestSnapshotDigest(snapshot);
    const sameDigest =
      await createOvertimeRequestSnapshotDigest(sameContentSnapshot);
    const changedReasonDigest = await createOvertimeRequestSnapshotDigest({
      ...snapshot,
      reason: `${snapshot.reason}-改变`,
    });
    const changedStaffDigest = await createOvertimeRequestSnapshotDigest({
      ...snapshot,
      staffName: `${snapshot.staffName}-改变`,
    });
    const changedStartDigest = await createOvertimeRequestSnapshotDigest({
      ...snapshot,
      startAt: '2026-08-10T20:00:00+08:00',
    });
    const changedEndDigest = await createOvertimeRequestSnapshotDigest({
      ...snapshot,
      endAt: '2026-08-10T22:00:00+08:00',
    });
    const changedImpactDigest = await createOvertimeRequestSnapshotDigest({
      ...snapshot,
      expectedImpact: createImpact({ rawHours: 3, payableHours: 3 }),
    });
    const changedImageDigest = await createOvertimeRequestSnapshotDigest({
      ...snapshot,
      screenshot: differentScreenshot,
    });
    const changedTypeDigest = await createOvertimeRequestSnapshotDigest({
      ...snapshot,
      screenshot: new File([new Uint8Array([1, 2, 3, 4])], 'same.png', {
        type: 'image/webp',
      }),
    });

    expect(digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(sameDigest).toBe(digest);
    expect(changedReasonDigest).not.toBe(digest);
    expect(changedStaffDigest).not.toBe(digest);
    expect(changedStartDigest).not.toBe(digest);
    expect(changedEndDigest).not.toBe(digest);
    expect(changedImpactDigest).not.toBe(digest);
    expect(changedImageDigest).not.toBe(digest);
    expect(changedTypeDigest).not.toBe(digest);
  });

  it('reads the same screenshot bytes only once while digesting repeated snapshots', async () => {
    const screenshot = new File([new Uint8Array([9, 8, 7, 6])], 'cached.png', {
      type: 'image/png',
    });
    const arrayBufferSpy = jest.spyOn(screenshot, 'arrayBuffer');
    const snapshot = { ...createSnapshot(), screenshot };

    const [firstDigest, secondDigest] = await Promise.all([
      createOvertimeRequestSnapshotDigest(snapshot),
      createOvertimeRequestSnapshotDigest(snapshot),
    ]);

    expect(firstDigest).toBe(secondDigest);
    expect(arrayBufferSpy).toHaveBeenCalledTimes(1);
  });

  it('does nothing after a pending digest is invalidated by unmount', async () => {
    let resolveDigest: (value: string) => void = () => undefined;
    const digest = new Promise<string>((resolve) => {
      resolveDigest = resolve;
    });
    const lifecycle = createOvertimeRequestPreparationLifecycle();
    const persist = jest.fn(() => true);
    const startNetwork = jest.fn();
    const stateEffect = jest.fn();

    const execution = coordinateOvertimeRequestPreparation({
      lifecycle,
      prepare: () => digest,
      persist,
      commit: (value) => {
        startNetwork(value);
        stateEffect('commit');
      },
      onPersistFailure: () => stateEffect('persist-failure'),
      onSettled: () => stateEffect('settled'),
    });
    lifecycle.invalidate();
    resolveDigest(SNAPSHOT_DIGEST);

    await expect(execution).resolves.toBe('cancelled');
    expect(persist).not.toHaveBeenCalled();
    expect(startNetwork).not.toHaveBeenCalled();
    expect(stateEffect).not.toHaveBeenCalled();
  });

  it('requires continuous cache coverage from the day before start through end', () => {
    const completeDates = [
      { scheduleDate: '2026-08-09' },
      { scheduleDate: '2026-08-10' },
      { scheduleDate: '2026-08-11' },
      { scheduleDate: '2026-08-12' },
    ];

    expect(
      isOvertimeScheduleRangeCovered(
        completeDates.slice(1),
        '2026-08-10',
        '2026-08-10',
      ),
    ).toBe(false);
    expect(
      isOvertimeScheduleRangeCovered(
        completeDates.filter((item) => item.scheduleDate !== '2026-08-11'),
        '2026-08-10',
        '2026-08-12',
      ),
    ).toBe(false);
    expect(
      isOvertimeScheduleRangeCovered(completeDates, '2026-08-10', '2026-08-12'),
    ).toBe(true);
  });

  it('drops stale authoritative impact for editable refreshes but keeps unknown snapshots', () => {
    const staleImpact = createImpact({ payableHours: 9 });

    expect(
      resolveOvertimeAuthoritativeImpactAfterSchedulesChange(
        staleImpact,
        'editable-error',
      ),
    ).toBeNull();
    expect(
      resolveOvertimeAuthoritativeImpactAfterSchedulesChange(
        staleImpact,
        'unknown-result',
      ),
    ).toBe(staleImpact);
  });

  it('accepts the exact 30-day history boundary and rejects day 31 or unavailable values', () => {
    const now = new Date('2026-08-09T16:30:00.000Z');
    expect(
      isOvertimeRangeSelectable(
        ['2026-07-11', '2026-08-10'],
        {
          startDate: '2026-07-11',
          startTime: '19:00',
          endDate: '2026-07-11',
          endTime: '21:00',
        },
        now,
      ),
    ).toBe(true);
    expect(
      isOvertimeRangeSelectable(
        ['2026-07-10'],
        {
          startDate: '2026-07-10',
          startTime: '19:00',
          endDate: '2026-07-10',
          endTime: '21:00',
        },
        now,
      ),
    ).toBe(false);
    expect(
      isOvertimeRangeSelectable(
        ['2026-08-10'],
        {
          startDate: '2026-08-09',
          startTime: '23:00',
          endDate: '2026-08-10',
          endTime: '01:00',
        },
        now,
      ),
    ).toBe(false);
    expect(
      isOvertimeRangeSelectable(
        ['2026-08-10'],
        {
          startDate: '2026-08-10',
          startTime: '01:00',
          endDate: '2026-08-10',
          endTime: '02:00',
        },
        now,
      ),
    ).toBe(true);
    expect(
      reconcileOvertimeRangeWithAvailability(
        ['2026-08-10'],
        {
          startDate: '2026-08-11',
          startTime: '09:00',
          endDate: '2026-08-11',
          endTime: '10:00',
        },
        now,
      ),
    ).toEqual({
      startDate: '2026-08-10',
      startTime: '01:00',
      endDate: '2026-08-10',
      endTime: '02:00',
    });
  });

  it('adds overtime immediately after leave and passes only existing caches', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const leaveIndex = source.indexOf('请休假');
    const overtimeIndex = source.indexOf('加班申请', leaveIndex + 1);

    expect(source).not.toContain(
      "import { OvertimeRequestDialog } from './OvertimeRequestDialog'",
    );
    expect(source).toContain('const LazyOvertimeRequestDialog = React.lazy');
    expect(source).toContain("import('./OvertimeRequestDialog')");
    expect(source).toContain('<React.Suspense');
    expect(source).toContain('正在打开加班申请...');
    expect(source).not.toContain('正在打开加班...');
    expect(source).toContain('const OvertimeRequestDialogHost = React.memo');
    expect(leaveIndex).toBeGreaterThan(-1);
    expect(overtimeIndex).toBeGreaterThan(leaveIndex);
    expect(source.slice(leaveIndex, overtimeIndex + 100)).toContain(
      'overtimeRequestDialogRef.current?.open()',
    );
    expect(source).toContain('<OvertimeRequestDialogHost');
    expect(source).toContain('ref={overtimeRequestDialogRef}');
    expect(source).toContain('personProfiles={personProfiles}');
    expect(source).toContain('schedules={schedules}');
    expect(source).toContain(
      'ensureSchedulesForDateRange={ensureSchedulesForLeaveDateRange}',
    );
    expect(source).toContain('canUseSelfServiceTools={canUseSelfServiceTools}');
    expect(source.slice(leaveIndex, overtimeIndex + 100)).toMatch(
      />\s*加班申请\s*</,
    );
    expect(
      source.match(/\n\s+加班申请\r?\n/g)?.length || 0,
    ).toBeGreaterThanOrEqual(2);
  });

  it('loads the 30-day schedule history in the background with a retryable status', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/OvertimeRequestDialog.tsx',
      ),
      'utf8',
    );

    expect(source).toContain('ensureSchedulesForDateRange');
    expect(source).toContain('listOvertimeHistoryScheduleCoverageDates');
    expect(source).toContain("setHistoryScheduleLoadStatus('loading')");
    expect(source).toContain('重新加载');
  });

  it('preloads the overtime dialog while idle and retries a failed chunk load', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );

    expect(source).toMatch(
      /let\s+overtimeRequestDialogModulePromise:\s*Promise<OvertimeRequestDialogModule>\s*\|\s*null\s*=\s*null/,
    );
    expect(source).toContain('function loadOvertimeRequestDialogModule()');
    expect(source).toContain('overtimeRequestDialogModulePromise = null');
    expect(source).toContain('requestIdleCallback');
    expect(source).toContain('cancelIdleCallback');
    expect(source).toContain(
      '<OvertimeRequestDialogPreloader onReady={markPrewarmed} />',
    );
    expect(source).toContain('await loadOvertimeRequestDialogModule()');
    expect(source).toMatch(
      /const\s*\[prewarmed,\s*setPrewarmed\]\s*=\s*useState\(false\)/,
    );
    expect(source).toContain('open || backgroundSyncing || prewarmed');
  });

  it('isolates overtime dialog state from the monthly schedule page render', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const hostStart = source.indexOf(
      'interface OvertimeRequestDialogHostHandle',
    );
    const pageStart = source.indexOf('function MonthlySchedulePageContent()');
    const hostSource = source.slice(hostStart, pageStart);
    const pageSource = source.slice(pageStart);

    expect(hostStart).toBeGreaterThan(-1);
    expect(pageStart).toBeGreaterThan(hostStart);
    expect(hostSource).toMatch(
      /const OvertimeRequestDialogHost = React\.memo\(\s*React\.forwardRef/,
    );
    expect(hostSource).toMatch(/open:\s*\(\)\s*=>\s*void/);
    expect(hostSource).toMatch(/setOpen:\s*\(open:\s*boolean\)\s*=>\s*void/);
    expect(hostSource).toMatch(
      /const\s*\[open,\s*setOpen\]\s*=\s*useState\(false\)/,
    );
    expect(hostSource).toMatch(
      /const\s*\[\s*backgroundSyncing,\s*setBackgroundSyncing\s*\]\s*=\s*useState\(false\)/,
    );
    expect(hostSource).toMatch(
      /const openDialog = useCallback\([\s\S]*?if \(backgroundSyncing\) return;[\s\S]*?setOpen\(true\)/,
    );
    expect(hostSource).toContain('React.useImperativeHandle');
    expect(hostSource).toMatch(/open:\s*openDialog/);
    expect(hostSource).toMatch(/\bsetOpen,?\s*\}/);
    expect(hostSource).toMatch(/open\s*\|\|\s*backgroundSyncing/);
    expect(hostSource).toContain('<React.Suspense');
    expect(hostSource).toContain('加班申请');
    expect(hostSource).toContain('正在打开加班申请...');
    expect(hostSource).toContain('<LazyOvertimeRequestDialog');
    expect(hostSource).toContain('open={open}');
    expect(hostSource).toContain('onOpenChange={setOpen}');
    expect(hostSource).toContain(
      'onBackgroundSyncChange={setBackgroundSyncing}',
    );

    expect(pageSource).toMatch(
      /const\s+overtimeRequestDialogRef\s*=\s*useRef<OvertimeRequestDialogHostHandle>\(null\)/,
    );
    expect(pageSource).toContain('overtimeRequestDialogRef.current?.open()');
    expect(pageSource).toContain('<OvertimeRequestDialogHost');
    expect(pageSource).not.toContain('overtimeRequestDialogOpen');
    expect(pageSource).not.toContain('overtimeRequestBackgroundSyncing');
    expect(pageSource).not.toContain('setOvertimeRequestDialogOpen');
    expect(pageSource).not.toContain('setOvertimeRequestBackgroundSyncing');
  });

  it('uses the lightweight local portal modal so opening does not invalidate the full schedule page', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/OvertimeRequestDialog.tsx',
      ),
      'utf8',
    );

    expect(source).toContain(
      "import { createPortal, flushSync } from 'react-dom'",
    );
    expect(source).not.toContain("from '@/components/ui/dialog'");
    expect(source).toContain('return createPortal(');
    expect(source).toContain('role="dialog"');
    expect(source).toContain('aria-modal="true"');
    expect(source).toContain("event.key === 'Escape'");
    expect(source).toContain("event.key !== 'Tab'");
    expect(source).toContain("document.body.style.overflow = 'hidden'");
    expect(source).toContain('event.target !== event.currentTarget');
    expect(source).toContain('if (formBusy) return');
    expect(source).toContain('dialogRef.current');
    expect(source).toContain('querySelectorAll<HTMLElement>');
    expect(source).toContain('previouslyFocusedElementRef');
    expect(source).toContain('focus({ preventScroll: true })');
    expect(source).toContain('aria-label="关闭加班申请"');
    expect(source).not.toContain('document.body.style.pointerEvents');
    expect(source).not.toMatch(/setAttribute\([^)]*aria-hidden/);
  });

  it('cancels stale focus restoration before reopening the overtime dialog', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/OvertimeRequestDialog.tsx',
      ),
      'utf8',
    );

    expect(source).toContain('interface OvertimeRequestDialogFocusCoordinator');
    expect(source).toContain('focusCoordinator.restoreFrameRef.current');
    expect(source).toMatch(
      /window\.cancelAnimationFrame\(\s*focusCoordinator\.restoreFrameRef\.current\s*\)/,
    );
    expect(source).toContain('if (focusCoordinator.openRef.current) return;');
    expect(source).toContain('ref={closeButtonRef}');
    expect(source).toContain(
      'closeButtonRef.current?.focus({ preventScroll: true });',
    );
    const focusIndex = source.indexOf(
      'closeButtonRef.current?.focus({ preventScroll: true });',
    );
    const layoutEffectIndex = source.lastIndexOf(
      'useLayoutEffect(() => {',
      focusIndex,
    );
    expect(layoutEffectIndex).toBeGreaterThan(-1);
    expect(source.slice(layoutEffectIndex, focusIndex)).toContain(
      'if (!dialogVisible',
    );
    expect(source).toContain(
      'const focusFrame = window.requestAnimationFrame(() =>',
    );
    expect(source).toContain('window.cancelAnimationFrame(focusFrame);');
  });

  it('keeps disabled and visually hidden controls out of the overtime focus trap', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/OvertimeRequestDialog.tsx',
      ),
      'utf8',
    );

    expect(source).toContain("'button:not(:disabled)'");
    expect(source).toContain('\'input:not([type="file"]):not(:disabled)\'');
    expect(source).toContain("element.matches(':disabled')");
    expect(source).toContain('window.getComputedStyle(element)');
    expect(source).toContain('element.getClientRects().length > 0');
  });

  it('uses a lightweight portal shell while the overtime dialog chunk loads', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const fallbackStart = source.indexOf(
      'function OvertimeRequestDialogLoadingFallback',
    );
    const fallbackEnd = source.indexOf('const BUILDING_MAP', fallbackStart);
    const fallbackSource = source.slice(fallbackStart, fallbackEnd);

    expect(source).toContain(
      "import { createPortal, flushSync } from 'react-dom'",
    );
    expect(fallbackStart).toBeGreaterThan(-1);
    expect(fallbackEnd).toBeGreaterThan(fallbackStart);
    expect(fallbackSource).toContain('return createPortal(');
    expect(fallbackSource).toContain('role="dialog"');
    expect(fallbackSource).toContain('aria-modal="true"');
    expect(fallbackSource).toContain('加班申请');
    expect(fallbackSource).toContain('正在打开加班申请...');
    expect(fallbackSource).toContain("event.key === 'Escape'");
    expect(fallbackSource).toContain('event.target !== event.currentTarget');
    expect(fallbackSource).toContain('aria-label="关闭加班申请"');
    expect(fallbackSource).not.toContain('<Dialog');
    expect(fallbackSource).not.toContain('<DialogContent');
    expect(fallbackSource).toMatch(
      /fallback=\{[\s\S]*?<OvertimeRequestDialogLoadingFallback/,
    );
  });

  it('hands the trigger focus through the loading fallback to the formal dialog', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const fallbackStart = source.indexOf(
      'function OvertimeRequestDialogLoadingFallback',
    );
    const fallbackEnd = source.indexOf('const BUILDING_MAP', fallbackStart);
    const fallbackSource = source.slice(fallbackStart, fallbackEnd);
    const coordinatorPasses =
      fallbackSource.match(
        /focusCoordinator=\{focusCoordinatorRef\.current\}/g,
      ) || [];

    expect(fallbackSource).toContain(
      'const closeButtonRef = useRef<HTMLButtonElement>(null);',
    );
    expect(fallbackSource).toContain(
      'closeButtonRef.current?.focus({ preventScroll: true });',
    );
    expect(fallbackSource).toContain("if (event.key === 'Tab')");
    expect(fallbackSource).toContain(
      'focusCoordinator.returnElementRef.current',
    );
    expect(fallbackSource).toContain(
      'focusCoordinator.openRef.current = open;',
    );
    expect(fallbackSource).toContain(
      'scheduleOvertimeDialogFocusRestore(focusCoordinator);',
    );
    expect(coordinatorPasses).toHaveLength(2);
  });

  it('uses local cache only and does not expose private profile fields or storage copy', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/OvertimeRequestDialog.tsx',
      ),
      'utf8',
    );

    expect(source).toContain('calculateOvertimeRequestImpact');
    expect(source).toContain('staffShift: selectedProfile?.shift || null');
    expect(source).toContain('Boolean(selectedProfile?.shift?.trim())');
    expect(source).toContain('加班人员班次信息缺失，请先在人员表维护');
    expect(source).toContain('长白班工作日加班仅可选择 09:00 前或 18:00 后');
    expect(source).toContain(
      '所选加班与本人排班连续值守达到 24 小时，请缩短或调整时段',
    );
    expect(source).toContain('法定工作日历数据不完整，暂不能提交该时段');
    expect(source).toContain('reconcileOvertimeRangeAfterStartChange');
    expect(source).toContain('listOvertimeEndDates');
    expect(source).toContain('listOvertimeEndTimes');
    expect(source).toContain('personProfiles');
    expect(source).toContain('schedules');
    expect(source).not.toMatch(
      /getPersonProfiles|getMonthlySchedules|axios|fetch\s*\(/,
    );
    expect(source).not.toMatch(
      /phone|email|photoUrl|personProfileDetails|写入多维表|后台表/,
    );
    expect(source).toContain('加班工时：');
    expect(source).toContain('结束时间必须晚于开始时间');
    expect(source).toContain('请先切换到对应排班月份');
    expect(source).toContain('与本人正常排班冲突');
    expect(source).toContain('maxLength={2000}');
    expect(source).toContain('label="加班举证"');
    expect(source).toContain('inputId="overtime-evidence"');
    expect(source).toContain('active={open}');
    expect(source).toContain('onOpenChange(false)');
    expect(source).toContain('加班申请已受理，正在后台同步');
    expect(source).toContain('\n            加班申请\n');
    expect(source).toContain('待审批通过后生效');
    expect(source).not.toMatch(
      /setSchedules|onSchedulesChange|loadPersonProfiles/,
    );
  });

  it('shows missing shift guidance beside the selected staff card', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/OvertimeRequestDialog.tsx',
      ),
      'utf8',
    );
    const profileCardStart = source.indexOf('{selectedProfile && (');
    const timeFieldsStart = source.indexOf(
      '<div className="grid gap-4 sm:grid-cols-2">',
      profileCardStart,
    );
    const selectedProfileArea = source.slice(profileCardStart, timeFieldsStart);

    expect(profileCardStart).toBeGreaterThan(-1);
    expect(timeFieldsStart).toBeGreaterThan(profileCardStart);
    expect(selectedProfileArea).toMatch(
      /\{!selectedProfile\.shift\?\.trim\(\) && \([\s\S]*?role="alert"[\s\S]*?加班人员班次信息缺失，请先在人员表维护/,
    );
  });

  it('closes before the background request, deduplicates clicks, and restores failures', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/OvertimeRequestDialog.tsx',
      ),
      'utf8',
    );
    const handlerStart = source.indexOf('const handleSubmit = useCallback');
    const handlerEnd = source.indexOf('\n  return (', handlerStart);
    const handler = source.slice(handlerStart, handlerEnd);
    const closeIndex = handler.indexOf('onOpenChange(false)');
    const localCloseIndex = handler.indexOf('setOptimisticallyClosed(true)');
    const backgroundIndex = handler.indexOf('onBackgroundSyncChange(true)');
    const flushIndex = handler.indexOf('flushSync(() =>');
    const frameIndex = handler.indexOf('window.requestAnimationFrame');
    const scheduleIndex = handler.indexOf('window.setTimeout');
    const coordinateIndex = handler.indexOf(
      'coordinateOvertimeRequestPreparation',
    );
    const requestIndex = handler.indexOf('void createOvertimeRequest');
    const digestIndex = handler.indexOf('createOvertimeRequestSnapshotDigest');
    const persistIndex = handler.indexOf(
      'persistOvertimeRequestRecoveryCredential',
    );

    expect(handlerStart).toBeGreaterThan(-1);
    expect(handler).toContain('requestInFlightRef.current ||');
    expect(handler).toContain('submissionPreparationRef.current ||');
    expect(handler).toContain('requestInFlightRef.current = true');
    expect(handler).toContain('createOvertimeRequestSnapshotDigest');
    expect(handler).toContain('persistOvertimeRequestRecoveryCredential');
    expect(source).toContain(
      "import { createPortal, flushSync } from 'react-dom';",
    );
    expect(flushIndex).toBeGreaterThan(-1);
    expect(flushIndex).toBeLessThan(localCloseIndex);
    expect(localCloseIndex).toBeLessThan(frameIndex);
    expect(frameIndex).toBeLessThan(scheduleIndex);
    expect(scheduleIndex).toBeLessThan(backgroundIndex);
    expect(backgroundIndex).toBeGreaterThan(-1);
    expect(backgroundIndex).toBeLessThan(closeIndex);
    expect(closeIndex).toBeLessThan(coordinateIndex);
    expect(digestIndex).toBeGreaterThan(-1);
    expect(persistIndex).toBeGreaterThan(digestIndex);
    expect(closeIndex).toBeGreaterThan(-1);
    expect(closeIndex).toBeLessThan(digestIndex);
    expect(closeIndex).toBeLessThan(requestIndex);
    expect(handler).toContain('加班申请已受理，正在后台同步');
    expect(handler).toContain('加班申请提交失败，请稍后重试');
    expect(handler).toContain('onOpenChange(true)');
    expect(handler).toContain('markOvertimeRequestMutationFailure');
    expect(handler).toContain('getLatestOvertimeImpactFromError');
    expect(handler).not.toMatch(
      /getMonthlySchedules|setSchedules|提交中|Loader2/,
    );
    expect(handler).not.toContain("logger.error('提交加班失败', error)");
    expect(source).toMatch(
      /if \(\s*!nextOpen\s*&&\s*!submissionPreparationRef\.current\s*&&\s*!requestInFlightRef\.current\s*\)/,
    );
  });

  it('registers clipboard paste only while its screenshot field is active', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/LeaveRequestScreenshotField.tsx',
      ),
      'utf8',
    );

    expect(source).toContain('inputId?: string');
    expect(source).toContain('label?: string');
    expect(source).toContain('previewAlt?: string');
    expect(source).toContain('active?: boolean');
    expect(source).toMatch(/if \(!active \|\| disabled\) return undefined/);
    expect(source).toContain("window.addEventListener('paste', handlePaste)");
    expect(source).toContain(
      "window.removeEventListener('paste', handlePaste)",
    );
  });

  it('normalizes pasted overtime evidence to one name even when source names are safe', async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const firstPaste = new File([bytes], 'paste-1.png', {
      type: 'image/png',
      lastModified: 1_786_147_200_000,
    });
    const retryPaste = new File([bytes], 'paste-2.png', {
      type: 'image/png',
      lastModified: 1_786_147_260_000,
    });

    const firstNormalized = normalizeRequestClipboardImageWithStableName(
      firstPaste,
      'overtime-evidence',
    );
    const retryNormalized = normalizeRequestClipboardImageWithStableName(
      retryPaste,
      'overtime-evidence',
    );

    expect(firstNormalized.name).toBe('overtime-evidence.png');
    expect(retryNormalized.name).toBe(firstNormalized.name);
    expect(firstNormalized).not.toBe(firstPaste);
    expect(firstNormalized.type).toBe('image/png');
    expect(new Uint8Array(await firstNormalized.arrayBuffer())).toEqual(bytes);
    expect(new Uint8Array(await retryNormalized.arrayBuffer())).toEqual(bytes);

    const dialogSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/MonthlySchedule/OvertimeRequestDialog.tsx',
      ),
      'utf8',
    );
    expect(dialogSource).toContain('stableClipboardName="overtime-evidence"');
  });

  it.each([
    ['image/png', 'png'],
    ['image/jpeg', 'jpg'],
    ['image/webp', 'webp'],
  ])('uses a stable overtime paste name for %s', (type, extension) => {
    const source = new File([new Uint8Array([1])], `source-safe.${extension}`, {
      type,
    });
    expect(
      normalizeRequestClipboardImageWithStableName(source, 'overtime-evidence')
        .name,
    ).toBe(`overtime-evidence.${extension}`);
  });

  it('keeps the leave clipboard naming behavior unchanged', () => {
    const source = new File([new Uint8Array([1])], 'leave-safe.png', {
      type: 'image/png',
    });
    expect(normalizeLeaveRequestClipboardImage(source)).toBe(source);
  });

  it('posts one overtime screenshot and one JSON payload as multipart data', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );
    const start = source.indexOf('export async function createOvertimeRequest');
    const end = source.indexOf(
      'export async function createChangeRequest',
      start,
    );
    const block = source.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(block).toMatch(
      /payload:\s*OvertimeRequestCreateRequest,\s*screenshot:\s*File/,
    );
    expect(block).toContain(
      "formData.append('payload', JSON.stringify(payload))",
    );
    expect(block).toContain("formData.append('screenshot', screenshot)");
    expect(block).toContain("url: '/api/duty-schedules/overtime-request'");
    expect(block).toContain('timeout: 120000');
    expect(block).not.toContain("logger.error('提交加班失败', error)");
    expect(block).toContain('OVERTIME_REQUEST_TRANSPORT_FAILED');
  });
});
