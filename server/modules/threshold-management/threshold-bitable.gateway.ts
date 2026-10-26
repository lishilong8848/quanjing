import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { getTenantAccessToken } from '../../common/feishu/bitable-direct-read';
import {
  THRESHOLD_BITABLE_SCHEMA as schema,
  thresholdFieldsMatch,
  thresholdText,
  thresholdToBitableFields,
  thresholdFromBitableFields,
} from '../../../shared/threshold-bitable';
import type {
  ThresholdRecord,
  ThresholdSyncJob,
} from '../../../shared/threshold-management.interface';

interface CloudRecord {
  record_id: string;
  fields: Record<string, unknown>;
}
@Injectable()
export class ThresholdBitableGateway {
  private readonly ready = new Map<string, number>();
  constructor(private readonly http: HttpService) {}
  private table(profession: string): string {
    const table = (schema.tables as Record<string, string>)[profession];
    if (!table) throw new Error('该专业尚未接入多维表');
    return table;
  }
  private url(table: string) {
    return `https://open.feishu.cn/open-apis/bitable/v1/apps/${schema.baseToken}/tables/${table}`;
  }
  private async request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    data?: unknown,
    params?: Record<string, unknown>,
  ) {
    try {
      const token = await getTenantAccessToken(this.http, undefined, {
        requestTimeoutMs: () => 8000,
      });
      const response = await this.http.axiosRef.request({
        method,
        url,
        data,
        params,
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10000,
      });
      if (response.data.code !== 0)
        throw new Error(`飞书请求未通过（${String(response.data.code)}）`);
      if (!response.data.data || typeof response.data.data !== 'object')
        throw new Error('飞书返回结构不符');
      return response.data.data;
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith('飞书'))
        throw cause;
      const error = cause as {
        response?: { status?: number; data?: { code?: number } };
        code?: string;
      };
      if (
        error.response?.status === 403 ||
        error.response?.data?.code === 91403
      )
        throw new Error('飞书应用无多维表读写权限');
      throw new Error('飞书暂时不可用，请重试同步');
    }
  }
  private async ensureFields(table: string) {
    if ((this.ready.get(table) || 0) > Date.now()) return;
    const fields = new Map<string, number>();
    let pageToken: string | undefined;
    do {
      const result = await this.request(
        'GET',
        `${this.url(table)}/fields`,
        undefined,
        { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) },
      );
      for (const field of result.items || [])
        fields.set(field.field_name, field.type);
      if (
        result.has_more &&
        (!result.page_token || result.page_token === pageToken)
      )
        throw new Error('飞书字段分页未推进');
      pageToken = result.has_more ? result.page_token : undefined;
    } while (pageToken);
    for (const name of Object.values(schema.fields))
      if (fields.get(name) !== 1)
        throw new Error(`飞书字段「${name}」须为文本`);
    this.ready.set(table, Date.now() + 60000);
  }
  private async find(table: string, id: string): Promise<CloudRecord | null> {
    const result = await this.request(
      'POST',
      `${this.url(table)}/records/search`,
      {
        field_names: Object.values(schema.fields),
        filter: {
          conjunction: 'and',
          conditions: [
            { field_name: schema.fields.id, operator: 'is', value: [id] },
          ],
        },
      },
      { page_size: 2 },
    );
    if (
      !Array.isArray(result.items) ||
      result.has_more ||
      result.items.length > 1
    )
      throw new Error('飞书记录标识重复或查询异常');
    const found = result.items[0] as CloudRecord | undefined;
    if (
      found &&
      (!found.record_id ||
        thresholdText(found.fields?.[schema.fields.id]) !== id)
    )
      throw new Error('飞书记录标识回读不符');
    return found || null;
  }
  private assertBefore(found: CloudRecord, before: ThresholdRecord | null) {
    if (!before) throw new Error('线上已存在相同标识，禁止覆盖');
    const expected = thresholdToBitableFields(before);
    delete expected[schema.fields.mutationId];
    if (!thresholdFieldsMatch(expected, found.fields))
      throw new Error('多维表记录已变化，请核对后重试');
  }
  async readRecord(
    profession: string,
    id: string,
  ): Promise<ThresholdRecord | null> {
    const table = this.table(profession);
    await this.ensureFields(table);
    const record = await this.find(table, id);
    return record
      ? thresholdFromBitableFields(record.fields, profession)
      : null;
  }
  async readSnapshot(): Promise<ThresholdRecord[]> {
    const startedAt = Date.now();
    const tablesUrl = `https://open.feishu.cn/open-apis/base/v3/bases/${schema.baseToken}/tables`;
    const before = await this.request('GET', tablesUrl, undefined, {
      limit: 100,
    });
    if (!Array.isArray(before.tables) || before.total > before.tables.length)
      throw new Error('飞书数据表元数据不完整');
    const records: ThresholdRecord[] = [];
    const ids = new Set<string>();
    for (const [profession, table] of Object.entries(schema.tables)) {
      const metadata = before.tables.find(
        (item: { id: string }) => item.id === table,
      );
      if (
        !metadata ||
        !Number.isSafeInteger(metadata.records_count) ||
        !Number.isSafeInteger(metadata.rev)
      )
        throw new Error('飞书数据表版本或数量无效');
      let count = 0;
      await this.ensureFields(table);
      let pageToken: string | undefined;
      do {
        if (Date.now() - startedAt > 60000)
          throw new Error('云端读取超时，请刷新重试');
        const result = await this.request(
          'POST',
          `${this.url(table)}/records/search`,
          { field_names: Object.values(schema.fields) },
          { page_size: 500, ...(pageToken ? { page_token: pageToken } : {}) },
        );
        if (
          !Array.isArray(result.items) ||
          (result.has_more &&
            (!result.items.length ||
              !result.page_token ||
              result.page_token === pageToken))
        )
          throw new Error('飞书阈值分页未推进');
        for (const item of result.items) {
          const record = thresholdFromBitableFields(
            item.fields || {},
            profession,
          );
          if (ids.has(record.id)) throw new Error('多维表阈值记录标识重复');
          ids.add(record.id);
          records.push(record);
          count += 1;
        }
        pageToken = result.has_more ? result.page_token : undefined;
      } while (pageToken);
      if (count !== metadata.records_count)
        throw new Error('多维表读取期间数量已变化，请刷新重试');
    }
    const after = await this.request('GET', tablesUrl, undefined, {
      limit: 100,
    });
    for (const table of Object.values(schema.tables)) {
      const first = before.tables.find(
        (item: { id: string }) => item.id === table,
      );
      const last = after.tables?.find(
        (item: { id: string }) => item.id === table,
      );
      if (
        !last ||
        first.rev !== last.rev ||
        first.records_count !== last.records_count
      )
        throw new Error('多维表读取期间内容已变化，请刷新重试');
    }
    return records;
  }
  async sync(
    job: ThresholdSyncJob,
    onLocated?: (tableId: string, recordId: string) => void,
  ): Promise<void> {
    const { result, before } = job;
    const next = result.record;
    const target = this.table((next || before)!.profession);
    await this.ensureFields(target);
    let found = await this.find(target, result.id);
    if (found) onLocated?.(target, found.record_id);
    if (result.operation === 'delete') {
      if (found) {
        this.assertBefore(found, before);
        await this.request(
          'DELETE',
          `${this.url(target)}/records/${found.record_id}`,
        );
      }
      if (await this.find(target, result.id))
        throw new Error('飞书删除回读不符');
      return;
    }
    const expected = thresholdToBitableFields(next!, result.clientMutationId);
    if (found && thresholdFieldsMatch(expected, found.fields))
      return this.removePreviousTable(job, target);
    if (found) {
      this.assertBefore(
        found,
        before?.profession === next!.profession ? before : null,
      );
      await this.request(
        'PUT',
        `${this.url(target)}/records/${found.record_id}`,
        { fields: expected },
      );
    } else {
      if (
        result.operation === 'update' &&
        before?.profession === next!.profession
      )
        throw new Error('多维表记录已被删除，禁止重新创建');
      const digest = createHash('sha256')
        .update(`${target}:${result.clientMutationId}`)
        .digest('hex');
      const clientToken = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
      const created = await this.request(
        'POST',
        `${this.url(target)}/records`,
        { fields: expected },
        { client_token: clientToken },
      );
      if (created.record?.record_id)
        onLocated?.(target, created.record.record_id);
    }
    found = await this.find(target, result.id);
    if (!found || !thresholdFieldsMatch(expected, found.fields))
      throw new Error('飞书逐字段回读不符，请重试同步');
    await this.removePreviousTable(job, target);
  }
  private async removePreviousTable(job: ThresholdSyncJob, target: string) {
    if (!job.before || job.before.profession === job.result.record?.profession)
      return;
    const oldTable = this.table(job.before.profession);
    if (oldTable === target) return;
    await this.ensureFields(oldTable);
    const previous = await this.find(oldTable, job.result.id);
    if (previous) {
      this.assertBefore(previous, job.before);
      await this.request(
        'DELETE',
        `${this.url(oldTable)}/records/${previous.record_id}`,
      );
    }
    if (await this.find(oldTable, job.result.id))
      throw new Error('专业变更后旧表记录未清除');
  }
}
