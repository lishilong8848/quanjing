import {
  buildOrganizationPersonQualityAssessment,
  mapOrganizationPersonProfileRecord,
  maskOrganizationPersonIdCard,
  mergeOrganizationPersonCertificatesFromDashboard,
} from '../../server/modules/bitable-sync/organization-person-profile.mapper';
import type { CampusCertificatePerson } from '../../shared/api.interface';

describe('organization person profile mapper', () => {
  it('normalizes a populated personnel record into the safe detail contract', () => {
    const profile = mapOrganizationPersonProfileRecord({
      record_id: 'rec-profile-1',
      last_modified_time: '1787241600000',
      fields: {
        姓名: '林昊',
        员工工号: 'NT-2023-047',
        岗位: '运维值班长',
        体系岗位: '设施运维',
        公司名称: '南通承宏云计算有限公司',
        用工性质: '420',
        '机楼/专业': ['A楼', '电气'],
        班组: 'A1班',
        班次: '白班',
        示例人员001: '周明远',
        联系方式: '13800004144',
        电子邮箱: 'linhao@example.com',
        身份证号: '32061219930309241X',
        入职日期: 1686499200000,
        离职日期: '2026/08/20',
        离职原因: '个人发展',
        '离职/异动情况': '已离职',
        学历: '本科',
        毕业院校: '南京工程学院',
        所学专业: '电气工程及其自动化',
        毕业时间: '2021-06-30',
        兴趣爱好: ['阅读', '羽毛球'],
        车牌号: '苏F·7A23X',
        特长标签: ['电气倒闸', '柴发并机'],
        MBTI: ' istj ',
        责任心: 101,
        稳定性: 93,
        协作力: -4,
        成长潜力: '87',
        电气运维: 92,
        暖通基础: 76,
        应急响应: 88,
        安全规范: 90,
        团队协作: 84,
        演练实战: 95,
        培训已完成课程: 18,
        培训课程总数: 20,
        培训完成率: 92,
        培训平均分: 91,
        培训签到率: 100,
        最终考核成绩: 93,
        年度演练次数: 12,
        最近演练评级: 'A',
        最近演练主题: 'A楼柴发并机应急演练',
        最近演练日期: '2026-07-18',
        高压电工证: '有效',
        高压电工证到期日期: '2028-06-30',
        低压电工证: '临期',
        低压电工证到期日期: '2026-09-30',
        高处作业证: '过期',
        高处作业证到期日期: '2026-01-10',
        照片: [{ file_token: 'file-token' }],
      },
    });

    expect(profile).not.toBeNull();
    expect(profile).toMatchObject({
      recordId: 'rec-profile-1',
      name: '林昊',
      employeeNo: 'NT-2023-047',
      employmentStatus: 'departed',
      idCardMasked: '320612********241X',
      entryDate: '2023-06-12',
      departureDate: '2026-08-20',
      mbti: 'ISTJ',
      photoUrl: '/api/bitable/employee-photo/rec-profile-1?scope=organization',
      profileScores: {
        responsibility: 100,
        stability: 93,
        collaboration: 0,
        growthPotential: 87,
      },
      training: {
        completedCourses: 18,
        totalCourses: 20,
        completionRate: 92,
        averageScore: 91,
        attendanceRate: 100,
        finalScore: 93,
      },
      drill: {
        annualCount: 12,
        latestRating: 'A',
        latestTitle: 'A楼柴发并机应急演练',
        latestDate: '2026-07-18',
      },
    });
    expect(profile?.abilities.map((item) => item.score)).toEqual([
      92, 76, 88, 90, 84, 95,
    ]);
    expect(profile?.employmentHistory.map((item) => item.kind)).toEqual([
      'entry',
      'position',
      'departure',
    ]);
    expect(profile?.certificates.map((item) => item.status)).toEqual([
      'valid',
      'expiring',
      'expired',
    ]);
    expect(profile?.certificateSource).toBe('personnel');
    expect(JSON.stringify(profile)).not.toContain('32061219930309241X');
    expect(JSON.stringify(profile)).not.toContain('file-token');
  });

  it('keeps unmaintained assessment fields empty instead of fabricating data', () => {
    const profile = mapOrganizationPersonProfileRecord({
      record_id: 'rec-profile-empty',
      fields: {
        姓名: '示例人员016',
        岗位: '运维值班员',
      },
    });

    expect(profile?.employmentStatus).toBe('active');
    expect(profile?.mbti).toBeNull();
    expect(profile?.profileScores).toEqual({
      responsibility: null,
      stability: null,
      collaboration: null,
      growthPotential: null,
    });
    expect(profile?.abilities.every((item) => item.score === null)).toBe(true);
    expect(profile?.training).toEqual({
      completedCourses: null,
      totalCourses: null,
      completionRate: null,
      averageScore: null,
      attendanceRate: null,
      finalScore: null,
    });
    expect(profile?.drill).toEqual({
      annualCount: null,
      latestRating: null,
      latestTitle: null,
      latestDate: null,
    });
    expect(profile?.certificates).toEqual([]);
    expect(profile?.certificateSource).toBeNull();
    expect(profile?.qualityAssessment).toEqual({
      status: 'unavailable',
      records: [],
      sourceUpdatedAt: null,
    });
  });

  it('maps exact quality issue mentions into the stable personnel archive', () => {
    const assessment = buildOrganizationPersonQualityAssessment(
      'rec-person-zhang',
      {
        fetchedAt: Date.parse('2026-08-20T02:00:00.000Z'),
        expiresAt: Date.parse('2026-08-20T03:00:00.000Z'),
        records: [
          {
            record_id: 'quality-a-july',
            fields: {
              月份: '7月',
              楼栋: 'A楼',
              检查项目: '值班纪律',
              问题: '示例人员008睡岗',
              问题补充描述: '已提醒整改',
              问题图片: [
                {
                  name: '现场.jpg',
                  type: 'image/jpeg',
                  size: 1024,
                  file_token: 'must-not-leak',
                },
              ],
            },
          },
        ],
      },
      [
        {
          record_id: 'rec-person-zhang',
          fields: {
            姓名: '示例人员008',
            员工姓名: [{ name: '示例人员008', open_id: 'ou_zhang' }],
            '机楼/专业': ['A楼'],
          },
        },
      ],
      Date.parse('2026-08-20T02:30:00.000Z'),
    );

    expect(assessment).toMatchObject({
      status: 'ready',
      sourceUpdatedAt: '2026-08-20T02:00:00.000Z',
      records: [
        {
          id: 'quality-a-july',
          year: null,
          month: '7月',
          building: 'A楼',
          item: '值班纪律',
          issue: '示例人员008睡岗',
        },
      ],
    });
    expect(JSON.stringify(assessment)).not.toContain('ou_zhang');
    expect(JSON.stringify(assessment)).not.toContain('must-not-leak');
  });

  it('distinguishes an unavailable quality snapshot from a verified empty archive', () => {
    expect(
      buildOrganizationPersonQualityAssessment('rec-person', null, []),
    ).toEqual({
      status: 'unavailable',
      records: [],
      sourceUpdatedAt: null,
    });

    expect(
      buildOrganizationPersonQualityAssessment(
        'rec-person',
        { records: [], fetchedAt: 1, expiresAt: 2 },
        [],
        1,
      ),
    ).toEqual({
      status: 'ready',
      records: [],
      sourceUpdatedAt: '1970-01-01T00:00:00.001Z',
    });
  });

  it('merges authoritative certificate-table records and preserves unrelated certificates', () => {
    const profile = mapOrganizationPersonProfileRecord({
      record_id: 'rec-profile-certificate-merge',
      fields: {
        姓名: '示例人员006',
        '机楼/专业': ['H楼', '电气'],
        高压电工证: '有效',
        高压电工证到期日期: '2027-01-01',
      },
    });
    expect(profile).not.toBeNull();

    const merged = mergeOrganizationPersonCertificatesFromDashboard(
      {
        ...profile!,
        certificates: [
          ...profile!.certificates,
          {
            id: 'fire-operator',
            name: '消防设施操作员',
            status: 'valid',
            expiryDate: '2029-05-01',
          },
        ],
      },
      [
        certificatePerson({
          name: '示例人员006',
          building: 'H楼',
          highVoltageValid: true,
          highVoltageExpiryDate: '2028-06-30',
          lowVoltageValid: true,
          lowVoltageExpiryDate: '2026-09-10',
          heightWorkValid: false,
          heightWorkExpiryDate: '2026-01-10',
        }),
      ],
      new Date('2026-08-22T00:00:00+08:00'),
    );

    expect(merged.certificateSource).toBe('certificate');
    expect(merged.certificates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'fire-operator', status: 'valid' }),
        expect.objectContaining({ id: 'high-voltage', status: 'valid' }),
        expect.objectContaining({ id: 'low-voltage', status: 'expiring' }),
        expect.objectContaining({ id: 'work-at-height', status: 'expired' }),
      ]),
    );
    expect(
      merged.certificates.find((item) => item.id === 'high-voltage')
        ?.expiryDate,
    ).toBe('2028-06-30');
  });

  it('uses building to disambiguate duplicate names and refuses an ambiguous match', () => {
    const profile = mapOrganizationPersonProfileRecord({
      record_id: 'rec-profile-duplicate-name',
      fields: { 姓名: '同名人员', '机楼/专业': ['B楼'] },
    })!;
    const hBuilding = certificatePerson({
      id: 'certificate-h',
      name: '同名人员',
      building: 'H楼',
      highVoltageValid: true,
      highVoltageExpiryDate: '2028-01-01',
    });
    const bBuilding = certificatePerson({
      id: 'certificate-b',
      name: '同名人员',
      building: 'B楼',
      lowVoltageValid: true,
      lowVoltageExpiryDate: '2028-02-02',
    });

    const disambiguated = mergeOrganizationPersonCertificatesFromDashboard(
      profile,
      [hBuilding, bBuilding],
      new Date('2026-08-22T00:00:00+08:00'),
    );
    expect(disambiguated.certificateSource).toBe('certificate');
    expect(disambiguated.certificates).toEqual([
      expect.objectContaining({ id: 'low-voltage', expiryDate: '2028-02-02' }),
    ]);

    const ambiguous = mergeOrganizationPersonCertificatesFromDashboard(
      profile,
      [bBuilding, { ...bBuilding, id: 'certificate-b-2' }],
      new Date('2026-08-22T00:00:00+08:00'),
    );
    expect(ambiguous).toEqual(profile);
  });

  it('marks a uniquely matched person with no certificates as verified empty', () => {
    const profile = mapOrganizationPersonProfileRecord({
      record_id: 'rec-profile-no-certificate',
      fields: { 姓名: '无证人员', '机楼/专业': ['C楼'] },
    })!;

    const merged = mergeOrganizationPersonCertificatesFromDashboard(
      profile,
      [certificatePerson({ name: '无证人员', building: 'C楼' })],
      new Date('2026-08-22T00:00:00+08:00'),
    );

    expect(merged.certificateSource).toBe('certificate');
    expect(merged.certificates).toEqual([]);
  });

  it('rejects invalid MBTI values and masks short identifiers safely', () => {
    const profile = mapOrganizationPersonProfileRecord({
      record_id: 'rec-profile-invalid',
      fields: { 姓名: '示例人员016', MBTI: 'ABCD' },
    });
    expect(profile?.mbti).toBeNull();
    expect(maskOrganizationPersonIdCard('1234567')).toBe('123****');
    expect(maskOrganizationPersonIdCard('')).toBeNull();
  });

  it('returns null when the stable record id or display name is missing', () => {
    expect(
      mapOrganizationPersonProfileRecord({ fields: { 姓名: '无记录ID' } }),
    ).toBeNull();
    expect(
      mapOrganizationPersonProfileRecord({
        record_id: 'rec-no-name',
        fields: {},
      }),
    ).toBeNull();
  });
});

function certificatePerson(
  overrides: Partial<CampusCertificatePerson>,
): CampusCertificatePerson {
  return {
    id: 'certificate-person',
    name: '示例人员016',
    building: 'A楼',
    position: '运维工程师',
    team: '长白',
    complianceStatus: '合规',
    missingCertificate: '',
    highVoltageValid: false,
    lowVoltageValid: false,
    heightWorkValid: false,
    highVoltageExpiryDate: null,
    lowVoltageExpiryDate: null,
    heightWorkExpiryDate: null,
    expiryReminder: '',
    ...overrides,
  };
}
