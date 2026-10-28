import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Optional,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { AdminOnly, ProfessionalScoped } from '../../common/access/unified-access.decorators';
import type {
  CreateInventoryMovementDeletionRequest,
  InventoryMovementCreateRequest,
  InventoryBatchAcceptanceResponse,
  InventoryOutboundMovementCreateRequest,
  InventoryOutboundConfirmRequest,
  PurchaseInboundCategoryPrepareRequest,
  PurchaseInboundConfirmRequest,
  WarehouseBuilding,
  WarehouseStorageLocationCreateRequest,
} from '../../../shared/inventory-management.interface';
import { InventoryManagementService } from './inventory-management.service';
import { InventoryInboundTaskService } from './inventory-inbound-task.service';
import type { ManualInventoryInboundTaskRequest } from './inventory-inbound-task-ledger.store';
import { InventoryMovementCommandService } from './inventory-movement-command.service';
import { InventoryMovementDeletionService } from './inventory-movement-deletion.service';
import {
  InventoryOutboundWorkflowService,
  isInventoryOutboundAcceptanceDefinitelyNotWrittenError,
} from './inventory-outbound-workflow.service';
import { InventoryWorkflowService } from './inventory-workflow.service';
import { PurchaseInboundConfirmationService } from './purchase-inbound-confirmation.service';
import { PurchaseInboundCategoryTaskService } from './purchase-inbound-category-task.service';
import { InventoryStorageLocationService } from './inventory-storage-location.service';
import { InventoryWorkflowScheduler } from './inventory-workflow.scheduler';
import { isInventoryWorkflowCode } from './inventory-workflow.rules';
import {
  isRefreshRequested,
  parseInventoryItemsQuery,
  parseInventoryMovementsQuery,
} from './inventory-management.query';
import {
  assertInventoryMovementScope,
  assertPurchaseInboundScope,
  assertStorageLocationCreateScope,
  scopeInventoryDashboard,
  scopeInventoryItemsQuery,
  scopeInventoryMovementOptionsQuery,
  scopeInventoryMovementsQuery,
  scopePendingPurchaseInbounds,
  scopeStorageLocationQuery,
} from './inventory-access-policy';
import { assertGlobalBusinessOperation } from '../../common/access/global-business-operation';
import { hasBusinessPermissionSomewhere } from '../../../shared/business-permissions';
import { PurchaseApplicationService } from '../purchase-inventory/purchase-application.service';

const PURCHASE_INBOUND_WORKFLOW_CODES = new Set([
  'purchase_h',
  'purchase_backfill',
  'purchase_abcde',
]);
const DEFINITELY_NOT_WRITTEN_DELETION_ACCEPTANCE_STATUSES = new Set([
  HttpStatus.BAD_REQUEST,
  HttpStatus.UNAUTHORIZED,
  HttpStatus.FORBIDDEN,
  HttpStatus.NOT_FOUND,
  HttpStatus.CONFLICT,
  HttpStatus.UNPROCESSABLE_ENTITY,
]);

type AccessRequest = Request & {
  accessPrincipal?: AccessPrincipal;
  accessPrincipalFingerprint?: string;
};

@Controller('api/inventory-management')
export class InventoryManagementController {
  constructor(
    private readonly service: InventoryManagementService,
    private readonly applicationService: PurchaseApplicationService,
    private readonly movementCommandService: InventoryMovementCommandService,
    private readonly purchaseInboundService: PurchaseInboundConfirmationService,
    private readonly workflowService: InventoryWorkflowService,
    private readonly workflowScheduler: InventoryWorkflowScheduler,
    private readonly storageLocationService: InventoryStorageLocationService,
    private readonly outboundWorkflowService: InventoryOutboundWorkflowService,
    private readonly movementDeletionService?: InventoryMovementDeletionService,
    @Optional()
    private readonly purchaseInboundCategoryTaskService?: PurchaseInboundCategoryTaskService,
    @Optional()
    private readonly inventoryInboundTaskService?: InventoryInboundTaskService,
  ) {}

  @ProfessionalScoped()
  @Get('dashboard')
  async getDashboard(
    @Req() request: AccessRequest,
    @Query('refresh') refresh?: string,
  ) {
    const principal = requirePrincipal(request);
    const dashboard = await this.service.getDashboard(
      isRefreshRequested(refresh),
      principal,
    );
    return scopeInventoryDashboard(principal, dashboard);
  }

