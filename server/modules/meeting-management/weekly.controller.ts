import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Req,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
  Query,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type {
  GenerateWeeklyReport,
  SaveWeeklyMeeting,
  EditMeetingAction,
} from '../../../shared/weekly-workspace.interface';
import { WeeklyService } from './weekly.service';
import { FilesInterceptor } from '@nestjs/platform-express';
import type { WeeklyAttachmentCommand } from '../../../shared/weekly-workspace.interface';

@Controller('api/meeting-management/weekly')
export class WeeklyController {
  constructor(private readonly weekly: WeeklyService) {}
  private actor(request: Request, admin = false) {
    const principal = (
      request as Request & { accessPrincipal?: AccessPrincipal }
    ).accessPrincipal;
    if (
      !principal ||
      (!isProfessionalBusinessPrincipal(principal) && (admin
        ? !['admin', 'professional_admin', 'professional_engineer'].includes(principal.role)
        : !['admin', 'editor', 'professional_admin', 'professional_engineer'].includes(principal.role)))
    )
      throw new ForbiddenException('当前账号无周会操作权限');
    return principal.accountId || `role:${principal.role}`;
  }
  private read(request: Request): void {
    if ((request as Request & { accessPageRead?: boolean }).accessPageRead !== true) this.actor(request);
  }
  @Get('workspace') async snapshot(
    @Req() request: Request,
    @Query('recheck') recheck?: string,
  ) {
    if (recheck === '1') this.actor(request); else this.read(request);
    const result = await this.weekly.snapshot(recheck === '1');
    const role = (request as Request & { accessPrincipal?: AccessPrincipal }).accessPrincipal?.role;
    return (isProfessionalBusinessPrincipal((request as Request & { accessPrincipal?: AccessPrincipal }).accessPrincipal) || role && ['admin', 'editor', 'professional_admin', 'professional_engineer'].includes(role)) ? result : { ...result, jobs: [], writeAccess: { enabled: false, message: '当前角色仅可读取' } };
  }
  @Get('records/:id') formRecord(
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    this.read(request);
    return this.weekly.formRecord(id);
  }
  @Post('meetings') save(
    @Req() request: Request,
    @Body() command: SaveWeeklyMeeting,
  ) {
    return this.weekly.save(command, this.actor(request));
  }
  @Post('generate') generate(
    @Req() request: Request,
    @Body() command: GenerateWeeklyReport,
  ) {
    return this.weekly.generate(command, this.actor(request));
  }
  @Post('actions') editAction(
    @Req() request: Request,
    @Body() command: EditMeetingAction,
  ) {
    return this.weekly.editAction(command, this.actor(request));
  }
  @Post('attachments')
  @UseInterceptors(
    FilesInterceptor('images', 1, {
      limits: {
        files: 1,
        fileSize: 10 * 1024 * 1024,
        fields: 1,
        fieldSize: 2000,
      },
    }),
  )
  attachImages(
    @Req() request: Request,
    @Body('payload') payload: string,
    @UploadedFiles() files: Express.Multer.File[] = [],
  ) {
    const actor = this.actor(request);
    let command: Omit<WeeklyAttachmentCommand, 'files'>;
    try {
      command = JSON.parse(payload);
    } catch {
      throw new BadRequestException('附件提交参数无效');
    }
    return this.weekly.attachImages(command, files, actor);
  }
  @Get('jobs/:id') job(@Req() request: Request, @Param('id') id: string) {
    this.actor(request);
    return this.weekly.job(id);
  }
  @Post('jobs/:id/retry') retry(
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    const actor = this.actor(request);
    return this.weekly.retry(
      id,
      actor,
      (request as Request & { accessPrincipal?: AccessPrincipal })
        .accessPrincipal?.role === 'admin',
    );
  }
  @Post('jobs/:id/retry-notification') retryNotification(
    @Req() request: Request,
    @Param('id') id: string,
  ) {
    const actor = this.actor(request);
    return this.weekly.retryNotification(
      id,
      actor,
      (request as Request & { accessPrincipal?: AccessPrincipal })
        .accessPrincipal?.role === 'admin',
    );
  }
  @Post('jobs/:id/recover') recover(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { documentUrl: string },
  ) {
    this.actor(request, true);
    return this.weekly.recover(id, body?.documentUrl);
  }
  @Post('jobs/:id/delete') deleteTask(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { clientMutationId: string },
  ) {
    return this.weekly.deleteTask(
      id,
      body?.clientMutationId,
      this.actor(request, true),
      true,
    );
  }
  @Post('jobs/:id/restore') restoreTask(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { clientMutationId: string },
  ) {
    return this.weekly.restoreTask(
      id,
      body?.clientMutationId,
      this.actor(request, true),
      true,
    );
  }
  @Post('jobs/:id/recover-row')
  recoverRow(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { targetRecordId: string },
  ) {
    this.actor(request, true);
    return this.weekly.recoverRow(id, body?.targetRecordId);
  }
  @Post('jobs/:id/recover-image') recoverImage(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: { fileToken: string },
  ) {
    this.actor(request, true);
    return this.weekly.recoverImage(id, body?.fileToken);
  }
}
