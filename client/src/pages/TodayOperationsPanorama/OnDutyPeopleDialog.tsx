import { Building2, CalendarDays, Moon, Sun, Users, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TodayAttendanceAnomalyList } from '@/components/attendance/TodayAttendanceAnomalyList';
import type { UseTodayAttendanceSnapshotResult } from '@/components/attendance/use-today-attendance';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { OnDutyDialogModel } from './top-kpi-model';

interface OnDutyPeopleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: OnDutyDialogModel;
  attendance: UseTodayAttendanceSnapshotResult;
  canViewAttendance?: boolean;
  canManualSync?: boolean;
  canViewCorrectionEvidence?: boolean;
}

function formatDate(value: string | null): string {
  if (!value) return '日期待同步';
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : value;
}

function formatShiftSummary(
  shift: OnDutyDialogModel['shifts'][number],
): string {
  return shift.total === null
    ? `${shift.shiftLabel} 待同步`
    : `${shift.shiftLabel} ${shift.total} 人`;
}

export function OnDutyPeopleDialog({
  open,
  onOpenChange,
  model,
  attendance,
  canViewAttendance = false,
  canManualSync = false,
  canViewCorrectionEvidence = false,
}: OnDutyPeopleDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="today-panorama-detail-dialog flex max-h-[min(84vh,720px)] w-[min(920px,calc(100vw-2rem))] max-w-none flex-col gap-0 overflow-hidden border-slate-200 p-0"
        showCloseButton={false}
      >
        <DialogHeader className="flex-row items-start gap-3 border-b border-slate-200 bg-slate-50/80 px-5 py-4 text-left sm:px-6">
          <span
            className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-50 text-blue-600"
            aria-hidden="true"
          >
            <Users className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <DialogTitle className="text-lg leading-6 text-slate-950">
              今日在岗人员
            </DialogTitle>
            <DialogDescription className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
              <span className="inline-flex items-center gap-1.5">
                <CalendarDays className="size-3.5" aria-hidden="true" />
                {formatDate(model.date)}
              </span>
              <strong className="font-semibold text-blue-700">
                {model.shifts.map(formatShiftSummary).join(' · ')}
              </strong>
            </DialogDescription>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-slate-500"
              aria-label="关闭今日在岗人员清单"
            >
              <X aria-hidden="true" />
            </Button>
          </DialogClose>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/40 p-4 sm:p-5">
          <div className="today-panorama-on-duty-shifts">
            {model.shifts.map((shift) => {
              const ShiftIcon = shift.shift === 'white' ? Sun : Moon;
              return (
                <section
                  className="today-panorama-on-duty-shift"
                  data-shift={shift.shift}
                  key={shift.shift}
                  aria-label={`${shift.shiftLabel}人员清单`}
                >
                  <header className="today-panorama-on-duty-shift-head">
                    <span aria-hidden="true">
                      <ShiftIcon />
                    </span>
                    <h3>{shift.shiftLabel}</h3>
                    <b>
                      {shift.total === null ? '待同步' : `${shift.total} 人`}
                    </b>
                  </header>

                  {!shift.dataAvailable ? (
                    <div
                      className="today-panorama-on-duty-empty is-compact"
                      role="status"
                    >
                      <Users aria-hidden="true" />
                      <strong>人员清单正在更新</strong>
                      <span>
                        当前缓存仅包含人数汇总，具体人员清单将在刷新后显示
                      </span>
                    </div>
                  ) : shift.buildings.length > 0 ? (
                    <ol
                      className="today-panorama-on-duty-grid"
                      aria-label={`${shift.shiftLabel}按楼栋分组`}
                    >
                      {shift.buildings.map((building) => (
                        <li
                          className="today-panorama-on-duty-building"
                          key={`${shift.shift}-${building.building}`}
                        >
                          <header>
                            <span aria-hidden="true">
                              <Building2 />
                            </span>
                            <h3>
                              {building.buildingName || building.building}
                            </h3>
                            <b>
                              {
                                building.people.filter(
                                  (person) => person.onDuty,
                                ).length
                              }{' '}
                              人在岗
                            </b>
                          </header>
                          {building.people.length > 0 ? (
                            <ul aria-label={`${building.buildingName}人员状态`}>
                              {building.people.map((person, index) => {
                                return (
                                  <li
                                    data-on-duty={
                                      person.onDuty ? 'true' : 'false'
                                    }
                                    key={`${person.name}-${person.status}-${index}`}
                                  >
                                    <span>{person.name}</span>
                                    <em data-status={person.status}>
                                      {person.statusLabel}
                                    </em>
                                    {person.relatedStaff.length > 0 ? (
                                      <small>
                                        关联：{person.relatedStaff.join('、')}
                                      </small>
                                    ) : null}
                                  </li>
                                );
                              })}
                            </ul>
                          ) : (
                            <p>本楼暂无人员记录</p>
                          )}
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div
                      className="today-panorama-on-duty-empty is-compact"
                      role="status"
                    >
                      <Users aria-hidden="true" />
                      <strong>{shift.shiftLabel}暂无人员记录</strong>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          {canViewAttendance && <TodayAttendanceAnomalyList
            {...attendance}
            compact
            title="今日考勤异常"
            canManualSync={canManualSync}
            canViewCorrectionEvidence={canViewCorrectionEvidence}
          />}
        </div>
      </DialogContent>
    </Dialog>
  );
}
