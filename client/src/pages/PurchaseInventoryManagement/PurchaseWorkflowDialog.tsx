import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Circle,
  FileText,
  Loader2,
  PackageCheck,
  Play,
  ReceiptText,
  Search,
  ShoppingCart,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import {
  approvePurchaseWorkflow,
  getPurchaseWorkflowDetail,
  getPurchaseWorkflowReceiptTaskStatus,
  searchPurchaseApplicationApplicants,
  startPurchaseWorkflow,
  submitPurchaseWorkflowOrder,
  submitPurchaseWorkflowReceipt,
} from '@/api';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { PurchaseApplicationApplicant } from '@shared/purchase-application.interface';
import type { PurchaseInventoryRequestItem } from '@shared/purchase-inventory.interface';
import type {
  PurchaseWorkflowCommandResult,
  PurchaseWorkflowDetail,
  PurchaseWorkflowRecord,
} from '@shared/purchase-workflow.interface';
import {
  PurchaseOrderSubmissionStateError,
  PurchaseWorkflowSubmissionGate,
  clearFinishedSubmission,
  resolveActionButtonState,
  runPurchaseOrderSubmission,
} from './purchase-workflow-action.logic';
import { createPurchaseWorkflowPreviewDetail } from './purchase-workflow-center.logic';

interface PurchaseWorkflowDialogProps {
  open: boolean;
  recordId: string | null;
  item: PurchaseInventoryRequestItem | null;
  canOperate: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated: () => void;
  onOrderAccepted: (
    recordId: string,
    actualQuantity: number,
    actualAmount: number,
  ) => void;
  onOrderTaskSettled: (
    recordId: string,
    outcome: 'completed' | 'failed',
  ) => Promise<boolean>;
  onReceiptAccepted: (recordId: string) => void;
  onReceiptTaskSettled: (
    recordId: string,
    outcome: 'completed' | 'failed',
  ) => Promise<boolean>;
}

