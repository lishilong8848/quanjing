import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import {
  getFeishuAuthPayload,
  readEnv,
} from '../../common/config/external-services.config';
import { InventoryWorkflowGateway } from './inventory-workflow.gateway';
import {
  STOCKTAKE_RESULT_FIELDS,
  STOCKTAKE_RESULTS_BASE,
  STOCKTAKE_RESULTS_TABLE,
  stocktakeCellText,
  stocktakeMonthField,
  verifyStocktakeResult,
} from './inventory-stocktake-results.model';

export interface StocktakeRemoteRecord {
  record_id: string;
  fields: Record<string, unknown>;
}

@Injectable()
export class InventoryStocktakeResultsGateway {
  private token: { value: string; expiresAt: number } | null = null;
  private ready = false;
  constructor(
    private readonly http: HttpService,
    private readonly inventory: InventoryWorkflowGateway,
  ) {}
  get target() {
    return {
      base: readEnv('FEISHU_STOCKTAKE_RESULTS_BASE') || STOCKTAKE_RESULTS_BASE,
      table:
        readEnv('FEISHU_STOCKTAKE_RESULTS_TABLE') || STOCKTAKE_RESULTS_TABLE,
    };
  }
  private async request(
    method: 'get' | 'post',
    suffix: string,
    data?: unknown,
    params?: unknown,
  ) {
    if (!this.token || this.token.expiresAt <= Date.now()) {
      const response = await this.http.axiosRef.post(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        getFeishuAuthPayload(),
        { timeout: 15000 },
      );
      if (response.data?.code !== 0 || !response.data?.tenant_access_token)
        throw new Error('盘点同步：飞书认证失败');
      this.token = {
        value: response.data.tenant_access_token,
        expiresAt:
          Date.now() +
          Math.max(60, Number(response.data.expire || 3600) - 300) * 1000,
      };
    }
    const { base, table } = this.target;
    try {
      const response = await this.http.axiosRef.request({
        method,
        url: `https://open.feishu.cn/open-apis/bitable/v1/apps/${encodeURIComponent(base)}/tables/${encodeURIComponent(table)}/${suffix}`,
        data,
        params,
        headers: { Authorization: `Bearer ${this.token.value}` },
        timeout: 20000,
      });
      if (response.data?.code !== 0)
        throw new Error(
          `盘点同步：飞书返回错误 ${Number(response.data?.code) || '未知'}`,
        );
      return response.data.data;
    } catch (error) {
      // Axios errors carry request headers; never persist or log those objects.
      if (error instanceof Error && error.message.startsWith('盘点同步：'))
        throw error;
      throw new Error('盘点同步：网络或权限异常，请重试');
    }
  }
  async ensureSchema(months: string[]) {
    const { base, table } = this.target;
    if (!this.ready) {
      const fields = await this.inventory.getFieldSchemas(
        base,
        table,
        '库存盘点记录',
      );
      for (const [name, type] of Object.entries(STOCKTAKE_RESULT_FIELDS))
        if (
          !fields.some(
            (f) => f.fieldName === name && f.type === type && f.writable,
          )
        )
          throw new Error(`盘点同步：字段“${name}”缺失或类型不符`);
      this.ready = true;
    }
    for (const month of [...new Set(months)])
      await this.inventory.ensureTextField(
        base,
        table,
        stocktakeMonthField(month),
        '库存盘点记录',
      );
  }
  async index(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    let page: string | undefined;
    for (let count = 0; count < 100; count++) {
      const data = await this.request(
        'post',
        'records/search',
        { field_names: ['库存条目ID'], automatic_fields: false },
        { page_size: 500, page_token: page, user_id_type: 'open_id' },
      );
      if (!Array.isArray(data?.items))
        throw new Error('盘点同步：索引返回格式异常');
      for (const row of data.items as StocktakeRemoteRecord[]) {
        const key = stocktakeCellText(row.fields['库存条目ID']);
        if (!key) continue;
        if (!row.record_id || result.has(key))
          throw new Error('盘点同步：库存条目ID重复，请检查目标表');
        result.set(key, row.record_id);
      }
      if (!data.has_more) return result;
      if (!data.page_token || data.page_token === page)
        throw new Error('盘点同步：索引分页异常');
      page = data.page_token;
    }
    throw new Error('盘点同步：目标表超过安全查询上限');
  }
  async create(ids: string[], clientToken: string) {
    const data = await this.request(
      'post',
      'records/batch_create',
      { records: ids.map((id) => ({ fields: { 库存条目ID: id } })) },
      { client_token: clientToken, user_id_type: 'open_id' },
    );
    if (!Array.isArray(data?.records) || data.records.length !== ids.length)
      throw new Error('盘点同步：创建结果待核对');
  }
  async update(records: StocktakeRemoteRecord[]) {
    await this.request(
      'post',
      'records/batch_update',
      { records },
      { user_id_type: 'open_id' },
    );
    const data = await this.request(
      'post',
      'records/batch_get',
      { record_ids: records.map((r) => r.record_id), automatic_fields: false },
      { user_id_type: 'open_id' },
    );
    if (!Array.isArray(data?.records))
      throw new Error('盘点同步：回读格式异常');
    const returned = new Map<string, StocktakeRemoteRecord>(
      data.records.map((r: StocktakeRemoteRecord) => [r.record_id, r]),
    );
    for (const record of records) {
      const actual = returned.get(record.record_id);
      if (!actual) throw new Error('盘点同步：回读记录缺失');
      verifyStocktakeResult(record.fields, actual.fields);
    }
  }
}
