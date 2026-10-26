import { useSyncExternalStore, type ReactNode } from 'react';

export function restoreCalendarDayDialogFocus(
  event: Pick<Event, 'preventDefault'>,
  date: Date,
  root: Pick<Document, 'querySelector'> = document,
) {
  const target = root.querySelector<HTMLButtonElement>(
    `[data-schedule-main-calendar] button[data-day="${date.toLocaleDateString()}"]`,
  );
  if (!target?.isConnected || target.disabled) return;
  event.preventDefault();
  target.focus({ preventScroll: true });
}

type Snapshot = Readonly<{ date: Date | null; open: boolean }>;

export function createCalendarDayDialogController() {
  let snapshot: Snapshot = Object.freeze({ date: null, open: false });
  const listeners = new Set<() => void>();
  const publish = (next: Snapshot) => {
    snapshot = Object.freeze(next);
    listeners.forEach(listener => listener());
  };
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    openDate: (date: Date) => {
      const current = snapshot.date;
      const sameDate = current !== null && current.getFullYear() === date.getFullYear()
        && current.getMonth() === date.getMonth() && current.getDate() === date.getDate();
      if (sameDate && snapshot.open) return;
      publish({ date: sameDate ? current : new Date(date.getTime()), open: true });
    },
    setOpen: (open: boolean) => {
      if (snapshot.open !== open) publish({ ...snapshot, open });
    },
  });
}

type Controller = ReturnType<typeof createCalendarDayDialogController>;

export function CalendarDayDialogHost({ controller, children }: {
  controller: Controller;
  children: (snapshot: Snapshot) => ReactNode;
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return children(snapshot);
}
