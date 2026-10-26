import { Controller, Get, Query, Req } from '@nestjs/common';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { ProfessionalScoped } from '../../common/access/unified-access.decorators';
import {
  EquipmentPatrolExecutionService,
  type EquipmentPatrolExecutionQuery,
} from './equipment-patrol-execution.service';

@Controller('api/equipment-patrol')
export class EquipmentPatrolExecutionController {
  constructor(private readonly service: EquipmentPatrolExecutionService) {}

  @Get('executions')
  @ProfessionalScoped()
  getExecutions(@Query() query: EquipmentPatrolExecutionQuery, @Req() request?: { accessPrincipal?: AccessPrincipal }) {
    return this.service.getExecutions(query, request?.accessPrincipal);
  }
}
