import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { WarehouseBuilding } from '../../../shared/inventory-management.interface';
import { WAREHOUSE_BUILDINGS } from '../../../shared/inventory-management.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  fetchBitableRecords,
  resolveBitableAppToken,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import type { InventoryOutboundApprovalApprover } from './inventory-outbound-approval.types';
import { readConfiguredCardMembers } from '../../common/access/access-configuration.service';

export const INVENTORY_WAREHOUSE_ROLE_READER = Symbol(
  'INVENTORY_WAREHOUSE_ROLE_READER',
);
export const INVENTORY_WAREHOUSE_ROLE_CLOCK = Symbol(
  'INVENTORY_WAREHOUSE_ROLE_CLOCK',
);
export const INVENTORY_WAREHOUSE_ROLE_CACHE_TTL_MS = Symbol(
  'INVENTORY_WAREHOUSE_ROLE_CACHE_TTL_MS',
);
export const INVENTORY_WAREHOUSE_ROLE_MAX_STALE_MS = Symbol(
  'INVENTORY_WAREHOUSE_ROLE_MAX_STALE_MS',
);

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MAXIMUM_STALE_MS = 30 * 60_000;
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9_-]{1,124}$/u;

export type InventoryWarehouseRoleReader = (
  httpService: HttpService,
) => Promise<BitableRecordItem[]>;

interface WarehouseRoleCache {
  records: WarehouseRoleRecord[];
  expiresAt: number;
  staleUntil: number;
}

interface WarehouseRoleRecord {
  buildings: string[];
  responsibleUsers: InventoryOutboundApprovalApprover[];
  managerUsers: InventoryOutboundApprovalApprover[];
}

export class InventoryWarehouseApproversNotConfiguredError extends ServiceUnavailableException {
  constructor(building: WarehouseBuilding) {
    super(`${building}未配置有效的库房示例人员019员`);
  }
}

@Injectable()
export class InventoryWarehouseRoleDirectory {
  private cache: WarehouseRoleCache | null = null;
  private refreshPromise: Promise<WarehouseRoleRecord[]> | null = null;

  constructor(
    private readonly httpService: HttpService,
    @Optional()
    @Inject(INVENTORY_WAREHOUSE_ROLE_READER)
    private readonly reader: InventoryWarehouseRoleReader = readWarehouseRoleRecords,
    @Optional()
    @Inject(INVENTORY_WAREHOUSE_ROLE_CLOCK)
    private readonly now: () => number = Date.now,
    @Optional()
    @Inject(INVENTORY_WAREHOUSE_ROLE_CACHE_TTL_MS)
    private readonly cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
    @Optional()
    @Inject(INVENTORY_WAREHOUSE_ROLE_MAX_STALE_MS)
    private readonly maximumStaleMs: number = DEFAULT_MAXIMUM_STALE_MS,
  ) {}

  async resolveApprovers(
    buildingValue: string,
    forceRefresh = false,
  ): Promise<InventoryOutboundApprovalApprover[]> {
    const configured = readConfiguredCardMembers('warehouse_responsible', requireBuilding(buildingValue));
    if (configured) return configured;
    const { building, records } = await this.resolveRecords(
      buildingValue,
      forceRefresh,
    );
    return resolveApproversFromRecords(records, building);
  }

  async resolveNotificationRecipients(
    buildingValue: string,
    forceRefresh = false,
  ): Promise<InventoryOutboundApprovalApprover[]> {
    const configured = readConfiguredCardMembers('warehouse_notify', requireBuilding(buildingValue));
    if (configured) return configured;
    const { building, records } = await this.resolveRecords(
      buildingValue,
      forceRefresh,
    );
    return resolveNotificationRecipientsFromRecords(records, building);
  }

  private async resolveRecords(
    buildingValue: string,
    forceRefresh: boolean,
  ): Promise<{
    building: WarehouseBuilding;
    records: WarehouseRoleRecord[];
  }> {
    const building = requireBuilding(buildingValue);
    const current = this.now();
    let records: WarehouseRoleRecord[];

    if (!forceRefresh && this.cache && this.cache.expiresAt > current) {
      records = clone(this.cache.records);
    } else if (!forceRefresh && this.cache && this.cache.staleUntil > current) {
      records = clone(this.cache.records);
      void this.refresh().catch(() => undefined);
    } else if (!forceRefresh && this.cache) {
      void this.refresh().catch(() => undefined);
      throw new ServiceUnavailableException(
        `${building}库房示例人员019员权限缓存已过期，正在后台刷新，请重试`,
      );
    } else {
      records = await this.refresh();
    }

    return { building, records };
  }

