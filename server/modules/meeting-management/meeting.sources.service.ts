import {
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import {
  fetchBitableRecords,
  readLatestPersistedBitableRecordSnapshot,
} from '../../common/feishu/bitable-direct-read';
import type {
  MeetingDetail,
  MeetingSourceState,
} from '../../../shared/meeting-management.interface';
import {
  ADDITIONAL_MEETING_SOURCES,
  mapAdditionalMeeting,
} from './meeting.sources.mapper';

type Source = (typeof ADDITIONAL_MEETING_SOURCES)[number];
interface Entry {
  meetings: MeetingDetail[] | null;
  fetchedAt: number;
  expiresAt: number;
  pending: Promise<void> | null;
  error: string | null;
  retryAfter: number;
}
const TTL = 300000;
@Injectable()
export class MeetingSourcesService {
  private readonly entries = new Map<string, Entry>();
  constructor(private readonly http: HttpService) {}
  private entry(source: Source) {
    let entry = this.entries.get(source.source);
    if (!entry) {
      entry = {
        meetings: null,
        fetchedAt: 0,
        expiresAt: 0,
        pending: null,
        error: null,
        retryAfter: 0,
      };
      this.entries.set(source.source, entry);
    }
    return entry;
  }
  async load(force = false) {
    await Promise.all(
      ADDITIONAL_MEETING_SOURCES.map(async (source) => {
        const entry = this.entry(source);
        if (force || entry.meetings === null) await this.read(source, force);
        if (
          entry.meetings !== null &&
          entry.expiresAt <= Date.now() &&
          entry.retryAfter <= Date.now()
        )
          void this.read(source, true);
      }),
    );
    return this.current();
  }
  current(): { meetings: MeetingDetail[]; states: MeetingSourceState[] } {
    return {
      meetings: ADDITIONAL_MEETING_SOURCES.flatMap(
        (s) => this.entry(s).meetings || [],
      ),
      states: ADDITIONAL_MEETING_SOURCES.map((s) => {
        const e = this.entry(s);
        return {
          source: s.source,
          count: e.meetings?.length ?? null,
          state: e.pending ? 'refreshing' : e.error ? 'error' : 'ready',
          updatedAt: e.fetchedAt ? new Date(e.fetchedAt).toISOString() : null,
          message: e.error,
        };
      }),
    };
  }
  async detail(id: string) {
    const source = ADDITIONAL_MEETING_SOURCES.find((s) =>
      id.startsWith(`${s.source}:`),
    );
    if (!source) throw new NotFoundException('未找到该会议记录');
    const entry = this.entry(source);
    if (entry.meetings === null) await this.read(source, false);
    const meeting = entry.meetings?.find((m) => m.id === id);
    if (entry.meetings === null)
      throw new ServiceUnavailableException(
        entry.error || '会议数据暂时不可用',
      );
    if (!meeting)
      throw new NotFoundException(entry.error || '未找到该会议记录');
    return meeting;
  }
  private read(source: Source, force: boolean): Promise<void> {
    const entry = this.entry(source);
    if (entry.pending) return entry.pending;
    if (!force && entry.error && entry.retryAfter > Date.now())
      return Promise.resolve();
    entry.pending = (async () => {
      const persisted = !force
        ? await readLatestPersistedBitableRecordSnapshot({
            ...source,
            directOnly: true,
          })
        : null;
      const records =
        persisted?.records ||
        (await fetchBitableRecords(this.http, {
          ...source,
          cacheTtlMs: TTL,
          strict: true,
          allowStale: false,
          forceRefresh: force,
        }));
      const meetings = records.map((r) => mapAdditionalMeeting(r, source));
      if (new Set(meetings.map((m) => m.id)).size !== meetings.length)
        throw new Error('重复记录 ID');
      entry.meetings = meetings;
      entry.fetchedAt = persisted?.fetchedAt || Date.now();
      entry.expiresAt = Math.min(
        persisted?.expiresAt ?? entry.fetchedAt + TTL,
        entry.fetchedAt + TTL,
      );
      entry.error = null;
      entry.retryAfter = 0;
    })()
      .catch(() => {
        entry.error = `${source.label}读取失败${entry.meetings ? '，显示上次数据' : '，请重试'}`;
        entry.retryAfter = Date.now() + 60000;
      })
      .finally(() => {
        entry.pending = null;
      });
    return entry.pending;
  }
}
