import { execFileSync } from 'node:child_process';

import {
  type ChinaWorkCalendarSnapshot,
  getChinaWorkdayInfo,
  getChinaWorkCalendarSnapshot,
  getHolidayInfo,
  getLongWhiteRestInfo,
  installChinaWorkCalendarSnapshot,
  validateChinaWorkCalendarSnapshot,
} from '../../shared/china-work-calendar';

const OFFICIAL_2026_SOURCE =
  '中国政府网《国务院办公厅关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号）';

const OFFICIAL_2026_HOLIDAYS = [
  ['2026-01-01', '元旦'],
  ['2026-01-02', '元旦'],
  ['2026-01-03', '元旦'],
  ['2026-02-15', '春节'],
  ['2026-02-16', '春节'],
  ['2026-02-17', '春节'],
  ['2026-02-18', '春节'],
  ['2026-02-19', '春节'],
  ['2026-02-20', '春节'],
  ['2026-02-21', '春节'],
  ['2026-02-22', '春节'],
  ['2026-02-23', '春节'],
  ['2026-04-04', '清明节'],
  ['2026-04-05', '清明节'],
  ['2026-04-06', '清明节'],
  ['2026-05-01', '劳动节'],
  ['2026-05-02', '劳动节'],
  ['2026-05-03', '劳动节'],
  ['2026-05-04', '劳动节'],
  ['2026-05-05', '劳动节'],
  ['2026-06-19', '端午节'],
  ['2026-06-20', '端午节'],
  ['2026-06-21', '端午节'],
  ['2026-09-25', '中秋节'],
  ['2026-09-26', '中秋节'],
  ['2026-09-27', '中秋节'],
  ['2026-10-01', '国庆节'],
  ['2026-10-02', '国庆节'],
  ['2026-10-03', '国庆节'],
  ['2026-10-04', '国庆节'],
  ['2026-10-05', '国庆节'],
  ['2026-10-06', '国庆节'],
  ['2026-10-07', '国庆节'],
] as const;

const OFFICIAL_2026_ADJUSTED_WORKDAYS = [
  '2026-01-04',
  '2026-02-14',
  '2026-02-28',
  '2026-05-09',
  '2026-09-20',
  '2026-10-10',
] as const;

function create2099Snapshot(): ChinaWorkCalendarSnapshot {
  return {
    schemaVersion: 1,
    years: [
      {
        year: 2099,
        source:
          '中国政府网《国务院办公厅关于2099年部分节假日安排的通知》（国办发明电〔2098〕1号）',
        sourceUrl:
          'https://www.gov.cn/zhengce/zhengceku/209811/content_2099001.htm',
        noticeNumber: '国办发明电〔2098〕1号',
        publishedAt: '2098-11-01T00:00:00.000Z',
        retrievedAt: '2098-11-02T00:00:00.000Z',
        contentHash:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        holidays: {
          '2099-01-01': '元旦',
          '2099-02-01': '春节',
          '2099-04-05': '清明节',
          '2099-05-01': '劳动节',
          '2099-06-20': '端午节',
          '2099-09-25': '中秋节',
          '2099-10-01': '国庆节',
          '2100-01-01': '元旦',
        },
        adjustedWorkdays: ['2099-10-10', '2099-01-04'],
      },
    ],
  };
}

