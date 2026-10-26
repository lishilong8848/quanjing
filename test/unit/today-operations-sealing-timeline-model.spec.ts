import type { SealingInfo } from '../../shared/api.interface';
import { buildSealingTimelineModel } from '../../client/src/pages/TodayOperationsPanorama/sealing-timeline-model';

function sealingInfo(
  id: string,
  startDate: string,
  endDate: string,
  overrides: Partial<SealingInfo> = {},
): SealingInfo {
  return {
    id,
    bitableRecordId: id,
    sealingCode: `FW-${id}`,
    sealingName: `封网 ${id}`,
    startDate,
    endDate,
    sealingType: '强管控',
    autoNumber: null,
    isToday: false,
    createdAt: startDate,
    updatedAt: startDate,
    ...overrides,
  };
}

describe('today operations sealing timeline model', () => {
  it('builds one continuous 168-hour axis with seven Shanghai date headers', () => {
    const model = buildSealingTimelineModel(
      [
        sealingInfo(
          'day-two',
          '2026-09-22T00:00:00.000Z',
          '2026-09-22T13:00:00.000Z',
        ),
      ],
      '2026-09-20',
    );

    expect(model.status).toBe('ready');
    expect(model.days).toHaveLength(7);
    expect(model.days.map((day) => day.dateKey)).toEqual([
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
    ]);
    expect(model.days[0]).toMatchObject({
      dateLabel: '09/21',
      weekdayLabel: '周一',
    });
    expect(model.segments).toHaveLength(1);
    expect(model.segments[0]).toMatchObject({
      recordKey: 'day-two',
      startMinute: 32 * 60,
      endMinute: 45 * 60,
      visibleTimeLabel: '09/22 08:00–21:00',
    });
    expect(model.segments[0].leftPercent).toBeCloseTo((32 / 168) * 100, 5);
    expect(model.segments[0].widthPercent).toBeCloseTo((13 / 168) * 100, 5);
  });

  it('keeps cross-midnight records continuous and clips only at the seven-day window', () => {
    const model = buildSealingTimelineModel(
      [
        sealingInfo(
          'from-today',
          '2026-09-20T15:00:00.000Z',
          '2026-09-20T18:00:00.000Z',
        ),
        sealingInfo(
          'cross-midnight',
          '2026-09-23T14:30:00.000Z',
          '2026-09-23T18:15:00.000Z',
        ),
      ],
      '2026-09-20',
    );

    expect(model.segments).toHaveLength(2);
    expect(model.segments[0]).toMatchObject({
      recordKey: 'from-today',
      startMinute: 0,
      endMinute: 120,
      startsBeforeWindow: true,
      visibleTimeLabel: '09/21 00:00–02:00',
    });
    expect(model.segments[1]).toMatchObject({
      recordKey: 'cross-midnight',
      startMinute: (2 * 24 + 22.5) * 60,
      endMinute: (3 * 24 + 2.25) * 60,
      startsBeforeWindow: false,
      endsAfterWindow: false,
      visibleTimeLabel: '09/23 22:30–09/24 02:15',
    });
  });

  it('returns one row per valid record and ignores intervals outside the window', () => {
    const model = buildSealingTimelineModel(
      [
        sealingInfo(
          'wide',
          '2026-09-25T00:00:00.000Z',
          '2026-09-25T04:00:00.000Z',
        ),
        sealingInfo(
          'nested',
          '2026-09-25T02:00:00.000Z',
          '2026-09-25T03:00:00.000Z',
        ),
        sealingInfo('invalid-date', 'not-a-date', 'still-not-a-date'),
        sealingInfo(
          'invalid-order',
          '2026-09-26T04:00:00.000Z',
          '2026-09-26T02:00:00.000Z',
        ),
        sealingInfo(
          'outside-window',
          '2026-09-28T00:00:00.000Z',
          '2026-09-28T02:00:00.000Z',
        ),
      ],
      '2026-09-20',
    );

    expect(model.segments.map((segment) => segment.recordKey)).toEqual([
      'wide',
      'nested',
    ]);
    expect(buildSealingTimelineModel([], 'invalid-date')).toEqual({
      status: 'error',
      days: [],
      segments: [],
    });
  });
});
