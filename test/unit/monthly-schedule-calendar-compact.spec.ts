import { readFileSync } from 'fs';
import { join } from 'path';

function getCalendarDayWithChangesSource(): string {
  const source = readFileSync(
    join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
    'utf8',
  );
  const start = source.indexOf('const StatusCalendarDayButtonWithChanges');
  const end = source.indexOf('const calendarWeatherSection', start);

  return source.slice(start, end);
}

describe('MonthlySchedule compact calendar day cell', () => {
  it('keeps overview navigation inside its own positioned month container', () => {
    const source = readFileSync(join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'), 'utf8');
    const start = source.indexOf('<Calendar\n', source.indexOf('const calendarWeatherSection'));
    const overview = source.slice(start, source.indexOf('</Calendar>', start) > start ? source.indexOf('</Calendar>', start) : source.indexOf('/>',start));
    expect(overview).toContain("months: 'relative w-full'");
  });
  it('uses a dedicated compact picker instead of the overview day cards', () => {
    const source = readFileSync(join(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'), 'utf8');
    const start = source.indexOf('<PopoverContent className="w-auto p-0" align="start">', source.indexOf('const calendarWeatherSection'));
    const picker = source.slice(start, source.indexOf('</PopoverContent>', start));
    expect(picker).toContain('CompactCalendarDayButton');
    expect(picker).not.toContain('StatusCalendarDayButtonWithChanges');
    expect(picker).toContain('grid grid-cols-7');
  });
  it('uses a non-text today marker and places conflict warning in the top-right corner', () => {
    const source = getCalendarDayWithChangesSource();

    expect(source).not.toContain('>\n            今\n          </span>');
    expect(source).toContain('todayClassName');
    expect(source).toContain('absolute right-1 top-1');
  });
});
