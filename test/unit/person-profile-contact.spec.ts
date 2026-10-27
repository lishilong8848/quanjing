import {
  buildFeishuChatAppLink,
  extractFeishuOpenId,
} from '../../server/modules/bitable-sync/person-profile-contact';

describe('person profile contact routing', () => {
  it('extracts only a valid Feishu open_id from nested personnel fields', () => {
    expect(
      extractFeishuOpenId({
        users: [{ id: 'ou_contact_User_123' }],
      }),
    ).toBe('ou_contact_User_123');
    expect(extractFeishuOpenId({ id: 'user_123' })).toBeNull();
    expect(extractFeishuOpenId({ open_id: 'javascript:alert(1)' })).toBeNull();
  });

  it('builds only the fixed-host official Feishu chat AppLink', () => {
    expect(buildFeishuChatAppLink('ou_contact_User_123')).toBe(
      'https://applink.feishu.cn/client/chat/open?openId=ou_contact_User_123',
    );
    expect(buildFeishuChatAppLink('https://evil.example')).toBeNull();
  });
});
