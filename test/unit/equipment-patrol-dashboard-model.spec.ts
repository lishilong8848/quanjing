describe('2026 equipment rotation plan', () => {
  const loadPlan = () =>
    require('../../client/src/pages/EquipmentPatrolDashboard/equipment-rotation-plan-2026.generated');
  const loadModel = () =>
    require('../../client/src/pages/EquipmentPatrolDashboard/model');
  const expectedWindowsByDevice = [
    {
      id: 'refrigeration-unit',
      windows: [
        '2026-01-11..2026-01-15',
        '2026-01-26..2026-01-30',
        '2026-02-10..2026-02-14',
        '2026-02-25..2026-03-01',
        '2026-03-12..2026-03-16',
        '2026-03-27..2026-03-31',
        '2026-04-11..2026-04-15',
        '2026-04-26..2026-04-30',
        '2026-05-11..2026-05-15',
        '2026-05-26..2026-05-30',
        '2026-06-10..2026-06-14',
        '2026-06-25..2026-06-29',
        '2026-07-10..2026-07-14',
        '2026-07-25..2026-07-29',
        '2026-08-09..2026-08-13',
        '2026-08-24..2026-08-28',
        '2026-09-08..2026-09-12',
        '2026-09-23..2026-09-27',
        '2026-10-08..2026-10-12',
        '2026-10-23..2026-10-27',
        '2026-11-07..2026-11-11',
        '2026-11-22..2026-11-26',
        '2026-12-07..2026-12-11',
        '2026-12-22..2026-12-26',
      ],
    },
    {
      id: 'auxiliary-precision-ac',
      windows: [
        '2026-03-15..2026-03-19',
        '2026-06-15..2026-06-19',
        '2026-09-15..2026-09-19',
        '2026-12-15..2026-12-19',
      ],
    },
    {
      id: 'secondary-pump',
      windows: [
        '2026-01-22..2026-01-26',
        '2026-02-24..2026-02-28',
        '2026-03-25..2026-03-29',
        '2026-04-25..2026-04-29',
        '2026-05-25..2026-05-29',
        '2026-06-25..2026-06-29',
        '2026-07-25..2026-07-29',
        '2026-08-25..2026-08-29',
        '2026-09-25..2026-09-29',
        '2026-10-25..2026-10-29',
        '2026-11-25..2026-11-29',
        '2026-12-25..2026-12-29',
      ],
    },
    {
      id: 'east-west-vfd-refill-unit',
      windows: [
        '2026-01-22..2026-01-26',
        '2026-02-24..2026-02-28',
        '2026-03-25..2026-03-29',
        '2026-04-25..2026-04-29',
        '2026-05-25..2026-05-29',
        '2026-06-25..2026-06-29',
        '2026-07-25..2026-07-29',
        '2026-08-25..2026-08-29',
        '2026-09-25..2026-09-29',
        '2026-10-25..2026-10-29',
        '2026-11-25..2026-11-29',
        '2026-12-25..2026-12-29',
      ],
    },
    {
      id: 'private-room-ac-backup',
      windows: ['2026-06-07..2026-06-11', '2026-12-08..2026-12-12'],
    },
    {
      id: 'water-quality-circulation',
      windows: [
        '2026-01-09..2026-01-09',
        '2026-01-16..2026-01-16',
        '2026-01-23..2026-01-23',
        '2026-01-30..2026-01-30',
        '2026-02-06..2026-02-06',
        '2026-02-13..2026-02-13',
        '2026-02-20..2026-02-20',
        '2026-02-27..2026-02-27',
        '2026-03-06..2026-03-06',
        '2026-03-13..2026-03-13',
        '2026-03-20..2026-03-20',
        '2026-03-27..2026-03-27',
        '2026-04-03..2026-04-03',
        '2026-04-10..2026-04-10',
        '2026-04-17..2026-04-17',
        '2026-04-24..2026-04-24',
        '2026-05-01..2026-05-01',
        '2026-05-08..2026-05-08',
        '2026-05-15..2026-05-15',
        '2026-05-22..2026-05-22',
        '2026-05-29..2026-05-29',
        '2026-06-05..2026-06-05',
        '2026-06-12..2026-06-12',
        '2026-06-19..2026-06-19',
        '2026-06-26..2026-06-26',
        '2026-07-03..2026-07-03',
        '2026-07-10..2026-07-10',
        '2026-07-17..2026-07-17',
        '2026-07-24..2026-07-24',
        '2026-07-31..2026-07-31',
        '2026-08-07..2026-08-07',
        '2026-08-14..2026-08-14',
        '2026-08-21..2026-08-21',
        '2026-08-28..2026-08-28',
        '2026-09-04..2026-09-04',
        '2026-09-11..2026-09-11',
        '2026-09-18..2026-09-18',
        '2026-09-25..2026-09-25',
        '2026-10-02..2026-10-02',
        '2026-10-09..2026-10-09',
        '2026-10-16..2026-10-16',
        '2026-10-23..2026-10-23',
        '2026-10-30..2026-10-30',
        '2026-11-06..2026-11-06',
        '2026-11-13..2026-11-13',
        '2026-11-20..2026-11-20',
        '2026-11-27..2026-11-27',
        '2026-12-04..2026-12-04',
        '2026-12-11..2026-12-11',
        '2026-12-18..2026-12-18',
        '2026-12-25..2026-12-25',
      ],
    },
  ];

  test('preserves the six source devices in workbook order', () => {
    const { EQUIPMENT_ROTATION_PLAN_2026 } = loadPlan();

    expect(
      EQUIPMENT_ROTATION_PLAN_2026.devices.map(
        (device: { name: string }) => device.name,
      ),
    ).toEqual([
      '制冷单元',
      '辅助区域精密空调',
      '二次泵',
      '东西区变频补水机组',
      '包间空调（备机）',
      '水质循环',
    ]);
  });

  test('stores all 105 explicit source windows', () => {
    const { EQUIPMENT_ROTATION_PLAN_2026 } = loadPlan();
    const windowsByDevice = EQUIPMENT_ROTATION_PLAN_2026.devices.map(
      (device: {
        id: string;
        plannedWindows: Array<{ startDate: string; endDate: string }>;
      }) => ({
        id: device.id,
        windows: device.plannedWindows.map(
          ({ startDate, endDate }) => `${startDate}..${endDate}`,
        ),
      }),
    );

    expect(windowsByDevice).toEqual(expectedWindowsByDevice);
    expect(
      windowsByDevice.reduce(
        (total: number, device: { windows: string[] }) =>
          total + device.windows.length,
        0,
      ),
    ).toBe(105);
  });

  test('stores the exact 15 holiday adjustment cells without treating them as outcomes', () => {
    const { EQUIPMENT_ROTATION_PLAN_2026 } = loadPlan();
    const adjustments = EQUIPMENT_ROTATION_PLAN_2026.devices.map(
      (device: { adjustments: Array<{ date: string; label: string }> }) =>
        device.adjustments.map(({ date, label }) => [date, label]),
    );

    expect(adjustments).toEqual([
      [
        ['2026-09-25', '中秋'],
        ['2026-09-26', '中秋'],
        ['2026-09-27', '中秋'],
      ],
      [['2026-06-19', '端午']],
      [
        ['2026-09-25', '中秋'],
        ['2026-09-26', '中秋'],
        ['2026-09-27', '中秋'],
      ],
      [
        ['2026-09-25', '中秋'],
        ['2026-09-26', '中秋'],
        ['2026-09-27', '中秋'],
      ],
      [],
      [
        ['2026-02-20', '春节'],
        ['2026-05-01', '五一'],
        ['2026-06-19', '端午'],
        ['2026-09-25', '中秋'],
        ['2026-10-02', '国庆'],
      ],
    ]);
    expect(
      adjustments.reduce(
        (total: number, deviceAdjustments: unknown[]) =>
          total + deviceAdjustments.length,
        0,
      ),
    ).toBe(15);
  });

  test('preserves the source identifier mismatch and workbook notes', () => {
    const { EQUIPMENT_ROTATION_PLAN_2026 } = loadPlan();
    const { metadata, devices } = EQUIPMENT_ROTATION_PLAN_2026;

    expect(metadata).toMatchObject({
      sourceFileName: '21V-FOC-RM-474-设备轮换计划 2026.xlsx',
      filenameIdentifier: '21V-FOC-RM-474',
      coverIdentifier: '21V-FOC-RM-483',
      sourceIdentifierMismatch: true,
      sourceSheet: '设备轮换年度计划表',
      sourceModifiedAt: '2026-07-10 16:16:22',
      executionDataAvailable: false,
    });
    expect(devices[3].notes.join('\n')).toContain('故不进行变频补水机组轮换');
    expect(devices[3].plannedWindows).toHaveLength(12);
    expect(devices[5].notes.join('\n')).toContain('可不进行水质循环');
    expect(devices[5].plannedWindows).toHaveLength(51);
  });

  test('derives July plan counts and active windows from source windows', () => {
    const model = loadModel();
    const dashboard = model.getPatrolMonthDashboard('2026-07');
    const summary = model.summarizePatrolMonth(dashboard);

    expect(
      dashboard.devices.map((device: { planned: number }) => device.planned),
    ).toEqual([2, 0, 1, 1, 0, 5]);
    expect(summary.planned).toBe(9);
    expect(dashboard.dailyPlanned).toBe(2);
    expect(dashboard.referenceDate).toBe('2026-07-10');
    expect(dashboard.referenceDay).toBe(10);
    expect(dashboard.planSourceUpdatedAt).toBe('2026-07-10 16:16:22');
    expect(dashboard.comparedPlanRate).toBe(-10);
  });

  test('keeps execution rates unknown when an execution-enabled month has no plan', () => {
    const model = loadModel();
    const dashboard = model.getPatrolMonthDashboard('2026-07');
    const zeroPlanDevice = {
      ...dashboard.devices[0],
      planned: 0,
      executed: 0,
      partial: 0,
      missed: 0,
    };
    const summary = model.summarizePatrolMonth({
      ...dashboard,
      executionDataAvailable: true,
      devices: [zeroPlanDevice],
    });
    const ranking = model.rankPatrolDevices([zeroPlanDevice]);

    expect(summary.executionRate).toBeNull();
    expect(ranking[0].rate).toBeNull();
  });

  test('does not coerce partial execution records from unknown to zero', () => {
    const model = loadModel();
    const dashboard = model.getPatrolMonthDashboard('2026-07');
    const completeDevice = {
      ...dashboard.devices[0],
      executed: 1,
      partial: 0,
      missed: 0,
    };
    const incompleteDevice = {
      ...dashboard.devices[1],
      executed: null,
      partial: null,
      missed: null,
    };

    expect(
      model.summarizePatrolMonth({
        ...dashboard,
        executionDataAvailable: true,
        devices: [completeDevice, incompleteDevice],
      }),
    ).toEqual({
      planned: completeDevice.planned + incompleteDevice.planned,
      executed: null,
      partial: null,
      missed: null,
      unexecuted: null,
      executionRate: null,
    });
  });

  test('clips the February cooling window in March without double-counting it', () => {
    const { EQUIPMENT_ROTATION_PLAN_2026 } = loadPlan();
    const model = loadModel();
    const sourceDevice = EQUIPMENT_ROTATION_PLAN_2026.devices[0];
    const sourceWindow = sourceDevice.plannedWindows.find(
      (window: { id: string }) => window.id === 'refrigeration-unit-2026-02-25',
    );
    const marchDashboard = model.getPatrolMonthDashboard('2026-03');
    const coolingRow = marchDashboard.devices[0];

    expect(sourceWindow).toEqual({
      id: 'refrigeration-unit-2026-02-25',
      startDate: '2026-02-25',
      endDate: '2026-03-01',
      sourceCells: ['BL4', 'BM4', 'BN4', 'BO4', 'BP4'],
    });
    expect(coolingRow.planned).toBe(2);
    expect(coolingRow.days[0]).toMatchObject({
      day: 1,
      status: 'planned',
      taskCount: 0,
      windowId: 'refrigeration-unit-2026-02-25',
      isWindowStart: false,
      sourceCell: 'BP4',
    });
  });

  test('does not fabricate execution results in July', () => {
    const model = loadModel();
    const dashboard = model.getPatrolMonthDashboard('2026-07');
    const summary = model.summarizePatrolMonth(dashboard);
    const statuses = new Set(
      dashboard.devices.flatMap((device: { days: Array<{ status: string }> }) =>
        device.days.map((day) => day.status),
      ),
    );

    expect(dashboard.executionDataAvailable).toBe(false);
    dashboard.devices.forEach(
      (device: {
        executed: number | null;
        partial: number | null;
        missed: number | null;
        lastMissedDate: string | null;
      }) => {
        expect(device.executed).toBeNull();
        expect(device.partial).toBeNull();
        expect(device.missed).toBeNull();
        expect(device.lastMissedDate).toBeNull();
      },
    );
    expect(summary).toEqual({
      planned: 9,
      executed: null,
      partial: null,
      missed: null,
      unexecuted: null,
      executionRate: null,
    });
    expect(dashboard.dailyCompleted).toBeNull();
    expect(dashboard.healthScore).toBeNull();
    expect(statuses).toEqual(new Set(['planned', 'none']));
    expect(
      dashboard.devices.some((device: { days: Array<{ status: string }> }) =>
        device.days.some((day) =>
          ['completed', 'partial', 'missed'].includes(day.status),
        ),
      ),
    ).toBe(false);
    expect(model.getPendingPatrolTasks(dashboard.devices)).toEqual([]);
  });

  test('marks September holiday adjustments as adjusted rather than missed', () => {
    const model = loadModel();
    const dashboard = model.getPatrolMonthDashboard('2026-09');
    const byName = new Map(
      dashboard.devices.map((device: { name: string }) => [
        device.name,
        device,
      ]),
    );
    const statuses = (name: string, days: number[]) => {
      const device = byName.get(name) as {
        days: Array<{ day: number; status: string; note?: string }>;
      };
      return days.map((day) => {
        const cell = device.days[day - 1];
        return [cell.day, cell.status, cell.note];
      });
    };

    expect(statuses('制冷单元', [25, 26, 27])).toEqual([
      [25, 'adjusted', '中秋'],
      [26, 'adjusted', '中秋'],
      [27, 'adjusted', '中秋'],
    ]);
    expect(statuses('二次泵', [25, 26, 27])).toEqual([
      [25, 'adjusted', '中秋'],
      [26, 'adjusted', '中秋'],
      [27, 'adjusted', '中秋'],
    ]);
    expect(statuses('东西区变频补水机组', [25, 26, 27])).toEqual([
      [25, 'adjusted', '中秋'],
      [26, 'adjusted', '中秋'],
      [27, 'adjusted', '中秋'],
    ]);
    expect(statuses('水质循环', [25])).toEqual([[25, 'adjusted', '中秋']]);
    expect(
      dashboard.devices.flatMap((device: { days: Array<{ status: string }> }) =>
        device.days.filter((day) => day.status === 'missed'),
      ),
    ).toEqual([]);
  });

  test('exposes twelve months with correct day counts and July fallback', () => {
    const model = loadModel();

    expect(model.PATROL_MONTH_OPTIONS).toHaveLength(12);
    expect(
      model.getPatrolMonthDashboard('2026-02').devices[0].days,
    ).toHaveLength(28);
    expect(
      model.getPatrolMonthDashboard('2026-04').devices[0].days,
    ).toHaveLength(30);
    expect(
      model.getPatrolMonthDashboard('2026-07').devices[0].days,
    ).toHaveLength(31);
    expect(model.getPatrolMonthDashboard('invalid').month).toBe('2026-07');
    expect(
      model.getPatrolMonthDashboard('2026-01').comparedPlanRate,
    ).toBeNull();
  });

  test('returns deeply independent dashboard values on repeated calls', () => {
    const model = loadModel();
    const first = model.getPatrolMonthDashboard('2026-07');
    const second = model.getPatrolMonthDashboard('2026-07');

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.devices).not.toBe(first.devices);
    first.devices.forEach(
      (device: { days: unknown[]; notes: string[] }, deviceIndex: number) => {
        expect(second.devices[deviceIndex]).not.toBe(device);
        expect(second.devices[deviceIndex].days).not.toBe(device.days);
        expect(second.devices[deviceIndex].notes).not.toBe(device.notes);
        device.days.forEach((day, dayIndex) => {
          expect(second.devices[deviceIndex].days[dayIndex]).not.toBe(day);
        });
      },
    );

    const secondNotesBeforeMutation = [...second.devices[3].notes];
    first.devices[3].notes.push('test-only mutation');

    expect(second.devices[3].notes).toEqual(secondNotesBeforeMutation);
    expect(second.devices[3].notes).not.toContain('test-only mutation');
  });

  test('counts windows only on their start date', () => {
    const model = loadModel();
    const dashboard = model.getPatrolMonthDashboard('2026-07');

    dashboard.devices.forEach(
      (device: {
        name: string;
        planned: number;
        days: Array<{ taskCount: number }>;
      }) => {
        expect({
          name: device.name,
          windowStarts: device.days.reduce(
            (total, day) => total + day.taskCount,
            0,
          ),
        }).toEqual({ name: device.name, windowStarts: device.planned });
      },
    );
  });

  test('keeps source order in ranking when execution data is unavailable', () => {
    const model = loadModel();
    const dashboard = model.getPatrolMonthDashboard('2026-07');
    const ranking = model.rankPatrolDevices(dashboard.devices);

    expect(ranking.map((device: { name: string }) => device.name)).toEqual(
      dashboard.devices.map((device: { name: string }) => device.name),
    );
    expect(
      ranking.map((device: { rate: number | null }) => device.rate),
    ).toEqual(Array(6).fill(null));
    expect(ranking[0].days).not.toBe(dashboard.devices[0].days);
    expect(ranking[0].days[0]).not.toBe(dashboard.devices[0].days[0]);
  });
});