  @ProfessionalScoped()
  @Get('items')
  getItems(
    @Req() request: AccessRequest,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('search') search = '',
    @Query('building') building = 'all',
    @Query('category') category = 'all',
    @Query('risk') risk = 'all',
    @Query('sort') sort = 'risk',
    @Query('refresh') refresh = 'false',
  ) {
    const principal = requirePrincipal(request);
    const parsed = parseInventoryItemsQuery({
      page,
      pageSize,
      search,
      building,
      category,
      risk,
      sort,
      refresh,
    });
    return this.service.getItems(
      scopeInventoryItemsQuery(principal, parsed.query),
      parsed.forceRefresh,
      principal,
    );
  }

  @ProfessionalScoped()
  @Get('movements')
  getMovements(
    @Req() request: AccessRequest,
    @Query('type') type = 'inbound',
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('search') search = '',
    @Query('building') building = 'all',
    @Query('status') status = 'all',
    @Query('refresh') refresh = 'false',
  ) {
    const principal = requirePrincipal(request);
    const parsed = parseInventoryMovementsQuery({
      type,
      page,
      pageSize,
      search,
      building,
      status,
      refresh,
    });
    return this.service.getMovements(
      scopeInventoryMovementsQuery(principal, parsed.query),
      parsed.forceRefresh,
      principal,
    );
  }

  @ProfessionalScoped()
  @Get('movement-options')
  getMovementOptions(
    @Req() request: AccessRequest,
    @Query('type') type = 'inbound',
    @Query('building') building = '',
    @Query('query') query = '',
    @Query('limit') limit = '30',
    @Query('refresh') refresh = '',
  ) {
    const principal = requirePrincipal(request);
    return this.movementCommandService.getOptions(
      scopeInventoryMovementOptionsQuery(principal, {
        type: type as InventoryMovementCreateRequest['type'],
        building: building as InventoryMovementCreateRequest['building'],
        query,
        limit: Number(limit),
        refresh: isRefreshRequested(refresh),
      }),
      principal,
    );
  }

  @ProfessionalScoped()
  @Get('applicant-search')
  async searchApplicants(
    @Req() request: AccessRequest,
    @Query('query') query = '',
    @Query('limit') limit = '30',
    @Query('self') self = 'false',
  ) {
    const principal = requirePrincipal(request);
    if (!hasBusinessPermissionSomewhere(principal, { module: 'inventory', action: 'create' })) {
      throw new ForbiddenException('当前账号没有办理出入库权限');
    }
    if (self === 'true') {
      return [await this.applicationService.resolveCurrentApplicant(principal, '')];
    }
    // Applicant identity is independent of the item's authorized building and specialty.
    return this.applicationService.searchApplicants({ query, limit: Number(limit) }, false);
  }

  @ProfessionalScoped()
  @Post('movements')
  @HttpCode(HttpStatus.ACCEPTED)
  createMovement(
    @Req() accessRequest: AccessRequest,
    @Body() request: InventoryMovementCreateRequest,
  ) {
    const principal = requirePrincipal(accessRequest);
    if (request?.type === 'outbound') {
      throw new BadRequestException(
        '出库申请请使用异步出库接口 /api/inventory-management/outbounds',
      );
    }
    const scopedRequest = assertInventoryMovementScope(principal, request);
    if (this.inventoryInboundTaskService) {
      return this.inventoryInboundTaskService.acceptManual(
        scopedRequest as ManualInventoryInboundTaskRequest,
        principal,
        requireAccessPrincipalFingerprint(accessRequest),
      );
    }
    if (scopedRequest.type === 'inbound' && scopedRequest.mode === 'new') {
      return this.storageLocationService
        .resolveSelectedLocation(
          scopedRequest.building,
          scopedRequest.newItem.locationRecordId,
          scopedRequest.newItem.location,
        )
        .then((location) =>
          this.movementCommandService.createMovement(
            {
              ...scopedRequest,
              newItem: {
                ...scopedRequest.newItem,
                location: location.name,
                locationRecordId: location.recordId,
              },
            },
            principal,
          ),
        );
    }
    return this.movementCommandService.createMovement(scopedRequest, principal);
  }

