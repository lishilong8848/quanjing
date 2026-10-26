import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Check, CircleAlert, RefreshCw, Sparkles } from 'lucide-react';
import type { MbtiAssessmentVersion } from './types';
import { getMbtiAxisInsight, MBTI_REPORT_PROFILES, type MbtiAxis } from '@shared/mbti-report';
import type { MbtiTypeCode } from '@shared/organization-person-profile';

const AXES: readonly MbtiAxis[] = ['EI', 'SN', 'TF', 'JP'];
const TYPE_NAMES: Record<MbtiTypeCode, string> = {
  ISTJ: '物流师', ISFJ: '守护者', INFJ: '提倡者', INTJ: '架构师',
  ISTP: '鉴赏家', ISFP: '冒险家', INFP: '调停者', INTP: '逻辑学家',
  ESTP: '企业家', ESFP: '表演者', ENFP: '活动家', ENTP: '辩论家',
  ESTJ: '管理者', ESFJ: '执政官', ENFJ: '主人公', ENTJ: '指挥官',
};
const GROUP_NAMES = { analyst: '分析家', diplomat: '外交家', sentinel: '守卫者', explorer: '探索者' } as const;

export interface MbtiResultReportProps {
  sample?: boolean;
  prototypeSource?: 'oejts' | 'attached';
  name: string;
  type: MbtiTypeCode;
  version: MbtiAssessmentVersion;
  preferences: Record<MbtiAxis, number>;
  portrait: ReactNode;
  famousReference: string;
  saveState: 'ready' | 'submitting' | 'success' | 'error';
  saveError: string;
  onRetry: () => void;
  onBack: () => void;
  onRetest: () => void;
}

function typeGroup(type: MbtiTypeCode): 'analyst' | 'diplomat' | 'sentinel' | 'explorer' {
  if (type.includes('N')) return type.includes('T') ? 'analyst' : 'diplomat';
  return type.includes('J') ? 'sentinel' : 'explorer';
}

