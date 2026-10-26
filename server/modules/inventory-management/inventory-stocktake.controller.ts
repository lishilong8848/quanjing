import { ProfessionalScoped } from '../../common/access/unified-access.decorators';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  Optional,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import type { WarehouseBuilding } from '../../../shared/inventory-management.interface';
import type {
  StocktakeCompleteRequest,
  StocktakeGenerationRequest,
  StocktakeLineRequest,
  StocktakeWriteRequest,
  StocktakeScope,
  StocktakeBulkRequest,
  StocktakeUndoRequest,
} from '../../../shared/inventory-stocktake.interface';
import { InventoryStocktakeService } from './inventory-stocktake.service';
import { InventoryStocktakeGenerationService } from './inventory-stocktake-generation.service';
import { InventoryStocktakeResultsSync } from './inventory-stocktake-results.sync';
import { InventoryStocktakeBulkService } from './inventory-stocktake-bulk.service';
type StocktakeRequest = Request & {
  accessPrincipal?: AccessPrincipal;
  accessPrincipalFingerprint?: string;
};
function identity(req: StocktakeRequest) {
  if (!req.accessPrincipal || !req.accessPrincipalFingerprint)
    throw new ForbiddenException('请重新登录');
  return {
    principal: req.accessPrincipal,
    actor: req.accessPrincipalFingerprint,
  };
}

@Controller('api/inventory-management/stocktake')
export class InventoryStocktakeController {
  constructor(
    private readonly service: InventoryStocktakeService,
    private readonly generation: InventoryStocktakeGenerationService,
    @Optional() private readonly sync?: InventoryStocktakeResultsSync,
    private readonly bulk?: InventoryStocktakeBulkService,
  ) {}
  @ProfessionalScoped()
  @Get('overview') overview(
    @Req() req: StocktakeRequest,
    @Query('month') month: string,
  ) {
    const principal = identity(req).principal;
    return {
      ...this.service.overview(month, principal),
      generation: this.generation.status(month, principal),
    };
  }
  @ProfessionalScoped()
  @Post('generate') @HttpCode(202) generate(
    @Req() req: StocktakeRequest,
    @Body() body: StocktakeGenerationRequest,
  ) {
    const { principal, actor } = identity(req);
    return this.generation.request(body, principal, actor);
  }
  @ProfessionalScoped()
  @Get('sheet') sheet(
    @Req() req: StocktakeRequest,
    @Query('month') month: string,
    @Query('building') building: WarehouseBuilding,
    @Query('scope') scope?: StocktakeScope,
  ) {
    return this.service.get(month, building, identity(req).principal, scope);
  }
  @ProfessionalScoped()
  @Post('start') start(
    @Req() req: StocktakeRequest,
    @Body() body: StocktakeWriteRequest,
  ) {
    const { principal, actor } = identity(req);
    return this.service.start(body, principal, actor);
  }
  @ProfessionalScoped()
  @Post('draft') draft(
    @Req() req: StocktakeRequest,
    @Body() body: StocktakeLineRequest,
  ) {
    const { principal, actor } = identity(req);
    return this.service.writeLine(body, principal, actor, 'draft');
  }
  @ProfessionalScoped()
  @Post('confirm') confirm(
    @Req() req: StocktakeRequest,
    @Body() body: StocktakeLineRequest,
  ) {
    const { principal, actor } = identity(req);
    return this.service.writeLine(body, principal, actor, 'confirm');
  }
  @ProfessionalScoped()
  @Post('refresh-line') refresh(
    @Req() req: StocktakeRequest,
    @Body() body: StocktakeLineRequest,
  ) {
    const { principal, actor } = identity(req);
    return this.service.writeLine(body, principal, actor, 'refresh');
  }
  @ProfessionalScoped()
  @Post('complete') complete(
    @Req() req: StocktakeRequest,
    @Body() body: StocktakeCompleteRequest,
  ) {
    const { principal, actor } = identity(req);
    return this.service.complete(body, principal, actor);
  }
  @ProfessionalScoped()
  @Post('bulk-confirm') @HttpCode(202) bulkConfirm(
    @Req() req: StocktakeRequest,
    @Body() body: StocktakeBulkRequest,
  ) {
    const { principal, actor } = identity(req);
    if (!this.bulk) throw new Error('批量盘点服务不可用');
    return this.bulk.request(body, principal, actor);
  }
  @ProfessionalScoped()
  @Get('bulk-status') bulkStatus(
    @Req() req: StocktakeRequest,
    @Query('month') month: string,
    @Query('building') building: WarehouseBuilding,
    @Query('id') id: string,
  ) {
    if (!this.bulk) throw new Error('批量盘点服务不可用');
    return this.bulk.status(month, building, id, identity(req).principal);
  }
  @ProfessionalScoped()
  @Post('bulk-undo') bulkUndo(
    @Req() req: StocktakeRequest,
    @Body() body: StocktakeUndoRequest,
  ) {
    const { principal, actor } = identity(req);
    return this.service.undoReview(body, principal, actor);
  }
  @ProfessionalScoped()
  @Get('sync-status') syncStatus(
    @Req() req: StocktakeRequest,
    @Query('month') month: string,
    @Query('building') building: WarehouseBuilding,
    @Query('scope') scope: StocktakeScope = 'sample',
  ) {
    this.service.get(month, building, identity(req).principal, scope);
    if (!this.sync) throw new Error('盘点同步服务不可用');
    return this.sync.summary(month, building, scope, identity(req).principal);
  }
  @ProfessionalScoped()
  @Post('retry-sync') @HttpCode(202) retrySync(
    @Req() req: StocktakeRequest,
    @Body() body: StocktakeWriteRequest,
  ) {
    const { principal, actor } = identity(req);
    return this.service.retrySync(body, principal, actor, this.sync);
  }
}
