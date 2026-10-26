import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('MonthlySchedule attendance section spacing', () => {
  it('uses the same section gap above and below the attendance anomaly card', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const wrapper = source.match(
      /<div className="([^"]+)" data-screenshot-extra="true">\s*<TodayAttendanceAnomalyList/u,
    );

    expect(wrapper).not.toBeNull();
    expect(wrapper?.[1].split(/\s+/u)).toContain('mb-6');
    expect(wrapper?.[1].split(/\s+/u)).not.toContain('mt-4');
  });

  it('lays out personnel movement groups as an equal-width responsive grid', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const start = source.indexOf('function TodayPersonnelMovementCard');
    const end = source.indexOf('function TodayEngineersOnDuty', start);
    const component = source.slice(start, end);

    expect(component).toContain(
      'duty-leave-grid grid grid-cols-1 gap-3 md:grid-cols-2',
    );
    expect(component).toContain('duty-leave-item grid w-full min-w-0');
    expect(component).toContain('duty-leave-content');
    expect(component).toContain('duty-leave-relation');
    expect(component).toContain('duty-leave-tag-absence');
    expect(component).toContain('duty-leave-shift-tag');
    expect(component).toContain('duty-leave-tag-substitute');
    expect(component).not.toContain('<div className="flex flex-wrap gap-3">');
  });

  it('keeps the three sealing footers on one baseline with matching content slots', () => {
    const cssSource = readFileSync(
      resolve(process.cwd(), 'client/src/index.css'),
      'utf8',
    );
    expect(cssSource).toMatch(
      /\.duty-sealing-footer\s*\{[^}]*min-height:\s*4\.5rem/u,
    );
    expect(cssSource).toMatch(
      /\.duty-sealing-footer-empty\s*\{[^}]*align-items:\s*center/u,
    );
    expect(cssSource).toMatch(
      /\.duty-leave-item\s*\{[^}]*grid-template-columns:\s*2\.5rem minmax\(0, 1fr\)/u,
    );
  });

  it('limits movement cards to two readable columns with one change per line', () => {
    const component = readFileSync(
      resolve(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    expect(component).toContain(
      'duty-leave-grid grid grid-cols-1 gap-3 md:grid-cols-2',
    );
    expect(component).toContain(
      'duty-leave-content flex min-w-0 flex-col items-start gap-1',
    );
  });

  it('uses the VNET theme and compact overview states', () => {
    const pageSource = readFileSync(
      resolve(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const cssSource = readFileSync(
      resolve(process.cwd(), 'client/src/index.css'),
      'utf8',
    );

    expect(pageSource).toContain('duty-nearby-title-marker');
    expect(pageSource).toContain('duty-nearby-roster');
    expect(pageSource).toContain('duty-personnel-summary');
    expect(pageSource).toContain('当日无请假及差旅安排');
    expect(pageSource).not.toContain(
      'from-amber-50/90 via-orange-50/80 to-pink-50/90',
    );
    expect(cssSource).toContain('--duty-brand-primary:');
    expect(cssSource).toMatch(
      /\.duty-sealing-empty\s*\{[^}]*height:\s*2rem\s*!important;/u,
    );
  });

  it('uses a coordinated two-column roster for D and E buildings on wide screens', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'client/src/pages/MonthlySchedule/index.tsx'),
      'utf8',
    );
    const start = source.indexOf('function TodayEngineersOnDuty');
    const end = source.indexOf('function MonthlySchedulePageContent', start);
    const component = source.slice(start, end);

    expect(component).toContain('isCompactTwoColumnBuilding');
    expect(component).toContain("buildingKey === 'building_d'");
    expect(component).toContain("buildingKey === 'building_e'");
    expect(component).toContain("'grid-cols-1 xl:grid-cols-2'");
  });
});