export default function MbtiResultReport({
  sample = false, prototypeSource, name, type, preferences, portrait, famousReference, saveState, saveError,
  onRetry, onBack, onRetest,
}: MbtiResultReportProps) {
  const report = MBTI_REPORT_PROFILES[type];
  return <article className="mbti-report" aria-label={`${name} 的人格偏好结果`}>
    <section className="mbti-report-hero" data-group={typeGroup(type)}>
      <div className="mbti-report-hero-copy">
        <div className="mbti-report-type"><span>{type}</span><strong>{TYPE_NAMES[type]}</strong><em>{GROUP_NAMES[typeGroup(type)]}</em></div>
        <h2>{report.headline}</h2>
        <p>{report.portrait}</p>
        {!sample && <div className={`mbti-sync-state ${saveState}`} role="status">
          {saveState === 'success' ? <Check size={17} /> : saveState === 'error' ? <CircleAlert size={17} /> : <RefreshCw size={17} className="mbti-spin" />}
          {saveState === 'success' ? '结果已同步至员工信息池' : saveState === 'error' ? '结果尚未同步，请重试' : '结果已生成，正在同步…'}
        </div>}
      </div>
      {portrait}
    </section>

    {!sample && saveState === 'error' && <div className="mbti-report-error" role="alert">
      <strong>同步未完成</strong><span>{saveError || '请稍后重试，当前答案仍保存在本机。'}</span>
      <div><button type="button" className="mbti-primary" onClick={onRetry}>重试同步 <ArrowRight size={16} /></button><button type="button" className="mbti-secondary" onClick={onBack}><ArrowLeft size={16} />返回检查答案</button></div>
    </div>}

    <section className="mbti-report-section">
      <div className="mbti-report-section-title"><span>01</span><div><h3>你的四个偏好维度</h3><p>看的是这次作答更常用的方式，不是能力强弱。</p></div></div>
      <div className="mbti-report-axis-grid">{AXES.map((axis) => {
        const leftPercent = preferences[axis];
        const insight = getMbtiAxisInsight(axis, leftPercent);
        return <div className="mbti-report-axis" key={axis}>
          <div className="mbti-report-axis-heading"><strong>{insight.title}</strong>{insight.close && <span>两端接近</span>}</div>
          <div className="mbti-report-axis-labels"><span>{insight.left.label} <b>{leftPercent}%</b></span><span>{insight.right.label} <b>{100 - leftPercent}%</b></span></div>
          <div className="mbti-report-axis-track" aria-label={`${insight.left.label} ${leftPercent}%，${insight.right.label} ${100 - leftPercent}%`} role="img"><span style={{ width: `${leftPercent}%` }} /></div>
          <p>{insight.summary}</p>
        </div>;
      })}</div>
      <p className="mbti-report-footnote">{prototypeSource === 'oejts' ? '百分比由 OEJTS 原始轴分数线性换算，仅用于展示，不代表答题比例或结果确定程度。恰好 50% 时依原计分规则归类，但本次作答无法区分两端偏好。' : prototypeSource === 'attached' ? '这是本次作答更接近的偏好类型；两端接近的维度可以结合不同情境继续观察。' : '百分比是本次题目在两个方向上的作答分布，不代表人格的确定程度。接近 50% 的维度尤其值得结合不同情境观察。'}</p>
    </section>

    <section className="mbti-report-section">
      <div className="mbti-report-section-title"><span>02</span><div><h3>你的优势与可能的盲点</h3><p>优势值得用好，盲点可以通过合适的方法补上。</p></div></div>
      <div className="mbti-report-two-columns">
        <div className="mbti-report-list-card strengths"><h4>你可能自带的优势</h4><ul>{report.strengths.map((item) => <li key={item}><Check size={17} />{item}</li>)}</ul></div>
        <div className="mbti-report-list-card blind-spots"><h4>值得留意的时刻</h4><ul>{report.blindSpots.map((item) => <li key={item}><CircleAlert size={17} />{item}</li>)}</ul></div>
      </div>
    </section>

    <section className="mbti-report-section">
      <div className="mbti-report-section-title"><span>03</span><div><h3>放到日常工作里，会怎样表现？</h3><p>把偏好变成可观察、可调整的协作方式。</p></div></div>
      <div className="mbti-report-scenes">
        <div><span>推进任务</span><h4>找到适合自己的节奏</h4><p>{report.workStyle}</p></div>
        <div><span>与人合作</span><h4>让别人跟上你的思路</h4><p>{report.collaboration}</p></div>
        <div><span>压力来时</span><h4>留意自己的惯性反应</h4><p>{report.underPressure}</p></div>
      </div>
    </section>

    <section className="mbti-report-section mbti-report-action-section">
      <div className="mbti-report-section-title"><span>04</span><div><h3>下周可以试试这三件小事</h3><p>选择其中一件开始，观察它是否真的帮到你。</p></div></div>
      <ol className="mbti-report-actions">{report.nextSteps.map((item, index) => <li key={item}><span>{String(index + 1).padStart(2, '0')}</span>{item}</li>)}</ol>
    </section>

    {famousReference && <aside className="mbti-report-famous"><Sparkles size={18} /><div><strong>人物风格联想：{famousReference}</strong></div></aside>}
    <footer className="mbti-report-footer">{prototypeSource !== 'attached' && (!sample || prototypeSource) && <p>{prototypeSource === 'oejts' ? <>按 <a href="https://openpsychometrics.org/tests/OJTS/development/OEJTS1.2.pdf" target="_blank" rel="noreferrer">OEJTS 1.2</a> 原计分表计算；中文为未验证试译，类型解读为页面样板文案。OEJTS 非官方 MBTI，作者未保证准确性；题目采用 CC BY-NC-SA 4.0 许可。本机结果不保存到员工档案，不用于招聘、绩效或岗位决策。</> : '人格偏好会随情境和时间变化。结果适合用来认识自己、开启沟通，不用于招聘、绩效或岗位决策。'}</p>}<div className="mbti-result-actions">{prototypeSource && <button type="button" className="mbti-secondary" onClick={onBack}><ArrowLeft size={16} />返回修改答案</button>}<button type="button" className="mbti-secondary" onClick={onRetest}><RefreshCw size={16} />重新测试</button></div></footer>
  </article>;
}
