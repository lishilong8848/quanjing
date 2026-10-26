import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const helper = () => require('../../client/src/pages/MonthlySchedule/calendar-day-dialog');

describe('calendar day dialog close focus', () => {
  it('focuses only a connected enabled main-calendar date button synchronously', () => {
    const focus = jest.fn();
    const target = { isConnected: true, disabled: false, focus };
    const querySelector = jest.fn(() => target);
    const event = { preventDefault: jest.fn() };
    const day = new Date(2026, 9, 16);
    helper().restoreCalendarDayDialogFocus(event, day, { querySelector });
    expect(querySelector).toHaveBeenCalledWith(`[data-schedule-main-calendar] button[data-day="${day.toLocaleDateString()}"]`);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it.each([null, { isConnected: false, disabled: false }, { isConnected: true, disabled: true }])('preserves default close behavior for an unavailable target %p', target => {
    const event = { preventDefault: jest.fn() };
    helper().restoreCalendarDayDialogFocus(event, new Date(2026, 9, 16), { querySelector: () => target });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('wires only the day dialog and explicitly marks the main calendar', () => {
    const source = readFileSync(resolve(__dirname, '../../client/src/pages/MonthlySchedule/index.tsx'), 'utf8');
    expect(source.includes('data-schedule-main-calendar')).toBe(true);
    expect(source.includes('onCloseAutoFocus={event => restoreCalendarDayDialogFocus(event, calendarDetailDate || selectedDate)}')).toBe(true);
  });
});
