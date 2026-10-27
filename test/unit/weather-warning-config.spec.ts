import { loadWeatherWarningCheckRuntimeConfig } from '../../server/modules/weather-warning/weather-warning.config';

const SOURCE_URL =
  'https://vnet.feishu.cn/base/appWeatherWarning?table=tblWeatherRules';

describe('weather warning check runtime config', () => {
  it('uses the registration table building and evidence fields by default', () => {
    const config = loadWeatherWarningCheckRuntimeConfig({
      FEISHU_WEATHER_WARNING_SOURCE_URL: SOURCE_URL,
      FEISHU_WEATHER_WARNING_CHECK_TABLE_ID: 'tblWeatherChecks',
    });

    expect(config.checkFields).toMatchObject({
      building: '楼栋',
      deviceEvidence: '设备安全检查纸质图片',
      disasterEvidence: '灾害专项检查纸质图片',
      environmentEvidence: '环境安全检查纸质图片',
    });
  });

  it('allows the building field name to be configured explicitly', () => {
    const config = loadWeatherWarningCheckRuntimeConfig({
      FEISHU_WEATHER_WARNING_SOURCE_URL: SOURCE_URL,
      FEISHU_WEATHER_WARNING_CHECK_TABLE_ID: 'tblWeatherChecks',
      FEISHU_WEATHER_WARNING_CHECK_BUILDING_FIELD: '机楼',
    });

    expect(config.checkFields).toMatchObject({ building: '机楼' });
  });

  it('allows every evidence field name to be configured explicitly', () => {
    const config = loadWeatherWarningCheckRuntimeConfig({
      FEISHU_WEATHER_WARNING_SOURCE_URL: SOURCE_URL,
      FEISHU_WEATHER_WARNING_CHECK_TABLE_ID: 'tblWeatherChecks',
      FEISHU_WEATHER_WARNING_CHECK_DEVICE_EVIDENCE_FIELD: '设备附件',
      FEISHU_WEATHER_WARNING_CHECK_DISASTER_EVIDENCE_FIELD: '灾害附件',
      FEISHU_WEATHER_WARNING_CHECK_ENVIRONMENT_EVIDENCE_FIELD: '环境附件',
    });

    expect(config.checkFields).toMatchObject({
      deviceEvidence: '设备附件',
      disasterEvidence: '灾害附件',
      environmentEvidence: '环境附件',
    });
  });
});
