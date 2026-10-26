import { useEvents } from './event-data';
import { useChanges } from './change-data';
import { useAssessment } from './assessment-data';
import { useMaintenance } from './maintenance-data';
import { useAlarms } from './alarm-data';
import { changeScope } from './change-model';
import { eventScope } from './event-model';
import type { MonthlyView } from './model';
export function useOverviewOperations(view: MonthlyView) {
  const events = useEvents(view.period),
    changes = useChanges(view.period),
    drills = useAssessment('drill', view.period),
    maintenance = useMaintenance('planned', view.period),
    alarms = useAlarms(view.period);
  const scope = <T extends { building: string }>(rows: T[]) =>
    rows.filter((r) => view.building === 'all' || r.building === view.building);
  const er = scope(
      eventScope(
        events.data?.records ?? [],
        view.period.start,
        view.period.asOf,
        'period',
      ),
    ),
    cr = changeScope(
      changes.data?.records ?? [],
      view.period.start,
      view.period.end,
      view.building,
    ),
    dr = scope(drills.data?.records ?? []),
    mr = scope(maintenance.data?.records ?? []),
    ar = scope(alarms.data?.records ?? []);
  const summary = <T>(
    query: { data: unknown },
    rows: T[],
    isDone: (row: T) => boolean,
  ) => ({
    ready: !!query.data,
    total: rows.length,
    done: rows.filter(isDone).length,
  });
  return {
    event: summary(events, er, (r) => r.closed === true),
    change: summary(changes, cr, (r) => r.state === 'done'),
    drill: summary(drills, dr, (r) => r.done),
    maintenance: summary(maintenance, mr, (r) => r.done),
    maintenanceAbnormal: maintenance.data
      ? mr.filter((r) => r.abnormal).length
      : null,
    alarmPending: alarms.data
      ? ar.filter((r) => r.process === '未处理').length
      : null,
  };
}
