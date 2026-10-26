import {
  alarmImageBaseScale,
  alarmImageStripCount,
  alarmImageWheelZoom,
  clampAlarmImageZoom,
  isWideAlarmImage,
} from '../../client/src/pages/MonthlyAlarmOverview/image-presentation';

describe('月度告警截图展示', () => {
  it('keeps thin screenshots readable and splits their full width into visible rows', () => {
    expect(isWideAlarmImage(2343, 19)).toBe(true);
    const scale = alarmImageBaseScale(2343, 19, 1000, 500);
    expect(scale).toBeCloseTo(36 / 19);
    expect(alarmImageStripCount(2343, scale, 1000)).toBe(5);
    expect(alarmImageStripCount(2504, 3 * 4, 400)).toBe(76);
  });

  it('fits regular screenshots inside the viewer without enlarging them', () => {
    expect(isWideAlarmImage(534, 285)).toBe(false);
    expect(alarmImageBaseScale(534, 285, 1000, 500)).toBe(1);
    expect(alarmImageBaseScale(3362, 1510, 1000, 500)).toBeCloseTo(1000 / 3362);
  });

  it('limits manual zoom to the available controls', () => {
    expect(clampAlarmImageZoom(0.1)).toBe(0.5);
    expect(clampAlarmImageZoom(1.26)).toBe(1.25);
    expect(clampAlarmImageZoom(5)).toBe(4);
    expect(alarmImageWheelZoom(1, -120)).toBe(1.5);
    expect(alarmImageWheelZoom(1, 60)).toBe(0.75);
    expect(alarmImageWheelZoom(4, -120)).toBe(4);
    expect(alarmImageWheelZoom(1, 30)).toBe(1);
  });
});
