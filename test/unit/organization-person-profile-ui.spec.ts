import * as fs from 'node:fs';
import * as path from 'node:path';
import { MBTI_TYPE_CODES } from '../../shared/organization-person-profile';
import * as personProfileModel from '../../client/src/pages/OrganizationPage/person-profile-model';
import {
  MBTI_PREFERENCE_DEFINITIONS,
  MBTI_TYPE_DEFINITIONS,
  resolveOrganizationPersonProfile,
  organizationProfileCacheKey,
} from '../../client/src/pages/OrganizationPage/person-profile-model';

const ROOT = path.resolve(__dirname, '../..');
const read = (relativePath: string) =>
  fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

describe('organization person profile UI contract', () => {
  it('provides workplace-friendly text for all 16 MBTI types', () => {
    expect(Object.keys(MBTI_TYPE_DEFINITIONS).sort()).toEqual(
      [...MBTI_TYPE_CODES].sort(),
    );
    MBTI_TYPE_CODES.forEach((code) => {
      expect(MBTI_TYPE_DEFINITIONS[code].name.length).toBeGreaterThan(3);
      expect(MBTI_TYPE_DEFINITIONS[code].traits.length).toBeGreaterThan(8);
    });
  });

  it('explains all eight preference letters', () => {
    expect(Object.keys(MBTI_PREFERENCE_DEFINITIONS).sort()).toEqual([
      'E',
      'F',
      'I',
      'J',
      'N',
      'P',
      'S',
      'T',
    ]);
    Object.values(MBTI_PREFERENCE_DEFINITIONS).forEach((definition) => {
      expect(definition.label).toMatch(/[偏好]$/u);
      expect(definition.description.length).toBeGreaterThan(12);
    });
  });

  it('uses stable source and record id for the in-memory cache key', () => {
    expect(
      organizationProfileCacheKey({
        source: 'certificate',
        recordId: 'cert-123',
      }),
    ).toBe('certificate:cert-123');
  });

  it('treats placeholder copy as non-display profile data', () => {
    const isProfileDisplayValue = (
      personProfileModel as typeof personProfileModel & {
        isProfileDisplayValue?: (value: unknown) => boolean;
      }
    ).isProfileDisplayValue;

    expect(typeof isProfileDisplayValue).toBe('function');
    if (!isProfileDisplayValue) return;

    expect(
      [
        null,
        '',
        '-',
        'N/A',
        '不适用',
        '未维护',
        '日期未维护',
        '暂无',
        '在职人员',
        '在职',
        '2023-09-05',
        '0',
      ].filter(isProfileDisplayValue),
    ).toEqual(['在职', '2023-09-05', '0']);
  });

  it('deduplicates combined profile values and hides raw employment type codes', () => {
    const model = personProfileModel as typeof personProfileModel & {
      joinProfileDisplayValues?: (...values: unknown[]) => string | null;
      isProfileEmploymentTypeDisplayValue?: (value: unknown) => boolean;
    };

    expect(typeof model.joinProfileDisplayValues).toBe('function');
    expect(typeof model.isProfileEmploymentTypeDisplayValue).toBe('function');
    if (
      !model.joinProfileDisplayValues ||
      !model.isProfileEmploymentTypeDisplayValue
    ) {
      return;
    }

    expect(model.joinProfileDisplayValues('长白', '长白', '未维护', null)).toBe(
      '长白',
    );
    expect(model.isProfileEmploymentTypeDisplayValue('420')).toBe(false);
    expect(model.isProfileEmploymentTypeDisplayValue('正式员工')).toBe(true);
  });

  const summary = {
    source: 'organization' as const,
    recordId: 'rec-audit-person',
    name: '档案测试人员',
    position: '运维工程师',
    buildings: ['B楼'],
    shift: '长白',
    photoUrl: '/api/person-photo/audit-person',
    email: 'profile@example.test',
    phone: '139****7788',
  };

  it('uses only known summary fields while the profile is loading or unavailable', () => {
    const detail = resolveOrganizationPersonProfile(summary);

    expect(detail).toMatchObject({
      recordId: summary.recordId,
      name: summary.name,
      position: summary.position,
      buildingsSpecialties: summary.buildings,
      shift: summary.shift,
      photoUrl: summary.photoUrl,
      email: summary.email,
      phone: summary.phone,
      employmentStatus: 'unknown',
      abilities: [],
      employmentHistory: [],
      hobbies: [],
      specialties: [],
      certificates: [],
      certificateSource: null,
      qualityAssessment: { status: 'unavailable', records: [] },
    });
    const unknownFields = [
      detail.employeeNo, detail.systemPosition, detail.company,
      detail.employmentType, detail.team, detail.supervisorName,
      detail.idCardMasked, detail.entryDate, detail.departureDate,
      detail.departureReason, detail.education, detail.school, detail.major,
      detail.graduationDate, detail.vehiclePlate, detail.mbti, detail.updatedAt,
      ...Object.values(detail.profileScores),
      ...Object.values(detail.training),
      ...Object.values(detail.drill),
    ];
    expect(unknownFields.every(value => value === null)).toBe(true);
  });

  it('does not invent contact or assignment data when the summary is also empty', () => {
    const detail = resolveOrganizationPersonProfile({
      ...summary, position: null, buildings: [], shift: null,
      photoUrl: null, email: null, phone: null,
    });

    expect(detail).toMatchObject({
      position: null, buildingsSpecialties: [], shift: null,
      photoUrl: null, email: null, phone: null,
    });
  });

  it('keeps missing real fields empty while retaining known summary information', () => {
    const real = resolveOrganizationPersonProfile({
      ...summary, position: null, buildings: [], shift: null,
      photoUrl: null, email: null, phone: null,
    });
    real.certificateSource = 'personnel';
    const resolved = resolveOrganizationPersonProfile(summary, real);

    expect(resolved).toEqual({
      ...real,
      position: summary.position,
      buildingsSpecialties: summary.buildings,
      shift: summary.shift,
      photoUrl: summary.photoUrl,
      email: summary.email,
      phone: summary.phone,
    });
    expect(resolved.certificates).toEqual([]);
    expect(resolved.school).toBeNull();
    expect(resolved.profileScores.collaboration).toBeNull();
    expect(resolved.training.averageScore).toBeNull();
  });

  it('preserves real values, zero scores, unknown status and verified empty certificates', () => {
    const real = resolveOrganizationPersonProfile(summary);
    real.education = '硕士';
    real.school = '真实院校';
    real.entryDate = '2023-05-01';
    real.vehiclePlate = '真实车牌';
    real.phone = '138****1234';
    real.mbti = 'ISTJ';
    real.profileScores.collaboration = 0;
    real.training.averageScore = 0;
    real.abilities = [{ key: 'teamwork', label: '团队协作', score: 0, benchmark: null }];
    real.certificateSource = 'certificate';

    expect(resolveOrganizationPersonProfile(summary, real)).toEqual(real);
  });

  it('uses the summary-only profile for loading and failure, and resolves real responses without demo data', () => {
    const source = read('client/src/pages/OrganizationPage/PersonProfileDialog.tsx');
    expect(source).toContain('const summaryDetail = resolveOrganizationPersonProfile(profile)');
    expect(source).toContain("setLoadState({ status: 'loading', detail: summaryDetail })");
    expect(source).toMatch(/status: 'fallback',\s*detail: summaryDetail/u);
    expect(source).toContain('resolveOrganizationPersonProfile(profile, detail)');
    expect(source).toContain('正在读取人员档案');
    expect(source).toContain('实时档案暂不可用');
    expect(source).not.toContain('DemoProfile');
    expect(source).not.toContain('mergeOrganizationPersonProfile');
  });

  it('renders the complete profile modules and accessible MBTI tooltips', () => {
    const source = read(
      'client/src/pages/OrganizationPage/PersonProfileDialog.tsx',
    );
    [
      '基础信息',
      '人员画像',
      '任职履历',
      '质量履职记录',
      '能力雷达',
      '培训与演练',
      '持证情况',
      '16 型人格图谱',
    ].forEach((title) => expect(source).toContain(title));
    expect(source).toContain('TooltipTrigger');
    expect(source).toContain('TooltipContent');
    expect(source).toContain('RadarChart');
    expect(source).not.toContain('部分字段尚未维护');
    expect(source).not.toContain('用于档案模板预览');
    expect(source).not.toContain("'不适用'");
    expect(source).not.toContain("'在职人员'");
    expect(source).not.toContain("'日期未维护'");
    expect(source).toContain("detail.employmentStatus !== 'active'");
    expect(source).toContain('resolveOrganizationPersonProfile');
    expect(source).toContain('年份待确认');
    expect(source).toContain('年度绩效考核依据');
    expect(source).toContain('assessment.status');
    expect(source).toContain('quality-record-evidence');
    expect(source).toContain('<img');
    expect(source).not.toContain('人员档案加载失败');
  });

  it('uses a compact desktop rail and a portrait photo crop', () => {
    const source = read(
      'client/src/pages/OrganizationPage/PersonProfileDialog.tsx',
    );
    expect(source).toContain('lg:grid-cols-[18rem_minmax(0,1fr)]');
    expect(source).toContain('aspect-[3/4]');
    expect(source).toContain('object-cover object-top');
  });

  it('uses a semantic bento grid with full text, hobby icons and specialty tags', () => {
    const source = read(
      'client/src/pages/OrganizationPage/PersonProfileDialog.tsx',
    );
    expect(source).toContain('grid-cols-12');
    expect(source).toContain('function ProfileFact');
    expect(source).toContain('function HobbyChip');
    expect(source).toContain('function SpecialtyTag');
    expect(source).toContain('break-words');
    expect(source).toContain('whitespace-normal');
    expect(source).toContain('Bike');
    expect(source).toContain('Music2');
    expect(source).toContain(
      "specialties.length > 0 ? 'lg:col-span-6' : 'lg:col-span-12'",
    );
    expect(source).toContain(
      "hobbies.length > 0 ? 'lg:col-span-6' : 'lg:col-span-12'",
    );

    const profileFactSource = source.slice(
      source.indexOf('function ProfileFact'),
      source.indexOf('function ScoreTile'),
    );
    expect(profileFactSource).not.toContain('truncate');
  });

  it('shows certificate cards without a redundant source and count summary', () => {
    const source = read(
      'client/src/pages/OrganizationPage/PersonProfileDialog.tsx',
    );
    expect(source).toContain('持证情况');
    expect(source).toContain('detail.certificates.length > 0');

    const certificateListSource = source.slice(
      source.indexOf('function CertificateList'),
      source.indexOf('function MbtiLetter'),
    );
    expect(certificateListSource).not.toContain('certificateSourceLabel');
    expect(certificateListSource).not.toContain('项记录');
    expect(certificateListSource).not.toContain('数据来源：');
  });

  it('loads details with abort protection and a ten-minute memory cache', () => {
    const source = read(
      'client/src/pages/OrganizationPage/PersonProfileDialog.tsx',
    );
    expect(source).toContain('PROFILE_DETAIL_CACHE_TTL_MS');
    expect(source).toContain('10 * 60 * 1000');
    expect(source).toContain('new AbortController()');
    expect(source).toContain('controller.abort()');
    expect(source).toContain('getOrganizationPersonProfile');

    const apiSource = read('client/src/api/index.ts');
    expect(apiSource).toContain('getOrganizationPersonProfile');
    expect(apiSource).toContain(
      '/api/bitable/organization-person-profile/${encodeURIComponent(source)}',
    );
    expect(apiSource).toContain('signal');
  });

  it('gates every organization entry with the shared admin/editor policy', () => {
    const source = read(
      'client/src/pages/OrganizationPage/OrganizationPage.tsx',
    );
    expect(source).toContain('useAccess()');
    expect(source).toContain('canViewOrganizationPersonProfile');
    expect(source).toContain('canOpenProfile');
    expect(source).toContain('if (!canOpenProfiles) return');
    expect(source).toContain('aria-disabled={!canOpenProfile}');
  });
});
