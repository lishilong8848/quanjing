import { Injectable } from '@nestjs/common';
import type { AttendanceHistoryResponse } from '@shared/attendance-history.interface';
import { AttendanceAutomationFeishuGateway } from './attendance-automation-feishu.gateway';
import { buildAttendanceHistoryResponse } from './attendance-history.model';

const CACHE_TTL_MS = 2 * 60 * 1_000;

@Injectable()
export class AttendanceHistoryService {
  private readonly active = new Map<
    string,
    Promise<AttendanceHistoryResponse>
  >();
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: AttendanceHistoryResponse }
  >();

  constructor(
    private readonly attendanceGateway: AttendanceAutomationFeishuGateway,
  ) {}

  getHistory(
    startDate: string,
    endDate: string,
    forceRefresh = false,
  ): Promise<AttendanceHistoryResponse> {
    const key = `${startDate}:${endDate}`;
    const cached = this.cache.get(key);
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return Promise.resolve(cached.value);
    }
    const current = this.active.get(key);
    if (current) return current;

    let execution!: Promise<AttendanceHistoryResponse>;
    execution = this.load(startDate, endDate, key, forceRefresh).finally(() => {
      if (this.active.get(key) === execution) this.active.delete(key);
    });
    this.active.set(key, execution);
    return execution;
  }

  private async load(
    startDate: string,
    endDate: string,
    key: string,
    forceRefresh: boolean,
  ): Promise<AttendanceHistoryResponse> {
    const summary = await this.attendanceGateway.readArchivedAttendancePeriod(
      startDate,
      endDate,
      forceRefresh,
    );
    const value = buildAttendanceHistoryResponse(summary);
    this.cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, value });
    return value;
  }
}
