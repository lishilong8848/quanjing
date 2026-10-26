// Generated from 21V-FOC-RM-474-设备轮换计划 2026.xlsx. Do not edit manually without revalidating the source workbook.

export interface RotationPlanAdjustment {
  readonly date: string;
  readonly label: string;
  readonly sourceCell: string;
}

export interface RotationPlanWindow {
  readonly id: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly sourceCells: ReadonlyArray<string>;
}

export interface RotationPlanDevice {
  readonly sourceSeq: number;
  readonly id: string;
  readonly name: string;
  readonly category: string | null;
  readonly quantity: number | string;
  readonly redundancy: string;
  readonly runningState: string;
  readonly strategy: string;
  readonly frequency: string;
  readonly plannedWindows: ReadonlyArray<RotationPlanWindow>;
  readonly adjustments: ReadonlyArray<RotationPlanAdjustment>;
  readonly notes: ReadonlyArray<string>;
  readonly sourceRow: number;
}

export interface RotationPlanMetadata {
  readonly year: number;
  readonly sourceFileName: string;
  readonly sourceSheet: string;
  readonly sourceRange: string;
  readonly deviceRows: string;
  readonly dayColumns: string;
  readonly filenameIdentifier: string;
  readonly coverIdentifier: string;
  readonly sourceIdentifierMismatch: boolean;
  readonly sourceModifiedAt: string;
  readonly executionDataAvailable: false;
  readonly extractionLibrary: string;
  readonly fillSemantics: Readonly<Record<string, string>>;
}

export interface EquipmentRotationPlan2026 {
  readonly metadata: RotationPlanMetadata;
  readonly devices: ReadonlyArray<RotationPlanDevice>;
}

