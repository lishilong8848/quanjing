import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SystemMonthlyReportDashboard } from '../../../shared/system-monthly-report.interface';
import { SystemMonthlyReportIdentityStore } from './system-monthly-report-identity.store';
import { SystemMonthlyReportIdentityService } from './system-monthly-report-identity.service';

describe('system monthly report identity service', () => {
  let directory = '';
  let service: SystemMonthlyReportIdentityService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'system-monthly-identity-service-'));
    service = new SystemMonthlyReportIdentityService(
      new SystemMonthlyReportIdentityStore(join(directory, 'sessions.json')),
    );
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('publishes only stable aliases and display names from matrix and schedule people', () => {
    const identities = service.list(buildDashboard()).identities;

    expect(identities.map((item) => item.name)).toEqual([
      '丁晓杰',
      '马进宇',
      '施小东',
    ]);
    expect(
      identities.every((item) => /^person_[a-f0-9]{24}$/u.test(item.id)),
    ).toBe(true);
    expect(JSON.stringify(identities)).not.toContain('ou_');
  });

  it('resolves an issued session to the internal stable person and invalidates removed people', () => {
    const dashboard = buildDashboard();
    const shi = service
      .list(dashboard)
      .identities.find((item) => item.name === '施小东');
    expect(shi).toBeDefined();

    const issued = service.select(shi!.id, dashboard, 1_000);
    expect(issued.person).toEqual(shi);
    expect(service.resolve(issued.token, dashboard, 1_001)).toMatchObject({
      kind: 'person',
      person: { id: shi!.id, openId: 'ou_shi', name: '施小东' },
      principalFingerprint: expect.stringMatching(/^smr-person:/u),
    });
    expect(
      service.resolve(issued.token, { ...dashboard, rooms: [] }, 1_001),
    ).toBeNull();
  });

  it('rejects an alias that is not in the current personnel directory', () => {
    expect(() =>
      service.select(
        'person_000000000000000000000000',
        buildDashboard(),
        1_000,
      ),
    ).toThrow('人员不存在或已移出月报范围');
  });
});

function buildDashboard(): SystemMonthlyReportDashboard {
  return {
    generatedAt: '',
    sourceUpdatedAt: '',
    stale: false,
    period: {
      year: 2026,
      month: 8,
      label: '',
      reminderDate: null,
      initialDueDate: null,
      recheckDueDate: null,
      finalDueDate: null,
      calendarSupported: true,
      milestones: [],
    },
    summary: {
      totalRooms: 1,
      completedRooms: 0,
      inReviewRooms: 0,
      pendingSubmissionRooms: 1,
      overdueRooms: 0,
    },
    rooms: [
      {
        recordId: 'rec-a',
        code: '南通-A',
        room: '南通-A',
        status: 'initial_pending',
        statusLabel: '待月报提交',
        currentOwnerRole: '可提报人员',
        currentOwnerName: '施小东',
        latestAt: null,
        submitters: [{ openId: 'ou_shi', name: '施小东' }],
        leaders: [{ openId: 'ou_ma', name: '马进宇' }],
        leader: { openId: 'ou_ma', name: '马进宇' },
        initialReviewer: null,
        recheckReviewer: null,
        issueSummary: { initial: '', recheck: '' },
        steps: [],
      },
    ],
    schedule: [
      {
        recordId: 'schedule-kunshan',
        year: 2026,
        month: 8,
        round: 'initial',
        room: '昆山',
        reviewerRoom: '南通-E',
        reviewer: { openId: 'ou_ding', name: '丁晓杰' },
        reviewDate: null,
      },
    ],
    standards: [],
    history: [],
    monthlySnapshots: [],
    reviewOpinions: [],
    warnings: [],
  };
}
