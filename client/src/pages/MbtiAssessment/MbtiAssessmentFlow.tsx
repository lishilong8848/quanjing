import { useEffect, useMemo, useState } from 'react';
import MbtiAssessmentPage, { type MbtiActivePerson, type MbtiPreviewSelection } from './index';
import AttachedBankAssessment from './AttachedBankAssessment';
import { getMbtiCurrentPerson, getMbtiOnboardingContext, searchMbtiActivePeople } from './mbti-api';
import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import { hasAuthenticatedAccessIdentity } from '@/access/access-policy';
import { resolveSelfServiceApplicant } from '@shared/self-service-applicant';

const TICKET_STORAGE_KEY = 'mbti-onboarding-ticket';

export default function MbtiAssessmentFlow() {
  const access = useAccess();
  const applicant = useMemo(() => resolveSelfServiceApplicant(access, hasAuthenticatedAccessIdentity(access), '开始 MBTI 测试'),
    [access.accountId, access.displayName, access.expiresAt, access.principalFingerprint, access.role]);
  const onboardingEntry = new URLSearchParams(window.location.search).get('entry') === 'onboarding';
  const canSubmit = onboardingEntry || canUsePageAction(access, 'personality', 'create', true);
  const [context, setContext] = useState<{ recordId: string; name: string; ticket: string } | null>(null);
  const [contextError, setContextError] = useState('');
  const [selection, setSelection] = useState<MbtiPreviewSelection | null>(null);
  const identityKey = onboardingEntry ? 'onboarding' : access.principalFingerprint;
  const [selectionIdentity, setSelectionIdentity] = useState(identityKey);
  const [personState, setPersonState] = useState<{ identity: string | null; person?: MbtiActivePerson; error?: string } | null>(null);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (onboardingEntry || access.isLoading || applicant.mode !== 'automatic') return;
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setPersonState(null);
    void getMbtiCurrentPerson(controller.signal).then(person => {
      if (!active || controller.signal.aborted) return;
      if (person.name !== applicant.name) throw new Error('登录姓名与人员资料不一致，请重新登录后重试');
      setPersonState({ identity: access.principalFingerprint, person });
    }).catch(error => {
      if (!active) return;
      setPersonState({ identity: access.principalFingerprint, error: controller.signal.aborted ? '人员匹配超时，请重试' : error instanceof Error ? error.message : '人员资料暂时无法匹配，请重试' });
    }).finally(() => window.clearTimeout(timeout));
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [onboardingEntry, access.isLoading, access.principalFingerprint, applicant, retry]);

  useEffect(() => {
    if (!onboardingEntry) return;
    const params = new URLSearchParams(window.location.search);
    const ticket = params.get('ticket') || sessionStorage.getItem(TICKET_STORAGE_KEY) || '';
    if (!ticket) { setContextError('测试链接无效，请从新员工登记重新进入'); return; }
    if (params.has('ticket')) {
      sessionStorage.setItem(TICKET_STORAGE_KEY, ticket);
      params.delete('ticket');
      window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
    }
    void getMbtiOnboardingContext(ticket)
      .then((value) => setContext({ ...value, ticket }))
      .catch((error: unknown) => setContextError(error instanceof Error ? error.message : '测试链接暂时无法打开'));
  }, [onboardingEntry]);

  if (onboardingEntry && !context) return <main className="mbti-page"><div className="mbti-shell"><div className="mbti-panel mbti-start" role={contextError ? 'alert' : 'status'}>{contextError || '正在打开入职测试…'}</div></div></main>;
  if (selection && selectionIdentity === identityKey) return <AttachedBankAssessment key={identityKey || 'manual'} selection={selection} canSubmit={canSubmit} onExit={() => setSelection(null)} />;
  const currentPersonState = personState?.identity === access.principalFingerprint ? personState : null;
  return <MbtiAssessmentPage onboardingPerson={context || undefined} applicant={onboardingEntry ? undefined : applicant}
    authenticatedPerson={currentPersonState?.person} identityLoading={access.isLoading || (!onboardingEntry && applicant.mode === 'automatic' && !currentPersonState)}
    identityError={currentPersonState?.error || (!canSubmit ? '当前身份无提交测试权限' : undefined)} onIdentityRetry={() => setRetry(value => value + 1)}
    onPrototypeStart={value => {
      if (!canSubmit) return;
      if (!onboardingEntry && applicant.mode === 'login') { access.requestLogin(applicant.message, '/mbti-assessment'); return; }
      if (!onboardingEntry && applicant.mode === 'error') return;
      setSelectionIdentity(identityKey); setSelection(value);
    }} searchActivePeople={searchMbtiActivePeople} />;
}
