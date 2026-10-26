import { Controller, Get, Header, Query, Req } from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { ProfessionalScoped } from '../../common/access/unified-access.decorators';
import { EquipmentLifecycleService } from './equipment-lifecycle.service';

@Controller('api/equipment-lifecycle')
export class EquipmentLifecycleController {
  constructor(private readonly service: EquipmentLifecycleService) {}

  @Get('dashboard')
  @ProfessionalScoped()
  @Header(
    'Cache-Control',
    'no-store, no-cache, must-revalidate, proxy-revalidate',
  )
  getDashboard(
    @Query('refresh') refresh?: string,
    @Query('forceRefresh') forceRefresh?: string,
    @Req() request?: { accessPrincipal?: AccessPrincipal },
  ) {
    return this.service.getDashboard(
      isForceRefresh(refresh) || isForceRefresh(forceRefresh),
      undefined,
      request?.accessPrincipal,
    );
  }
}

function isForceRefresh(value: string | undefined): boolean {
  return value === '1' || value?.toLowerCase() === 'true';
}
