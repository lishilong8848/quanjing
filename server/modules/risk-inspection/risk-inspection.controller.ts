import { ProfessionalScoped } from '../../common/access/unified-access.decorators';
import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Query, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import {
  type RiskInspectionAliMonthlyQualityQuery,
  type RiskInspectionAliQuery,
  type RiskInspectionCrossGuideQuery,
  type RiskInspectionCrossQuery,
  RiskInspectionService,
} from './risk-inspection.service';

@Controller('api/risk-inspection')
export class RiskInspectionController {
  constructor(private readonly service: RiskInspectionService) {}

  @ProfessionalScoped()
  @Get('monthly-alarm-overview')
  getMonthlyAlarmOverview(@Query('refresh') refresh?: string, @Req() request?: { accessPrincipal?: AccessPrincipal }) {
    return this.service.getMonthlyAlarmOverview(refresh === '1', request?.accessPrincipal);
  }

  @ProfessionalScoped()
  @Get('monthly-alarm-overview/evidence/:recordId/:index')
  async getMonthlyAlarmEvidence(
    @Param('recordId') recordId: string,
    @Param('index') index: string,
    @Res() response: Response,
    @Req() request?: { accessPrincipal?: AccessPrincipal },
  ) {
    const evidence = await this.service.getMonthlyAlarmEvidence(
      recordId,
      index,
      request?.accessPrincipal,
    );
    response.setHeader('Content-Type', evidence.contentType);
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('Vary', 'Cookie');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(evidence.fileName)}`,
    );
    response.send(evidence.buffer);
  }

  @ProfessionalScoped()
  @Get('ali')
  getAliDashboard(@Query() query: RiskInspectionAliQuery, @Req() request?: { accessPrincipal?: AccessPrincipal }) {
    return this.service.getAliDashboard(query, request?.accessPrincipal);
  }

  @ProfessionalScoped()
  @Get('ali-monthly-quality')
  getAliMonthlyQuality(@Query() query: RiskInspectionAliMonthlyQualityQuery, @Req() request?: { accessPrincipal?: AccessPrincipal }) {
    return this.service.getAliMonthlyQuality(query, request?.accessPrincipal);
  }

  @ProfessionalScoped()
  @Patch('ali-monthly-quality/issues/:recordId/supplemental')
  @HttpCode(HttpStatus.ACCEPTED)
  updateAliMonthlyQualitySupplemental(
    @Param('recordId') recordId: string,
    @Body() body: {
      supplemental?: unknown;
      expectedSupplemental?: unknown;
      clientMutationId?: unknown;
    },
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
  ) {
    return this.service.acceptAliMonthlyQualitySupplemental(
      recordId,
      body,
      request.accessPrincipal,
    );
  }

  @ProfessionalScoped()
  @Get('ali-monthly-quality/supplemental-tasks/:taskId')
  getAliMonthlyQualitySupplementalTask(
    @Param('taskId') taskId: string,
    @Req() request: Request & { accessPrincipal?: AccessPrincipal },
  ) {
    return this.service.getAliMonthlyQualitySupplementalTask(taskId, request.accessPrincipal);
  }

  @ProfessionalScoped()
  @Get('ali-monthly-quality/evidence/:recordId/:kind/:index')
  async getAliMonthlyQualityEvidence(
    @Param('recordId') recordId: string,
    @Param('kind') kind: string,
    @Param('index') index: string,
    @Res() response: Response,
    @Req() request?: { accessPrincipal?: AccessPrincipal },
  ) {
    const evidence = await this.service.getAliMonthlyQualityEvidence(
      recordId,
      kind,
      index,
      request?.accessPrincipal,
    );
    const disposition = evidence.contentType.startsWith('image/')
      ? 'inline'
      : 'attachment';
    response.setHeader('Content-Type', evidence.contentType);
    response.setHeader('Cache-Control', 'private, max-age=300');
    response.setHeader('Vary', 'Cookie');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader(
      'Content-Disposition',
      `${disposition}; filename*=UTF-8''${encodeURIComponent(evidence.fileName)}`,
    );
    response.send(evidence.buffer);
  }

  @ProfessionalScoped()
  @Get('cross')
  getCrossDashboard(@Query() query: RiskInspectionCrossQuery, @Req() request?: { accessPrincipal?: AccessPrincipal }) {
    return this.service.getCrossDashboard(query, request?.accessPrincipal);
  }

  @ProfessionalScoped()
  @Get('cross/guides')
  getCrossGuides(@Query() query: RiskInspectionCrossGuideQuery) {
    return this.service.getCrossGuides(query);
  }
}
