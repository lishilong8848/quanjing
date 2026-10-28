import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { GuestReadable, PublicAccess } from '../../common/access/unified-access.decorators';
import { UnifiedAccessService } from '../../common/access/unified-access.service';
import { readAccessCookie } from '../../common/access/unified-access.guard';
import { hasBusinessPermissionSomewhere, personalPermissionPagePaths } from '../../../shared/business-permissions';
import { TodayOperationsAnomalyService } from './today-operations-anomaly.service';
import { renderTodayOperationsFollowUpPage } from './today-operations-follow-up.page';
import { TodayOperationsFollowUpTicketService } from './today-operations-follow-up.ticket';
import type { TodayOperationsFollowUpUpdate } from './today-operations-anomaly.types';

@Controller('')
export class TodayOperationsFollowUpController {
  constructor(
    private readonly tickets: TodayOperationsFollowUpTicketService,
    private readonly service: TodayOperationsAnomalyService,
    private readonly access: UnifiedAccessService,
  ) {}

  @PublicAccess()
  @Get('attendance-anomaly-follow-up')
  page(
    @Query('ticket') ticket: string,
    @Res({ passthrough: true }) response?: Response,
  ): string {
    this.tickets.verify(ticket);
    response?.setHeader('Cache-Control', 'no-store');
    response?.type('html');
    return renderTodayOperationsFollowUpPage({ ticket });
  }

  @GuestReadable()
  @Get('api/duty-schedules/daily-operations-follow-ups')
  async list(@Headers('x-follow-up-ticket') ticket: string, @Req() request: Request) {
    const scope = this.tickets.verify(ticket);
    const session = this.requireCurrentSession(request,'read');
    return {
      success: true as const,
      canUpdate: session.principal.effectiveAuthorization ? hasBusinessPermissionSomewhere(session.principal,{module:'today_operations',action:'update'}) : session.principal.role === 'admin' || session.principal.role === 'editor',
      actorKey: session.principal.accountId || session.principalFingerprint!,
      records: await this.service.listFollowUps(scope.from, scope.through),
    };
  }

  @Post('api/duty-schedules/daily-operations-follow-ups')
  async update(
    @Headers('x-follow-up-ticket') ticket: string,
    @Body() body: TodayOperationsFollowUpUpdate,
    @Req() request: Request,
  ) {
    const scope = this.tickets.verify(ticket);
    const session = this.requireCurrentSession(request,'update');
    // This route's existing unified guard permits writes only to these roles.
    if (!(session.principal.effectiveAuthorization ? hasBusinessPermissionSomewhere(session.principal,{module:'today_operations',action:'update'}) : ['admin', 'editor'].includes(session.principal.role))) throw new ForbiddenException('当前账号仅可查看，暂无处理权限');
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new BadRequestException('异常跟进请求无效');
    }
    const record = await this.service.updateFollowUp({ ...body, handlerName: session.principal.displayName || '平台账号' }, {
      from: scope.from,
      through: scope.through,
    });
    return { success: true as const, record };
  }

  private requireCurrentSession(request: Request, action:'read'|'update') {
    const cookie = readAccessCookie(request?.headers?.cookie, this.access);
    const session = this.access.readSessionIdentity(cookie.value);
    if (!session.principalFingerprint || !session.expiresAt) throw new UnauthorizedException('请先登录后查看异常跟进');
    const principal = session.principal;
    if (principal.effectiveAuthorization) {
      if(!hasBusinessPermissionSomewhere(principal,{module:'today_operations',action})) throw new ForbiddenException('当前账号暂无异常跟进权限');
      return session;
    }
    if (principal.role === 'guest') throw new ForbiddenException('当前账号暂无异常跟进权限');
    const inherited = this.access.pagePermissions(principal.role, principal.accountId, principal.authorizationVersion);
    const paths = personalPermissionPagePaths(principal, inherited.paths);
    if (principal.role !== 'admin' && !paths.some(path => ['/monthly-schedule', '/today-operations-panorama'].includes(path))) throw new ForbiddenException('当前账号暂无异常跟进权限');
    return session;
  }
}
