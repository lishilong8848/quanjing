import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const readSource = (relativePath: string) =>
  readFileSync(join(process.cwd(), relativePath), 'utf8');

describe('China work calendar snapshot transport', () => {
  it('exposes a dedicated guest-readable in-memory endpoint', () => {
    const controller = readSource(
      'server/modules/duty-schedule/china-work-calendar.controller.ts',
    );
    const moduleSource = readSource(
      'server/modules/duty-schedule/duty-schedule.module.ts',
    );

    expect(controller).toMatch(
      /@GuestReadable\(\)\s+@Get\(\)\s+getChinaWorkCalendar\(/,
    );
    expect(controller).toContain(
      "@Controller('api/duty-schedules/work-calendar')",
    );
    expect(controller).toContain('this.calendarService.getResponse()');
    expect(moduleSource).toContain('ChinaWorkCalendarController');
    expect(moduleSource).toContain('ChinaWorkCalendarService');
  });

  it('allows the exact read-only endpoint for duty editor sessions', () => {
    const guard = readSource('server/common/access/unified-access.guard.ts');

    expect(guard).toContain("'GET /api/duty-schedules/work-calendar'");
  });

  it('uses a typed client request without refresh or mutation parameters', () => {
    const api = readSource('client/src/api/index.ts');

    expect(api).toContain('getChinaWorkCalendar');
    expect(api).toContain("url: '/api/duty-schedules/work-calendar'");
    expect(api).toMatch(/getChinaWorkCalendar[\s\S]{0,500}method:\s*'GET'/);
  });

  it('loads the snapshot non-blockingly and reruns calendar-dependent leave calculations', () => {
    const page = readSource('client/src/pages/MonthlySchedule/index.tsx');

    expect(page).toContain('installChinaWorkCalendarSnapshot');
    expect(page).toContain('getChinaWorkCalendar');
    expect(page).toContain('workCalendarRevision');
    expect(page).toMatch(
      /void\s+getChinaWorkCalendar\(\)[\s\S]{0,900}installChinaWorkCalendarSnapshot/,
    );
    expect(page).toMatch(
      /createLeaveRequestTimeCandidates[\s\S]{0,350}\[([^\]]*workCalendarRevision[^\]]*)\]/,
    );
    expect(page).toMatch(
      /calculateLeaveRequestImpact[\s\S]{0,350}\[([^\]]*workCalendarRevision[^\]]*)\]/,
    );
    expect(page).toMatch(
      /interface TodayEngineersOnDutyProps[\s\S]{0,220}workCalendarRevision:\s*number/,
    );
    expect(page).toMatch(
      /<TodayEngineersOnDuty[\s\S]{0,260}workCalendarRevision=\{workCalendarRevision\}/,
    );
    expect(page).toContain(
      '`${dateStr}|calendar:${workCalendarRevision}`',
    );
  });
});
