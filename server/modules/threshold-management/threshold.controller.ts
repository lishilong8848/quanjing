import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Post,
  Query,
  BadRequestException,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { ThresholdCommand } from '../../../shared/threshold-management.interface';
import { ThresholdStore } from './threshold.store';
import { ThresholdSyncService } from './threshold-sync.service';
import { Optional } from '@nestjs/common';
import { ThresholdAdjustmentService } from './threshold-adjustment.service';
import type { ThresholdAdjustmentInput } from '../../../shared/threshold-adjustment.interface';
import { filterProfessionalRecords } from '../../common/access/professional-record-scope';
import { accessBuildings, canAccessBuilding } from '../../../shared/building-access';
import { ProfessionalScoped } from '../../common/access/unified-access.decorators';

@Controller('api/threshold-management')
export class ThresholdController {
  constructor(
    private readonly store: ThresholdStore,
    private readonly sync?: ThresholdSyncService,
    @Optional() private readonly adjustments?: ThresholdAdjustmentService,
  ) {}
  private actor(request: Request & { accessPrincipal?: AccessPrincipal }) {
    const principal = request.accessPrincipal;
    if (!principal || (!['admin', 'editor', 'professional_admin', 'professional_engineer'].includes(principal.role) && !isProfessionalBusinessPrincipal(principal)))
      throw new ForbiddenException('当前账号无阈值管理权限');
    return `${principal.role}:${principal.accountId || request['accessPrincipalFingerprint'] || 'unrestricted'}`;
  }
  private read(request: Request & { accessPrincipal?: AccessPrincipal }): void {
    if (request['accessPageRead'] !== true) this.actor(request);
  }
  @Get('records')
  @ProfessionalScoped()
  list(
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
    @Query('force') force?: string,
  ) {
    this.read(request);
    if (force === 'true') this.actor(request);
    this.sync?.refreshSource(force === 'true');
    const snapshot = this.store.list();
    return {
      ...snapshot,
      records: filterProfessionalRecords(request.accessPrincipal, snapshot.records, record => record.profession).filter(record => !request.accessPrincipal || accessBuildings(request.accessPrincipal) === null || canAccessBuilding(request.accessPrincipal, record.building)),
      ...(this.sync ? { sourceSync: this.sync.sourceStatus() } : {}),
    };
  }
  @Post('mutations')
  mutate(
    @Body() body: ThresholdCommand,
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
  ) {
    this.actor(request);
    throw new ForbiddenException(
      '阈值变更必须提交调整申请并通过楼长和专业主管审批',
    );
  }
  @Get('adjustments/context')
  @ProfessionalScoped()
  adjustmentContext(
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
  ) {
    this.actor(request);
    if (!this.adjustments) throw new BadRequestException('阈值审批服务未接入');
    return this.adjustments.context(request.accessPrincipal!);
  }
  @Get('adjustments')
  @ProfessionalScoped()
  adjustmentList(
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
  ) {
    this.read(request);
    return this.adjustments?.list(request.accessPrincipal!) || [];
  }
  @Post('adjustments')
  @ProfessionalScoped()
  submitAdjustment(
    @Body() body: ThresholdAdjustmentInput,
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
  ) {
    this.actor(request);
    if (!this.adjustments) throw new BadRequestException('阈值审批服务未接入');
    return this.adjustments.submit(body, request.accessPrincipal!);
  }
  @Post('adjustments/retry')
  @ProfessionalScoped()
  retryAdjustment(
    @Body() body: { id: string },
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
  ) {
    this.actor(request);
    if (!this.adjustments || !/^ta-[a-f0-9-]{36}$/.test(body?.id || ''))
      throw new BadRequestException('审批申请标识无效');
    return this.adjustments.retry(body.id, request.accessPrincipal!);
  }
  @Get('sync')
  status(
    @Query('ids') ids: string,
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
  ) {
    this.actor(request);
    const values = (ids || '').split(',');
    if (
      !values.length ||
      values.length > 100 ||
      values.some((id) => !/^[a-zA-Z0-9_-]{8,160}$/.test(id))
    )
      throw new BadRequestException('同步任务标识无效');
    return this.store.syncResults(values);
  }
  @ProfessionalScoped()
  @Get('sync/source')
  sourceStatus(
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
  ) {
    this.read(request);
    if (request['accessPageRead'] !== true) this.sync?.refreshSource();
    return {
      sourceSync: this.sync?.sourceStatus(),
      revision: this.store.list().revision,
    };
  }
  @Post('sync/retry')
  retry(
    @Body() body: { clientMutationId: string },
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
  ) {
    const actor = this.actor(request);
    if (
      typeof body?.clientMutationId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,160}$/.test(body.clientMutationId)
    )
      throw new BadRequestException('同步任务标识无效');
    const result = this.store.retrySync(body.clientMutationId, actor);
    this.sync?.kick();
    return result;
  }
  @Post('sync/accept-cloud')
  acceptCloud(
    @Body() body: { clientMutationId: string },
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
  ) {
    const actor = this.actor(request);
    if (
      typeof body?.clientMutationId !== 'string' ||
      !/^[a-zA-Z0-9_-]{8,160}$/.test(body.clientMutationId)
    )
      throw new BadRequestException('同步任务标识无效');
    if (!this.sync) throw new BadRequestException('未接入云端同步');
    return this.sync.acceptCloud(body.clientMutationId, actor);
  }
}
