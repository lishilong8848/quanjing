import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bookmark, Sparkles } from 'lucide-react';
import { MBTI_TYPE_CODES } from '@shared/organization-person-profile';
import type { MbtiPreviewSelection } from './index';
import MbtiResultReport from './MbtiResultReport';
import { syncMbtiResult } from './mbti-api';
import { ATTACHED_BANK, getAttachedBankDisplayType, scoreAttachedBank, type BankAnswer, type FullAnswer, type ShortAnswer } from '@shared/mbti-attached-bank-model';
import type { EmployeeOnboardingMbtiAssessment } from '@shared/employee-onboarding';

interface Draft {
  answers: BankAnswer[];
  marked: number[];
  current: number;
  complete: boolean;
  clientMutationId: string;
  syncState: 'ready' | 'submitting' | 'success' | 'error';
  syncError: string;
}

const SCALE_LABELS = ['非常不同意', '比较不同意', '稍不同意', '中立', '稍同意', '比较同意', '非常同意'];
const STYLE_REFERENCES: Record<(typeof MBTI_TYPE_CODES)[number], string> = {
  ISTJ: '乔治·华盛顿', ISFJ: '克拉拉·巴顿', INFJ: '纳尔逊·曼德拉', INTJ: '艾萨克·牛顿',
  ISTP: '阿梅莉亚·埃尔哈特', ISFP: '弗里达·卡罗', INFP: 'J.R.R. 托尔金', INTP: '阿尔伯特·爱因斯坦',
  ESTP: '李小龙', ESFP: '玛丽莲·梦露', ENFP: '罗宾·威廉姆斯', ENTP: '马克·吐温',
  ESTJ: '亨利·福特', ESFJ: '弗洛伦斯·南丁格尔', ENFJ: '马丁·路德·金', ENTJ: '玛格丽特·撒切尔',
};
function emptyDraft(count: number): Draft {
  return { answers: Array(count).fill(null), marked: [], current: 0, complete: false, clientMutationId: crypto.randomUUID(), syncState: 'ready', syncError: '' };
}

function validAnswer(value: BankAnswer, version: MbtiPreviewSelection['version']): boolean {
  return value === null || (version === 'short'
    ? Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 7
    : value === 'A' || value === 'B');
}

function loadDraft(key: string, count: number, version: MbtiPreviewSelection['version']): Draft {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null') as Partial<Draft> | null;
    if (saved && Array.isArray(saved.answers) && saved.answers.length === count && saved.answers.every((value) => validAnswer(value, version))) {
      return {
        answers: saved.answers,
        marked: Array.isArray(saved.marked) ? saved.marked.filter((value): value is number => Number.isInteger(value) && value >= 0 && value < count) : [],
        current: Number.isInteger(saved.current) ? Math.max(0, Math.min(count - 1, saved.current!)) : 0,
        complete: saved.complete === true && saved.answers.every((value) => value !== null),
        clientMutationId: typeof saved.clientMutationId === 'string' && /^[0-9a-f-]{36}$/iu.test(saved.clientMutationId) ? saved.clientMutationId : crypto.randomUUID(),
        syncState: saved.syncState === 'success' || saved.syncState === 'error' ? saved.syncState : 'ready',
        syncError: typeof saved.syncError === 'string' ? saved.syncError : '',
      };
    }
  } catch { /* An unreadable preview draft starts over; saving errors are shown below. */ }
  return emptyDraft(count);
}

