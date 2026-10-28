import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';
import { useState } from 'react';
import {
  CheckCircle2,
  FileUp,
  Loader2,
  LockKeyhole,
  Trash2,
} from 'lucide-react';
import type {
  SystemMonthlyReportRoom,
  SystemMonthlyReportStage,
  SystemMonthlyReportSubmissionOperation,
} from '@shared/system-monthly-report.interface';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { buildSystemMonthlyReportSubmissionStageOptions } from './system-monthly-report.logic';

type DeleteTarget = {
  room: SystemMonthlyReportRoom;
  stage: SystemMonthlyReportStage;
  label: string;
};

export function SubmissionLauncherDialog({
  open,
  rooms,
  periodLabel,
  editable,
  onOpenChange,
  onSelect,
  onDelete,
}: {
  open: boolean;
  rooms: SystemMonthlyReportRoom[];
  periodLabel: string;
  editable: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (
    room: SystemMonthlyReportRoom,
    stage: SystemMonthlyReportStage,
    operation: SystemMonthlyReportSubmissionOperation,
  ) => void;
  onDelete: (
    room: SystemMonthlyReportRoom,
    stage: SystemMonthlyReportStage,
  ) => Promise<void>;
}) {
  const canDelete = canUsePageAction(useAccess(), 'system_reports', 'delete', true);
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [pendingDeletes, setPendingDeletes] = useState<Set<string>>(
    () => new Set(),
  );

  const confirmDelete = async () => {
    if (!canDelete || !deleteTarget || deleting) return;
    const key = `${deleteTarget.room.recordId}:${deleteTarget.stage}`;
    setDeleting(true);
    setDeleteError('');
    try {
      await onDelete(deleteTarget.room, deleteTarget.stage);
      setPendingDeletes((current) => new Set(current).add(key));
      setDeleteTarget(null);
    } catch {
      setDeleteError('删除未受理，请重试。');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteTarget(null);
          onOpenChange(nextOpen);
        }}
      >
        <DialogContent className="max-h-[82vh] overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="border-b border-slate-100 bg-slate-50/80 px-6 py-5 text-left">
            <DialogTitle className="text-xl">
              提交月报 · {periodLabel}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {periodLabel}机房月报版本操作
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[62vh] space-y-2 overflow-y-auto px-6 py-4">
            {rooms
              .filter((room) => room.access?.canSubmit)
              .map((room) => {
                const options = buildSystemMonthlyReportSubmissionStageOptions(
                  room,
                  editable,
                );
                return (
                  <div
                    key={room.recordId}
                    className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 bg-white px-4 py-3"
                  >
                    <div className="min-w-36 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-semibold text-slate-900">
                          {room.room}
                        </p>
                        <Badge variant="outline" className="text-[10px]">
                          {room.statusLabel}
                        </Badge>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">
                        {room.submitters.map((item) => item.name).join('、') ||
                          '未维护'}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {options.map((option) => {
                        const pending = pendingDeletes.has(
                          `${room.recordId}:${option.stage}`,
                        );
                        const actionable =
                          option.state === 'available' ||
                          option.state === 'replaceable';
                        return (
                          <div
                            key={option.stage}
                            className="flex items-center gap-1"
                          >
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              disabled={!actionable || pending}
                              aria-label={`${room.room}${option.label}`}
                              className={
                                actionable
                                  ? 'border-blue-200 text-blue-700'
                                  : option.state === 'completed'
                                    ? 'border-teal-100 bg-teal-50/60 text-teal-600 opacity-100'
                                    : ''
                              }
                              onClick={() =>
                                onSelect(
                                  room,
                                  option.stage,
                                  option.state === 'replaceable'
                                    ? 'replace'
                                    : 'create',
                                )
                              }
                            >
                              {pending ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : actionable ? (
                                <FileUp className="h-4 w-4" />
                              ) : option.state === 'completed' ? (
                                <CheckCircle2 className="h-4 w-4" />
                              ) : (
                                <LockKeyhole className="h-4 w-4" />
                              )}
                              {pending
                                ? '处理中'
                                : option.state === 'replaceable'
                                  ? `替换${option.label}`
                                  : option.label}
                            </Button>
                            {canDelete && option.canDelete && !pending ? (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                className="h-8 w-8 text-slate-400 hover:bg-rose-50 hover:text-rose-600"
                                aria-label={`删除${room.room}${option.label}`}
                                onClick={() => {
                                  setDeleteError('');
                                  setDeleteTarget({
                                    room,
                                    stage: option.stage,
                                    label: option.label,
                                  });
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                              </Button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={Boolean(deleteTarget)}
        onOpenChange={(nextOpen) => !nextOpen && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              删除{deleteTarget?.room.room} {deleteTarget?.label}？
            </AlertDialogTitle>
            <AlertDialogDescription className="sr-only">
              确认删除当前月报版本
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? (
            <p className="text-sm text-rose-600" role="alert">
              {deleteError}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              className="bg-rose-600 hover:bg-rose-700"
              disabled={deleting}
              onClick={(event) => {
                event.preventDefault();
                void confirmDelete();
              }}
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