  @ProfessionalScoped()
  @Post('outbounds')
  @HttpCode(HttpStatus.ACCEPTED)
  async createInventoryOutbound(
    @Req() accessRequest: AccessRequest,
    @Body() request: InventoryOutboundMovementCreateRequest,
  ) {
    const principal = requirePrincipal(accessRequest);
    if (request?.type !== 'outbound') {
      throw outboundAcceptanceDefinitelyNotWritten(
        new BadRequestException('异步出库接口仅接受出库申请'),
      );
    }
    let scoped: InventoryOutboundMovementCreateRequest;
    try {
      scoped = assertInventoryMovementScope(
        principal,
        request,
      ) as InventoryOutboundMovementCreateRequest;
    } catch (error) {
      throw outboundAcceptanceDefinitelyNotWritten(error);
    }
    try {
      return await this.outboundWorkflowService.acceptPending(
        scoped,
        principal,
        requireAccessPrincipalFingerprint(accessRequest),
      );
    } catch (error) {
      if (isInventoryOutboundAcceptanceDefinitelyNotWrittenError(error)) {
        throw outboundAcceptanceDefinitelyNotWritten(error);
      }
      throw error;
    }
  }

  @ProfessionalScoped()
  @Post('outbounds/batch')
  @HttpCode(HttpStatus.ACCEPTED)
  async createInventoryOutboundsBatch(
    @Req() accessRequest: AccessRequest,
    @Body() requests: InventoryOutboundMovementCreateRequest[],
  ): Promise<InventoryBatchAcceptanceResponse> {
    assertInventoryBatch(requests);
    if (new Set(requests.map((request) => `${request.building}:${request.catalogRecordId}`)).size !== requests.length) {
      throw new BadRequestException('同一物品在同一批次中只能出现一次');
    }
    const principal = requirePrincipal(accessRequest);
    const fingerprint = requireAccessPrincipalFingerprint(accessRequest);
    const items = [];
    for (const request of requests) {
      const clientMutationId = request.clientMutationId;
      try {
        if (request.type !== 'outbound') throw new BadRequestException('仅接受出库申请');
        const scoped = assertInventoryMovementScope(principal, request) as InventoryOutboundMovementCreateRequest;
        const result = await this.outboundWorkflowService.acceptPending(scoped, principal, fingerprint);
        items.push({ clientMutationId, accepted: true, taskId: result.taskId, message: result.message });
      } catch (error) {
        if (!isDefiniteBatchRejection(error)) throw error;
        items.push({ clientMutationId, accepted: false, message: batchErrorMessage(error) });
      }
    }
    return { success: true, items };
  }

  @ProfessionalScoped()
  @Get('outbounds/tasks/:taskId')
  getInventoryOutboundTask(
    @Req() accessRequest: AccessRequest,
    @Param('taskId') taskId: string,
    @Query('building') building: string,
  ) {
    const principal = requirePrincipal(accessRequest);
    return this.outboundWorkflowService.getTaskStatus(
      taskId,
      building,
      principal,
      requireAccessPrincipalFingerprint(accessRequest),
    );
  }

  @ProfessionalScoped()
  @Post('movements/deletions')
  @HttpCode(HttpStatus.ACCEPTED)
  async createInventoryMovementDeletion(
    @Req() accessRequest: AccessRequest,
    @Body() request: CreateInventoryMovementDeletionRequest,
  ) {
    try {
      const principal = requirePrincipal(accessRequest);
      return await requireMovementDeletionService(
        this.movementDeletionService,
      ).accept(
        request,
        principal,
        requireAccessPrincipalFingerprint(accessRequest),
      );
    } catch (error) {
      if (
        error instanceof HttpException &&
        DEFINITELY_NOT_WRITTEN_DELETION_ACCEPTANCE_STATUSES.has(
          error.getStatus(),
        )
      ) {
        throw movementDeletionAcceptanceDefinitelyNotWritten(error);
      }
      throw error;
    }
  }

  @ProfessionalScoped()
  @Get('movements/deletions/tasks/:taskId')
  getInventoryMovementDeletionTask(
    @Req() accessRequest: AccessRequest,
    @Param('taskId') taskId: string,
  ) {
    const principal = requirePrincipal(accessRequest);
    return requireMovementDeletionService(
      this.movementDeletionService,
    ).getTaskStatus(
      taskId,
      principal,
      requireAccessPrincipalFingerprint(accessRequest),
    );
  }

  @ProfessionalScoped()
  @Post('outbounds/:recordId/confirm')
  confirmInventoryOutbound(
    @Req() accessRequest: AccessRequest,
    @Param('recordId') recordId: string,
    @Body() request: InventoryOutboundConfirmRequest,
  ) {
    const principal = requirePrincipal(accessRequest);
    return this.outboundWorkflowService.confirm(recordId, request, principal);
  }

