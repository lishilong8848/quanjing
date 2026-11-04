import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';

function serviceWith(records: Array<{ record_id: string; fields: Record<string, unknown> }>) {
  // Exercise the real service/filter/field adapters without constructing external gateways.
  const service = Object.create(DutyScheduleService.prototype) as DutyScheduleService;
  Object.assign(service, {
    longWhiteDutyConfig: { tableId: 'tbl_synthetic_long_white', viewId: '' },
    fetchLongWhiteDutyRecords: jest.fn(async () => records),
  });
  return service;
}

function row(id: string, shift: string, overrides: Record<string, unknown> = {}) {
  return { record_id: id, fields: { 排班日期: '2026-11-02', 班组: '长白班', 班次: shift,
    机楼: 'A楼', '值班人员（实际）': ['SYNTHETIC_STAFF'], ...overrides } };
}

describe('long-white duty source shift filtering', () => {
  it.each(['长白班', '长白', 'LONG_WHITE', '白班', 'WHITE', ''])('keeps an actual long-white team with shift %s', async shift => {
    const service = serviceWith([row('rec_synthetic_1', shift)]);
    const result = await service.getLongWhiteDutyStaff('2026-11-02');
    expect(result.total).toBe(1);
    expect(result.buildings).toEqual([{ building: 'building_a', buildingName: 'A栋', staff: ['SYNTHETIC_STAFF'] }]);
  });

  it('still excludes night shifts, other teams and other dates', async () => {
    const service = serviceWith([
      row('rec_synthetic_night', '夜班'), row('rec_synthetic_other_team', '白班', { 班组: 'A班' }),
      row('rec_synthetic_other_day', '长白班', { 排班日期: '2026-11-03' }),
    ]);
    expect((await service.getLongWhiteDutyStaff('2026-11-02')).total).toBe(0);
  });

  it('keeps travel exclusion and vacancy substitution with long-white shift rows', async () => {
    const service = serviceWith([row('rec_synthetic_day', '长白班', {
      '值班人员（实际）': ['SYNTHETIC_PRESENT', 'SYNTHETIC_TRAVELLING'],
      差旅人员: ['SYNTHETIC_TRAVELLING'], 缺岗替班: ['SYNTHETIC_SUBSTITUTE'],
    })]);
    const result = await service.getLongWhiteDutyStaff('2026-11-02');
    expect(result.total).toBe(2);
    expect(result.buildings[0].staff).toEqual(['SYNTHETIC_PRESENT', 'SYNTHETIC_SUBSTITUTE']);
  });
});