describe('China work-calendar snapshots', () => {
  it('validates, normalizes and deep-clones a complete official snapshot', () => {
    const input = create2099Snapshot();

    const validated = validateChinaWorkCalendarSnapshot(input);

    expect(validated).toEqual({
      ...input,
      years: [
        {
          ...input.years[0],
          adjustedWorkdays: ['2099-01-04', '2099-10-10'],
        },
      ],
    });
    expect(validated).not.toBe(input);
    expect(validated.years[0]).not.toBe(input.years[0]);
    expect(validated.years[0].holidays).not.toBe(input.years[0].holidays);
    expect(validated.years[0].adjustedWorkdays).not.toBe(
      input.years[0].adjustedWorkdays,
    );

    input.years[0].holidays['2099-01-01'] = '被外部修改';
    expect(validated.years[0].holidays['2099-01-01']).toBe('元旦');
  });

  it.each([
    'http://www.gov.cn/zhengce/content_2099.htm',
    'https://www.gov.cn.example.com/zhengce/content_2099.htm',
    'https://gov.cn/zhengce/content_2099.htm',
    'https://www.gov.cn/other/content_2099.htm',
    'https://user@www.gov.cn/zhengce/content_2099.htm',
  ])('rejects a non-official source URL: %s', (sourceUrl) => {
    const input = create2099Snapshot();
    input.years[0].sourceUrl = sourceUrl;

    expect(() => validateChinaWorkCalendarSnapshot(input)).toThrow(
      /官方|www\.gov\.cn|sourceUrl/i,
    );
  });

  it('rejects a malformed notice number and content hash', () => {
    const invalidNotice = create2099Snapshot();
    invalidNotice.years[0].noticeNumber = '内部通知 1 号';
    expect(() => validateChinaWorkCalendarSnapshot(invalidNotice)).toThrow(
      /noticeNumber|文号/i,
    );

    const invalidHash = create2099Snapshot();
    invalidHash.years[0].contentHash = 'short-hash';
    expect(() => validateChinaWorkCalendarSnapshot(invalidHash)).toThrow(
      /contentHash|哈希/i,
    );
  });

  it.each([
    ['invalid date', '2099-02-30'],
    ['date outside target year plus or minus one', '2101-01-01'],
  ])('rejects an invalid holiday %s', (_label, invalidDate) => {
    const input = create2099Snapshot();
    input.years[0].holidays[invalidDate] = '测试节日';

    expect(() => validateChinaWorkCalendarSnapshot(input)).toThrow(
      /日期|year/i,
    );
  });

  it('rejects holiday and adjusted-workday overlap', () => {
    const input = create2099Snapshot();
    input.years[0].adjustedWorkdays.push('2099-01-01');

    expect(() => validateChinaWorkCalendarSnapshot(input)).toThrow(
      /重叠|overlap/i,
    );
  });

  it.each([
    ['source', ''],
    ['noticeNumber', '   '],
    ['publishedAt', 'not-a-date'],
    ['retrievedAt', ''],
    ['contentHash', ''],
  ] as const)('rejects an invalid required field: %s', (field, value) => {
    const input = create2099Snapshot();
    input.years[0][field] = value;

    expect(() => validateChinaWorkCalendarSnapshot(input)).toThrow(
      new RegExp(field, 'i'),
    );
  });

  it('rejects an incomplete annual holiday set', () => {
    const input = create2099Snapshot();
    input.years[0].holidays = Object.fromEntries(
      Object.entries(input.years[0].holidays).slice(0, 6),
    );

    expect(() => validateChinaWorkCalendarSnapshot(input)).toThrow(
      /完整|7|holiday/i,
    );
  });

  it('installs annual data atomically and reports idempotent reinstallation', () => {
    const input = create2099Snapshot();

    expect(installChinaWorkCalendarSnapshot(input)).toBe(true);
    expect(installChinaWorkCalendarSnapshot(create2099Snapshot())).toBe(false);
    expect(getChinaWorkdayInfo('2099-01-01')).toMatchObject({
      kind: 'holiday',
      supported: true,
      name: '元旦',
      source: input.years[0].source,
    });

    const changed = create2099Snapshot();
    changed.years[0].holidays['2099-01-01'] = '元旦更新';
    changed.years[0].contentHash =
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    expect(installChinaWorkCalendarSnapshot(changed)).toBe(true);
    expect(getChinaWorkdayInfo('2099-01-01')).toMatchObject({
      kind: 'holiday',
      supported: true,
      name: '元旦更新',
    });
  });

  it('does not mutate installed years when a multi-year install is invalid', () => {
    const before = getChinaWorkCalendarSnapshot();
    const invalid = create2099Snapshot();
    invalid.years.push({
      ...invalid.years[0],
      year: 2098,
      source: '中国政府网《国务院办公厅关于2098年部分节假日安排的通知》',
      sourceUrl: 'http://www.gov.cn/invalid',
    });

    expect(() => installChinaWorkCalendarSnapshot(invalid)).toThrow();
    expect(getChinaWorkCalendarSnapshot()).toEqual(before);
  });

  it('returns detached snapshots that cannot mutate the active calendar', () => {
    const first = getChinaWorkCalendarSnapshot();
    const installed2099 = first.years.find(({ year }) => year === 2099);
    expect(installed2099).toBeDefined();

    installed2099!.holidays['2099-01-01'] = '外部篡改';
    installed2099!.adjustedWorkdays.push('2099-12-31');

    const second = getChinaWorkCalendarSnapshot();
    const fresh2099 = second.years.find(({ year }) => year === 2099);
    expect(fresh2099?.holidays['2099-01-01']).toBe('元旦更新');
    expect(fresh2099?.adjustedWorkdays).not.toContain('2099-12-31');
  });

  it('prioritizes explicit cross-year exceptions but still fails closed for ordinary dates', () => {
    expect(getChinaWorkdayInfo('2100-01-01')).toMatchObject({
      dateKey: '2100-01-01',
      kind: 'holiday',
      isWorkday: false,
      supported: true,
      name: '元旦',
    });
    expect(getChinaWorkdayInfo('2100-01-02')).toEqual({
      dateKey: '2100-01-02',
      kind: 'calendar_data_missing',
      isWorkday: false,
      supported: false,
      name: '缺少 2100 年法定节假日日历',
    });
  });
});