export function PurchaseWorkflowDialog({
  open,
  recordId,
  item,
  canOperate,
  onOpenChange,
  onUpdated,
  onOrderAccepted,
  onOrderTaskSettled,
  onReceiptAccepted,
  onReceiptTaskSettled,
}: PurchaseWorkflowDialogProps) {
  const [detail, setDetail] = useState<PurchaseWorkflowDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [submittingRecordId, setSubmittingRecordId] = useState<string | null>(
    null,
  );
  const [error, setError] = useState('');
  const [decision, setDecision] = useState<'approved' | 'rejected'>('approved');
  const [purchaseMethod, setPurchaseMethod] = useState<'综合采购' | '需求自采'>(
    '综合采购',
  );
  const [approvalComment, setApprovalComment] = useState('');
  const [actualQuantity, setActualQuantity] = useState('');
  const [actualAmount, setActualAmount] = useState('');
  const [orderNote, setOrderNote] = useState('');
  const [paymentAttachments, setPaymentAttachments] = useState<File[]>([]);
  const [signer, setSigner] = useState('');
  const [signerOpenId, setSignerOpenId] = useState('');
  const [signerResults, setSignerResults] = useState<
    PurchaseApplicationApplicant[]
  >([]);
  const [signerLoading, setSignerLoading] = useState(false);
  const [receiptTime, setReceiptTime] = useState('');
  const [receiptNote, setReceiptNote] = useState('');
  const [receiptPhotos, setReceiptPhotos] = useState<File[]>([]);
  const [invoices, setInvoices] = useState<File[]>([]);
  const detailRequestVersion = useRef(0);
  const signerSearchTimer = useRef<number | null>(null);
  const signerSearchSequence = useRef(0);
  const receiptSubmissionInFlight = useRef(false);
  const submissionGateRef = useRef(new PurchaseWorkflowSubmissionGate());

  const loadDetail = useCallback(async () => {
    if (!recordId) return;
    const preview = item
      ? createPurchaseWorkflowPreviewDetail(item, canOperate)
      : null;
    const requestVersion = ++detailRequestVersion.current;
    setLoading(true);
    setError('');
    try {
      const loaded = await getPurchaseWorkflowDetail(recordId);
      if (requestVersion !== detailRequestVersion.current) return;
      if (!loaded?.record) {
        throw new Error('采购流程详情响应为空');
      }
      setDetail(loaded);
      setActualQuantity(
        loaded.record.actualQuantity === null
          ? ''
          : String(loaded.record.actualQuantity),
      );
      setActualAmount(
        loaded.record.actualAmount === null
          ? ''
          : String(loaded.record.actualAmount),
      );
      if (loaded.record.signer) setSigner(loaded.record.signer);
      setReceiptTime(toDateTimeLocal(loaded.record.receiptTime || Date.now()));
      setReceiptNote(loaded.record.note || '');
    } catch (loadError) {
      if (requestVersion !== detailRequestVersion.current) return;
      if (preview) setDetail((current) => current || preview);
      setError(apiError(loadError, '采购流程详情加载失败'));
    } finally {
      if (requestVersion === detailRequestVersion.current) setLoading(false);
    }
  }, [canOperate, item, recordId]);

  useEffect(() => {
    if (open && recordId) {
      setSigner('');
      setSignerOpenId('');
      setSignerResults([]);
      setSignerLoading(false);
      if (item) {
        const preview = createPurchaseWorkflowPreviewDetail(item, canOperate);
        setDetail(preview);
        setActualQuantity(
          preview.record.actualQuantity === null
            ? ''
            : String(preview.record.actualQuantity),
        );
        setActualAmount(
          preview.record.actualAmount === null
            ? ''
            : String(preview.record.actualAmount),
        );
        setReceiptTime(
          toDateTimeLocal(preview.record.receiptTime || Date.now()),
        );
        setReceiptNote(preview.record.note || '');
      }
      void loadDetail();
    }
    if (!open) {
      detailRequestVersion.current += 1;
      signerSearchSequence.current += 1;
      if (signerSearchTimer.current) {
        window.clearTimeout(signerSearchTimer.current);
        signerSearchTimer.current = null;
      }
      setDetail(null);
      setError('');
    }
  }, [canOperate, item, loadDetail, open, recordId]);

  function searchSigner(query: string) {
    setSigner(query);
    setSignerOpenId('');
    setSignerResults([]);
    if (signerSearchTimer.current) {
      window.clearTimeout(signerSearchTimer.current);
    }
    if (!query.trim()) {
      setSignerLoading(false);
      return;
    }

    const sequence = signerSearchSequence.current + 1;
    signerSearchSequence.current = sequence;
    signerSearchTimer.current = window.setTimeout(async () => {
      setSignerLoading(true);
      try {
        const results = await searchPurchaseApplicationApplicants({
          building: detail?.record.building || item?.building || undefined,
          query: query.trim(),
          limit: 30,
        });
        if (signerSearchSequence.current === sequence) {
          setSignerResults(results);
        }
      } catch {
        if (signerSearchSequence.current === sequence) {
          toast.error('在职人员搜索失败');
        }
      } finally {
        if (signerSearchSequence.current === sequence) {
          setSignerLoading(false);
        }
      }
    }, 300);
  }

  function selectSigner(applicant: PurchaseApplicationApplicant) {
    signerSearchSequence.current += 1;
    setSigner(applicant.name);
    setSignerOpenId(applicant.openId);
    setSignerResults([]);
    setSignerLoading(false);
  }

  function clearSigner() {
    signerSearchSequence.current += 1;
    if (signerSearchTimer.current) {
      window.clearTimeout(signerSearchTimer.current);
      signerSearchTimer.current = null;
    }
    setSigner('');
    setSignerOpenId('');
    setSignerResults([]);
    setSignerLoading(false);
  }

  async function runAction(
    operation: () => Promise<PurchaseWorkflowCommandResult>,
    successMessage: string,
  ) {
    if (!canOperate || !recordId) return;
    const submissionRecordId = recordId;
    if (!submissionGateRef.current.begin(submissionRecordId)) return;
    setSubmittingRecordId(submissionRecordId);
    setError('');
    try {
      const result = await operation();
      setDetail(result.detail);
      onUpdated();
      toast.success(successMessage);
      result.notificationWarnings.forEach((warning) => toast.warning(warning));
    } catch (actionError) {
      const message = apiError(actionError, '采购流程操作失败');
      setError(message);
      toast.error(message);
    } finally {
      submissionGateRef.current.finish(submissionRecordId);
      setSubmittingRecordId((currentRecordId) =>
        clearFinishedSubmission(currentRecordId, submissionRecordId),
      );
    }
  }

  async function runOrderAction() {
    if (!canOperate || !recordId) return;
    const quantity = Number(actualQuantity);
    const amount = Number(actualAmount);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      const message = '实际采购数量必须大于 0';
      setError(message);
      toast.error(message);
      return;
    }
    if (!Number.isFinite(amount) || amount < 0) {
      const message = '实际付款金额不能小于 0';
      setError(message);
      toast.error(message);
      return;
    }

    const submissionRecordId = recordId;
    let submissionStarted = false;
    setError('');
    try {
      const submission = await runPurchaseOrderSubmission({
        gate: submissionGateRef.current,
        recordId: submissionRecordId,
        onAccepted: () => {
          submissionStarted = true;
          setSubmittingRecordId(submissionRecordId);
          onOrderAccepted(submissionRecordId, quantity, amount);
        },
        onClose: () => onOpenChange(false),
        submit: () =>
          submitPurchaseWorkflowOrder(
            submissionRecordId,
            {
              actualQuantity: quantity,
              actualAmount: amount,
              note: orderNote,
            },
            paymentAttachments,
          ),
        onSettled: onOrderTaskSettled,
      });
      if (!submission) return;
      const { result, settled: refreshed } = submission;
      if (refreshed) toast.success('下单信息已提交，等待到货签收');
      else toast.warning('下单已提交，但清单刷新失败，请手动刷新');
      result.notificationWarnings.forEach((warning) => toast.warning(warning));
    } catch (actionError) {
      if (
        actionError instanceof PurchaseOrderSubmissionStateError &&
        actionError.serverAccepted
      ) {
        toast.error('下单已提交，但页面状态同步失败，请手动刷新');
      } else if (
        actionError instanceof PurchaseOrderSubmissionStateError &&
        actionError.recoveryFailed
      ) {
        toast.error('下单失败，页面状态恢复失败，请手动刷新');
      } else {
        const message = apiError(actionError, '下单信息提交失败');
        toast.error(`${message}，页面状态已自动恢复`);
      }
    } finally {
      if (submissionStarted) {
        setSubmittingRecordId((currentRecordId) =>
          clearFinishedSubmission(currentRecordId, submissionRecordId),
        );
      }
    }
  }

  function runReceiptAction() {
    if (
      !canOperate ||
      !recordId ||
      !signerOpenId ||
      receiptSubmissionInFlight.current
    )
      return;
    receiptSubmissionInFlight.current = true;
    setError('');
    onReceiptAccepted(recordId);
    onOpenChange(false);

    window.setTimeout(() => {
      void submitPurchaseWorkflowReceipt(
        recordId,
        {
          signer,
          signerOpenId,
          receiptTime: new Date(receiptTime).getTime(),
          note: receiptNote,
        },
        receiptPhotos,
        invoices,
      )
        .then((accepted) => {
          toast.success(accepted.message);
          void monitorPurchaseWorkflowReceiptTask(
            accepted.taskId,
            async (message, warnings) => {
              const refreshed = await onReceiptTaskSettled(
                recordId,
                'completed',
              );
              if (refreshed) toast.success(message);
              else toast.warning(`${message}，但清单刷新失败，请手动刷新`);
              warnings.forEach((warning) => toast.warning(warning));
            },
            async (message) => {
              await onReceiptTaskSettled(recordId, 'failed');
              toast.error(`${message}，页面状态已自动恢复`);
            },
          );
        })
        .catch(async (actionError) => {
          await onReceiptTaskSettled(recordId, 'failed');
          const message = apiError(actionError, '到货签收提交失败');
          toast.error(`${message}，页面状态已自动恢复`);
        })
        .finally(() => {
          receiptSubmissionInFlight.current = false;
        });
    }, 0);
  }

  const allowedActions = detail?.allowedActions ?? [];
  const actionDisabled = !canOperate;
  const actionLoading = Boolean(
    recordId && submittingRecordId === recordId,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        style={{ transform: 'none', translate: 'none' }}
        className="fixed inset-0 !left-0 !top-0 flex h-[100dvh] w-screen max-w-none items-center justify-center border-0 bg-slate-950/45 p-4 shadow-none !animate-none"
      >
        <div className="grid max-h-[calc(100dvh-2rem)] w-[min(1180px,100%)] grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-lg border border-slate-200 bg-[#f4f7fc] shadow-2xl">
          <header className="flex items-center justify-between gap-4 bg-[#0c49b8] px-5 py-4 text-white">
            <div className="flex min-w-0 items-center gap-3">
              <span className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/15">
                <PackageCheck className="h-6 w-6" />
              </span>
              <div className="min-w-0">
                <DialogTitle className="truncate text-lg font-bold">
                  采购流程详情
                </DialogTitle>
                <DialogDescription className="mt-1 truncate text-xs text-blue-100">
                  {detail?.record.requestCode || '采购单据加载中'} ·{' '}
                  {detail?.record.itemName || '物品信息'}
                </DialogDescription>
              </div>
            </div>
            <button
              type="button"
              aria-label="关闭采购流程详情"
              title="关闭"
              onClick={() => onOpenChange(false)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-white/20 bg-white/10 text-white hover:bg-white/20"
            >
              <X className="h-5 w-5" />
            </button>
          </header>

          <div className="overflow-y-auto p-4 sm:p-5">
            {error && !detail ? (
              <EmptyError message={error} onRetry={() => void loadDetail()} />
            ) : detail ? (
              <div className="space-y-4">
                {loading && (
                  <div className="flex items-center rounded-lg border border-blue-200 bg-blue-50 px-4 py-2.5 text-xs text-blue-700">
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    正在后台刷新最新流程
                  </div>
                )}
                <section className="grid gap-3 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Summary
                    label="申请人"
                    value={detail.record.requesterName || '待补充'}
                  />
                  <Summary
                    label="采购人"
                    value={detail.record.purchaserName || '待分配'}
                  />
                  <Summary
                    label="申请楼栋"
                    value={detail.record.building || '待补充'}
                  />
                  <Summary
                    label="当前状态"
                    value={detail.record.status || '状态待同步'}
                    strong
                  />
                </section>

                <section className="rounded-lg border border-slate-200 bg-white p-4">
                  <h3 className="text-sm font-bold text-slate-900">流程进度</h3>
                  <div className="mt-4 grid gap-2 sm:grid-cols-6">
                    {detail.timeline.map((node, index) => (
                      <div
                        key={node.key}
                        className="relative flex min-w-0 items-center gap-2 sm:flex-col sm:text-center"
                      >
                        {index > 0 && (
                          <span className="absolute right-[calc(50%+1.25rem)] top-4 hidden h-px w-[calc(100%-2.5rem)] bg-slate-200 sm:block" />
                        )}
                        <span
                          className={cn(
                            'relative z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border-2 bg-white',
                            node.state === 'completed' &&
                              'border-emerald-500 bg-emerald-500 text-white',
                            node.state === 'current' &&
                              'border-blue-500 bg-blue-500 text-white',
                            node.state === 'terminated' &&
                              'border-rose-500 bg-rose-500 text-white',
                            node.state === 'pending' &&
                              'border-slate-200 text-slate-400',
                          )}
                        >
                          {node.state === 'completed' ? (
                            <Check className="h-4 w-4" />
                          ) : (
                            <Circle className="h-3 w-3" />
                          )}
                        </span>
                        <span className="min-w-0 truncate text-xs font-semibold text-slate-600">
                          {node.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </section>

                {!detail.programEnabled && !loading && (
                  <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{detail.disabledReason}</span>
                  </div>
                )}
                {error && (
                  <div className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                    {error}
                  </div>
                )}

                <section className="rounded-lg border border-slate-200 bg-white p-4">
                  <h3 className="text-sm font-bold text-slate-900">
                    当前节点操作
                  </h3>
                  {!allowedActions.length ? (
                    <p className="mt-3 text-sm text-slate-500">
                      当前账号在此节点没有待处理操作。
                    </p>
                  ) : (
                    <div className="mt-4">
                      {allowedActions.includes('approve') && (
                        <ApprovalForm
                          decision={decision}
                          purchaseMethod={purchaseMethod}
                          comment={approvalComment}
                          disabled={actionDisabled}
                          loading={actionLoading}
                          onDecision={setDecision}
                          onPurchaseMethod={setPurchaseMethod}
                          onComment={setApprovalComment}
                          onSubmit={() =>
                            void runAction(
                              () =>
                                approvePurchaseWorkflow(recordId!, {
                                  decision,
                                  purchaseMethod:
                                    decision === 'rejected'
                                      ? '驳回'
                                      : purchaseMethod,
                                  comment: approvalComment,
                                }),
                              decision === 'rejected'
                                ? '采购申请已驳回'
                                : '采购申请已审批',
                            )
                          }
                        />
                      )}
                      {allowedActions.includes('start') && (
                        <ActionButton
                          icon={Play}
                          disabled={actionDisabled}
                          loading={actionLoading}
                          label="确认库房并启动采购"
                          onClick={() =>
                            void runAction(
                              () => startPurchaseWorkflow(recordId!),
                              '采购任务已启动',
                            )
                          }
                        />
                      )}
                      {allowedActions.includes('order') && (
                        <OrderForm
                          quantity={actualQuantity}
                          amount={actualAmount}
                          note={orderNote}
                          files={paymentAttachments}
                          disabled={actionDisabled}
                          loading={actionLoading}
                          onQuantity={setActualQuantity}
                          onAmount={setActualAmount}
                          onNote={setOrderNote}
                          onFiles={setPaymentAttachments}
                          onSubmit={() => void runOrderAction()}
                        />
                      )}
                      {allowedActions.includes('receive') && (
                        <ReceiptForm
                          record={detail.record}
                          signer={signer}
                          signerOpenId={signerOpenId}
                          signerResults={signerResults}
                          signerLoading={signerLoading}
                          receiptTime={receiptTime}
                          note={receiptNote}
                          receiptPhotos={receiptPhotos}
                          invoices={invoices}
                          disabled={actionDisabled}
                          loading={false}
                          onSignerQuery={searchSigner}
                          onSignerSelect={selectSigner}
                          onSignerClear={clearSigner}
                          onReceiptTime={setReceiptTime}
                          onNote={setReceiptNote}
                          onReceiptPhotos={setReceiptPhotos}
                          onInvoices={setInvoices}
                          onSubmit={() => void runReceiptAction()}
                        />
                      )}
                    </div>
                  )}
                </section>
              </div>
            ) : loading ? (
              <div className="flex min-h-80 items-center justify-center text-sm text-slate-500">
                <Loader2 className="mr-2 h-5 w-5 animate-spin text-blue-500" />
                正在读取采购流程
              </div>
            ) : null}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ApprovalForm(props: {
  decision: 'approved' | 'rejected';
  purchaseMethod: '综合采购' | '需求自采';
  comment: string;
  disabled: boolean;
  loading: boolean;
  onDecision: (value: 'approved' | 'rejected') => void;
  onPurchaseMethod: (value: '综合采购' | '需求自采') => void;
  onComment: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Field label="审批结果">
        <select
          value={props.decision}
          onChange={(event) =>
            props.onDecision(event.target.value as 'approved' | 'rejected')
          }
          className={controlClass}
        >
          <option value="approved">审批通过</option>
          <option value="rejected">驳回申请</option>
        </select>
      </Field>
      <Field label="采购方式">
        <select
          value={props.purchaseMethod}
          disabled={props.decision === 'rejected'}
          onChange={(event) =>
            props.onPurchaseMethod(
              event.target.value as '综合采购' | '需求自采',
            )
          }
          className={controlClass}
        >
          <option value="综合采购">综合采购</option>
          <option value="需求自采">需求自采</option>
        </select>
      </Field>
      <div className="lg:col-span-2">
        <Label>审批意见</Label>
        <Textarea
          value={props.comment}
          onChange={(event) => props.onComment(event.target.value)}
          className="mt-2 min-h-20"
          placeholder="填写审批意见"
        />
      </div>
      <ActionButton
        icon={props.decision === 'rejected' ? X : Check}
        disabled={props.disabled}
        loading={props.loading}
        label={props.decision === 'rejected' ? '确认驳回' : '确认审批通过'}
        onClick={props.onSubmit}
      />
    </div>
  );
}

function OrderForm(props: {
  quantity: string;
  amount: string;
  note: string;
  files: File[];
  disabled: boolean;
  loading: boolean;
  onQuantity: (value: string) => void;
  onAmount: (value: string) => void;
  onNote: (value: string) => void;
  onFiles: (files: File[]) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Field label="实际采购数量">
        <Input
          type="number"
          min="1"
          value={props.quantity}
          onChange={(event) => props.onQuantity(event.target.value)}
        />
      </Field>
      <Field label="实际付款金额">
        <Input
          type="number"
          min="0"
          step="0.01"
          value={props.amount}
          onChange={(event) => props.onAmount(event.target.value)}
        />
      </Field>
      <div className="lg:col-span-2">
        <Label>采购备注</Label>
        <Textarea
          value={props.note}
          onChange={(event) => props.onNote(event.target.value)}
          className="mt-2 min-h-20"
        />
      </div>
      <FileField
        label="付款附件"
        name="paymentAttachments"
        files={props.files}
        onChange={props.onFiles}
      />
      <div className="flex items-end">
        <ActionButton
          icon={ShoppingCart}
          disabled={
            props.disabled || props.quantity === '' || props.amount === ''
          }
          loading={props.loading}
          label="提交下单结果"
          onClick={props.onSubmit}
        />
      </div>
    </div>
  );
}

function ReceiptForm(props: {
  record: PurchaseWorkflowRecord;
  signer: string;
  signerOpenId: string;
  signerResults: PurchaseApplicationApplicant[];
  signerLoading: boolean;
  receiptTime: string;
  note: string;
  receiptPhotos: File[];
  invoices: File[];
  disabled: boolean;
  loading: boolean;
  onSignerQuery: (value: string) => void;
  onSignerSelect: (applicant: PurchaseApplicationApplicant) => void;
  onSignerClear: () => void;
  onReceiptTime: (value: string) => void;
  onNote: (value: string) => void;
  onReceiptPhotos: (files: File[]) => void;
  onInvoices: (files: File[]) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ReadOnlyValue
        label="实际采购数量"
        value={formatQuantityValue(
          props.record.actualQuantity,
          props.record.unit,
        )}
      />
      <ReadOnlyValue
        label="数量差异"
        value={formatQuantityValue(
          props.record.quantityDifference,
          props.record.unit,
          '待多维表计算',
        )}
      />
      <ReadOnlyValue
        label="实际付款金额"
        value={formatMoneyValue(props.record.actualAmount)}
      />
      <ReadOnlyValue
        label="金额差异"
        value={formatMoneyValue(props.record.amountDifference, '待多维表计算')}
      />
      <ReadOnlyValue
        label="采购完成"
        value={props.record.purchaseCompleted ? '是' : '否'}
      />
      <SignerField
        query={props.signer}
        selectedOpenId={props.signerOpenId}
        results={props.signerResults}
        loading={props.signerLoading}
        disabled={props.disabled}
        onQueryChange={props.onSignerQuery}
        onSelect={props.onSignerSelect}
        onClear={props.onSignerClear}
      />
      <Field label="签收时间">
        <Input
          type="datetime-local"
          value={props.receiptTime}
          onChange={(event) => props.onReceiptTime(event.target.value)}
        />
      </Field>
      <FileField
        label="签收照片（必填）"
        name="receiptPhotos"
        accept="image/*"
        files={props.receiptPhotos}
        onChange={props.onReceiptPhotos}
        required
      />
      <FileField
        label="发票附件（选填）"
        name="invoices"
        files={props.invoices}
        onChange={props.onInvoices}
      />
      <div className="lg:col-span-2">
        <Label>签收备注</Label>
        <Textarea
          value={props.note}
          onChange={(event) => props.onNote(event.target.value)}
          className="mt-2 min-h-20"
        />
      </div>
      <ActionButton
        icon={ReceiptText}
        disabled={
          props.disabled ||
          !props.signer ||
          !props.signerOpenId ||
          !props.receiptTime ||
          !props.receiptPhotos.length
        }
        loading={props.loading}
        label="确认到货签收"
        onClick={props.onSubmit}
      />
    </div>
  );
}

function SignerField({
  query,
  selectedOpenId,
  results,
  loading,
  disabled,
  onQueryChange,
  onSelect,
  onClear,
}: {
  query: string;
  selectedOpenId: string;
  results: PurchaseApplicationApplicant[];
  loading: boolean;
  disabled: boolean;
  onQueryChange: (value: string) => void;
  onSelect: (applicant: PurchaseApplicationApplicant) => void;
  onClear: () => void;
}) {
  const fieldId = 'purchase-receipt-signer';
  return (
    <div className="relative">
      <Label htmlFor={fieldId}>签收人（必选）</Label>
      <div className="relative mt-2">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <Input
          id={fieldId}
          data-purchase-signer-field
          value={query}
          disabled={disabled}
          autoComplete="off"
          className="bg-white pl-9 pr-9"
          placeholder="搜索姓名、工号或岗位"
          onChange={(event) => onQueryChange(event.target.value)}
        />
        {loading ? (
          <Loader2 className="absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-blue-500" />
        ) : selectedOpenId ? (
          <button
            type="button"
            title="清除签收人"
            aria-label="清除签收人"
            disabled={disabled}
            onClick={onClear}
            className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded text-slate-400 hover:bg-rose-50 hover:text-rose-500"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {selectedOpenId && (
        <p className="mt-1 truncate text-[11px] text-emerald-600">
          已选择 {query}
        </p>
      )}
      {results.length > 0 && !selectedOpenId && (
        <div className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-blue-100 bg-white p-1 shadow-lg">
          {results.map((applicant) => (
            <button
              key={applicant.recordId}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onSelect(applicant)}
              className="block w-full rounded px-3 py-2 text-left transition hover:bg-blue-50 focus-visible:bg-blue-50 focus-visible:outline-none"
            >
              <span className="flex items-center justify-between gap-3">
                <strong className="truncate text-sm text-slate-800">
                  {applicant.name}
                </strong>
                <span className="shrink-0 text-[11px] text-slate-400">
                  {applicant.employeeNo || '无工号'}
                </span>
              </span>
              <span className="mt-1 block truncate text-[11px] text-slate-500">
                {[applicant.position, applicant.building, applicant.specialty]
                  .filter(Boolean)
                  .join(' · ') || '岗位信息待补充'}
              </span>
            </button>
          ))}
        </div>
      )}
      {!loading && query.trim() && !selectedOpenId && !results.length && (
        <p className="mt-1 text-[11px] text-slate-400">
          输入关键词，从飞书在职人员表模糊查找
        </p>
      )}
    </div>
  );
}

const RECEIPT_TASK_POLL_INTERVAL_MS = 500;
const RECEIPT_TASK_POLL_TIMEOUT_MS = 210_000;

async function monitorPurchaseWorkflowReceiptTask(
  taskId: string,
  onCompleted: (message: string, warnings: string[]) => void | Promise<void>,
  onFailed: (message: string) => void | Promise<void>,
): Promise<void> {
  const deadline = Date.now() + RECEIPT_TASK_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await getPurchaseWorkflowReceiptTaskStatus(taskId);
      const task = response.task;
      if (!response.success || !task) {
        await onFailed(
          response.message || '签收后台任务不存在，请刷新页面确认',
        );
        return;
      }
      if (task.status === 'completed') {
        await onCompleted(
          task.message || '到货签收已同步',
          task.notificationWarnings || task.result?.notificationWarnings || [],
        );
        return;
      }
      if (task.status === 'failed') {
        await onFailed(task.message || '签收同步飞书多维表失败');
        return;
      }
    } catch {
      // 单次状态查询失败不影响后台任务，继续等待最终状态。
    }
    await waitForReceiptTask(RECEIPT_TASK_POLL_INTERVAL_MS);
  }
  toast.warning('签收仍在后台同步，请稍后刷新页面确认结果');
}

function waitForReceiptTask(durationMs: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMs));
}

function ReadOnlyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
      <p className="text-xs font-medium text-slate-400">{label}</p>
      <p className="mt-1 font-semibold text-slate-700">{value}</p>
    </div>
  );
}

