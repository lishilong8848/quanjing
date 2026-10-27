import { ForbiddenException } from '@nestjs/common';
import type {
  SystemMonthlyReportDashboard,
  SystemMonthlyReportRoom,
} from '../../../shared/system-monthly-report.interface';
import {
  assertSystemMonthlyReportReviewAuthorized,
  assertSystemMonthlyReportSubmissionAuthorized,
  buildSystemMonthlyReportScope,
  isSystemMonthlyReportTaskOwner,
  projectSystemMonthlyReportDashboard,
} from './system-monthly-report-access';

describe('system monthly report person scope', () => {
  const dashboard = buildDashboard();

  it('keeps the administrator view complete', () => {
    const scope = buildSystemMonthlyReportScope(
      {
        kind: 'privileged',
        role: 'admin',
        principalFingerprint: 'admin-session',
      },
      dashboard,
    );

    expect(
      projectSystemMonthlyReportDashboard(dashboard, scope).rooms,
    ).toHaveLength(7);
    expect(scope.canPackage).toBe(true);
  });

  it('lets Shi Xiaodong submit Nantong-A and only see the rooms related to him', () => {
    const scope = buildSystemMonthlyReportScope(
      personSubject('person-shi', 'ou_shi', '施小东'),
      dashboard,
    );
    const projected = projectSystemMonthlyReportDashboard(dashboard, scope);

    expect([...scope.visibleRooms]).toEqual(['南通-A']);
    expect([...scope.submitRooms]).toEqual(['南通-A']);
    expect(projected.rooms.map((room) => room.room)).toEqual(['南通-A']);
    expect(projected.summary.totalRooms).toBe(1);
    expect(projected.rooms[0].access).toMatchObject({
      canSubmit: true,
      canDownload: true,
      reviewRounds: [],
    });
    expect(() =>
      assertSystemMonthlyReportSubmissionAuthorized(scope, '南通-B'),
    ).toThrow(ForbiddenException);
  });

  it('adds an assigned Kunshan recheck without granting other review rounds', () => {
    const scope = buildSystemMonthlyReportScope(
      personSubject('person-shi', 'ou_shi', '施小东'),
      {
        ...dashboard,
        schedule: [
          ...dashboard.schedule,
          schedule(
            'schedule-kunshan-recheck',
            '昆山',
            'recheck',
            'ou_shi',
            '施小东',
          ),
        ],
      },
    );

    expect([...scope.visibleRooms]).toEqual(['南通-A', '昆山']);
    expect([...scope.reviewAssignments]).toEqual(['昆山:recheck']);
    expect(() =>
      assertSystemMonthlyReportReviewAuthorized(scope, '昆山', 'recheck'),
    ).not.toThrow();
    expect(() =>
      assertSystemMonthlyReportReviewAuthorized(scope, '昆山', 'initial'),
    ).toThrow(ForbiddenException);
  });

  it('lets Nantong leaders view and submit A-E without exposing unrelated rooms', () => {
    const scope = buildSystemMonthlyReportScope(
      personSubject('person-ma', 'ou_ma', '马进宇'),
      dashboard,
    );
    const projected = projectSystemMonthlyReportDashboard(dashboard, scope);

    expect([...scope.manageRooms]).toEqual([
      '南通-A',
      '南通-B',
      '南通-C',
      '南通-D',
      '南通-E',
    ]);
    expect(projected.rooms.map((room) => room.room)).toEqual([
      '南通-A',
      '南通-B',
      '南通-C',
      '南通-D',
      '南通-E',
    ]);
    expect(projected.reviewOpinions.map((opinion) => opinion.room)).toEqual([
      '南通-A',
      '南通-E',
    ]);
    expect(projected.history.map((item) => item.room)).toEqual([
      '南通-A',
      '南通-E',
    ]);
    expect(
      projected.rooms.every((room) => room.access?.canSubmit === true),
    ).toBe(true);
    expect(() =>
      assertSystemMonthlyReportSubmissionAuthorized(scope, '南通-A'),
    ).not.toThrow();
  });

  it('lets Ding Xintuan submit the Kunshan report as its room leader', () => {
    const scope = buildSystemMonthlyReportScope(
      personSubject('person-dingxin', 'ou_dingxin', '丁心团'),
      dashboard,
    );
    const projected = projectSystemMonthlyReportDashboard(dashboard, scope);

    expect([...scope.visibleRooms]).toEqual(['昆山']);
    expect([...scope.manageRooms]).toEqual(['昆山']);
    expect([...scope.submitRooms]).toEqual(['昆山']);
    expect(projected.rooms[0].access).toMatchObject({
      canSubmit: true,
      managed: true,
    });
    expect(() =>
      assertSystemMonthlyReportSubmissionAuthorized(scope, '昆山'),
    ).not.toThrow();
  });

  it('recomputes historical totals after filtering and never exposes Open IDs', () => {
    const scope = buildSystemMonthlyReportScope(
      personSubject('person-shi', 'ou_shi', '施小东'),
      dashboard,
    );
    const projected = projectSystemMonthlyReportDashboard(dashboard, scope);

    expect(projected.monthlySnapshots[0]).toMatchObject({
      totalRooms: 1,
      completedRooms: 1,
      stageCompletedRooms: {
        initial_submit: 1,
        initial_review: 1,
        recheck_submit: 1,
        recheck_review: 1,
        final_submit: 1,
      },
    });
    expect(JSON.stringify(projected)).not.toContain('ou_shi');
    expect(JSON.stringify(projected)).not.toContain('ou_ma');
  });

  it('accepts only the stable person principal or one of its legacy sessions', () => {
    const subject = {
      ...personSubject('person-dingxin', 'ou_dingxin', '丁心团'),
      principalFingerprint: 'smr-person:stable',
      legacyPrincipalFingerprints: [
        'smr-person:legacy-current',
        'smr-person:legacy-previous',
      ],
    };

    expect(isSystemMonthlyReportTaskOwner(subject, 'smr-person:stable')).toBe(
      true,
    );
    expect(
      isSystemMonthlyReportTaskOwner(subject, 'smr-person:legacy-previous'),
    ).toBe(true);
    expect(
      isSystemMonthlyReportTaskOwner(subject, 'smr-person:someone-else'),
    ).toBe(false);
  });
});

