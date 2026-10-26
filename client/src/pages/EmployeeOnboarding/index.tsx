import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, UserPlus } from 'lucide-react';
import { Toaster } from 'sonner';

import { Button } from '@/components/ui/button';
import NewEmployeeOnboardingDialog, {
  type EmployeeOnboardingSubmissionState,
} from '../MonthlySchedule/NewEmployeeOnboardingDialog';

export default function EmployeeOnboardingPage() {
  const [open, setOpen] = useState(true);
  const [submission, setSubmission] =
    useState<EmployeeOnboardingSubmissionState>({ status: 'ready' });
  const [exitHint, setExitHint] = useState(false);

  useEffect(() => {
    document.title = '新员工入职登记 - 世纪互联南通基地';
  }, []);

  const exit = () => {
    setExitHint(true);
    window.close();
    window.setTimeout(() => {
      if (window.history.length > 1) window.history.back();
    }, 150);
  };

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4">
      <section className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 shadow-sm">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          {submission.status === 'confirmed' ? (
            <CheckCircle2 className="text-primary" aria-hidden="true" />
          ) : (
            <UserPlus className="text-primary" aria-hidden="true" />
          )}
          {submission.status === 'confirmed'
            ? '入职登记成功'
            : '新员工入职登记'}
        </h1>
        {submission.status === 'syncing' && (
          <p role="status" className="flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            正在同步入职资料，请稍候
          </p>
        )}
        {submission.status === 'ready' && (
          <Button onClick={() => setOpen(true)}>继续填写登记</Button>
        )}
        {submission.status === 'confirmed' && (
          <>
            <p className="break-all text-sm">
              登记编号：{submission.result.recordId}
            </p>
            {submission.cleanupWarning && (
              <p role="alert" className="text-sm text-destructive">
                记录已写入，本地状态未清理，请勿重复提交。
              </p>
            )}
            <Button onClick={exit}>完成并退出</Button>
          </>
        )}
        {exitHint && (
          <p role="status" className="text-sm text-muted-foreground">
            如页面未关闭，可使用返回按钮或关闭此标签页。
          </p>
        )}
      </section>
      <NewEmployeeOnboardingDialog
        open={open}
        onOpenChange={setOpen}
        onSubmissionStateChange={setSubmission}
      />
      <Toaster richColors position="top-center" />
    </main>
  );
}
