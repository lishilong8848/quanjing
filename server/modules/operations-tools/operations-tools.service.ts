import { HttpService } from '@nestjs/axios';
import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  TOOL_SOURCE_LABELS,
  type OperationsToolsSnapshot,
  type ToolFlowKind,
  type ToolSourceKey,
  type ToolSourceStatus,
} from '../../../shared/operations-tools.interface';
import {
  createBitableBackgroundRefresh,
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import {
  TOOLS_BASE,
  TOOLS_BASE_URL,
  TOOL_SOURCES,
  TOOLS_SYNC_INTERVAL_MS,
} from './operations-tools.config';
import { mapFlow, mapTool } from './operations-tools.mapper';

type Section = { records: BitableRecordItem[]; status: ToolSourceStatus };
const keys = Object.keys(TOOL_SOURCES) as ToolSourceKey[];

@Injectable()
export class OperationsToolsService implements OnModuleInit, OnModuleDestroy {
  private readonly sections = new Map<ToolSourceKey, Section>();
  private hydration?: Promise<void>;
  private pending?: Promise<void>;
  private lastAttempt = 0;
  private readonly background;

  constructor(private readonly http: HttpService) {
    for (const key of keys) {
      const source = TOOL_SOURCES[key],
        sourceUrl = `${TOOLS_BASE_URL}?table=${source.tableId}`;
      this.sections.set(key, {
        records: [],
        status: {
          state: 'loading',
          updatedAt: null,
          message: null,
          sourceUrl,
          formUrl: source.formId ? `${sourceUrl}&view=${source.formId}` : null,
        },
      });
    }
    this.background = createBitableBackgroundRefresh({
      name: '运维工具管理',
      intervalMs: TOOLS_SYNC_INTERVAL_MS,
      warm: () => this.refresh(),
      refresh: () => this.refresh(),
    });
  }
  onModuleInit(): void {
    this.background.start();
  }
  onModuleDestroy(): void {
    this.background.stop();
  }

  private hydrate(): Promise<void> {
    if (!this.hydration)
      this.hydration = Promise.all(
        keys.map(async (key) => {
          const source = TOOL_SOURCES[key],
            section = this.sections.get(key)!;
          try {
            const cached = await readLatestPersistedBitableRecordSnapshot({
              appToken: TOOLS_BASE,
              tableId: source.tableId,
              tableName: TOOL_SOURCE_LABELS[key],
            });
            if (!cached) return;
            section.records = cached.records;
            section.status = {
              ...section.status,
              state: 'stale',
              updatedAt: new Date(cached.fetchedAt).toISOString(),
              message: '正在核对最新数据',
            };
          } catch {
            section.status = {
              ...section.status,
              state: 'error',
              message: '本地缓存读取失败，正在重新同步',
            };
          }
        }),
      ).then(() => undefined);
    return this.hydration;
  }

  async getSnapshot(forceRefresh = false): Promise<OperationsToolsSnapshot> {
    await this.hydrate();
    // Reads return local data immediately. External work is single-flight and rate-limited.
    if (
      !this.pending &&
      (Date.now() - this.lastAttempt >= TOOLS_SYNC_INTERVAL_MS ||
        (forceRefresh && Date.now() - this.lastAttempt >= 5000))
    )
      void this.refresh();
    const tools = [
      ...new Map(
        this.sections
          .get('ledger')!
          .records.map(mapTool)
          .filter((t) => t !== null)
          .map((t) => [t.id, t]),
      ).values(),
    ];
    const flows = keys
      .filter((key): key is ToolFlowKind => key !== 'ledger')
      .flatMap((kind) => [
        ...new Map(
          this.sections
            .get(kind)!
            .records.map((r) => mapFlow(kind, r))
            .filter((f) => f !== null)
            .map((f) => [f.id, f]),
        ).values(),
      ]);
    return {
      tools,
      flows,
      sources: Object.fromEntries(
        keys.map((key) => [key, { ...this.sections.get(key)!.status }]),
      ) as OperationsToolsSnapshot['sources'],
      generatedAt: new Date().toISOString(),
      refreshing: Boolean(this.pending),
      scopedBuilding: null,
    };
  }

  refresh(): Promise<void> {
    if (this.pending) return this.pending;
    this.lastAttempt = Date.now();
    this.pending = this.hydrate()
      .then(async () => {
        // A bounded pool avoids flooding the shared Feishu application rate limit.
        const queue = [...keys];
        const worker = async (): Promise<void> => {
          for (let key = queue.shift(); key; key = queue.shift()) {
            const section = this.sections.get(key)!;
            try {
              const records = await fetchBitableRecords(this.http, {
                appToken: TOOLS_BASE,
                tableId: TOOL_SOURCES[key].tableId,
                tableName: TOOL_SOURCE_LABELS[key],
                cacheTtlMs: TOOLS_SYNC_INTERVAL_MS,
                forceRefresh: true,
                allowStale: false,
                strict: true,
              });
              section.records = records;
              section.status = {
                ...section.status,
                state: 'ready',
                updatedAt: new Date().toISOString(),
                message: null,
              };
            } catch {
              section.status = {
                ...section.status,
                state: section.status.updatedAt ? 'stale' : 'error',
                message: section.status.updatedAt
                  ? '同步失败，保留最近一次成功数据'
                  : '读取失败，请重试或检查飞书应用访问权限',
              };
            }
          }
        };
        await Promise.all([worker(), worker()]);
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
}
