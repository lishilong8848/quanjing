import {
  buildTyphoonPathWarningDeliveryKey,
  buildTyphoonWarningSendState,
  decideTyphoonPathScreenshotSend,
  findActiveTyphoonWarning,
  getTyphoonWarningCadenceHours,
  isWeatherWarningActive,
} from '../../server/modules/duty-schedule/typhoon-warning-alert';

function response(warning: Array<Record<string, string>>) {
  return {
    code: '200',
    warning,
  };
}

describe('typhoon warning alert rules', () => {
  it('finds the highest active typhoon warning', () => {
    const warning = findActiveTyphoonWarning(response([
      {
        id: 'rain-yellow',
        title: '南通市发布暴雨黄色预警',
        level: '黄色',
        type: '暴雨',
        status: '发布',
      },
      {
        id: 'typhoon-blue',
        title: '南通市发布台风蓝色预警',
        level: '蓝色',
        type: '台风',
        status: '发布',
      },
      {
        id: 'typhoon-orange',
        title: '南通市发布台风橙色预警',
        level: '橙色',
        type: '台风',
        status: '发布',
      },
    ]));

    expect(warning?.id).toBe('typhoon-orange');
    expect(warning?.level).toBe('orange');
    expect(warning?.levelText).toBe('橙色');
  });

  it('ignores released typhoon warnings', () => {
    const warning = findActiveTyphoonWarning(response([
      {
        id: 'typhoon-released',
        title: '南通市解除台风蓝色预警',
        level: '蓝色',
        type: '台风',
        status: '解除',
      },
    ]));

    expect(warning).toBeNull();
  });

  it.each([
    '解除',
    '取消',
    '撤销',
    '结束',
    '终止',
    '失效',
    '过期',
    'cancelled',
    'expired',
    'ended',
    'closed',
    'inactive',
  ])('ignores terminal warning status %s', (status) => {
    expect(isWeatherWarningActive({
      id: `terminal-${status}`,
      title: '南通市发布台风橙色预警',
      level: '橙色',
      type: '台风',
      status,
    }, new Date('2026-07-28T10:00:00.000Z'))).toBe(false);
  });

  it('ignores a warning whose end time has reached the current time', () => {
    const now = new Date('2026-07-28T10:00:00.000Z');
    const expired = {
      id: 'typhoon-expired',
      title: '南通市发布台风橙色预警',
      level: '橙色',
      type: '台风',
      status: '发布',
      endTime: now.toISOString(),
    };

    expect(isWeatherWarningActive(expired, now)).toBe(false);
    expect(findActiveTyphoonWarning(response([expired]), now)).toBeNull();
  });

  it('keeps a warning with a future end time or an invalid optional end time active', () => {
    const now = new Date('2026-07-28T10:00:00.000Z');

    expect(isWeatherWarningActive({
      id: 'typhoon-future',
      title: '南通市发布台风蓝色预警',
      level: '蓝色',
      type: '台风',
      status: '发布',
      endTime: '2026-07-28T10:01:00.000Z',
    }, now)).toBe(true);
    expect(isWeatherWarningActive({
      id: 'typhoon-no-valid-end',
      title: '南通市发布台风蓝色预警',
      level: '蓝色',
      type: '台风',
      status: '发布',
      endTime: '待定',
    }, now)).toBe(true);
  });

  it('does not let an expired high-level warning hide an active lower-level warning', () => {
    const now = new Date('2026-07-28T10:00:00.000Z');
    const warning = findActiveTyphoonWarning(response([
      {
        id: 'typhoon-orange-expired',
        title: '南通市发布台风橙色预警',
        level: '橙色',
        type: '台风',
        status: '发布',
        endTime: '2026-07-28T09:59:59.000Z',
      },
      {
        id: 'typhoon-blue-active',
        title: '南通市发布台风蓝色预警',
        level: '蓝色',
        type: '台风',
        status: '发布',
        endTime: '2026-07-28T18:00:00.000Z',
      },
    ]), now);

    expect(warning?.id).toBe('typhoon-blue-active');
  });

  it('does not treat another warning type as typhoon only because its text mentions a typhoon', () => {
    const warning = findActiveTyphoonWarning(response([
      {
        id: 'marine-gale-yellow',
        title: '南通市气象台发布海区大风黄色预警',
        level: '黄色',
        type: '海区大风',
        status: '发布',
        text: '受今年第9号台风影响，沿岸海区有9到10级大风。',
      },
      {
        id: 'typhoon-blue',
        title: '南通市气象台发布台风蓝色预警',
        level: '蓝色',
        type: '台风',
        status: '发布',
      },
    ]));

    expect(warning?.id).toBe('typhoon-blue');
    expect(warning?.level).toBe('blue');
  });

  it('uses 8 hours for blue and 4 hours for yellow or above', () => {
    expect(getTyphoonWarningCadenceHours('blue')).toBe(8);
    expect(getTyphoonWarningCadenceHours('yellow')).toBe(4);
    expect(getTyphoonWarningCadenceHours('orange')).toBe(4);
    expect(getTyphoonWarningCadenceHours('red')).toBe(4);
  });

  it('sends blue warning screenshots only after the 8 hour cadence', () => {
    const data = response([
      {
        id: 'typhoon-blue',
        title: '南通市发布台风蓝色预警',
        level: '蓝色',
        type: '台风',
        status: '发布',
      },
    ]);
    const first = decideTyphoonPathScreenshotSend(data, {}, new Date('2026-07-09T00:00:00.000Z'));
    expect(first.shouldSend).toBe(true);

    const state = buildTyphoonWarningSendState(first.warning!, new Date('2026-07-09T00:00:00.000Z'));
    expect(
      decideTyphoonPathScreenshotSend(data, state, new Date('2026-07-09T07:59:00.000Z')).shouldSend,
    ).toBe(false);
    expect(
      decideTyphoonPathScreenshotSend(data, state, new Date('2026-07-09T08:00:00.000Z')).shouldSend,
    ).toBe(true);
  });

  it('sends yellow warning screenshots after the 4 hour cadence', () => {
    const data = response([
      {
        id: 'typhoon-yellow',
        title: '南通市发布台风黄色预警',
        level: '黄色',
        type: '台风',
        status: '发布',
      },
    ]);
    const first = decideTyphoonPathScreenshotSend(data, {}, new Date('2026-07-09T00:00:00.000Z'));
    const state = buildTyphoonWarningSendState(first.warning!, new Date('2026-07-09T00:00:00.000Z'));

    expect(
      decideTyphoonPathScreenshotSend(data, state, new Date('2026-07-09T03:59:00.000Z')).shouldSend,
    ).toBe(false);
    expect(
      decideTyphoonPathScreenshotSend(data, state, new Date('2026-07-09T04:00:00.000Z')).shouldSend,
    ).toBe(true);
  });

  it('sends immediately when a warning level escalates', () => {
    const blue = findActiveTyphoonWarning(response([
      {
        id: 'typhoon-same',
        title: '南通市发布台风蓝色预警',
        level: '蓝色',
        type: '台风',
        status: '发布',
      },
    ]));
    const state = buildTyphoonWarningSendState(blue!, new Date('2026-07-09T00:00:00.000Z'));

    const escalated = decideTyphoonPathScreenshotSend(
      response([
        {
          id: 'typhoon-same',
          title: '南通市发布台风黄色预警',
          level: '黄色',
          type: '台风',
          status: '发布',
        },
      ]),
      state,
      new Date('2026-07-09T02:00:00.000Z'),
    );

    expect(escalated.shouldSend).toBe(true);
    expect(escalated.reason).toBe('level-escalated');
  });

  it('uses the injected decision time when filtering expired warnings', () => {
    const data = response([
      {
        id: 'typhoon-time-boundary',
        title: '南通市发布台风黄色预警',
        level: '黄色',
        type: '台风',
        status: '发布',
        endTime: '2026-07-28T10:00:00.000Z',
      },
    ]);

    expect(
      decideTyphoonPathScreenshotSend(
        data,
        {},
        new Date('2026-07-28T09:59:59.000Z'),
      ).shouldSend,
    ).toBe(true);
    expect(
      decideTyphoonPathScreenshotSend(
        data,
        {},
        new Date('2026-07-28T10:00:00.000Z'),
      ),
    ).toMatchObject({
      shouldSend: false,
      reason: 'no-active-typhoon-warning',
    });
  });

  it('builds a stable delivery key for retries and changes it for a later cadence', () => {
    const data = response([
      {
        id: 'typhoon-stable-key',
        title: '南通市发布台风黄色预警',
        level: '黄色',
        type: '台风',
        status: '发布',
        pubTime: '2026-07-28T00:00:00.000Z',
      },
    ]);
    const firstDecision = decideTyphoonPathScreenshotSend(
      data,
      {},
      new Date('2026-07-28T01:00:00.000Z'),
    );
    const firstKey = buildTyphoonPathWarningDeliveryKey(firstDecision, {});

    expect(buildTyphoonPathWarningDeliveryKey(firstDecision, {})).toBe(firstKey);

    const state = buildTyphoonWarningSendState(
      firstDecision.warning!,
      new Date('2026-07-28T01:00:00.000Z'),
    );
    const cadenceDecision = decideTyphoonPathScreenshotSend(
      data,
      state,
      new Date('2026-07-28T05:00:00.000Z'),
    );

    expect(buildTyphoonPathWarningDeliveryKey(cadenceDecision, state))
      .not.toBe(firstKey);
  });
});
