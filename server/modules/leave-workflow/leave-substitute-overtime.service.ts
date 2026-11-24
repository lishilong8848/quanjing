import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  containsExactPersonName, createLeaveRequestShiftGroups, parseShanghaiLocalDateTime,
  resolveLeaveScheduleKind,
} from '@shared/leave-request-impact';
import { calculateOvertimePayableHours, calculateOvertimeRequestImpact } from '@shared/overtime-request-impact';
import { calculateSubstituteOvertimeRequirement, type SubstituteOvertimeInterval } from '@shared/substitute-overtime-policy';
import { extractDisplayText } from '../../common/feishu/bitable-direct-read';
import { BitableSyncService } from '../bitable-sync/bitable-sync.service';
import { OvertimeWorkflowGateway, type OvertimeBitableRecord } from '../overtime-workflow/overtime-workflow.gateway';
import { OvertimeWorkflowService } from '../overtime-workflow/overtime-workflow.service';
import { OvertimeWorkflowStore } from '../overtime-workflow/overtime-workflow.store';
import { withOvertimeSubmissionLock } from '../overtime-workflow/overtime-submission-lock';
import { LeaveWorkflowGateway } from './leave-workflow.gateway';
import type { LeaveWorkflowApplicationEntry } from './leave-workflow.store';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const AUTO_PREFIX = 'overtime-request-leave-';
const WITHDRAWN = new Set(['已撤回', '已撤销', '已取消', '已作废', '已驳回']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const leavePrefix = (id: string) => AUTO_PREFIX + hash(id).slice(0, 24) + '-';
const fieldText = (fields: Record<string, unknown>, name: string) => extractDisplayText(fields[name]).trim();

function requireInterval(start: string, end: string): SubstituteOvertimeInterval {
  const startMs = parseShanghaiLocalDateTime(start)?.epochMs ?? Date.parse(start);
  const endMs = parseShanghaiLocalDateTime(end)?.epochMs ?? Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs % HOUR || endMs % HOUR ||
      startMs >= endMs || endMs - startMs > 366 * DAY) {
    throw new ServiceUnavailableException('替班加班时段无效，请核对原申请日期和班次');
  }
  return { startMs, endMs };
}

function checkedDate(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = extractDisplayText(value).trim();
  return /^\d{13}$/u.test(text) ? Number(text) : parseShanghaiLocalDateTime(text)?.epochMs ?? Date.parse(text);
}

function intervalOf(row: OvertimeBitableRecord): SubstituteOvertimeInterval {
  const startMs = checkedDate(row.fields.加班开始时间);
  const endMs = checkedDate(row.fields.加班结束时间);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new ServiceUnavailableException('已有加班时段无法核对，暂未生成替班加班');
  }
  return { startMs, endMs };
}

function personId(row: OvertimeBitableRecord): string {
  const ids = row.fields.加班人员;
  return Array.isArray(ids) && ids.length === 1 ? String(ids[0]?.id || ids[0]?.open_id || '') : '';
}

function applicationState(row: OvertimeBitableRecord) {
  const status = fieldText(row.fields, '加班工作流状态');
  const progress = fieldText(row.fields, '加班流程进展');
  if (WITHDRAWN.has(status) || WITHDRAWN.has(progress)) return 'cancelled' as const;
  if (['已审批', '待确认', '已确认'].includes(status) || ['已审批', '已确认'].includes(progress)) {
    const actual = row.fields.实际加班时长;
    if (status === '已确认' && actual !== undefined && actual !== null && String(actual).trim() !== '' && Number(actual) === 0) return 'cancelled' as const;
    return 'approved' as const;
  }
  if (['', '待路由', '待审批'].includes(status) && ['', '申请中', '待审批'].includes(progress)) return 'pending' as const;
  throw new ServiceUnavailableException('已有加班申请状态无法核对');
}

function groupIntervals(intervals: SubstituteOvertimeInterval[]): SubstituteOvertimeInterval[] {
  const result: SubstituteOvertimeInterval[] = [];
  for (const next of intervals.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)) {
    const previous = result.at(-1);
    if (previous && next.startMs <= previous.endMs) previous.endMs = Math.max(previous.endMs, next.endMs);
    else result.push({ ...next });
  }
  return result;
}

@Injectable()
export class LeaveSubstituteOvertimeService {
  private readonly logger = new Logger(LeaveSubstituteOvertimeService.name);

