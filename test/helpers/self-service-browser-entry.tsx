import '../../client/src/polyfills';
import '../../client/src/index.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AccessProvider, useAccess } from '../../client/src/access/AccessProvider';
import { GlobalNavigation } from '../../client/src/components/GlobalNavigation';
import MonthlySchedule from '../../client/src/pages/MonthlySchedule';
import ChangeRequestApplyPage from '../../client/src/pages/ChangeRequestApply';
import MbtiAssessmentFlow from '../../client/src/pages/MbtiAssessment/MbtiAssessmentFlow';
import { Toaster } from '../../client/src/components/ui/sonner';
import { useState } from 'react';
import { ChangeRequestDialog } from '../../client/src/pages/MonthlySchedule/ChangeRequestDialog';
import { createChangeRequest } from '../../client/src/api';
import type { ChangeRequestDraft } from '../../shared/change-request';
const ownerMutationId = 'change-request-9c109b77-6110-4dcf-9a63-b79aa7d3b49d';
const stagedDocument = { name: '隔离验收.pdf', type: 'application/pdf', size: 20, objectStorage: { id: 'qa-synthetic', filePath: 'qa/synthetic.pdf', bucketId: 'qa', url: 'https://example.invalid/qa.pdf' } };
const initialDraft: ChangeRequestDraft = { submitterName: '', nature: '标准变更', changeType: '计划性变更', workType: '维护', buildings: ['A楼'], discipline: '电气', level: '低', summary: '隔离验收：本人申请', riskSummary: '隔离验收：风险可控', plannedStartAt: '2026-10-12T10:00', plannedEndAt: '2026-10-12T11:00', meetingStartAt: '', meetingEndAt: '' };
function ChangeFixture() {
  const [open, setOpen] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState('');
  return <><ChangeRequestDialog open={open} onOpenChange={setOpen} standalone ownerMutationId={ownerMutationId} initialDraft={initialDraft} initialStagedDocuments={[stagedDocument]} submitting={submitting} serverError={error} onSubmit={(draft, documents) => {
    setSubmitting(true); setError(null);
    void createChangeRequest({ ...draft, clientMutationId: ownerMutationId, stagedDocuments: documents } as Parameters<typeof createChangeRequest>[0])
      .then(result => { setSuccess(result.message); setOpen(false); })
      .catch(error => setError(error.response?.data?.message || error.message))
      .finally(() => setSubmitting(false));
  }} />{success && <p role="status">{success}</p>}</>;
}
function Controls() {
  const { logout } = useAccess();
  return <button className="fixed bottom-2 right-2 z-20" onClick={() => void logout()}>切换游客</button>;
}
createRoot(document.getElementById('root')!).render(<BrowserRouter><AccessProvider><GlobalNavigation /><div className="pt-16"><Routes>
  <Route path="/monthly-schedule" element={<MonthlySchedule />} />
  <Route path="/change-request/apply" element={<ChangeRequestApplyPage />} />
  <Route path="/change-fixture" element={<ChangeFixture />} />
  <Route path="/mbti-assessment" element={<MbtiAssessmentFlow />} />
</Routes></div><Controls /><Toaster /></AccessProvider></BrowserRouter>);
