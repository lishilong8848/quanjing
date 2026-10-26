import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import { mapCampusCertificateDashboard } from './certificate-dashboard.mapper';

const BUILDING_EXPECTATIONS = [
  { building: '110站', compliant: 8, nonCompliant: 0, rate: 100 },
  { building: 'A楼', compliant: 11, nonCompliant: 0, rate: 100 },
  { building: 'H楼', compliant: 15, nonCompliant: 0, rate: 100 },
  { building: 'D楼', compliant: 11, nonCompliant: 0, rate: 100 },
  { building: 'E楼', compliant: 10, nonCompliant: 2, rate: 83 },
  { building: 'C楼', compliant: 10, nonCompliant: 0, rate: 100 },
  { building: 'B楼', compliant: 8, nonCompliant: 2, rate: 80 },
] as const;

function buildVerifiedRecords(): BitableRecordItem[] {
  const records: BitableRecordItem[] = [];
  let index = 0;

  for (const building of BUILDING_EXPECTATIONS) {
    for (let count = 0; count < building.compliant; count += 1) {
      records.push(buildRecord(index, building.building, '合规'));
      index += 1;
    }
    for (let count = 0; count < building.nonCompliant; count += 1) {
      records.push(buildRecord(index, building.building, '不合规'));
      index += 1;
    }
  }

  for (let count = 0; count < 14; count += 1) {
    records.push(buildRecord(index, 'H楼', '不涉及'));
    index += 1;
  }

  return records;
}

function buildRecord(
  index: number,
  building: string,
  complianceStatus: string,
): BitableRecordItem {
  return {
    record_id: `rec-${index + 1}`,
    fields: {
      姓名: `人员${index + 1}`,
      班组: index % 2 === 0 ? ['A班'] : 'B班',
      岗位: ['运维值班员'],
      体系岗位: ['值班员'],
      楼栋: building,
      证书是否合规: complianceStatus,
      缺少证书: complianceStatus === '不合规' ? '高压电工证' : '',
      高压证是否有效: index < 68 ? '✔️' : '',
      低压证是否有效: index < 72 ? '有效' : '',
      登高证是否有效: index < 7 ? true : false,
      高压证到期日期: index === 0 ? '2026/12/17' : null,
      低压证到期日期: index === 0 ? 1786896000000 : null,
      登高证到期日期: index === 0 ? { timestamp: 1811289600000 } : null,
      月度临期提示: index < 8 ? '低压证将在30天后到期' : '',
      更新时间:
        index === 90 ? '2026-07-17T03:00:56.000Z' : '2026-07-16T03:00:56.000Z',
      身份证号: `sensitive-id-${index + 1}`,
      员工工号: `sensitive-number-${index + 1}`,
      高压证: [{ file_token: `sensitive-attachment-${index + 1}` }],
    },
  };
}

