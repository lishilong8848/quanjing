import { createRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StableScheduleCalendarRoot } from '../../client/src/pages/MonthlySchedule/calendar-root';

describe('stable schedule calendar root', () => {
  it('keeps the existing div, calendar marker, class and children', () => {
    const element = StableScheduleCalendarRoot({
      className: 'schedule-root',
      children: 'day cells',
    });
    expect(element.type).toBe('div');
    expect(element.props['data-slot']).toBe('calendar');
    expect(element.props.className).toBe('schedule-root');
    expect(element.props.children).toBe('day cells');
  });

  it('forwards the root reference and native accessibility attributes', () => {
    const rootRef = createRef<HTMLDivElement>();
    const onKeyDown = jest.fn();
    const element = StableScheduleCalendarRoot({
      rootRef,
      id: 'calendar-root',
      role: 'region',
      'aria-label': '排班日期',
      onKeyDown,
    });
    expect(Reflect.get(element.props, 'ref')).toBe(rootRef);
    expect(element.props.id).toBe('calendar-root');
    expect(element.props.role).toBe('region');
    expect(element.props['aria-label']).toBe('排班日期');
    expect(element.props.onKeyDown).toBe(onKeyDown);
  });

  it('installs the same module-level root in both schedule calendars', () => {
    const source = readFileSync(
      resolve(__dirname, '../../client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    expect(source.match(/Root:\s*StableScheduleCalendarRoot/g)).toHaveLength(2);
  });

  it('cannot clear the selected compact date', () => {
    const source = readFileSync(
      resolve(__dirname, '../../client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const selection = source.indexOf('onSelect={handleDateClick}');
    const start = source.lastIndexOf('<Calendar', selection);
    const end = source.indexOf('/>', selection);
    expect(selection).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(selection);
    expect(source.slice(start, end)).toMatch(/mode="single"\s+required\s/);
  });
});