export const EQUIPMENT_ROTATION_PLAN_2026 = {
  metadata: {
    year: 2026,
    sourceFileName: '21V-FOC-RM-474-设备轮换计划 2026.xlsx',
    sourceSheet: '设备轮换年度计划表',
    sourceRange: 'A1:NI20',
    deviceRows: '4:9',
    dayColumns: 'I:NI',
    filenameIdentifier: '21V-FOC-RM-474',
    coverIdentifier: '21V-FOC-RM-483',
    sourceIdentifierMismatch: true,
    sourceModifiedAt: '2026-07-10 16:16:22',
    executionDataAvailable: false,
    extractionLibrary: 'openpyxl 3.1.2',
    fillSemantics: {
      FFFFFF00: 'preRotation',
      FFFF0000: 'adjustment',
      FF03FB03: 'completed',
    },
  },
  devices: [
    {
      sourceSeq: 1,
      id: 'refrigeration-unit',
      name: '制冷单元',
      category: '暖通专业',
      quantity: 3,
      redundancy: '2用1备',
      runningState: '2用1备',
      strategy: '每运行300-400小时设备进行手动轮巡',
      frequency: '300-400时',
      plannedWindows: [
        {
          id: 'refrigeration-unit-2026-01-11',
          startDate: '2026-01-11',
          endDate: '2026-01-15',
          sourceCells: ['S4', 'T4', 'U4', 'V4', 'W4'],
        },
        {
          id: 'refrigeration-unit-2026-01-26',
          startDate: '2026-01-26',
          endDate: '2026-01-30',
          sourceCells: ['AH4', 'AI4', 'AJ4', 'AK4', 'AL4'],
        },
        {
          id: 'refrigeration-unit-2026-02-10',
          startDate: '2026-02-10',
          endDate: '2026-02-14',
          sourceCells: ['AW4', 'AX4', 'AY4', 'AZ4', 'BA4'],
        },
        {
          id: 'refrigeration-unit-2026-02-25',
          startDate: '2026-02-25',
          endDate: '2026-03-01',
          sourceCells: ['BL4', 'BM4', 'BN4', 'BO4', 'BP4'],
        },
        {
          id: 'refrigeration-unit-2026-03-12',
          startDate: '2026-03-12',
          endDate: '2026-03-16',
          sourceCells: ['CA4', 'CB4', 'CC4', 'CD4', 'CE4'],
        },
        {
          id: 'refrigeration-unit-2026-03-27',
          startDate: '2026-03-27',
          endDate: '2026-03-31',
          sourceCells: ['CP4', 'CQ4', 'CR4', 'CS4', 'CT4'],
        },
        {
          id: 'refrigeration-unit-2026-04-11',
          startDate: '2026-04-11',
          endDate: '2026-04-15',
          sourceCells: ['DE4', 'DF4', 'DG4', 'DH4', 'DI4'],
        },
        {
          id: 'refrigeration-unit-2026-04-26',
          startDate: '2026-04-26',
          endDate: '2026-04-30',
          sourceCells: ['DT4', 'DU4', 'DV4', 'DW4', 'DX4'],
        },
        {
          id: 'refrigeration-unit-2026-05-11',
          startDate: '2026-05-11',
          endDate: '2026-05-15',
          sourceCells: ['EI4', 'EJ4', 'EK4', 'EL4', 'EM4'],
        },
        {
          id: 'refrigeration-unit-2026-05-26',
          startDate: '2026-05-26',
          endDate: '2026-05-30',
          sourceCells: ['EX4', 'EY4', 'EZ4', 'FA4', 'FB4'],
        },
        {
          id: 'refrigeration-unit-2026-06-10',
          startDate: '2026-06-10',
          endDate: '2026-06-14',
          sourceCells: ['FM4', 'FN4', 'FO4', 'FP4', 'FQ4'],
        },
        {
          id: 'refrigeration-unit-2026-06-25',
          startDate: '2026-06-25',
          endDate: '2026-06-29',
          sourceCells: ['GB4', 'GC4', 'GD4', 'GE4', 'GF4'],
        },
        {
          id: 'refrigeration-unit-2026-07-10',
          startDate: '2026-07-10',
          endDate: '2026-07-14',
          sourceCells: ['GQ4', 'GR4', 'GS4', 'GT4', 'GU4'],
        },
        {
          id: 'refrigeration-unit-2026-07-25',
          startDate: '2026-07-25',
          endDate: '2026-07-29',
          sourceCells: ['HF4', 'HG4', 'HH4', 'HI4', 'HJ4'],
        },
        {
          id: 'refrigeration-unit-2026-08-09',
          startDate: '2026-08-09',
          endDate: '2026-08-13',
          sourceCells: ['HU4', 'HV4', 'HW4', 'HX4', 'HY4'],
        },
        {
          id: 'refrigeration-unit-2026-08-24',
          startDate: '2026-08-24',
          endDate: '2026-08-28',
          sourceCells: ['IJ4', 'IK4', 'IL4', 'IM4', 'IN4'],
        },
        {
          id: 'refrigeration-unit-2026-09-08',
          startDate: '2026-09-08',
          endDate: '2026-09-12',
          sourceCells: ['IY4', 'IZ4', 'JA4', 'JB4', 'JC4'],
        },
        {
          id: 'refrigeration-unit-2026-09-23',
          startDate: '2026-09-23',
          endDate: '2026-09-27',
          sourceCells: ['JN4', 'JO4', 'JP4', 'JQ4', 'JR4'],
        },
        {
          id: 'refrigeration-unit-2026-10-08',
          startDate: '2026-10-08',
          endDate: '2026-10-12',
          sourceCells: ['KC4', 'KD4', 'KE4', 'KF4', 'KG4'],
        },
        {
          id: 'refrigeration-unit-2026-10-23',
          startDate: '2026-10-23',
          endDate: '2026-10-27',
          sourceCells: ['KR4', 'KS4', 'KT4', 'KU4', 'KV4'],
        },
        {
          id: 'refrigeration-unit-2026-11-07',
          startDate: '2026-11-07',
          endDate: '2026-11-11',
          sourceCells: ['LG4', 'LH4', 'LI4', 'LJ4', 'LK4'],
        },
        {
          id: 'refrigeration-unit-2026-11-22',
          startDate: '2026-11-22',
          endDate: '2026-11-26',
          sourceCells: ['LV4', 'LW4', 'LX4', 'LY4', 'LZ4'],
        },
        {
          id: 'refrigeration-unit-2026-12-07',
          startDate: '2026-12-07',
          endDate: '2026-12-11',
          sourceCells: ['MK4', 'ML4', 'MM4', 'MN4', 'MO4'],
        },
        {
          id: 'refrigeration-unit-2026-12-22',
          startDate: '2026-12-22',
          endDate: '2026-12-26',
          sourceCells: ['MZ4', 'NA4', 'NB4', 'NC4', 'ND4'],
        },
      ],
      adjustments: [
        {
          date: '2026-09-25',
          label: '中秋',
          sourceCell: 'JP4',
        },
        {
          date: '2026-09-26',
          label: '中秋',
          sourceCell: 'JQ4',
        },
        {
          date: '2026-09-27',
          label: '中秋',
          sourceCell: 'JR4',
        },
      ],
      notes: [],
      sourceRow: 4,
    },
    {
      sourceSeq: 2,
      id: 'auxiliary-precision-ac',
      name: '辅助区域精密空调',
      category: '弱电专业',
      quantity: 3,
      redundancy: '2用1备',
      runningState: '2用1备',
      strategy: '定期轮换时间为2160小时，不得大于2500小时',
      frequency: '每季度',
      plannedWindows: [
        {
          id: 'auxiliary-precision-ac-2026-03-15',
          startDate: '2026-03-15',
          endDate: '2026-03-19',
          sourceCells: ['CD5', 'CE5', 'CF5', 'CG5', 'CH5'],
        },
        {
          id: 'auxiliary-precision-ac-2026-06-15',
          startDate: '2026-06-15',
          endDate: '2026-06-19',
          sourceCells: ['FR5', 'FS5', 'FT5', 'FU5', 'FV5'],
        },
        {
          id: 'auxiliary-precision-ac-2026-09-15',
          startDate: '2026-09-15',
          endDate: '2026-09-19',
          sourceCells: ['JF5', 'JG5', 'JH5', 'JI5', 'JJ5'],
        },
        {
          id: 'auxiliary-precision-ac-2026-12-15',
          startDate: '2026-12-15',
          endDate: '2026-12-19',
          sourceCells: ['MS5', 'MT5', 'MU5', 'MV5', 'MW5'],
        },
      ],
      adjustments: [
        {
          date: '2026-06-19',
          label: '端午',
          sourceCell: 'FV5',
        },
      ],
      notes: [],
      sourceRow: 5,
    },
    {
      sourceSeq: 3,
      id: 'secondary-pump',
      name: '二次泵',
      category: null,
      quantity: 3,
      redundancy: '2用1备',
      runningState: '2用1备',
      strategy: '定期轮换时间为720小时，不得大于800小时',
      frequency: '每月度',
      plannedWindows: [
        {
          id: 'secondary-pump-2026-01-22',
          startDate: '2026-01-22',
          endDate: '2026-01-26',
          sourceCells: ['AD6', 'AE6', 'AF6', 'AG6', 'AH6'],
        },
        {
          id: 'secondary-pump-2026-02-24',
          startDate: '2026-02-24',
          endDate: '2026-02-28',
          sourceCells: ['BK6', 'BL6', 'BM6', 'BN6', 'BO6'],
        },
        {
          id: 'secondary-pump-2026-03-25',
          startDate: '2026-03-25',
          endDate: '2026-03-29',
          sourceCells: ['CN6', 'CO6', 'CP6', 'CQ6', 'CR6'],
        },
        {
          id: 'secondary-pump-2026-04-25',
          startDate: '2026-04-25',
          endDate: '2026-04-29',
          sourceCells: ['DS6', 'DT6', 'DU6', 'DV6', 'DW6'],
        },
        {
          id: 'secondary-pump-2026-05-25',
          startDate: '2026-05-25',
          endDate: '2026-05-29',
          sourceCells: ['EW6', 'EX6', 'EY6', 'EZ6', 'FA6'],
        },
        {
          id: 'secondary-pump-2026-06-25',
          startDate: '2026-06-25',
          endDate: '2026-06-29',
          sourceCells: ['GB6', 'GC6', 'GD6', 'GE6', 'GF6'],
        },
        {
          id: 'secondary-pump-2026-07-25',
          startDate: '2026-07-25',
          endDate: '2026-07-29',
          sourceCells: ['HF6', 'HG6', 'HH6', 'HI6', 'HJ6'],
        },
        {
          id: 'secondary-pump-2026-08-25',
          startDate: '2026-08-25',
          endDate: '2026-08-29',
          sourceCells: ['IK6', 'IL6', 'IM6', 'IN6', 'IO6'],
        },
        {
          id: 'secondary-pump-2026-09-25',
          startDate: '2026-09-25',
          endDate: '2026-09-29',
          sourceCells: ['JP6', 'JQ6', 'JR6', 'JS6', 'JT6'],
        },
        {
          id: 'secondary-pump-2026-10-25',
          startDate: '2026-10-25',
          endDate: '2026-10-29',
          sourceCells: ['KT6', 'KU6', 'KV6', 'KW6', 'KX6'],
        },
        {
          id: 'secondary-pump-2026-11-25',
          startDate: '2026-11-25',
          endDate: '2026-11-29',
          sourceCells: ['LY6', 'LZ6', 'MA6', 'MB6', 'MC6'],
        },
        {
          id: 'secondary-pump-2026-12-25',
          startDate: '2026-12-25',
          endDate: '2026-12-29',
          sourceCells: ['NC6', 'ND6', 'NE6', 'NF6', 'NG6'],
        },
      ],
      adjustments: [
        {
          date: '2026-09-25',
          label: '中秋',
          sourceCell: 'JP6',
        },
        {
          date: '2026-09-26',
          label: '中秋',
          sourceCell: 'JQ6',
        },
        {
          date: '2026-09-27',
          label: '中秋',
          sourceCell: 'JR6',
        },
      ],
      notes: [],
      sourceRow: 6,
    },
    {
      sourceSeq: 4,
      id: 'east-west-vfd-refill-unit',
      name: '东西区变频补水机组',
      category: null,
      quantity: 2,
      redundancy: '1用1备',
      runningState: '1用1备',
      strategy: '定期轮换时间为720小时，不得大于800小时',
      frequency: '每月度',
      plannedWindows: [
        {
          id: 'east-west-vfd-refill-unit-2026-01-22',
          startDate: '2026-01-22',
          endDate: '2026-01-26',
          sourceCells: ['AD7', 'AE7', 'AF7', 'AG7', 'AH7'],
        },
        {
          id: 'east-west-vfd-refill-unit-2026-02-24',
          startDate: '2026-02-24',
          endDate: '2026-02-28',
          sourceCells: ['BK7', 'BL7', 'BM7', 'BN7', 'BO7'],
        },
        {
          id: 'east-west-vfd-refill-unit-2026-03-25',
          startDate: '2026-03-25',
          endDate: '2026-03-29',
          sourceCells: ['CN7', 'CO7', 'CP7', 'CQ7', 'CR7'],
        },
        {
          id: 'east-west-vfd-refill-unit-2026-04-25',
          startDate: '2026-04-25',
          endDate: '2026-04-29',
          sourceCells: ['DS7', 'DT7', 'DU7', 'DV7', 'DW7'],
        },
        {
          id: 'east-west-vfd-refill-unit-2026-05-25',
          startDate: '2026-05-25',
          endDate: '2026-05-29',
          sourceCells: ['EW7', 'EX7', 'EY7', 'EZ7', 'FA7'],
        },
        {
          id: 'east-west-vfd-refill-unit-2026-06-25',
          startDate: '2026-06-25',
          endDate: '2026-06-29',
          sourceCells: ['GB7', 'GC7', 'GD7', 'GE7', 'GF7'],
        },
        {
          id: 'east-west-vfd-refill-unit-2026-07-25',
          startDate: '2026-07-25',
          endDate: '2026-07-29',
          sourceCells: ['HF7', 'HG7', 'HH7', 'HI7', 'HJ7'],
        },
        {
          id: 'east-west-vfd-refill-unit-2026-08-25',
          startDate: '2026-08-25',
          endDate: '2026-08-29',
          sourceCells: ['IK7', 'IL7', 'IM7', 'IN7', 'IO7'],
        },
        {
          id: 'east-west-vfd-refill-unit-2026-09-25',
          startDate: '2026-09-25',
          endDate: '2026-09-29',
          sourceCells: ['JP7', 'JQ7', 'JR7', 'JS7', 'JT7'],
        },
        {
          id: 'east-west-vfd-refill-unit-2026-10-25',
          startDate: '2026-10-25',
          endDate: '2026-10-29',
          sourceCells: ['KT7', 'KU7', 'KV7', 'KW7', 'KX7'],
        },
        {
          id: 'east-west-vfd-refill-unit-2026-11-25',
          startDate: '2026-11-25',
          endDate: '2026-11-29',
          sourceCells: ['LY7', 'LZ7', 'MA7', 'MB7', 'MC7'],
        },
        {
          id: 'east-west-vfd-refill-unit-2026-12-25',
          startDate: '2026-12-25',
          endDate: '2026-12-29',
          sourceCells: ['NC7', 'ND7', 'NE7', 'NF7', 'NG7'],
        },
      ],
      adjustments: [
        {
          date: '2026-09-25',
          label: '中秋',
          sourceCell: 'JP7',
        },
        {
          date: '2026-09-26',
          label: '中秋',
          sourceCell: 'JQ7',
        },
        {
          date: '2026-09-27',
          label: '中秋',
          sourceCell: 'JR7',
        },
      ],
      notes: [
        'li.guoquan:\nAB楼变频补水机组因同时使用，无法进行切换，故不进行变频补水机组轮换',
      ],
      sourceRow: 7,
    },
    {
      sourceSeq: 5,
      id: 'private-room-ac-backup',
      name: '包间空调（备机）',
      category: null,
      quantity: 10,
      redundancy: '8用2备',
      runningState: '根据每个包间负载以及空调开启情况调整',
      strategy: '手动开启运行，运行时长不低于3小时',
      frequency: '半年度',
      plannedWindows: [
        {
          id: 'private-room-ac-backup-2026-06-07',
          startDate: '2026-06-07',
          endDate: '2026-06-11',
          sourceCells: ['FJ8', 'FK8', 'FL8', 'FM8', 'FN8'],
        },
        {
          id: 'private-room-ac-backup-2026-12-08',
          startDate: '2026-12-08',
          endDate: '2026-12-12',
          sourceCells: ['ML8', 'MM8', 'MN8', 'MO8', 'MP8'],
        },
      ],
      adjustments: [],
      notes: [],
      sourceRow: 8,
    },
    {
      sourceSeq: 6,
      id: 'water-quality-circulation',
      name: '水质循环',
      category: null,
      quantity: '/',
      redundancy: '/',
      runningState: '备机',
      strategy: '备用制冷单元每周进行一次冷却水水质循环',
      frequency: '每周',
      plannedWindows: [
        {
          id: 'water-quality-circulation-2026-01-09',
          startDate: '2026-01-09',
          endDate: '2026-01-09',
          sourceCells: ['Q9'],
        },
        {
          id: 'water-quality-circulation-2026-01-16',
          startDate: '2026-01-16',
          endDate: '2026-01-16',
          sourceCells: ['X9'],
        },
        {
          id: 'water-quality-circulation-2026-01-23',
          startDate: '2026-01-23',
          endDate: '2026-01-23',
          sourceCells: ['AE9'],
        },
        {
          id: 'water-quality-circulation-2026-01-30',
          startDate: '2026-01-30',
          endDate: '2026-01-30',
          sourceCells: ['AL9'],
        },
        {
          id: 'water-quality-circulation-2026-02-06',
          startDate: '2026-02-06',
          endDate: '2026-02-06',
          sourceCells: ['AS9'],
        },
        {
          id: 'water-quality-circulation-2026-02-13',
          startDate: '2026-02-13',
          endDate: '2026-02-13',
          sourceCells: ['AZ9'],
        },
        {
          id: 'water-quality-circulation-2026-02-20',
          startDate: '2026-02-20',
          endDate: '2026-02-20',
          sourceCells: ['BG9'],
        },
        {
          id: 'water-quality-circulation-2026-02-27',
          startDate: '2026-02-27',
          endDate: '2026-02-27',
          sourceCells: ['BN9'],
        },
        {
          id: 'water-quality-circulation-2026-03-06',
          startDate: '2026-03-06',
          endDate: '2026-03-06',
          sourceCells: ['BU9'],
        },
        {
          id: 'water-quality-circulation-2026-03-13',
          startDate: '2026-03-13',
          endDate: '2026-03-13',
          sourceCells: ['CB9'],
        },
        {
          id: 'water-quality-circulation-2026-03-20',
          startDate: '2026-03-20',
          endDate: '2026-03-20',
          sourceCells: ['CI9'],
        },
        {
          id: 'water-quality-circulation-2026-03-27',
          startDate: '2026-03-27',
          endDate: '2026-03-27',
          sourceCells: ['CP9'],
        },
        {
          id: 'water-quality-circulation-2026-04-03',
          startDate: '2026-04-03',
          endDate: '2026-04-03',
          sourceCells: ['CW9'],
        },
        {
          id: 'water-quality-circulation-2026-04-10',
          startDate: '2026-04-10',
          endDate: '2026-04-10',
          sourceCells: ['DD9'],
        },
        {
          id: 'water-quality-circulation-2026-04-17',
          startDate: '2026-04-17',
          endDate: '2026-04-17',
          sourceCells: ['DK9'],
        },
        {
          id: 'water-quality-circulation-2026-04-24',
          startDate: '2026-04-24',
          endDate: '2026-04-24',
          sourceCells: ['DR9'],
        },
        {
          id: 'water-quality-circulation-2026-05-01',
          startDate: '2026-05-01',
          endDate: '2026-05-01',
          sourceCells: ['DY9'],
        },
        {
          id: 'water-quality-circulation-2026-05-08',
          startDate: '2026-05-08',
          endDate: '2026-05-08',
          sourceCells: ['EF9'],
        },
        {
          id: 'water-quality-circulation-2026-05-15',
          startDate: '2026-05-15',
          endDate: '2026-05-15',
          sourceCells: ['EM9'],
        },
        {
          id: 'water-quality-circulation-2026-05-22',
          startDate: '2026-05-22',
          endDate: '2026-05-22',
          sourceCells: ['ET9'],
        },
        {
          id: 'water-quality-circulation-2026-05-29',
          startDate: '2026-05-29',
          endDate: '2026-05-29',
          sourceCells: ['FA9'],
        },
        {
          id: 'water-quality-circulation-2026-06-05',
          startDate: '2026-06-05',
          endDate: '2026-06-05',
          sourceCells: ['FH9'],
        },
        {
          id: 'water-quality-circulation-2026-06-12',
          startDate: '2026-06-12',
          endDate: '2026-06-12',
          sourceCells: ['FO9'],
        },
        {
          id: 'water-quality-circulation-2026-06-19',
          startDate: '2026-06-19',
          endDate: '2026-06-19',
          sourceCells: ['FV9'],
        },
        {
          id: 'water-quality-circulation-2026-06-26',
          startDate: '2026-06-26',
          endDate: '2026-06-26',
          sourceCells: ['GC9'],
        },
        {
          id: 'water-quality-circulation-2026-07-03',
          startDate: '2026-07-03',
          endDate: '2026-07-03',
          sourceCells: ['GJ9'],
        },
        {
          id: 'water-quality-circulation-2026-07-10',
          startDate: '2026-07-10',
          endDate: '2026-07-10',
          sourceCells: ['GQ9'],
        },
        {
          id: 'water-quality-circulation-2026-07-17',
          startDate: '2026-07-17',
          endDate: '2026-07-17',
          sourceCells: ['GX9'],
        },
        {
          id: 'water-quality-circulation-2026-07-24',
          startDate: '2026-07-24',
          endDate: '2026-07-24',
          sourceCells: ['HE9'],
        },
        {
          id: 'water-quality-circulation-2026-07-31',
          startDate: '2026-07-31',
          endDate: '2026-07-31',
          sourceCells: ['HL9'],
        },
        {
          id: 'water-quality-circulation-2026-08-07',
          startDate: '2026-08-07',
          endDate: '2026-08-07',
          sourceCells: ['HS9'],
        },
        {
          id: 'water-quality-circulation-2026-08-14',
          startDate: '2026-08-14',
          endDate: '2026-08-14',
          sourceCells: ['HZ9'],
        },
        {
          id: 'water-quality-circulation-2026-08-21',
          startDate: '2026-08-21',
          endDate: '2026-08-21',
          sourceCells: ['IG9'],
        },
        {
          id: 'water-quality-circulation-2026-08-28',
          startDate: '2026-08-28',
          endDate: '2026-08-28',
          sourceCells: ['IN9'],
        },
        {
          id: 'water-quality-circulation-2026-09-04',
          startDate: '2026-09-04',
          endDate: '2026-09-04',
          sourceCells: ['IU9'],
        },
        {
          id: 'water-quality-circulation-2026-09-11',
          startDate: '2026-09-11',
          endDate: '2026-09-11',
          sourceCells: ['JB9'],
        },
        {
          id: 'water-quality-circulation-2026-09-18',
          startDate: '2026-09-18',
          endDate: '2026-09-18',
          sourceCells: ['JI9'],
        },
        {
          id: 'water-quality-circulation-2026-09-25',
          startDate: '2026-09-25',
          endDate: '2026-09-25',
          sourceCells: ['JP9'],
        },
        {
          id: 'water-quality-circulation-2026-10-02',
          startDate: '2026-10-02',
          endDate: '2026-10-02',
          sourceCells: ['JW9'],
        },
        {
          id: 'water-quality-circulation-2026-10-09',
          startDate: '2026-10-09',
          endDate: '2026-10-09',
          sourceCells: ['KD9'],
        },
        {
          id: 'water-quality-circulation-2026-10-16',
          startDate: '2026-10-16',
          endDate: '2026-10-16',
          sourceCells: ['KK9'],
        },
        {
          id: 'water-quality-circulation-2026-10-23',
          startDate: '2026-10-23',
          endDate: '2026-10-23',
          sourceCells: ['KR9'],
        },
        {
          id: 'water-quality-circulation-2026-10-30',
          startDate: '2026-10-30',
          endDate: '2026-10-30',
          sourceCells: ['KY9'],
        },
        {
          id: 'water-quality-circulation-2026-11-06',
          startDate: '2026-11-06',
          endDate: '2026-11-06',
          sourceCells: ['LF9'],
        },
        {
          id: 'water-quality-circulation-2026-11-13',
          startDate: '2026-11-13',
          endDate: '2026-11-13',
          sourceCells: ['LM9'],
        },
        {
          id: 'water-quality-circulation-2026-11-20',
          startDate: '2026-11-20',
          endDate: '2026-11-20',
          sourceCells: ['LT9'],
        },
        {
          id: 'water-quality-circulation-2026-11-27',
          startDate: '2026-11-27',
          endDate: '2026-11-27',
          sourceCells: ['MA9'],
        },
        {
          id: 'water-quality-circulation-2026-12-04',
          startDate: '2026-12-04',
          endDate: '2026-12-04',
          sourceCells: ['MH9'],
        },
        {
          id: 'water-quality-circulation-2026-12-11',
          startDate: '2026-12-11',
          endDate: '2026-12-11',
          sourceCells: ['MO9'],
        },
        {
          id: 'water-quality-circulation-2026-12-18',
          startDate: '2026-12-18',
          endDate: '2026-12-18',
          sourceCells: ['MV9'],
        },
        {
          id: 'water-quality-circulation-2026-12-25',
          startDate: '2026-12-25',
          endDate: '2026-12-25',
          sourceCells: ['NC9'],
        },
      ],
      adjustments: [
        {
          date: '2026-02-20',
          label: '春节',
          sourceCell: 'BG9',
        },
        {
          date: '2026-05-01',
          label: '五一',
          sourceCell: 'DY9',
        },
        {
          date: '2026-06-19',
          label: '端午',
          sourceCell: 'FV9',
        },
        {
          date: '2026-09-25',
          label: '中秋',
          sourceCell: 'JP9',
        },
        {
          date: '2026-10-02',
          label: '国庆',
          sourceCell: 'JW9',
        },
      ],
      notes: [
        'li.guoquan:\n如制冷单元轮询时间与水质循环时间一致，可不进行水质循环',
      ],
      sourceRow: 9,
    },
  ],
} as const satisfies EquipmentRotationPlan2026;
