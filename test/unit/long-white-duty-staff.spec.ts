import {
  buildLongWhiteDutyStaffByBuilding,
  hasMissingLongWhiteDutyBuildings,
  preferMoreCompleteLongWhiteDutyRows,
} from '../../server/modules/duty-schedule/long-white-duty-staff';

describe('buildLongWhiteDutyStaffByBuilding', () => {
  it('moves leave substitutes to the leave staff building and removes them from their original building', () => {
    const result = buildLongWhiteDutyStaffByBuilding(
      [
        {
          building: 'building_c',
          buildingName: 'C楼',
          staff: ['朱春华', '张文豪', '孙婷婷', '唐依辉'],
          leaveStaff: [],
          substituteStaff: [],
        },
        {
          building: 'building_e',
          buildingName: 'E楼',
          staff: ['陈凯', '杨占山', '丁晓杰', '郭克成'],
          leaveStaff: ['郭克成'],
          substituteStaff: ['唐依辉'],
        },
      ],
      ['building_c', 'building_e'],
    );

    const byBuilding = new Map(
      result.map((building) => [building.building, building.staff]),
    );
    expect(byBuilding.get('building_c')).toEqual([
      '朱春华',
      '张文豪',
      '孙婷婷',
    ]);
    expect(byBuilding.get('building_e')).toEqual([
      '陈凯',
      '杨占山',
      '丁晓杰',
      '唐依辉',
    ]);
    expect(
      result.reduce((total, building) => total + building.staff.length, 0),
    ).toBe(7);
  });

  it('removes travel staff from long-white on-duty buildings', () => {
    const result = buildLongWhiteDutyStaffByBuilding(
      [
        {
          building: 'building_h',
          buildingName: 'H',
          staff: ['Alice', 'Bob', 'Charlie'],
          leaveStaff: [],
          substituteStaff: [],
          travelStaff: ['Bob'],
        },
      ],
      ['building_h'],
    );

    expect(result).toEqual([
      {
        building: 'building_h',
        buildingName: 'H',
        staff: ['Alice', 'Charlie'],
      },
    ]);
  });

  it('does not count the no-substitute sentinel as long-white on-duty staff', () => {
    const result = buildLongWhiteDutyStaffByBuilding(
      [
        {
          building: 'building_e',
          buildingName: 'E楼',
          staff: ['陈清溪'],
          leaveStaff: ['杨煜文'],
          substituteStaff: ['无需替班'],
        },
      ],
      ['building_e'],
    );

    expect(result).toEqual([
      {
        building: 'building_e',
        buildingName: 'E楼',
        staff: ['陈清溪'],
      },
    ]);
  });

  it('moves vacancy substitutes to the target building and removes them from their original building', () => {
    const rows = [
      {
        building: 'building_a',
        buildingName: 'A楼',
        staff: ['施小东', '汪根尚', '卢俊钳', '何洪'],
        leaveStaff: [],
        substituteStaff: [],
        vacancySubstituteStaff: [],
      },
      {
        building: 'building_d',
        buildingName: 'D楼',
        staff: ['陶必亮', '彭怀响', '赵震兴', '卢俊钳'],
        leaveStaff: [],
        substituteStaff: [],
        vacancySubstituteStaff: ['卢俊钳'],
      },
    ];

    const result = buildLongWhiteDutyStaffByBuilding(rows, [
      'building_a',
      'building_d',
    ]);
    const byBuilding = new Map(
      result.map((building) => [building.building, building.staff]),
    );

    expect(byBuilding.get('building_a')).toEqual(['施小东', '汪根尚', '何洪']);
    expect(byBuilding.get('building_d')).toEqual([
      '陶必亮',
      '彭怀响',
      '赵震兴',
      '卢俊钳',
    ]);
  });

  it('prefers all-table rows when the configured view misses expected long-white buildings', () => {
    const viewRows = [
      {
        building: 'building_c',
        buildingName: 'C楼',
        staff: ['孙婷婷'],
        leaveStaff: [],
        substituteStaff: [],
      },
    ];
    const allTableRows = [
      {
        building: 'building_a',
        buildingName: 'A楼',
        staff: ['施小东'],
        leaveStaff: [],
        substituteStaff: [],
      },
      ...viewRows,
      {
        building: 'building_b',
        buildingName: 'B楼',
        staff: ['陈继猛'],
        leaveStaff: [],
        substituteStaff: [],
      },
    ];
    const expectedBuildings = ['building_a', 'building_b', 'building_c'];

    expect(hasMissingLongWhiteDutyBuildings(viewRows, expectedBuildings)).toBe(
      true,
    );
    expect(
      preferMoreCompleteLongWhiteDutyRows(
        viewRows,
        allTableRows,
        expectedBuildings,
      ),
    ).toBe(allTableRows);
  });

  it('keeps configured view rows when all-table rows are not more complete', () => {
    const viewRows = [
      {
        building: 'building_a',
        buildingName: 'A楼',
        staff: ['施小东'],
        leaveStaff: [],
        substituteStaff: [],
      },
    ];
    const allTableRows = [
      {
        building: 'building_a',
        buildingName: 'A楼',
        staff: ['施小东'],
        leaveStaff: [],
        substituteStaff: [],
      },
    ];
    const expectedBuildings = ['building_a', 'building_b'];

    expect(
      preferMoreCompleteLongWhiteDutyRows(
        viewRows,
        allTableRows,
        expectedBuildings,
      ),
    ).toBe(viewRows);
  });
});