  constructor(
    private readonly bitable: BitableSyncService,
    private readonly leaveGateway: LeaveWorkflowGateway,
    private readonly gateway: OvertimeWorkflowGateway,
    private readonly workflow: OvertimeWorkflowService,
    private readonly store: OvertimeWorkflowStore,
  ) {}

  async sync(application: LeaveWorkflowApplicationEntry, revision: number): Promise<void> {
    const names = (application.snapshot.shiftAssignments ?? []).flatMap(row => [
      row.substituteName, ...(row.originalPostBackfills ?? []).map(backup => backup.substituteName),
    ]);
    await withOvertimeSubmissionLock([leavePrefix(application.recordId), ...names], () => this.syncLocked(application, revision));
  }

  private async syncLocked(application: LeaveWorkflowApplicationEntry, revision: number): Promise<void> {
    if (!this.workflow.isEnabled()) throw new ServiceUnavailableException('加班审批工作流尚未启用');
    const schedule = application.snapshot;
    const prefix = leavePrefix(application.recordId);
    if (await this.sourceState(application) !== 'current') {
      await this.retireOwned(prefix, await this.gateway.readSubstitutionOvertimeRecords());
      return;
    }
    const leave = requireInterval(schedule.startAt, schedule.endAt);
    const shifts = new Map<string, SubstituteOvertimeInterval[]>();
    const add = (id: string, startAt: string, endAt: string, scope?: SubstituteOvertimeInterval) => {
      if (!id) throw new ServiceUnavailableException('替班人员身份无法核验');
      let { startMs, endMs } = requireInterval(startAt, endAt);
      if (scope) {
        startMs = Math.max(startMs, scope.startMs);
        endMs = Math.min(endMs, scope.endMs);
      }
      if (startMs < endMs) shifts.set(id, [...(shifts.get(id) ?? []), { startMs, endMs }]);
    };
    for (const assignment of schedule.shiftAssignments ?? []) {
      add(assignment.substituteOpenId, assignment.startAt, assignment.endAt, leave);
      for (const backup of assignment.originalPostBackfills ?? []) {
        add(backup.substituteOpenId, backup.group.startAt, backup.group.endAt);
      }
    }
    if (!shifts.size && schedule.substituteOpenId && !schedule.shiftAssignments?.length) {
      // Legacy approved records are not precise enough to create extra hours.
      throw new ServiceUnavailableException('请先核对逐班替班安排，再生成加班申请');
    }
    if (!shifts.size) {
      await this.retireOwned(prefix, await this.gateway.readSubstitutionOvertimeRecords());
      return;
    }
    const periods = [...shifts.values()].flat();
    const date = (ms: number) => new Date(ms + 8 * HOUR).toISOString().slice(0, 10);
    const from = Math.min(...periods.map(row => row.startMs)) - DAY;
    const through = Math.max(...periods.map(row => row.endMs - 1));
    const startDate = date(from);
    const endDate = date(through);
    const [recorded, people, schedules] = await Promise.all([
      this.gateway.readSubstitutionOvertimeRecords(),
      this.bitable.readSubstituteOvertimePersonnel(),
      this.bitable.getCachedLeaveRequestImpactSchedules(startDate, endDate, { originalOnly: true }),
    ]);
    const owned = this.ownedRows(prefix, recorded);
    const coveredDays = new Set(schedules.map(row => row.scheduleDate));
    for (let day = Date.parse(startDate); day <= Date.parse(endDate); day += DAY) {
      if (!coveredDays.has(new Date(day).toISOString().slice(0, 10))) throw new ServiceUnavailableException('原始排班未覆盖替班加班核对范围');
    }
    const retained = new Set<string>();
    const desired: Array<{ id: string; fingerprint: string; interval: SubstituteOvertimeInterval; person: typeof people[number] }> = [];
    for (const [id, intervals] of shifts) {
      const person = people.find(row => row.openId === id);
      const workPattern = person?.shift === '长白' ? 'long_white' : /^[ABCD]班$/u.test(person?.shift ?? '') ? 'rotating' : null;
      if (!person || !workPattern || people.filter(row => row.name === person.name).length !== 1 ||
          people.filter(row => row.openId === id).length !== 1) {
        throw new ServiceUnavailableException('替班人员的身份或本班排班无法唯一核验');
      }
      const original = schedules.filter(row => row.dutyStaffActual.some(name => containsExactPersonName(name, person.name)))
        .flatMap(row => {
          const kind = resolveLeaveScheduleKind(row);
          if (!kind || !row.scheduleDate) throw new ServiceUnavailableException('替班人正常班次无法核验');
          if (kind === 'long_white') return []; // The work calendar supplies long-white normal hours.
          const group = createLeaveRequestShiftGroups([{
            recordId: row.recordId, date: row.scheduleDate, building: row.building || '', team: row.team || '',
            shift: row.shiftText || row.shift || '', kind, scheduledHours: 0, leaveHours: 0, countedHours: 0,
          }])[0];
          return [{ ...requireInterval(group.startAt, group.endAt), staffUserId: id, source: 'original' as const }];
        });
      const applications = recorded.filter(row =>
        personId(row) === id || fieldText(row.fields, '加班人员姓名') === person.name).flatMap(row => {
          const status = applicationState(row);
          if (status === 'cancelled') return [];
          if (personId(row) !== id) throw new ServiceUnavailableException('同名加班人员身份无法核对');
          const own = fieldText(row.fields, '请求唯一ID').startsWith(prefix);
          if (own && status === 'pending') return [];
          return [{ ...intervalOf(row), staffUserId: id, status, ownRecordId: own ? row.recordId : '' }];
        });
      for (const substitute of groupIntervals(intervals)) {
        const input = { staff: { userId: id, workPattern }, substitute, schedules: original } as const;
        const expected = calculateSubstituteOvertimeRequirement({ ...input, applications: [] });
        if (expected.status === 'needs_review') throw new ServiceUnavailableException('替班加班时段或原始排班无法核对');
        for (const prior of applications) {
          if (prior.ownRecordId && expected.unappliedIntervals.some(period =>
            period.startMs <= prior.startMs && prior.endMs <= period.endMs)) retained.add(prior.ownRecordId);
        }
        const requirement = calculateSubstituteOvertimeRequirement({ ...input, applications });
        if (requirement.status === 'needs_review') throw new ServiceUnavailableException('替班加班时段或已有申请无法核对');
        for (const interval of requirement.unappliedIntervals) {
          const impact = calculateOvertimeRequestImpact(schedules, {
            staffName: person.name, staffShift: person.shift ?? '',
            startAt: new Date(interval.startMs).toISOString(), endAt: new Date(interval.endMs).toISOString(),
          });
          if (!impact.canSubmit) throw new ServiceUnavailableException('替班加班不符合现有工时或连班校验，请人工核对');
          const fingerprint = hash(JSON.stringify([id, interval.startMs, interval.endMs]));
          const mutationId = prefix + revision + '-' + fingerprint.slice(0, 32);
          const existing = owned.find(row => fieldText(row.fields, '请求唯一ID') === mutationId) ??
            owned.find(row => fieldText(row.fields, '请求指纹') === fingerprint && applicationState(row) !== 'cancelled');
          if (existing) {
            retained.add(existing.recordId);
            if (applicationState(existing) !== 'pending') continue;
          }
          desired.push({ id: existing ? fieldText(existing.fields, '请求唯一ID') : mutationId, fingerprint, interval, person });
        }
      }
    }
    // Verify once more before changing either workflow. New rows are written
    // only after obsolete pending rows have been retired.
    if (await this.sourceState(application) !== 'current') {
      await this.retireOwned(prefix, owned);
      return;
    }
    await this.retireOwned(prefix, owned.filter(row => !retained.has(row.recordId)));
    for (const { id, fingerprint, interval, person } of desired) {
      const reason = '请休假替班自动申请';
      const hours = calculateOvertimePayableHours(interval.startMs, interval.endMs);
      const matches = owned.filter(row => fieldText(row.fields, '请求唯一ID') === id);
      if (matches.length > 1) throw new ServiceUnavailableException('系统替班加班申请重复，请核对');
      const recordId = matches[0]?.recordId ?? await this.gateway.createSubstitutionOvertimeRecord({
        加班人员: [{ id: person.openId }], 加班人员姓名: person.name,
        加班开始时间: interval.startMs, 加班结束时间: interval.endMs, 加班时长: hours,
        加班原因: reason, 请求唯一ID: id, 请求指纹: fingerprint,
      }, id);
      const record = await this.gateway.readOvertimeRecord(recordId);
      const persisted = intervalOf(record);
      if (record.recordId !== recordId || personId(record) !== person.openId || fieldText(record.fields, '请求唯一ID') !== id ||
          fieldText(record.fields, '请求指纹') !== fingerprint ||
          persisted.startMs !== interval.startMs || persisted.endMs !== interval.endMs) {
        throw new ServiceUnavailableException('替班加班写入回执待核对');
      }
      if (applicationState(record) !== 'pending') continue;
      await this.workflow.acceptSubstitutionApplication(id, {
        recordId, applicantName: person.name, applicantOpenId: person.openId,
        building: person.buildings[0] || '', position: person.position,
        plannedStartAt: new Date(interval.startMs).toISOString(),
        plannedEndAt: new Date(interval.endMs).toISOString(), plannedHours: hours, reason,
      });
    }
  }

