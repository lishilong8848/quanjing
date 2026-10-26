import { AccessLoginNamesService } from '../../server/common/access/access-login-names.service';
import { readLatestPersistedBitableRecordSnapshot } from '../../server/common/feishu/bitable-direct-read';
import { UnifiedAccessController } from '../../server/common/access/unified-access.controller';
import { PublicAccessMetadataKey } from '../../server/common/access/unified-access.decorators';

jest.mock('../../server/common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../server/common/feishu/bitable-direct-read'),
  readLatestPersistedBitableRecordSnapshot: jest.fn(),
}));

describe('login name suggestions', () => {
  afterEach(() => jest.clearAllMocks());
  it('reads the active-personnel snapshot and exposes names only, including people without Open IDs', async () => {
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue({
      fetchedAt: 123, expiresAt: 456,
      records: [
        { record_id: 'recA', fields: { 姓名: '验收甲', 密码: 'never-return', open_id: 'never-return' } },
        { record_id: 'recB', fields: { 姓名: '验收乙', '离职/异动情况': true } },
        { record_id: 'recC', fields: { 姓名: ' 验收甲 ' } },
        { record_id: 'recD', fields: { 姓名: '验收丙' } },
        { record_id: 'recE', fields: { 姓名: '\u202e无效' } },
      ],
    });
    const result = await new AccessLoginNamesService().read();
    expect(result).toEqual({ names: ['验收丙', '验收甲'], snapshotAt: 123 });
    expect(JSON.stringify(result)).not.toMatch(/never-return|密码|open_id|recA/);
    expect(readLatestPersistedBitableRecordSnapshot).toHaveBeenCalledWith(expect.objectContaining({ tableName: '在职人员', viewId: expect.any(String) }));
  });
  it('fails explicitly when the synchronized snapshot is missing', async () => {
    (readLatestPersistedBitableRecordSnapshot as jest.Mock).mockResolvedValue(null);
    await expect(new AccessLoginNamesService().read()).rejects.toThrow('请手动输入姓名');
  });
  it('provides only the directory response before login and disables intermediary caching', async () => {
    const directory = { read: jest.fn().mockResolvedValue({ names: ['验收甲'], snapshotAt: 123 }) };
    const response = { setHeader: jest.fn() };
    const controller = new UnifiedAccessController({} as never, {} as never, directory as never);
    expect(Reflect.getMetadata(PublicAccessMetadataKey, controller.names)).toBe(true);
    expect(await controller.names(response as never)).toEqual({ names: ['验收甲'], snapshotAt: 123 });
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  });
});
