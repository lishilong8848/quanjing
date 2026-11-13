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
  it('normalizes an omitted unchecked employment checkbox only after complete matching metadata',async()=>{
    get.mockResolvedValueOnce({data:{code:0,data:{record:{record_id:source.recordId,fields:{姓名:'合成人员'}}}}})
      .mockResolvedValueOnce({data:{code:0,data:{items:[],has_more:true,page_token:'page2'}}})
      .mockResolvedValueOnce({data:{code:0,data:{items:[{field_name:'离职/异动情况',type:7}],has_more:false}}});
    await expect(gateway.read(source)).resolves.toMatchObject({fields:{'离职/异动情况':false}});
    expect(get).toHaveBeenCalledTimes(3);
  });
  it.each([true,null,'','未确认'])('does not normalize explicit employment value %s',async value=>{
    get.mockResolvedValue({data:{code:0,data:{record:{record_id:source.recordId,fields:{'离职/异动情况':value}}}}});
    await expect(gateway.read(source)).rejects.toThrow('人员在职状态已变化');expect(get).toHaveBeenCalledTimes(1);
  });
  it.each([{items:[]},{items:[{field_name:'离职/异动情况',type:1}]}])('rejects missing or non-checkbox schema',async ({items})=>{
    get.mockResolvedValueOnce({data:{code:0,data:{record:{record_id:source.recordId,fields:{}}}}})
      .mockResolvedValueOnce({data:{code:0,data:{items,has_more:false}}});
    await expect(gateway.read(source)).rejects.toThrow('人员在职状态已变化');
  });
  it.each([
    {items:[{field_name:'离职/异动情况',type:7}],has_more:true},
    {items:[{field_name:'离职/异动情况',type:7}]},
    {items:[{field_name:'离职/异动情况',type:7},{field_name:'离职/异动情况',type:1}],has_more:false},
  ])('rejects incomplete or ambiguous metadata without assuming active',async data=>{
    get.mockResolvedValueOnce({data:{code:0,data:{record:{record_id:source.recordId,fields:{}}}}}).mockResolvedValueOnce({data:{code:0,data}});
    await expect(gateway.read(source)).rejects.toThrow('人员字段');
  });
  it('keeps explicit active records fast and rejects malformed fields',async()=>{
    get.mockResolvedValueOnce({data:{code:0,data:{record:{record_id:source.recordId,fields:{'离职/异动情况':false}}}}});
    await expect(gateway.read(source)).resolves.toMatchObject({fields:{'离职/异动情况':false}});expect(get).toHaveBeenCalledTimes(1);
    get.mockResolvedValueOnce({data:{code:0,data:{record:{record_id:source.recordId,fields:[]}}}});
    await expect(gateway.read(source)).rejects.toThrow('核对失败');
  });
  it('does not reuse unchecked-checkbox inference after schema or source changes',async()=>{
    const record=()=>({data:{code:0,data:{record:{record_id:source.recordId,fields:{}}}}});
    get.mockResolvedValueOnce(record()).mockResolvedValueOnce({data:{code:0,data:{items:[{field_name:'离职/异动情况',type:7}],has_more:false}}});
    await gateway.read(source);
    get.mockResolvedValueOnce(record()).mockResolvedValueOnce({data:{code:0,data:{items:[{field_name:'离职/异动情况',type:1}],has_more:false}}});
    await expect(gateway.read(source)).rejects.toThrow('人员在职状态已变化');
    jest.mocked(gateway.verifySource).mockRejectedValueOnce(new Error('source changed'));get.mockClear();
    await expect(gateway.read(source)).rejects.toThrow('source changed');expect(get).not.toHaveBeenCalled();
  });
});