function personSubject(id: string, openId: string, name: string) {
  return {
    kind: 'person' as const,
    principalFingerprint: `session-${id}`,
    person: { id, openId, name },
  };
}

function schedule(
  recordId: string,
  room: string,
  round: 'initial' | 'recheck',
  openId: string,
  name: string,
) {
  return {
    recordId,
    year: 2026,
    month: 8,
    round,
    room,
    reviewerRoom: '南通-A',
    reviewer: { openId, name },
    reviewDate: null,
  };
}

function buildDashboard(): SystemMonthlyReportDashboard {
  const rooms = [
    room('南通-A', 'ou_shi', '施小东', ['ou_ma', 'ou_mei']),
    room('南通-B', 'ou_chen', '陈继猛', ['ou_ma', 'ou_mei']),
    room('南通-C', 'ou_sun', '孙婷婷', ['ou_ma', 'ou_mei']),
    room('南通-D', 'ou_tao', '陶必亮', ['ou_ma', 'ou_mei']),
    room('南通-E', 'ou_chenkai', '陈凯', ['ou_ma', 'ou_mei']),
    room('昆山', 'ou_gu', '顾晓磊', ['ou_dingxin']),
    room('宿州', 'ou_wu', '武时聪', ['ou_wu']),
  ];
  const completedStages = {
    initial_submit: {
      completed: true,
      completedAt: '2026-09-01T01:00:00.000Z',
    },
    initial_review: {
      completed: true,
      completedAt: '2026-09-02T01:00:00.000Z',
    },
    recheck_submit: {
      completed: true,
      completedAt: '2026-09-03T01:00:00.000Z',
    },
    recheck_review: {
      completed: true,
      completedAt: '2026-09-04T01:00:00.000Z',
    },
    final_submit: { completed: true, completedAt: '2026-09-05T01:00:00.000Z' },
  };
  return {
    generatedAt: '2026-08-30T00:00:00.000Z',
    sourceUpdatedAt: '2026-08-30T00:00:00.000Z',
    stale: false,
    period: {
      year: 2026,
      month: 8,
      label: '2026年8月体系月报',
      reminderDate: null,
      initialDueDate: null,
      recheckDueDate: null,
      finalDueDate: null,
      calendarSupported: true,
      milestones: [],
    },
    summary: {
      totalRooms: rooms.length,
      completedRooms: rooms.length,
      inReviewRooms: 0,
      pendingSubmissionRooms: 0,
      overdueRooms: 0,
    },
    rooms,
    schedule: [],
    standards: [],
    history: ['南通-A', '南通-E', '昆山'].map((roomName, index) => ({
      recordId: `history-${index}`,
      year: 2026,
      month: 8,
      room: roomName,
      createdAt: null,
      finalSubmittedAt: null,
      initialAttachmentCount: 1,
      recheckAttachmentCount: 1,
      finalAttachmentCount: 1,
      archiveStatus: 'archived' as const,
      archivedAttachmentCount: 1,
      attachments: [],
    })),
    monthlySnapshots: [
      {
        year: 2026,
        month: 8,
        totalRooms: rooms.length,
        completedRooms: rooms.length,
        stageCompletedRooms: {
          initial_submit: rooms.length,
          initial_review: rooms.length,
          recheck_submit: rooms.length,
          recheck_review: rooms.length,
          final_submit: rooms.length,
        },
        rooms: rooms.map((item) => ({
          room: item.room,
          stages: completedStages,
        })),
        milestones: [],
      },
    ],
    reviewOpinions: ['南通-A', '南通-E', '昆山'].map((roomName, index) => ({
      recordId: `opinion-${index}`,
      year: 2026,
      month: 8,
      room: roomName,
      round: 'initial' as const,
      reviewer: { openId: 'ou_reviewer', name: '审核人' },
      submittedAt: '2026-09-02T01:00:00.000Z',
      summary: '通过',
      conclusion: 'passed' as const,
      issues: [],
      images: [],
    })),
    warnings: [],
  };
}

function room(
  roomName: string,
  submitterOpenId: string,
  submitterName: string,
  leaderOpenIds: string[],
): SystemMonthlyReportRoom {
  const leaders = leaderOpenIds.map((openId) => ({
    openId,
    name:
      openId === 'ou_ma' ? '马进宇' : openId === 'ou_mei' ? '梅冰冰' : '十夫长',
  }));
  return {
    recordId: `record-${roomName}`,
    code: roomName,
    room: roomName,
    status: 'completed',
    statusLabel: '已完成',
    currentOwnerRole: '归档人',
    currentOwnerName: submitterName,
    latestAt: null,
    submitters: [{ openId: submitterOpenId, name: submitterName }],
    leaders,
    leader: leaders[0] || null,
    initialReviewer: null,
    recheckReviewer: null,
    issueSummary: { initial: '', recheck: '' },
    steps: [],
  };
}