  async reconcileChangedSources(applications: LeaveWorkflowApplicationEntry[], readCurrent: (id: string) => Promise<LeaveWorkflowApplicationEntry | null>): Promise<void> {
    if (!this.workflow.isEnabled()) return;
    const pending = new Set((await this.store.listApplications())
      .filter(row => row.clientMutationId.startsWith(AUTO_PREFIX) &&
        (row.phase !== 'source_deleted' || Boolean(row.lastError)))
      .map(row => row.clientMutationId.slice(0, AUTO_PREFIX.length + 25)));
    if (!pending.size) return;
    for (const application of applications) {
      const prefix = leavePrefix(application.recordId);
      if (!pending.has(prefix)) continue;
      try {
        await withOvertimeSubmissionLock([prefix], async () => {
          const current = await readCurrent(application.recordId);
          if (current && await this.sourceState(current) !== 'current') {
            await this.retireOwned(prefix, await this.gateway.readSubstitutionOvertimeRecords());
          }
        });
      } catch (error) {
        this.logger.warn(`替班加班来源待核对 ${application.recordId} ${error instanceof Error ? error.message.slice(0, 120) : ''}`);
      }
    }
  }

  private async sourceState(application: LeaveWorkflowApplicationEntry): Promise<'current' | 'changed'> {
    const current = await this.leaveGateway.readLeaveRecordIfExists(application.recordId);
    if (!current || application.status === 'rejected') return 'changed';
    const status = fieldText(current.fields, '请假工作流状态');
    if (WITHDRAWN.has(status) || ['待路由', '待主管审批', '待经理审批'].includes(status)) return 'changed';
    if (status !== '已审批' || application.status !== 'approved') {
      throw new ServiceUnavailableException('请休假审批状态尚未核验');
    }
    const expected = requireInterval(application.snapshot.startAt, application.snapshot.endAt);
    const start = checkedDate(current.fields.休假开始时间);
    const end = checkedDate(current.fields.休假结束时间);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new ServiceUnavailableException('请休假起止时间尚未核验');
    const assigned = application.snapshot.shiftAssignments ?? [];
    const namesField = '替班人员（填姓名）';
    if (assigned.length && Object.hasOwn(current.fields, namesField)) {
      const names = fieldText(current.fields, namesField).split(/[、,，]/u).map(name => name.trim()).filter(Boolean);
      const expectedNames = new Set(assigned.map(row => row.substituteName));
      if (new Set(names).size !== expectedNames.size || names.some(name => !expectedNames.has(name))) return 'changed';
    }
    return start === expected.startMs && end === expected.endMs ? 'current' : 'changed';
  }

