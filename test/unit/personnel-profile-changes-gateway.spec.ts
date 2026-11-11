import { PersonnelProfileChangesGateway } from '../../server/common/access/personnel-profile-changes.gateway';
const source = {
  appId: 'cliTest',
  appToken: 'appTest',
  tableId: 'tblTest',
  recordId: 'recTest',
};
describe('profile change field boundary', () => {
  let get: jest.Mock, gateway: PersonnelProfileChangesGateway;
  beforeEach(() => {
    get = jest.fn();
    gateway = new PersonnelProfileChangesGateway({ axiosRef: { get } } as any);
    jest.spyOn(gateway, 'verifySource').mockResolvedValue(undefined);
    jest.spyOn(gateway as any, 'config').mockResolvedValue({});
  });
  it('updates the photo field actually used by the reader, not the first empty alias', async () => {
    get.mockResolvedValue({
      data: {
        code: 0,
        data: {
          items: [
            { field_name: '照片', type: 17 },
            { field_name: '证件照', type: 17 },
          ],
          has_more: false,
        },
      },
    });
    await expect(
      gateway.fields(source, ['photo'], {
        record_id: 'recTest',
        fields: { 照片: [], 证件照: [{ file_token: 'token-real' }] },
      }),
    ).resolves.toEqual({ photo: '证件照' });
  });
  it('rejects incomplete metadata pagination and read-only field types', async () => {
    get.mockResolvedValueOnce({
      data: { code: 0, data: { items: [], has_more: true } },
    });
    await expect(
      gateway.fields(source, ['phone'], { fields: {} }),
    ).rejects.toThrow('分页不完整');
    get.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [{ field_name: '联系方式', type: 20 }],
          has_more: false,
        },
      },
    });
    await expect(
      gateway.fields(source, ['phone'], { fields: { 联系方式: '123' } }),
    ).rejects.toThrow('不可修改');
  });
  it('rejects a record response belonging to another target', async () => {
    get.mockResolvedValue({
      data: {
        code: 0,
        data: { record: { record_id: 'recOther', fields: {} } },
      },
    });
    await expect(gateway.read(source)).rejects.toThrow('核对失败');
  });
  it('uses the existing text mapping and does not add another field', async () => {
    get.mockResolvedValue({
      data: {
        code: 0,
        data: {
          items: [
            { field_name: '联系方式', type: 1 },
            { field_name: '手机号', type: 13 },
          ],
          has_more: false,
        },
      },
    });
    await expect(
      gateway.fields(source, ['phone'], { fields: { 手机号: '13800000000' } }),
    ).resolves.toEqual({ phone: '手机号' });
  });
});
