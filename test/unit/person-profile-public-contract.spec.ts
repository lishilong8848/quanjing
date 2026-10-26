import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BitableSyncService } from '../../server/modules/bitable-sync/bitable-sync.service';

describe('public person profile privacy contract', () => {
  it('returns only schedule-required fields without Feishu identifiers or metadata', async () => {
    const service = new BitableSyncService({} as never, {} as never);
    const internals = service as unknown as {
      fetchFeishuPersonProfileRecords: jest.Mock;
    };
    internals.fetchFeishuPersonProfileRecords = jest.fn().mockResolvedValue([
      {
        record_id: 'rec_real_secret',
        created_time: 1_700_000_000_000,
        last_modified_time: 1_710_000_000_000,
        fields: {
          姓名: '示例人员020',
          员工姓名: [{ id: 'ou_private_contact_123', name: '示例人员020' }],
          '机楼/专业': 'H楼',
          岗位: '设施运维副经理',
          班次: '长白',
          联系方式: '13800009626',
          照片: [{ file_token: 'file_secret' }],
        },
      },
    ]);

    const response = await service.getPersonProfiles(true, 'leave');

    expect(response).toEqual({
      organizations: [
        {
          supervisorText: '示例人员020',
          position: '设施运维副经理',
          buildingsSpecialties: ['H楼'],
          shift: '长白',
        },
      ],
      changeRequestSubmitters: ['示例人员020'],
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('rec_real_secret');
    expect(serialized).not.toContain('13800009626');
    expect(serialized).not.toContain('file_secret');
    expect(serialized).not.toContain('ou_private_contact_123');
    expect(serialized).not.toContain('applink.feishu.cn');
    expect(serialized).not.toMatch(/"(?:id|recordId|createdAt|updatedAt)"/);
  });

  it('uses a dedicated travel view and explicitly disallows stale profile reads', () => {
    const serviceSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/bitable-sync/bitable-sync.service.ts',
      ),
      'utf8',
    );
    const travelConfig = serviceSource.slice(
      serviceSource.indexOf('private readonly TRAVEL_PERSON_PROFILE_VIEW_ID'),
      serviceSource.indexOf('// 飞书多维表配置 - 员工证书信息表'),
    );

    expect(travelConfig).toContain('FEISHU_TRAVEL_PERSON_PROFILE_VIEW_ID');
    expect(travelConfig).toContain('FEISHU_PERSONNEL_MOVEMENT_VIEW_ID');
    expect(travelConfig).not.toContain('FEISHU_ORG_VIEW_ID');
    expect(travelConfig).not.toContain('FEISHU_ORGANIZATION_VIEW_ID');
    expect(serviceSource).toContain('allowStale: plan.allowStale');
  });

  it('keeps employee photos behind authenticated access', () => {
    const controllerSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/bitable-sync/bitable-sync.controller.ts',
      ),
      'utf8',
    );
    const photoDecoratorStart = controllerSource.lastIndexOf(
      '\n  @',
      controllerSource.indexOf('async getEmployeePhoto'),
    );
    const photoBlock = controllerSource.slice(
      photoDecoratorStart,
      controllerSource.indexOf('async getEmployeePhoto'),
    );

    expect(photoBlock).toContain("@Get('employee-photo/:recordId')");
    expect(photoBlock).not.toContain('@GuestReadable()');
  });

  it('types the transport as a safe DTO and creates only local compatibility ids', () => {
    const sharedSource = readFileSync(
      join(process.cwd(), 'shared/api.interface.ts'),
      'utf8',
    );
    const publicProfileContract = sharedSource.slice(
      sharedSource.indexOf('export interface PersonProfile {'),
      sharedSource.indexOf('export interface PersonProfileDetail'),
    );
    const clientSource = readFileSync(
      join(process.cwd(), 'client/src/api/index.ts'),
      'utf8',
    );
    const clientAdapter = clientSource.slice(
      clientSource.indexOf('export async function getPersonProfiles'),
      clientSource.indexOf('export async function syncOrganization'),
    );

    expect(publicProfileContract).toContain(
      'export interface PersonProfileResponse',
    );
    expect(publicProfileContract).not.toMatch(
      /\b(?:id|recordId|createdAt|updatedAt)\s*:/,
    );
    expect(clientAdapter).toContain('PersonProfileResponse');
    expect(clientAdapter).toContain('person-profile-${scope}-${index + 1}');
    expect(clientAdapter).not.toContain('profile.recordId');
    expect(clientAdapter).not.toContain('profile.id');
  });

  it('provides full details only through the dedicated protected service method', async () => {
    const service = new BitableSyncService({} as never, {} as never);
    const internals = service as unknown as {
      fetchFeishuPersonProfileRecords: jest.Mock;
      getPersonProfileDetails: (
        forceRefresh: boolean,
        scope: 'leave' | 'travel',
      ) => Promise<{
        organizations: Array<Record<string, unknown>>;
      }>;
    };
    internals.fetchFeishuPersonProfileRecords = jest.fn().mockResolvedValue([
      {
        record_id: 'rec_real_secret',
        fields: {
          姓名: '示例人员020',
          员工姓名: [{ id: 'ou_private_contact_123', name: '示例人员020' }],
          '机楼/专业': 'H楼',
          岗位: '设施运维副经理',
          班次: '长白',
          联系方式: '13800009626',
          照片: [{ file_token: 'file_secret' }],
        },
      },
    ]);

    const response = await internals.getPersonProfileDetails(true, 'leave');

    expect(response.organizations).toEqual([
      expect.objectContaining({
        recordId: 'rec_real_secret',
        supervisorText: '示例人员020',
        phone: '13800009626',
        photoUrl:
          '/api/bitable/employee-photo/rec_real_secret?scope=leave',
        feishuChatUrl:
          '/api/bitable/person-chat/rec_real_secret?scope=leave',
      }),
    ]);
  });

  it('loads a profile photo from the matching local detail snapshot instead of another Base table', async () => {
    const service = new BitableSyncService({} as never, {} as never);
    const expectedPhoto = {
      contentType: 'image/jpeg',
      buffer: Buffer.from('profile-photo'),
    };
    const internals = service as unknown as {
      readCachedPersonProfileRecords: jest.Mock;
      fetchFeishuOrganizationRecords: jest.Mock;
      getTenantAccessToken: jest.Mock;
      downloadEmployeePhotoFromUrl: jest.Mock;
      getEmployeePhoto: (
        recordId: string,
        scope: 'leave' | 'travel' | 'organization',
      ) => Promise<typeof expectedPhoto | null>;
    };
    internals.readCachedPersonProfileRecords = jest.fn().mockResolvedValue([
      {
        record_id: 'rec_MixedCase_Profile',
        fields: { 照片: [{ url: 'https://example.test/profile.jpg' }] },
      },
    ]);
    internals.fetchFeishuOrganizationRecords = jest
      .fn()
      .mockRejectedValue(new Error('organization source must not be used'));
    internals.getTenantAccessToken = jest.fn().mockResolvedValue('token');
    internals.downloadEmployeePhotoFromUrl = jest
      .fn()
      .mockResolvedValue(expectedPhoto);

    await expect(
      internals.getEmployeePhoto('rec_MixedCase_Profile', 'leave'),
    ).resolves.toEqual(expectedPhoto);
    expect(internals.readCachedPersonProfileRecords).toHaveBeenCalledWith(
      'leave',
      true,
    );
    expect(internals.fetchFeishuOrganizationRecords).not.toHaveBeenCalled();
  });

  it('serves ordinary form personnel reads from the local snapshot without calling Feishu', async () => {
    const service = new BitableSyncService({} as never, {} as never);
    const internals = service as unknown as {
      readCachedPersonProfileRecords: jest.Mock;
      fetchFeishuPersonProfileRecords: jest.Mock;
    };
    internals.readCachedPersonProfileRecords = jest.fn().mockResolvedValue([
      {
        record_id: 'rec_local_profile',
        fields: {
          姓名: '示例人员020',
          '机楼/专业': 'H楼',
          岗位: '设施运维副经理',
          班次: '长白',
        },
      },
    ]);
    internals.fetchFeishuPersonProfileRecords = jest
      .fn()
      .mockRejectedValue(new Error('Feishu must not be called'));

    await expect(service.getPersonProfiles(false, 'leave')).resolves.toEqual({
      organizations: [
        expect.objectContaining({
          supervisorText: '示例人员020',
          position: '设施运维副经理',
        }),
      ],
      changeRequestSubmitters: [],
    });
    expect(internals.readCachedPersonProfileRecords).toHaveBeenCalledWith(
      'leave',
      false,
    );
    expect(internals.fetchFeishuPersonProfileRecords).not.toHaveBeenCalled();
  });

  it('warms public and private personnel snapshots in the background', async () => {
    const service = new BitableSyncService({} as never, {} as never);
    const internals = service as unknown as {
      fetchFeishuNonDutyRecords: jest.Mock;
      fetchFeishuScheduleRecords: jest.Mock;
      fetchFeishuFestivalImportantRecords: jest.Mock;
      fetchFeishuPersonProfileRecords: jest.Mock;
      refreshFeishuLocalCache: () => Promise<void>;
    };
    internals.fetchFeishuNonDutyRecords = jest.fn().mockResolvedValue([]);
    internals.fetchFeishuScheduleRecords = jest.fn().mockResolvedValue([]);
    internals.fetchFeishuFestivalImportantRecords = jest
      .fn()
      .mockResolvedValue([]);
    internals.fetchFeishuPersonProfileRecords = jest
      .fn()
      .mockResolvedValue([]);

    await internals.refreshFeishuLocalCache();

    expect(internals.fetchFeishuPersonProfileRecords).toHaveBeenCalledWith(
      true,
      'leave',
    );
    expect(internals.fetchFeishuPersonProfileRecords).toHaveBeenCalledWith(
      true,
      'leave',
      true,
    );
  });

  it('preloads leave-form snapshots before starting background refresh', () => {
    const serviceSource = readFileSync(
      join(
        process.cwd(),
        'server/modules/bitable-sync/bitable-sync.service.ts',
      ),
      'utf8',
    );
    const initStart = serviceSource.indexOf('async onModuleInit');
    const initEnd = serviceSource.indexOf('onModuleDestroy', initStart);
    const initMethod = serviceSource.slice(initStart, initEnd);
    const warmMethodStart = serviceSource.indexOf(
      'private async warmLeaveFormLocalSnapshots',
    );
    const warmMethodEnd = serviceSource.indexOf(
      'private async refreshLeaveApprovalCache',
      warmMethodStart,
    );
    const warmMethod = serviceSource.slice(warmMethodStart, warmMethodEnd);

    expect(initMethod).toContain('await this.warmLeaveFormLocalSnapshots()');
    expect(initMethod.indexOf('await this.warmLeaveFormLocalSnapshots()')).toBeLessThan(
      initMethod.indexOf('void this.refreshFeishuLocalCache()'),
    );
    expect(warmMethod).toContain('readLatestPersistedBitableRecordSnapshot');
    expect(warmMethod).toContain("this.readCachedPersonProfileRecords('leave', false)");
    expect(warmMethod).toContain("this.readCachedPersonProfileRecords('leave', true)");
    expect(warmMethod).toContain('readCachedLeaveApprovalSnapshot()');
  });

  it('uses four-hour base synchronization and fifteen-minute approval synchronization by default', () => {
    const previousLocalRefresh = process.env.FEISHU_LOCAL_CACHE_REFRESH_MS;
    const previousApprovalRefresh =
      process.env.FEISHU_LEAVE_APPROVAL_REFRESH_MS;
    delete process.env.FEISHU_LOCAL_CACHE_REFRESH_MS;
    delete process.env.FEISHU_LEAVE_APPROVAL_REFRESH_MS;
    try {
      const service = new BitableSyncService({} as never, {} as never);
      const internals = service as unknown as {
        getLocalCacheRefreshMs: () => number;
        getLeaveApprovalRefreshMs: () => number;
      };
      expect(internals.getLocalCacheRefreshMs()).toBe(4 * 60 * 60 * 1000);
      expect(internals.getLeaveApprovalRefreshMs()).toBe(15 * 60 * 1000);
    } finally {
      if (previousLocalRefresh === undefined) {
        delete process.env.FEISHU_LOCAL_CACHE_REFRESH_MS;
      } else {
        process.env.FEISHU_LOCAL_CACHE_REFRESH_MS = previousLocalRefresh;
      }
      if (previousApprovalRefresh === undefined) {
        delete process.env.FEISHU_LEAVE_APPROVAL_REFRESH_MS;
      } else {
        process.env.FEISHU_LEAVE_APPROVAL_REFRESH_MS =
          previousApprovalRefresh;
      }
    }
  });
});
