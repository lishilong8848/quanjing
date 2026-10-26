import * as fs from 'node:fs';
import * as path from 'node:path';
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import type {
  EmergencyDutyPersonOption,
  EmergencyDutySchedule,
} from '../../shared/emergency-duty.interface';
import { GlobalExceptionFilter } from '../../server/common/filters/exception.filter';
import { EmergencyDutyOptionList } from '../../client/src/pages/MonthlySchedule/emergency-duty-option-list';
import {
  beginEmergencyDutyMutation,
  buildEmergencyDutyIndex,
  classifyEmergencyDutyMutationError,
  formatEmergencyDutySummary,
  getEmergencyDutyByDate,
  getEmergencyDutySubmissionIssue,
  mergeEmergencyDutySnapshot,
  retryEmergencyDutyMutation,
  resolveEmergencyDutyMutationFailure,
  resolveEmergencyDutyMutationSuccess,
} from '../../client/src/pages/MonthlySchedule/emergency-duty-state';

const option = (
  key: string,
  name: string,
  role = '运维值班员',
): EmergencyDutyPersonOption => ({ key, name, role });

const schedule = (
  date: string,
  people: EmergencyDutyPersonOption[],
  recordId = `record-${date}`,
): EmergencyDutySchedule => ({
  recordId,
  date,
  people,
  building: null,
});

