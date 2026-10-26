import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { createHash } from 'node:crypto';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
  type BitableRecordItem,
} from '../../common/feishu/bitable-direct-read';
import type {
  MeetingDetail,
  MeetingDetailResponse,
  MeetingSnapshot,
  MeetingLatestActions,
} from '../../../shared/meeting-management.interface';
import { mapWeeklyMeeting, summarizeMeeting } from './meeting.mapper';
import { latestMeetingActions } from './meeting.actions';
import { WeeklyDocumentReader } from './meeting.document';
import { MeetingSourcesService } from './meeting.sources.service';
import type { PreparedActionEdit } from '../../../shared/weekly-workspace.interface';

export const WEEKLY_MEETING_SOURCE = {
  appToken: 'Ku17b5rmgaULYJsioBpcHl0Xnqd',
  tableId: 'tbl96c6dccf01af4',
  viewId: 'vewDqqJuM7',
  tableName: '01 【周报】南通运维周报收集库',
  automaticFields: true,
};
const CACHE_TTL_MS = 20 * 1000;

@Injectable()
export class MeetingService {
  private documentReader?: WeeklyDocumentReader;
  private documentPeopleLookup?: () => Promise<
    { openId: string; name: string }[]
  >;
  setDocumentPeopleLookup(
    lookup: () => Promise<{ openId: string; name: string }[]>,
  ) {
    this.documentPeopleLookup = lookup;
  }
  private cache: {
    snapshotId: string;
    fetchedAt: number;
    expiresAt: number;
    meetings: MeetingDetail[];
    latestActions: MeetingLatestActions | null;
  } | null = null;
  private initialRead: Promise<void> | null = null;
  private refreshRead: Promise<void> | null = null;
  private syncError: string | null = null;
  private retryAfter = 0;
  private writeVersion = 0;
  private ownerLookup?: () => PreparedActionEdit[];
  setOwnerLookup(lookup: () => PreparedActionEdit[]) {
    this.ownerLookup = lookup;
  }
  private actionsWithOwners(): MeetingLatestActions | null {
    const actions = this.cache?.latestActions;
    if (!actions) return null;
    const owners = new Map(
      (this.ownerLookup?.() || []).map((edit) => [edit.actionId, edit]),
    );
    return {
      ...actions,
      items: actions.items.map((item) => {
        const edit = owners.get(item.id);
        return edit?.desiredContent === item.content && edit.assignee
          ? {
              ...item,
              assignee: edit.assignee,
              responsible:
                edit.assignee.kind === 'unassigned' ? null : edit.assignee.name,
            }
          : item;
      }),
    };
  }

  constructor(
    private readonly http: HttpService,
    @Optional() private readonly sources?: MeetingSourcesService,
  ) {}

  async snapshot(forceRefresh = false): Promise<MeetingSnapshot> {
    if (!this.sources) return this.weeklySnapshot(forceRefresh);
    const [weekly, additional] = await Promise.allSettled([
      this.weeklySnapshot(forceRefresh),
      this.sources.load(forceRefresh),
    ]);
    const extra =
      additional.status === 'fulfilled'
        ? additional.value
        : this.sources.current();
    const week = weekly.status === 'fulfilled' ? weekly.value : null;
    if (!week && extra.states.every((s) => s.count === null))
      throw new ServiceUnavailableException('会议归档暂时不可用，请重试');
    const states = [
      {
        source: 'nantong-weekly' as const,
        count: week?.records.length ?? null,
        state: week?.syncState || ('error' as const),
        updatedAt: week?.updatedAt || null,
        message: week?.message || (week ? null : '属地周会读取失败，请重试'),
      },
      ...extra.states,
    ];
    const records = [
      ...(week?.records || []),
      ...extra.meetings.map(summarizeMeeting),
    ];
    return {
      snapshotId: this.combinedId(),
      updatedAt:
        [week?.updatedAt, ...extra.states.map((s) => s.updatedAt)]
          .filter((v): v is string => Boolean(v))
          .sort()
          .at(-1) || new Date().toISOString(),
      syncState: states.some((s) => s.state === 'refreshing')
        ? 'refreshing'
        : states.some((s) => s.state === 'error')
          ? 'error'
          : 'ready',
      message:
        states
          .map((s) => s.message)
          .filter(Boolean)
          .join('；') || null,
      records,
      latestActions: week?.latestActions || null,
      sources: states,
    };
  }

  private combinedId() {
    if (!this.sources) return this.cache?.snapshotId || '';
    return createHash('sha256')
      .update(
        JSON.stringify([
          this.cache?.snapshotId,
          this.sources.current().meetings,
        ]),
      )
      .digest('hex');
  }

  async weeklySnapshot(forceRefresh = false): Promise<MeetingSnapshot> {
    await this.ensureLoaded();
    if (forceRefresh) await this.refresh();
    else if (
      this.cache &&
      this.cache.expiresAt <= Date.now() &&
      Date.now() >= this.retryAfter
    )
      void this.refresh();
    if (!this.cache)
      throw new ServiceUnavailableException('会议归档暂时不可用，请重试');
    return {
      snapshotId: this.cache.snapshotId,
      updatedAt: new Date(this.cache.fetchedAt).toISOString(),
      syncState: this.refreshRead
        ? 'refreshing'
        : this.syncError
          ? 'error'
          : 'ready',
      message: this.syncError,
      records: this.cache.meetings.map(summarizeMeeting),
      latestActions: this.actionsWithOwners(),
    };
  }

