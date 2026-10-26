import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { MeetingService } from './meeting.service';

@Controller('api/meeting-management')
export class MeetingController {
  constructor(private readonly meetings: MeetingService) {}

  private authorize(request: Request, readOnly = false) {
    if (readOnly && (request as Request & { accessPageRead?: boolean }).accessPageRead === true) return;
    const principal = (
      request as Request & { accessPrincipal?: AccessPrincipal }
    ).accessPrincipal;
    if (principal?.role !== 'admin' && principal?.role !== 'editor' && !isProfessionalBusinessPrincipal(principal))
      throw new ForbiddenException('当前账号无会议归档访问权限');
  }

  @Get('snapshot')
  snapshot(@Req() request: Request, @Query('refresh') refresh?: string) {
    this.authorize(request, refresh !== '1');
    return this.meetings.snapshot(refresh === '1');
  }

  @Get('records/:id')
  detail(@Req() request: Request, @Param('id') id: string) {
    this.authorize(request, true);
    if (!/^(?:(?:training|ali-meeting):)?rec[A-Za-z0-9]{1,100}$/.test(id))
      throw new BadRequestException('会议记录编号无效');
    return this.meetings.detail(id);
  }
}
