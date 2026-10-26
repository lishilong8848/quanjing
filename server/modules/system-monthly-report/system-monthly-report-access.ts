import type { AccessRole } from '../../../shared/access-control.interface';
import { ForbiddenException } from '@nestjs/common';
import type {
  SystemMonthlyReportDashboard,
  SystemMonthlyReportPerson,
  SystemMonthlyReportReviewRound,
  SystemMonthlyReportRoom,
  SystemMonthlyReportStepKey,
} from '../../../shared/system-monthly-report.interface';

export type SystemMonthlyReportAccessSubject =
  | {
      kind: 'privileged';
      role: AccessRole;
      principalFingerprint: string;
    }
  | {
      kind: 'person';
      principalFingerprint: string;
      legacyPrincipalFingerprints?: string[];
      person: { id: string; openId: string; name: string };
    };

export interface SystemMonthlyReportScope {
  subject: SystemMonthlyReportAccessSubject;
  visibleRooms: Set<string>;
  submitRooms: Set<string>;
  manageRooms: Set<string>;
  reviewAssignments: Set<string>;
  canPackage: boolean;
}

const STEP_KEYS: SystemMonthlyReportStepKey[] = [
  'initial_submit',
  'initial_review',
  'recheck_submit',
  'recheck_review',
  'final_submit',
];

export function buildSystemMonthlyReportScope(
  subject: SystemMonthlyReportAccessSubject,
  dashboard: SystemMonthlyReportDashboard,
): SystemMonthlyReportScope {
  if (subject.kind === 'privileged') {
    const allRooms = new Set(dashboard.rooms.map((room) => room.room));
    return {
      subject,
      visibleRooms: allRooms,
      submitRooms: new Set(allRooms),
      manageRooms: new Set(allRooms),
      reviewAssignments: new Set(
        dashboard.schedule.map((item) => assignmentKey(item.room, item.round)),
      ),
      canPackage: true,
    };
  }

  const submitRooms = new Set<string>();
  const manageRooms = new Set<string>();
  const reviewAssignments = new Set<string>();
  const visibleRooms = new Set<string>();
  for (const room of dashboard.rooms) {
    if (hasPerson(room.submitters, subject.person)) {
      submitRooms.add(room.room);
      visibleRooms.add(room.room);
    }
    if (hasPerson(room.leaders, subject.person)) {
      manageRooms.add(room.room);
      submitRooms.add(room.room);
      visibleRooms.add(room.room);
    }
  }
  for (const item of dashboard.schedule) {
    if (!samePerson(item.reviewer, subject.person)) continue;
    reviewAssignments.add(assignmentKey(item.room, item.round));
    visibleRooms.add(item.room);
  }
  return {
    subject,
    visibleRooms,
    submitRooms,
    manageRooms,
    reviewAssignments,
    canPackage: false,
  };
}

export function projectSystemMonthlyReportDashboard(
  dashboard: SystemMonthlyReportDashboard,
  scope: SystemMonthlyReportScope,
): SystemMonthlyReportDashboard {
  const privileged = scope.subject.kind === 'privileged';
  const rooms = dashboard.rooms
    .filter((room) => scope.visibleRooms.has(room.room))
    .map((room) => projectRoom(room, scope, privileged));
  const allowedRooms = new Set(rooms.map((room) => room.room));
  const monthlySnapshots = dashboard.monthlySnapshots.map((snapshot) => {
    const snapshotRooms = snapshot.rooms.filter((room) =>
      allowedRooms.has(room.room),
    );
    return {
      ...snapshot,
      totalRooms: snapshotRooms.length,
      completedRooms: snapshotRooms.filter(
        (room) => room.stages.final_submit.completed,
      ).length,
      stageCompletedRooms: Object.fromEntries(
        STEP_KEYS.map((key) => [
          key,
          snapshotRooms.filter((room) => room.stages[key].completed).length,
        ]),
      ) as typeof snapshot.stageCompletedRooms,
      rooms: snapshotRooms,
    };
  });
  return {
    ...dashboard,
    viewer: {
      mode: privileged ? 'privileged' : 'person',
      person:
        scope.subject.kind === 'person'
          ? { id: scope.subject.person.id, name: scope.subject.person.name }
          : null,
      canPackage: scope.canPackage,
      canForceRefresh: privileged,
    },
    summary: summarizeRooms(rooms),
    rooms,
    schedule: dashboard.schedule
      .filter((item) => allowedRooms.has(item.room))
      .map((item) => ({
        ...item,
        reviewer: privileged ? item.reviewer : redactPerson(item.reviewer),
      })),
    history: dashboard.history.filter((item) => allowedRooms.has(item.room)),
    monthlySnapshots,
    reviewOpinions: dashboard.reviewOpinions
      .filter((item) => allowedRooms.has(item.room))
      .map((item) => ({
        ...item,
        reviewer:
          privileged || !item.reviewer
            ? item.reviewer
            : redactPerson(item.reviewer),
      })),
  };
}

