import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { CampusCertificateDashboardResponse } from '../../../shared/api.interface';
import { readEnv } from '../../common/config/external-services.config';
import {
  type BitableRecordItem,
  fetchBitableRecords,
  readLatestPersistedBitableRecords,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import { mapCampusCertificateDashboard } from './certificate-dashboard.mapper';

const DEFAULT_WIKI_TOKEN = 'Rz4GwoB8Fi4WyokVcCPcmWJMnle';
const DEFAULT_TABLE_ID = 'tbl9NBxImAt3kzx2';
const SOURCE_NAME = '园区持证正式表';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_ERROR_MESSAGE = '源数据同步失败，已展示上次成功结果';
const MIN_LAST_GOOD_RATIO = 0.7;

@Injectable()
export class CertificateDashboardService {
  private readonly logger = new Logger(CertificateDashboardService.name);
  private lastGoodSnapshot: CampusCertificateDashboardResponse | null = null;
  private activeRefresh: Promise<CampusCertificateDashboardResponse> | null =
    null;

  constructor(private readonly httpService: HttpService) {}

  async getDashboard(
    forceRefresh = false,
  ): Promise<CampusCertificateDashboardResponse> {
    if (!forceRefresh && this.lastGoodSnapshot) {
      return this.lastGoodSnapshot;
    }
    if (this.activeRefresh) {
      return this.activeRefresh;
    }

    this.activeRefresh = this.loadDashboard().finally(() => {
      this.activeRefresh = null;
    });
    return this.activeRefresh;
  }

  refresh(): Promise<CampusCertificateDashboardResponse> {
    return this.getDashboard(true);
  }

  private async loadDashboard(): Promise<CampusCertificateDashboardResponse> {
    let appToken = '';
    const tableId = readEnv('FEISHU_CERTIFICATE_TABLE_ID') || DEFAULT_TABLE_ID;
    let persistedRecords: BitableRecordItem[] | null = null;
    if (!this.lastGoodSnapshot) {
      try {
        persistedRecords = await readLatestPersistedBitableRecords({
          tableId,
          tableName: SOURCE_NAME,
        });
      } catch {
        this.logger.warn('园区持证持久快照不可用');
      }
    }
    const previousPeopleCount =
      this.lastGoodSnapshot?.people.length ?? persistedRecords?.length;
    const validateRecords = (records: BitableRecordItem[]): void =>
      assertCertificateRecordsQuality(records, previousPeopleCount);
    try {
      const wikiToken =
        readEnv('FEISHU_CERTIFICATE_WIKI_TOKEN') || DEFAULT_WIKI_TOKEN;
      appToken =
        readEnv('FEISHU_CERTIFICATE_APP_TOKEN') ||
        (await resolveBitableAppToken(this.httpService, {
          wikiToken,
          tableName: SOURCE_NAME,
        }));
      const records = await fetchBitableRecords(this.httpService, {
        appToken,
        tableId,
        tableName: SOURCE_NAME,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh: true,
        strict: true,
        validateRecords,
      });
      const dashboard = buildCheckedDashboard(records, previousPeopleCount);
      this.lastGoodSnapshot = dashboard;
      return dashboard;
    } catch {
      this.logger.warn('园区持证数据同步失败');
      if (this.lastGoodSnapshot) {
        const stale = markSnapshotStale(this.lastGoodSnapshot);
        this.lastGoodSnapshot = stale;
        return stale;
      }
      if (persistedRecords) {
        try {
          const stale = markSnapshotStale(
            buildCheckedDashboard(persistedRecords, previousPeopleCount),
          );
          this.lastGoodSnapshot = stale;
          return stale;
        } catch {
          this.logger.warn('园区持证持久快照不可用');
        }
      }
      if (appToken) {
        try {
          const records = await fetchBitableRecords(this.httpService, {
            appToken,
            tableId,
            tableName: SOURCE_NAME,
            cacheTtlMs: CACHE_TTL_MS,
            forceRefresh: false,
            strict: false,
            validateRecords,
          });
          const stale = markSnapshotStale(
            buildCheckedDashboard(records, previousPeopleCount),
          );
          this.lastGoodSnapshot = stale;
          return stale;
        } catch {
          this.logger.warn('园区持证本地快照不可用');
        }
      }
      throw new ServiceUnavailableException('园区持证数据同步失败，请稍后重试');
    }
  }
}

function buildCheckedDashboard(
  records: BitableRecordItem[],
  previousPeopleCount?: number,
): CampusCertificateDashboardResponse {
  const dashboard = mapCampusCertificateDashboard(
    records,
    new Date().toISOString(),
  );
  assertDashboardQuality(dashboard, previousPeopleCount);
  return dashboard;
}

function assertCertificateRecordsQuality(
  records: BitableRecordItem[],
  previousPeopleCount?: number,
): void {
  assertDashboardQuality(
    mapCampusCertificateDashboard(records, '1970-01-01T00:00:00.000Z'),
    previousPeopleCount,
  );
}

function assertDashboardQuality(
  dashboard: CampusCertificateDashboardResponse,
  previousPeopleCount?: number,
): void {
  const total = dashboard.people.length;
  const unknownCount = dashboard.people.filter(
    (person) => person.complianceStatus === '未知',
  ).length;
  const isObviouslyTruncated =
    typeof previousPeopleCount === 'number' &&
    previousPeopleCount > 0 &&
    total < Math.ceil(previousPeopleCount * MIN_LAST_GOOD_RATIO);
  if (total === 0 || unknownCount > total / 2 || isObviouslyTruncated) {
    throw new Error('园区持证数据质量校验失败');
  }
}

function markSnapshotStale(
  snapshot: CampusCertificateDashboardResponse,
): CampusCertificateDashboardResponse {
  return {
    ...snapshot,
    sourceStatus: 'stale',
    errorMessage: STALE_ERROR_MESSAGE,
  };
}