function formatQuantityValue(
  value: number | null | undefined,
  unit = '',
  fallback = '未填写',
): string {
  return value === null || value === undefined
    ? fallback
    : `${value.toLocaleString('zh-CN')} ${unit || '件'}`;
}

function formatMoneyValue(
  value: number | null | undefined,
  fallback = '未填写',
): string {
  return value === null || value === undefined
    ? fallback
    : new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency: 'CNY',
        minimumFractionDigits: 2,
      }).format(value);
}

function toDateTimeLocal(timestamp: number): string {
  const date = new Date(timestamp);
  const offset = date.getTimezoneOffset() * 60_000;
  return new Date(timestamp - offset).toISOString().slice(0, 16);
}

function ActionButton({
  icon: Icon,
  label,
  disabled,
  loading,
  onClick,
}: {
  icon: typeof Play;
  label: string;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}) {
  const {
    disabled: buttonDisabled,
    showSpinner,
  } = resolveActionButtonState({
    disabled,
    loading,
  });

  return (
    <Button
      type="button"
      disabled={buttonDisabled}
      aria-busy={loading}
      onClick={onClick}
      className="min-w-40 bg-blue-600 text-white hover:bg-blue-700"
    >
      {showSpinner ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Icon className="h-4 w-4" />
      )}
      {loading ? '提交中' : label}
    </Button>
  );
}