export function assertSystemMonthlyReportSubmissionAuthorized(
  scope: SystemMonthlyReportScope,
  room: string,
): void {
  if (!scope.submitRooms.has(room)) {
    throw new ForbiddenException('无权提交该机房体系月报');
  }
}

export function assertSystemMonthlyReportReviewAuthorized(
  scope: SystemMonthlyReportScope,
  room: string,
  round: SystemMonthlyReportReviewRound,
): void {
  if (
    scope.subject.kind !== 'privileged' &&
    !scope.reviewAssignments.has(assignmentKey(room, round))
  ) {
    throw new ForbiddenException('无权审核该机房或当前轮次');
  }
}

export function assertSystemMonthlyReportRoomReadAuthorized(
  scope: SystemMonthlyReportScope,
  room: string,
): void {
  if (!scope.visibleRooms.has(room)) {
    throw new ForbiddenException('无权查看该机房体系月报');
  }
}

export function isSystemMonthlyReportTaskOwner(
  subject: SystemMonthlyReportAccessSubject,
  principalFingerprint: string,
): boolean {
  return (
    subject.principalFingerprint === principalFingerprint ||
    (subject.kind === 'person' &&
      Boolean(
        subject.legacyPrincipalFingerprints?.includes(principalFingerprint),
      ))
  );
}

function projectRoom(
  room: SystemMonthlyReportRoom,
  scope: SystemMonthlyReportScope,
  privileged: boolean,
): SystemMonthlyReportRoom {
  const reviewRounds: SystemMonthlyReportReviewRound[] = (
    ['initial', 'recheck'] as const
  ).filter(
    (round) =>
      privileged ||
      scope.reviewAssignments.has(assignmentKey(room.room, round)),
  );
  return {
    ...room,
    submitters: privileged
      ? room.submitters
      : room.submitters.map(redactPerson),
    leaders: privileged ? room.leaders : room.leaders.map(redactPerson),
    leader:
      privileged || !room.leader ? room.leader : redactPerson(room.leader),
    initialReviewer:
      privileged || !room.initialReviewer
        ? room.initialReviewer
        : redactPerson(room.initialReviewer),
    recheckReviewer:
      privileged || !room.recheckReviewer
        ? room.recheckReviewer
        : redactPerson(room.recheckReviewer),
    access: {
      canSubmit: scope.submitRooms.has(room.room),
      canDownload: scope.visibleRooms.has(room.room),
      managed: scope.manageRooms.has(room.room),
      reviewRounds,
    },
  };
}

function summarizeRooms(rooms: SystemMonthlyReportRoom[]) {
  const today = new Date().toISOString().slice(0, 10);
  return {
    totalRooms: rooms.length,
    completedRooms: rooms.filter((room) => room.status === 'completed').length,
    inReviewRooms: rooms.filter((room) =>
      ['initial_review', 'recheck_review'].includes(room.status),
    ).length,
    pendingSubmissionRooms: rooms.filter((room) =>
      ['initial_pending', 'recheck_pending', 'final_pending'].includes(
        room.status,
      ),
    ).length,
    overdueRooms: rooms.filter((room) => {
      const current = room.steps.find((step) => step.state === 'current');
      return Boolean(current?.date && current.date < today);
    }).length,
  };
}

function assignmentKey(room: string, round: SystemMonthlyReportReviewRound) {
  return `${room}:${round}`;
}

function hasPerson(
  people: SystemMonthlyReportPerson[],
  person: { openId: string; name: string },
): boolean {
  return people.some((candidate) => samePerson(candidate, person));
}

function samePerson(
  candidate: SystemMonthlyReportPerson,
  person: { openId: string; name: string },
): boolean {
  if (candidate.openId && person.openId)
    return candidate.openId === person.openId;
  return candidate.name === person.name;
}

function redactPerson(
  person: SystemMonthlyReportPerson,
): SystemMonthlyReportPerson {
  return { ...person, openId: '' };
}
