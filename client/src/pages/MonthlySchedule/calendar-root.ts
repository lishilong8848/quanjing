import { createElement } from 'react';
import type { RootProps } from 'react-day-picker';
import { cn } from '../../lib/utils';

export function StableScheduleCalendarRoot({ className, rootRef, ...props }: RootProps) {
  return createElement('div', {
    'data-slot': 'calendar',
    ref: rootRef,
    className: cn(className),
    ...props,
  });
}
