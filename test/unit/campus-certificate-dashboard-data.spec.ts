import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildCertificateCalendarMonths,
  getExpiringCertificateLabel,
  selectCertificateExpiryEvents,
  selectCertificateMetricPeople,
  selectCertificateBuildingPeople,
  selectCertificateBuildingRoster,
  summarizeCertificateBuildingPeople,
} from '../../client/src/pages/CampusCertificateDashboard/data';
import {
  getDashboardStatusPresentation,
  paginateNonCompliantPeople,
} from '../../client/src/pages/CampusCertificateDashboard/logic';
import {
  buildExpiryCalendarFromEvents,
  type CertificateFilter,
} from '../../client/src/pages/CampusCertificateDashboard/model';

const people = [
  {
    id: 'person-a',
    name: '甲',
    building: 'A楼',
    position: '值班员',
    team: 'A班',
    complianceStatus: '合规' as const,
    missingCertificate: '',
    highVoltageValid: true,
    lowVoltageValid: true,
    heightWorkValid: false,
    highVoltageExpiryDate: '2026-08-05',
    lowVoltageExpiryDate: '2027-01-10',
    heightWorkExpiryDate: null,
    expiryReminder: '高压证将在19天后到期',
  },
  {
    id: 'person-b',
    name: '乙',
    building: 'B楼',
    position: '暖通工程师',
    team: '长白',
    complianceStatus: '不合规' as const,
    missingCertificate: '低压电工证',
    highVoltageValid: false,
    lowVoltageValid: false,
    heightWorkValid: true,
    highVoltageExpiryDate: null,
    lowVoltageExpiryDate: null,
    heightWorkExpiryDate: '2028-02-03',
    expiryReminder: '',
  },
];

