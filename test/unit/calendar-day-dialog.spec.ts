import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const helperPath = resolve(__dirname, '../../client/src/pages/MonthlySchedule/calendar-day-dialog.ts');
function helper() {
  expect(existsSync(helperPath)).toBe(true);
  return require(helperPath);
}
const date = (day: number) => new Date(`2026-10-${day}T00:00:00+08:00`);

describe('instance-local calendar day dialog', () => {
  it('removes parent-only date/open state and keeps a permanent module-level Host', () => {
    const source=readFileSync(resolve(__dirname, '../../client/src/pages/MonthlySchedule/index.tsx'),'utf8');
    expect(source.includes('<CalendarDayDialogHost controller={calendarDayDialogController}>')).toBe(true);
    expect(source.includes('useState(createCalendarDayDialogController)')).toBe(true);
    expect(source.includes('calendarDayDialogController.openDate(date)')).toBe(true);
    expect(source.includes('setCalendarDetailDate(date)')).toBe(false);
    expect(source.includes('useSyncExternalStore(calendarDayDialogController')).toBe(false);
  });

  it('returns a cached closed snapshot until an actual state change', () => {
    const controller=helper().createCalendarDayDialogController();
    const initial=controller.getSnapshot();
    expect(initial).toEqual({date:null,open:false});
    expect(controller.getSnapshot()).toBe(initial);
    expect(Object.isFrozen(initial)).toBe(true);
  });

  it('opens synchronously and does not notify twice for the same open date', () => {
    const controller=helper().createCalendarDayDialogController();
    const listener=jest.fn(); controller.subscribe(listener);
    controller.openDate(date(16));
    const first=controller.getSnapshot();
    expect(first.open).toBe(true);
    expect(first.date.getTime()).toBe(date(16).getTime());
    controller.openDate(date(16));
    controller.openDate(new Date(date(16).getTime() + 2 * 60 * 60 * 1000));
    expect(controller.getSnapshot()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies when an already-open dialog changes date', () => {
    const controller=helper().createCalendarDayDialogController();
    controller.openDate(date(15));
    const listener=jest.fn(); controller.subscribe(listener);
    controller.openDate(date(16));
    expect(controller.getSnapshot().date.getTime()).toBe(date(16).getTime());
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('closes synchronously, retains its date and ignores repeated close', () => {
    const controller=helper().createCalendarDayDialogController();
    controller.openDate(date(16));
    const listener=jest.fn(); controller.subscribe(listener);
    controller.setOpen(false);
    const closed=controller.getSnapshot();
    expect(closed.open).toBe(false);
    expect(closed.date.getTime()).toBe(date(16).getTime());
    controller.setOpen(false);
    expect(controller.getSnapshot()).toBe(closed);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes without leaking events', () => {
    const controller=helper().createCalendarDayDialogController();
    const listener=jest.fn(),unsubscribe=controller.subscribe(listener);
    unsubscribe(); unsubscribe(); controller.openDate(date(16));
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps independent page instances isolated and does not retain a caller-mutable date', () => {
    const {createCalendarDayDialogController}=helper();
    const first=createCalendarDayDialogController(),second=createCalendarDayDialogController();
    const input=date(16); first.openDate(input); input.setDate(17);
    expect(first.getSnapshot().date.getTime()).toBe(date(16).getTime());
    expect(second.getSnapshot()).toEqual({date:null,open:false});
  });

  it('renders while closed and consumes the latest data/permission callback', () => {
    const {CalendarDayDialogHost,createCalendarDayDialogController}=helper();
    const controller=createCalendarDayDialogController();
    const render=(label:string)=>renderToStaticMarkup(createElement(CalendarDayDialogHost,{
      controller,children:()=>createElement('span',null,label),
    }));
    expect(render('readonly-old')).toContain('readonly-old');
    controller.openDate(date(16));
    expect(render('authorized-new')).toContain('authorized-new');
  });
});