describe('getChinaWorkdayInfo', () => {
  it('marks the 2026 Labour Day holiday as a supported rest day', () => {
    expect(getChinaWorkdayInfo('2026-05-01')).toEqual({
      dateKey: '2026-05-01',
      kind: 'holiday',
      isWorkday: false,
      supported: true,
      name: '劳动节',
      source: OFFICIAL_2026_SOURCE,
    });
  });

  it('marks an official adjusted Saturday as a supported workday', () => {
    expect(getChinaWorkdayInfo('2026-05-09')).toEqual({
      dateKey: '2026-05-09',
      kind: 'adjusted_workday',
      isWorkday: true,
      supported: true,
      name: '调休上班',
      source: OFFICIAL_2026_SOURCE,
    });
  });

  it('distinguishes an ordinary weekend from an ordinary weekday', () => {
    expect(getChinaWorkdayInfo('2026-08-01')).toEqual({
      dateKey: '2026-08-01',
      kind: 'weekend_rest',
      isWorkday: false,
      supported: true,
      name: '周末',
      source: OFFICIAL_2026_SOURCE,
    });
    expect(getChinaWorkdayInfo('2026-08-03')).toEqual({
      dateKey: '2026-08-03',
      kind: 'weekday',
      isWorkday: true,
      supported: true,
      name: '工作日',
      source: OFFICIAL_2026_SOURCE,
    });
  });

  it.each(['2026-02-30', '2026-5-01', '2026-05-01T00:00:00+08:00'])(
    'fails closed for an invalid YYYY-MM-DD value: %s',
    (dateKey) => {
      expect(getChinaWorkdayInfo(dateKey)).toEqual({
        dateKey,
        kind: 'calendar_data_missing',
        isWorkday: false,
        supported: false,
        name: '日期格式无效',
      });
    },
  );

  it('fails closed when the requested year has no official calendar data', () => {
    expect(getChinaWorkdayInfo('2027-08-02')).toEqual({
      dateKey: '2027-08-02',
      kind: 'calendar_data_missing',
      isWorkday: false,
      supported: false,
      name: '缺少 2027 年法定节假日日历',
    });
  });

  it('extracts Date inputs in Asia/Shanghai regardless of the process timezone', () => {
    const calendarModulePath =
      require.resolve('../../shared/china-work-calendar');
    const childScript = `
      const { getChinaWorkdayInfo } = require(${JSON.stringify(calendarModulePath)});
      process.stdout.write(JSON.stringify(
        getChinaWorkdayInfo(new Date('2026-04-30T16:30:00.000Z')),
      ));
    `;
    const output = execFileSync(
      process.execPath,
      ['-r', 'ts-node/register/transpile-only', '-e', childScript],
      {
        cwd: process.cwd(),
        env: { ...process.env, TZ: 'UTC' },
        encoding: 'utf8',
      },
    );

    expect(JSON.parse(output)).toEqual({
      dateKey: '2026-05-01',
      kind: 'holiday',
      isWorkday: false,
      supported: true,
      name: '劳动节',
      source: OFFICIAL_2026_SOURCE,
    });
  });

  it.each(OFFICIAL_2026_HOLIDAYS)(
    'covers the official 2026 holiday date %s',
    (dateKey, name) => {
      expect(getChinaWorkdayInfo(dateKey)).toMatchObject({
        dateKey,
        kind: 'holiday',
        isWorkday: false,
        supported: true,
        name,
        source: OFFICIAL_2026_SOURCE,
      });
    },
  );

  it.each(OFFICIAL_2026_ADJUSTED_WORKDAYS)(
    'covers the official 2026 adjusted workday %s',
    (dateKey) => {
      expect(getChinaWorkdayInfo(dateKey)).toEqual({
        dateKey,
        kind: 'adjusted_workday',
        isWorkday: true,
        supported: true,
        name: '调休上班',
        source: OFFICIAL_2026_SOURCE,
      });
    },
  );

  it('fails closed with an empty diagnostic dateKey for an invalid Date', () => {
    expect(getChinaWorkdayInfo(new Date(Number.NaN))).toEqual({
      dateKey: '',
      kind: 'calendar_data_missing',
      isWorkday: false,
      supported: false,
      name: '日期格式无效',
    });
  });
});

