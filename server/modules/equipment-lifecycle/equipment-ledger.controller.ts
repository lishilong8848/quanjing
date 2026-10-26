import { ProfessionalScoped } from '../../common/access/unified-access.decorators';
import {
  Controller,
  Get,
  Header,
  Query,
  Req,
  BadRequestException,
} from '@nestjs/common';
import type { LedgerQuery } from '../../../shared/equipment-ledger.interface';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import {
  ledgerAccessBuilding,
  scopeLedgerDashboard,
  scopeLedgerQuery,
  scopeLedgerLifecycle,
  scopedLedgerSnapshotId,
} from './equipment-ledger-access';
import { EquipmentLedgerService } from './equipment-ledger.service';
import { EquipmentHistoryService } from './equipment-history.service';
import {
  LEDGER_SYSTEMS,
  LEDGER_MANAGEMENTS,
} from '../../../shared/equipment-ledger-classification';

type LedgerRequest = Request & { accessPrincipal?: AccessPrincipal; accessPageRead?: boolean };

@Controller('api/equipment-ledger')
export class EquipmentLedgerController {
  constructor(
    private readonly service: EquipmentLedgerService,
    private readonly history: EquipmentHistoryService,
  ) {}
  @ProfessionalScoped()
  @Get('history-devices')
  @Header('Cache-Control', 'no-store')
  getHistoryDevices(
    @Req() request: LedgerRequest,
    @Query('refresh') refresh?: string,
  ) {
    const building = ledgerAccessBuilding(request.accessPrincipal, request.accessPageRead === true);
    return this.history.getDevices(building, refresh === '1', request.accessPrincipal);
  }
  @ProfessionalScoped()
  @Get('history')
  @Header('Cache-Control', 'no-store')
  async getHistory(
    @Req() request: LedgerRequest,
    @Query('assetId') assetId?: string,
    @Query('refresh') refresh?: string,
  ) {
    const building = ledgerAccessBuilding(request.accessPrincipal, request.accessPageRead === true);
    if (!assetId || assetId.length > 200)
      throw new BadRequestException('设备标识无效');
    return this.history.getState(assetId, building, refresh === '1', request.accessPrincipal);
  }
  @ProfessionalScoped()
  @Get('dashboard')
  @Header('Cache-Control', 'no-store')
  async getDashboard(
    @Req() request: LedgerRequest,
    @Query('refresh') refresh?: string,
    @Query('async') asyncRead?: string,
  ) {
    const building = ledgerAccessBuilding(request.accessPrincipal, request.accessPageRead === true);
    if (asyncRead === '1') {
      const state = await this.service.getDashboardState(refresh === '1', request.accessPrincipal);
      return {
        ...state,
        dashboard: state.dashboard
          ? scopeLedgerDashboard(state.dashboard, building)
          : null,
      };
    }
    return scopeLedgerDashboard(
      await this.service.getDashboard(refresh === '1', request.accessPrincipal),
      building,
    );
  }
  @ProfessionalScoped()
  @Get('items')
  @Header('Cache-Control', 'no-store')
  async getItems(
    @Req() request: LedgerRequest,
    @Query() raw: Record<string, string>,
  ) {
    const building = ledgerAccessBuilding(request.accessPrincipal, request.accessPageRead === true);
    if (raw.kind && raw.kind !== 'detail' && raw.kind !== 'collection')
      throw new BadRequestException('条目类型无效');
    if (raw.warranty && !['在保', '过保', '待确认'].includes(raw.warranty))
      throw new BadRequestException('维保状态无效');
    if (
      raw.system &&
      !(LEDGER_SYSTEMS as readonly string[]).includes(raw.system)
    )
      throw new BadRequestException('设备系统无效');
    if (
      raw.management &&
      !(LEDGER_MANAGEMENTS as readonly string[]).includes(raw.management)
    )
      throw new BadRequestException('楼栋分组无效');
    const query: LedgerQuery = {
      kind: raw.kind === 'collection' ? 'collection' : 'detail',
    };
    for (const key of [
      'id',
      'building',
      'category',
      'family',
      'system',
      'management',
      'model',
      'brand',
      'warranty',
      'search',
    ] as const) {
      if (raw[key]?.length > 200) throw new BadRequestException('查询条件过长');
      if (raw[key]) query[key] = raw[key];
    }
    for (const key of ['page', 'pageSize'] as const) {
      if (!raw[key]) continue;
      if (
        !/^\d+$/u.test(raw[key]) ||
        !Number.isSafeInteger(Number(raw[key])) ||
        Number(raw[key]) < 1
      )
        throw new BadRequestException('分页参数无效');
      query[key] = Number(raw[key]);
    }
    const page = await this.service.getItems(scopeLedgerQuery(query, building), request.accessPrincipal);
    return {
      ...page,
      snapshotId: scopedLedgerSnapshotId(page.snapshotId, building),
    };
  }
  @ProfessionalScoped()
  @Get('lifecycle')
  @Header('Cache-Control', 'no-store')
  async getLifecycle(@Req() request: LedgerRequest) {
    const building = ledgerAccessBuilding(request.accessPrincipal, request.accessPageRead === true);
    return scopeLedgerLifecycle(await this.service.getLifecycle(request.accessPrincipal), building);
  }

  @ProfessionalScoped()
  @Get('lifecycle-dashboard')
  @Header('Cache-Control', 'no-store')
  getLifecycleDashboard(
    @Req() request: LedgerRequest,
    @Query('building') requestedBuilding?: string,
    @Query('refresh') refresh?: string,
  ) {
    const building = ledgerAccessBuilding(request.accessPrincipal, request.accessPageRead === true);
    if (
      requestedBuilding &&
      !['A楼', 'B楼', 'C楼', 'D楼', 'E楼'].includes(requestedBuilding)
    )
      throw new BadRequestException('楼栋无效');
    const scope = scopeLedgerQuery({ building: requestedBuilding }, building);
    return this.service.getLifecycleDashboard(refresh === '1', scope.building, request.accessPrincipal);
  }
}
