import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, ClipboardList, Search, Sparkles, UserRound } from 'lucide-react';
import type { MbtiAssessmentVersion } from './types';
import './styles.css';
import type { SelfServiceApplicant } from '@shared/self-service-applicant';

type Audience = 'active' | 'new';
export interface MbtiActivePerson {
  recordId: string;
  name: string;
  position: string;
  buildings: string[];
}
type SearchActivePeople = (query: string, signal?: AbortSignal) => Promise<{ people: MbtiActivePerson[]; stale: boolean }>;
export interface MbtiPreviewSelection {
  audience: Audience;
  name: string;
  recordId?: string;
  draftId?: string;
  ticket?: string;
  version: MbtiAssessmentVersion;
}

export default function MbtiAssessmentPage({ onPrototypeStart, searchActivePeople, onboardingPerson, applicant, authenticatedPerson, identityLoading = false, identityError, onIdentityRetry }: { onPrototypeStart?: (selection: MbtiPreviewSelection) => void; searchActivePeople?: SearchActivePeople; onboardingPerson?: { recordId: string; name: string; ticket: string }; applicant?: SelfServiceApplicant; authenticatedPerson?: MbtiActivePerson; identityLoading?: boolean; identityError?: string; onIdentityRetry?: () => void }) {
  const onboardingEntry = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('entry') === 'onboarding';
  const [version, setVersion] = useState<MbtiAssessmentVersion>('short');
  const [query, setQuery] = useState('');
  const [selectedPerson, setSelectedPerson] = useState<MbtiActivePerson | null>(null);
  const automatic = applicant && applicant.mode !== 'manual';
  const activePerson = applicant?.mode === 'automatic' ? authenticatedPerson : selectedPerson;
  const [people, setPeople] = useState<MbtiActivePerson[]>([]);
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [stale, setStale] = useState(false);
  const [linkMessage, setLinkMessage] = useState('');
  const [draftId] = useState(() => {
    if (!onboardingEntry || typeof window === 'undefined') return undefined;
    const params = new URLSearchParams(window.location.search);
    const existing = params.get('draftId');
    if (existing && /^[0-9a-f-]{36}$/iu.test(existing)) return existing;
    const created = window.crypto.randomUUID();
    params.set('draftId', created);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
    return created;
  });

  useEffect(() => {
    if (onboardingEntry || automatic || selectedPerson || query.trim().length < 2) {
      setPeople([]);
      setSearchState('idle');
      return;
    }
    if (!searchActivePeople) {
      setSearchState('error');
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setSearchState('loading');
      void searchActivePeople(query.trim(), controller.signal)
        .then((response) => {
          if (controller.signal.aborted) return;
          setPeople(response.people);
          setStale(response.stale);
          setSearchState('ready');
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearchState('error');
        });
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [onboardingEntry, automatic, query, searchActivePeople, selectedPerson]);

  async function copyTestLink() {
    const link = `${window.location.origin}${window.location.pathname}`;
    try {
      await window.navigator.clipboard.writeText(link);
      setLinkMessage('链接已复制');
    } catch {
      setLinkMessage(`请复制地址：${link}`);
    }
  }

  const canStart = !identityLoading && !identityError && (onboardingEntry ? Boolean(onboardingPerson) : applicant?.mode === 'login' ? true : applicant?.mode === 'error' ? false : Boolean(activePerson));
  return <main className="mbti-page">
    <div className="mbti-shell">
      <div className="mbti-topbar"><a href="/nantong-base"><ArrowLeft size={15} />返回平台</a>{!onboardingEntry && <div><button type="button" onClick={() => void copyTestLink()}>复制独立链接</button>{linkMessage && <span role="status">{linkMessage}</span>}</div>}</div>
      <header className="mbti-header mbti-landing-header">
        <div className="mbti-header-icon"><Sparkles size={26} /></div>
        <div><p className="mbti-eyebrow">人员保障 / 员工成长</p><h1>{onboardingEntry ? '新员工人格偏好测试' : '发现你的 16 型人格偏好'}</h1><p>选择适合自己的版本，按第一感觉作答。</p></div>
      </header>

      <section className="mbti-panel mbti-start" aria-labelledby="mbti-start-title">
        {onboardingEntry ? <div className="mbti-onboarding-intro"><UserRound size={20} /><div><h2 id="mbti-start-title">入职测试</h2><p>从新员工登记进入，无需再填写姓名。</p></div></div> : <>
          <div className="mbti-section-heading"><UserRound size={20} /><h2 id="mbti-start-title">您的姓名</h2></div>
          <div className="mbti-name-field"><label className="mbti-sr-only" htmlFor="mbti-name">您的姓名</label><div className="mbti-search-field"><Search size={18} aria-hidden="true" /><input id="mbti-name" value={applicant?.mode === 'automatic' ? applicant.name : automatic ? '' : query} readOnly={Boolean(automatic)} aria-readonly={Boolean(automatic)} onChange={(event) => { setQuery(event.target.value); setSelectedPerson(null); setPeople([]); setSearchState('idle'); }} placeholder={automatic ? '登录后自动匹配姓名' : '请输入您的姓名'} autoComplete="name" maxLength={40} /></div>
            {automatic ? <div className="mbti-search-results" aria-live="polite">
              {identityLoading && <p role="status">正在匹配人员资料…</p>}
              {(identityError || applicant?.mode === 'error') && <p role="alert">{identityError || (applicant?.mode === 'error' ? applicant.message : '')}</p>}
              {identityError && <button type="button" onClick={onIdentityRetry}>重新匹配</button>}
              {activePerson && <p>{[activePerson.position, ...activePerson.buildings.map(building => `${building}楼`)].filter(Boolean).join(' · ')}</p>}
            </div> : selectedPerson ? <div className="mbti-person-selected" role="status"><strong>已选择：{selectedPerson.name}</strong><span>{[selectedPerson.position, ...selectedPerson.buildings.map((building) => `${building}楼`)].filter(Boolean).join(' · ')}</span><button type="button" onClick={() => { setSelectedPerson(null); setQuery(''); }}>更换</button></div> : <div className="mbti-search-results" aria-live="polite">
              {searchState === 'loading' && <p>正在匹配姓名…</p>}
              {searchState === 'error' && <p role="alert">姓名暂时无法匹配，请稍后重试。</p>}
              {searchState === 'ready' && people.length === 0 && <p>未找到您的姓名，请核对输入。</p>}
              {searchState === 'ready' && people.length > 0 && <div className="mbti-person-options" aria-label="匹配的在职员工">{people.map((person) => <button type="button" key={person.recordId} aria-label={`选择 ${person.name}，${person.position || '在职员工'}，${person.buildings.join('、') || '未分配楼栋'}`} onClick={() => { setSelectedPerson(person); setQuery(person.name); }}><strong>{person.name}</strong><span>{[person.position, ...person.buildings.map((building) => `${building}楼`)].filter(Boolean).join(' · ') || '在职员工'}</span></button>)}</div>}
              {searchState === 'ready' && stale && <p>名单可能正在更新，请核对所选员工信息。</p>}
            </div>}
          </div>
        </>}
        <div className="mbti-section-heading"><ClipboardList size={20} /><h2>选择测试版本</h2></div>
        <div className="mbti-version-grid" role="group" aria-label="测试版本">
          <button type="button" className={`mbti-version ${version === 'short' ? 'selected' : ''}`} aria-pressed={version === 'short'} onClick={() => setVersion('short')}><span>轻量版</span><strong>60 题</strong><small>约 10 分钟 · 7 级选择</small></button>
          <button type="button" className={`mbti-version ${version === 'full' ? 'selected' : ''}`} aria-pressed={version === 'full'} onClick={() => setVersion('full')}><span>完整版</span><strong>93 题</strong><small>约 15 分钟 · A/B 选择</small></button>
        </div>
        <div className="mbti-start-footer"><button className="mbti-primary" type="button" disabled={!onPrototypeStart || !canStart} onClick={() => onPrototypeStart?.({ audience: onboardingEntry ? 'new' : 'active', name: onboardingPerson?.name || activePerson?.name || '', recordId: onboardingPerson?.recordId || activePerson?.recordId, ticket: onboardingPerson?.ticket, draftId, version })}>{onPrototypeStart ? applicant?.mode === 'login' ? '登录后开始测试' : '开始测试' : '正式测试暂未开放'} <ArrowRight size={17} /></button>{!automatic && !canStart && query.trim().length >= 2 && <span>请在匹配结果中选择您的姓名。</span>}</div>
      </section>
    </div>
  </main>;
}
