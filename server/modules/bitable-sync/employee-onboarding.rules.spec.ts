import type {
  EmployeeOnboardingCreateRequest,
  EmployeeOnboardingCreateResponse,
} from '../../../shared/employee-onboarding';
import {
  EMPLOYEE_ONBOARDING_CLIENT_MUTATION_ID_PREFIX,
  EMPLOYEE_ONBOARDING_COMPANIES,
  EMPLOYEE_ONBOARDING_EDUCATIONS,
  EMPLOYEE_ONBOARDING_EMPLOYMENT_TYPES,
  EMPLOYEE_ONBOARDING_HOBBIES,
  EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE,
  EMPLOYEE_ONBOARDING_POSITIONS,
  EMPLOYEE_ONBOARDING_TEXT_LIMITS,
  isEmployeeOnboardingCreateResponse,
} from '../../../shared/employee-onboarding';
import { ATTACHED_BANK, getAttachedBankDisplayType, scoreAttachedBank } from '../../../shared/mbti-attached-bank-model';
import {
  EmployeeOnboardingRuleError,
  buildEmployeeOnboardingFields,
  parseEmployeeOnboardingRequest,
  toShanghaiDateMilliseconds,
} from './employee-onboarding.rules';

const VALID_MUTATION_ID =
  'employee-onboarding-123e4567-e89b-42d3-a456-426614174000';

function validRequest(
  overrides: Partial<EmployeeOnboardingCreateRequest> = {},
): EmployeeOnboardingCreateRequest {
  const request: EmployeeOnboardingCreateRequest = {
    clientMutationId: VALID_MUTATION_ID,
    name: '自动化测试员工',
    companyName: '南通承宏云计算有限公司',
    position: '运维实习生',
    identityNumber: '110101199001010015',
    phone: '13800007889',
    entryDate: '2026-08-15',
    education: '本科',
    graduateSchool: '自动化测试院校',
    major: '自动化测试专业',
    graduationDate: '2026-06-30',
    hobbies: ['阅读'],
    vehiclePlate: '',
    mbtiAssessment: { participantName: '自动化测试员工', version: 'full', answers: Array(93).fill('A'), sourceSha256: ATTACHED_BANK.sourceSha256 },
    ...overrides,
  };
  if (overrides.name !== undefined && overrides.mbtiAssessment === undefined) {
    request.mbtiAssessment = { ...request.mbtiAssessment, participantName: request.name.trim() };
  }
  return request;
}

function issueFields(error: unknown): string[] {
  expect(error).toBeInstanceOf(EmployeeOnboardingRuleError);
  return (error as EmployeeOnboardingRuleError).issues.map(
    (issue) => issue.field,
  );
}

