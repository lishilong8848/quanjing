jest.mock('../../server/common/feishu/bitable-direct-read', () => {
  const actual = jest.requireActual(
    '../../server/common/feishu/bitable-direct-read',
  );
  return {
    ...actual,
    fetchBitableRecords: jest.fn(),
    readLatestPersistedBitableRecordSnapshot: jest.fn(),
  };
});

import { ServiceUnavailableException } from '@nestjs/common';
import {
  buildActivePersonnelDirectory,
  DEFAULT_ACTIVE_PERSONNEL_TABLE_ID,
  DEFAULT_ACTIVE_PERSONNEL_VIEW_ID,
  searchActivePersonnelCandidates,
} from '../../server/modules/bitable-sync/active-personnel-directory';
import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
  type BitableRecordItem,
} from '../../server/common/feishu/bitable-direct-read';

const mockedReadLatestSnapshot = jest.mocked(
  readLatestPersistedBitableRecordSnapshot,
);
const mockedFetchBitableRecords = jest.mocked(fetchBitableRecords);

function record(
  id: string,
  fields: Record<string, unknown>,
): BitableRecordItem {
  return { record_id: id, fields };
}

describe('active personnel directory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('maps only active personnel, extracts supported buildings and resolves both manager roles', () => {
    const directory = buildActivePersonnelDirectory(
      {
        records: [
          record('rec-operator', {
            姓名: [{ text: '示例人员008' }],
            员工姓名: [{ id: 'ou-operator', name: '示例人员008' }],
            示例人员001: [
              { id: 'ou-supervisor-a', name: '直属示例人员001甲' },
              { id: 'ou-supervisor-b', name: '直属示例人员001乙' },
            ],
            员工工号: [{ text: '1001' }],
            岗位: '值班工程师',
            体系岗位: '运维工程师',
            '机楼/专业': ['南通基地-A楼、B楼/弱电'],
            '离职/异动情况': false,
          }),
          record('rec-manager', {
            姓名: '梅经理',
            员工姓名: [{ id: 'ou-manager', name: '梅经理' }],
            岗位: '设施运维经理',
            体系岗位: '运维经理',
            '机楼/专业': ['E楼'],
          }),
          record('rec-deputy-manager', {
            员工姓名: [{ id: 'ou-deputy', name: '马副经理' }],
            岗位: '设施运维副经理',
            体系岗位: '运维经理',
            '机楼/专业': ['H楼、110站'],
            '离职/异动情况': 'false',
          }),
          record('rec-inactive', {
            姓名: '已离职人员',
            员工姓名: [{ id: 'ou-inactive', name: '已离职人员' }],
            '机楼/专业': ['C楼'],
            '离职/异动情况': true,
          }),
          record('rec-moved', {
            姓名: '已异动人员',
            员工姓名: [{ id: 'ou-moved', name: '已异动人员' }],
            '机楼/专业': ['D楼'],
            '离职/异动情况': '已异动',
          }),
          record('rec-no-open-id', {
            姓名: '缺少账号',
            '机楼/专业': ['C楼'],
          }),
          record('rec-duplicate', {
            姓名: '重复账号',
            员工姓名: [{ id: 'ou-operator', name: '重复账号' }],
            '机楼/专业': ['D楼'],
          }),
          record('rec-no-name', {
            员工姓名: [{}],
            '机楼/专业': ['C楼'],
          }),
        ],
        fetchedAt: 1_000,
        expiresAt: 2_000,
      },
      2_500,
    );

    expect(directory.personnel).toEqual([
      expect.objectContaining({
        recordId: 'rec-deputy-manager',
        name: '马副经理',
        openId: 'ou-deputy',
        position: '设施运维副经理',
        systemPosition: '运维经理',
        buildings: ['H', '110'],
      }),
      expect.objectContaining({
        recordId: 'rec-manager',
        name: '梅经理',
        openId: 'ou-manager',
        buildings: ['E'],
      }),
      expect.objectContaining({
        recordId: 'rec-operator',
        name: '示例人员008',
        openId: 'ou-operator',
        employeeNo: '1001',
        buildings: ['A', 'B'],
        supervisorNames: ['直属示例人员001甲', '直属示例人员001乙'],
      }),
    ]);
    expect(directory.selectablePersonnel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: 'rec-no-open-id',
          name: '缺少账号',
          openId: '',
          buildings: ['C'],
        }),
        expect.objectContaining({
          recordId: 'rec-operator',
          name: '示例人员008',
          openId: 'ou-operator',
        }),
      ]),
    );
    expect(directory.managers.map((person) => person.openId)).toEqual([
      'ou-deputy',
      'ou-manager',
    ]);
    expect(directory.snapshot).toEqual({
      fetchedAt: 1_000,
      expiresAt: 2_000,
      stale: true,
    });
    expect(directory.quality).toEqual({
      sourceRecordCount: 8,
      activeRecordCount: 6,
      inactiveRecordCount: 2,
      usablePersonnelCount: 3,
      managerCount: 2,
      missingNameCount: 1,
      missingOpenIdCount: 2,
      duplicateOpenIdCount: 1,
      missingBuildingCount: 0,
    });
    expect(searchActivePersonnelCandidates(directory, '示例人员008')).toEqual([
      { recordId: 'rec-operator', name: '示例人员008', position: '值班工程师', buildings: ['A', 'B'] },
    ]);
    expect(searchActivePersonnelCandidates(directory, '已离职')).toEqual([]);
  });

  it('uses the latest persisted snapshot only and never falls through to a direct Base request', async () => {
    mockedReadLatestSnapshot.mockResolvedValue({
      records: [
        record('rec-a', {
          员工姓名: [{ id: 'ou-a', name: '甲' }],
          '机楼/专业': ['A楼'],
        }),
      ],
      fetchedAt: 1_000,
      expiresAt: 2_000,
    });
    const service = new BitableSyncService({} as never, {} as never);

    const directory = await service.getCachedActivePersonnelDirectory();

    expect(directory.personnel).toHaveLength(1);
    expect(mockedReadLatestSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        tableId: DEFAULT_ACTIVE_PERSONNEL_TABLE_ID,
        viewId: DEFAULT_ACTIVE_PERSONNEL_VIEW_ID,
        tableName: '在职人员',
      }),
    );
    expect(mockedFetchBitableRecords).not.toHaveBeenCalled();
  });

  it('fails explicitly when no local active-personnel snapshot exists', async () => {
    mockedReadLatestSnapshot.mockResolvedValue(null);
    const service = new BitableSyncService({} as never, {} as never);

    await expect(
      service.getCachedActivePersonnelDirectory(),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(mockedFetchBitableRecords).not.toHaveBeenCalled();
  });
});
