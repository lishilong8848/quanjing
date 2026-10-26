import { HttpService } from '@nestjs/axios';
import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  MonthlyEventReviewReportContent,
  MonthlyEventsResponse,
} from '../../../shared/monthly-operations-events.interface';
import { readEnv } from '../../common/config/external-services.config';
import {
  fetchBitableRecords,
  getTenantAccessToken,
  readLatestPersistedBitableRecordSnapshot,
  resolveBitableAppToken,
} from '../../common/feishu/bitable-direct-read';
import {
  resourceRange,
  shanghaiDay,
} from './monthly-operations-resources.model';
import { mergeMonthlyEventSources } from './monthly-operations-events.model';
export const MONTHLY_EVENT_SOURCE = {
  tableId: 'tbl72e6608772279',
  tableName: '月览事件',
  fieldNames: [
    '事件编号',
    '告警描述',
    '事件简述',
    '机楼',
    '专业',
    '事件等级',
    '事件发现来源（统一）',
    '事件发现来源',
    '事件发生时间',
    '事件恢复时间',
    '事件结束时间',
    '检修完成时间',
    '是否转检修',
    '持续时间',
    '检修进度',
    '最终状态',
    '事件状态',
    '不计入事件',
    '事件目前进展',
  ],
} as const;
export const MONTHLY_EVENT_PRIORITY_SOURCE = {
  tableId: 'tbl8c53fd40c1f50',
  viewId: 'vewtj0ZiJJ',
  tableName: '重点事件补充',
  fieldNames: [
    '事件编号',
    '告警描述',
    '事件简述',
    '机楼',
    '专业',
    '事件等级',
    '事件发现来源（统一）',
    '事件发生时间',
    '事件恢复时间',
    '事件结束时间',
    '检修完成时间',
    '是否转检修',
    '持续时间',
    '检修进度',
    '最终状态',
    '事件状态',
    '不计入事件',
    '事件目前进展',
    '需回溯',
    '1-回溯报告',
    '2-回溯报告',
    '事件发生原因',
    '故障原因(ai识别可修改）',
    '事件解决措施',
    '处理措施（ai识别可修改）',
  ],
} as const;
@Injectable()
export class MonthlyOperationsEventsService {
  constructor(@Inject(HttpService) private readonly http: HttpService) {}
  private auth() {
    const authPrefix = [
      'TODAY_OPERATIONS_KPI_FEISHU',
      'FEISHU_RISK_INSPECTION',
      'ALI_MONTHLY_REPORT_FEISHU',
    ].find(
      (prefix) =>
        readEnv(`${prefix}_APP_ID`) && readEnv(`${prefix}_APP_SECRET`),
    );
    return authPrefix
      ? {
          appId: readEnv(`${authPrefix}_APP_ID`),
          appSecret: readEnv(`${authPrefix}_APP_SECRET`),
        }
      : undefined;
  }

