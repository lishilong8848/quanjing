import { ServiceUnavailableException } from '@nestjs/common';
import { readEmployeeOnboardingConfig } from './employee-onboarding.config';

const DEFAULT_WIKI_TOKEN = 'AdQmwOqwei6Xr4kag3pcp1Flnmg';
const DEFAULT_TABLE_ID = 'tblOu75UtJTDNHIM';
const DIRECT_BASE_TOKEN = 'F9lDbA5XKaLmyasoARRcZFpKnZd';
const GENERIC_ERROR_MESSAGE = '新员工入职数据源配置不可用，请联系管理员';

function read(env: Record<string, string | undefined>) {
  return readEmployeeOnboardingConfig(env as NodeJS.ProcessEnv);
}

function captureError(env: Record<string, string | undefined>): Error {
  try {
    read(env);
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected employee onboarding configuration to fail');
}

describe('readEmployeeOnboardingConfig', () => {
  it('默认使用已确认的员工信息池 Wiki 和固定表', () => {
    expect(read({})).toEqual({
      appToken: '',
      wikiToken: DEFAULT_WIKI_TOKEN,
      tableId: DEFAULT_TABLE_ID,
      tableName: '员工信息池（全量）',
    });
  });

  it('解析专用完整 Base URL，兼容真实的非 bas 前缀 token', () => {
    expect(
      read({
        FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL: `https://vnet.feishu.cn/base/${DIRECT_BASE_TOKEN}?table=tblDedicated123&view=vewIgnored123`,
      }),
    ).toEqual({
      appToken: DIRECT_BASE_TOKEN,
      wikiToken: '',
      tableId: 'tblDedicated123',
      tableName: '员工信息池（全量）',
    });
  });

  it('专用显式 token 和 table 分别覆盖来源 URL 解析值', () => {
    expect(
      read({
        FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL:
          'https://vnet.feishu.cn/base/SourceAppToken1234?table=tblSource123',
        FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN: 'DedicatedAppToken1234',
        FEISHU_EMPLOYEE_ONBOARDING_WIKI_TOKEN: 'DedicatedWikiToken1234',
        FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID: 'tblExplicit123',
      }),
    ).toEqual({
      appToken: 'DedicatedAppToken1234',
      wikiToken: 'DedicatedWikiToken1234',
      tableId: 'tblExplicit123',
      tableName: '员工信息池（全量）',
    });
  });

  it('专用 wiki token 不会被来源 URL 的 app token 反向覆盖', () => {
    expect(
      read({
        FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL:
          'https://vnet.feishu.cn/base/SourceAppToken1234?table=tblSource123',
        FEISHU_EMPLOYEE_ONBOARDING_WIKI_TOKEN: 'DedicatedWikiToken1234',
      }),
    ).toEqual({
      appToken: '',
      wikiToken: 'DedicatedWikiToken1234',
      tableId: 'tblSource123',
      tableName: '员工信息池（全量）',
    });
  });

  it('有效来源 token 不会被无关的低优先级别名覆盖', () => {
    expect(
      read({
        FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL:
          'https://vnet.feishu.cn/wiki/SourceWikiToken12345?table=tblSource123',
        FEISHU_PERSONNEL_MOVEMENT_APP_TOKEN: 'bad-token!',
      }),
    ).toEqual({
      appToken: '',
      wikiToken: 'SourceWikiToken12345',
      tableId: 'tblSource123',
      tableName: '员工信息池（全量）',
    });
  });

  it('按 personnel movement、org、organization 顺序选择第一个非空来源别名', () => {
    expect(
      read({
        FEISHU_PERSONNEL_MOVEMENT_SOURCE_URL:
          'https://vnet.feishu.cn/wiki/PersonnelWikiToken1234?table=tblPersonnel123',
        FEISHU_ORG_SOURCE_URL:
          'https://vnet.feishu.cn/wiki/OrgWikiToken123456?table=tblOrg123',
        FEISHU_ORGANIZATION_SOURCE_URL:
          'https://vnet.feishu.cn/wiki/OrganizationWiki123?table=tblOrganization123',
      }),
    ).toEqual({
      appToken: '',
      wikiToken: 'PersonnelWikiToken1234',
      tableId: 'tblPersonnel123',
      tableName: '员工信息池（全量）',
    });
  });

  it('兼容显式 app token 和 table 覆盖兼容来源 URL', () => {
    expect(
      read({
        FEISHU_PERSONNEL_MOVEMENT_SOURCE_URL:
          'https://vnet.feishu.cn/wiki/AliasSourceWiki123?table=tblAliasSource123',
        FEISHU_PERSONNEL_MOVEMENT_APP_TOKEN: 'AliasExplicitApp123',
        FEISHU_PERSONNEL_MOVEMENT_TABLE_ID: 'tblAliasExplicit123',
      }),
    ).toEqual({
      appToken: 'AliasExplicitApp123',
      wikiToken: '',
      tableId: 'tblAliasExplicit123',
      tableName: '员工信息池（全量）',
    });
  });

  it('兼容显式 wiki token 作为目标层覆盖兼容来源 app token', () => {
    expect(
      read({
        FEISHU_PERSONNEL_MOVEMENT_SOURCE_URL:
          'https://vnet.feishu.cn/base/AliasSourceApp1234?table=tblAliasSource123',
        FEISHU_PERSONNEL_MOVEMENT_WIKI_TOKEN: 'AliasExplicitWiki123',
      }),
    ).toEqual({
      appToken: '',
      wikiToken: 'AliasExplicitWiki123',
      tableId: 'tblAliasSource123',
      tableName: '员工信息池（全量）',
    });
  });

  it('当来源 URL 缺失时，各类显式别名独立按顺序回退', () => {
    expect(
      read({
        FEISHU_PERSONNEL_MOVEMENT_APP_TOKEN: 'PersonnelAppToken1234',
        FEISHU_ORG_APP_TOKEN: 'OrgAppToken123456',
        FEISHU_ORGANIZATION_APP_TOKEN: 'OrganizationApp123',
        FEISHU_PERSONNEL_MOVEMENT_WIKI_TOKEN: 'PersonnelWikiToken1234',
        FEISHU_ORG_WIKI_TOKEN: 'OrgWikiToken123456',
        FEISHU_PERSONNEL_MOVEMENT_TABLE_ID: 'tblPersonnel123',
        FEISHU_ORG_TABLE_ID: 'tblOrg123',
      }),
    ).toEqual({
      appToken: 'PersonnelAppToken1234',
      wikiToken: 'PersonnelWikiToken1234',
      tableId: 'tblPersonnel123',
      tableName: '员工信息池（全量）',
    });
  });

  it('跳过空白专用值和别名', () => {
    expect(
      read({
        FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL: '  ',
        FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN: '\t',
        FEISHU_PERSONNEL_MOVEMENT_SOURCE_URL: ' ',
        FEISHU_ORG_SOURCE_URL:
          'https://vnet.feishu.cn/base/OrgDirectToken12345?table=tblOrgSelected123',
        FEISHU_ORGANIZATION_SOURCE_URL:
          'https://vnet.feishu.cn/base/UnusedToken123456?table=tblUnused123',
      }),
    ).toEqual({
      appToken: 'OrgDirectToken12345',
      wikiToken: '',
      tableId: 'tblOrgSelected123',
      tableName: '员工信息池（全量）',
    });
  });

  it.each([
    'https://vnet.feishu.cn/share/base/form/shrDedicated',
    'https://vnet.feishu.cn/SHARE/BASE/FORM/shrUpper/',
    'https://vnet.feishu.cn/share/base/form/?token=shrQuery',
  ])('拒绝专用表单分享地址：%s', (sourceUrl) => {
    const error = captureError({
      FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL: sourceUrl,
      FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN: 'ExplicitAppToken1234',
      FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID: 'tblExplicit123',
    });

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(
      JSON.stringify((error as ServiceUnavailableException).getResponse()),
    ).not.toMatch(/shr|share\/base\/form|vnet\.feishu/iu);
  });

  it.each([
    'https://vnet.feishu.cn/share%2Fbase%2Fform/shrEncoded?table=tblEncoded123',
    'https://vnet.feishu.cn/sh%61re/base%2Fform/shrMixed?table=tblMixed123',
    'https://vnet.feishu.cn/share%252Fbase%252Fform/shrDouble?table=tblDouble123',
  ])('拒绝编码或多重编码的表单分享路径：%s', (sourceUrl) => {
    const error = captureError({
      FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL: sourceUrl,
      FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN: 'ExplicitAppToken1234',
      FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID: 'tblExplicit123',
    });

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(
      JSON.stringify((error as ServiceUnavailableException).getResponse()),
    ).not.toMatch(/shr|share|%2f|vnet\.feishu/iu);
  });

  it('拒绝含非法百分号编码的来源 URL', () => {
    const error = captureError({
      FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL:
        'https://vnet.feishu.cn/base/ValidAppToken123/%ZZ?table=tblValid123',
      FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN: 'ExplicitAppToken1234',
      FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID: 'tblExplicit123',
    });

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(GENERIC_ERROR_MESSAGE);
  });

  it('专用显式 token 不能掩盖别名中的表单分享地址', () => {
    const error = captureError({
      FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN: 'ExplicitAppToken1234',
      FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID: 'tblExplicit123',
      FEISHU_ORG_SOURCE_URL:
        'https://vnet.feishu.cn/share/base/form/shrAliasMustFail?from=config',
    });

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(error.message).not.toContain('shrAliasMustFail');
  });

  it.each([
    'https://vnet.feishu.cn/?table=tblValid123',
    'https://vnet.feishu.cn/base/ValidAppToken123',
    'not a URL',
    'https://vnet.feishu.cn/base/form?table=tblValid123',
    'https://vnet.feishu.cn/base/ValidAppToken123/wiki/ValidWikiToken123?table=tblValid123',
    'https://example.com/base/ValidAppToken123?table=tblValid123',
  ])('即使有显式目标也拒绝不完整或非飞书来源 URL：%s', (sourceUrl) => {
    const error = captureError({
      FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL: sourceUrl,
      FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN: 'ExplicitAppToken1234',
      FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID: 'tblExplicit123',
    });

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(error.message).not.toContain(sourceUrl);
  });

  it('拒绝未被选中但无效的兼容来源 URL', () => {
    const error = captureError({
      FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL: `https://vnet.feishu.cn/base/${DIRECT_BASE_TOKEN}?table=tblDedicated123`,
      FEISHU_ORGANIZATION_SOURCE_URL:
        'https://vnet.feishu.cn/base/UnusedAliasToken123',
    });

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(GENERIC_ERROR_MESSAGE);
  });

  it.each([
    { FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN: 'form' },
    { FEISHU_EMPLOYEE_ONBOARDING_APP_TOKEN: 'bad-token!' },
    { FEISHU_EMPLOYEE_ONBOARDING_WIKI_TOKEN: 'wiki/token' },
    { FEISHU_EMPLOYEE_ONBOARDING_TABLE_ID: 'tb_invalid' },
  ])('对非法专用显式 token/table 安全失败：%j', (env) => {
    const error = captureError(env);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(GENERIC_ERROR_MESSAGE);
    expect(
      JSON.stringify((error as ServiceUnavailableException).getResponse()),
    ).not.toContain(Object.values(env)[0]);
  });

  it('对实际选中的非法别名安全失败', () => {
    const error = captureError({
      FEISHU_PERSONNEL_MOVEMENT_APP_TOKEN: 'bad-token!',
      FEISHU_ORG_APP_TOKEN: 'ValidOrgAppToken1234',
    });

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(error.message).toBe(GENERIC_ERROR_MESSAGE);
  });

  it('返回对象不泄露 sourceUrl、viewId 或其他配置', () => {
    const config = read({
      FEISHU_EMPLOYEE_ONBOARDING_SOURCE_URL: `https://vnet.feishu.cn/base/${DIRECT_BASE_TOKEN}?table=tblDedicated123&view=vewMustNotLeak`,
    });

    expect(Object.keys(config).sort()).toEqual([
      'appToken',
      'tableId',
      'tableName',
      'wikiToken',
    ]);
    expect(config).not.toHaveProperty('sourceUrl');
    expect(config).not.toHaveProperty('viewId');
  });
});
