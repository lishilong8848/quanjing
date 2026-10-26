import {
  SYSTEM_APPROVED_LEAVE_ASSIGNMENTS_FIELD,
  SYSTEM_APPROVED_LEAVE_STAFF_FIELD,
  SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD,
  SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD,
  buildCachedLeaveApprovalSnapshot,
  buildLeaveApprovalSnapshot,
  enrichScheduleRecordsWithLeaveApproval,
} from '../../server/common/feishu/leave-approval-source';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scheduleRecord = {
  record_id: 'schedule-1',
  fields: {
    fldZSaDbGf: Date.parse('2026-08-10T00:00:00+08:00'),
    fldnP4gXMn: 'H楼',
    fldE9Gwnk7: '长白',
    fldqPpOgW5: '长白',
    fldJi5bxBG: '请假甲 请假乙',
    fld4xMPICY: '请假甲、请假乙',
    fldZnstUS3: '替班甲、替班乙',
    '值班人员（实际）程序修改': '替班甲 替班乙',
  },
};

describe('leave approval source', () => {
  it('memoizes a parsed local approval snapshot by fetched time and hard age', () => {
    const source = readFileSync(
      join(process.cwd(), 'server/common/feishu/leave-approval-source.ts'),
      'utf8',
    );
    const readerStart = source.indexOf(
      'export async function readCachedLeaveApprovalSnapshot',
    );
    const readerEnd = source.indexOf(
      'export function buildLeaveApprovalSnapshot',
      readerStart,
    );
    const reader = source.slice(readerStart, readerEnd);

    expect(source).toContain('cachedParsedLeaveApprovalSnapshot');
    expect(reader).toContain(
      'cachedParsedLeaveApprovalSnapshot.fetchedAt === snapshot.fetchedAt',
    );
    expect(reader).toContain(
      'cachedParsedLeaveApprovalSnapshot.maxAgeMs === maxAgeMs',
    );
    expect(reader).toContain('nowMs - snapshot.fetchedAt <= maxAgeMs');
  });

  it('uses a fresh local approval snapshot and fails closed after its hard age limit', () => {
    const fetchedAt = Date.parse('2026-08-08T12:00:00+08:00');
    const persistedSnapshot = {
      records: [
        {
          record_id: 'leave-approved-local',
          fields: {
            系统审批完成标记: '审批结束',
            '休假人员（文本）': '请假甲',
            休假开始时间: Date.parse('2026-08-10T09:00:00+08:00'),
            休假结束时间: Date.parse('2026-08-10T18:00:00+08:00'),
            系统影响排班记录ID: 'schedule-1',
          },
        },
      ],
      fetchedAt,
      expiresAt: fetchedAt + 15 * 60 * 1000,
    };

    expect(
      buildCachedLeaveApprovalSnapshot(
        persistedSnapshot,
        fetchedAt + 30 * 60 * 1000,
        60 * 60 * 1000,
      ),
    ).toMatchObject({
      verified: true,
      requests: [expect.objectContaining({ recordId: 'leave-approved-local' })],
    });
    expect(
      buildCachedLeaveApprovalSnapshot(
        persistedSnapshot,
        fetchedAt + 61 * 60 * 1000,
        60 * 60 * 1000,
      ),
    ).toEqual({ verified: false, requests: [] });
  });

  it('uses only approval-complete records and exact impacted schedule ids', () => {
    const snapshot = buildLeaveApprovalSnapshot([
      {
        record_id: 'leave-approved',
        fields: {
          系统审批完成标记: '审批结束',
          '休假人员（文本）': '请假甲',
          休假开始时间: Date.parse('2026-08-10T09:00:00+08:00'),
          休假结束时间: Date.parse('2026-08-10T18:00:00+08:00'),
          机楼: 'H楼',
          班组: '长白',
          '班次（有关联）': '长白',
          '替班人员（填姓名）': '替班甲',
          系统影响排班记录ID: 'schedule-1',
        },
      },
      {
        record_id: 'leave-pending',
        fields: {
          系统审批完成标记: '',
          '休假人员（文本）': '请假乙',
          休假开始时间: Date.parse('2026-08-10T09:00:00+08:00'),
          休假结束时间: Date.parse('2026-08-10T18:00:00+08:00'),
          '替班人员（填姓名）': '替班乙',
          系统影响排班记录ID: 'schedule-1',
        },
      },
    ]);

    const [enriched] = enrichScheduleRecordsWithLeaveApproval(
      [scheduleRecord],
      snapshot,
    );

    expect(enriched.fields?.[SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD]).toBe(true);
    expect(enriched.fields?.[SYSTEM_APPROVED_LEAVE_STAFF_FIELD]).toEqual([
      '请假甲',
    ]);
    expect(enriched.fields?.[SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD]).toEqual([
      '替班甲',
    ]);
  });

  it('maps each approved substitute only to its exact schedule records', () => {
    const snapshot = {
      verified: true,
      requests: [
        {
          recordId: 'rec-leave',
          leaveStaff: ['示例人员012'],
          substituteStaff: ['示例人员008', '示例人员013'],
          startAt: '2026-08-26T09:00',
          endAt: '2026-08-28T09:00',
          building: '',
          team: '',
          shift: '',
          impactedScheduleRecordIds: ['rec-day', 'rec-night'],
          assignmentRevision: 1,
          shiftDetails: [
            {
              shiftKey: '2026-08-26T09:00__2026-08-26T18:00',
              scheduleRecordIds: ['rec-day'],
              substituteStaff: ['示例人员008'],
              revision: 1,
            },
            {
              shiftKey: '2026-08-27T18:00__2026-08-28T09:00',
              scheduleRecordIds: ['rec-night'],
              substituteStaff: ['示例人员013'],
              revision: 1,
            },
          ],
        },
      ],
    };
    const records = ['rec-day', 'rec-night'].map((recordId) => ({
      record_id: recordId,
      fields: {
        fld4xMPICY: '示例人员012',
        fldZSaDbGf: Date.parse('2026-08-26T00:00:00+08:00'),
        fldnP4gXMn: 'A楼',
        fldE9Gwnk7: '一班',
        fldqPpOgW5: '白班',
      },
    }));

    const enriched = enrichScheduleRecordsWithLeaveApproval(records, snapshot);
    expect(
      enriched[0].fields?.[SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD],
    ).toEqual(['示例人员008']);
    expect(
      enriched[1].fields?.[SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD],
    ).toEqual(['示例人员013']);
  });

  it('keeps each leave applicant paired with hours and the exact substitute', () => {
    const snapshot = buildLeaveApprovalSnapshot([
      {
        record_id: 'leave-zhang-san',
        fields: {
          系统审批完成标记: '审批结束',
          '休假人员（文本）': '示例人员008',
          休假开始时间: Date.parse('2026-08-10T09:00:00+08:00'),
          休假结束时间: Date.parse('2026-08-10T14:00:00+08:00'),
          '替班人员（填姓名）': '示例人员017',
          系统影响排班记录ID: 'schedule-1',
        },
      },
      {
        record_id: 'leave-li-si',
        fields: {
          系统审批完成标记: '审批结束',
          '休假人员（文本）': '示例人员013',
          休假开始时间: Date.parse('2026-08-10T09:00:00+08:00'),
          休假结束时间: Date.parse('2026-08-10T18:00:00+08:00'),
          '替班人员（填姓名）': '赵六',
          系统影响排班记录ID: 'schedule-1',
        },
      },
    ]);
    const record = {
      ...scheduleRecord,
      fields: {
        ...scheduleRecord.fields,
        fld4xMPICY: '示例人员008、示例人员013',
      },
    };

    const [enriched] = enrichScheduleRecordsWithLeaveApproval(
      [record],
      snapshot,
    );

    expect(enriched.fields?.[SYSTEM_APPROVED_LEAVE_ASSIGNMENTS_FIELD]).toEqual([
      {
        requestRecordId: 'leave-zhang-san',
        leaveStaffName: '示例人员008',
        substituteStaff: ['示例人员017'],
        startAt: '2026-08-10T09:00',
        endAt: '2026-08-10T14:00',
        leaveHours: 4,
      },
      {
        requestRecordId: 'leave-li-si',
        leaveStaffName: '示例人员013',
        substituteStaff: ['赵六'],
        startAt: '2026-08-10T09:00',
        endAt: '2026-08-10T18:00',
        leaveHours: 8,
      },
    ]);
  });

  it('keeps the full 15-hour night-shift duration in the assignment detail', () => {
    const snapshot = buildLeaveApprovalSnapshot([
      {
        record_id: 'leave-night',
        fields: {
          系统审批完成标记: '审批结束',
          '休假人员（文本）': '夜班甲',
          休假开始时间: Date.parse('2026-08-10T18:00:00+08:00'),
          休假结束时间: Date.parse('2026-08-11T09:00:00+08:00'),
          '替班人员（填姓名）': '夜班乙',
          系统影响排班记录ID: 'schedule-night',
        },
      },
    ]);
    const [enriched] = enrichScheduleRecordsWithLeaveApproval(
      [
        {
          record_id: 'schedule-night',
          fields: {
            fldZSaDbGf: Date.parse('2026-08-10T00:00:00+08:00'),
            fldnP4gXMn: 'H楼',
            fldE9Gwnk7: '一班',
            fldqPpOgW5: '夜班',
            fld4xMPICY: '夜班甲',
          },
        },
      ],
      snapshot,
    );

    expect(enriched.fields?.[SYSTEM_APPROVED_LEAVE_ASSIGNMENTS_FIELD]).toEqual([
      expect.objectContaining({
        requestRecordId: 'leave-night',
        leaveStaffName: '夜班甲',
        substituteStaff: ['夜班乙'],
        leaveHours: 15,
      }),
    ]);
  });

  it('uses the program-card terminal state without depending on a legacy workflow field', () => {
    const snapshot = buildLeaveApprovalSnapshot([
      {
        record_id: 'program-card-pending',
        fields: {
          系统审批完成标记: '审批结束',
          审批来源: '程序卡片',
          请假工作流状态: '待示例人员001审批',
          '休假人员（文本）': '请假甲',
          休假开始时间: Date.parse('2026-08-10T09:00:00+08:00'),
          休假结束时间: Date.parse('2026-08-10T18:00:00+08:00'),
        },
      },
      {
        record_id: 'program-card-approved',
        fields: {
          审批来源: '程序卡片',
          请假工作流状态: '已审批',
          审批进度: '审批中',
          '休假人员（文本）': '请假乙',
          休假开始时间: Date.parse('2026-08-10T09:00:00+08:00'),
          休假结束时间: Date.parse('2026-08-10T18:00:00+08:00'),
        },
      },
    ]);

    expect(snapshot.requests.map((request) => request.recordId)).toEqual([
      'program-card-approved',
    ]);
  });

  it('falls back to authoritative time and scope matching for legacy records', () => {
    const snapshot = buildLeaveApprovalSnapshot([
      {
        record_id: 'legacy-approved',
        fields: {
          系统审批完成标记: '审批结束',
          '休假人员（文本）': '请假甲',
          休假开始时间: Date.parse('2026-08-10T09:00:00+08:00'),
          休假结束时间: Date.parse('2026-08-10T18:00:00+08:00'),
          机楼: 'H楼',
          班组: '长白',
          '班次（有关联）': '长白',
          '替班人员（填姓名）': '替班甲',
        },
      },
    ]);

    const [enriched] = enrichScheduleRecordsWithLeaveApproval(
      [scheduleRecord],
      snapshot,
    );

    expect(enriched.fields?.[SYSTEM_APPROVED_LEAVE_STAFF_FIELD]).toEqual([
      '请假甲',
    ]);
    expect(enriched.fields?.[SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD]).toEqual([
      '替班甲',
    ]);
  });

  it('fails closed when the approval source is unverified', () => {
    const [enriched] = enrichScheduleRecordsWithLeaveApproval(
      [scheduleRecord],
      { verified: false, requests: [] },
    );

    expect(enriched.fields?.[SYSTEM_LEAVE_APPROVAL_VERIFIED_FIELD]).toBe(false);
    expect(enriched.fields?.[SYSTEM_APPROVED_LEAVE_STAFF_FIELD]).toEqual([]);
    expect(enriched.fields?.[SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD]).toEqual(
      [],
    );
  });

  it('does not attach an approved request to a different schedule id', () => {
    const snapshot = buildLeaveApprovalSnapshot([
      {
        record_id: 'approved-for-other-schedule',
        fields: {
          系统审批完成标记: '审批结束',
          '休假人员（文本）': '请假甲',
          休假开始时间: Date.parse('2026-08-10T09:00:00+08:00'),
          休假结束时间: Date.parse('2026-08-10T18:00:00+08:00'),
          系统影响排班记录ID: 'schedule-2',
        },
      },
    ]);

    const [enriched] = enrichScheduleRecordsWithLeaveApproval(
      [scheduleRecord],
      snapshot,
    );

    expect(enriched.fields?.[SYSTEM_APPROVED_LEAVE_STAFF_FIELD]).toEqual([]);
    expect(enriched.fields?.[SYSTEM_APPROVED_SUBSTITUTE_STAFF_FIELD]).toEqual(
      [],
    );
  });

  it('indexes approved requests once instead of rescanning every request per schedule', () => {
    const requests = Array.from({ length: 200 }, (_, index) => ({
      recordId: `leave-${index}`,
      leaveStaff: [index === 199 ? 'target-person' : `other-${index}`],
      substituteStaff: index === 199 ? ['substitute-person'] : [],
      startAt: '2026-08-10T09:00',
      endAt: '2026-08-10T18:00',
      building: '',
      team: '',
      shift: '',
      impactedScheduleRecordIds: index === 199 ? ['schedule-0'] : [],
    }));
    let numericReads = 0;
    const observedRequests = new Proxy(requests, {
      get(target, property, receiver) {
        if (typeof property === 'string' && /^\d+$/u.test(property)) {
          numericReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const records = Array.from({ length: 20 }, (_, index) => ({
      ...scheduleRecord,
      record_id: `schedule-${index}`,
      fields: {
        ...scheduleRecord.fields,
        fld4xMPICY: 'target-person',
      },
    }));

    const enriched = enrichScheduleRecordsWithLeaveApproval(records, {
      verified: true,
      requests: observedRequests,
    });

    expect(enriched[0].fields?.[SYSTEM_APPROVED_LEAVE_STAFF_FIELD]).toEqual([
      'target-person',
    ]);
    expect(numericReads).toBeLessThanOrEqual(requests.length + 20);
  });
});