  async detail(
    id: string,
    includeDocument = true,
  ): Promise<MeetingDetailResponse> {
    if (id.includes(':') && this.sources) {
      const meeting = await this.sources.detail(id);
      return { snapshotId: this.combinedId(), meeting };
    }
    await this.ensureLoaded();
    const meeting = this.cache?.meetings.find((item) => item.id === id);
    if (!meeting || !this.cache)
      throw new NotFoundException('未找到该会议记录');
    if (!includeDocument)
      return {
        snapshotId: this.combinedId(),
        meeting,
        latestActions: this.actionsWithOwners(),
      };
    this.documentReader ??= new WeeklyDocumentReader(
      this.http,
      WEEKLY_MEETING_SOURCE,
      () => this.documentPeopleLookup?.() || Promise.resolve([]),
    );
    const document = this.documentReader.get(meeting);
    const sections = [
      ...meeting.sections,
      ...document.sections.filter(
        (section) =>
          !meeting.sections.some((existing) => existing.key === section.key),
      ),
    ];
    const order = [
      'current-actions',
      'customer-actions',
      'previous-actions',
      'carryover',
      'management',
      'professional',
      'operations',
    ];
    sections.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
    return {
      snapshotId: this.combinedId(),
      meeting: {
        ...meeting,
        documentUrl: document.url,
        sections,
        hasActions: sections.some((section) => section.isAction),
        sectionTitles: sections.map((section) => section.title),
      },
      documentState: document.state,
      ...(document.state === 'error'
        ? {
            documentMessage:
              '原始周报补读失败，可打开原始周报查看，稍后重新打开重试',
          }
        : {}),
      latestActions: this.actionsWithOwners(),
    };
  }

  async applyWeeklyFields(id: string, fields: Record<string, string>) {
    await this.ensureLoaded();
    const previous = this.cache?.meetings.find((item) => item.id === id);
    if (!previous || !this.cache) throw new NotFoundException('未找到该周报');
    const original: Record<string, unknown> = {
      日期: previous.date,
      第几周: previous.title,
      链接: previous.documentUrl,
      最后更新: new Date().toISOString(),
    };
    for (const section of previous.sections)
      original[section.title === '本周待办' ? '本周代办' : section.title] =
        section.content;
    const meeting = mapWeeklyMeeting({
      record_id: id,
      fields: { ...original, ...fields },
    });
    this.cache.meetings = this.cache.meetings.map((item) =>
      item.id === id ? meeting : item,
    );
    this.cache.snapshotId = createHash('sha256')
      .update(JSON.stringify(this.cache.meetings))
      .digest('hex');
    this.cache.latestActions = latestMeetingActions(this.cache.meetings);
    this.writeVersion += 1;
  }
  async addWeeklyRecord(id: string, fields: Record<string, unknown>) {
    await this.ensureLoaded();
    if (!this.cache)
      throw new ServiceUnavailableException('会议归档暂时不可用');
    const meeting = mapWeeklyMeeting({ record_id: id, fields });
    this.cache.meetings = [
      ...this.cache.meetings.filter((item) => item.id !== id),
      meeting,
    ];
    this.cache.snapshotId = createHash('sha256')
      .update(JSON.stringify(this.cache.meetings))
      .digest('hex');
    this.cache.latestActions = latestMeetingActions(this.cache.meetings);
    this.writeVersion += 1;
  }

  private replace(
    records: BitableRecordItem[],
    fetchedAt: number,
    expiresAt: number,
  ) {
    const meetings = records.map(mapWeeklyMeeting);
    const ids = new Set(meetings.map((item) => item.id));
    if (ids.size !== meetings.length) throw new Error('会议源返回重复记录 ID');
    const snapshotId = createHash('sha256')
      .update(JSON.stringify(meetings))
      .digest('hex');
    this.cache = {
      meetings,
      fetchedAt,
      expiresAt,
      snapshotId,
      latestActions: latestMeetingActions(meetings),
    };
    this.syncError = null;
    this.retryAfter = 0;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.cache) return;
    if (!this.initialRead) {
      this.initialRead = (async () => {
        const persisted = await readLatestPersistedBitableRecordSnapshot({
          ...WEEKLY_MEETING_SOURCE,
          directOnly: true,
        });
        if (persisted) {
          this.replace(
            persisted.records,
            persisted.fetchedAt,
            Math.min(persisted.expiresAt, persisted.fetchedAt + CACHE_TTL_MS),
          );
          return;
        }
        const records = await fetchBitableRecords(this.http, {
          ...WEEKLY_MEETING_SOURCE,
          cacheTtlMs: CACHE_TTL_MS,
          allowStale: false,
          strict: true,
        });
        const now = Date.now();
        this.replace(records, now, now + CACHE_TTL_MS);
      })()
        .catch(() => {
          throw new ServiceUnavailableException('会议归档暂时不可用，请重试');
        })
        .finally(() => {
          this.initialRead = null;
        });
    }
    await this.initialRead;
  }

  private refresh(): Promise<void> {
    if (this.refreshRead) return this.refreshRead;
    this.syncError = null;
    this.refreshRead = (async () => {
      const version = this.writeVersion;
      const records = await fetchBitableRecords(this.http, {
        ...WEEKLY_MEETING_SOURCE,
        cacheTtlMs: CACHE_TTL_MS,
        forceRefresh: true,
        allowStale: false,
        strict: true,
      });
      const now = Date.now();
      if (version !== this.writeVersion) return;
      this.replace(records, now, now + CACHE_TTL_MS);
    })()
      .catch(() => {
        this.syncError = '刷新失败，正在显示上次归档数据；请重试';
        this.retryAfter = Date.now() + 60000;
      })
      .finally(() => {
        this.refreshRead = null;
      });
    return this.refreshRead;
  }
}
