import { randomBytes } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import type { AccessPrincipal } from '../../shared/access-control.interface';
import { UnifiedAccessService } from '../../server/common/access/unified-access.service';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { TodayOperationsFollowUpController } from '../../server/modules/bitable-sync/today-operations-follow-up.controller';
import { TodayOperationsFollowUpTicketService, issueTodayOperationsFollowUpTicket, verifyTodayOperationsFollowUpTicket } from '../../server/modules/bitable-sync/today-operations-follow-up.ticket';

const appId = 'cli_synthetic_followup', secret = 'synthetic-followup-ticket-secret-only';
const scope = { from: '2026-10-01', through: '2026-10-13', issuedAt: Date.now() };
type Request = { headers: { cookie?: string }; method: string; url: string; originalUrl: string; query: Record<string, string> };
type Port = { list(ticket: string, request: Request): Promise<unknown>; update(ticket: string, body: unknown, request: Request): Promise<unknown> };
describe('群跟进链接使用本人当前会话', () => {
  const saved = { ...process.env };
  let current: AccessPrincipal, active: boolean, paths: string[], access: UnifiedAccessService, tickets: TodayOperationsFollowUpTicketService;
  beforeEach(() => {
    process.env.FEISHU_APP_ID = appId; process.env.DAILY_OPERATIONS_FOLLOW_UP_TICKET_SECRET = secret;
    process.env.LOCAL_ACCESS_SESSION_SECRET = randomBytes(32).toString('base64'); process.env.LOCAL_ACCESS_CONTROL_ENABLED = 'true';
    active = true; paths = ['/monthly-schedule'];
    current = { role: 'admin', purchaseBuilding: null, accountId: `feishu-${'a'.repeat(64)}`, authorizationVersion: 1, displayName: '合成管理员' };
    access = new UnifiedAccessService({ validateSession: (id: string, version: number, role: string) => active && id === current.accountId && version === current.authorizationVersion && role === current.role, currentPrincipal: () => active ? current : undefined, pagePermissions: () => ({ paths, configured: true, revision: 1 }) } as never);
    tickets = new TodayOperationsFollowUpTicketService();
  });
  afterEach(() => { process.env = { ...saved }; });
  const request = (cookie?: string, method = 'GET'): Request => ({ headers: { cookie }, method, url: '/api/duty-schedules/daily-operations-follow-ups', originalUrl: '/api/duty-schedules/daily-operations-follow-ups', query: {} });
  const token = () => `${access.cookieName}=${access.issueTrustedSession(current as never).token}`;
  it('真实签名的新群票据绑定app，跨应用拒绝且原v1仍可识别', () => {
    const legacy = issueTodayOperationsFollowUpTicket(scope, secret);
    expect(verifyTodayOperationsFollowUpTicket(legacy, secret, { now: Date.now() })).toEqual(scope);
    const bound = issueTodayOperationsFollowUpTicket({ ...scope, appId } as never, secret);
    expect(tickets.verify(bound)).toMatchObject({ appId });
    process.env.FEISHU_APP_ID = 'cli_another_fixture';
    expect(() => tickets.verify(bound)).toThrow();
  });
  it('原v1不能匿名读写；当前实名管理员可办理，收权后原cookie不能新写', async () => {
    const service = { listFollowUps: jest.fn(async () => []), updateFollowUp: jest.fn(async () => ({ recordId: 'recSynthetic', completed: true })) };
    const controller = new (TodayOperationsFollowUpController as unknown as new (...args: unknown[]) => Port)(tickets, service, access);
    const ticket = issueTodayOperationsFollowUpTicket(scope, secret);
    await expect(controller.list(ticket, request())).rejects.toThrow();
    expect(service.listFollowUps).not.toHaveBeenCalled();
    const authenticated = request(token());
    await expect(controller.list(ticket, authenticated)).resolves.toMatchObject({ success: true });
    await expect(controller.update(ticket, { recordId: 'recSynthetic' }, authenticated)).resolves.toMatchObject({ success: true });
    expect(service.updateFollowUp).toHaveBeenCalledWith(expect.objectContaining({ handlerName: current.displayName }), { from: scope.from, through: scope.through });
    active = false;
    await expect(controller.update(ticket, { recordId: 'recSynthetic' }, authenticated)).rejects.toThrow();
    expect(service.updateFollowUp).toHaveBeenCalledTimes(1);
  });
  it('统一guard对基地员工只开放读取，个人页面范围收回后也拒绝读取', async () => {
    current = { ...current, role: 'site_member', displayName: '合成员工' };
    const service = { listFollowUps: jest.fn(async () => []), updateFollowUp: jest.fn() };
    const controller = new (TodayOperationsFollowUpController as unknown as new (...args: unknown[]) => Port)(tickets, service, access);
    const guard = new UnifiedAccessGuard(new Reflector(), access), cookie = token();
    const check = (method: 'GET' | 'POST') => guard.canActivate({ switchToHttp: () => ({ getRequest: () => request(cookie, method), getResponse: () => ({ cookie: jest.fn() }) }), getHandler: () => method === 'GET' ? TodayOperationsFollowUpController.prototype.list : TodayOperationsFollowUpController.prototype.update, getClass: () => TodayOperationsFollowUpController } as never);
    expect(check('GET')).toBe(true); expect(check('POST')).toBe(false);
    const ticket = issueTodayOperationsFollowUpTicket({ ...scope, appId } as never, secret);
    await expect(controller.list(ticket, request(cookie))).resolves.toMatchObject({ canUpdate: false });
    paths = [];
    await expect(controller.list(ticket, request(cookie))).rejects.toThrow();
    expect(service.updateFollowUp).not.toHaveBeenCalled();
  });
});