  @ProfessionalScoped()
  @Get('storage-locations')
  getStorageLocations(
    @Req() request: AccessRequest,
    @Query('building') building = '',
    @Query('query') query = '',
    @Query('limit') limit = '50',
  ) {
    const principal = requirePrincipal(request);
    return this.storageLocationService.list(
      scopeStorageLocationQuery(principal, {
        building: building as WarehouseBuilding,
        query,
        limit: Number(limit),
      }),
    );
  }

  @Post('storage-locations')
  @ProfessionalScoped()
  createStorageLocation(
    @Req() request: AccessRequest,
    @Body() body: WarehouseStorageLocationCreateRequest,
  ) {
    const principal = requirePrincipal(request);
    return this.storageLocationService.create(
      assertStorageLocationCreateScope(principal, body),
    );
  }

  @ProfessionalScoped()
  @Get('purchase-inbounds/pending')
  async getPendingPurchaseInbounds(
    @Req() request: AccessRequest,
    @Query('refresh') refresh = 'false',
  ) {
    const principal = requirePrincipal(request);
    const pending = await this.purchaseInboundService.listPending(
      isRefreshRequested(refresh),
    );
    return scopePendingPurchaseInbounds(principal, pending);
  }

  @ProfessionalScoped()
  @Post('purchase-inbounds/confirm')
  @HttpCode(HttpStatus.ACCEPTED)
  async confirmPurchaseInbound(
    @Req() accessRequest: AccessRequest,
    @Body() request: PurchaseInboundConfirmRequest,
  ) {
    const principal = requirePrincipal(accessRequest);
    if (this.inventoryInboundTaskService) {
      return this.inventoryInboundTaskService.acceptPurchase(
        assertPurchaseInboundScope(principal, request),
        principal,
        requireAccessPrincipalFingerprint(accessRequest),
      );
    }
    return this.purchaseInboundService.confirm(
      assertPurchaseInboundScope(principal, request),
      principal,
    );
  }

  @ProfessionalScoped()
  @Post('purchase-inbounds/confirm-batch')
  @HttpCode(HttpStatus.ACCEPTED)
  async confirmPurchaseInboundsBatch(
    @Req() accessRequest: AccessRequest,
    @Body() requests: PurchaseInboundConfirmRequest[],
  ): Promise<InventoryBatchAcceptanceResponse> {
    assertInventoryBatch(requests);
    if (new Set(requests.map((request) => request.executionRecordId)).size !== requests.length) {
      throw new BadRequestException('同一采购记录在同一批次中只能出现一次');
    }
    const principal = requirePrincipal(accessRequest);
    const fingerprint = requireAccessPrincipalFingerprint(accessRequest);
    const taskService = requireInventoryInboundTaskService(this.inventoryInboundTaskService);
    const items = [];
    for (const request of requests) {
      const clientMutationId = request.clientMutationId ?? '';
      try {
        const scoped = assertPurchaseInboundScope(principal, request);
        const result = await taskService.acceptPurchase(scoped, principal, fingerprint);
        items.push({ clientMutationId, accepted: true, taskId: result.taskId, message: result.message });
      } catch (error) {
        if (!isDefiniteBatchRejection(error)) throw error;
        items.push({ clientMutationId, accepted: false, message: batchErrorMessage(error) });
      }
    }
    return { success: true, items };
  }

  @ProfessionalScoped()
  @Get('inbounds/tasks/:taskId')
  getInventoryInboundTask(
    @Req() accessRequest: AccessRequest,
    @Param('taskId') taskId: string,
  ) {
    const principal = requirePrincipal(accessRequest);
    return requireInventoryInboundTaskService(
      this.inventoryInboundTaskService,
    ).getTaskStatus(taskId, principal);
  }

  @ProfessionalScoped()
  @Post('purchase-inbounds/prepare-category')
  @HttpCode(HttpStatus.ACCEPTED)
  async preparePurchaseInboundCategory(
    @Req() accessRequest: AccessRequest,
    @Body() request: PurchaseInboundCategoryPrepareRequest,
  ) {
    const principal = requirePrincipal(accessRequest);
    return requirePurchaseInboundCategoryTaskService(
      this.purchaseInboundCategoryTaskService,
    ).accept(
      request,
      principal,
      requireAccessPrincipalFingerprint(accessRequest),
    );
  }

