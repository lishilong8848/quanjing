import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MbtiAssessmentPage from '../../client/src/pages/MbtiAssessment';

jest.mock('../../client/src/pages/MbtiAssessment/styles.css', () => ({}));

describe('MBTI assessment entry sample', () => {
  it('searches active employees and shows both versions on the landing page', () => {
    const html = renderToStaticMarkup(createElement(MbtiAssessmentPage));
    expect(html).toContain('您的姓名');
    expect(html).toContain('请输入您的姓名');
    expect(html).not.toContain('查找在职员工');
    expect(html).not.toContain('新员工</strong>');
    expect(html).toContain('轻量版');
    expect(html).toContain('完整版');
    expect(html).not.toContain('文档参考计分键');
    expect(html).not.toContain('认识 16 种偏好');
    expect(html).toContain('正式测试暂未开放');
  });

  it('登录姓名只读，匹配记录后直接开始，不显示更换人员', () => {
    const html = renderToStaticMarkup(createElement(MbtiAssessmentPage, {
      applicant: { mode: 'automatic', name: '验收员工甲' },
      authenticatedPerson: { recordId: 'recFixture', name: '验收员工甲', position: '值班员', buildings: ['A'] },
      onPrototypeStart: () => undefined,
    }));
    expect(html).toContain('value="验收员工甲"');
    expect(html).toContain('readOnly=""');
    expect(html).toContain('开始测试');
    expect(html).not.toContain('更换');
    expect(html).not.toContain('匹配的在职员工');
    expect(html).not.toContain('disabled=""');
  });

  it('身份未匹配时显示错误并禁止开始，游客提供登录入口', () => {
    const html = renderToStaticMarkup(createElement(MbtiAssessmentPage, {
      applicant: { mode: 'automatic', name: '验收员工甲' }, identityError: '人员资料未匹配', onPrototypeStart: () => undefined,
    }));
    expect(html).toContain('人员资料未匹配');
    expect(html).toContain('重新匹配');
    expect(html).toContain('disabled=""');
    const guest = renderToStaticMarkup(createElement(MbtiAssessmentPage, { applicant: { mode: 'login', message: '请登录' }, onPrototypeStart: () => undefined }));
    expect(guest).toContain('登录后开始测试');
    expect(guest).toContain('readOnly=""');
  });
});
