import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChartNoAxesCombined } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AttendanceHistoryDialog } from './AttendanceHistoryDialog';
import { getDefaultAttendanceHistoryRange } from './attendance-history-presentation';
import { prefetchAttendanceHistory } from './use-attendance-history';

export function AttendanceHistoryDialogButton({
  canViewCorrectionEvidence,
}: {
  canViewCorrectionEvidence: boolean;
}) {
  const [open, setOpen] = useState(false);
  const defaultRange = useMemo(() => getDefaultAttendanceHistoryRange(), []);
  const warm = useCallback(() => {
    void prefetchAttendanceHistory(defaultRange).catch(() => undefined);
  }, [defaultRange]);

  useEffect(() => {
    const timer = window.setTimeout(warm, 600);
    return () => window.clearTimeout(timer);
  }, [warm]);

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="text-current"
        onClick={() => {
          warm();
          setOpen(true);
        }}
        onPointerEnter={warm}
        onFocus={warm}
        aria-label="查询历史考勤异常"
        title="查询历史考勤异常"
      >
        <ChartNoAxesCombined className="size-3.5" aria-hidden="true" />
      </Button>
      {open && (
        <AttendanceHistoryDialog
          open={open}
          onOpenChange={setOpen}
          canViewCorrectionEvidence={canViewCorrectionEvidence}
        />
      )}
    </>
  );
}