  private ownedRows(prefix: string, rows: OvertimeBitableRecord[]) {
    return rows.filter(row => fieldText(row.fields, '请求唯一ID').startsWith(prefix));
  }

  private async retireOwned(prefix: string, rows: OvertimeBitableRecord[]): Promise<void> {
    let needsReview = false;
    for (const row of this.ownedRows(prefix, rows)) {
      const state = applicationState(row);
      if (state === 'cancelled') {
        if (fieldText(row.fields, '加班工作流错误').endsWith('本笔自动加班申请已撤回')) {
          const local = await this.store.getApplication(row.recordId);
          if (local?.phase === 'source_deleted' && local.lastError) {
            await this.workflow.retireSubstitutionApplication(row.recordId, local.clientMutationId);
          }
        }
        continue;
      }
      if (state === 'approved') {
        const message = '替班已调整，关联加班已审批或确认，请人工核对';
        if (fieldText(row.fields, '加班工作流错误') !== message) {
          await this.gateway.updateOvertimeRecord(row.recordId, { 加班工作流错误: message });
        }
        needsReview = true;
        continue;
      }
      await this.workflow.retireSubstitutionApplication(row.recordId, fieldText(row.fields, '请求唯一ID'));
    }
    if (needsReview) this.logger.warn(`替班已调整，关联加班已审批或确认，请人工核对 (${prefix})`);
  }
}