describe('legacy holiday helpers', () => {
  it('keeps getHolidayInfo compatible for holidays and adjusted workdays', () => {
    expect(getHolidayInfo('2026-05-01')).toEqual({
      name: '劳动节',
      isHoliday: true,
      isAdjustedWorkday: false,
      source: OFFICIAL_2026_SOURCE,
    });
    expect(getHolidayInfo('2026-05-09')).toEqual({
      name: '',
      isHoliday: false,
      isAdjustedWorkday: true,
      source: OFFICIAL_2026_SOURCE,
    });
  });

  it('keeps getLongWhiteRestInfo compatible for all supported day kinds', () => {
    expect(getLongWhiteRestInfo('2026-05-01')).toEqual({
      isRestDay: true,
      reason: '劳动节',
      isOfficialHoliday: true,
      isAdjustedWorkday: false,
    });
    expect(getLongWhiteRestInfo('2026-05-09')).toEqual({
      isRestDay: false,
      reason: '调休上班',
      isOfficialHoliday: false,
      isAdjustedWorkday: true,
    });
    expect(getLongWhiteRestInfo('2026-08-01')).toEqual({
      isRestDay: true,
      reason: '周末',
      isOfficialHoliday: false,
      isAdjustedWorkday: false,
    });
    expect(getLongWhiteRestInfo('2026-08-03')).toEqual({
      isRestDay: false,
      reason: '工作日',
      isOfficialHoliday: false,
      isAdjustedWorkday: false,
    });
  });

  it('makes the legacy long-white helper fail closed for a missing year', () => {
    expect(getLongWhiteRestInfo('2027-08-02')).toEqual({
      isRestDay: true,
      reason: '缺少 2027 年法定节假日日历',
      isOfficialHoliday: false,
      isAdjustedWorkday: false,
    });
  });
});