  peekApprovers(
    buildingValue: string,
  ): InventoryOutboundApprovalApprover[] | null {
    const building = requireBuilding(buildingValue);
    const configured = readConfiguredCardMembers('warehouse_responsible', building);
    if (configured) return configured;
    if (this.cache && this.cache.staleUntil <= this.now()) {
      void this.refresh().catch(() => undefined);
      return null;
    }
    return this.cache
      ? resolveApproversFromRecords(this.cache.records, building)
      : null;
  }

  private async refresh(): Promise<WarehouseRoleRecord[]> {
    if (this.refreshPromise) return clone(await this.refreshPromise);
    const promise = this.reader(this.httpService).then((records) => {
      const snapshot = normalizeRecords(records);
      const refreshedAt = this.now();
      const expiresAt = refreshedAt + positiveCacheTtl(this.cacheTtlMs);
      this.cache = {
        records: snapshot,
        expiresAt,
        staleUntil: expiresAt + positiveMaximumStale(this.maximumStaleMs),
      };
      return snapshot;
    });
    this.refreshPromise = promise;
    try {
      return clone(await promise);
    } finally {
      if (this.refreshPromise === promise) this.refreshPromise = null;
    }
  }
}

export async function readWarehouseRoleRecords(
  httpService: HttpService,
): Promise<BitableRecordItem[]> {
  const managerSourceUrl = readEnv('FEISHU_WAREHOUSE_MANAGER_SOURCE_URL');
  const managerSource = parseFeishuBitableLink(managerSourceUrl);
  const managerAppToken =
    readEnv('FEISHU_WAREHOUSE_MANAGER_APP_TOKEN') || managerSource.appToken;
  const managerWikiToken =
    readEnv('FEISHU_WAREHOUSE_MANAGER_WIKI_TOKEN') || managerSource.wikiToken;
  const usesDedicatedManagerSource = Boolean(
    managerSourceUrl || managerAppToken || managerWikiToken,
  );
  const warehouseSource = parseFeishuBitableLink(
    readEnv('FEISHU_WAREHOUSE_SOURCE_URL'),
  );
  const tableId =
    readEnv('FEISHU_WAREHOUSE_MANAGER_TABLE_ID') || managerSource.tableId;
  const viewId =
    readEnv('FEISHU_WAREHOUSE_MANAGER_VIEW_ID') || managerSource.viewId;
  if (!tableId) {
    throw new ServiceUnavailableException('库存楼栋管理员 Base 配置缺失');
  }
  const appToken = await resolveBitableAppToken(httpService, {
    appToken: usesDedicatedManagerSource
      ? managerAppToken
      : readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || warehouseSource.appToken,
    wikiToken: usesDedicatedManagerSource
      ? managerWikiToken
      : warehouseSource.wikiToken,
    tableName: '库存楼栋管理员',
  });
  if (!appToken) {
    throw new ServiceUnavailableException('库存楼栋管理员 Base 配置缺失');
  }
  return fetchBitableRecords(httpService, {
    appToken,
    tableId,
    ...(viewId ? { viewId } : {}),
    tableName: '库存楼栋管理员',
    automaticFields: true,
    fieldNames: ['楼栋', '库房示例人员019员', '库房管理人'],
    cacheTtlMs: 0,
    forceRefresh: true,
    allowStale: false,
    strict: true,
  });
}

function resolveApproversFromRecords(
  records: WarehouseRoleRecord[],
  building: WarehouseBuilding,
): InventoryOutboundApprovalApprover[] {
  const users = new Map<string, InventoryOutboundApprovalApprover>();
  for (const record of records) {
    const matchesBuilding = record.buildings.some(
      (candidate) =>
        normalizeBuilding(candidate) === normalizeBuilding(building),
    );
    if (!matchesBuilding) continue;
    for (const candidate of record.responsibleUsers) {
      const previous = users.get(candidate.openId);
      users.set(candidate.openId, {
        openId: candidate.openId,
        name: previous?.name || candidate.name || '库房示例人员019员',
      });
    }
  }
  if (!users.size) {
    throw new InventoryWarehouseApproversNotConfiguredError(building);
  }
  return clone([...users.values()]);
}

