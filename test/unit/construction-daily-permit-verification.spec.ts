import type {
  ConstructionAttachmentGroup,
  ConstructionOverviewItem,
} from '../../shared/api.interface';
import {
  DAILY_PERMIT_DEFINITIONS,
  getDailyPermitAuditDetails,
  getBlockingDailyPermitIssues,
  getDailyPermitAuditSummary,
  getDailyPermitInvalidDetails,
  getDailyPermitChecklistItems,
  getDailyPermitNextRefreshDelay,
  getDailyPermitRenewalFileFields,
  getDailyFollowupStageRequiredFileKeys,
  getDailyPermitSummary,
  getDailyPermitVerificationTone,
  getDailyPermitVerifications as deriveDailyPermitVerifications,
  getRequiredDailyPermitRenewalFileKeys,
  isDailyFollowupStageAllowedByPermits,
} from '../../client/src/pages/ConstructionManagement/daily-permit-verification';
import { buildConstructionPermitManualReviewFingerprint } from '../../server/modules/duty-schedule/construction-management';

const getDailyPermitVerifications = (
  item: ConstructionOverviewItem | null,
  referenceDate: Date = new Date(),
  confirmedWorkTypes?: readonly string[] | null,
) =>
  deriveDailyPermitVerifications(item, referenceDate, confirmedWorkTypes, true);

function buildPermitAttachment(
  label: string,
  feedback: string | null,
  fileName: string | null = `${label}.jpg`,
  manualReview: ConstructionAttachmentGroup['manualReview'] = null,
): ConstructionAttachmentGroup {
  const files = fileName
    ? [{ fileToken: `${label}-token`, name: fileName, size: 128 }]
    : [];
  return {
    field: label,
    label,
    count: files.length,
    files,
    status: 'complete',
    feedback,
    manualReview,
  };
}

function buildConstruction(
  feedbacks: Array<{
    label: string;
    feedback: string | null;
    updatedAt: string;
    fileName?: string | null;
    manualReview?: ConstructionAttachmentGroup['manualReview'];
  }>,
  workTypes: string[] = ['一般作业', '高处作业'],
): ConstructionOverviewItem {
  return {
    recordId: 'recConstruction',
    constructionCode: 'SG260505-1031',
    workContent: 'EA118-A楼挖潜机房施工',
    building: 'A楼',
    specialty: '其他',
    contractorType: '外部',
    workTypes,
    relatedWorkType: null,
    planStartTime: '2026-05-28T05:40:00.000Z',
    planEndTime: '2026-06-30T05:40:00.000Z',
    remainingDays: 32,
    approval: {
      supervisor: '通过',
      ehsNotified: '已知会',
      ehs: '通过',
      credential: '通过',
      depositConfirmation: '无需缴纳',
      parkSync: '已同步',
      depositPaid: '否',
    },
    deposit: { amount: null, deducted: null, balance: null },
    managers: {
      supervisor: '楼栋主管',
      safety: 'EHS',
      park: '园区经理',
      applicant: '申请人',
      engineer: '工程师',
    },
    createdBy: null,
    createdAt: null,
    updatedAt: null,
    recordUrl: null,
    applicationAttachments: [],
    constructionIssues: [],
    completionChecklistArchive: [],
    crewMembers: [],
    followups: feedbacks.map((item, index) => ({
      recordId: `recFollowup${index}`,
      title: '申请材料',
      constructionCode: 'SG260505-1031',
      workContent: 'EA118-A楼挖潜机房施工',
      workTypes,
      overviewRecordIds: ['recConstruction'],
      constructionDay: null,
      isLatest: index === feedbacks.length - 1,
      followupStaff: null,
      followupStaffMembers: [],
      completed: null,
      dailyPersonnelCheck: null,
      isolationCompliant: null,
      isolationFeedback: null,
      processFeedback: null,
      closingFeedback: null,
      closingApproval: null,
      createdAt: item.updatedAt,
      updatedAt: item.updatedAt,
      recordUrl: null,
      attachments: [
        buildPermitAttachment(
          item.label,
          item.feedback,
          item.fileName,
          item.manualReview || null,
        ),
      ],
      aiIssues: [],
    })),
    latestFollowup: null,
  };
}

