import { HttpService } from '@nestjs/axios';
import type { AccessPrincipal } from '../../../shared/access-control.interface';
import { filterProfessionalRecords } from '../../common/access/professional-record-scope';
import { extractDisplayText } from '../../common/feishu/bitable-direct-read';
import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { EquipmentPatrolExecutionResponse } from '../../../shared/equipment-patrol-execution.interface';
import {
  parseFeishuBitableLink,
  readEnv,
} from '../../common/config/external-services.config';
import {
  type BitableRecordItem,
  fetchBitableRecords,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import {
  filterEquipmentPatrolExecutionRecordsByMonth,
  mapEquipmentPatrolExecutionRecords,
} from './equipment-patrol-execution.mapper';

const TABLE_NAME = '设备轮巡执行数据';
const DEFAULT_SOURCE_URL =
  'https://example.feishu.cn/wiki/PUBLIC_EXAMPLE_SOURCE';
const SNAPSHOT_PATH = join(
  process.cwd(),
  'data',
  'equipment-patrol',
  'execution-snapshot.json',
);
const SNAPSHOT_WARNING =
  '飞书实时数据读取失败，当前展示本地快照，数据可能已过期。';

export interface EquipmentPatrolExecutionQuery {
  month?: string;
  refresh?: string;
}

interface EquipmentPatrolExecutionSnapshot {
  version: number;
  sourceUrl: string;
  generatedAt: string;
  recordCount: number;
  records: BitableRecordItem[];
}

@Injectable()
export class EquipmentPatrolExecutionService {
  constructor(private readonly httpService: HttpService) {}

  async getExecutions(
    query: EquipmentPatrolExecutionQuery,
    principal?: AccessPrincipal,
  ): Promise<EquipmentPatrolExecutionResponse> {
    const month = requireMonth(query.month);
    const sourceUrl =
      readEnv('FEISHU_EQUIPMENT_PATROL_EXECUTION_SOURCE_URL') ||
      DEFAULT_SOURCE_URL;

    try {
      const records = await this.fetchLiveRecords(
        sourceUrl,
        query.refresh === '1' || query.refresh === 'true',
      );
      return buildResponse(filterProfessionalRecords(principal, records, record => extractDisplayText(record.fields?.['专业'])), month, sourceUrl, 'live');
    } catch {
      try {
        const snapshot = await readSnapshot();
        return buildResponse(
          filterProfessionalRecords(principal, snapshot.records, record => extractDisplayText(record.fields?.['专业'])),
          month,
          sourceUrl || snapshot.sourceUrl,
          'snapshot',
          [SNAPSHOT_WARNING],
        );
      } catch {
        throw new ServiceUnavailableException(
          '设备轮巡执行数据暂时不可用，实时数据和本地快照均读取失败。',
        );
      }
    }
  }

  private async fetchLiveRecords(
    sourceUrl: string,
    forceRefresh: boolean,
  ): Promise<BitableRecordItem[]> {
    const source = parseFeishuBitableLink(sourceUrl);
    const appToken = await resolveBitableAppToken(this.httpService, {
      appToken: source.appToken,
      wikiToken: source.wikiToken,
      tableName: TABLE_NAME,
    });

    return fetchBitableRecords(this.httpService, {
      appToken,
      tableId: source.tableId,
      tableName: TABLE_NAME,
      forceRefresh,
    });
  }
}

function requireMonth(value: string | undefined): string {
  const month = value?.trim() || '';
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) {
    throw new BadRequestException('month 必须使用 YYYY-MM 格式');
  }
  return month;
}

function buildResponse(
  rawRecords: BitableRecordItem[],
  month: string,
  sourceUrl: string,
  sourceMode: EquipmentPatrolExecutionResponse['sourceMode'],
  warnings: string[] = [],
): EquipmentPatrolExecutionResponse {
  const mappedRecords = mapEquipmentPatrolExecutionRecords(rawRecords);
  const sourceUpdatedAt = mappedRecords.reduce<string | null>(
    (latest, record) => {
      if (!record.updatedAt) return latest;
      return !latest || record.updatedAt > latest ? record.updatedAt : latest;
    },
    null,
  );

  return {
    month,
    generatedAt: new Date().toISOString(),
    sourceUpdatedAt,
    sourceUrl,
    sourceMode,
    stale: sourceMode === 'snapshot',
    totalSourceRecords: rawRecords.length,
    records: filterEquipmentPatrolExecutionRecordsByMonth(mappedRecords, month),
    warnings,
  };
}

async function readSnapshot(): Promise<EquipmentPatrolExecutionSnapshot> {
  const content = await readFile(SNAPSHOT_PATH, 'utf8');
  const snapshot = JSON.parse(
    content,
  ) as Partial<EquipmentPatrolExecutionSnapshot>;
  if (!Array.isArray(snapshot.records)) {
    throw new Error('Invalid equipment patrol execution snapshot');
  }
  return snapshot as EquipmentPatrolExecutionSnapshot;
}