describe('campus certificate dashboard live data helpers', () => {
  it('drills each building series to the matching people only', () => {
    const sample = [
      people[0],
      { ...people[1], building: 'A楼' },
      { ...people[0], id: 'not-applicable', complianceStatus: '不涉及' },
    ];
    expect(
      selectCertificateBuildingPeople(sample, 'A楼', 'compliant').map(
        (person) => person.id,
      ),
    ).toEqual(['person-a']);
    expect(
      selectCertificateBuildingPeople(sample, 'A楼', 'non-compliant').map(
        (person) => person.id,
      ),
    ).toEqual(['person-b']);
    expect(
      selectCertificateBuildingPeople(sample, 'A楼', 'rate').map(
        (person) => person.id,
      ),
    ).toEqual(['person-a', 'person-b']);
    expect(
      selectCertificateBuildingRoster(sample, 'A楼').map((person) => person.id),
    ).toEqual(['person-a', 'person-b', 'not-applicable']);
  });
  it('counts every assigned person in the building, including non-applicable and unclassified people', () => {
    const sample = [
      people[0],
      { ...people[1], building: 'C楼' },
      {
        ...people[0],
        id: 'no-certificate',
        building: 'C楼',
        complianceStatus: '不涉及',
      },
      {
        ...people[0],
        id: 'pending-review',
        building: 'C楼',
        complianceStatus: '未知',
      },
    ];

    expect(summarizeCertificateBuildingPeople(sample, 'C楼')).toEqual({
      total: 3,
      notApplicable: 1,
      unclassified: 1,
    });
    expect(
      selectCertificateBuildingRoster(sample, 'C楼').map((person) => person.id),
    ).toEqual(['person-b', 'no-certificate', 'pending-review']);
  });
  it('paginates real non-compliant rows in groups of four and clamps stale pages', () => {
    const rows = Array.from({ length: 9 }, (_, index) => ({
      id: `person-${index + 1}`,
    }));

    expect(paginateNonCompliantPeople(rows, 1)).toMatchObject({
      page: 1,
      pageCount: 3,
      total: 9,
      hasPrevious: false,
      hasNext: true,
      items: rows.slice(0, 4),
    });
    expect(paginateNonCompliantPeople(rows, 2)).toMatchObject({
      page: 2,
      pageCount: 3,
      hasPrevious: true,
      hasNext: true,
      items: rows.slice(4, 8),
    });
    expect(paginateNonCompliantPeople(rows, 99)).toMatchObject({
      page: 3,
      pageCount: 3,
      hasPrevious: true,
      hasNext: false,
      items: rows.slice(8),
    });
    expect(paginateNonCompliantPeople([], 3)).toMatchObject({
      page: 1,
      pageCount: 1,
      total: 0,
      hasPrevious: false,
      hasNext: false,
      items: [],
    });
  });

  it('uses semantic refresh status colors and only auto-dismisses success', () => {
    expect(getDashboardStatusPresentation('success')).toEqual({
      className: 'certificate-refresh-status-success',
      autoDismissMs: 4000,
    });
    expect(getDashboardStatusPresentation('warning')).toEqual({
      className: 'certificate-refresh-status-warning',
      autoDismissMs: null,
    });
    expect(getDashboardStatusPresentation('error')).toEqual({
      className: 'certificate-refresh-status-error',
      autoDismissMs: null,
    });
  });

  it('selects detail people with the same predicate as each metric card', () => {
    expect(
      selectCertificateMetricPeople(people, 'high-voltage').map(
        (person) => person.id,
      ),
    ).toEqual(['person-a']);
    expect(
      selectCertificateMetricPeople(people, 'low-voltage').map(
        (person) => person.id,
      ),
    ).toEqual(['person-a']);
    expect(
      selectCertificateMetricPeople(people, 'height-work').map(
        (person) => person.id,
      ),
    ).toEqual(['person-b']);
    expect(
      selectCertificateMetricPeople(people, 'expiring').map(
        (person) => person.id,
      ),
    ).toEqual(['person-a']);
    expect(
      selectCertificateMetricPeople(people, 'compliant').map(
        (person) => person.id,
      ),
    ).toEqual(['person-a']);
    expect(
      selectCertificateMetricPeople(people, 'non-compliant').map(
        (person) => person.id,
      ),
    ).toEqual(['person-b']);
  });

  it('keeps qualifying structured expiry names in stable order through the inclusive 90-day boundary', () => {
    const events = [
      {
        id: 'event-day-zero',
        personId: 'person-a',
        personName: '甲',
        building: 'A楼',
        category: 'low-voltage' as const,
        certificateName: '低压电工证',
        date: '2026-07-23',
      },
      {
        id: 'event-duplicate',
        personId: 'person-a',
        personName: '甲',
        building: 'A楼',
        category: 'low-voltage' as const,
        certificateName: ' 低压电工证 ',
        date: '2026-08-01',
      },
      {
        id: 'event-day-ninety',
        personId: 'person-a',
        personName: '甲',
        building: 'A楼',
        category: 'height-work' as const,
        certificateName: '高处作业证',
        date: '2026-10-21',
      },
      {
        id: 'event-past',
        personId: 'person-a',
        personName: '甲',
        building: 'A楼',
        category: 'high-voltage' as const,
        certificateName: '高压电工证',
        date: '2026-07-22',
      },
      {
        id: 'event-day-ninety-one',
        personId: 'person-a',
        personName: '甲',
        building: 'A楼',
        category: 'high-voltage' as const,
        certificateName: '高压电工证',
        date: '2026-10-22',
      },
      {
        id: 'event-other-person',
        personId: 'person-b',
        personName: '乙',
        building: 'B楼',
        category: 'high-voltage' as const,
        certificateName: '高压电工证',
        date: '2026-07-23',
      },
      {
        id: 'event-empty-name',
        personId: 'person-a',
        personName: '甲',
        building: 'A楼',
        category: 'high-voltage' as const,
        certificateName: '   ',
        date: '2026-07-23',
      },
    ];

    expect(
      getExpiringCertificateLabel(
        { ...people[0], expiryReminder: '' },
        events,
        '2026-07-23T08:30:00+08:00',
      ),
    ).toBe('低压电工证、高处作业证 / 临期证件');
  });

  it('uses the Shanghai calendar date for timezone timestamps without shifting date-only input', () => {
    const events = [
      {
        id: 'event-shanghai-day-ninety',
        personId: 'person-a',
        personName: '甲',
        building: 'A楼',
        category: 'height-work' as const,
        certificateName: '高处作业证',
        date: '2026-10-21',
      },
      {
        id: 'event-shanghai-day-ninety-one',
        personId: 'person-a',
        personName: '甲',
        building: 'A楼',
        category: 'low-voltage' as const,
        certificateName: '低压电工证',
        date: '2026-10-22',
      },
    ];
    const expiringPerson = { ...people[0], expiryReminder: '' };

    expect(
      getExpiringCertificateLabel(
        expiringPerson,
        events,
        '2026-07-22T16:30:00.000Z',
      ),
    ).toBe('高处作业证 / 临期证件');
    expect(
      getExpiringCertificateLabel(expiringPerson, events, '2026-07-23'),
    ).toBe('高处作业证 / 临期证件');
  });

  it('normalizes multiple reminder certificate aliases including refrigeration', () => {
    expect(
      getExpiringCertificateLabel(
        {
          ...people[0],
          expiryReminder:
            '高压证、低压证将在30天后到期；登高证、高处作业证和制冷证将在90天内到期',
        },
        [],
        '2026-07-23',
      ),
    ).toBe('高压电工证、低压电工证、高处作业证、制冷证 / 临期证件');
  });

  it('ignores certificate names outside explicit expiry reminder clauses', () => {
    expect(
      getExpiringCertificateLabel(
        {
          ...people[0],
          expiryReminder: '低压证已续证，高压证将在17天后到期',
        },
        [],
        '2026-07-23',
      ),
    ).toBe('高压电工证 / 临期证件');
  });

  it('uses an explicit fallback when no certificate name can be identified', () => {
    expect(
      getExpiringCertificateLabel(
        { ...people[0], expiryReminder: '有证书即将到期，请核对' },
        [],
        '2026-07-23',
      ),
    ).toBe('证书名称待核对 / 临期证件');
  });

  it('builds a continuous selectable month range around live expiry events', () => {
    expect(
      buildCertificateCalendarMonths(
        [
          {
            id: 'event-1',
            personId: 'person-a',
            personName: '甲',
            building: 'A楼',
            category: 'high-voltage',
            certificateName: '高压电工证',
            date: '2026-05-12',
          },
          {
            id: 'event-2',
            personId: 'person-b',
            personName: '乙',
            building: 'B楼',
            category: 'low-voltage',
            certificateName: '低压电工证',
            date: '2026-08-20',
          },
        ],
        '2026-07',
      ),
    ).toEqual(['2026-05', '2026-06', '2026-07', '2026-08']);
  });

  it('selects one calendar day with the active certificate filter and keeps multiple certificates', () => {
    const events = [
      {
        id: 'event-b',
        personId: 'person-b',
        personName: '乙',
        building: 'B楼',
        category: 'low-voltage' as const,
        certificateName: '低压电工证',
        date: '2026-07-28',
      },
      {
        id: 'event-a2',
        personId: 'person-a',
        personName: '甲',
        building: 'A楼',
        category: 'height-work' as const,
        certificateName: '高处作业证',
        date: '2026-07-28',
      },
      {
        id: 'event-a1',
        personId: 'person-a',
        personName: '甲',
        building: 'A楼',
        category: 'high-voltage' as const,
        certificateName: '高压电工证',
        date: '2026-07-28',
      },
      {
        id: 'event-other-day',
        personId: 'person-c',
        personName: '丙',
        building: 'C楼',
        category: 'high-voltage' as const,
        certificateName: '高压电工证',
        date: '2026-07-29',
      },
    ];

    expect(
      selectCertificateExpiryEvents(events, '2026-07-28', 'all').map(
        (event) => event.id,
      ),
    ).toEqual(['event-a1', 'event-a2', 'event-b']);
    expect(
      selectCertificateExpiryEvents(events, '2026-07-28', 'high-voltage').map(
        (event) => event.id,
      ),
    ).toEqual(['event-a1']);
    expect(selectCertificateExpiryEvents(events, '2026-07-30', 'all')).toEqual(
      [],
    );
    expect(events.map((event) => event.id)).toEqual([
      'event-b',
      'event-a2',
      'event-a1',
      'event-other-day',
    ]);
  });

  it.each<CertificateFilter>([
    'all',
    'high-voltage',
    'low-voltage',
    'height-work',
  ])('builds a 42-cell live calendar for %s', (filter) => {
    const events = [
      {
        id: 'event-1',
        personId: 'person-a',
        personName: '甲',
        building: 'A楼',
        category: 'high-voltage' as const,
        certificateName: '高压电工证',
        date: '2026-07-12',
      },
      {
        id: 'event-2',
        personId: 'person-b',
        personName: '乙',
        building: 'B楼',
        category: 'low-voltage' as const,
        certificateName: '低压电工证',
        date: '2026-07-12',
      },
    ];
    const calendar = buildExpiryCalendarFromEvents('2026-07', filter, events);
    const july12 = calendar.cells.find(
      (cell) => cell.kind === 'day' && cell.date === '2026-07-12',
    );
    const expectedCount =
      filter === 'all' || filter === 'high-voltage' || filter === 'low-voltage'
        ? filter === 'all'
          ? 2
          : 1
        : 0;

    expect(calendar.cells).toHaveLength(42);
    expect(july12).toMatchObject({
      kind: 'day',
      count: expectedCount,
      level: expectedCount,
    });
  });

  it('wires the page to the real dashboard API and detail dialog', () => {
    const apiSource = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );
    const pageSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/index.tsx',
      ),
      'utf8',
    );
    const dialogSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/CertificateMetricDetailDialog.tsx',
      ),
      'utf8',
    );

    expect(apiSource).toContain(
      'export async function getCampusCertificateDashboard',
    );
    expect(apiSource).toContain(
      "url: '/api/bitable/campus-certificate-dashboard'",
    );
    expect(pageSource).toContain('getCampusCertificateDashboard');
    expect(pageSource).toContain('<CertificateMetricDetailDialog');
    expect(pageSource).toContain('expiryEvents={currentExpiryEvents}');
    expect(pageSource).toMatch(
      /referenceDate=\{\s*dashboardData\?\.sourceUpdatedAt\s*\|\|\s*dashboardData\?\.syncedAt\s*\|\|\s*''\s*\}/,
    );
    expect(dialogSource).toMatch(
      /detailKey\s*===\s*'expiring'\s*\?\s*getExpiringCertificateLabel\(\s*person,\s*expiryEvents,\s*referenceDate,\s*\)\s*:\s*getCertificateName\(detailKey\)/,
    );
    expect(pageSource).toContain('<CertificateExpiryDayDetailDialog');
    expect(pageSource).toContain('onDateSelect={setActiveExpiryDate}');
    expect(pageSource).toContain(
      'getCampusCertificateExpiryNotificationPreview',
    );
    expect(pageSource).toContain('sendCampusCertificateExpiryNotifications');
    expect(pageSource).not.toContain(
      'setLastUpdated(formatDashboardTimestamp(new Date()))',
    );
  });

  it('never falls back to demo business data while loading or after an initial failure', () => {
    const pageSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/index.tsx',
      ),
      'utf8',
    );

    expect(pageSource).not.toMatch(
      /import\s*\{[\s\S]*\b(?:dashboardSummary|certificateMetrics|buildingCompliance|nonCompliantPeople|CERTIFICATE_MONTHS)\b[\s\S]*\}\s*from\s*['"]\.\/model['"]/,
    );
    expect(pageSource).toContain('正在同步飞书持证数据');
    expect(pageSource).toContain('持证数据加载失败');
    expect(pageSource).toContain('重试');
    expect(pageSource).toMatch(
      /data-screenshot-ready=\{\s*dashboardData\s*!==\s*null/,
    );
  });

  it('keeps summary cards on API summary values and wires all eight cards to details', () => {
    const pageSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/index.tsx',
      ),
      'utf8',
    );

    expect(pageSource).toContain('currentSummary.compliantPeople');
    expect(pageSource).toContain('currentSummary.nonCompliantPeople');
    expect(pageSource).toContain('currentSummary.averageComplianceRate');
    expect(pageSource).toContain(
      "onClick={() => setActiveDetailKey('non-compliant')}",
    );
    expect(pageSource).toContain('查看园区整体持证合规差距清单');
    expect(pageSource).toContain('currentPagePeople.map');
    expect(pageSource).toContain('setPeoplePage(1)');
    expect(pageSource).toContain('共 {peoplePagination.total} 条');
  });

  it('renders explicit empty states in both people and building detail tables', () => {
    const dialogSource = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/CampusCertificateDashboard/CertificateMetricDetailDialog.tsx',
      ),
      'utf8',
    );

    expect(dialogSource).toContain('暂无符合该指标的人员明细');
    expect(dialogSource).toContain('暂无楼栋合规明细');
    expect(dialogSource).toContain('className="certificate-detail-empty"');
  });
});