export default function AttachedBankAssessment({ selection, onExit, onUseResult, canSubmit = true }: { selection: MbtiPreviewSelection; onExit: () => void; onUseResult?: (assessment: EmployeeOnboardingMbtiAssessment) => void; canSubmit?: boolean }) {
  const { version } = selection;
  const questions = version === 'short' ? ATTACHED_BANK.short : ATTACHED_BANK.full;
  const count = questions.length;
  const draftKey = `mbti-assessment-v1:${ATTACHED_BANK.sourceSha256.slice(0, 12)}:${version}:${selection.audience}:${selection.recordId || selection.draftId || selection.name}`;
  const [draft, setDraft] = useState<Draft>(() => loadDraft(draftKey, count, version));
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState('');
  const questionHeadingRef = useRef<HTMLHeadingElement>(null);
  const confirmDialogRef = useRef<HTMLDialogElement>(null);
  const syncInFlightRef = useRef<string | null>(null);

  useEffect(() => {
    if (draft.current > 0) questionHeadingRef.current?.focus();
  }, [draft.current]);

  useEffect(() => {
    try {
      localStorage.setItem(draftKey, JSON.stringify(draft));
      setStorageError('');
    } catch {
      setStorageError('本机保存失败；关闭页面后可能无法续填。请检查浏览器存储空间。');
    }
  }, [draftKey, draft]);

  useEffect(() => {
    if (!canSubmit || !draft.complete || !selection.recordId ||
      !['ready', 'submitting'].includes(draft.syncState) || syncInFlightRef.current === draft.clientMutationId) return;
    const mutationId = draft.clientMutationId;
    syncInFlightRef.current = mutationId;
    setDraft((previous) => ({ ...previous, syncState: 'submitting', syncError: '' }));
    void syncMbtiResult({
      clientMutationId: mutationId,
      audience: selection.audience,
      recordId: selection.recordId,
      name: selection.name,
      ticket: selection.ticket,
      version,
      answers: draft.answers,
      sourceSha256: ATTACHED_BANK.sourceSha256,
    }).then((response) => {
      const expected = getAttachedBankDisplayType(scoreAttachedBank(version, draft.answers));
      if (response.recordId !== selection.recordId || response.type !== expected) throw new Error('同步结果与当前答案不一致，请重试');
      setDraft((previous) => previous.clientMutationId === mutationId ? { ...previous, syncState: 'success', syncError: '' } : previous);
    }).catch((error: unknown) => {
      setDraft((previous) => previous.clientMutationId === mutationId ? { ...previous, syncState: 'error', syncError: error instanceof Error ? error.message : '飞书同步暂时失败，请重试' } : previous);
    }).finally(() => { if (syncInFlightRef.current === mutationId) syncInFlightRef.current = null; });
  }, [canSubmit, draft, selection.audience, selection.recordId, selection.name, selection.ticket, version]);

  const answered = draft.answers.filter((value) => value !== null).length;
  const question = questions[draft.current];
  const result = draft.complete ? scoreAttachedBank(version, draft.answers) : null;
  const title = version === 'short' ? '60 题轻量版' : '93 题完整版';
  const displayName = selection.name;

  function setAnswer(value: ShortAnswer | FullAnswer) {
    setDraft((previous) => {
      const answers = [...previous.answers];
      answers[previous.current] = value;
      return { ...previous, answers, current: Math.min(previous.current + 1, count - 1) };
    });
    setNotice('');
  }

  function submit() {
    if (!canSubmit) { setNotice('当前身份无提交测试权限，答案已保留'); return; }
    const missing = draft.answers.findIndex((value) => value === null);
    if (missing >= 0) {
      setDraft((previous) => ({ ...previous, current: missing }));
      setNotice(`还有 ${count - answered} 题未作答，已跳到第 ${missing + 1} 题。`);
      return;
    }
    if (draft.marked.length) {
      setDraft((previous) => ({ ...previous, current: previous.marked[0] }));
      setNotice(`还有 ${draft.marked.length} 题标记为待确认，请确认后取消标记。`);
      return;
    }
    if (!confirmDialogRef.current?.open) confirmDialogRef.current?.showModal();
  }

  function confirmSubmission() {
    if (!canSubmit) { setNotice('当前身份无提交测试权限，答案已保留'); return; }
    confirmDialogRef.current?.close();
    setDraft((previous) => ({ ...previous, complete: true, syncState: 'ready', syncError: '' }));
    setNotice('');
  }

  function retest() {
    setDraft(emptyDraft(count));
    setNotice('');
  }

  if (result) {
    const type = getAttachedBankDisplayType(result);
    const index = MBTI_TYPE_CODES.indexOf(type);
    return <main className="mbti-page">
      {onUseResult && <div className="mbti-shell mbti-onboarding-return"><button type="button" className="mbti-primary" onClick={() => onUseResult({ participantName: selection.name.trim(), version, answers: [...draft.answers] as EmployeeOnboardingMbtiAssessment['answers'], sourceSha256: ATTACHED_BANK.sourceSha256 })}>使用本次结果，返回入职登记<ArrowRight size={16} /></button></div>}
      <MbtiResultReport sample={Boolean(onUseResult)} prototypeSource="attached" name={displayName} type={type} version={version} preferences={result.preferences}
        portrait={<div className="mbti-character mbti-report-portrait" role="img" aria-label={`${type} 卡通人物`} style={{ backgroundImage: "url('/assets/mbti-character-sprite.png')", backgroundPosition: `${index % 4 * 100 / 3}% ${Math.floor(index / 4) * 100 / 3}%` }} />}
        famousReference={STYLE_REFERENCES[type]} saveState={draft.syncState} saveError={draft.syncError} onRetry={() => setDraft((previous) => ({ ...previous, syncState: 'ready', syncError: '' }))} onBack={() => setDraft((previous) => ({ ...previous, complete: false, clientMutationId: crypto.randomUUID(), syncState: 'ready', syncError: '' }))} onRetest={retest} />
    </main>;
  }

  return <main className="mbti-page"><div className="mbti-shell">
    <div className="mbti-topbar"><button type="button" onClick={onExit}><ArrowLeft size={15} />{onUseResult ? '返回入职登记' : '返回选择版本'}</button><span>本机自动保存进度</span></div>
    <header className="mbti-header mbti-question-header"><div className="mbti-header-icon"><Sparkles size={26} /></div><div><p className="mbti-eyebrow">{title}</p><h1>按第一感觉，选择更像你的答案</h1><p>独立作答，没有好坏或标准答案。</p></div></header>
    {storageError && <div className="bank-error" role="alert">{storageError}</div>}
    <div className="mbti-workspace"><section className="mbti-panel mbti-question-panel" aria-labelledby="bank-question-title">
      <div className="mbti-progress-label"><span>已完成 {answered} / {count}</span><strong>{Math.round(answered / count * 100)}%</strong></div><div className="mbti-progress-track" role="progressbar" aria-label="答题进度" aria-valuenow={answered} aria-valuemin={0} aria-valuemax={count}><span style={{ width: `${answered / count * 100}%` }} /></div>
      <div className="mbti-question-meta"><span>第 {draft.current + 1} 题 / 共 {count} 题</span><span>{draft.answers[draft.current] ? '已作答' : '未作答'}</span></div>
      <h2 id="bank-question-title" className="bank-question" ref={questionHeadingRef} tabIndex={-1}>{question.text}</h2>
      {version === 'short' ? <fieldset className="mbti-scale bank-scale-seven"><legend className="sr-only">选择同意程度</legend>{([1, 2, 3, 4, 5, 6, 7] as const).map((value) => <label key={value} className={draft.answers[draft.current] === value ? 'selected' : ''}><input type="radio" name="bank-answer" value={value} checked={draft.answers[draft.current] === value} onChange={() => setAnswer(value)} /><span>{value}</span><small>{SCALE_LABELS[value - 1]}</small></label>)}</fieldset>
        : <div className="bank-options" role="group" aria-label="选择更符合你的描述">{(['A', 'B'] as const).map((value) => <button type="button" key={value} aria-label={`${value}：${value === 'A' ? (question as typeof ATTACHED_BANK.full[number]).a : (question as typeof ATTACHED_BANK.full[number]).b}`} aria-pressed={draft.answers[draft.current] === value} className={`bank-option${draft.answers[draft.current] === value ? ' selected' : ''}`} onClick={() => setAnswer(value)}><span className="bank-option-letter" aria-hidden="true">{value}</span><span className="bank-option-copy">{value === 'A' ? (question as typeof ATTACHED_BANK.full[number]).a : (question as typeof ATTACHED_BANK.full[number]).b}</span><span className="bank-option-indicator" aria-hidden="true" /></button>)}</div>}
      <button type="button" className={`mbti-mark ${draft.marked.includes(draft.current) ? 'active' : ''}`} aria-pressed={draft.marked.includes(draft.current)} onClick={() => setDraft((previous) => ({ ...previous, marked: previous.marked.includes(previous.current) ? previous.marked.filter((value) => value !== previous.current) : [...previous.marked, previous.current].sort((a, b) => a - b) }))}><Bookmark size={16} />{draft.marked.includes(draft.current) ? '已标记待确认' : '稍后确认这题'}</button>
      {notice && <p className="bank-error" role="alert">{notice}</p>}
      <div className="mbti-actions"><button type="button" className="mbti-secondary" disabled={draft.current === 0} onClick={() => setDraft((previous) => ({ ...previous, current: previous.current - 1 }))}><ArrowLeft size={16} />上一题</button><button type="button" className="mbti-primary" disabled={draft.current === count - 1} onClick={() => setDraft((previous) => ({ ...previous, current: previous.current + 1 }))}>下一题<ArrowRight size={16} /></button></div>
      <button type="button" className="mbti-submit" onClick={submit}>{answered < count ? '检查未完成题目' : draft.marked.length ? '检查待确认题目' : '确认提交'}</button>
    </section><aside className="mbti-panel mbti-index"><div className="mbti-index-title"><h2>题目导航</h2><span>{answered}/{count}</span></div><p>蓝色已答 · 橙色待确认。可随时返回修改。</p><div className="mbti-index-grid">{questions.map((item, index) => <button key={item.id} type="button" aria-label={`第 ${item.id} 题${draft.marked.includes(index) ? '，待确认' : draft.answers[index] ? '，已作答' : '，未作答'}`} className={`${index === draft.current ? 'current ' : ''}${draft.marked.includes(index) ? 'marked ' : draft.answers[index] ? 'answered' : ''}`} onClick={() => { setDraft((previous) => ({ ...previous, current: index })); setNotice(''); }}>{item.id}</button>)}</div><div className="mbti-index-footer"><span>待确认 {draft.marked.length} 题</span><span>未作答 {count - answered} 题</span></div></aside></div>
    <dialog ref={confirmDialogRef} className="bank-submit-dialog" aria-labelledby="bank-submit-title" aria-describedby="bank-submit-summary">
      <h2 id="bank-submit-title">确认提交测试？</h2>
      <p id="bank-submit-summary">已完成全部 {count} 题。提交后即可查看你的 16 型人格偏好与分析。</p>
      <div><button type="button" className="mbti-secondary" onClick={() => confirmDialogRef.current?.close()}>返回检查</button><button type="button" className="mbti-primary" onClick={confirmSubmission}>提交并查看结果<ArrowRight size={16} /></button></div>
    </dialog>
  </div></main>;
}