describe('construction daily permit verification', () => {
  const today = new Date('2026-05-29T08:00:00+08:00');

  it('schedules the next permit refresh after the local date changes', () => {
    const delay = getDailyPermitNextRefreshDelay(
      new Date(2026, 5, 3, 23, 59, 58, 500),
    );

    expect(delay).toBe(2500);
  });

  it('blocks process stage when a required height work permit expired yesterday', () => {
    const item = buildConstruction([
      {
        label: '高处作业许可证',
        feedback: '审核结果：通过；有效期至：2026-05-28；问题清单：无',
        updatedAt: '2026-05-28T06:03:00.000Z',
      },
    ]);

    const verifications = getDailyPermitVerifications(item, today);
    const [heightPermit] = verifications;

    expect(heightPermit.status).toBe('expired');
    expect(heightPermit.blocksProcess).toBe(true);
    expect(heightPermit.message).toContain('已过期');
    expect(getBlockingDailyPermitIssues(verifications)).toHaveLength(1);
    expect(isDailyFollowupStageAllowedByPermits('prepare', verifications)).toBe(
      true,
    );
    expect(isDailyFollowupStageAllowedByPermits('process', verifications)).toBe(
      false,
    );
  });

  it('warns but does not block when a permit expires tomorrow', () => {
    const item = buildConstruction([
      {
        label: '高处作业许可证',
        feedback: '审核结果：通过；有效期到5月30号；问题清单：无',
        updatedAt: '2026-05-29T06:03:00.000Z',
      },
    ]);

    const [heightPermit] = getDailyPermitVerifications(item, today);

    expect(heightPermit.status).toBe('expiresTomorrow');
    expect(heightPermit.blocksProcess).toBe(false);
    expect(heightPermit.requiresRenewal).toBe(false);
    expect(getDailyPermitVerificationTone(heightPermit)).toBe('valid');
    expect(heightPermit.message).toContain('明天即将过期');
  });

  it('does not require renewal upload when a permit expires today', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback: '审核结果：通过；有效期至：2026-05-29；问题清单：无',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ],
      ['一般作业', '动火作业'],
    );

    const verifications = getDailyPermitVerifications(item, today);
    const [hotWorkPermit] = verifications;

    expect(hotWorkPermit.status).toBe('expiresToday');
    expect(hotWorkPermit.blocksProcess).toBe(false);
    expect(hotWorkPermit.requiresRenewal).toBe(false);
    expect(getDailyPermitVerificationTone(hotWorkPermit)).toBe('valid');
    expect(getDailyPermitRenewalFileFields(verifications)).toEqual([]);
    expect(getRequiredDailyPermitRenewalFileKeys(verifications)).toEqual([]);
  });

  it('filters permit checks by the daily confirmed work types', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback: '审核结果：通过；有效期至：2026-06-30；问题清单：无',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
        {
          label: '高处作业许可证',
          feedback: '审核结果：通过；有效期至：2026-06-30；问题清单：无',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ],
      ['一般作业', '动火作业', '高处作业'],
    );

    const heightOnly = getDailyPermitVerifications(item, today, ['高处作业']);
    const hotWorkOnly = getDailyPermitVerifications(item, today, ['动火作业']);

    expect(heightOnly.map((verification) => verification.label)).toEqual([
      '高处作业许可证',
    ]);
    expect(hotWorkOnly.map((verification) => verification.label)).toEqual([
      '动火许可证',
    ]);
  });

  it('uses a recognized validity date even when the audit conclusion asks for manual review', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '结论：需人工复核；有效期至：2026-10-11；问题：票面信息需人工核验',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(item, today);

    expect(hotWorkPermit.status).toBe('valid');
    expect(hotWorkPermit.expiryDate).toBe('2026-10-11');
    expect(hotWorkPermit.requiresRenewal).toBe(false);
    expect(hotWorkPermit.blocksProcess).toBe(false);
    expect(getDailyPermitVerificationTone(hotWorkPermit)).toBe('valid');
  });

  it('carries a passed manual permit review across the unchanged permit period', () => {
    const item = buildConstruction([
      {
        label: '高处作业许可证',
        feedback:
          '核验日期：2026-06-10；核验版本：6；结论：通过；有效期至：2026-06-18；说明：高处作业许可证有效期未过期；问题：无',
        updatedAt: '2026-06-10T02:00:00.000Z',
        manualReview: {
          field: '人员审核-高处作业许可证',
          fingerprintField: '人员审核票据标识-高处作业许可证',
          reviewed: true,
          value: 'true',
          fingerprint: null,
          expectedFingerprint: null,
        },
      },
    ]);

    const [heightPermit] = getDailyPermitVerifications(
      item,
      new Date('2026-06-12T08:00:00+08:00'),
    );

    expect(heightPermit.status).toBe('valid');
    expect(heightPermit.expiryDate).toBe('2026-06-18');
    expect(heightPermit.manualReview).toMatchObject({
      status: 'passed',
      reviewed: true,
      matched: true,
    });
  });

  it('lets passed manual review override a rejected AI permit audit', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '结论：不通过；有效期至：2026-06-30；问题清单：动火许可证审核未通过，请重新上传',
          updatedAt: '2026-06-04T02:00:00.000Z',
          manualReview: {
            field: '人工审核-动火许可票',
            fingerprintField: '人工审核票据标识-动火许可票',
            reviewed: true,
            value: '通过',
            fingerprint: null,
            expectedFingerprint: null,
          },
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(
      item,
      new Date('2026-06-04T08:00:00+08:00'),
    );

    expect(hotWorkPermit.status).toBe('valid');
    expect(hotWorkPermit.blocksProcess).toBe(false);
    expect(hotWorkPermit.requiresRenewal).toBe(false);
    expect(hotWorkPermit.sourceText).toContain('结论：不通过');
    expect(hotWorkPermit.manualReview).toMatchObject({
      status: 'passed',
      reviewed: true,
      matched: true,
    });
    expect(hotWorkPermit.message).toContain('人工审核通过');
  });

  it('uses the human-confirmed validity date instead of the AI-recognized date', () => {
    const manualReview = {
      field: '人工审核-动火许可票',
      fingerprintField: '人工审核票据标识-动火许可票',
      reviewed: true,
      value: '通过',
      fingerprint: null,
      expectedFingerprint: null,
      validUntil: '2026-06-30',
    } as ConstructionAttachmentGroup['manualReview'];
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '结论：不通过；有效期至：2026-05-31；问题清单：有效期无法识别',
          updatedAt: '2026-06-04T02:00:00.000Z',
          manualReview,
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(
      item,
      new Date('2026-06-04T08:00:00+08:00'),
    );

    expect(hotWorkPermit.status).toBe('valid');
    expect(hotWorkPermit.expiryDate).toBe('2026-06-30');
  });

  it('requires manual re-review when a previously approved permit is expired today', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '核验日期：2026-06-10；核验版本：6；结论：通过；有效期至：2026-06-10；说明：动火许可证有效期未过期；问题：无',
          updatedAt: '2026-06-10T06:03:00.000Z',
          manualReview: {
            field: '人工审核-动火许可票',
            fingerprintField: '人工审核票据标识-动火许可票',
            reviewed: true,
            value: '通过',
            fingerprint: null,
            expectedFingerprint: null,
          },
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(
      item,
      new Date('2026-06-11T08:00:00+08:00'),
    );

    expect(hotWorkPermit.status).toBe('pendingReview');
    expect(hotWorkPermit.expiryDate).toBe('2026-06-10');
    expect(hotWorkPermit.blocksProcess).toBe(true);
    expect(hotWorkPermit.requiresRenewal).toBe(false);
    expect(hotWorkPermit.manualReview).toMatchObject({
      status: 'pending',
      reviewed: false,
      matched: false,
    });
    expect(hotWorkPermit.message).toContain('需今日重新人工审核');
  });

  it('accepts today manual re-review for an expired permit when the fingerprint matches', () => {
    const referenceDate = new Date('2026-06-11T08:00:00+08:00');
    const expiredItem = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '核验日期：2026-06-10；核验版本：6；结论：通过；有效期至：2026-06-10；说明：动火许可证有效期未过期；问题：无',
          updatedAt: '2026-06-10T06:03:00.000Z',
          manualReview: {
            field: '人工审核-动火许可票',
            fingerprintField: '人工审核票据标识-动火许可票',
            reviewed: true,
            value: '通过',
            fingerprint: null,
            expectedFingerprint: null,
          },
        },
      ],
      ['一般作业', '动火作业'],
    );
    const [expiredPermit] = getDailyPermitVerifications(
      expiredItem,
      referenceDate,
    );
    const todayFingerprint = expiredPermit.manualReview.expectedFingerprint;

    const reviewedTodayItem = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '核验日期：2026-06-10；核验版本：6；结论：通过；有效期至：2026-06-10；说明：动火许可证有效期未过期；问题：无',
          updatedAt: '2026-06-11T02:03:00.000Z',
          manualReview: {
            field: '人工审核-动火许可票',
            fingerprintField: '人工审核票据标识-动火许可票',
            reviewed: true,
            value: '通过',
            fingerprint: todayFingerprint,
            expectedFingerprint: todayFingerprint,
          },
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(
      reviewedTodayItem,
      referenceDate,
    );

    expect(hotWorkPermit.status).toBe('valid');
    expect(hotWorkPermit.blocksProcess).toBe(false);
    expect(hotWorkPermit.manualReview).toMatchObject({
      status: 'passed',
      reviewed: true,
      matched: true,
    });
  });

  it('marks a rejected AI permit audit invalid when manual review rejects it', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '结论：不通过；有效期至：2026-05-31；问题清单：动火许可证审核未通过，请重新上传',
          updatedAt: '2026-06-04T02:00:00.000Z',
          manualReview: {
            field: '人工审核-动火许可票',
            fingerprintField: '人工审核票据标识-动火许可票',
            reviewed: false,
            value: '驳回',
            fingerprint: null,
            expectedFingerprint: null,
          },
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(
      item,
      new Date('2026-06-04T08:00:00+08:00'),
    );

    expect(hotWorkPermit.status).toBe('invalid');
    expect(hotWorkPermit.blocksProcess).toBe(true);
    expect(hotWorkPermit.sourceText).toContain('结论：不通过');
    expect(hotWorkPermit.manualReview).toMatchObject({
      status: 'rejected',
      reviewed: true,
      matched: true,
    });
    expect(hotWorkPermit.message).toContain('人工审核驳回');
  });

  it('keeps a permit waiting for manual review when the manual field is empty', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '结论：不通过；有效期至：2026-05-31；问题清单：动火许可证审核未通过，请重新上传',
          updatedAt: '2026-06-04T02:00:00.000Z',
          manualReview: {
            field: '人工审核-动火许可票',
            fingerprintField: '人工审核票据标识-动火许可票',
            reviewed: false,
            value: null,
            fingerprint: null,
            expectedFingerprint: null,
          },
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(
      item,
      new Date('2026-06-04T08:00:00+08:00'),
    );

    expect(hotWorkPermit.status).toBe('pendingReview');
    expect(hotWorkPermit.blocksProcess).toBe(true);
    expect(hotWorkPermit.requiresRenewal).toBe(false);
    expect(hotWorkPermit.sourceText).toContain('结论：不通过');
    expect(hotWorkPermit.manualReview).toMatchObject({
      status: 'pending',
      reviewed: false,
      matched: false,
    });
    expect(hotWorkPermit.message).toContain('待人工审核');
  });

  it('tracks the follow-up record that owns the displayed permit file', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '审核结果：不通过；有效期至：2026-06-18；问题清单：需人工复核',
          updatedAt: '2026-05-28T06:03:00.000Z',
          fileName: '动火作业票.jpg',
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(item, today);

    expect(hotWorkPermit.files).toEqual([
      expect.objectContaining({ name: '动火作业票.jpg' }),
    ]);
    expect(hotWorkPermit.sourceFollowupRecordId).toBe('recFollowup0');
  });

  it('uses the latest manual review value from today even when the permit file is from an earlier follow-up', () => {
    const fingerprint = buildConstructionPermitManualReviewFingerprint(
      [{ file_token: '临时用电作业许可证-token' }],
      '2026-06-19',
    );
    const item = buildConstruction(
      [
        {
          label: '临时用电作业许可证',
          feedback:
            '审核结果：不通过；有效期至：2026-06-19；问题清单：需人工复核',
          updatedAt: '2026-06-03T06:03:00.000Z',
          fileName: '临时用电作业票.jpg',
        },
        {
          label: '临时用电作业许可证',
          feedback: null,
          updatedAt: '2026-06-04T06:03:00.000Z',
          fileName: null,
          manualReview: {
            field: '人工审核-临时用电许可证',
            fingerprintField: '人工审核票据标识-临时用电许可证',
            reviewed: true,
            value: '通过',
            fingerprint,
            expectedFingerprint: fingerprint,
          },
        },
      ],
      ['一般作业', '临时用电作业'],
    );

    const [tempPowerPermit] = getDailyPermitVerifications(item, today);

    expect(tempPowerPermit.status).toBe('valid');
    expect(tempPowerPermit.manualReview).toMatchObject({
      status: 'passed',
      fingerprint,
    });
    expect(tempPowerPermit.files).toEqual([
      expect.objectContaining({ name: '临时用电作业票.jpg' }),
    ]);
  });

  it('requires manual re-review when a reviewed permit fingerprint no longer matches', () => {
    const item = buildConstruction([
      {
        label: '高处作业许可证',
        feedback:
          '核验日期：2026-06-11；核验版本：6；结论：通过；有效期至：2026-06-30；说明：高处作业许可证有效期未过期；问题：无',
        updatedAt: '2026-06-11T02:00:00.000Z',
        fileName: '新高处作业票.jpg',
        manualReview: {
          field: '人员审核-高处作业许可证',
          fingerprintField: '人员审核票据标识-高处作业许可证',
          reviewed: true,
          value: 'true',
          fingerprint: 'v1:old-permit',
          expectedFingerprint: 'v1:old-permit',
        },
      },
    ]);

    const [heightPermit] = getDailyPermitVerifications(
      item,
      new Date('2026-06-12T08:00:00+08:00'),
    );

    expect(heightPermit.status).toBe('pendingReview');
    expect(heightPermit.blocksProcess).toBe(true);
    expect(heightPermit.manualReview).toMatchObject({
      status: 'stale',
      reviewed: true,
      matched: false,
    });
    expect(heightPermit.manualReview.message).toContain('重新人工审核');
  });

  it('allows uploading a new permit when the validity period needs manual verification', () => {
    const verifications = getDailyPermitVerifications(
      buildConstruction([
        {
          label: '高处作业许可证',
          feedback:
            '审核结果：通过；有效期至：未识别；问题清单：需人工核验票面有效期',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ]),
      today,
    );
    const [heightPermit] = verifications;

    expect(heightPermit.status).toBe('unknown');
    expect(heightPermit.blocksProcess).toBe(false);
    expect(heightPermit.requiresRenewal).toBe(true);
    expect(getDailyPermitRenewalFileFields(verifications)).toEqual([
      ['heightWorkPermitFiles', '高处作业许可证新作业票'],
    ]);
    expect(getRequiredDailyPermitRenewalFileKeys(verifications)).toEqual([]);
  });

  it('verifies temporary power permits for temporary power work', () => {
    const [temporaryPowerPermit] = getDailyPermitVerifications(
      buildConstruction(
        [
          {
            label: '临时用电作业许可证',
            feedback: '审核结果：通过；有效期至：2026-06-30；问题清单：无',
            updatedAt: '2026-05-29T06:03:00.000Z',
          },
        ],
        ['一般作业', '临时用电作业'],
      ),
      today,
    );

    expect(temporaryPowerPermit.label).toBe('临时用电作业许可证');
    expect(temporaryPowerPermit.fileKey).toBe('temporaryPowerPermitFiles');
    expect(temporaryPowerPermit.status).toBe('valid');
    expect(temporaryPowerPermit.blocksProcess).toBe(false);
  });

  it('exposes temporary power permit new ticket uploads when validity is unknown', () => {
    const verifications = getDailyPermitVerifications(
      buildConstruction(
        [
          {
            label: '临时用电作业许可证',
            feedback:
              '结论：需人工复核；有效期至：未识别；问题：票面信息需人工核验',
            updatedAt: '2026-05-29T06:03:00.000Z',
          },
        ],
        ['一般作业', '临时用电作业'],
      ),
      today,
    );

    expect(getDailyPermitRenewalFileFields(verifications)).toEqual([
      ['temporaryPowerPermitFiles', '临时用电作业许可证新作业票'],
    ]);
  });

  it('keeps renewal upload metadata for invalid or expired permits outside the daily form', () => {
    const expiringTomorrow = getDailyPermitVerifications(
      buildConstruction([
        {
          label: '高处作业许可证',
          feedback: '审核结果：通过；有效期到5月30号；问题清单：无',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ]),
      today,
    );
    const invalidHotWork = getDailyPermitVerifications(
      buildConstruction(
        [
          {
            label: '动火许可证',
            feedback: '审核结果：不通过；问题清单：未识别动火许可证',
            updatedAt: '2026-05-29T06:03:00.000Z',
          },
        ],
        ['一般作业', '动火作业'],
      ),
      today,
    );

    expect(getDailyPermitRenewalFileFields(expiringTomorrow)).toEqual([]);
    expect(getRequiredDailyPermitRenewalFileKeys(expiringTomorrow)).toEqual([]);
    expect(getRequiredDailyPermitRenewalFileKeys(invalidHotWork)).toEqual([
      'hotWorkPermitFiles',
    ]);
  });

  it('does not append permit upload fields during daily prepare', () => {
    const verifications = getDailyPermitVerifications(
      buildConstruction(
        [
          {
            label: '动火许可证',
            feedback:
              '审核结果：不通过；有效期至：2026-05-31；问题清单：有效期已过期',
            updatedAt: '2026-06-03T06:03:00.000Z',
          },
          {
            label: '临时用电作业许可证',
            feedback: '审核结果：通过；有效期至：2026-06-19；问题清单：无',
            updatedAt: '2026-06-03T06:03:00.000Z',
          },
          {
            label: '高处作业许可证',
            feedback: '审核结果：通过；有效期至：2026-06-04；问题清单：无',
            updatedAt: '2026-06-03T06:03:00.000Z',
          },
        ],
        ['一般作业', '动火作业', '临时用电作业', '高处作业'],
      ),
      new Date('2026-06-03T09:00:00+08:00'),
    );

    expect(getDailyPermitRenewalFileFields(verifications)).toEqual([
      ['hotWorkPermitFiles', '动火许可证新作业票'],
    ]);
    expect(
      getDailyFollowupStageRequiredFileKeys(
        'prepare',
        ['isolationPhotoFiles'],
        verifications,
      ),
    ).toEqual(['isolationPhotoFiles']);
  });

  it('does not treat date-like attachment filenames as a valid permit period', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback: null,
          updatedAt: '2026-05-29T06:03:00.000Z',
          fileName: 'screenshot-20250210-114637.png',
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(item, today);

    expect(hotWorkPermit.status).toBe('invalid');
    expect(hotWorkPermit.expiryDate).toBeNull();
    expect(hotWorkPermit.blocksProcess).toBe(true);
    expect(hotWorkPermit.message).toContain('已上传，待人工审核');
  });

  it('keeps failed audit feedback invalid even when a date is present', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '审核结果：不通过；有效期至：2026-10-11；问题清单：未识别动火许可证，文件不符合审核要求',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(item, today);

    expect(hotWorkPermit.status).toBe('invalid');
    expect(hotWorkPermit.expiryDate).toBeNull();
    expect(hotWorkPermit.blocksProcess).toBe(true);
    expect(hotWorkPermit.message).toContain('审核未通过');
  });

  it('does not reject a permit only because the vision audit API failed', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '结论：需人工复核；有效期至：未识别；问题：票面信息需人工核验；视觉审核失败：Request failed with status code 403',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(item, today);

    expect(hotWorkPermit.status).toBe('unknown');
    expect(hotWorkPermit.blocksProcess).toBe(false);
    expect(getDailyPermitAuditSummary(hotWorkPermit)).toBe(
      '需人工复核：票面信息待核验',
    );
    expect(getDailyPermitAuditSummary(hotWorkPermit)).not.toContain('403');
  });

  it('does not reject legacy comma-separated manual review text as invalid', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '结论：需人工复核、有效期至：未识别、说明：自动审核已接收动火许可证材料（动作作业票.jpg）、问题：票面信息需人工核验、视觉审核失败：Request failed with status code 403',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(item, today);

    expect(hotWorkPermit.status).toBe('unknown');
    expect(getDailyPermitInvalidDetails(hotWorkPermit)).toBeNull();
  });

  it('extracts specific details for an invalid permit', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '审核结果：不通过；有效期至：2026-10-11；问题清单：未识别动火许可证，文件不符合审核要求；建议：重新上传清晰完整的动火许可证',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(item, today);

    expect(hotWorkPermit.status).toBe('invalid');
    expect(getDailyPermitInvalidDetails(hotWorkPermit)).toEqual({
      reason: '未识别动火许可证，文件不符合审核要求',
      suggestion: '重新上传清晰完整的动火许可证',
    });
  });

  it('keeps matched permit files for previewing the source attachment', () => {
    const heightDefinition = DAILY_PERMIT_DEFINITIONS.find(
      (definition) => definition.fileKey === 'heightWorkPermitFiles',
    );
    const label = heightDefinition?.label || '高处作业许可证';
    const item = buildConstruction([
      {
        label,
        feedback: '审核结果：通过；有效期至：2026-06-30；问题清单：无',
        updatedAt: '2026-05-29T06:03:00.000Z',
      },
    ]);

    const [heightPermit] = getDailyPermitVerifications(item, today);

    expect(heightPermit.files).toEqual([
      {
        fileToken: `${label}-token`,
        name: `${label}.jpg`,
        size: 128,
      },
    ]);
  });

  it('uses the latest renewed permit validity instead of the old expired one', () => {
    const item = buildConstruction([
      {
        label: '高处作业许可证',
        feedback: '审核结果：通过；有效期至：2026-05-28；问题清单：无',
        updatedAt: '2026-05-28T06:03:00.000Z',
      },
      {
        label: '高处作业许可证',
        feedback: '审核结果：通过；有效期至：2026-06-30；问题清单：无',
        updatedAt: '2026-05-29T06:03:00.000Z',
      },
    ]);

    const [heightPermit] = getDailyPermitVerifications(item, today);

    expect(heightPermit.status).toBe('valid');
    expect(heightPermit.expiryDate).toBe('2026-06-30');
    expect(heightPermit.blocksProcess).toBe(false);
  });

  it('uses the latest approved renewal instead of an older failed permit audit', () => {
    const item = buildConstruction([
      {
        label: '高处作业许可证',
        feedback:
          '结论：不通过；有效期至：未识别；问题：未识别高处作业许可证有效期',
        updatedAt: '2026-05-28T06:03:00.000Z',
        fileName: '旧高处作业票.pdf',
      },
      {
        label: '高处作业许可证',
        feedback: '结论：通过；有效期至：2026-06-30；问题：无',
        updatedAt: '2026-05-29T06:03:00.000Z',
        fileName: '新高处作业票.pdf',
      },
    ]);

    const [heightPermit] = getDailyPermitVerifications(item, today);

    expect(heightPermit.status).toBe('valid');
    expect(heightPermit.expiryDate).toBe('2026-06-30');
    expect(heightPermit.blocksProcess).toBe(false);
    expect(heightPermit.files[0].name).toBe('新高处作业票.pdf');
    expect(heightPermit.sourceText).toContain('结论：通过');
  });

  it('summarizes permit AI audit feedback with the conclusion first', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '结论：需人工复核；有效期至：未识别；说明：自动审核已接收动火许可证材料；问题：审批签章需人工确认；建议：补充清晰扫描件',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [hotWorkPermit] = getDailyPermitVerifications(item, today);

    expect(getDailyPermitAuditSummary(hotWorkPermit)).toBe(
      '结论：需人工复核；有效期至：未识别；问题：审批签章需人工确认',
    );
  });

  it('parses daily permit audit details separated by Chinese punctuation', () => {
    expect(
      getDailyPermitAuditDetails({
        sourceText:
          '核验日期：2026-06-03、核验版本：6、结论：不通过、有效期至：2026-05-31、说明：动火许可证有效期已过期、问题：动火时间截止日期早于核验日期、许可证编号未填写、建议：重新申请有效期内的动火作业票',
      }),
    ).toMatchObject({
      verificationDate: '2026-06-03',
      version: '6',
      conclusion: '不通过',
      expiry: '2026-05-31',
      description: '动火许可证有效期已过期',
      issue: '动火时间截止日期早于核验日期、许可证编号未填写',
      suggestion: '重新申请有效期内的动火作业票',
    });
  });

  it('compresses legacy verbose permit audit feedback before displaying it', () => {
    expect(
      getDailyPermitAuditSummary({
        sourceText:
          '自动审核：已接收 1 个文件，其中 0 个为图片（高处作业票.pdf）；审核对象：高处作业许可证；多维表匹配要求：很长很长；核验要点：需识别作业票类型、项目/作业内容、审批签章、有效期截止日期；当前未完成视觉识别时，系统已生成审核要点，请在多维表中结合附件复核后确认',
      }),
    ).toBe('需人工复核：票面信息待核验');
  });

  it('compresses uploaded permit fallback feedback before displaying it', () => {
    expect(
      getDailyPermitAuditSummary({
        sourceText:
          '结论：需人工复核；有效期至：未识别；说明：自动审核已接收动火许可证材料（动火作业票.jpg）、已接收 1 张图片、需人工核验票面信息；审核对象：动火许可证；要求：匹配作业类型：动火作业；问题：有效期、审批签章或作业内容需人工确认；视觉审核失败：Request failed with status code 403',
      }),
    ).toBe('需人工复核：票面信息待核验');
  });

  it('uses the end date when permit validity is written as a date range', () => {
    const item = buildConstruction([
      {
        label: '高处作业许可证',
        feedback:
          '审核结果：通过；有效期：2026-05-28 至 2026-06-30；问题清单：无',
        updatedAt: '2026-05-29T06:03:00.000Z',
      },
    ]);

    const [heightPermit] = getDailyPermitVerifications(item, today);

    expect(heightPermit.status).toBe('valid');
    expect(heightPermit.expiryDate).toBe('2026-06-30');
  });

  it('uses compact filename range end dates instead of AI start dates', () => {
    const hotWorkDefinition = DAILY_PERMIT_DEFINITIONS[1];
    const item = buildConstruction(
      [
      {
        label: hotWorkDefinition.label,
        feedback:
          '核验日期：2026-06-10；核验版本：6；结论：通过；有效期至：2026-06-08；说明：动火作业票人工审核通过，附件名为动火作业单6.8-6.10.jpg；问题：无',
        updatedAt: '2026-06-10T06:03:00.000Z',
      },
      ],
      ['一般作业', hotWorkDefinition.workType],
    );

    const [hotPermit] = getDailyPermitVerifications(item, today);

    expect(hotPermit.expiryDate).toBe('2026-06-10');
    expect(getDailyPermitAuditDetails(hotPermit)?.expiry).toBe('2026-06-10');
  });

  it('summarizes permit verification for the daily prepare detail view', () => {
    const verifications = getDailyPermitVerifications(
      buildConstruction(
        [
          {
            label: '动火许可证',
            feedback: '审核结果：通过；有效期至：2026-05-30；问题清单：无',
            updatedAt: '2026-05-29T06:03:00.000Z',
          },
        ],
        ['一般作业', '动火作业'],
      ),
      today,
    );

    expect(getDailyPermitSummary(verifications)).toMatchObject({
      label: '作业票校核',
      value: '有效（临期 1项）',
      done: true,
      issue: false,
      tone: 'complete',
    });
  });

  it('builds one combined checklist item for all project permits', () => {
    const mixed = getDailyPermitVerifications(
      buildConstruction(
        [
          {
            label: '动火许可证',
            feedback: '审核结果：通过；有效期至：2026-06-30；问题清单：无',
            updatedAt: '2026-05-29T06:03:00.000Z',
          },
          {
            label: '高处作业许可证',
            feedback: '审核结果：通过；问题清单：无',
            updatedAt: '2026-05-28T06:03:00.000Z',
          },
        ],
        ['一般作业', '动火作业', '高处作业'],
      ),
      today,
    );
    const expired = getDailyPermitVerifications(
      buildConstruction([
        {
          label: '高处作业许可证',
          feedback: '审核结果：通过；有效期至：2026-05-28；问题清单：无',
          updatedAt: '2026-05-28T06:03:00.000Z',
        },
      ]),
      today,
    );
    const expiringTomorrow = getDailyPermitVerifications(
      buildConstruction([
        {
          label: '高处作业许可证',
          feedback: '审核结果：通过；有效期到5月30号；问题清单：无',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ]),
      today,
    );

    expect(getDailyPermitChecklistItems(mixed)).toEqual([
      {
        label: '作业票',
        value: '待核验 1项',
        done: false,
        issue: false,
      },
    ]);
    expect(getDailyPermitChecklistItems(expired)).toEqual([
      {
        label: '作业票',
        value: '过期 1项',
        done: false,
        issue: true,
      },
    ]);
    expect(getDailyPermitChecklistItems(expiringTomorrow)).toEqual([
      {
        label: '作业票',
        value: '有效（临期 1项）',
        done: true,
        issue: false,
      },
    ]);
    expect(
      getDailyPermitChecklistItems(
        getDailyPermitVerifications(
          buildConstruction([
            {
              label: '高处作业许可证',
              feedback: '审核结果：通过；有效期至：2026-06-30；问题清单：无',
              updatedAt: '2026-05-29T06:03:00.000Z',
            },
          ]),
          today,
        ),
      ),
    ).toEqual([
      {
        label: '作业票',
        value: '有效',
        done: true,
        issue: false,
      },
    ]);
  });

  it('fails closed when AI audit is undefined or disabled despite historical AI approval', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback: '审核结果：通过；有效期至：2026-06-30；问题清单：无',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ],
      ['一般作业', '动火作业'],
    );
    for (const enabled of [undefined, false] as const) {
      const [verification] = deriveDailyPermitVerifications(
        item,
        today,
        ['动火作业'],
        enabled,
      );
      expect(verification.status).toBe('pendingReview');
      expect(verification.blocksProcess).toBe(true);
      expect(verification.sourceText).toBeNull();
      expect(verification.manualReview.status).toBe('pending');
    }

    const [enabledVerification] = deriveDailyPermitVerifications(
      item,
      today,
      ['动火作业'],
      true,
    );
    expect(enabledVerification.status).toBe('valid');
    expect(enabledVerification.blocksProcess).toBe(false);
  });

  it('ignores historical AI rejection when AI audit is disabled', () => {
    const item = buildConstruction(
      [
        {
          label: '动火许可证',
          feedback:
            '审核结果：不通过；有效期至：2026-06-30；问题清单：票面信息异常',
          updatedAt: '2026-05-29T06:03:00.000Z',
        },
      ],
      ['一般作业', '动火作业'],
    );

    const [verification] = deriveDailyPermitVerifications(
      item,
      today,
      ['动火作业'],
      false,
    );

    expect(verification.status).toBe('pendingReview');
    expect(verification.blocksProcess).toBe(true);
    expect(verification.sourceText).toBeNull();
    expect(verification.message).toBe('动火许可证已上传，待人工审核。');
  });

  it('uses only the human decision and human validity date in manual-only mode', () => {
    const buildManualOnly = (
      value: '通过' | '驳回',
      validUntil: string | null,
    ) =>
      buildConstruction(
        [
          {
            label: '动火许可证',
            feedback:
              value === '通过'
                ? '审核结果：不通过；有效期至：2026-05-01；问题清单：旧AI驳回'
                : '审核结果：通过；有效期至：2026-12-31；问题清单：无',
            updatedAt: '2026-05-29T06:03:00.000Z',
            manualReview: {
              field: '人工审核-动火许可票',
              fingerprintField: '人工审核票据标识-动火许可票',
              reviewed: value === '通过',
              value,
              fingerprint: null,
              expectedFingerprint: null,
              validUntil,
            },
          },
        ],
        ['一般作业', '动火作业'],
      );

    const [passed] = deriveDailyPermitVerifications(
      buildManualOnly('通过', '2026-06-30'),
      today,
      ['动火作业'],
      false,
    );
    const [expired] = deriveDailyPermitVerifications(
      buildManualOnly('通过', '2026-05-01'),
      today,
      ['动火作业'],
      false,
    );
    const [rejected] = deriveDailyPermitVerifications(
      buildManualOnly('驳回', null),
      today,
      ['动火作业'],
      false,
    );

    expect(passed.status).toBe('valid');
    expect(passed.blocksProcess).toBe(false);
    expect(passed.expiryDate).toBe('2026-06-30');
    expect(passed.sourceText).toBeNull();
    expect(expired.status).toBe('expired');
    expect(expired.blocksProcess).toBe(true);
    expect(rejected.status).toBe('invalid');
    expect(rejected.blocksProcess).toBe(true);
  });

  it('uses the human-confirmed start and end dates as an inclusive validity range', () => {
    const buildManualRange = (validFrom: string, validUntil: string) =>
      buildConstruction(
        [
          {
            label: '动火许可证',
            feedback: null,
            updatedAt: '2026-05-29T06:03:00.000Z',
            manualReview: {
              field: '人工审核-动火许可票',
              fingerprintField: '人工审核票据标识-动火许可票',
              reviewed: true,
              value: '通过',
              fingerprint: null,
              expectedFingerprint: null,
              validFrom,
              validUntil,
            } as ConstructionAttachmentGroup['manualReview'],
          },
        ],
        ['一般作业', '动火作业'],
      );

    const [startsTomorrow] = deriveDailyPermitVerifications(
      buildManualRange('2026-05-30', '2026-06-30'),
      today,
      ['动火作业'],
      false,
    );
    const [validToday] = deriveDailyPermitVerifications(
      buildManualRange('2026-05-29', '2026-05-29'),
      today,
      ['动火作业'],
      false,
    );

    expect(startsTomorrow.status).toBe('notStarted');
    expect(startsTomorrow.blocksProcess).toBe(true);
    expect(startsTomorrow.message).toContain('尚未生效');
    expect(validToday.status).toBe('expiresToday');
    expect(validToday.blocksProcess).toBe(false);
    expect(getDailyPermitSummary([validToday])).toMatchObject({
      value: '有效（临期 1项）',
      done: true,
      tone: 'complete',
    });
  });
});
