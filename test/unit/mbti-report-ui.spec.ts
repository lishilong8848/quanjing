import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import MbtiResultReport, { type MbtiResultReportProps } from '../../client/src/pages/MbtiAssessment/MbtiResultReport';
import type { MbtiTypeCode } from '../../shared/organization-person-profile';

const baseProps: MbtiResultReportProps = {
  name: '样板员工',
  type: 'ESTJ',
  version: 'short',
  preferences: { EI: 60, SN: 50, TF: 70, JP: 65 },
  portrait: createElement('div'),
  famousReference: '示例人物',
  saveState: 'submitting',
  saveError: '',
  onRetry: () => undefined,
  onBack: () => undefined,
  onRetest: () => undefined,
};

describe('MBTI result report', () => {
  it('shows the tested employee and the full analysis while synchronization is pending', () => {
    const html = renderToStaticMarkup(createElement(MbtiResultReport, baseProps));
    expect(html).toContain('aria-label="样板员工 的人格偏好结果"');
    expect(html).toContain('结果已生成，正在同步');
    expect(html).toContain('你的优势与可能的盲点');
    expect(html).toContain('下周可以试试这三件小事');
    expect(html).toContain('两端接近');
    expect(html).not.toContain('结果已同步至员工信息池');
  });

  it('offers retry and answer review on synchronization failure', () => {
    const html = renderToStaticMarkup(createElement(MbtiResultReport, {
      ...baseProps,
      saveState: 'error',
      saveError: '飞书暂时不可用',
    }));
    expect(html).toContain('结果尚未同步，请重试');
    expect(html).toContain('飞书暂时不可用');
    expect(html).toContain('重试同步');
    expect(html).toContain('返回检查答案');
    expect(html).not.toContain('结果已同步至员工信息池');
  });

  it('confirms synchronization and keeps retest available', () => {
    const html = renderToStaticMarkup(createElement(MbtiResultReport, { ...baseProps, saveState: 'success' }));
    expect(html).toContain('结果已同步至员工信息池');
    expect(html).toContain('重新测试');
  });

  it('shows a sample result without preview notices or employee sync claims', () => {
    const html = renderToStaticMarkup(createElement(MbtiResultReport, { ...baseProps, sample: true, saveState: 'success' }));
    expect(html).toContain('管理者');
    expect(html).toContain('守卫者');
    expect(html).not.toContain('页面样板');
    expect(html).not.toContain('虚构结果');
    expect(html).not.toContain('结果已同步至员工信息池');
  });

  it('keeps the attached bank result focused on its type and analysis', () => {
    const html = renderToStaticMarkup(createElement(MbtiResultReport, { ...baseProps, sample: true, prototypeSource: 'attached' }));
    expect(html).toContain('<span>ESTJ</span><strong>管理者</strong><em>守卫者</em>');
    expect(html).not.toContain('用户提供题库样板');
    expect(html).not.toContain('虚构结果的页面样板');
    expect(html).toContain('重新测试');
  });

  it.each<[MbtiTypeCode, string, string]>([
    ['ISTJ', '物流师', '守卫者'], ['ISFJ', '守护者', '守卫者'], ['INFJ', '提倡者', '外交家'], ['INTJ', '架构师', '分析家'],
    ['ISTP', '鉴赏家', '探索者'], ['ISFP', '冒险家', '探索者'], ['INFP', '调停者', '外交家'], ['INTP', '逻辑学家', '分析家'],
    ['ESTP', '企业家', '探索者'], ['ESFP', '表演者', '探索者'], ['ENFP', '活动家', '外交家'], ['ENTP', '辩论家', '分析家'],
    ['ESTJ', '管理者', '守卫者'], ['ESFJ', '执政官', '守卫者'], ['ENFJ', '主人公', '外交家'], ['ENTJ', '指挥官', '分析家'],
  ])('shows %s as %s in %s', (type, title, group) => {
    const html = renderToStaticMarkup(createElement(MbtiResultReport, { ...baseProps, type, sample: true }));
    expect(html).toContain(`<strong>${title}</strong><em>${group}</em>`);
  });
});
