import '../../client/src/polyfills';
import '../../client/src/index.css';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useState } from 'react';
import { AccessProvider, useAccess } from '../../client/src/access/AccessProvider';
import { PurchaseApplicationDialog } from '../../client/src/pages/PurchaseInventoryManagement/PurchaseApplicationDialog';
import { createBlankDraft, saveDraft } from '../../client/src/pages/PurchaseInventoryManagement/purchase-application.logic';
import { ChangeSummaryReportDialog } from '../../client/src/pages/MonthlySchedule/ChangeSummaryReportDialog';
import { createChangeSummaryReport } from '../../client/src/api';
import SystemMonthlyReportPage from '../../client/src/pages/SystemMonthlyReport';
import { Toaster } from '../../client/src/components/ui/sonner';

function PurchaseFixture() {
  const access = useAccess();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState('');
  return <><button onClick={() => {
    const draft = createBlankDraft('H楼');
    Object.assign(draft.shared, { applicantRecordId: 'recOther', applicantOpenId: 'ou_other', applicantName: '他人旧草稿', supplier: '隔离验收供应商', procurementForm: '单一采购', singleReason: '隔离验收独家配件', expectedDeliveryDate: '2026-10-20', requirementSummary: '隔离验收采购' });
    Object.assign(draft.items[0], { mode: 'new', sku: 'QA-001', primaryCategory: 'A备品备件类', secondaryCategory: '常备件A2', itemName: '隔离验收备件', specification: '合成规格', brand: '合成品牌', unit: '件', unitPrice: 10 });
    saveDraft(draft, access); setOpen(true); setResult('');
  }}>打开采购申请</button><PurchaseApplicationDialog open={open} onOpenChange={setOpen} onSubmissionStarted={() => setResult('采购同步中')}
    onSubmissionSettled={(_, response) => { setResult(response?.message || '采购未完成'); return true; }} />
    <p role="status">{result}</p></>;
}

function SummaryFixture() {
  const access = useAccess();
  const [open, setOpen] = useState(true);
  const [retry, setRetry] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState('');
  const ownerMutationId = 'change-summary-report-9c109b77-6110-4dcf-9a63-b79aa7d3b49d';
  const original = { id: 'recSummaryFixture', bitableRecordId: 'recSummaryFixture', title: '隔离验收变更', startDate: '2026-10-12', endDate: '2026-10-12', level: '低', progress: '已结束', submitterName: access.displayName || '验收员工甲', workflowStatus: '已审批', hasSummaryReport: false };
  const request = { clientMutationId: ownerMutationId, changeRecordId: original.id, submitterName: original.submitterName, summaryDocuments: [{ name: '隔离验收总结.pdf', type: 'application/pdf', size: 20, objectStorage: { id: 'qa-summary-fixture', filePath: 'qa/summary.pdf', bucketId: 'qa', url: 'https://example.invalid/summary.pdf' } }] };
  return <><button onClick={() => { setRetry(true); setOpen(true); }}>载入代表性总结草稿</button>
    <ChangeSummaryReportDialog open={open} onOpenChange={setOpen} ownerMutationId={ownerMutationId} changes={[original as any]} personOptions={[original.submitterName, ...Array.from({ length: 1200 }, (_, i) => `合成人员${i}`)]} changesStatus="ready" personOptionsStatus="ready" pendingChangeRecordIds={new Set()}
      retryBinding={retry ? { request, original, state: 'failed' } : null} submitting={submitting} serverError={error}
      onAbandonFailed={() => setRetry(false)} onSubmit={value => {
        setSubmitting(true); setError(null);
        void createChangeSummaryReport(value).then(response => { setResult(response.message); setOpen(false); })
          .catch(failure => setError(failure.response?.data?.message || failure.message)).finally(() => setSubmitting(false));
      }} /> <p role="status">{result}</p></>;
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><AccessProvider><nav className="flex flex-wrap gap-3 p-4">
  {['feishu', 'external', 'legacy', 'unmatched', 'guest'].map(actor => <a key={actor} href={`/qa/actor/${actor}?next=${location.pathname}`}>{actor}</a>)}
  <a href="/purchase-fixture">采购</a><a href="/summary-fixture">总结</a><a href="/system-monthly-report">月报</a>
  <a href={`/qa/mode/failure?next=${location.pathname}`}>提交失败</a><a href={`/qa/mode/success?next=${location.pathname}`}>提交成功</a>
  <a href={`/qa/mode/matchfailure?next=${location.pathname}`}>匹配失败</a>
</nav><Routes><Route path="/purchase-fixture" element={<PurchaseFixture />} /><Route path="/summary-fixture" element={<SummaryFixture />} /><Route path="/system-monthly-report" element={<SystemMonthlyReportPage />} /></Routes><Toaster /></AccessProvider></BrowserRouter>);
