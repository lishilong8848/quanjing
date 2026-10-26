import { readFileSync } from 'fs';
import { join } from 'path';

const source = readFileSync(
  join(
    process.cwd(),
    'server/modules/bitable-sync/today-operations-follow-up.controller.ts',
  ),
  'utf8',
);

describe('TodayOperationsFollowUpController route gate', () => {
  it('publishes the signed lightweight page and requires current identity for scoped APIs', () => {
    expect(source).toMatch(
      /@PublicAccess\(\)\s+@Get\('attendance-anomaly-follow-up'\)/u,
    );
    expect(source).toMatch(
      /@GuestReadable\(\)\s+@Get\('api\/duty-schedules\/daily-operations-follow-ups'\)/u,
    );
    expect(source).not.toMatch(/@PublicAccess\(\)\s+@Post\('api\/duty-schedules\/daily-operations-follow-ups'\)/u);
    expect(source).toContain('this.requireCurrentSession(request)');
    expect(source).toContain("@Headers('x-follow-up-ticket')");
    expect(source).toContain('this.tickets.verify(ticket)');
    expect(source).toContain(
      "response?.setHeader('Cache-Control', 'no-store')",
    );
  });

  it('passes the verified date range into reads and writes', () => {
    expect(source).toContain(
      'this.service.listFollowUps(scope.from, scope.through)',
    );
    expect(source).toMatch(
      /this\.service\.updateFollowUp\(\{ \.\.\.body, handlerName: session\.principal\.displayName \|\| '平台账号' \},\s*\{\s*from: scope\.from,\s*through: scope\.through/u,
    );
    expect(source).toContain(
      "throw new BadRequestException('异常跟进请求无效')",
    );
  });
});
