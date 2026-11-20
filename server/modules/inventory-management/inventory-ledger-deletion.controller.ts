import { Body, Controller, ForbiddenException, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { InventoryLedgerDeletionRequest } from '../../../shared/inventory-ledger-deletion.interface';
import { ProfessionalScoped } from '../../common/access/unified-access.decorators';
import { InventoryLedgerDeletionService } from './inventory-ledger-deletion.service';
type AccessRequest = Request & { accessPrincipal?: AccessPrincipal; accessPrincipalFingerprint?: string };
@Controller('api/inventory-management/ledger-deletions')
export class InventoryLedgerDeletionController {
  constructor(private readonly service: InventoryLedgerDeletionService) {}
  @ProfessionalScoped() @Post() @HttpCode(202)
  create(@Req() req: AccessRequest, @Body() body: InventoryLedgerDeletionRequest) {
    if (!req.accessPrincipal || !req.accessPrincipalFingerprint) throw new ForbiddenException('请重新登录');
    return this.service.accept(body, req.accessPrincipal, req.accessPrincipalFingerprint);
  }
  @ProfessionalScoped() @Get(':clientMutationId')
  status(@Req() req: AccessRequest, @Param('clientMutationId') id: string) {
    if (!req.accessPrincipalFingerprint) throw new ForbiddenException('请重新登录');
    return this.service.status(id, req.accessPrincipalFingerprint);
  }
}