describe('monthly schedule emergency duty state', () => {
  it('builds an independent date index and returns an explicit empty result', () => {
    const index = buildEmergencyDutyIndex([
      schedule('2026-08-09', [option('person-a', '孙婷婷')]),
    ]);

    expect(getEmergencyDutyByDate(index, '2026-08-09')).toMatchObject({
      state: 'scheduled',
      people: [{ key: 'person-a', name: '孙婷婷' }],
    });
    expect(getEmergencyDutyByDate(index, '2026-08-10')).toEqual({
      state: 'empty',
      people: [],
      syncState: null,
    });
  });

  it('optimistically updates only the target date and records its rollback snapshot', () => {
    const initial = buildEmergencyDutyIndex([
      schedule('2026-08-09', [option('person-a', '孙婷婷')]),
      schedule('2026-08-10', [option('person-b', '彭怀响')]),
    ]);

    const mutation = beginEmergencyDutyMutation(initial, {
      date: '2026-08-09',
      people: [option('person-c', '汪根尚')],
      clientMutationId: 'mutation-a',
    });

    expect(mutation.binding.before?.people[0]?.name).toBe('孙婷婷');
    expect(getEmergencyDutyByDate(mutation.index, '2026-08-09')).toMatchObject({
      state: 'scheduled',
      people: [{ key: 'person-c', name: '汪根尚' }],
      syncState: 'pending',
    });
    expect(getEmergencyDutyByDate(mutation.index, '2026-08-10')).toMatchObject({
      people: [{ key: 'person-b', name: '彭怀响' }],
      syncState: null,
    });
  });

  it('rolls back only a definitely-not-written target and restores its draft', () => {
    const initial = buildEmergencyDutyIndex([
      schedule('2026-08-09', [option('person-a', '孙婷婷')]),
      schedule('2026-08-10', [option('person-b', '彭怀响')]),
    ]);
    const mutation = beginEmergencyDutyMutation(initial, {
      date: '2026-08-09',
      people: [option('person-c', '汪根尚')],
      clientMutationId: 'mutation-a',
    });

    const resolved = resolveEmergencyDutyMutationFailure(
      mutation.index,
      mutation.binding,
      'definitely-not-written',
    );

    expect(resolved.restoreDraft).toEqual({
      date: '2026-08-09',
      personKeys: ['person-c'],
      clientMutationId: 'mutation-a',
    });
    expect(getEmergencyDutyByDate(resolved.index, '2026-08-09')).toMatchObject({
      people: [{ key: 'person-a', name: '孙婷婷' }],
      syncState: null,
    });
    expect(getEmergencyDutyByDate(resolved.index, '2026-08-10')).toMatchObject({
      people: [{ key: 'person-b', name: '彭怀响' }],
    });
  });

  it('keeps an unknown result optimistic and retains the same retry binding', () => {
    const mutation = beginEmergencyDutyMutation(new Map(), {
      date: '2026-08-09',
      people: [option('person-a', '孙婷婷')],
      clientMutationId: 'mutation-a',
    });

    const resolved = resolveEmergencyDutyMutationFailure(
      mutation.index,
      mutation.binding,
      'unknown-result',
    );

    expect(resolved.restoreDraft).toBeNull();
    expect(resolved.retryBinding).toMatchObject({
      clientMutationId: mutation.binding.clientMutationId,
      unknownHistory: true,
    });
    expect(getEmergencyDutyByDate(resolved.index, '2026-08-09')).toMatchObject({
      people: [{ key: 'person-a', name: '孙婷婷' }],
      syncState: 'unknown-result',
    });

    const retry = retryEmergencyDutyMutation(
      resolved.index,
      resolved.retryBinding!,
    );
    expect(retry.binding).toBe(resolved.retryBinding);
    expect(retry.binding.before).toEqual(mutation.binding.before);
    expect(getEmergencyDutyByDate(retry.index, '2026-08-09')).toMatchObject({
      syncState: 'pending',
    });
  });

  it('never rolls back the first unknown attempt when a same-id retry is definitely rejected', () => {
    const initial = buildEmergencyDutyIndex([
      schedule('2026-08-09', [option('person-a', '孙婷婷')]),
    ]);
    const firstAttempt = beginEmergencyDutyMutation(initial, {
      date: '2026-08-09',
      people: [option('person-b', '彭怀响')],
      clientMutationId: 'mutation-unknown-history',
    });
    const firstFailure = resolveEmergencyDutyMutationFailure(
      firstAttempt.index,
      firstAttempt.binding,
      'unknown-result',
    );

    expect(firstFailure.retryBinding).toMatchObject({
      clientMutationId: 'mutation-unknown-history',
      unknownHistory: true,
    });

    const retry = retryEmergencyDutyMutation(
      firstFailure.index,
      firstFailure.retryBinding!,
    );
    const retryFailure = resolveEmergencyDutyMutationFailure(
      retry.index,
      retry.binding,
      'definitely-not-written',
    );

    expect(retryFailure.restoreDraft).toBeNull();
    expect(retryFailure.retryBinding).toMatchObject({
      clientMutationId: 'mutation-unknown-history',
      unknownHistory: true,
    });
    expect(
      getEmergencyDutyByDate(retryFailure.index, '2026-08-09'),
    ).toMatchObject({
      people: [{ key: 'person-b', name: '彭怀响' }],
      syncState: 'unknown-result',
    });
  });

  it('does not let an older response overwrite a newer mutation on the same date', () => {
    const first = beginEmergencyDutyMutation(new Map(), {
      date: '2026-08-09',
      people: [option('person-a', '孙婷婷')],
      clientMutationId: 'mutation-a',
    });
    const second = beginEmergencyDutyMutation(first.index, {
      date: '2026-08-09',
      people: [option('person-b', '彭怀响')],
      clientMutationId: 'mutation-b',
    });

    const afterOldSuccess = resolveEmergencyDutyMutationSuccess(
      second.index,
      first.binding,
      {
        clientMutationId: 'mutation-a',
        syncStatus: 'synced',
        record: schedule(
          '2026-08-09',
          [option('person-a', '孙婷婷')],
          'server-a',
        ),
      },
    );
    const afterOldFailure = resolveEmergencyDutyMutationFailure(
      afterOldSuccess,
      first.binding,
      'definitely-not-written',
    );

    expect(afterOldSuccess).toBe(second.index);
    expect(afterOldFailure.index).toBe(second.index);
    expect(afterOldFailure.restoreDraft).toBeNull();
    expect(getEmergencyDutyByDate(second.index, '2026-08-09')).toMatchObject({
      people: [{ key: 'person-b', name: '彭怀响' }],
      syncState: 'pending',
    });
  });

  it('preserves a partial-success overlay until the local snapshot confirms it', () => {
    const initial = buildEmergencyDutyIndex([
      schedule('2026-08-09', [option('person-a', '孙婷婷')]),
    ]);
    const mutation = beginEmergencyDutyMutation(initial, {
      date: '2026-08-09',
      people: [option('person-b', '彭怀响')],
      clientMutationId: 'mutation-a',
    });
    const partial = resolveEmergencyDutyMutationSuccess(
      mutation.index,
      mutation.binding,
      {
        clientMutationId: 'mutation-a',
        syncStatus: 'cache_refresh_pending',
        record: schedule(
          '2026-08-09',
          [option('person-b', '彭怀响')],
          'server-b',
        ),
      },
    );

    const staleSnapshot = mergeEmergencyDutySnapshot(partial, [
      schedule('2026-08-09', [option('person-a', '孙婷婷')]),
    ]);
    const confirmedSnapshot = mergeEmergencyDutySnapshot(staleSnapshot, [
      schedule('2026-08-09', [option('person-b', '彭怀响')], 'server-b'),
    ]);

    expect(getEmergencyDutyByDate(staleSnapshot, '2026-08-09')).toMatchObject({
      people: [{ key: 'person-b', name: '彭怀响' }],
      syncState: 'cache_refresh_pending',
    });
    expect(
      getEmergencyDutyByDate(confirmedSnapshot, '2026-08-09'),
    ).toMatchObject({
      people: [{ key: 'person-b', name: '彭怀响' }],
      syncState: null,
    });
  });

  it('requires the complete canonical record before clearing cache-refresh-pending', () => {
    const mutation = beginEmergencyDutyMutation(new Map(), {
      date: '2026-08-09',
      people: [option('person-a', '孙婷婷')],
      clientMutationId: 'mutation-canonical-a',
    });
    const partial = resolveEmergencyDutyMutationSuccess(
      mutation.index,
      mutation.binding,
      {
        clientMutationId: mutation.binding.clientMutationId,
        syncStatus: 'cache_refresh_pending',
        record: schedule(
          '2026-08-09',
          [option('person-a', '孙婷婷')],
          'rec-canonical',
        ),
      },
    );
    const staleBuilding = mergeEmergencyDutySnapshot(partial, [
      {
        ...schedule(
          '2026-08-09',
          [option('person-a', '孙婷婷')],
          'rec-canonical',
        ),
        building: 'A楼',
      },
    ]);
    const staleRecordId = mergeEmergencyDutySnapshot(partial, [
      schedule('2026-08-09', [option('person-a', '孙婷婷')], 'rec-stale'),
    ]);
    const canonical = mergeEmergencyDutySnapshot(partial, [
      schedule('2026-08-09', [option('person-a', '孙婷婷')], 'rec-canonical'),
    ]);

    expect(staleBuilding.get('2026-08-09')).toMatchObject({
      recordId: 'rec-canonical',
      building: null,
      syncState: 'cache_refresh_pending',
    });
    expect(staleRecordId.get('2026-08-09')).toMatchObject({
      recordId: 'rec-canonical',
      building: null,
      syncState: 'cache_refresh_pending',
    });
    expect(canonical.get('2026-08-09')).toMatchObject({
      recordId: 'rec-canonical',
      building: null,
    });
    expect(canonical.get('2026-08-09')?.syncState).toBeUndefined();
  });

  it('classifies only an explicit definitely-not-written response as safe rollback', () => {
    expect(
      classifyEmergencyDutyMutationError({
        response: { data: { writeDisposition: 'definitely-not-written' } },
      }),
    ).toBe('definitely-not-written');
    expect(classifyEmergencyDutyMutationError({ code: 'ECONNABORTED' })).toBe(
      'unknown-result',
    );
    expect(classifyEmergencyDutyMutationError(new Error('network'))).toBe(
      'unknown-result',
    );
  });

  it('classifies the real global-filter Axios body even when the toolkit wraps it as a cause', () => {
    const response = {
      headersSent: false,
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    const host = {
      switchToHttp: () => ({ getResponse: () => response }),
    } as unknown as ArgumentsHost;
    new GlobalExceptionFilter().catch(
      new BadRequestException({
        message: '所选值班人员已离职，请刷新后重选',
        writeDisposition: 'definitely-not-written',
      }),
      host,
    );
    const filteredBody = response.json.mock.calls[0]?.[0];

    expect(
      classifyEmergencyDutyMutationError({
        cause: {
          isAxiosError: true,
          response: { status: 400, data: filteredBody },
        },
      }),
    ).toBe('definitely-not-written');
    expect(
      classifyEmergencyDutyMutationError({
        response: { status: 400, data: { message: '普通 400' } },
      }),
    ).toBe('unknown-result');
  });

  it('blocks duplicate, unavailable, and out-of-range submissions but permits a loaded date', () => {
    const loadedRange = {
      startDate: '2026-08-04',
      endDate: '2026-08-14',
    };
    const valid = {
      date: '2026-08-09',
      loadedRange,
      loadState: 'ready' as const,
      syncState: null,
      selectedCount: 1,
      optionsReady: true,
      isRecovery: false,
    };

    expect(getEmergencyDutySubmissionIssue(valid)).toBeNull();
    expect(
      getEmergencyDutySubmissionIssue({ ...valid, date: '2026-08-20' }),
    ).toBe('outside-loaded-range');
    expect(
      getEmergencyDutySubmissionIssue({ ...valid, loadState: 'error' }),
    ).toBe('schedules-unavailable');
    expect(
      getEmergencyDutySubmissionIssue({ ...valid, syncState: 'pending' }),
    ).toBe('pending');
    expect(
      getEmergencyDutySubmissionIssue({
        ...valid,
        date: '2026-08-20',
        loadState: 'error',
        syncState: 'unknown-result',
        optionsReady: false,
        isRecovery: true,
      }),
    ).toBeNull();
  });

  it('does not let a GET started before a successful mutation restore the old value', () => {
    const initial = buildEmergencyDutyIndex([
      schedule('2026-08-09', [option('person-a', '孙婷婷')]),
    ]);
    const mutation = beginEmergencyDutyMutation(initial, {
      date: '2026-08-09',
      people: [option('person-b', '彭怀响')],
      clientMutationId: 'mutation-after-get-started',
      revision: 1,
    });
    const succeeded = resolveEmergencyDutyMutationSuccess(
      mutation.index,
      { ...mutation.binding, revision: 2 },
      {
        clientMutationId: mutation.binding.clientMutationId,
        syncStatus: 'synced',
        record: schedule('2026-08-09', [option('person-b', '彭怀响')]),
      },
    );

    const oldGet = mergeEmergencyDutySnapshot(
      succeeded,
      [schedule('2026-08-09', [option('person-a', '孙婷婷')])],
      { snapshotRevision: 1 },
    );
    const newerGet = mergeEmergencyDutySnapshot(
      oldGet,
      [schedule('2026-08-09', [option('person-c', '汪根尚')])],
      { snapshotRevision: 2 },
    );

    expect(getEmergencyDutyByDate(oldGet, '2026-08-09').people[0]?.key).toBe(
      'person-b',
    );
    expect(getEmergencyDutyByDate(newerGet, '2026-08-09').people[0]?.key).toBe(
      'person-c',
    );
  });

  it('labels stale and failed snapshots even when the date is empty or has cached people', () => {
    const empty = { state: 'empty' as const, people: [], syncState: null };
    const cached = {
      state: 'scheduled' as const,
      people: [option('person-a', '孙婷婷')],
      syncState: null,
    };

    expect(
      formatEmergencyDutySummary({
        ...empty,
        loadState: 'ready',
        stale: true,
      }),
    ).toBe('应急：缓存已过期 · 暂无法确认');
    expect(
      formatEmergencyDutySummary({
        ...cached,
        loadState: 'error',
        stale: false,
      }),
    ).toBe('应急：孙婷婷 · 刷新失败，展示上次缓存');
    expect(
      formatEmergencyDutySummary({
        ...empty,
        loadState: 'error',
        stale: false,
      }),
    ).toBe('应急：刷新失败 · 暂无法确认');
  });

  it('renders a large option list with Set membership and browser rendering containment', () => {
    const options = Array.from({ length: 600 }, (_, index) =>
      option(`person-${index}`, `人员${index}`),
    );
    const html = renderToStaticMarkup(
      React.createElement(EmergencyDutyOptionList, {
        options,
        selectedKeys: new Set(['person-2', 'person-599']),
        disabled: false,
        onToggle: () => undefined,
      }),
    );

    expect(html).toContain('content-visibility:auto');
    expect(html).toContain('contain-intrinsic-size');
    expect(html.match(/aria-pressed="true"/gu)).toHaveLength(2);
    expect(html).toContain('人员599');
  });
});

describe('monthly schedule emergency duty integration contract', () => {
  const pageSource = fs.readFileSync(
    path.resolve(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
    'utf8',
  );
  const apiSource = fs.readFileSync(
    path.resolve(process.cwd(), 'client/src/api/index.ts'),
    'utf8',
  );

  it('uses the independent API and offers the fourth adjustment tab', () => {
    expect(apiSource).toContain('getEmergencyDutySchedules');
    expect(apiSource).toContain('getEmergencyDutyOptions');
    expect(apiSource).toContain('upsertEmergencyDutySchedule');
    expect(pageSource).toMatch(
      /type StaffAdjustmentMode\s*=\s*'vacancy'\s*\|\s*'repair'\s*\|\s*'travel'\s*\|\s*'emergency'/,
    );
    expect(pageSource).toContain("['emergency', '应急值班']");
  });

  it('does not rebuild emergency duty from the ordinary monthly schedule field', () => {
    expect(pageSource).not.toContain(
      'const emergencyDutySets = new Map<string, Set<string>>()',
    );
    expect(pageSource).toContain('loadEmergencyDutySchedules');
    expect(pageSource).toContain('formatEmergencyDutySummary');
    expect(pageSource).toContain('emergencyDutyLoadStatus');
  });

  it('wires loaded-range gating, mutation revisions, and the optimized option component into the page', () => {
    expect(pageSource).toContain('getEmergencyDutySubmissionIssue');
    expect(pageSource).toContain('emergencyDutyLoadedRange');
    expect(pageSource).toContain('min={editableRange?.startDate}');
    expect(pageSource).toContain('max={editableRange?.endDate}');
    expect(pageSource).toContain('snapshotRevision: requestMutationRevision');
    expect(pageSource).toContain('revision: mutationRevision');
    expect(pageSource).toContain('<EmergencyDutyOptionList');
    expect(pageSource).toContain('emergencyDutySelectedKeySet');
    expect(pageSource).not.toContain('selectedKeys.includes(person.key)');
  });

  it('silently revalidates stale emergency duty snapshots while the page stays open or regains focus', () => {
    expect(pageSource).toContain(
      'const EMERGENCY_DUTY_REVALIDATE_INTERVAL_MS = 60 * 1000;',
    );
    expect(pageSource).toContain(
      'void loadEmergencyDutySchedules({ silent: true });',
    );
    expect(pageSource).toContain(
      "window.addEventListener('focus', refreshEmergencyDutySchedules);",
    );
    expect(pageSource).toMatch(
      /document\.addEventListener\(\s*'visibilitychange',\s*refreshEmergencyDutySchedules,?\s*\);/s,
    );
    expect(pageSource).toMatch(
      /if \(!silent\) \{\s*setEmergencyDutyLoadStatus\('loading'\);/s,
    );
    expect(pageSource).toMatch(
      /catch \(error\) \{[\s\S]*?if \(silent\) \{[\s\S]*?return;/,
    );
  });

  it('renders ordinary and emergency names through the same protected personnel card', () => {
    expect(pageSource).toContain('function EmergencyDutyProfileSummary');
    expect(pageSource).toContain('<EmergencyDutyProfileSummary');
    expect(pageSource).toContain('<StaffProfilePopover');
    expect(pageSource).toContain('buildTelephoneHref(profile?.phone)');
    expect(pageSource).toContain('href={profile.feishuChatUrl}');
    expect(pageSource).toContain(
      'onClick={() => setOpen((current) => !current)}',
    );
  });
});