describe('mapCampusCertificateDashboard', () => {
  it('ignores stale negative reminders and empty epoch expiry dates', () => {
    const record = buildRecord(20, 'A楼', '合规');
    record.fields = {
      ...record.fields,
      低压证到期日期: 0,
      月度临期提示: '制冷证将在-20726天后到期',
    };

    const result = mapCampusCertificateDashboard(
      [record],
      '2026-09-30T04:00:00.000Z',
    );

    expect(result.people[0].expiryReminder).toBe('');
    expect(result.people[0].lowVoltageExpiryDate).toBeNull();
    expect(result.expiryEvents).toEqual([]);
    expect(result.certificateMetrics.find((metric) => metric.id === 'expiring')?.value).toBe(0);
  });

  it('retains each certificate in a valid combined reminder', () => {
    const record = buildRecord(20, 'A楼', '合规');
    record.fields = {
      ...record.fields,
      月度临期提示: '高压证、低压证将在30天后到期；制冷证将在90天内到期',
    };

    const result = mapCampusCertificateDashboard([record], '2026-09-30T04:00:00.000Z');

    expect(result.people[0].expiryReminder).toContain('高压证将在30天后到期');
    expect(result.people[0].expiryReminder).toContain('低压证将在30天后到期');
    expect(result.people[0].expiryReminder).toContain('制冷证将在90天内到期');
  });

  it('maps the verified 91-record certificate dataset into dashboard totals', () => {
    const result = mapCampusCertificateDashboard(
      buildVerifiedRecords(),
      '2026-07-17T04:00:00.000Z',
    );

    expect(result.summary).toEqual({
      totalPeople: 91,
      compliantPeople: 73,
      nonCompliantPeople: 4,
      notApplicablePeople: 14,
      currentQualified: 86,
      targetQualified: 90,
      complianceRate: 95.6,
      totalCertificates: 147,
      averageComplianceRate: 97.3,
    });
    expect(
      Object.fromEntries(
        result.certificateMetrics.map((metric) => [metric.id, metric.value]),
      ),
    ).toEqual({
      'high-voltage': 68,
      'low-voltage': 72,
      'height-work': 7,
      expiring: 8,
    });
    expect(result.buildingCompliance).toEqual(BUILDING_EXPECTATIONS);
    expect(result.nonCompliantPeople).toHaveLength(4);
    expect(result.people).toHaveLength(91);
    expect(result.sourceUpdatedAt).toBe('2026-07-17T03:00:56.000Z');
    expect(result.syncedAt).toBe('2026-07-17T04:00:00.000Z');
    expect(result.sourceStatus).toBe('fresh');
  });

  it('only exposes the approved person fields and creates calendar expiry events', () => {
    const result = mapCampusCertificateDashboard(
      [buildRecord(0, 'A楼', '合规')],
      '2026-07-17T04:00:00.000Z',
    );

    expect(result.people[0]).toEqual({
      id: 'rec-1',
      name: '人员1',
      building: 'A楼',
      position: '运维值班员',
      team: 'A班',
      complianceStatus: '合规',
      missingCertificate: '',
      highVoltageValid: true,
      lowVoltageValid: true,
      heightWorkValid: true,
      highVoltageExpiryDate: '2026-12-17',
      lowVoltageExpiryDate: '2026-08-17',
      heightWorkExpiryDate: '2027-05-26',
      expiryReminder: '低压电工证将在31天后到期',
    });
    expect(result.expiryEvents).toEqual([
      {
        id: 'rec-1-high-voltage-2026-12-17',
        date: '2026-12-17',
        category: 'high-voltage',
        personId: 'rec-1',
        personName: '人员1',
        building: 'A楼',
        certificateName: '高压电工证',
      },
      {
        id: 'rec-1-low-voltage-2026-08-17',
        date: '2026-08-17',
        category: 'low-voltage',
        personId: 'rec-1',
        personName: '人员1',
        building: 'A楼',
        certificateName: '低压电工证',
      },
      {
        id: 'rec-1-height-work-2027-05-26',
        date: '2027-05-26',
        category: 'height-work',
        personId: 'rec-1',
        personName: '人员1',
        building: 'A楼',
        certificateName: '高处作业证',
      },
    ]);

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('身份证号');
    expect(serialized).not.toContain('员工工号');
    expect(serialized).not.toContain('sensitive-id-');
    expect(serialized).not.toContain('sensitive-number-');
    expect(serialized).not.toContain('sensitive-attachment-');
  });

  it('handles missing and malformed fields without treating them as compliant', () => {
    const result = mapCampusCertificateDashboard(
      [
        {
          record_id: 'rec-malformed',
          last_modified_time: 1784257256000,
          fields: {
            员工姓名: [{ name: '备用姓名' }],
            机楼专业: ['暖通', 'E楼'],
            体系岗位: '暖通专业工程师',
            持证统计: '高压电工证',
            证书是否合规: '异常值',
            更新时间: 'not-a-date',
          },
        },
      ],
      '2026-07-17T04:00:00.000Z',
    );

    expect(result.people[0]).toMatchObject({
      name: '备用姓名',
      building: 'E楼',
      position: '暖通专业工程师',
      complianceStatus: '未知',
      highVoltageValid: true,
      lowVoltageValid: false,
      heightWorkValid: false,
    });
    expect(result.summary).toMatchObject({
      compliantPeople: 0,
      nonCompliantPeople: 0,
      notApplicablePeople: 0,
    });
    expect(result.sourceUpdatedAt).toBe('2026-07-17T03:00:56.000Z');
  });

  it('derives compliance when Feishu returns formula option ids', () => {
    const result = mapCampusCertificateDashboard(
      [
        {
          record_id: 'rec-compliant',
          fields: {
            姓名: '合规人员',
            楼栋: 'A楼',
            证书是否合规: ['optr63Dphp'],
          },
        },
        {
          record_id: 'rec-not-applicable',
          fields: {
            姓名: '不涉及人员',
            楼栋: 'H楼',
            证书是否合规: ['optixgST5g'],
            缺少证书: [{ text: '无', type: 'text' }],
          },
        },
        {
          record_id: 'rec-non-compliant',
          fields: {
            姓名: '不合规人员',
            楼栋: 'E楼',
            证书是否合规: ['optU2Gi5Q4'],
            缺少证书: [{ text: '低压电工证', type: 'text' }],
          },
        },
        {
          record_id: 'rec-unknown-empty',
          fields: {
            姓名: '未知人员一',
            楼栋: 'B楼',
            证书是否合规: ['optUnknown'],
          },
        },
        {
          record_id: 'rec-unknown-missing',
          fields: {
            姓名: '未知人员二',
            楼栋: 'C楼',
            证书是否合规: ['optAnotherUnknown'],
            缺少证书: '低压电工证',
          },
        },
      ],
      '2026-07-17T04:00:00.000Z',
    );

    expect(result.people.map((person) => person.complianceStatus)).toEqual([
      '合规',
      '不涉及',
      '不合规',
      '未知',
      '未知',
    ]);
    expect(result.summary).toMatchObject({
      compliantPeople: 1,
      notApplicablePeople: 1,
      nonCompliantPeople: 1,
    });
  });

  it('uses the readable building field when the formula field returns option ids', () => {
    const result = mapCampusCertificateDashboard(
      [
        {
          record_id: 'rec-building-formula',
          fields: {
            姓名: '楼栋映射人员',
            楼栋: ['opt601tBh1'],
            '机楼/专业': ['电气', 'H楼'],
            证书是否合规: '合规',
          },
        },
      ],
      '2026-07-17T04:00:00.000Z',
    );

    expect(result.people[0]?.building).toBe('H楼');
    expect(
      result.buildingCompliance.find(({ building }) => building === 'H楼'),
    ).toEqual({
      building: 'H楼',
      compliant: 1,
      nonCompliant: 0,
      rate: 100,
    });
  });

  it.each([
    ['opt8Ll1tGG', '110站'],
    ['optoYag9Yd', 'A楼'],
    ['opt601tBh1', 'H楼'],
    ['opt34QiiO3', 'D楼'],
    ['optciYId6U', 'E楼'],
    ['optSnsb7yW', 'C楼'],
    ['optlwTsAAK', 'B楼'],
  ])(
    'uses the verified building option fallback %s -> %s',
    (optionId, building) => {
      const result = mapCampusCertificateDashboard(
        [
          {
            record_id: `rec-${optionId}`,
            fields: {
              姓名: '楼栋映射人员',
              楼栋: [optionId],
              证书是否合规: '合规',
            },
          },
        ],
        '2026-07-17T04:00:00.000Z',
      );

      expect(result.people[0]?.building).toBe(building);
    },
  );
});
