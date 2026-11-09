import { isProfessionalBusinessPrincipal } from '../../../shared/business-permissions';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { assertProfessionalRecordScope } from '../../common/access/professional-record-scope';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  InventoryManagementItem,
  InventorySourceKey,
  WarehouseBuilding,
} from '../../../shared/inventory-management.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import { getWarehouseInventoryLocationReadFieldNames } from '../../common/config/warehouse-inventory-location.config';
import {
  extractDisplayText,
  extractNumberValue,
  fetchBitableRecords,
  pickField,
  resolveBitableAppToken,
  type BitableRecordItem,
  type BitableRecordSearchFilter,
} from '../../common/feishu/bitable-direct-read';
import { buildInventoryManagementSnapshot } from './inventory-management.mapper';
import {
  offsetStocktakeMonth,
  stocktakeMonth,
  validateStocktakeMonth,
} from './inventory-stocktake.rules';
import { InventoryWorkflowGateway } from './inventory-workflow.gateway';

const SNAPSHOT_TIMEOUT_MS = 180_000;

function stocktakeMovementFilter(
  field: string,
  month: string,
): BitableRecordSearchFilter {
  const previous = Date.parse(
    `${offsetStocktakeMonth(month, -1)}-01T00:00:00+08:00`,
  );
  const end = Date.parse(`${month}-01T00:00:00+08:00`);
  return {
    conjunction: 'and',
    conditions: [
      // Feishu date comparisons can operate on whole days. Include the first
      // day by comparing with the preceding day and verify the month locally.
      {
        field_name: field,
        operator: 'isGreater',
        value: ['ExactDate', String(previous - 86_400_000)],
      },
      { field_name: field, operator: 'isLess', value: ['ExactDate', String(end)] },
    ],
  };
}

@Injectable()
export class InventoryStocktakeSource {
  constructor(
    private readonly http: HttpService,
    private readonly gateway: InventoryWorkflowGateway,
  ) {}

  private async config() {
    const url = readEnv('FEISHU_WAREHOUSE_SOURCE_URL');
    const parsed = parseFeishuBitableLink(url);
    const appToken = await resolveBitableAppToken(this.http, {
      appToken: readEnv('FEISHU_WAREHOUSE_APP_TOKEN') || parsed.appToken,
      wikiToken: parsed.wikiToken,
      tableName: '库存盘点',
    });
    return { appToken, url };
  }

  snapshot(building?: WarehouseBuilding, month = stocktakeMonth()) {
    validateStocktakeMonth(month);
    return this.readSnapshot(building, month);
  }