  @ProfessionalScoped()
  @Get('purchase-inbounds/category-tasks/:taskId')
  getPurchaseInboundCategoryTask(
    @Req() accessRequest: AccessRequest,
    @Param('taskId') taskId: string,
  ) {
    const principal = requirePrincipal(accessRequest);
    return requirePurchaseInboundCategoryTaskService(
      this.purchaseInboundCategoryTaskService,
    ).getTaskStatus(taskId, principal);
  }

  @ProfessionalScoped()
  @Get('workflows')
  getWorkflows() {
    return this.workflowScheduler.getStatus();
  }

  @AdminOnly()
  @Post('workflows/self-test')
  selfTestWorkflows() {
    return this.workflowService.selfTest();
  }

  @Post('workflows/:code/run')
  @ProfessionalScoped()
  runWorkflow(@Param('code') code: string, @Req() request: AccessRequest) {
    if (!isInventoryWorkflowCode(code)) {
      throw new BadRequestException('未知库存工作流代码');
    }
    if (PURCHASE_INBOUND_WORKFLOW_CODES.has(code)) {
      throw new BadRequestException('采购入库已改为库房人工确认');
    }
    assertGlobalBusinessOperation(requirePrincipal(request), { module: 'inventory', action: 'notify' });
    return this.workflowService.run(code, { trigger: 'manual' });
  }
}

function requirePrincipal(request: AccessRequest): AccessPrincipal {
  if (!request?.accessPrincipal) {
    throw new ForbiddenException('无权访问库存管理数据');
  }
  return request.accessPrincipal;
}

function requireAccessPrincipalFingerprint(request: AccessRequest): string {
  const fingerprint =
    typeof request?.accessPrincipalFingerprint === 'string'
      ? request.accessPrincipalFingerprint.trim()
      : '';
  if (
    fingerprint.length < 8 ||
    fingerprint.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(fingerprint)
  ) {
    throw new ForbiddenException('当前提交会话无法验证，请重新登录');
  }
  return fingerprint;
}

function requireMovementDeletionService(
  service: InventoryMovementDeletionService | undefined,
): InventoryMovementDeletionService {
  if (!service) {
    throw new ServiceUnavailableException('库存删除后台服务未配置');
  }
  return service;
}

function requirePurchaseInboundCategoryTaskService(
  service: PurchaseInboundCategoryTaskService | undefined,
): PurchaseInboundCategoryTaskService {
  if (!service) {
    throw new ServiceUnavailableException('物品类别号后台服务未配置');
  }
  return service;
}

function requireInventoryInboundTaskService(
  service: InventoryInboundTaskService | undefined,
): InventoryInboundTaskService {
  if (!service) {
    throw new ServiceUnavailableException('入库后台任务服务未配置');
  }
  return service;
}

function assertInventoryBatch<T extends { clientMutationId?: string }>(
  requests: T[],
): void {
  if (!Array.isArray(requests) || requests.length < 2 || requests.length > 50) {
    throw new BadRequestException('批量操作必须包含 2 至 50 项');
  }
  const ids = requests.map((request) =>
    typeof request?.clientMutationId === 'string'
      ? request.clientMutationId.trim()
      : '',
  );
  if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
    throw new BadRequestException('批量操作的每项必须有不同的客户端编号');
  }
}

function isDefiniteBatchRejection(error: unknown): boolean {
  return error instanceof HttpException && error.getStatus() >= 400 && error.getStatus() < 500;
}

function batchErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '该项未受理';
}

function outboundAcceptanceDefinitelyNotWritten(error: unknown): HttpException {
  const status =
    error instanceof HttpException
      ? error.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
  const response =
    error instanceof HttpException ? error.getResponse() : undefined;
  const payload =
    typeof response === 'object' && response !== null
      ? response
      : {
          message:
            typeof response === 'string'
              ? response
              : error instanceof Error
                ? error.message
                : '出库申请受理失败',
        };
  return new HttpException(
    {
      ...payload,
      definitelyNotWritten: true,
      writeDisposition: 'definitely-not-written',
    },
    status,
    { cause: error },
  );
}

function movementDeletionAcceptanceDefinitelyNotWritten(
  error: HttpException,
): HttpException {
  const response = error.getResponse();
  const payload =
    typeof response === 'object' && response !== null
      ? response
      : {
          message:
            typeof response === 'string'
              ? response
              : error.message || '删除申请未受理',
        };
  return new HttpException(
    {
      ...payload,
      definitelyNotWritten: true,
      writeDisposition: 'definitely-not-written',
    },
    error.getStatus(),
    { cause: error },
  );
}