  async getEvents(
    start: unknown,
    end: unknown,
    refresh = false,
  ): Promise<MonthlyEventsResponse> {
    const range = resourceRange(start, end);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const auth = this.auth();
    try {
      let supplementFailed = false;
      const read = async () => {
        const readSource = async (
          source:
            | typeof MONTHLY_EVENT_SOURCE
            | typeof MONTHLY_EVENT_PRIORITY_SOURCE,
          wikiToken: string,
        ) => {
          const appToken = await resolveBitableAppToken(this.http, {
            wikiToken,
            tableName: source.tableName,
            auth,
          });
          return fetchBitableRecords(this.http, {
            ...source,
            appToken,
            auth,
            strict: true,
            allowStale: !refresh,
            cacheTtlMs: 300000,
            forceRefresh: refresh,
          });
        };
        const [records, supplement] = await Promise.all([
          readSource(MONTHLY_EVENT_SOURCE, 'D01TwFPyXiJBY6kCBDZcMCGLnSe'),
          readSource(
            MONTHLY_EVENT_PRIORITY_SOURCE,
            'G7oUwGdwaiTmimk8i2ecGTWOn4d',
          ).catch(() => {
            supplementFailed = true;
            return [];
          }),
        ]);
        return { records, supplement };
      };
      const sources = await Promise.race([
        read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error('事件读取超时')), 35000);
        }),
      ]);
      const snapshot =
        await readLatestPersistedBitableRecordSnapshot(MONTHLY_EVENT_SOURCE);
      const updating =
        !refresh && snapshot && Date.now() - snapshot.fetchedAt >= 300000;
      return {
        range,
        status: updating
          ? 'stale'
          : sources.records.length || sources.supplement.length
            ? 'ready'
            : 'empty',
        syncedAt: new Date(snapshot?.fetchedAt ?? Date.now()).toISOString(),
        ...(supplementFailed
          ? { message: '重点事件补充源更新失败，已显示事件主表数据' }
          : updating
            ? { message: '后台更新中' }
            : {}),
        ...mergeMonthlyEventSources(
          sources.records,
          sources.supplement,
          range.asOf,
        ),
      };
    } catch {
      const [snapshot, supplementSnapshot] = await Promise.all([
        readLatestPersistedBitableRecordSnapshot(MONTHLY_EVENT_SOURCE),
        readLatestPersistedBitableRecordSnapshot(MONTHLY_EVENT_PRIORITY_SOURCE),
      ]);
      return snapshot
        ? {
            range,
            status: 'stale',
            syncedAt: new Date(snapshot.fetchedAt).toISOString(),
            message: '更新失败，显示上次成功数据',
            ...mergeMonthlyEventSources(
              snapshot.records,
              supplementSnapshot?.records ?? [],
              range.asOf,
            ),
          }
        : {
            range,
            status: 'error',
            syncedAt: null,
            message: '事件读取失败，请重试',
            records: [],
            excluded: 0,
            invalid: 0,
          };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async getEventReviewReport(
    eventId: unknown,
    reportIndex: unknown,
  ): Promise<MonthlyEventReviewReportContent> {
    const id = String(eventId ?? '').trim();
    const index = Number(reportIndex);
    if (
      !id ||
      id.length > 128 ||
      !Number.isInteger(index) ||
      index < 0 ||
      index > 1
    )
      throw new BadRequestException('复盘报告参数无效');

    const today = shanghaiDay();
    const events = await this.getEvents(today, today);
    const event = events.records.find((record) => record.id === id);
    const report = event?.reviewReports[index];
    if (!report) throw new NotFoundException('未找到复盘报告');

    const url = new URL(report.url);
    const match = url.pathname.match(
      /^\/(wiki|docx|file)\/([A-Za-z0-9_-]{16,80})(?:\/|$)/,
    );
    if (url.hostname !== 'vnet.feishu.cn' || !match)
      throw new BadRequestException('复盘报告链接无效');

    const [, sourceType, sourceToken] = match;
    if (sourceType === 'file') {
      return {
        title: report.title,
        kind: 'file',
        content: null,
        message: '该报告为飞书附件，请在飞书中打开查看完整内容。',
      };
    }

    const tenantAccessToken = await getTenantAccessToken(
      this.http,
      this.auth(),
    );
    let documentToken = sourceToken;
    if (sourceType === 'wiki') {
      const response = await this.http.axiosRef.get(
        'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node',
        {
          headers: { Authorization: `Bearer ${tenantAccessToken}` },
          params: { token: sourceToken },
          timeout: 15000,
        },
      );
      const payload = response.data as {
        code?: number;
        data?: { node?: { obj_type?: string; obj_token?: string } };
      };
      const node = payload.data?.node;
      if (payload.code !== 0 || node?.obj_type !== 'docx' || !node.obj_token)
        throw new BadGatewayException('复盘报告暂时无法读取，请在飞书中打开');
      documentToken = node.obj_token;
    }

    const response = await this.http.axiosRef.get(
      `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(documentToken)}/raw_content`,
      {
        headers: { Authorization: `Bearer ${tenantAccessToken}` },
        timeout: 15000,
      },
    );
    const payload = response.data as {
      code?: number;
      data?: { content?: string };
    };
    const content = String(payload.data?.content ?? '').trim();
    if (payload.code !== 0 || !content)
      throw new BadGatewayException('复盘报告暂时无法读取，请在飞书中打开');
    return {
      title: report.title,
      kind: 'document',
      content: content.slice(0, 200000),
      message: '',
    };
  }
}