  private async readSnapshot(building?: WarehouseBuilding, month?: string) {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('读取盘点来源超时'), { code: 'ETIMEDOUT' }));
      }, SNAPSHOT_TIMEOUT_MS);
    });
    try {
      // A shared Feishu page read may still serve other consumers after this job times out.
      return await Promise.race([
        this.readSnapshotSources(building, month),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async readSnapshotSources(
    building?: WarehouseBuilding,
    month?: string,
  ) {
    const config = await this.config();
    const sources = [
      ['inventory', 'FEISHU_WAREHOUSE_INVENTORY_TABLE_ID', '库存台账'],
      ['catalog', 'FEISHU_WAREHOUSE_CATALOG_TABLE_ID', '物品类别'],
      ['inbound', 'FEISHU_WAREHOUSE_INBOUND_TABLE_ID', '入库填写', '入库日期'],
      ['outbound', 'FEISHU_WAREHOUSE_OUTBOUND_TABLE_ID', '出库填写', '出库时间'],
    ] as const;
    const entries = await Promise.all(
      sources.map(async ([key, env, name, dateField]) => {
        if (dateField && !month) return [key, []] as const;
        const tableId = readEnv(env);
        if (!tableId)
          throw new BadRequestException(`${name}未配置，无法生成盘点清单`);
        return [
          key,
          await fetchBitableRecords(this.http, {
            appToken: config.appToken,
            tableId,
            tableName: name,
            forceRefresh: true,
            strict: true,
            allowStale: false,
            filter: dateField && month
              ? stocktakeMovementFilter(dateField, month)
              : undefined,
          }),
        ] as const;
      }),
    );
    const records = Object.fromEntries(entries) as Record<
      'inventory' | 'catalog' | 'inbound' | 'outbound',
      BitableRecordItem[]
    >;
    const status = Object.fromEntries(
      [
        'inventory',
        'catalog',
        'inbound',
        'outbound',
        'borrow',
        'prices',
        'stocktake',
        'managers',
      ].map((key) => [key, { configured: true, count: 0 }]),
    ) as Record<InventorySourceKey, { configured: boolean; count: number }>;
    const snapshot = buildInventoryManagementSnapshot({
      ...records,
      borrow: [],
      prices: [],
      stocktakeSummaries: [],
      managers: [],
      sourceUrl: config.url,
      generatedAt: new Date().toISOString(),
      sectionStatus: status,
    });
    const inventoryById = new Map(
      records.inventory.map((record) => [record.record_id || record.id, record]),
    );
    const inboundById = new Map(
      records.inbound.map((record) => [record.record_id || record.id, record]),
    );
    const outboundById = new Map(
      records.outbound.map((record) => [record.record_id || record.id, record]),
    );
    for (const item of snapshot.items.filter(
      (i) => !building || i.building === building,
    )) {
      const record = inventoryById.get(item.recordId);
      if (
        !record ||
        extractNumberValue(pickField(record.fields || {}, ['剩余库存'])) ===
          null
      )
        throw new BadRequestException(
          `库存条目 ${item.recordId} 缺少有效台账数量`,
        );
    }
    const movements = [
      ...snapshot.movements.inbound,
      ...snapshot.movements.outbound,
    ].flatMap((movement) => {
      const raw = (movement.type === 'inbound' ? inboundById : outboundById)
        .get(movement.recordId);
      // The dashboard may infer a location from SKU. Sampling requires an explicit
      // location or an unambiguous SKU so distinct stock ledger rows cannot merge.
      const location =
        getWarehouseInventoryLocationReadFieldNames()
          .map((name) =>
            extractDisplayText(
              pickField(raw?.fields || {}, [name]),
              ' ',
            ).trim(),
          )
          .find(
            (value) =>
              value &&
              !value
                .split(/[、\s]+/)
                .every((token) => /^opt[A-Za-z0-9_-]+$/.test(token)),
          ) || '';
      const rawSku = ['物品类别号', '物品类别号（单选）']
        .map((name) =>
          extractDisplayText(pickField(raw?.fields || {}, [name]), ',').trim(),
        )
        .find((value) => value && !/^opt[A-Za-z0-9_-]+$/.test(value));
      // Historical rows may explicitly contain multiple category codes.
      // Each code must independently resolve to one stock row in the rules layer.
      const skus = [
        ...new Set(
          (rawSku || movement.sku || '')
            .split(/[,，、;；\n]+/)
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ];
      return (skus.length ? skus : ['']).map((sku) => ({
        ...movement,
        sku,
        location,
      }));
    });
    return { items: snapshot.items, movements };
  }

  async current(
    previous: InventoryManagementItem,
    principal?: AccessPrincipal,
  ): Promise<InventoryManagementItem> {
    if (isProfessionalBusinessPrincipal(principal)) return (await this.currentMany([previous], principal))[0];
    const { appToken } = await this.config();
    const tableId = readEnv('FEISHU_WAREHOUSE_INVENTORY_TABLE_ID');
    const record = await this.gateway.getRecord(
      appToken,
      tableId,
      previous.recordId,
      '库存台账',
    );
    return this.currentRecord(previous, record);
  }
  async currentMany(
    previous: InventoryManagementItem[],
    principal?: AccessPrincipal,
  ): Promise<InventoryManagementItem[]> {
    if (isProfessionalBusinessPrincipal(principal)) {
      const snapshot = await this.readSnapshot();
      return previous.map(item => {
        const current = snapshot.items.find(candidate => candidate.recordId === item.recordId);
        assertProfessionalRecordScope(principal, current?.specialty, current?.building);
        if (!current || current.sku !== item.sku || current.building !== item.building) throw new BadRequestException('库存条目已变化，请核对台账');
        return current;
      });
    }
    const { appToken } = await this.config();
    const tableId = readEnv('FEISHU_WAREHOUSE_INVENTORY_TABLE_ID');
    if (!tableId) throw new BadRequestException('库存台账未配置');
    const records = await this.gateway.getRecords(appToken, tableId, previous.map(item => item.recordId), '库存台账');
    const byId = new Map(records.map((r) => [r.record_id || r.id, r]));
    return previous.map((item) => {
      const record = byId.get(item.recordId);
      if (!record)
        throw new BadRequestException(
          `${item.name}库存条目已不存在，请核对台账`,
        );
      return this.currentRecord(item, record);
    });
  }
  private currentRecord(
    previous: InventoryManagementItem,
    record: BitableRecordItem,
  ): InventoryManagementItem {
    const fields = record.fields || {};
    const quantity = extractNumberValue(pickField(fields, ['剩余库存']));
    const building = extractDisplayText(pickField(fields, ['楼栋']), '').trim();
    const sku = extractDisplayText(
      pickField(fields, ['物品类别号']),
      '',
    ).trim();
    const location = extractDisplayText(
      pickField(fields, getWarehouseInventoryLocationReadFieldNames()),
      ' ',
    ).trim();
    if (
      quantity === null ||
      !Number.isFinite(quantity) ||
      building !== previous.building ||
      sku !== previous.sku
    )
      throw new BadRequestException('库存条目已变化或缺少有效数量，请核对台账');
    return { ...previous, quantity, location };
  }
}
