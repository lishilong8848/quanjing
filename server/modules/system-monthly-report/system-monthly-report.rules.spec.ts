import { BadRequestException } from '@nestjs/common';
import type {
  SystemMonthlyReportReviewRequest,
  SystemMonthlyReportSubmissionRequest,
} from '../../../shared/system-monthly-report.interface';
import {
  assertSystemMonthlyReportSubmissionMutationAllowed,
  assertSystemMonthlyReportReviewTransition,
  assertSystemMonthlyReportSemanticReadback,
  assertSystemMonthlyReportSubmissionTransition,
  buildSystemMonthlyReportReviewFields,
  buildSystemMonthlyReportSubmissionFields,
  normalizeSystemMonthlyReportSubmission,
  validateSystemMonthlyReportSubmission,
  validateSystemMonthlyReportReview,
} from './system-monthly-report.rules';

describe('system monthly report write rules', () => {
  it('allows edits only before the next-month 15th Shanghai cutoff', () => {
    expect(() =>
      assertSystemMonthlyReportSubmissionMutationAllowed(
        'completed',
        'final',
        'replace',
        2026,
        8,
        new Date('2026-09-14T15:59:59.999Z'),
      ),
    ).not.toThrow();
    expect(() =>
      assertSystemMonthlyReportSubmissionMutationAllowed(
        'completed',
        'final',
        'replace',
        2026,
        8,
        new Date('2026-09-14T16:00:00.000Z'),
      ),
    ).toThrow(BadRequestException);
  });

  it('locks earlier versions after dependent review opinions are submitted', () => {
    expect(() =>
      assertSystemMonthlyReportSubmissionMutationAllowed(
        'recheck_review',
        'initial',
        'replace',
        2026,
        8,
        new Date('2026-09-01T00:00:00.000Z'),
      ),
    ).not.toThrow();
    expect(() =>
      assertSystemMonthlyReportSubmissionMutationAllowed(
        'final_pending',
        'initial',
        'replace',
        2026,
        8,
        new Date('2026-09-01T00:00:00.000Z'),
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      assertSystemMonthlyReportSubmissionMutationAllowed(
        'final_pending',
        'recheck',
        'replace',
        2026,
        8,
        new Date('2026-09-01T00:00:00.000Z'),
      ),
    ).not.toThrow();
  });

  it('only deletes a version before a later stage depends on it', () => {
    expect(() =>
      assertSystemMonthlyReportSubmissionMutationAllowed(
        'initial_review',
        'initial',
        'delete',
        2026,
        8,
        new Date('2026-09-01T00:00:00.000Z'),
      ),
    ).not.toThrow();
    expect(() =>
      assertSystemMonthlyReportSubmissionMutationAllowed(
        'recheck_pending',
        'initial',
        'delete',
        2026,
        8,
        new Date('2026-09-01T00:00:00.000Z'),
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      assertSystemMonthlyReportSubmissionMutationAllowed(
        'recheck_review',
        'recheck',
        'delete',
        2026,
        8,
        new Date('2026-09-01T00:00:00.000Z'),
      ),
    ).not.toThrow();
  });

  it('only accepts submissions and reviews from their matching workflow state', () => {
    expect(() =>
      assertSystemMonthlyReportSubmissionTransition(
        'initial_pending',
        'initial',
      ),
    ).not.toThrow();
    expect(() =>
      assertSystemMonthlyReportSubmissionTransition(
        'initial_review',
        'initial',
      ),
    ).toThrow(BadRequestException);
    expect(() =>
      assertSystemMonthlyReportSubmissionTransition(
        'recheck_pending',
        'recheck',
      ),
    ).not.toThrow();
    expect(() =>
      assertSystemMonthlyReportSubmissionTransition('final_pending', 'final'),
    ).not.toThrow();

    expect(() =>
      assertSystemMonthlyReportReviewTransition('initial_review', 'initial'),
    ).not.toThrow();
    expect(() =>
      assertSystemMonthlyReportReviewTransition('recheck_review', 'recheck'),
    ).not.toThrow();
    expect(() =>
      assertSystemMonthlyReportReviewTransition('completed', 'recheck'),
    ).toThrow(BadRequestException);
  });

  it('maps each submission stage to the real collection-table attachment field', () => {
    const base: Omit<SystemMonthlyReportSubmissionRequest, 'stage'> = {
      clientMutationId: 'mutation-stage-001',
      currentRecordId: 'rec-current-b',
      room: '南通-B',
      reportYear: 2026,
      reportMonth: 7,
      versionedFileName: '南通-B-2026年07月体系月报-初版.xlsx',
    };

    expect(
      buildSystemMonthlyReportSubmissionFields({ ...base, stage: 'initial' }, [
        'box-initial',
      ]),
    ).toEqual({
      机房: '南通-B',
      月报月份: 7,
      初版月报: [{ file_token: 'box-initial' }],
    });
    expect(
      buildSystemMonthlyReportSubmissionFields(
        {
          ...base,
          stage: 'recheck',
          versionedFileName: '南通-B-2026年07月体系月报-复审版.xlsx',
        },
        ['box-recheck'],
      ),
    ).toEqual({
      机房: '南通-B',
      月报月份: 7,
      复审月报: [{ file_token: 'box-recheck' }],
    });
    expect(
      buildSystemMonthlyReportSubmissionFields(
        {
          ...base,
          stage: 'final',
          versionedFileName: '南通-B-2026年07月体系月报-终版.xlsx',
        },
        ['box-final'],
      ),
    ).toEqual({
      机房: '南通-B',
      月报月份: 7,
      终版月报: [{ file_token: 'box-final' }],
    });
  });

  it('requires the standardized filename to match report period and stage', () => {
    const request: SystemMonthlyReportSubmissionRequest = {
      clientMutationId: 'mutation-stage-002',
      currentRecordId: 'rec-current-b',
      room: '南通-B',
      stage: 'recheck',
      reportYear: 2026,
      reportMonth: 8,
      versionedFileName: '南通-B-2026年08月体系月报-复审版.xlsx',
    };
    expect(() => validateSystemMonthlyReportSubmission(request)).not.toThrow();
    expect(() =>
      validateSystemMonthlyReportSubmission({
        ...request,
        versionedFileName: '南通-B-2026年08月体系月报-初版.xlsx',
      }),
    ).toThrow(BadRequestException);
  });

  it('normalizes arbitrary client and upload names from the report identity', () => {
    const normalized = normalizeSystemMonthlyReportSubmission(
      {
        clientMutationId: 'mutation-normalize-001',
        currentRecordId: 'rec-current-b',
        room: ' 昆山 ',
        stage: 'initial',
        reportYear: 2026,
        reportMonth: 8,
        versionedFileName: '客户端随便填写的名字.pdf',
      },
      '阿里IDC5.0架构-适配当下及未来的技术方案.pdf',
    );

    expect(normalized.fileName).toBe('昆山-2026年08月体系月报-初版.pdf');
    expect(normalized.request).toMatchObject({
      room: '昆山',
      versionedFileName: '昆山-2026年08月体系月报-初版.pdf',
    });
    expect(() =>
      validateSystemMonthlyReportSubmission(normalized.request),
    ).not.toThrow();
  });

  it('maps initial review modules, relation and completion fields to the real form schema', () => {
    const request = reviewRequest('initial');
    const fields = buildSystemMonthlyReportReviewFields(request, {
      event: ['box-event'],
      other: ['box-other'],
    });

    expect(fields).toMatchObject({
      机房: '南通-B',
      审核关联: ['rec-current-b'],
      '初审：事件模块是否有问题': '是',
      '初审：事件模块': '事件台账缺少闭环时间',
      '初审：事件模块截图': [{ file_token: 'box-event' }],
      '初审：变更模块是否有问题': '否',
      '初审：是否有其他问题': '是',
      '初审：其他问题截图': [{ file_token: 'box-other' }],
      初审确认提交: '是',
      初审审核: true,
    });
    expect(String(fields.初审意见)).toContain('事件管理：事件台账缺少闭环时间');
    expect(fields.初审问题截图).toEqual([
      { file_token: 'box-event' },
      { file_token: 'box-other' },
    ]);
  });

  it('uses the recheck form field family without leaking initial-review fields', () => {
    const request = reviewRequest('recheck');
    const fields = buildSystemMonthlyReportReviewFields(request, {
      event: ['box-event'],
      other: ['box-other'],
    });

    expect(fields).toMatchObject({
      审核关联: ['rec-current-b'],
      '复审：事件模块是否有问题': '是',
      '复审：事件模块截图': [{ file_token: 'box-event' }],
      复审确认提交: '是',
    });
    expect(fields).not.toHaveProperty('初审审核');
    expect(fields).not.toHaveProperty('初审确认提交');
  });

  it('rejects an issue without both description and screenshot before upload', () => {
    const request = reviewRequest('initial');
    request.modules.event.description = '';

    expect(() =>
      validateSystemMonthlyReportReview(request, { event: ['event.png'] }),
    ).toThrow(BadRequestException);

    request.modules.event.description = '事件问题';
    expect(() => validateSystemMonthlyReportReview(request, {})).toThrow(
      BadRequestException,
    );
  });

  it('semantically compares links, selects and attachments without raw-json deep equality', () => {
    expect(() =>
      assertSystemMonthlyReportSemanticReadback(
        {
          机房: '南通-B',
          审核关联: ['rec-current-b'],
          复审月报: [{ file_token: 'box-recheck' }],
        },
        {
          机房: [{ text: '南通-B', type: 'text' }],
          审核关联: [{ record_id: 'rec-current-b', text: '南通-B-561' }],
          复审月报: [
            { file_token: 'box-recheck', name: '南通-B-7月复审版.xlsx' },
          ],
        },
      ),
    ).not.toThrow();

    expect(() =>
      assertSystemMonthlyReportSemanticReadback(
        { 终版月报: [{ file_token: 'box-final' }] },
        { 终版月报: [{ file_token: 'box-other' }] },
      ),
    ).toThrow('终版月报');
  });
});

function reviewRequest(
  round: SystemMonthlyReportReviewRequest['round'],
): SystemMonthlyReportReviewRequest {
  return {
    clientMutationId: `mutation-review-${round}`,
    currentRecordId: 'rec-current-b',
    room: '南通-B',
    round,
    completed: true,
    modules: {
      event: { hasIssue: true, description: '事件台账缺少闭环时间' },
      change: { hasIssue: false, description: '' },
      maintenance: { hasIssue: false, description: '' },
      drill: { hasIssue: false, description: '' },
      other: { hasIssue: true, description: '风险记录缺少负责人' },
    },
  };
}
