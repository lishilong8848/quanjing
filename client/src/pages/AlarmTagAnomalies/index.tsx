import { useEffect, useState } from 'react';
import { getTodayOperationsAlarmDashboard } from '@/api';
import { Button } from '@/components/ui/button';
import { readAlarmTagAnomaliesDate } from '@/navigation/alarm-tag-anomalies-route';
import type { TodayOperationsAlarmDashboardResponse } from '@shared/today-operations-alarm.interface';
import { AlarmTagAnomalyDialog } from '../TodayOperationsPanorama/AlarmTagAnomalyDialog';
import '../TodayOperationsPanorama/styles.css';

type PageState =
  | { status: 'loading' }
  | { status: 'ready'; data: TodayOperationsAlarmDashboardResponse }
  | { status: 'error'; message: string };

export default function AlarmTagAnomaliesPage() {
  const [date] = useState(() => readAlarmTagAnomaliesDate(window.location.search));
  const [state, setState] = useState<PageState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (!date) {
      setState({ status: 'error', message: '告警日期无效，请从巡视卡片重新打开。' });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    void getTodayOperationsAlarmDashboard({ date, metric: 'tagAnomaly', page: 1, pageSize: 50 })
      .then((data) => { if (active) setState({ status: 'ready', data }); })
      .catch(() => { if (active) setState({ status: 'error', message: '告警异常读取失败，请重试。' }); });
    return () => { active = false; };
  }, [date, attempt]);

  const exit = () => {
    setClosed(true);
    window.close();
    if (window.history.length > 1) window.history.back();
  };

  return (
    <main className="min-h-dvh bg-background p-6">
      {closed ? (
        <section className="mx-auto max-w-lg rounded-lg border bg-card p-6">
          <h1 className="text-xl font-semibold">告警异常查看已结束</h1>
          <Button className="mt-4" onClick={() => setClosed(false)}>重新查看</Button>
        </section>
      ) : state.status === 'ready' && date ? (
        <AlarmTagAnomalyDialog open onOpenChange={(open) => { if (!open) exit(); }} snapshot={state.data} businessDate={date} initialPageLoaded />
      ) : (
        <section className="mx-auto max-w-lg rounded-lg border bg-card p-6">
          <h1 className="text-xl font-semibold">告警异常{date ? ` · ${date}` : ''}</h1>
          {state.status === 'loading' ? <p className="mt-4" role="status">加载中…</p> : state.status === 'error' ? (
            <div className="mt-4" role="alert">
              <p>{state.message}</p>
              {date && <Button className="mt-4" onClick={() => setAttempt((value) => value + 1)}>重试</Button>}
            </div>
          ) : null}
          <Button className="mt-4" variant="outline" onClick={exit}>关闭</Button>
        </section>
      )}
    </main>
  );
}
