import { readFileSync } from 'fs';
import { join } from 'path';
import * as personnelMovements from '../../client/src/pages/MonthlySchedule/personnel-movements';

const { buildPersonnelMovementOverview } = personnelMovements;

describe('personnel movement overview', () => {
  it('keeps temporary substitute staff separate from leave substitutes', () => {
    const result = buildPersonnelMovementOverview({
      leaveData: [
        {
          building: 'C',
          buildingName: 'C栋',
          leaveStaff: ['任烁炜'],
          substituteStaff: ['祁金鹰'],
          temporarySubstituteStaff: ['示例人员012'],
          temporarySubstitutes: [
            {
              shift: 'night',
              shiftLabel: '夜',
              staff: ['示例人员012'],
            },
          ],
        },
      ],
      travelDetails: [],
      buildingOrder: ['building_c'],
      buildingNameMap: {
        building_c: 'C栋',
      },
    });

    expect(result).toEqual([
      {
        building: 'building_c',
        buildingName: 'C栋',
        leaveStaff: ['任烁炜'],
        substituteStaff: ['祁金鹰'],
        temporarySubstituteStaff: ['示例人员012'],
        temporarySubstitutes: [
          {
            shift: 'night',
            shiftLabel: '夜',
            staff: ['示例人员012'],
          },
        ],
        travelStaff: [],
      },
    ]);
  });

  it('keeps leave and substitute staff paired by building and shift', () => {
    type ScheduleMovementStub = {
      scheduleDate: string;
      building: string;
      buildingText: string;
      shift: string;
      shiftText: string;
      team: string;
      teamText: string;
      leaveStaff: string[];
      substituteStaff: string[];
    };
    const buildLeaveSubstitutionGroupsByBuilding = (
      personnelMovements as typeof personnelMovements & {
        buildLeaveSubstitutionGroupsByBuilding?: (
          schedules: ScheduleMovementStub[],
          date: string,
        ) => Map<string, Array<{
          shift: string;
          shiftLabel: string;
          leaveStaff: string[];
          substituteStaff: string[];
        }>>;
      }
    ).buildLeaveSubstitutionGroupsByBuilding;

    expect(buildLeaveSubstitutionGroupsByBuilding).toEqual(expect.any(Function));

    const result = buildLeaveSubstitutionGroupsByBuilding!([
      {
        scheduleDate: '2026-07-24',
        building: 'building_d',
        buildingText: 'D栋',
        shift: 'night',
        shiftText: '夜班',
        team: 'D班',
        teamText: 'D班',
        leaveStaff: ['潘佩胜'],
        substituteStaff: ['虞伟'],
      },
      {
        scheduleDate: '2026-07-24',
        building: 'building_d',
        buildingText: 'D栋',
        shift: 'long_white',
        shiftText: '长白班',
        team: '长白班',
        teamText: '长白班',
        leaveStaff: ['卢俊钳'],
        substituteStaff: ['张文豪'],
      },
    ], '2026-07-24');

    expect(result.get('building_d')).toEqual([
      {
        shift: 'night',
        shiftLabel: '夜',
        leaveStaff: ['潘佩胜'],
        substituteStaff: ['虞伟'],
      },
      {
        shift: 'long_white',
        shiftLabel: '长白',
        leaveStaff: ['卢俊钳'],
        substituteStaff: ['张文豪'],
      },
    ]);
  });

  it('keeps compact per-person leave hours and substitute relations', () => {
    const result = personnelMovements.buildLeaveSubstitutionGroupsByBuilding(
      [
        {
          scheduleDate: '2026-09-15',
          building: 'building_b',
          buildingText: 'B楼',
          shift: 'white',
          shiftText: '白班',
          team: 'B班',
          teamText: 'B班',
          leaveStaff: ['示例人员008', '示例人员013'],
          substituteStaff: ['示例人员017', '赵六'],
          leaveAssignments: [
            {
              requestRecordId: 'leave-zhang-san',
              leaveStaffName: '示例人员008',
              substituteStaff: ['示例人员017'],
              startAt: '2026-09-15T09:00',
              endAt: '2026-09-15T14:00',
              leaveHours: 4,
            },
            {
              requestRecordId: 'leave-li-si',
              leaveStaffName: '示例人员013',
              substituteStaff: ['赵六'],
              startAt: '2026-09-15T09:00',
              endAt: '2026-09-15T18:00',
              leaveHours: 8,
            },
          ],
        },
      ],
      '2026-09-15',
    );

    expect(result.get('building_b')).toEqual([
      {
        shift: 'white',
        shiftLabel: '白',
        leaveStaff: ['示例人员008', '示例人员013'],
        substituteStaff: ['示例人员017', '赵六'],
        assignments: [
          {
            requestRecordId: 'leave-zhang-san',
            leaveStaffName: '示例人员008',
            substituteStaff: ['示例人员017'],
            startAt: '2026-09-15T09:00',
            endAt: '2026-09-15T14:00',
            leaveHours: 4,
          },
          {
            requestRecordId: 'leave-li-si',
            leaveStaffName: '示例人员013',
            substituteStaff: ['赵六'],
            startAt: '2026-09-15T09:00',
            endAt: '2026-09-15T18:00',
            leaveHours: 8,
          },
        ],
      },
    ]);
  });

  it('filters the no-substitute sentinel while keeping real substitutes', () => {
    const schedules = [
      {
        scheduleDate: '2026-08-10',
        building: 'building_e',
        buildingText: 'E楼',
        shift: 'long_white',
        shiftText: '长白班',
        team: '长白',
        teamText: '长白',
        leaveStaff: ['杨煜文'],
        substituteStaff: ['无需替班', '潘佩胜'],
      },
    ];

    expect(
      personnelMovements
        .buildLeaveSubstitutionGroupsByBuilding(schedules, '2026-08-10')
        .get('building_e'),
    ).toEqual([
      {
        shift: 'long_white',
        shiftLabel: '长白',
        leaveStaff: ['杨煜文'],
        substituteStaff: ['潘佩胜'],
      },
    ]);

    expect(
      buildPersonnelMovementOverview({
        leaveData: [
          {
            building: 'E楼',
            buildingName: 'E楼',
            leaveStaff: ['杨煜文'],
            substituteStaff: ['无需替班', '潘佩胜'],
            temporarySubstituteStaff: [],
            temporarySubstitutes: [],
          },
        ],
        travelDetails: [],
        buildingOrder: ['building_e'],
        buildingNameMap: { building_e: 'E楼' },
      })[0]?.substituteStaff,
    ).toEqual(['潘佩胜']);
  });

  it('patches only the matching schedule with the updated actual duty staff', () => {
    type ScheduleStub = {
      recordId: string;
      dutyStaffActual: string[];
      marker: string;
    };
    const applyDutyStaffActualUpdates = (
      personnelMovements as typeof personnelMovements & {
        applyDutyStaffActualUpdates?: (
          schedules: ScheduleStub[],
          updates: Array<{ recordId: string; dutyStaffActual: string[] }>,
        ) => ScheduleStub[];
      }
    ).applyDutyStaffActualUpdates;

    expect(applyDutyStaffActualUpdates).toEqual(expect.any(Function));

    const schedules: ScheduleStub[] = [
      { recordId: 'unchanged', dutyStaffActual: ['示例人员008'], marker: 'keep' },
      { recordId: 'target', dutyStaffActual: ['示例人员013'], marker: 'update' },
    ];
    const result = applyDutyStaffActualUpdates!(schedules, [
      { recordId: 'target', dutyStaffActual: ['江亮'] },
    ]);

    expect(result).toEqual([
      { recordId: 'unchanged', dutyStaffActual: ['示例人员008'], marker: 'keep' },
      { recordId: 'target', dutyStaffActual: ['江亮'], marker: 'update' },
    ]);
    expect(result[0]).toBe(schedules[0]);
    expect(result[1]).not.toBe(schedules[1]);
  });

  it('updates vacancy and repair results in the view without running a full local sync', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const vacancyBlock = source.slice(
      source.indexOf('const handleSubmitVacancySubstitutes'),
      source.indexOf('const handleSubmitStaffRepair'),
    );
    const repairBlock = source.slice(
      source.indexOf('const handleSubmitStaffRepair'),
      source.indexOf('const refreshTravelDataAfterMutation'),
    );

    expect(vacancyBlock).toContain('updateDisplayedDutyStaff(result.results)');
    expect(vacancyBlock).not.toContain('refreshScheduleDataAfterBackgroundSync');
    expect(repairBlock).toContain('updateDisplayedDutyStaff([result])');
    expect(repairBlock).not.toContain('refreshScheduleDataAfterBackgroundSync');
  });

  it('does not render a pending placeholder when a leave shift has no substitute', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const start = source.indexOf('function TodayPersonnelMovementCard');
    const end = source.indexOf('function TodayEngineersOnDuty', start);
    const componentSource = source.slice(start, end);
    const relationStart = componentSource.indexOf(
      'key={`${building}-leave-relation-${group.shift}`}',
    );
    const relationEnd = componentSource.indexOf(
      '{/* 无法按排班记录确定关系的数据单独展示',
      relationStart,
    );
    const relationSource = componentSource.slice(relationStart, relationEnd);
    const substituteConditionIndex = relationSource.indexOf(
      '{group.substituteStaff.length > 0 && (',
    );
    const substituteTagIndex = relationSource.indexOf(
      'duty-leave-tag-substitute',
    );

    expect(componentSource).not.toContain('待安排');
    expect(substituteConditionIndex).toBeGreaterThanOrEqual(0);
    expect(substituteConditionIndex).toBeLessThan(substituteTagIndex);
  });

  it('renders each verified leave relation as one compact inline pill', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const start = source.indexOf('function TodayPersonnelMovementCard');
    const end = source.indexOf('function TodayEngineersOnDuty', start);
    const componentSource = source.slice(start, end);

    expect(componentSource).toContain(
      'duty-leave-relation inline-flex min-w-0 flex-nowrap',
    );
    expect(componentSource).toContain('assignment.leaveHours');
    expect(componentSource).toContain('assignment.substituteStaff');
    expect(componentSource).toContain('→');
    expect(componentSource).toContain('title={');
  });

  it('vertically centers movement labels and staff names', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/index.css'),
      'utf8',
    );
    const readRule = (selector: string) => {
      const start = source.indexOf(selector);
      const end = source.indexOf('}', start);
      return start >= 0 && end >= 0 ? source.slice(start, end + 1) : '';
    };

    expect(readRule('.duty-leave-item {')).toContain(
      'align-items: center !important;',
    );
    expect(
      readRule(
        '.duty-leave-building,\n.duty-leave-tag,\n.duty-leave-shift-tag {',
      ),
    ).toEqual(expect.stringContaining('align-items: center !important;'));
    expect(readRule('.duty-leave-name {')).toContain(
      'align-items: center !important;',
    );
  });
});