function resolveNotificationRecipientsFromRecords(
  records: WarehouseRoleRecord[],
  building: WarehouseBuilding,
): InventoryOutboundApprovalApprover[] {
  const users = new Map<string, InventoryOutboundApprovalApprover>();
  for (const record of records) {
    const matchesBuilding = record.buildings.some(
      (candidate) =>
        normalizeBuilding(candidate) === normalizeBuilding(building),
    );
    if (!matchesBuilding) continue;
    for (const candidate of record.managerUsers) {
      const previous = users.get(candidate.openId);
      users.set(candidate.openId, {
        openId: candidate.openId,
        name: previous?.name || candidate.name || '库房管理人',
      });
    }
  }
  return clone([...users.values()]);
}

function requireBuilding(value: unknown): WarehouseBuilding {
  const normalized = normalizeBuilding(value);
  const building = WAREHOUSE_BUILDINGS.find(
    (candidate) => normalizeBuilding(candidate) === normalized,
  );
  if (!normalized || !building) {
    throw new BadRequestException('出库申请楼栋无效');
  }
  return building;
}

function normalizeBuilding(value: unknown): string {
  return clean(value)
    .normalize('NFC')
    .replace(/[楼栋]$/u, '')
    .toUpperCase();
}

function warehouseRecordBuildings(fields: Record<string, unknown>): string[] {
  for (const fieldName of ['楼栋', '楼栋/专业', '机楼']) {
    const values = unique(extractDisplayValues(fields[fieldName]).map(clean));
    if (values.length) return values;
  }
  return [];
}

function extractDisplayValues(value: unknown): string[] {
  const values: string[] = [];
  const stack: unknown[] = [value];
  const visited = new WeakSet<object>();
  while (stack.length) {
    const current = stack.shift();
    if (typeof current === 'string' || typeof current === 'number') {
      const normalized = clean(String(current));
      if (normalized) values.push(normalized);
      continue;
    }
    if (!current || typeof current !== 'object' || visited.has(current))
      continue;
    visited.add(current);
    if (Array.isArray(current)) {
      stack.unshift(...current);
      continue;
    }
    const item = current as Record<string, unknown>;
    for (const key of ['text', 'name', 'value']) {
      if (Object.prototype.hasOwnProperty.call(item, key))
        stack.unshift(item[key]);
    }
  }
  return unique(values);
}

function extractUsers(value: unknown): InventoryOutboundApprovalApprover[] {
  const stack: unknown[] = [value];
  const users = new Map<string, InventoryOutboundApprovalApprover>();
  const visited = new WeakSet<object>();
  while (stack.length) {
    const current = stack.shift();
    if (!current || typeof current !== 'object' || visited.has(current))
      continue;
    visited.add(current);
    if (Array.isArray(current)) {
      stack.unshift(...current);
      continue;
    }
    const item = current as Record<string, unknown>;
    const openId = clean(item.id || item.open_id || item.openId);
    if (OPEN_ID_PATTERN.test(openId)) {
      const previous = users.get(openId);
      users.set(openId, {
        openId,
        name: previous?.name || clean(item.name || item.text),
      });
    }
    stack.unshift(...Object.values(item));
  }
  return [...users.values()];
}

function normalizeRecords(records: BitableRecordItem[]): WarehouseRoleRecord[] {
  if (!Array.isArray(records)) {
    throw new ServiceUnavailableException('库存楼栋管理员 Base 响应无效');
  }
  return records.map((record) => {
    const fields = isPlainObject(record.fields) ? record.fields : {};
    return {
      buildings: warehouseRecordBuildings(fields),
      responsibleUsers: extractUsers(fields['库房示例人员019员']),
      managerUsers: extractUsers(fields['库房管理人']),
    };
  });
}

function positiveCacheTtl(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_CACHE_TTL_MS;
}

function positiveMaximumStale(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : DEFAULT_MAXIMUM_STALE_MS;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
