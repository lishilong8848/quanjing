import {
  ADDITIONAL_MEETING_SOURCES,
  mapAdditionalMeeting,
} from './meeting.sources.mapper';
import { summarizeMeeting } from './meeting.mapper';

describe('真实会议字段适配', () => {
  it('人员只带稳定ID和姓名，超链接取link而非显示文字，保留资料类型', () => {
    const meeting = mapAdditionalMeeting(
      {
        record_id: 'recA',
        fields: {
          分享主题: 'BA系统测试',
          开始时间: 1767830400000,
          分享类型: '技术经验分享',
          分享人: [
            {
              id: 'ou_test',
              name: '分享人甲',
              email: 'private@example.com',
              avatar_url: 'private',
            },
          ],
          '楼栋&专业（多选）': ['E楼', '弱电'],
          SourceID: 'private-internal-id',
          '演示文档/PPT（链接）': {
            text: '课件',
            link: 'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
          },
          '会议回放&妙记链接': {
            text: '回放',
            link: 'https://example.feishu.cn/minutes/PUBLIC_EXAMPLE_SOURCE',
          },
        },
      },
      ADDITIONAL_MEETING_SOURCES[0],
    );
    expect(meeting.id).toBe('training:recA');
    expect(meeting.presenters).toEqual([{ id: 'ou_test', name: '分享人甲' }]);
    expect(meeting.documentUrl).toBe(
      'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE',
    );
    expect(meeting.resources?.map((r) => r.kind)).toEqual(['slides', 'replay']);
    expect(JSON.stringify(meeting)).not.toMatch(/private/);
    expect(summarizeMeeting(meeting).searchText).toContain('分享人甲');
    expect(summarizeMeeting(meeting).searchText).toContain('弱电');
  });
  it('同ID跨表不碰撞，属地和运维部不误标客户，专业会议保留性质', () => {
    const map = (fields: Record<string, unknown>) =>
      mapAdditionalMeeting(
        { record_id: 'recA', fields },
        ADDITIONAL_MEETING_SOURCES[1],
      );
    expect(map({ 会议属性: '属地', 类型: '南通周会' })).toMatchObject({
      id: 'ali-meeting:recA',
      scope: '机房',
      hasActions: false,
    });
    expect(map({ 会议属性: '运维部', 类型: '技术会议' })).toMatchObject({
      scope: '运维部',
      nature: '专业类',
    });
    expect(map({ 类型: '培训会议' }).nature).toBe('培训类');
    expect(map({ 会议属性: '未知部门', 类型: '其他' })).toMatchObject({
      scope: '未分类',
      nature: '未分类',
    });
  });
  it('乱码不伪装正常摘要，异常时间不生成错误时长，附件不编造下载地址', () => {
    const meeting = mapAdditionalMeeting(
      {
        record_id: 'recB',
        fields: {
          开始时间: 1767830400000,
          结束时间: 1767820400000,
          会议重点: '????? Outlook ?????',
          会议总结: [
            {
              name: '会议截图.png',
              file_token: 'private-token',
              tmp_url: 'private-url',
            },
          ],
        },
      },
      ADDITIONAL_MEETING_SOURCES[1],
    );
    expect(meeting.warnings).toHaveLength(2);
    expect(meeting.sections).toEqual([]);
    expect(meeting.attachmentNames).toEqual(['会议截图.png']);
    expect(JSON.stringify(meeting)).not.toMatch(/private/);
  });
  it('拒绝脚本、仿冒域名和带凭据链接', () => {
    for (const link of [
      'javascript:alert(1)',
      'https://vnet.feishu.cn.evil.test/docx/A',
      'https://user:user-3d40ddff@example.com/docx/A',
    ]) {
      const meeting = mapAdditionalMeeting(
        { record_id: 'recA', fields: { 会议纪要: { text: '纪要', link } } },
        ADDITIONAL_MEETING_SOURCES[1],
      );
      expect(meeting.resources).toEqual([]);
      expect(meeting.documentUrl).toBeNull();
    }
  });
});