function FileField({
  label,
  name,
  files,
  onChange,
  accept,
  required = false,
}: {
  label: string;
  name: string;
  files: File[];
  onChange: (files: File[]) => void;
  accept?: string;
  required?: boolean;
}) {
  return (
    <Field label={label}>
      <label className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border border-dashed border-slate-300 bg-slate-50 px-3 text-sm text-slate-600 hover:border-blue-300 hover:bg-blue-50">
        <Upload className="h-4 w-4 text-blue-500" />
        <span className="truncate">
          {files.length
            ? `已选择 ${files.length} 个文件`
            : required
              ? '选择必需附件'
              : '选择附件'}
        </span>
        <input
          name={name}
          type="file"
          multiple
          accept={accept}
          className="sr-only"
          onChange={(event) => onChange(Array.from(event.target.files || []))}
        />
      </label>
    </Field>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function Summary({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-slate-400">{label}</p>
      <p
        className={cn(
          'mt-1 truncate text-sm text-slate-700',
          strong && 'font-semibold text-blue-700',
        )}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

function EmptyError({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-80 flex-col items-center justify-center text-center">
      <FileText className="h-9 w-9 text-slate-300" />
      <p className="mt-3 text-sm text-rose-600">{message}</p>
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <Button type="button" variant="outline" onClick={onRetry}>
          重新加载
        </Button>
      </div>
    </div>
  );
}

const controlClass =
  'h-10 w-full rounded-md border border-slate-200 bg-white px-3 text-sm text-slate-700 outline-none focus:border-blue-500';

function apiError(error: unknown, fallback: string): string {
  if (!error || typeof error !== 'object') return fallback;
  const candidate = error as {
    message?: string;
    response?: { data?: { message?: string | { message?: string } } };
  };
  const responseMessage = candidate.response?.data?.message;
  if (typeof responseMessage === 'string') return responseMessage;
  if (
    responseMessage &&
    typeof responseMessage === 'object' &&
    typeof responseMessage.message === 'string'
  )
    return responseMessage.message;
  return candidate.message || fallback;
}
