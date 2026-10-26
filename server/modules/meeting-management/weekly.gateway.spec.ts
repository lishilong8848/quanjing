import { HttpService } from '@nestjs/axios';
import { WeeklyGateway } from './weekly.gateway';
import {
  getTenantAccessToken,
  invalidateBitableRecordCache,
} from '../../common/feishu/bitable-direct-read';
jest.mock('../../common/feishu/bitable-direct-read', () => ({
  ...jest.requireActual('../../common/feishu/bitable-direct-read'),
  getTenantAccessToken: jest.fn().mockResolvedValue('qa-not-a-real-token'),
  invalidateBitableRecordCache: jest.fn(),
}));

describe('weekly field adapter and permissions', () => {
  it('保留多行文本、空行、重复行和缩进，不按展示标签拆分正文', () => {
    const adapter = new WeeklyGateway({} as HttpService);
    const value = '1. 核对电气\n  保留缩进\n\n2. 相邻事项\n2. 相邻事项';
    expect(adapter.text(value)).toBe(value);
    expect(
      adapter.text([{ text: '1. 原事项\n' }, { text: '2. 相邻事项' }]),
    ).toBe('1. 原事项\n2. 相邻事项');
  });
  let fields: Record<string, unknown>;
  let request: jest.Mock;
  let gateway: WeeklyGateway;
  beforeEach(() => {
    fields = {
      阿里会议待办: [{ text: '旧待办' }],
      链接: { link: 'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE', text: '查看周报' },
    };
    request = jest.fn(async (options) => {
      if (options.url.endsWith('/fields'))
        return {
          data: {
            code: 0,
            data: {
              items: [
                { field_name: '阿里会议待办', type: 1 },
                { field_name: '链接', type: 15 },
                { field_name: '阿里会议附件', type: 17 },
              ],
              has_more: false,
            },
          },
        };
      if (options.method === 'PUT')
        fields = { ...fields, ...options.data.fields };
      return {
        data: {
          code: 0,
          data: { record: { record_id: 'recExample', fields } },
        },
      };
    });
    gateway = new WeeklyGateway({
      axiosRef: { request },
    } as unknown as HttpService);
    jest.mocked(invalidateBitableRecordCache).mockClear();
  });
  it('writes only the requested field and compares rich-text semantics', async () => {
    await gateway.update(
      'recExample',
      { 阿里会议待办: '旧待办' },
      { 阿里会议待办: '新待办\r\n示例人员019：测试' },
    );
    const writes = request.mock.calls.filter(
      (call) => call[0].method === 'PUT',
    );
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0][0].data.fields)).toEqual(['阿里会议待办']);
    expect(invalidateBitableRecordCache).toHaveBeenCalledWith(
      expect.objectContaining({ tableId: 'tbl96c6dccf01af4' }),
    );
  });
  it('以机器人身份向指定群发送周报链接，携带稳定去重编号', async () => {
    request.mockResolvedValueOnce({
      data: { code: 0, data: { message_id: 'om_Notification' } },
    });
    expect(
      await gateway.sendWeeklyReport(
        'oc_a584b9f72f95d94e665e51af321e516c',
        'a'.repeat(32),
        '本周周报',
        'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE',
      ),
    ).toBe('om_Notification');
    const call = request.mock.calls[0][0];
    expect(call.params).toEqual({ receive_id_type: 'chat_id' });
    expect(call.data).toMatchObject({
      receive_id: 'oc_a584b9f72f95d94e665e51af321e516c',
      msg_type: 'text',
      uuid: 'a'.repeat(32),
    });
    expect(JSON.parse(call.data.content).text).toContain(
      '请各专业示例人员019更新本周内容和待办',
    );
  });
  it('空条目提醒使用飞书返回的记录链接，标识不符时拒绝发送', async () => {
    const link =
      'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE';
    request.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [{ record_id: 'recNew', record_url: link }],
          has_more: false,
        },
      },
    });
    expect(await gateway.creationLink('create-12345678', 'recNew')).toBe(link);
    request.mockResolvedValueOnce({
      data: {
        code: 0,
        data: { items: [{ record_id: 'recNew' }], has_more: false },
      },
    });
    expect(await gateway.creationLink('create-12345678', 'recNew')).toBe(
      'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
    );
    request.mockResolvedValueOnce({
      data: {
        code: 0,
        data: {
          items: [{ record_id: 'recOther', record_url: link }],
          has_more: false,
        },
      },
    });
    await expect(
      gateway.creationLink('create-12345678', 'recNew'),
    ).rejects.toThrow('未确认');
  });
  it('通知接口拒绝时给出可执行错误，不伪报成功或自动盲发', async () => {
    request.mockResolvedValueOnce({ data: { code: 230002 } });
    await expect(
      gateway.sendWeeklyReport(
        'oc_a584b9f72f95d94e665e51af321e516c',
        'a'.repeat(32),
        '周报',
        'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE',
      ),
    ).rejects.toMatchObject({ notificationRejected: true });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('retries a timed-out attachment field read without retrying uploads or writes', async () => {
    request.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
    );
    await gateway.assertAttachmentField('阿里会议附件');
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every((call) => call[0].method === 'GET')).toBe(
      true,
    );
  });
  it('persists a created row ID before a failed confirmation read', async () => {
    const saved = jest.fn();
    request.mockImplementation(async (options) => {
      if (options.method === 'POST')
        return { data: { code: 0, data: { record: { record_id: 'recNew' } } } };
      throw new Error('回读暂时失败');
    });
    await expect(
      gateway.createRow('2026-10-14', 'create-12345678', saved),
    ).rejects.toThrow('回读');
    expect(saved).toHaveBeenCalledWith('recNew');
    expect(
      request.mock.calls.filter((call) => call[0].method === 'POST'),
    ).toHaveLength(1);
  });
  it('refuses to overwrite a changed source', async () => {
    fields['阿里会议待办'] = '别人修改';
    await expect(
      gateway.update(
        'recExample',
        { 阿里会议待办: '旧待办' },
        { 阿里会议待办: '新待办' },
      ),
    ).rejects.toThrow('已被示例人员004修改');
    expect(request.mock.calls.some((call) => call[0].method === 'PUT')).toBe(
      false,
    );
  });
  it('recovers a completed write without writing it twice', async () => {
    fields['阿里会议待办'] = [{ text: '新待办' }];
    await gateway.update(
      'recExample',
      { 阿里会议待办: '旧待办' },
      { 阿里会议待办: '新待办' },
    );
    expect(request.mock.calls.some((call) => call[0].method === 'PUT')).toBe(
      false,
    );
  });
  it('uses link identity instead of displayed hyperlink text', async () => {
    await gateway.update(
      'recExample',
      { 链接: 'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE' },
      { 链接: 'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE' },
    );
    expect(fields['链接']).toEqual({
      link: 'https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE',
      text: '查看周报',
    });
  });
  it('附件追加保留旧 token，回读忽略名称和对象顺序，重复调用不重写', async () => {
    fields['阿里会议附件'] = [{ file_token: 'oldToken', name: '旧附件.png' }];
    await gateway.appendImages(
      'recExample',
      '阿里会议附件',
      ['oldToken'],
      ['newToken'],
    );
    fields['阿里会议附件'] = [
      { file_token: 'oldToken', name: '不同展示名' },
      { file_token: 'newToken', size: 123 },
    ];
    await gateway.appendImages(
      'recExample',
      '阿里会议附件',
      ['oldToken'],
      ['newToken'],
    );
    expect(
      request.mock.calls.filter((call) => call[0].method === 'PUT'),
    ).toHaveLength(1);
  });
  it('附件发生外部变更或字段类型错误时不覆盖', async () => {
    fields['阿里会议附件'] = [{ file_token: 'otherToken' }];
    await expect(
      gateway.appendImages(
        'recExample',
        '阿里会议附件',
        ['oldToken'],
        ['newToken'],
      ),
    ).rejects.toThrow('已被示例人员004修改');
    await expect(
      gateway.appendImages('recExample', '阿里会议待办', [], ['newToken']),
    ).rejects.toThrow('附件字段');
    expect(request.mock.calls.some((call) => call[0].method === 'PUT')).toBe(
      false,
    );
  });
  it('认证失败与明确拒绝可重试，上传超时保留未知状态', async () => {
    const post = jest.fn();
    const uploader = new WeeklyGateway({
      axiosRef: { post },
    } as unknown as HttpService);
    jest.mocked(getTenantAccessToken).mockRejectedValueOnce(new Error('auth'));
    await expect(
      uploader.uploadImage(Buffer.from('image'), 'qa.png', 'image/png'),
    ).rejects.toMatchObject({ uploadRejected: true });
    expect(post).not.toHaveBeenCalled();
    post.mockRejectedValueOnce({ response: { status: 403 } });
    await expect(
      uploader.uploadImage(Buffer.from('image'), 'qa.png', 'image/png'),
    ).rejects.toMatchObject({ uploadRejected: true });
    const timeout = new Error('timeout');
    post.mockRejectedValueOnce(timeout);
    await expect(
      uploader.uploadImage(Buffer.from('image'), 'qa.png', 'image/png'),
    ).rejects.toBe(timeout);
  });
  it('reads permission before and after grant and does not duplicate a grant', async () => {
    const members: { member_type: string; member_id: string; perm: string }[] =
      [];
    request.mockImplementation(async (options) => {
      if (options.method === 'POST') members.push(options.data);
      return { data: { code: 0, data: { items: members } } };
    });
    await gateway.grantDocument('https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE', [
      'ou_12345678901',
    ]);
    await gateway.grantDocument('https://example.feishu.cn/docx/PUBLIC_EXAMPLE_SOURCE', [
      'ou_12345678901',
    ]);
    expect(
      request.mock.calls.filter((call) => call[0].method === 'POST'),
    ).toHaveLength(1);
    expect(
      request.mock.calls.find((call) => call[0].method === 'POST')?.[0].params
        .need_notification,
    ).toBe(false);
    expect(getTenantAccessToken).toHaveBeenCalled();
  });
});
