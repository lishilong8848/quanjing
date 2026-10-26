import { ProfessionalScoped } from '../../common/access/unified-access.decorators';
import { Controller, Get, Query, Req, Header } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { OperationsToolsService } from './operations-tools.service';
import {
  assertToolsPrincipal,
  scopeToolsSnapshot,
} from './operations-tools.mapper';

@Controller('api/operations-tools')
export class OperationsToolsController {
  constructor(private readonly service: OperationsToolsService) {}

  @ProfessionalScoped()
  @Get('snapshot')
  @Header('Cache-Control', 'private, no-store')
  async snapshot(
    @Req() request: Request & { accessPrincipal?: AccessPrincipal; accessPageRead?: boolean },
    @Query('refresh') refresh?: string,
  ) {
    assertToolsPrincipal(request.accessPrincipal, request.accessPageRead === true);
    return scopeToolsSnapshot(
      request.accessPrincipal!,
      await this.service.getSnapshot(refresh === '1'),
      request.accessPageRead === true,
    );
  }
}