describe('employee onboarding contract and rules', () => {
  it.each([
    ['南通承宏云计算有限公司', '420'],
    ['北京智航万恒', '102'],
    ['上海科之锐', '生态'],
  ] as const)(
    'derives 用工性质 from the validated company instead of accepting a client value: %s',
    (companyName, employmentType) => {
      const payload = {
        ...validRequest({ companyName }),
      } as Record<string, unknown>;
      delete payload.employmentType;

      expect(buildEmployeeOnboardingFields(payload).用工性质).toBe(
        employmentType,
      );
    },
  );

  it('normalizes values, removes duplicate hobbies in order, and maps only writable Base fields', () => {
    const request = {
      ...validRequest(),
      name: '  自动化测试员工  ',
      identityNumber: '11010519491231002x',
      graduateSchool: '  自动化测试院校 ',
      hobbies: [' 阅读 ', '篮球', '阅读', ' 篮球 '],
      vehiclePlate: '  苏F12345  ',
    };
    const parsed = parseEmployeeOnboardingRequest(request);

    expect(parsed).toEqual({
      ...validRequest(),
      name: '自动化测试员工',
      employmentType: '420',
      mbtiType: getAttachedBankDisplayType(scoreAttachedBank('full', Array(93).fill('A'))),
      identityNumber: '11010519491231002X',
      hobbies: ['阅读', '篮球'],
      vehiclePlate: '苏F12345',
    });
    expect(buildEmployeeOnboardingFields(request)).toEqual({
      MBTI: getAttachedBankDisplayType(scoreAttachedBank('full', Array(93).fill('A'))),
      姓名: '自动化测试员工',
      用工性质: '420',
      公司名称: '南通承宏云计算有限公司',
      岗位: '运维实习生',
      身份证号: '11010519491231002X',
      联系方式: '13800007889',
      入职日期: Date.UTC(2026, 7, 14, 16),
      学历: '本科',
      毕业院校: '自动化测试院校',
      所学专业: '自动化测试专业',
      毕业时间: '2026/06/30',
      兴趣爱好: ['阅读', '篮球'],
      车牌号: '苏F12345',
    });
  });

  it('converts a China-local calendar date to Shanghai midnight without UTC drift', () => {
    expect(toShanghaiDateMilliseconds('2026-01-01')).toBe(
      Date.UTC(2025, 11, 31, 16),
    );
    expect(toShanghaiDateMilliseconds('2026-08-15')).toBe(
      Date.UTC(2026, 7, 14, 16),
    );
  });

  it.each([
    'clientMutationId',
    'name',
    'companyName',
    'position',
    'identityNumber',
    'phone',
    'entryDate',
    'education',
    'graduateSchool',
    'major',
    'graduationDate',
    'hobbies',
    'mbtiAssessment',
  ] as const)('rejects a missing required %s field', (field) => {
    const request = { ...validRequest() } as Record<string, unknown>;
    delete request[field];

    try {
      parseEmployeeOnboardingRequest(request);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(issueFields(error)).toContain(field);
    }
  });

  it.each([
    { participantName: '其他员工', version: 'full', answers: Array(93).fill('A'), sourceSha256: ATTACHED_BANK.sourceSha256 },
    { participantName: '自动化测试员工', version: 'full', answers: Array(92).fill('A'), sourceSha256: ATTACHED_BANK.sourceSha256 },
    { participantName: '自动化测试员工', version: 'full', answers: Array(93).fill('A'), sourceSha256: 'outdated' },
  ])('rejects an assessment that cannot be bound and scored', (mbtiAssessment) => {
    expect(() => parseEmployeeOnboardingRequest({ ...validRequest(), mbtiAssessment })).toThrow(EmployeeOnboardingRuleError);
  });

  it.each([
    ['name', '   '],
    ['graduateSchool', '\t'],
    ['major', ''],
    ['hobbies', []],
    ['hobbies', ['阅读', '   ']],
  ] as const)('rejects an empty required %s value', (field, value) => {
    try {
      parseEmployeeOnboardingRequest({ ...validRequest(), [field]: value });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(issueFields(error)).toContain(field);
    }
  });

  it.each([
    ['companyName', '不存在的公司'],
    ['position', '不存在的岗位'],
    ['education', '博士'],
    ['hobbies', ['阅读', '摄影']],
  ] as const)('rejects an unsupported %s option', (field, value) => {
    try {
      parseEmployeeOnboardingRequest({ ...validRequest(), [field]: value });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(issueFields(error)).toContain(field);
    }
  });

  it('rejects a client-provided employment type so the server mapping is authoritative', () => {
    expect(() =>
      parseEmployeeOnboardingRequest({
        ...validRequest(),
        employmentType: '生态',
      }),
    ).toThrow('不支持的请求字段');
  });

  it.each([
    'employee-onboarding-123e4567-e89b-12d3-a456-426614174000',
    'employee-onboarding-123e4567-e89b-42d3-7456-426614174000',
    'EMPLOYEE-ONBOARDING-123e4567-e89b-42d3-a456-426614174000',
    '123e4567-e89b-42d3-a456-426614174000',
    'employee-onboarding-not-a-uuid',
    '',
  ])('rejects an invalid prefixed UUID v4: %s', (clientMutationId) => {
    expect(() =>
      parseEmployeeOnboardingRequest(validRequest({ clientMutationId })),
    ).toThrow('clientMutationId');
  });

  it.each([
    '110101199001010016',
    '11010119900101001',
    '110101199013010015',
    '110101199002300015',
    'not-an-identity',
  ])(
    'rejects an invalid 18-character identity number: %s',
    (identityNumber) => {
      expect(() =>
        parseEmployeeOnboardingRequest(validRequest({ identityNumber })),
      ).toThrow('身份证号');
    },
  );

  it.each(['12900001234', '1990000123', '199000012345', '199-0000-1234'])(
    'rejects an invalid mainland mobile number: %s',
    (phone) => {
      expect(() =>
        parseEmployeeOnboardingRequest(validRequest({ phone })),
      ).toThrow('联系方式');
    },
  );

  it.each([
    ['entryDate', '0000-01-01'],
    ['entryDate', '0099-12-31'],
    ['entryDate', '0999-12-31'],
    ['entryDate', '2026-02-29'],
    ['entryDate', '2026-13-01'],
    ['graduationDate', '0000-01-01'],
    ['graduationDate', '0099-12-31'],
    ['graduationDate', '0999-12-31'],
    ['graduationDate', '2026-04-31'],
    ['graduationDate', '2026/06/30'],
    ['graduationDate', '2026-6-30'],
  ] as const)('rejects an invalid %s calendar date', (field, value) => {
    try {
      parseEmployeeOnboardingRequest({ ...validRequest(), [field]: value });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(issueFields(error)).toContain(field);
    }
  });

  it.each(['0000-01-01', '0099-12-31', '0999-12-31'])(
    'refuses to convert an out-of-range business year: %s',
    (date) => {
      expect(() => toShanghaiDateMilliseconds(date)).toThrow(
        '有效的 YYYY-MM-DD',
      );
    },
  );

  it('rejects unknown request fields before any Base mapping', () => {
    expect(() =>
      parseEmployeeOnboardingRequest({
        ...validRequest(),
        appToken: 'forged-token',
        photoToken: 'forged-file-token',
      }),
    ).toThrow('不支持的请求字段');
  });

  it('does not echo a malicious unknown key in errors or validation issues', () => {
    const maliciousKey = '身份证号\n19900001234';

    try {
      parseEmployeeOnboardingRequest({
        ...validRequest(),
        [maliciousKey]: true,
      });
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EmployeeOnboardingRuleError);
      const ruleError = error as EmployeeOnboardingRuleError;
      expect(ruleError.message).toBe('不支持的请求字段');
      expect(ruleError.message).not.toContain(maliciousKey);
      expect(ruleError.message).not.toContain('13800007889');
      expect(ruleError.message).not.toContain('\n');
      expect(ruleError.issues).toEqual([
        { field: 'request', message: '不支持的请求字段' },
      ]);
      expect(JSON.stringify(ruleError.issues)).not.toContain(maliciousKey);
      expect(JSON.stringify(ruleError.issues)).not.toContain('13800007889');
      expect(JSON.stringify(ruleError.issues)).not.toContain('\\n');
    }
  });

  it('accepts every shared text field at its exact Unicode code-point limit', () => {
    expect(EMPLOYEE_ONBOARDING_TEXT_LIMITS).toEqual({
      name: 50,
      graduateSchool: 100,
      major: 100,
      vehiclePlate: 20,
    });

    const parsed = parseEmployeeOnboardingRequest(
      validRequest({
        name: '员'.repeat(50),
        graduateSchool: '校'.repeat(100),
        major: '😀'.repeat(100),
        vehiclePlate: '🚗'.repeat(20),
      }),
    );

    expect(Array.from(parsed.name)).toHaveLength(50);
    expect(Array.from(parsed.graduateSchool)).toHaveLength(100);
    expect(Array.from(parsed.major)).toHaveLength(100);
    expect(Array.from(parsed.vehiclePlate ?? '')).toHaveLength(20);
    expect(parsed.major).toHaveLength(200);
  });

  it.each([
    ['name', '员'.repeat(51)],
    ['graduateSchool', '校'.repeat(101)],
    ['major', '😀'.repeat(101)],
    ['vehiclePlate', '🚗'.repeat(21)],
  ] as const)(
    'rejects %s at one code point over its shared limit',
    (field, value) => {
      try {
        parseEmployeeOnboardingRequest({ ...validRequest(), [field]: value });
        throw new Error('expected validation to fail');
      } catch (error) {
        expect(issueFields(error)).toContain(field);
      }
    },
  );

  it('validates the vehicle plate limit after uppercase normalization', () => {
    expect(
      parseEmployeeOnboardingRequest(
        validRequest({ vehiclePlate: '  苏f12345  ' }),
      ).vehiclePlate,
    ).toBe('苏F12345');

    try {
      parseEmployeeOnboardingRequest(
        validRequest({ vehiclePlate: 'ß'.repeat(11) }),
      );
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(issueFields(error)).toContain('vehiclePlate');
    }
  });

  it('omits an empty optional vehicle plate from Base fields', () => {
    const fields = buildEmployeeOnboardingFields(
      validRequest({ vehiclePlate: '   ' }),
    );

    expect(fields).not.toHaveProperty('车牌号');
    expect(Object.keys(fields)).toEqual([
      'MBTI',
      '姓名',
      '用工性质',
      '公司名称',
      '岗位',
      '身份证号',
      '联系方式',
      '入职日期',
      '学历',
      '毕业院校',
      '所学专业',
      '毕业时间',
      '兴趣爱好',
    ]);
  });

  it('exports the fixed attachment limits without putting files in JSON payloads', () => {
    expect(EMPLOYEE_ONBOARDING_PHOTO_FILE_RULE).toEqual({
      required: true,
      maxCount: 1,
      maxBytesPerFile: 10 * 1024 * 1024,
      mimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
    });
    expect(EMPLOYEE_ONBOARDING_CLIENT_MUTATION_ID_PREFIX).toBe(
      'employee-onboarding-',
    );
    expect(validRequest()).not.toHaveProperty('photo');
    expect(validRequest()).not.toHaveProperty('certificates');
  });

  it('keeps the normalized Base option sets exact and duplicate-free', () => {
    expect(EMPLOYEE_ONBOARDING_EMPLOYMENT_TYPES).toEqual([
      '420',
      '102',
      '生态',
    ]);
    expect(EMPLOYEE_ONBOARDING_COMPANIES).toEqual([
      '上海科之锐',
      '启东电力',
      '深圳锐科',
      '锐科',
      '深圳锐科信息技术有限公司',
      '神舟邦邦',
      '上海智服人力资源有限公司',
      '南通承宏云计算有限公司',
      '北京智航万恒',
      '亚康万玮',
    ]);
    expect(EMPLOYEE_ONBOARDING_POSITIONS).toEqual([
      '设施运维经理',
      '综合管理',
      '弱电工程师',
      '暖通工程师',
      '运维实习生',
      '设施运维助理工程师',
      '运维值班长',
      '电气工程师',
      '消防工程师',
      '安全&消防工程师',
      '设施运维副经理',
      '电气示例人员001',
      '暖通示例人员001',
      '弱电示例人员001',
      '设施运维示例人员001',
      '运维值班员',
      '110值班人员',
      '消防示例人员001',
      'FOC',
      '110站站长',
      'H楼值班示例人员001',
    ]);
    expect(EMPLOYEE_ONBOARDING_EDUCATIONS).toEqual([
      '本科',
      '大专',
      '中专',
      '高中',
      '/',
      '中技',
      '硕士',
    ]);
    expect(EMPLOYEE_ONBOARDING_HOBBIES).toEqual([
      '篮球',
      '羽毛球',
      '乒乓球',
      '电子游戏',
      '跑步',
      '唱歌',
      '舞蹈',
      '骑行',
      '钻研技术',
      '阅读',
      '撸铁',
      '喝酒',
      '其他',
    ]);
    for (const options of [
      EMPLOYEE_ONBOARDING_EMPLOYMENT_TYPES,
      EMPLOYEE_ONBOARDING_COMPANIES,
      EMPLOYEE_ONBOARDING_POSITIONS,
      EMPLOYEE_ONBOARDING_EDUCATIONS,
      EMPLOYEE_ONBOARDING_HOBBIES,
    ]) {
      expect(new Set(options).size).toBe(options.length);
      expect(options.every((option) => option === option.trim())).toBe(true);
    }
  });

  it('keeps the confirmed response contract minimal and rejects unexpected response fields', () => {
    const response = {
      success: true,
      syncStatus: 'confirmed',
      clientMutationId: VALID_MUTATION_ID,
      recordId: 'rec_test',
      createdAt: '2026-08-15T10:00:00.000Z',
    } satisfies EmployeeOnboardingCreateResponse;

    expect(isEmployeeOnboardingCreateResponse(response)).toBe(true);
    expect(isEmployeeOnboardingCreateResponse({ ...response, mbtiTicket: 'ticket-from-server' })).toBe(true);
    expect(Object.keys(response)).toEqual([
      'success',
      'syncStatus',
      'clientMutationId',
      'recordId',
      'createdAt',
    ]);
    expect(
      isEmployeeOnboardingCreateResponse({
        ...response,
        identityNumber: '110101199001010015',
      }),
    ).toBe(false);
    expect(
      isEmployeeOnboardingCreateResponse({
        ...response,
        attachmentTokens: ['file_secret'],
      }),
    ).toBe(false);

    const acceptResponse = (_value: EmployeeOnboardingCreateResponse) => true;
    // @ts-expect-error confirmed responses must not expose form PII
    expect(acceptResponse({ ...response, phone: '13800007889' })).toBe(true);
  });
});
