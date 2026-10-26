import {
  buildConstructionCompletionChecklistFile,
  buildConstructionApplicationFields,
  buildConstructionCrewLedgerViewFilterPayload,
  buildConstructionCrewLedgerViewName,
  buildDailyPersonnelChecklistFile,
  buildConstructionFollowupFields,
  buildConstructionImageAuditStatus,
  buildConstructionManagementView,
  buildConstructionFollowupOverviewFields,
  buildConstructionPermitAuditFeedback,
  buildConstructionPermitAuditRequirementLines,
  buildConstructionPermitManualReviewFingerprint,
  buildConstructionTrainingAssessmentAuditFeedback,
  buildConstructionPermitManualReviewResetFields,
  buildConstructionPermitVisionAuditPayload,
  buildDailyPermitAuditFeedbackWithDate,
  buildIsolationPhotoAuditFeedback,
  buildIsolationPhotoVisionAuditPayload,
  CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS,
  CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS,
  CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS,
  CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
  CONSTRUCTION_FULL_COMPLETION_CHECKLIST_ITEMS,
  CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS,
  CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS,
  CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS,
  CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD,
  extractConstructionPermitFeedbackExpiryDate,
  extractConstructionPermitManualReviewValidityRange,
  formatConstructionPermitDailyValidityFeedback,
  formatConstructionPermitVisionAuditFeedback,
  formatIsolationPhotoVisionAuditFeedback,
  getConstructionCompletionChecklistItems,
  hasConstructionApprovalMaterialUpload,
  filterChangedConstructionUploadFiles,
  filterChangedConstructionUploadFilesByContent,
  omitUnchangedConstructionFieldValues,
  mergeConstructionAttachmentFieldValues,
  normalizeConstructionCompletionChecklist,
  normalizeConstructionUploadFileName,
  parseConstructionCrewRosterFiles,
  parseConstructionPermitVisionAuditResponse,
  parseIsolationPhotoVisionAuditResponse,
  shouldRefreshDailyPermitAuditFeedback,
  validateConstructionApplicationSubmission,
  validateConstructionFollowupSubmission,
} from '../../server/modules/duty-schedule/construction-management';
import * as XLSX from 'xlsx';

describe('construction management helpers', () => {
  function buildCrewRosterWorkbookBuffer(rows: unknown[][]): Buffer {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(rows),
      '工作表1',
    );
    return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  }

  it('uses the actual bitable fields for application and crew roster attachments', () => {
    expect(CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS.applicationFiles).toBe(
      '施工申请单',
    );
    expect(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles).toBe(
      '施工作业申请单',
    );
    expect(CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS.crewRosterFiles).toBe(
      '施工人员信息表--初始',
    );
    expect(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.crewRosterFiles).toBe(
      '施工人员增删名单',
    );
  });

  it('parses uploaded construction crew roster authorization dates', () => {
    const buffer = buildCrewRosterWorkbookBuffer([
      [
        '姓名*\nName*',
        '证件号码*\nCertificateNo*',
        '手机号码*\nCellphone*',
        '公司*\nCompany*',
        '授权范围(选填)\nAuthorizationScope',
        '授权有效期',
      ],
      [
        '张鹏',
        '411024199110154959',
        '13800004492',
        '浙江省邮电工程建设有限公司',
        'HA楼',
        '2026-06-08 至 2026-06-14',
      ],
    ]);

    const entries = parseConstructionCrewRosterFiles(
      [
        {
          fieldname: 'crewRosterFiles',
          originalname: '施工人员名单.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer,
          size: buffer.length,
        },
      ],
      new Date('2026-06-08T00:00:00+08:00'),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: '张鹏',
      phone: '13800004492',
      certificateNo: '411024199110154959',
      company: '浙江省邮电工程建设有限公司',
      authorizationScope: 'HA楼',
      authorizationStartDate: '2026-06-08',
      authorizationEndDate: '2026-06-14',
      authorizationStatus: '授权有效',
    });
  });

  it('parses construction unit from uploaded crew roster workbooks', () => {
    const buffer = buildCrewRosterWorkbookBuffer([
      ['姓名', '证件号码', '手机号码', '施工单位', '授权范围', '授权有效期'],
      [
        '周淑娟',
        '320611197206091525',
        '13800007382',
        '浙江邮电',
        'HA楼',
        '2026-06-08 至 2026-06-14',
      ],
    ]);

    const entries = parseConstructionCrewRosterFiles(
      [
        {
          fieldname: 'crewRosterFiles',
          originalname: '施工人员名单汇总.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer,
          size: buffer.length,
        },
      ],
      new Date('2026-06-08T00:00:00+08:00'),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: '周淑娟',
      company: '浙江邮电',
      authorizationStatus: '授权有效',
    });
  });

  it('maps scoped initial application supplemental material attachments', () => {
    expect(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.trainingPhotoFiles).toBe(
      '入场培训照片',
    );
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.entryTrainingSignInFiles,
    ).toBe('入场培训签到表');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.entryTrainingAssessmentFiles,
    ).toBe('入场培训考核');
    expect(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.safetyNoticePhotoFiles).toBe(
      '安全告知书照片',
    );
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerRiskDisclosureFiles,
    ).toBe('临电作业风险交底单');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerTrainingSignInFiles,
    ).toBe('临电作业培训签到表');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerTrainingAssessmentFiles,
    ).toBe('临电作业培训考核');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerPermitFiles,
    ).toBe('临时用电作业票');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkRiskDisclosureFiles,
    ).toBe('动火作业风险交底单');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkTrainingSignInFiles,
    ).toBe('动火作业培训签到表');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkTrainingAssessmentFiles,
    ).toBe('动火作业培训考核');
    expect(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.hotWorkPermitFiles).toBe(
      '动火作业票',
    );
    expect(
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.hotWorkRiskDisclosureFiles
        .feedbackField,
    ).toBe('AI审核结果-风险交底单');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.heightWorkRiskDisclosureFiles,
    ).toBe('高处作业风险交底单');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.heightWorkTrainingSignInFiles,
    ).toBe('高处作业培训签到表');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.heightWorkTrainingAssessmentFiles,
    ).toBe('高处作业培训考核');
    expect(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.heightWorkPermitFiles).toBe(
      '高处作业票',
    );
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.confinedSpaceRiskDisclosureFiles,
    ).toBe('受限空间作业风险交底单');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.confinedSpaceTrainingSignInFiles,
    ).toBe('受限空间作业培训签到表');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.confinedSpaceTrainingAssessmentFiles,
    ).toBe('受限空间作业培训考核');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.confinedSpacePermitFiles,
    ).toBe('受限空间作业许可证');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.excavationRiskDisclosureFiles,
    ).toBe('开挖动土作业风险交底单');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.excavationTrainingSignInFiles,
    ).toBe('开挖动土作业培训签到表');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.excavationTrainingAssessmentFiles,
    ).toBe('开挖动土作业培训考核');
    expect(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.excavationPermitFiles).toBe(
      '开挖动土作业票',
    );
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.liftingRiskDisclosureFiles,
    ).toBe('吊装作业风险交底单');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.liftingTrainingSignInFiles,
    ).toBe('吊装作业培训签到表');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.liftingTrainingAssessmentFiles,
    ).toBe('吊装作业培训考核');
    expect(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.liftingPermitFiles).toBe(
      '吊装作业票',
    );
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.fireSystemShutdownRiskDisclosureFiles,
    ).toBe('消防系统关闭作业风险交底单');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.fireSystemShutdownTrainingSignInFiles,
    ).toBe('消防系统关闭作业培训签到表');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.fireSystemShutdownTrainingAssessmentFiles,
    ).toBe('消防系统关闭作业培训考核');
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.fireSystemShutdownPermitFiles,
    ).toBe('消防系统关闭作业票');
  });

  it('builds one filtered crew ledger view per construction code', () => {
    expect(buildConstructionCrewLedgerViewName(' SG260605-1031 ')).toBe(
      'SG260605-1031',
    );
    expect(buildConstructionCrewLedgerViewName('')).toBeNull();

    expect(
      buildConstructionCrewLedgerViewFilterPayload('fldCode', 'SG260605-1031'),
    ).toEqual({
      property: {
        filter_info: {
          conjunction: 'and',
          conditions: [
            {
              field_id: 'fldCode',
              operator: 'is',
              value: ['SG260605-1031'],
            },
          ],
        },
      },
    });
  });

  it('maps temporary power work permits to follow-up and audit fields', () => {
    expect(
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerPermitFiles,
    ).toBe('临时用电作业票');
    expect(
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.temporaryPowerPermitFiles,
    ).toEqual({
      label: '临时用电作业票',
      feedbackField: 'AI审核结果-临时用电作业许可证',
      fallbackFeedbackFields: ['AI审核结果-临时用电许可证'],
    });
  });

  it('maps safety notice photos to AI audit feedback fields', () => {
    expect(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.safetyNoticePhotoFiles).toBe(
      '安全告知书照片',
    );
    expect(
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.safetyNoticePhotoFiles,
    ).toEqual({
      label: '安全告知书',
      feedbackField: 'AI审核结果-安全告知书',
      fallbackFeedbackFields: ['AI审核结果-安全告知书照片'],
      requiresValidity: false,
    });
  });

  it('maps construction application forms to AI audit feedback fields', () => {
    expect(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.applicationFiles).toBe(
      '施工作业申请单',
    );
    expect(
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.applicationFiles,
    ).toEqual({
      label: '施工申请单',
      feedbackField: 'AI审核结果-施工申请单',
      requiresValidity: true,
    });
  });

  it('maps permit manual review fields and reset payloads', () => {
    expect(
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS.heightWorkPermitFiles,
    ).toMatchObject({
      label: '高处作业票',
      reviewField: '人工审核-高处作业票',
      fingerprintField: '人工审核票据标识-高处作业票',
    });

    expect(
      buildConstructionPermitManualReviewResetFields(
        {
          高处作业票: [{ file_token: 'height-token' }],
        },
        {
          'AI审核结果-高处作业许可证':
            '核验日期：2026-06-10；核验版本：6；结论：通过；有效期至：2026-06-18；问题：无',
        },
        ['heightWorkPermitFiles'],
      ),
    ).toMatchObject({
      '人工审核-高处作业票': null,
      '人工审核票据标识-高处作业票': expect.stringMatching(/^v1:/),
    });
  });

  it('stores a human-confirmed permit validity range in a versioned fingerprint', () => {
    const buildManualFingerprint =
      buildConstructionPermitManualReviewFingerprint as unknown as (
        files: Array<{ file_token: string }>,
        expiryDate: string,
        source: 'manual',
        validFrom: string,
      ) => string;

    const fingerprint = buildManualFingerprint(
      [{ file_token: 'height-token' }],
      '2026-07-26',
      'manual',
      '2026-07-20',
    );

    expect(fingerprint).toMatch(
      /^v3:2026-07-20:2026-07-26:[a-z0-9]+$/,
    );
    expect(
      extractConstructionPermitManualReviewValidityRange(fingerprint),
    ).toEqual({
      validFrom: '2026-07-20',
      validUntil: '2026-07-26',
    });
    expect(
      extractConstructionPermitManualReviewValidityRange(
        buildManualFingerprint(
          [{ file_token: 'height-token' }],
          '2026-07-26',
          'manual',
          '',
        ),
      ),
    ).toEqual({
      validFrom: null,
      validUntil: '2026-07-26',
    });
  });

  it('repairs latin1-decoded upload file names without changing normal names', () => {
    const fileName = '施工申请单.pdf';
    const mojibakeName = Buffer.from(fileName, 'utf8').toString('latin1');

    expect(normalizeConstructionUploadFileName(mojibakeName)).toBe(fileName);
    expect(normalizeConstructionUploadFileName(fileName)).toBe(fileName);
    expect(normalizeConstructionUploadFileName('report-2026.pdf')).toBe(
      'report-2026.pdf',
    );
  });

  it('maps application input to writable overview fields only', () => {
    const { fields, normalized } = buildConstructionApplicationFields({
      workContent: 'A楼挖潜机房施工',
      building: 'A楼',
      specialty: '其他',
      workTypes: ['一般作业', '动火作业'],
      contractorType: '外部',
      relatedWorkType: '维护',
      planStartTime: '2026-05-25T09:00',
      planEndTime: '2026-07-31T21:00',
      depositPaid: '是',
      depositAmount: 3000,
      constructionApplicantId: 'ou_applicant',
    });

    expect(normalized.workContent).toBe('A楼挖潜机房施工');
    expect(fields).toEqual({
      作业内容: 'A楼挖潜机房施工',
      楼栋: 'A楼',
      专业: '其他',
      作业类型: ['一般作业', '动火作业'],
      '施工方（内部/施工单位）': '外部',
      关联作业类型: '维护',
      计划开始时间: new Date('2026-05-25T09:00:00+08:00').getTime(),
      计划结束时间: new Date('2026-07-31T21:00:00+08:00').getTime(),
      施工申请人: [{ id: 'ou_applicant' }],
      流程: '施工申请',
      新建施工单提交: true,
      是否缴纳保证金: '是',
      '缴纳保证金（元）': 3000,
    });
    expect(fields).not.toHaveProperty('施工随工人员（专业工程师）');
    expect(fields).not.toHaveProperty('示例人员001审批');
    expect(fields).not.toHaveProperty('EHS审批');
    expect(fields).not.toHaveProperty('施工编码');
  });

  it('allows new construction applications without work type input', () => {
    const { fields, normalized } = buildConstructionApplicationFields({
      workContent: 'A楼挖潜机房施工',
      building: 'A楼',
      specialty: '其他',
      contractorType: '外部',
      relatedWorkType: '维护',
      planStartTime: '2026-05-25T09:00',
      planEndTime: '2026-07-31T21:00',
      constructionApplicantId: 'ou_applicant',
    });

    expect(normalized.workTypes).toEqual([]);
    expect(fields).not.toHaveProperty('作业类型');
  });

  it('normalizes crew roster authorization dates from new construction applications', () => {
    const { normalized } = buildConstructionApplicationFields({
      workContent: 'A楼挖潜机房施工',
      building: 'A楼',
      specialty: '其他',
      contractorType: '外部',
      relatedWorkType: '维护',
      planStartTime: '2026-05-25T09:00',
      planEndTime: '2026-07-31T21:00',
      authorizationStartDate: '2026-05-25',
      authorizationEndDate: '2026-07-31',
      constructionApplicantId: 'ou_applicant',
    });

    expect(normalized.authorizationStartDate).toBe('2026-05-25');
    expect(normalized.authorizationEndDate).toBe('2026-07-31');
  });

  it('requires crew roster files only for new construction applications', () => {
    expect(() => validateConstructionApplicationSubmission([])).toThrow(
      '新建施工需上传施工人员名单',
    );
    expect(() =>
      validateConstructionApplicationSubmission([
        {
          fieldname: 'applicationFiles',
          originalname: '施工申请单.pdf',
          mimetype: 'application/pdf',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).toThrow('新建施工需上传施工人员名单');
    expect(() =>
      validateConstructionApplicationSubmission([
        {
          fieldname: 'crewRosterFiles',
          originalname: '施工人员名单.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).not.toThrow();
    expect(() =>
      validateConstructionApplicationSubmission([
        {
          fieldname: 'applicationFiles',
          originalname: '施工申请单.pdf',
          mimetype: 'application/pdf',
          size: 1,
          buffer: Buffer.from('x'),
        },
        {
          fieldname: 'crewRosterFiles',
          originalname: '施工人员名单.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).not.toThrow();
  });

  it('allows other related work type without a change order link', () => {
    const { fields, normalized } = buildConstructionApplicationFields({
      workContent: 'A楼临时配合作业',
      building: 'A楼',
      specialty: '其他',
      workTypes: ['一般作业'],
      contractorType: '外部',
      relatedWorkType: '其他',
      planStartTime: '2026-05-25T09:00',
      planEndTime: '2026-05-25T18:00',
      constructionApplicantId: 'ou_applicant',
    });

    expect(normalized.relatedWorkType).toBe('其他');
    expect(fields.关联作业类型).toBe('其他');
    expect(fields).not.toHaveProperty('变更关联');
  });

  it('maps selected change order to overview change link when related type is change', () => {
    const { fields, normalized } = buildConstructionApplicationFields({
      workContent: 'B楼变更配套施工',
      building: 'B楼',
      specialty: '电气',
      workTypes: ['一般作业'],
      contractorType: '外部',
      relatedWorkType: '变更',
      changeOrderLinkRecordId: 'recLocalChange',
      planStartTime: '2026-05-25T09:00',
      planEndTime: '2026-05-25T18:00',
      constructionApplicantId: 'ou_applicant',
    } as any);

    expect(normalized.relatedWorkType).toBe('变更');
    expect(fields.关联作业类型).toBe('变更');
    expect(fields.变更关联).toEqual(['recLocalChange']);
  });

  it('maps follow-up input to writable follow-up fields and overview link', () => {
    const { fields, normalized } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      followupStaffIds: ['ou_follow_1', 'ou_follow_2'],
      dailyPersonnelCheck: '已核对，现场施工人员与台账一致',
      isolationCompliant: '是',
      isolationFeedback: '挂牌隔离照片清晰',
    });

    expect(fields).toEqual({
      施工总览: ['recOverview'],
      跟进人员: [{ id: 'ou_follow_1' }, { id: 'ou_follow_2' }],
      '挂牌&隔离合规反馈': '挂牌隔离照片清晰',
    });
    expect(normalized.dailyPersonnelCheck).toBe(
      '已核对，现场施工人员与台账一致',
    );
    expect(normalized.isolationCompliant).toBeNull();
    expect(fields).not.toHaveProperty('每日人员核查');
    expect(fields).not.toHaveProperty('挂牌&隔离是否合规');
    expect(fields).not.toHaveProperty('挂牌审批');
    expect(fields).not.toHaveProperty('收尾审批');
    expect(fields).not.toHaveProperty('施工审批结果');
  });

  it('requires daily personnel check for construction follow-ups', () => {
    expect(() =>
      buildConstructionFollowupFields({
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        followupStaffIds: ['ou_follow_1'],
        isolationCompliant: '是',
      }),
    ).toThrow('每日人员核查不能为空');
  });

  it('requires follow-up staff for daily construction follow-ups', () => {
    expect(() =>
      buildConstructionFollowupFields({
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyPersonnelCheck: '已核对，现场施工人员与台账一致',
        isolationCompliant: '是',
      }),
    ).toThrow('跟进人员不能为空');
  });

  it('normalizes daily crew members for the generated personnel checklist', () => {
    const { normalized } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      followupStaffIds: ['ou_follow_1'],
      dailyPersonnelCheck: '已核对施工人员台账',
      dailyCrewMembers: JSON.stringify([
        {
          recordId: 'crew-1',
          name: '示例人员008',
          certificateSummary: '高处作业证，有效期至2026-06-30',
        },
      ]),
    });

    expect(normalized.dailyPersonnelCheckParticipants).toEqual([
      {
        recordId: 'crew-1',
        name: '示例人员008',
        certificateSummary: '高处作业证，有效期至2026-06-30',
        complianceStatus: null,
        issueSummary: null,
      },
    ]);
  });

  it('marks daily personnel AI check failed when temporary power crew lacks low or high voltage certificate', () => {
    const { fields } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      followupStaffIds: ['ou_follow_1'],
      dailyPersonnelCheck: '已核对施工人员台账',
      workTypes: ['一般作业', '临时用电作业'],
      dailyCrewMembers: JSON.stringify([
        {
          recordId: 'crew-1',
          name: '示例人员008',
          certificateSummary: '高处作业证',
        },
      ]),
    });

    expect(fields['AI审核结果-每日人员核查']).toBe('不通过：缺低压/高压证');
  });

  it('marks daily personnel AI check passed when temporary power crew has low voltage certificate', () => {
    const { fields } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      followupStaffIds: ['ou_follow_1'],
      dailyPersonnelCheck: '已核对施工人员台账',
      workTypes: ['临时用电作业'],
      dailyCrewMembers: JSON.stringify([
        {
          recordId: 'crew-1',
          name: '示例人员008',
          certificateSummary: '低压电工证',
        },
      ]),
    });

    expect(fields['AI审核结果-每日人员核查']).toBe('通过');
  });

  it('marks daily personnel AI check passed when temporary power crew has high voltage certificate', () => {
    const { fields } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      followupStaffIds: ['ou_follow_1'],
      dailyPersonnelCheck: '已核对施工人员台账',
      workTypes: ['临时用电作业'],
      dailyCrewMembers: JSON.stringify([
        {
          recordId: 'crew-1',
          name: '示例人员008',
          certificateSummary: '高压电工证',
        },
      ]),
    });

    expect(fields['AI审核结果-每日人员核查']).toBe('通过');
  });

  it('maps initial application follow-ups without daily-only fields', () => {
    const { fields, normalized } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'supplemental',
      workTypes: ['一般作业'],
    });

    expect(normalized.followupMode).toBe('supplemental');
    expect(fields).toEqual({
      施工总览: ['recOverview'],
    });
    expect(buildConstructionFollowupOverviewFields(normalized as any)).toEqual({
      作业类型: ['一般作业'],
    });
    expect(fields).not.toHaveProperty('每日人员核查');
    expect(fields).not.toHaveProperty('挂牌&隔离是否合规');
    expect(fields).not.toHaveProperty('AI识别反馈（过程）');
  });

  it('maps supplemental deposit changes to follow-up and overview fields', () => {
    const { fields, normalized } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'supplemental',
      workTypes: ['一般作业'],
      depositPaid: '是',
      depositAmount: '1200',
      depositDeducted: '300',
    });

    expect(fields).toEqual({
      施工总览: ['recOverview'],
      是否缴纳保证金: '是',
      质保金是否确认: true,
      同步机房经理: true,
      '缴纳保证金（元）': 1200,
      被扣款保证金: 300,
    });
    expect((normalized as any).depositPaid).toBe('是');
    expect((normalized as any).depositAmount).toBe(1200);
    expect((normalized as any).depositDeducted).toBe(300);
    expect(buildConstructionFollowupOverviewFields(normalized as any)).toEqual({
      作业类型: ['一般作业'],
      是否缴纳保证金: '是',
      '缴纳保证金（元）': 1200,
      被扣款保证金: 300,
    });
  });

  it('marks approval material uploads without counting deposit attachments', () => {
    expect(
      hasConstructionApprovalMaterialUpload([
        { fieldname: 'hotWorkPermitFiles' },
      ]),
    ).toBe(true);
    expect(
      hasConstructionApprovalMaterialUpload([
        { fieldname: 'depositAgreementFiles' },
      ]),
    ).toBe(false);
  });

  it('maps daily follow-ups to the project-level overview workflow', () => {
    const prepare = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      followupStaffIds: ['ou_follow_1'],
      dailyPersonnelCheck: '已核对',
    });
    const process = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'process',
      followupStaffIds: ['ou_follow_1'],
      processFeedback: '施工过程正常',
    });
    const closeContinue = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'close',
      followupStaffIds: ['ou_follow_1'],
      completed: '否',
    });
    const closeDone = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'close',
      followupStaffIds: ['ou_follow_1'],
      completed: '是',
    });

    expect(buildConstructionFollowupOverviewFields(prepare.normalized)).toEqual(
      {
        流程: '施工进行',
      },
    );
    expect(buildConstructionFollowupOverviewFields(process.normalized)).toEqual(
      {
        流程: '施工进行',
      },
    );
    expect(
      buildConstructionFollowupOverviewFields(closeContinue.normalized),
    ).toEqual({
      流程: '施工进行',
    });
    expect(
      buildConstructionFollowupOverviewFields(closeDone.normalized),
    ).toEqual({
      流程: '闭环归档',
    });
  });

  it('uses overview attachment fields for deposit agreement and transfer screenshots', () => {
    expect(CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS.depositAgreementFiles).toBe(
      '质保金协议',
    );
    expect(CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS.depositTransferFiles).toBe(
      '质保金到账/返还',
    );
  });

  it('requires daily follow-up photos only for daily follow-ups', () => {
    const { normalized } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'close',
      followupStaffIds: ['ou_follow_1'],
      completed: '否',
      dailyPersonnelCheck: '已核对，现场施工人员与台账一致',
      isolationCompliant: '是',
    });

    expect(() =>
      validateConstructionFollowupSubmission(normalized, [
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '挂牌.jpg',
          mimetype: 'image/jpeg',
          size: 1,
          buffer: Buffer.from('x'),
        },
        {
          fieldname: 'processPhotoFiles',
          originalname: '过程.jpg',
          mimetype: 'image/jpeg',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).toThrow('每日施工收尾需上传每日收尾照片');

    expect(() =>
      validateConstructionFollowupSubmission(normalized, [
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '挂牌.jpg',
          mimetype: 'image/jpeg',
          size: 1,
          buffer: Buffer.from('x'),
        },
        {
          fieldname: 'processPhotoFiles',
          originalname: '过程.jpg',
          mimetype: 'image/jpeg',
          size: 1,
          buffer: Buffer.from('x'),
        },
        {
          fieldname: 'closingPhotoFiles',
          originalname: '收尾.jpg',
          mimetype: 'image/jpeg',
          size: 1,
          buffer: Buffer.from('x'),
        },
        {
          fieldname: 'inspectionFormFiles',
          originalname: '每日收尾检查表.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).not.toThrow();
  });

  it('validates daily follow-up stage specific required fields and attachments', () => {
    const prepare = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      followupStaffIds: JSON.stringify(['ou_follow_1']),
      dailyPersonnelCheck: '已核对，今日 3 人参与施工',
      isolationCompliant: '是',
      isolationFeedback: '挂牌隔离完成',
    });

    expect(prepare.normalized.dailyFollowupStage).toBe('prepare');
    expect(prepare.fields).toEqual({
      施工总览: ['recOverview'],
      跟进人员: [{ id: 'ou_follow_1' }],
      '挂牌&隔离合规反馈': '挂牌隔离完成',
    });
    expect(prepare.normalized.dailyPersonnelCheck).toBe(
      '已核对，今日 3 人参与施工',
    );
    expect(prepare.normalized.isolationCompliant).toBeNull();
    expect(prepare.fields).not.toHaveProperty('每日人员核查');
    expect(prepare.fields).not.toHaveProperty('挂牌&隔离是否合规');
    expect(() =>
      validateConstructionFollowupSubmission(prepare.normalized, [
        {
          fieldname: 'dailyPersonnelChecklistFiles',
          originalname: 'daily-personnel-checklist.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 1,
          buffer: Buffer.from('x'),
        },
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '挂牌.jpg',
          mimetype: 'image/jpeg',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).not.toThrow();

    const process = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'process',
      followupStaffIds: ['ou_follow_1'],
      processFeedback: '施工过程正常',
    });

    expect(process.normalized.dailyFollowupStage).toBe('process');
    expect(process.fields).toEqual({
      施工总览: ['recOverview'],
      跟进人员: [{ id: 'ou_follow_1' }],
      'AI识别反馈（过程）': '施工过程正常',
    });
    expect(() =>
      validateConstructionFollowupSubmission(process.normalized, []),
    ).toThrow('每日施工实施需上传施工过程照片');
    expect(() =>
      validateConstructionFollowupSubmission(process.normalized, [
        {
          fieldname: 'processPhotoFiles',
          originalname: '过程.jpg',
          mimetype: 'image/jpeg',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).not.toThrow();

    const close = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'close',
      followupStaffIds: ['ou_follow_1'],
      completed: '是',
    });

    expect(close.normalized.dailyFollowupStage).toBe('close');
    expect(close.fields).toEqual({
      施工总览: ['recOverview'],
      跟进人员: [{ id: 'ou_follow_1' }],
      是否完成: '是',
      EHS施工收尾审批: true,
    });
    expect(() =>
      validateConstructionFollowupSubmission(close.normalized, [
        {
          fieldname: 'closingPhotoFiles',
          originalname: '收尾.jpg',
          mimetype: 'image/jpeg',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).not.toThrow();
  });

  it('allows updating a completed prepare follow-up while keeping existing isolation photos', () => {
    const prepare = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupRecordId: 'recPrepareFollowup',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      followupStaffIds: ['ou_follow_1'],
      dailyPersonnelCheck:
        '已核对施工人员台账；今日参与施工（1人）：张鹏（低压电工证）',
      isolationCompliant: '是',
      isolationFeedback: '重新核对通过',
    });

    expect(() =>
      validateConstructionFollowupSubmission(prepare.normalized, [], {
        existingAttachmentFields: [
          'dailyPersonnelChecklistFiles',
          'isolationPhotoFiles',
        ],
      }),
    ).not.toThrow();
  });

  it('writes daily work types to the daily field while leaving permit-only uploads scoped to files', () => {
    const daily = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      followupDate: '2026-06-05',
      followupStaffIds: ['ou_follow_1'],
      dailyPersonnelCheck:
        '已核对施工人员台账；今日参与施工（1人）：张鹏（低压电工证）',
      workTypes: JSON.stringify(['一般作业', '动火作业']),
    });

    expect(daily.normalized.followupDate).toBe('2026-06-05');
    expect(daily.fields.跟进日期).toBe(
      new Date('2026-06-05T00:00:00+08:00').getTime(),
    );
    expect(daily.normalized.workTypes).toEqual(['一般作业', '动火作业']);
    expect(daily.fields.当日作业类型).toEqual(['一般作业', '动火作业']);
    expect(daily.fields).not.toHaveProperty('作业类型');

    const permitOnly = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      permitOnlyUpload: 'true',
      workTypes: JSON.stringify(['动火作业']),
    });

    expect(permitOnly.normalized.workTypes).toEqual(['动火作业']);
    expect(permitOnly.fields).not.toHaveProperty('作业类型');
    expect(permitOnly.fields).not.toHaveProperty('当日作业类型');
  });

  it('allows a focused daily work type submission without personnel or files', () => {
    const workTypeOnly = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      dailyChecklistFocus: 'workType',
      partialDailySubmit: 'true',
      followupDate: '2026-07-23',
      workTypes: JSON.stringify(['一般作业', '高处作业']),
    });

    expect(workTypeOnly.normalized.partialDailySubmit).toBe(true);
    expect(workTypeOnly.normalized.dailyChecklistFocus).toBe('workType');
    expect(workTypeOnly.normalized.followupStaffIds).toEqual([]);
    expect(workTypeOnly.normalized.dailyPersonnelCheck).toBeNull();
    expect(workTypeOnly.fields).toEqual({
      施工总览: ['recOverview'],
      当日作业类型: ['一般作业', '高处作业'],
      跟进日期: new Date('2026-07-23T00:00:00+08:00').getTime(),
    });
    expect(() =>
      validateConstructionFollowupSubmission(workTypeOnly.normalized, []),
    ).not.toThrow();
  });

  it('allows permit-only prepare uploads without daily personnel check content', () => {
    const permitOnly = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      permitOnlyUpload: 'true',
    });

    expect(permitOnly.normalized.permitOnlyUpload).toBe(true);
    expect(permitOnly.normalized.dailyPersonnelCheck).toBeNull();
    expect(permitOnly.fields).toEqual({
      施工总览: ['recOverview'],
    });
    expect(() =>
      validateConstructionFollowupSubmission(permitOnly.normalized, [
        {
          fieldname: 'heightWorkPermitFiles',
          originalname: '高处作业票.pdf',
          mimetype: 'application/pdf',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).not.toThrow();
    expect(() =>
      validateConstructionFollowupSubmission(permitOnly.normalized, []),
    ).toThrow();
  });

  it('parses and validates a manual validity range for each privileged permit upload', () => {
    const request = {
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      permitOnlyUpload: 'true',
      permitValidFromByFileKey: JSON.stringify({
        heightWorkPermitFiles: '2026-07-28',
      }),
      permitValidUntilByFileKey: JSON.stringify({
        heightWorkPermitFiles: '2026-08-02',
      }),
    } as Parameters<typeof buildConstructionFollowupFields>[0] & {
      permitValidFromByFileKey: string;
      permitValidUntilByFileKey: string;
    };
    const permitOnly = buildConstructionFollowupFields(request);
    const normalized = permitOnly.normalized as typeof permitOnly.normalized & {
      permitValidFromByFileKey: Record<string, string>;
      permitValidUntilByFileKey: Record<string, string>;
    };
    const heightPermit = {
      fieldname: 'heightWorkPermitFiles',
      originalname: '高处作业票.pdf',
      mimetype: 'application/pdf',
      size: 1,
      buffer: Buffer.from('x'),
    };

    expect(normalized.permitValidFromByFileKey).toEqual({
      heightWorkPermitFiles: '2026-07-28',
    });
    expect(normalized.permitValidUntilByFileKey).toEqual({
      heightWorkPermitFiles: '2026-08-02',
    });
    expect(() =>
      validateConstructionFollowupSubmission(
        normalized,
        [heightPermit],
        { requirePermitValidityDates: true } as {
          existingAttachmentFields?: string[];
          requirePermitValidityDates: boolean;
        },
      ),
    ).not.toThrow();

    const legacyUntilOnly = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      permitOnlyUpload: 'true',
      permitValidUntilByFileKey: JSON.stringify({
        heightWorkPermitFiles: '2026-08-02',
      }),
    }).normalized;
    expect(legacyUntilOnly.permitValidFromByFileKey).toEqual({});
    expect(() =>
      validateConstructionFollowupSubmission(
        legacyUntilOnly,
        [heightPermit],
        { requirePermitValidityDates: true },
      ),
    ).not.toThrow();

    const missingValidity = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      permitOnlyUpload: 'true',
    }).normalized;
    expect(() =>
      validateConstructionFollowupSubmission(
        missingValidity,
        [heightPermit],
        { requirePermitValidityDates: true } as {
          existingAttachmentFields?: string[];
          requirePermitValidityDates: boolean;
        },
      ),
    ).toThrow('请选择高处作业票有效期');

    expect(() =>
      buildConstructionFollowupFields({
        ...request,
        permitValidFromByFileKey: JSON.stringify({
          heightWorkPermitFiles: '2026-08-03',
        }),
      }),
    ).toThrow('开始日期不能晚于结束日期');
    expect(() =>
      buildConstructionFollowupFields({
        ...request,
        permitValidFromByFileKey: JSON.stringify({
          heightWorkPermitFiles: '2026-02-30',
        }),
      }),
    ).toThrow('作业票有效期');
    expect(() =>
      buildConstructionFollowupFields({
        ...request,
        permitValidUntilByFileKey: JSON.stringify({
          heightWorkPermitFiles: '2026-02-30',
        }),
      }),
    ).toThrow('作业票有效期');
    expect(() =>
      buildConstructionFollowupFields({
        ...request,
        permitValidUntilByFileKey: JSON.stringify({
          unknownPermitFiles: '2026-08-02',
        }),
      }),
    ).toThrow('未知作业票');
  });

  it('allows focused daily submissions without follow-up staff except personnel checks', () => {
    const personnelOnly = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      partialDailySubmit: 'true',
      dailyChecklistFocus: 'personnel',
      followupStaffIds: ['ou_follow_1'],
      dailyPersonnelCheck: '已核对施工人员台账',
      dailyCrewMembers: JSON.stringify([
        {
          recordId: 'crew_1',
          name: '张鹏',
          certificateSummary: '低压电工证',
        },
      ]),
      isolationFeedback: '误传的挂牌隔离反馈',
    });

    expect(personnelOnly.normalized.partialDailySubmit).toBe(true);
    expect(personnelOnly.normalized.dailyChecklistFocus).toBe('personnel');
    expect(personnelOnly.normalized.followupStaffIds).toEqual(['ou_follow_1']);
    expect(personnelOnly.normalized.dailyPersonnelCheck).toBe(
      '已核对施工人员台账',
    );
    expect(personnelOnly.normalized.dailyPersonnelCheckParticipants).toEqual([
      {
        recordId: 'crew_1',
        name: '张鹏',
        certificateSummary: '低压电工证',
        complianceStatus: null,
        issueSummary: null,
      },
    ]);
    expect(personnelOnly.normalized.isolationFeedback).toBeNull();
    expect(() =>
      validateConstructionFollowupSubmission(personnelOnly.normalized, []),
    ).not.toThrow();
    expect(() =>
      buildConstructionFollowupFields({
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'prepare',
        partialDailySubmit: 'true',
        dailyChecklistFocus: 'personnel',
        dailyPersonnelCheck: '已核对施工人员台账',
      }),
    ).toThrow('跟进人员不能为空');

    const isolationOnly = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'prepare',
      partialDailySubmit: 'true',
      dailyChecklistFocus: 'isolation',
    });

    expect(isolationOnly.normalized.partialDailySubmit).toBe(true);
    expect(isolationOnly.normalized.dailyChecklistFocus).toBe('isolation');
    expect(isolationOnly.normalized.followupStaffIds).toEqual([]);
    expect(isolationOnly.normalized.dailyPersonnelCheck).toBeNull();
    expect(isolationOnly.fields).toEqual({
      施工总览: ['recOverview'],
    });
    expect(() =>
      validateConstructionFollowupSubmission(isolationOnly.normalized, [
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '挂牌隔离.jpg',
          mimetype: 'image/jpeg',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).not.toThrow();
    expect(() =>
      validateConstructionFollowupSubmission(isolationOnly.normalized, []),
    ).toThrow('请填写或上传当前弹窗的跟进内容');

    expect(() =>
      buildConstructionFollowupFields({
        constructionRecordId: 'recOverview',
        followupMode: 'daily',
        dailyFollowupStage: 'prepare',
        partialDailySubmit: '',
      }),
    ).toThrow('跟进人员不能为空');
  });

  it('builds isolation photo audit feedback for uploaded prepare photos', () => {
    const feedback = buildIsolationPhotoAuditFeedback([
      {
        fieldname: 'isolationPhotoFiles',
        originalname: '挂牌隔离.jpg',
        mimetype: 'image/jpeg',
        size: 1024,
        buffer: Buffer.from('x'),
      },
    ]);

    expect(feedback).toContain('自动审核');
    expect(feedback).toContain('水印');
    expect(feedback).toContain('隔离带');
    expect(feedback).toContain('警示牌');
    expect(feedback).toContain('施工铭牌');
  });

  it('builds a vision audit payload with the required watermark and onsite checks', () => {
    const payload = buildIsolationPhotoVisionAuditPayload(
      [
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '水印照片.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('image-bytes'),
        },
      ],
      'vision-model',
    );

    const content = payload.messages[0].content;
    const prompt = content.find((item) => item.type === 'text')?.text || '';
    const image = content.find((item) => item.type === 'image_url');

    expect(payload.stream).toBe(false);
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(prompt).toContain('世纪互联/VNET');
    expect(prompt).toContain('蓝底白字“世纪互联 VNET”品牌块');
    expect(prompt).toContain('不要要求额外的图形 logo');
    expect(prompt).toContain('项目/机房标题');
    expect(prompt).toContain('区域');
    expect(prompt).toContain('工作内容');
    expect(prompt).toContain('拍摄时间');
    expect(prompt).toContain('地点');
    expect(prompt).toContain('保税A区');
    expect(prompt).toContain('阿里巴巴南通保税A区数据中心');
    expect(prompt).toContain('隔离带');
    expect(prompt).toContain('警示牌');
    expect(prompt).toContain('施工铭牌');
    expect(image?.image_url.url).toBe(
      `data:image/jpeg;base64,${Buffer.from('image-bytes').toString('base64')}`,
    );
  });

  it('builds a permit audit payload and formats the recognized validity date', () => {
    const payload = buildConstructionPermitVisionAuditPayload(
      [
        {
          fieldname: 'heightWorkPermitFiles',
          originalname: '高处作业票.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('image-bytes'),
        },
      ],
      'vision-model',
      '高处作业许可证',
    );

    const content = payload.messages[0].content;
    const prompt = content.find((item) => item.type === 'text')?.text || '';
    const image = content.find((item) => item.type === 'image_url');

    expect(prompt).toContain('高处作业许可证');
    expect(prompt).toContain('当前核验日期');
    expect(prompt).toContain('有效期');
    expect(prompt).toContain('作业时间');
    expect(prompt).toContain('取“至/到/截止/止”后的结束日期');
    expect(prompt).toContain('2026-07-29');
    expect(prompt).toContain('许可证、作业票、作业单按同类材料处理');
    expect(prompt).toContain('附件名称：高处作业票.jpg');
    expect(image?.image_url.url).toContain('data:image/jpeg;base64,');

    const parsed = parseConstructionPermitVisionAuditResponse(
      '{"result":"通过","summary":"票面信息完整","expiryDate":"2026-05-30","issues":[],"suggestions":["到期前续期"]}',
    );
    const feedback = formatConstructionPermitVisionAuditFeedback(parsed);

    expect(feedback).toBe(
      '结论：通过；分组：作业票；问题：无（有效期至 2026-05-30）',
    );
  });

  it('audits safety notices as construction documents without requiring expiry dates', () => {
    const payload = buildConstructionPermitVisionAuditPayload(
      [
        {
          fieldname: 'safetyNoticePhotoFiles',
          originalname: '安全告知书.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('image-bytes'),
        },
      ],
      'vision-model',
      '安全告知书',
      {
        requiresValidity: false,
        context: {
          workContent: 'EA118-A挖潜机房施工',
          workTypes: ['动火作业'],
          planStartTime: '2026-06-20 08:00',
        },
      },
    );

    const prompt =
      payload.messages[0].content.find((item) => item.type === 'text')?.text ||
      '';
    const feedback = buildConstructionPermitAuditFeedback(
      [
        {
          fieldname: 'safetyNoticePhotoFiles',
          originalname: '安全告知书.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('image-bytes'),
        },
      ],
      '安全告知书',
      [],
      new Date('2026-06-12T08:00:00+08:00'),
      { requiresValidity: false },
    );

    expect(prompt).toContain('请审核施工资料“安全告知书”');
    expect(prompt).toContain('当前核验日期');
    expect(prompt).toContain('施工计划开始：2026-06-20 08:00');
    expect(prompt).toContain('现场安全行为告知书');
    expect(prompt).toContain('均视为安全告知书');
    expect(prompt).toContain('人员/签字人数');
    expect(prompt).toContain('应签人员是否都已签');
    expect(prompt).toContain('签字日期是否早于施工计划开始');
    expect(prompt).toContain('只统计安全告知书/现场安全行为告知书签字区');
    expect(prompt).toContain('不要把作业票人数');
    expect(prompt).toContain('人数识别必须写“疑似N人”');
    expect(prompt).toContain('签字项不要重复同一人数');
    expect(prompt).toContain('不要写“身份不明/未明确身份”');
    expect(prompt).toContain('必须完整显示两个日期');
    expect(prompt).toContain('不需要识别有效期');
    expect(prompt).toContain('每条不超过 30 个字');
    expect(prompt).not.toContain('作业时间');
    expect(feedback).toBe('结论：需人工复核；1. 资料信息需人工核验');
  });

  it('infers construction application expiry date from generated Word HTML body', () => {
    const feedback = buildConstructionPermitAuditFeedback(
      [
        {
          fieldname: 'applicationFiles',
          originalname: '20260623-施工申请-施工作业申请单.doc',
          mimetype: 'application/msword',
          size: 1024,
          buffer: Buffer.from(
            '\ufeff<html><body><table><tr><td>作业日期</td><td>2026年05月22日09时00分 至 2026年07月31日18时00分</td></tr></table></body></html>',
            'utf8',
          ),
        },
      ],
      '施工申请单',
      [],
      new Date('2026-06-23T08:00:00+08:00'),
    );

    expect(feedback).toContain('2026-07-31');
    expect(extractConstructionPermitFeedbackExpiryDate(feedback)).toBe(
      '2026-07-31',
    );
  });

  it('audits generated construction application Word body for missing fields and worker count', () => {
    const feedback = buildConstructionPermitAuditFeedback(
      [
        {
          fieldname: 'applicationFiles',
          originalname: '20260623-施工申请-施工作业申请单.doc',
          mimetype: 'application/msword',
          size: 2048,
          buffer: Buffer.from(
            [
              '\ufeff<html><body><table>',
              '<tr><td>作业项目</td><td>EA118-A楼挖潜机房施工</td></tr>',
              '<tr><td>作业日期</td><td>2026年06月23日09时00分 至 2026年07月31日18时00分</td></tr>',
              '<tr><td>作业单位</td><td></td></tr>',
              '<tr><td>作业方负责人</td><td>示例人员009</td><td>联系电话</td><td>333</td><td>施工人数</td><td>5</td></tr>',
              '<tr><td>现场示例人员019</td><td>示例人员010</td><td>联系电话</td><td>333</td></tr>',
              '<tr><td>作业人员身份证号及资质证书（可另贴附件）：</td><td>1. 范柏各    320382198605102838    低压电工证 2. 潘仕学    52020319760302433X 3. 邓小利    500234199710113215</td></tr>',
              '<tr><td>作业地点</td><td>EA118 园区 A楼 楼栋 2F-3F 楼层 其他 房间或区域</td></tr>',
              '<tr><td>作业内容描述</td><td>EA118-A楼挖潜机房施工</td></tr>',
              '<tr><td>材料堆放点</td><td></td></tr>',
              '<tr><td>特殊作业</td><td>高处作业</td></tr>',
              '</table></body></html>',
            ].join(''),
            'utf8',
          ),
        },
      ],
      '施工申请单',
      [],
      new Date('2026-06-23T08:00:00+08:00'),
    );

    expect(feedback).toContain('填写：缺少作业单位、材料堆放点');
    expect(feedback).toContain('人员：作业人数疑似5人');
    expect(feedback).toContain('有效期：至2026-07-31');
    expect(feedback).not.toContain('人员：待核');
  });

  it('audits hot work risk disclosure as structured construction document feedback', () => {
    const payload = buildConstructionPermitVisionAuditPayload(
      [
        {
          fieldname: 'hotWorkRiskDisclosureFiles',
          originalname: '动火作业风险交底单.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('image-bytes'),
        },
      ],
      'vision-model',
      '动火作业风险交底单',
      {
        referenceDate: new Date('2026-06-12T08:00:00+08:00'),
        requiresValidity: false,
        context: {
          workContent: '动火焊接',
          workTypes: ['动火作业'],
          planStartTime: '2026-06-20 08:00',
        },
      },
    );
    const prompt =
      payload.messages[0].content.find((item) => item.type === 'text')?.text ||
      '';
    expect(prompt).toContain('风险交底单重点审核');
    expect(prompt).toContain('人员：疑似N人');
    expect(prompt).toContain('日期：交底早于作业');
    expect(prompt).not.toContain('安全告知书重点只看');

    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '通过',
        summary: '',
        expiryDate: null,
        issues: [
          '填写：风险识别、防范措施、应急措施可见',
          '人员：疑似5人全员签字',
          '日期：交底2026-06-07早于作业2026-06-08',
        ],
        suggestions: [],
      }),
      { requiresValidity: false },
    );

    expect(
      formatConstructionPermitVisionAuditFeedback(
        parsed,
        '动火作业风险交底单',
        { requiresValidity: false },
      ),
    ).toBe(
      '结论：通过；1. 填写：关键项可见；2. 人员：疑似5人；3. 日期：交底早于作业',
    );
  });

  it('audits construction application forms for completeness, crew ledger and exact validity', () => {
    const payload = buildConstructionPermitVisionAuditPayload(
      [
        {
          fieldname: 'applicationFiles',
          originalname: '施工作业申请单.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('image-bytes'),
        },
      ],
      'vision-model',
      '施工申请单',
      {
        referenceDate: new Date('2026-06-12T08:00:00+08:00'),
        context: {
          workContent: 'EA118-A挖潜机房施工',
          workTypes: ['动火作业'],
          planStartTime: '2026-06-20 08:00',
          crewMembers: [
            {
              name: '张鹏',
              certificateNo: '411024199110154959',
              authorizationStatus: '授权有效',
              certificateSummary: '低压电工证',
            },
          ],
        },
      },
    );

    const prompt =
      payload.messages[0].content.find((item) => item.type === 'text')?.text ||
      '';

    expect(prompt).toContain('施工申请单');
    expect(prompt).toContain('填充是否完整');
    expect(prompt).toContain('停用设备及能源切断');
    expect(prompt).toContain('可以不填');
    expect(prompt).toContain('施工人员台账');
    expect(prompt).toContain('可模糊匹配');
    expect(prompt).toContain('身份证');
    expect(prompt).toContain('不要把签字人数');
    expect(prompt).toContain('作业人数待核');
    expect(prompt).toContain('人员：作业人数疑似N人');
    expect(prompt).toContain('有效期需要精确识别');
    expect(prompt).toContain('张鹏');
    expect(prompt).toContain('411024199110154959');
  });

  it('does not infer signature dates as expiry dates for safety notice audit results', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '需人工复核',
        summary: '签署日期为 2026.5.22，签署人身份需要核验',
        expiryDate: null,
        issues: ['签署日期为 2026.5.22，但缺少施工项目'],
        suggestions: [],
      }),
      { requiresValidity: false },
    );

    expect(parsed.expiryDate).toBeNull();
    expect(
      formatConstructionPermitVisionAuditFeedback(parsed, '安全告知书'),
    ).toBe(
      '结论：需人工复核；分组：安全告知书；问题：签署日期为 2026.5.22，但缺少施工项目',
    );
    expect(
      formatConstructionPermitVisionAuditFeedback(parsed, '安全告知书', {
        requiresValidity: false,
      }),
    ).toBe('结论：需人工复核；1. 签署日期为2026.5.22；2. 但缺少施工项目');
  });

  it('formats safety notice feedback as short numbered image findings', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '不通过',
        summary: '',
        expiryDate: null,
        issues: [
          '附件文件类型为动火安全作业票，但未体现安全告知书内容、未见施工单位名称、签字身份无法确认、缺少作业地点',
        ],
        suggestions: [],
      }),
      { requiresValidity: false },
    );

    const feedback = formatConstructionPermitVisionAuditFeedback(
      parsed,
      '安全告知书',
      { requiresValidity: false },
    );

    expect(feedback).toBe(
      '结论：不通过；1. 类型为动火安全作业票；2. 但未体现安全告知书内容；3. 未见施工单位名称',
    );
    expect(
      feedback
        .split('；')
        .slice(1)
        .every((line) => line.replace(/^\d+[.．]\s*/, '').length <= 30),
    ).toBe(true);
  });

  it('keeps focused safety notice findings intact when they contain list punctuation', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '不通过',
        summary: '',
        expiryDate: null,
        issues: [
          '人员：应签人员至少6人（含服务商负责人、作业人员等）',
          '签字：图中仅见5人签名',
          '日期：签字日期早于计划开始',
        ],
        suggestions: [],
      }),
      { requiresValidity: false },
    );

    expect(
      formatConstructionPermitVisionAuditFeedback(parsed, '安全告知书', {
        requiresValidity: false,
      }),
    ).toBe(
      '结论：不通过；1. 人员：疑似6人；2. 签字：疑似5人签字；3. 日期：签字早于计划开始',
    );
  });

  it('removes redundant identity wording and keeps full safety notice date comparison', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '不通过',
        summary: '',
        expiryDate: null,
        issues: [
          '人员：应签人数无法确认、仅见5个签名',
          '签字：签名处有5人手写签名、但未明确对应人员身份',
          '日期：签字日期为2026.5.22、晚于施工计划开始时间2026-05-20',
        ],
        suggestions: [],
      }),
      { requiresValidity: false },
    );

    expect(
      formatConstructionPermitVisionAuditFeedback(parsed, '安全告知书', {
        requiresValidity: false,
      }),
    ).toBe(
      '结论：不通过；1. 人员：疑似5人；2. 日期：签字2026-05-22晚于计划2026-05-20',
    );
  });

  it('uses suspected safety notice headcount and removes duplicate signature count', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '不通过',
        summary: '',
        expiryDate: null,
        issues: [
          '人员：应签人数无法确认、仅见6个签名',
          '签字：第2页仅6人签字、缺多人签名（如合作方EHS、集群消防负责人）',
          '日期：签字日期为2026-05-22、晚于施工计划开始时间2026-06-04',
        ],
        suggestions: [],
      }),
      { requiresValidity: false },
    );

    expect(
      formatConstructionPermitVisionAuditFeedback(parsed, '安全告知书', {
        requiresValidity: false,
      }),
    ).toBe(
      '结论：不通过；1. 人员：疑似6人；2. 日期：签字2026-05-22早于计划2026-06-04',
    );
  });

  it('formats construction application audit feedback like safety notice results', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '需人工复核',
        summary: '',
        expiryDate: '2026-06-20',
        issues: ['人员：需核对台账'],
        suggestions: [],
      }),
    );

    expect(
      formatConstructionPermitVisionAuditFeedback(parsed, '施工申请单'),
    ).toBe(
      '结论：需人工复核；1. 填写：待核；2. 人员：需核对台账；3. 有效期：至2026-06-20',
    );
  });

  it('formats construction application issues as readable filling and personnel findings', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '不通过',
        summary: '',
        expiryDate: '2026-06-21',
        issues: [
          '完整性：作业内容',
          '人员：但施工人员签字处手写姓名与身份证号模糊',
          '有效期：至2026-06-21',
        ],
        suggestions: [],
      }),
    );

    expect(
      formatConstructionPermitVisionAuditFeedback(parsed, '施工申请单'),
    ).toBe(
      '结论：不通过；1. 填写：作业内容待核；2. 人员：作业人数待核，身份证模糊；3. 有效期：至2026-06-21',
    );
  });

  it('keeps suspected construction application headcount and ID status together', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '不通过',
        summary: '',
        expiryDate: '2026-06-21',
        issues: [
          '完整性：施工项目、作业内容、区域可见',
          '人员：疑似6人，身份证号填写完整',
          '有效期：至2026-06-21',
        ],
        suggestions: [],
      }),
    );

    expect(
      formatConstructionPermitVisionAuditFeedback(parsed, '施工申请单'),
    ).toBe(
      '结论：不通过；1. 填写：关键项可见；2. 人员：作业人数疑似6人，身份证完整；3. 有效期：至2026-06-21',
    );
  });

  it('prefers construction application work headcount over visible signature count', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '不通过',
        summary: '',
        expiryDate: '2026-06-21',
        issues: [
          '填写：关键项可见',
          '人员：签名5人，作业人数6人，身份证号填写完整',
          '有效期：至2026-06-21',
        ],
        suggestions: [],
      }),
    );

    expect(
      formatConstructionPermitVisionAuditFeedback(parsed, '施工申请单'),
    ).toBe(
      '结论：不通过；1. 填写：关键项可见；2. 人员：作业人数疑似6人，身份证完整；3. 有效期：至2026-06-21',
    );
  });

  it('does not use construction application signature count as worker count', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '需人工复核',
        summary: '',
        expiryDate: '2026-06-21',
        issues: [
          '填写：关键项可见',
          '人员：仅见5个签名，身份证号模糊',
          '有效期：至2026-06-21',
        ],
        suggestions: [],
      }),
    );

    expect(
      formatConstructionPermitVisionAuditFeedback(parsed, '施工申请单'),
    ).toBe(
      '结论：需人工复核；1. 填写：关键项可见；2. 人员：作业人数待核，身份证模糊；3. 有效期：至2026-06-21',
    );
  });

  it('formats training assessment audit feedback by sign-in count and assessment file count', () => {
    expect(
      buildConstructionTrainingAssessmentAuditFeedback({
        signInPersonCount: 5,
        assessmentFileCount: 4,
      }),
    ).toBe(
      '结论：不通过；1. 人数：签到疑似5人；2. 文件：考核4份；3. 匹配：缺1份',
    );

    expect(
      buildConstructionTrainingAssessmentAuditFeedback({
        signInPersonCount: null,
        assessmentFileCount: 4,
      }),
    ).toBe(
      '结论：需人工复核；1. 人数：签到人数待核；2. 文件：考核4份；3. 匹配：待核',
    );

    expect(CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD).toBe(
      'AI审核结果-培训考核',
    );
  });

  it('marks permit audit feedback with the verification date for daily refresh', () => {
    const today = new Date('2026-06-03T10:00:00+08:00');
    const yesterdayFeedback =
      '核验日期：2026-06-02；结论：通过；有效期至：2026-06-19；问题：无';
    const todayFeedback = buildDailyPermitAuditFeedbackWithDate(
      '结论：通过；分组：临时用电作业许可证；问题：无（有效期至 2026-06-19）',
      today,
    );

    expect(todayFeedback).toBe(
      '结论：通过；分组：临时用电作业许可证；问题：无（有效期至 2026-06-19）',
    );
    expect(
      shouldRefreshDailyPermitAuditFeedback(yesterdayFeedback, today),
    ).toBe(true);
    expect(shouldRefreshDailyPermitAuditFeedback(todayFeedback, today)).toBe(
      false,
    );
    expect(
      shouldRefreshDailyPermitAuditFeedback(
        '结论：通过；分组：临时用电作业许可证；问题：无（有效期至 2026-06-19）',
        today,
      ),
    ).toBe(false);
    expect(
      shouldRefreshDailyPermitAuditFeedback(
        '核验日期：2026-06-03；结论：通过；有效期至：2026-06-19；问题：无',
        today,
      ),
    ).toBe(true);
  });

  it('tells vision audit to use the hot work range end date instead of the start date', () => {
    const payload = buildConstructionPermitVisionAuditPayload(
      [
        {
          fieldname: 'hotWorkPermitFiles',
          originalname: '动火作业票.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('image-bytes'),
        },
      ],
      'vision-model',
      '动火许可证',
      { dailyValidityRefresh: true },
    );

    const prompt =
      payload.messages[0].content.find((item) => item.type === 'text')?.text ||
      '';

    expect(prompt).toContain('动火时间');
    expect(prompt).toContain('2026年6月4日11时20分');
    expect(prompt).toContain('2026年6月8日8时30分');
    expect(prompt).toContain('2026-06-08');
    expect(prompt).toContain('不能返回 2026-06-04');
    expect(prompt).toContain('签字日期');
    expect(prompt).toContain('审批日期');
    expect(prompt).toContain('验票日期');
  });

  it('formats daily permit validity from recognized expiry date', () => {
    const referenceDate = new Date('2026-06-03T10:00:00+08:00');
    const futureFeedback = formatConstructionPermitDailyValidityFeedback(
      {
        result: '不通过',
        summary:
          '作业时间截止日期为2026-06-19，早于当前核验日期2026-06-03，已过期',
        expiryDate: '2026-06-19',
        issues: ['作业时间截止日期早于核验日期'],
        suggestions: ['补充上传低压电工证'],
      },
      referenceDate,
      '临时用电作业许可证',
    );
    const expiredFeedback = formatConstructionPermitDailyValidityFeedback(
      {
        result: '通过',
        summary: '票面信息完整',
        expiryDate: '2026-05-21',
        issues: [],
        suggestions: [],
      },
      referenceDate,
      '动火许可证',
    );

    expect(futureFeedback).toBe(
      '结论：通过；分组：临时用电作业许可证；问题：无（有效期至 2026-06-19）',
    );
    expect(futureFeedback).not.toContain('已过期');
    expect(futureFeedback).not.toContain('建议：');
    expect(expiredFeedback).toBe(
      '结论：需人工复核；分组：动火许可证；问题：有效期至 2026-05-21，已过期，需今日人工审核',
    );
  });

  it('extracts permit expiry from previous daily audit feedback', () => {
    const expiryDate = extractConstructionPermitFeedbackExpiryDate(
      '核验日期：2026-06-02；核验版本：2；结论：通过；有效期至：2026-06-19；说明：临时用电作业许可证有效期未过期（当前核验日期 2026-06-02）；问题：无',
    );
    const refreshedFeedback = formatConstructionPermitDailyValidityFeedback(
      {
        result: '通过',
        summary: '',
        expiryDate,
        issues: [],
        suggestions: [],
      },
      new Date('2026-06-03T10:00:00+08:00'),
      '临时用电作业许可证',
    );

    expect(expiryDate).toBe('2026-06-19');
    expect(refreshedFeedback).toBe(
      '结论：通过；分组：临时用电作业许可证；问题：无（有效期至 2026-06-19）',
    );
  });

  it('extracts permit expiry from visible work-time range when expiryDate is null', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '通过',
        summary:
          '高处安全作业票可见，作业时间自2026年5月22日10时30分至2026年7月29日8时00分止。',
        expiryDate: null,
        issues: [],
        suggestions: [],
      }),
    );
    const feedback = formatConstructionPermitVisionAuditFeedback(parsed);

    expect(parsed.expiryDate).toBe('2026-07-29');
    expect(feedback).toBe(
      '结论：通过；分组：作业票；问题：无（有效期至 2026-07-29）',
    );
  });

  it('prefers the work-time range end date for temporary power permits', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '需人工复核',
        summary:
          '临时用电安全作业票可见，作业时间 自2026年5月26日9时30分 至2026年6月19日18时00分止。合作伙伴意见签字日期为2026年5月26日。',
        expiryDate: '2026-05-26',
        issues: ['审批签字需人工核验'],
        suggestions: [],
      }),
    );

    expect(parsed.expiryDate).toBe('2026-06-19');
    expect(formatConstructionPermitVisionAuditFeedback(parsed)).toBe(
      '结论：需人工复核；分组：作业票；问题：审批签字需人工核验（有效期至 2026-06-19）',
    );
  });

  it('uses the end date from compact permit filename ranges over the AI start date', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '通过',
        summary:
          '动火作业票已识别，附件名为动火作业单6.8-6.10.jpg，票面有效期未过期。',
        expiryDate: '2026-06-08',
        issues: [],
        suggestions: [],
      }),
    );

    expect(parsed.expiryDate).toBe('2026-06-10');
    expect(formatConstructionPermitVisionAuditFeedback(parsed)).toBe(
      '结论：通过；分组：作业票；问题：无（有效期至 2026-06-10）',
    );
  });

  it('prefers the hot work time range end date over signature dates', () => {
    const parsed = parseConstructionPermitVisionAuditResponse(
      JSON.stringify({
        result: '不通过',
        summary:
          '动火安全作业票可见，动火时间 自2026年5月31日9时30分 至2026年6月3日18时00分止。合作伙伴EHS工程师签字日期为2026年5月31日，验票日期为2026年5月29日。',
        expiryDate: '2026-05-31',
        issues: ['签字日期需人工核验'],
        suggestions: [],
      }),
    );

    expect(parsed.expiryDate).toBe('2026-06-03');
    expect(formatConstructionPermitVisionAuditFeedback(parsed)).toBe(
      '结论：不通过；分组：作业票；问题：签字日期需人工核验（有效期至 2026-06-03）',
    );
  });

  it('sends image permit files to vision audit even when upload mimetype is generic', () => {
    const payload = buildConstructionPermitVisionAuditPayload(
      [
        {
          fieldname: 'temporaryPowerPermitFiles',
          originalname: '临时用电作业票.jpg',
          mimetype: 'application/octet-stream',
          size: 1024,
          buffer: Buffer.from('image-bytes'),
        },
      ],
      'qwen-vl-max-latest',
      '临时用电作业许可证',
    );

    const image = payload.messages[0].content.find(
      (item) => item.type === 'image_url',
    );

    expect(image?.image_url.url).toContain('data:image/jpeg;base64,');
  });

  it('builds fallback permit audit feedback when only rules can be generated', () => {
    const feedback = buildConstructionPermitAuditFeedback(
      [
        {
          fieldname: 'heightWorkPermitFiles',
          originalname: '高处作业票.pdf',
          mimetype: 'application/pdf',
          size: 1024,
          buffer: Buffer.from('pdf'),
        },
      ],
      '高处作业许可证',
    );

    expect(feedback).toBe(
      '结论：需人工复核；分组：高处作业许可证；问题：有效期未识别，需人工核验',
    );
  });

  it('infers fallback hot work permit expiry from compact attachment filename ranges', () => {
    const feedback = buildConstructionPermitAuditFeedback(
      [
        {
          fieldname: 'hotWorkPermitFiles',
          originalname: '动火作业单6.8-6.10.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('image'),
        },
      ],
      '动火许可证',
      [],
      new Date('2026-06-11T08:00:00+08:00'),
    );

    expect(feedback).toBe(
      '结论：需人工复核；分组：动火许可证；问题：有效期至 2026-06-10，已过期，需今日人工审核',
    );
  });

  it('adds matched form audit requirements to hot work permit audit prompts', () => {
    const requirementRows = [
      {
        fields: {
          作业类型: ['动火作业'],
          需上传文件: ['安全告知书照片', '动火许可证'],
          所需作业证: ['焊接与热切割证'],
          表单审核要求: [{ name: '动火作业单审核要点.docx' }],
          施工准备要求:
            '检查《南通集群作业申请单》《动火作业许可证》按流程审批完成。',
        },
      },
      {
        fields: {
          作业类型: ['高处作业'],
          需上传文件: ['高处作业许可证'],
          表单审核要求: [{ name: '高处作业单审核要点.docx' }],
          施工准备要求: '检查《高处作业许可证》按流程审批完成。',
        },
      },
    ];
    const requirementLines = buildConstructionPermitAuditRequirementLines(
      requirementRows,
      '动火许可证',
      ['动火作业'],
    );

    expect(requirementLines.join('\n')).toContain('动火作业单审核要点.docx');
    expect(requirementLines.join('\n')).toContain('焊接与热切割证');
    expect(requirementLines.join('\n')).toContain(
      '对应表单审核要点：动火作业单审核要点.docx',
    );
    expect(requirementLines.join('\n')).toContain('动火方式');
    expect(requirementLines.join('\n')).toContain('最长不得超过3天');
    expect(requirementLines.join('\n')).not.toContain(
      '高处作业单审核要点.docx',
    );

    const payload = buildConstructionPermitVisionAuditPayload(
      [
        {
          fieldname: 'hotWorkPermitFiles',
          originalname: '动火作业票.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('image-bytes'),
        },
      ],
      'vision-model',
      '动火许可证',
      { requirementLines },
    );
    const prompt =
      payload.messages[0].content.find((item) => item.type === 'text')?.text ||
      '';
    const feedback = buildConstructionPermitAuditFeedback(
      [
        {
          fieldname: 'hotWorkPermitFiles',
          originalname: '动火作业票.pdf',
          mimetype: 'application/pdf',
          size: 1024,
          buffer: Buffer.from('pdf'),
        },
      ],
      '动火许可证',
      requirementLines,
    );

    expect(prompt).toContain('动火作业单审核要点.docx');
    expect(prompt).toContain('必须逐项核对“表单审核要求”的对应审核要点');
    expect(prompt).toContain('动火作业许可证');
    expect(feedback).toBe(
      '结论：需人工复核；分组：动火许可证；问题：有效期未识别，需人工核验',
    );
    expect(feedback).not.toContain('动火作业单审核要点.docx');
    expect(feedback).not.toContain('焊接与热切割证');
  });

  it('uses solidified audit requirements when the remote requirement table is unavailable', () => {
    const requirementLines = buildConstructionPermitAuditRequirementLines(
      [],
      '高处作业许可证',
      ['高处作业'],
    );
    const joined = requirementLines.join('\n');

    expect(joined).toContain('匹配作业类型：高处作业');
    expect(joined).toContain(
      '需上传文件：安全告知书照片、培训照片、高处作业许可证',
    );
    expect(joined).toContain('所需作业证：高处作业证');
    expect(joined).toContain('表单审核要求：高处作业单审核要点.docx');
    expect(joined).toContain('对应表单审核要点：高处作业单审核要点.docx');
    expect(joined).toContain('最长不得超过7天');
    expect(joined).toContain('作业时间起止完整');
  });

  it('reads form audit requirement attachment names from file_name metadata', () => {
    const requirementLines = buildConstructionPermitAuditRequirementLines(
      [
        {
          fields: {
            作业类型: ['高处作业'],
            需上传文件: ['高处作业许可证'],
            表单审核要求: [{ file_name: '高处作业单审核要点-现场版.docx' }],
          },
        },
      ],
      '高处作业许可证',
      ['高处作业'],
    );
    const joined = requirementLines.join('\n');

    expect(joined).toContain('表单审核要求：高处作业单审核要点-现场版.docx');
    expect(joined).toContain(
      '对应表单审核要点：高处作业单审核要点-现场版.docx',
    );
  });

  it('merges renewed permit attachments without removing old tokens', () => {
    const merged = mergeConstructionAttachmentFieldValues(
      {
        高处作业许可证: [{ file_token: 'old-token', name: '旧高处作业票.pdf' }],
      },
      {
        高处作业许可证: [
          { file_token: 'new-token' },
          { file_token: 'old-token' },
        ],
      },
    );

    expect(merged).toEqual({
      高处作业许可证: [
        { file_token: 'old-token' },
        { file_token: 'new-token' },
      ],
    });
  });

  it('does not treat an unchanged uploaded construction attachment as changed', async () => {
    const files = await filterChangedConstructionUploadFilesByContent(
      [
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '水印测试.JPG',
          mimetype: 'image/jpeg',
          size: Buffer.byteLength('same-file'),
          buffer: Buffer.from('same-file'),
        },
        {
          fieldname: 'heightWorkPermitFiles',
          originalname: '新高处作业票.pdf',
          mimetype: 'application/pdf',
          size: 2048,
          buffer: Buffer.from('new-file'),
        },
      ],
      {
        挂牌与隔离照片: [
          {
            file_token: 'old-token',
            name: '水印测试.JPG',
            size: Buffer.byteLength('same-file'),
          },
        ],
      },
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
      async (fileToken) => {
        expect(fileToken).toBe('old-token');
        return Buffer.from('same-file');
      },
    );

    expect(files.map((file) => file.fieldname)).toEqual([
      'heightWorkPermitFiles',
    ]);
  });

  it('treats a same-name same-size construction attachment as changed when content differs', async () => {
    const changed = await filterChangedConstructionUploadFilesByContent(
      [
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '水印测试.JPG',
          mimetype: 'image/jpeg',
          size: Buffer.byteLength('new-file'),
          buffer: Buffer.from('new-file'),
        },
      ],
      {
        挂牌与隔离照片: [
          {
            file_token: 'old-token',
            name: '水印测试.JPG',
            size: Buffer.byteLength('new-file'),
          },
        ],
      },
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
      async () => Buffer.from('old-file'),
    );

    expect(changed.map((file) => file.fieldname)).toEqual([
      'isolationPhotoFiles',
    ]);
  });

  it('keeps the legacy metadata filter conservative for same-name same-size files', () => {
    const files = filterChangedConstructionUploadFiles(
      [
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '水印测试.JPG',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('same-size-but-unknown-content'),
        },
      ],
      {
        挂牌与隔离照片: [
          { file_token: 'old-token', name: '水印测试.JPG', size: 1024 },
        ],
      },
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS,
    );

    expect(files.map((file) => file.fieldname)).toEqual([
      'isolationPhotoFiles',
    ]);
  });

  it('omits unchanged construction feedback fields from update payloads', () => {
    const fields = {
      施工总览: ['recConstruction'],
      '挂牌&隔离合规反馈': 'AI审核：已完成',
      'AI识别反馈（过程）': '现场反馈已填写',
    };

    const changed = omitUnchangedConstructionFieldValues(fields, {
      '挂牌&隔离合规反馈': 'AI审核：已完成',
      'AI识别反馈（过程）': '现场反馈已调整',
    });

    expect(changed).toEqual({
      施工总览: ['recConstruction'],
      'AI识别反馈（过程）': '现场反馈已填写',
    });
  });

  it('includes construction context in the vision audit prompt for watermark matching', () => {
    const payload = buildIsolationPhotoVisionAuditPayload(
      [
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '水印照片.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('image-bytes'),
        },
      ],
      'vision-model',
      {
        context: {
          constructionCode: 'SG260505-1031',
          workContent: 'EA118-A楼挖潜机房施工',
          building: 'A楼',
          planStartTime: '2026-05-28T09:00:00+08:00',
          planEndTime: '2026-06-30T18:00:00+08:00',
        },
      },
    );

    const prompt =
      payload.messages[0].content.find((item) => item.type === 'text')?.text ||
      '';

    expect(prompt).toContain('SG260505-1031');
    expect(prompt).toContain('EA118-A楼挖潜机房施工');
    expect(prompt).toContain('A楼');
    expect(prompt).toContain('不要求字段名称完全一致');
  });

  it('adds DeepSeek non-thinking mode when requested', () => {
    const payload = buildIsolationPhotoVisionAuditPayload(
      [
        {
          fieldname: 'isolationPhotoFiles',
          originalname: '水印照片.jpg',
          mimetype: 'image/jpeg',
          size: 1024,
          buffer: Buffer.from('image-bytes'),
        },
      ],
      'deepseek-v4-pro',
      { disableThinking: true },
    );

    expect(payload.thinking).toEqual({ type: 'disabled' });
  });

  it('reports Qwen image audit configuration status without exposing keys', () => {
    const configured = buildConstructionImageAuditStatus({
      apiKey: 'sk-secret',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-vl-max-latest',
    });

    expect(configured).toEqual({
      configured: true,
      provider: 'Qwen',
      model: 'qwen-vl-max-latest',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      supportsImageInput: true,
      message: 'Qwen qwen-vl-max-latest 已配置',
    });
    expect(JSON.stringify(configured)).not.toContain('sk-secret');

    expect(buildConstructionImageAuditStatus(null)).toMatchObject({
      configured: false,
      provider: 'OpenAI兼容模型',
      model: null,
      baseUrl: null,
      supportsImageInput: true,
    });
  });

  it('formats parsed vision audit result for bitable feedback', () => {
    const parsed = parseIsolationPhotoVisionAuditResponse(
      JSON.stringify({
        result: '不通过',
        summary: '缺少施工铭牌',
        watermark: {
          complete: true,
          hasVnetLogo: true,
          missing: [],
        },
        onsite: {
          isolationTape: true,
          warningSign: true,
          constructionNameplate: false,
        },
        issues: ['未看到施工铭牌'],
        suggestions: ['补拍包含施工铭牌的挂牌隔离照片'],
      }),
    );

    const feedback = formatIsolationPhotoVisionAuditFeedback(parsed);

    expect(feedback).toBe(
      '结论：不通过｜水印核验：通过｜现场核验：不通过（未识别：施工铭牌）',
    );
    expect(feedback).not.toContain('整改建议');
  });

  it('does not mark the VNET watermark logo missing when the logo block is recognized', () => {
    const parsed = parseIsolationPhotoVisionAuditResponse(
      JSON.stringify({
        result: '通过',
        summary: '水印中可见蓝底白字世纪互联 VNET 品牌块',
        watermark: {
          complete: false,
          hasVnetLogo: true,
          missing: ['世纪互联/VNET标识logo'],
        },
        onsite: {
          isolationTape: true,
          warningSign: true,
          constructionNameplate: true,
        },
        issues: [],
        suggestions: [],
      }),
    );

    const feedback = formatIsolationPhotoVisionAuditFeedback(parsed);

    expect(feedback).toBe('结论：通过｜水印核验：通过｜现场核验：通过');
  });

  it('passes watermark verification when the VNET logo is recognized even if context text is mismatched', () => {
    const parsed = parseIsolationPhotoVisionAuditResponse(
      JSON.stringify({
        result: '不通过',
        summary: '可见世纪互联 VNET 水印，但现场隔离要素缺失',
        watermark: {
          complete: false,
          hasVnetLogo: true,
          missing: ['项目/机房标题', '工作内容', '拍摄时间', '地点'],
        },
        onsite: {
          isolationTape: false,
          warningSign: false,
          constructionNameplate: false,
        },
        issues: ['未看到隔离带、警示牌、施工铭牌'],
        suggestions: ['补拍挂牌隔离现场照片'],
      }),
    );

    const feedback = formatIsolationPhotoVisionAuditFeedback(parsed);

    expect(feedback).toBe(
      '结论：不通过｜水印核验：通过｜现场核验：不通过（未识别：隔离带、警示牌、施工铭牌）',
    );
  });

  it('downgrades passing vision audit when onsite essentials are missing', () => {
    const parsed = parseIsolationPhotoVisionAuditResponse(
      JSON.stringify({
        result: '通过',
        summary: '水印信息完整',
        watermark: {
          complete: true,
          hasVnetLogo: true,
          missing: [],
        },
        onsite: {
          isolationTape: false,
          warningSign: false,
          constructionNameplate: false,
        },
        issues: [],
        suggestions: [],
      }),
    );

    const feedback = formatIsolationPhotoVisionAuditFeedback(parsed);

    expect(feedback).toBe(
      '结论：不通过｜水印核验：通过｜现场核验：不通过（未识别：隔离带、警示牌、施工铭牌）',
    );
    expect(feedback).not.toContain('整改建议');
  });

  it('normalizes completion checklist and requires all close items to be checked', () => {
    const completeChecklist = CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS.map(
      (item) => ({
        key: item.key,
        result: item.key === 'compliance-1-1' ? '×' : '√',
        remark: item.key === 'compliance-1-1' ? '需补齐施工记录' : '',
      }),
    );

    const normalized = normalizeConstructionCompletionChecklist(
      JSON.stringify(completeChecklist),
    );

    expect(normalized).toHaveLength(
      CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS.length,
    );
    expect(normalized[0]).toMatchObject({
      key: 'compliance-1-1',
      result: '×',
      remark: '需补齐施工记录',
    });
    expect(() =>
      normalizeConstructionCompletionChecklist(
        JSON.stringify(completeChecklist.slice(1)),
      ),
    ).toThrow('每日收尾检查清单需完成全部检查项');
    expect(() =>
      normalizeConstructionCompletionChecklist(
        JSON.stringify(
          completeChecklist.map((item) =>
            item.key === 'compliance-1-1' ? { ...item, remark: '' } : item,
          ),
        ),
      ),
    ).toThrow('不合格检查项需填写整改说明');
  });

  it('uses the daily completion checklist when the project continues tomorrow', () => {
    expect(getConstructionCompletionChecklistItems('是')).toBe(
      CONSTRUCTION_FULL_COMPLETION_CHECKLIST_ITEMS,
    );
    expect(getConstructionCompletionChecklistItems('否')).toBe(
      CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS,
    );

    const dailyChecklist = CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS.map(
      (item) => ({
        key: item.key,
        result: '√' as const,
        remark: '',
      }),
    );

    const normalized = normalizeConstructionCompletionChecklist(
      JSON.stringify(dailyChecklist),
      CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS,
    );

    expect(normalized).toHaveLength(
      CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS.length,
    );
    expect(normalized.at(-1)?.key).toBe('overall-6-1');
    expect(() =>
      normalizeConstructionCompletionChecklist(
        JSON.stringify(dailyChecklist),
        CONSTRUCTION_FULL_COMPLETION_CHECKLIST_ITEMS,
      ),
    ).toThrow('每日收尾检查清单需完成全部检查项');
  });

  it('persists and reads back daily close checklist answers for later editing', () => {
    const dailyChecklist = CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS.map(
      (item) => ({
        key: item.key,
        result: item.key === 'overall-6-1' ? ('N/A' as const) : ('√' as const),
        remark: item.key === 'overall-6-1' ? '今日未全部收尾' : '',
      }),
    );
    const built = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'daily',
      dailyFollowupStage: 'close',
      followupStaffIds: ['ou_1'],
      completed: '否',
      completionChecklist: dailyChecklist,
    });

    expect(built.fields).toHaveProperty(
      '每日收尾检查清单',
      JSON.stringify(built.normalized.completionChecklist),
    );
    expect(built.fields).toHaveProperty('EHS施工收尾审批', true);

    const result = buildConstructionManagementView({
      generatedAt: '2026-06-05T10:00:00.000Z',
      referenceDate: new Date('2026-06-05T00:00:00+08:00'),
      overviewRecords: [],
      crewRecords: [],
      followupRecords: [
        {
          record_id: 'recCloseFollowup',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编码: 'SG260605-1035',
            作业内容: '测试-A',
            是否完成: '否',
            每日收尾检查清单: JSON.stringify(
              built.normalized.completionChecklist,
            ),
            每日收尾照片: [{ file_token: 'closePhoto', name: '收尾.jpg' }],
            施工检查表: [{ file_token: 'checklist', name: '检查表.xlsx' }],
            EHS施工收尾审批: true,
          },
        },
      ],
    });

    expect((result.followups[0] as any).completionChecklist).toEqual(
      built.normalized.completionChecklist,
    );
    expect((result.followups[0] as any).closingApproval).toBe('通过');
  });

  it('builds a generated completion checklist workbook for the inspection form field', () => {
    const checklist = normalizeConstructionCompletionChecklist(
      JSON.stringify(
        CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS.map((item) => ({
          key: item.key,
          result: item.key === 'temporary-power-2-1' ? 'N/A' : '√',
          remark: item.key === 'temporary-power-2-1' ? '本日无临电拆除项' : '',
        })),
      ),
    );

    const file = buildConstructionCompletionChecklistFile({
      checklist,
      constructionCode: 'SG260505-1029',
      workContent: 'A楼挖潜机房施工',
      building: 'A楼',
      contractor: '外部施工单位',
      completedAt: new Date('2026-05-24T10:30:00+08:00'),
    });

    expect(file.fieldname).toBe('inspectionFormFiles');
    expect(file.originalname).toContain('施工完工检查表');
    expect(file.mimetype).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(file.size).toBe(file.buffer.length);

    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const worksheet = workbook.Sheets['施工完工检查表'];
    expect(worksheet).toBeTruthy();
    expect(worksheet['A1']?.v).toBe('施工完工检查表');
    expect(worksheet['B3']?.v).toContain('A楼挖潜机房施工');
    expect(worksheet['E5']?.v).toBe('2026-05-24');
    expect(worksheet['D11']?.v).toBe('N/A');
    expect(worksheet['E11']?.v).toBe('本日无临电拆除项');
  });

  it('appends daily personnel checklist rows by date without duplicating the same person', () => {
    const firstFile = buildDailyPersonnelChecklistFile({
      constructionCode: 'SG260505-1031',
      workContent: 'EA118-A楼挖潜机房施工',
      building: 'A楼',
      checker: '示例人员011',
      checkDate: new Date('2026-05-29T09:00:00+08:00'),
      participants: [
        {
          recordId: 'crew-1',
          name: '示例人员008',
          certificateSummary: '高处作业证，有效期至2026-06-30',
          complianceStatus: '正常',
          issueSummary: null,
        },
      ],
    });
    const secondFile = buildDailyPersonnelChecklistFile({
      existingWorkbookBuffer: firstFile.buffer,
      constructionCode: 'SG260505-1031',
      workContent: 'EA118-A楼挖潜机房施工',
      building: 'A楼',
      checker: '示例人员011',
      checkDate: new Date('2026-05-29T15:00:00+08:00'),
      participants: [
        {
          recordId: 'crew-1',
          name: '示例人员008',
          certificateSummary: '高处作业证，有效期至2026-06-30',
          complianceStatus: '正常',
          issueSummary: null,
        },
        {
          recordId: 'crew-2',
          name: '示例人员013',
          certificateSummary: '焊接与热切割证，有效期至2026-07-01',
          complianceStatus: '正常',
          issueSummary: null,
        },
        {
          recordId: 'crew-3',
          name: '示例人员017',
          certificateSummary: null,
          complianceStatus: null,
          issueSummary: null,
        },
      ],
    });

    expect(secondFile.fieldname).toBe('dailyPersonnelChecklistFiles');
    expect(secondFile.originalname).toContain('每日人员核查清单');

    const workbook = XLSX.read(secondFile.buffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
      workbook.Sheets['每日人员核查清单'],
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row['日期'])).toEqual([
      '2026-05-29',
      '2026-05-29',
      '2026-05-29',
    ]);
    expect(rows.map((row) => row['人员姓名'])).toEqual([
      '示例人员008',
      '示例人员013',
      '示例人员017',
    ]);
    expect(rows[0]['证件摘要']).toContain('高处作业证');
    expect(rows[1]['人员记录ID']).toBe('crew-2');
    expect(rows[2]['证件摘要'] || '').toBe('');
  });

  it('allows initial application follow-ups with files and rejects empty submissions', () => {
    const { normalized } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'supplemental',
    });

    expect(() =>
      validateConstructionFollowupSubmission(normalized, []),
    ).toThrow('初始申请至少选择一个作业类型或上传一个附件');
    expect(() =>
      validateConstructionFollowupSubmission(normalized, [
        {
          fieldname: 'applicationFiles',
          originalname: '施工申请单.pdf',
          mimetype: 'application/pdf',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).not.toThrow();
  });

  it('allows temporary power permit files as initial application content', () => {
    const { normalized } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'supplemental',
    });

    expect(() =>
      validateConstructionFollowupSubmission(normalized, [
        {
          fieldname: 'temporaryPowerPermitFiles',
          originalname: '临时用电作业票.pdf',
          mimetype: 'application/pdf',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).not.toThrow();
  });

  it('matches temporary power permit audit requirements', () => {
    const requirementLines = buildConstructionPermitAuditRequirementLines(
      [
        {
          fields: {
            作业类型: ['临时用电作业'],
            需上传文件: ['临时用电作业许可证'],
            所需作业证: ['低压电工证'],
            表单审核要求: [{ name: '临时用电作业审核要点.docx' }],
            施工准备要求:
              '检查《南通集群作业申请单》《临时用电作业许可证》按流程审批完成。',
          },
        },
      ],
      '临时用电作业许可证',
      ['临时用电作业'],
    );

    expect(requirementLines.join('\n')).toContain('低压电工证');
    expect(requirementLines.join('\n')).toContain('临时用电作业审核要点.docx');
    expect(requirementLines.join('\n')).toContain(
      '对应表单审核要点：临时用电作业审核要点.docx',
    );
    expect(requirementLines.join('\n')).toContain(
      '电源接入点+用电设备、电压、功率',
    );
    expect(requirementLines.join('\n')).toContain('最长不得超过15天');
  });

  it('ignores leaked Feishu option ids in supplemental work types', () => {
    const fireSystemWorkType =
      '\u6d88\u9632\u7cfb\u7edf\u5173\u95ed\u4f5c\u4e1a';
    const { fields, normalized } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'supplemental',
      workTypes: JSON.stringify(['optuOG6rh9', fireSystemWorkType]),
    });

    expect(normalized.workTypes).toEqual([fireSystemWorkType]);
    expect(fields).not.toHaveProperty('\u4f5c\u4e1a\u7c7b\u578b');
    expect(buildConstructionFollowupOverviewFields(normalized as any)).toEqual({
      '\u4f5c\u4e1a\u7c7b\u578b': [fireSystemWorkType],
    });
  });

  it('rejects construction issue-only first supplemental submissions with leaked option ids', () => {
    const { fields, normalized } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupMode: 'supplemental',
      workTypes: JSON.stringify(['optuOG6rh9']),
    });

    expect(normalized.workTypes).toEqual([]);
    expect(fields).not.toHaveProperty('\u4f5c\u4e1a\u7c7b\u578b');
    expect(() =>
      validateConstructionFollowupSubmission(normalized, [
        {
          fieldname: 'constructionIssueFiles',
          originalname: 'issue.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).toThrow();
  });

  it('allows construction issue-only supplemental updates after the initial follow-up exists', () => {
    const { fields, normalized } = buildConstructionFollowupFields({
      constructionRecordId: 'recOverview',
      followupRecordId: 'recInitialFollowup',
      followupMode: 'supplemental',
      workTypes: JSON.stringify(['optuOG6rh9']),
    });

    expect(normalized.workTypes).toEqual([]);
    expect(fields).not.toHaveProperty('\u4f5c\u4e1a\u7c7b\u578b');
    expect(() =>
      validateConstructionFollowupSubmission(normalized, [
        {
          fieldname: 'constructionIssueFiles',
          originalname: 'issue.xlsx',
          mimetype:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          size: 1,
          buffer: Buffer.from('x'),
        },
      ]),
    ).not.toThrow();
  });

  it('combines overview and follow-up records into dashboard data', () => {
    const result = buildConstructionManagementView({
      generatedAt: '2026-05-23T10:00:00.000Z',
      overviewSourceUrl:
        'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
      followupSourceUrl:
        'https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE',
      referenceDate: new Date('2026-05-23T00:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverview',
          fields: {
            施工编号: 'SG260505-1029',
            作业内容: 'A楼挖潜机房施工',
            计划开始时间: 1779661200000,
            计划结束日期: 1785502800000,
            专业: ['其他'],
            楼栋: ['A楼'],
            作业类型: ['一般作业'],
            '施工方（内部/施工单位）': ['外部'],
            示例人员001审批: ['通过'],
            是否已知会EHS工程师: true,
            EHS确认: ['通过'],
            证件审核结果: '通过',
            是否缴纳保证金: '否',
            施工剩余天数: 69,
            施工问题: [
              { file_token: 'issue1', name: '施工问题照片.jpg', size: 12345 },
            ],
            施工完工检查清单: [
              {
                file_token: 'archive1',
                name: '施工完工检查表.xlsx',
                size: 67890,
              },
            ],
          },
        },
      ],
      crewRecords: [
        {
          record_id: 'recCrew1',
          fields: {
            施工编号: 'SG260505-1029',
            姓名: '张鹏',
            手机号: '13800004492',
            授权开始日期: '2026-05-01',
            授权结束日期: '2026-06-30',
            授权状态: '已过期',
            持证统计: '低压电工证,高处作业证,',
            人员持证是否达标: '合规',
            总结: '',
          },
        },
      ],
      followupRecords: [
        {
          record_id: 'recFollowup',
          fields: {
            跟进记录: 'SG260505-1029-A楼挖潜机房施工',
            施工总览: [],
            施工编号: 'SG260505-1029',
            跟进人员: [{ id: 'ou_follow_1', name: '示例人员008伟' }],
            作业内容: 'A楼挖潜机房施工',
            作业类型: ['一般作业'],
            当日作业类型: ['动火作业'],
            施工天数: '1',
            是否最新: '最新',
            是否完成: '否',
            '挂牌&隔离是否合规': ['否'],
            'AI识别反馈（过程）': '过程照片缺少挂牌隔离标识',
            最后更新时间: 1780019694000,
            施工作业申请单: [
              { file_token: 'file1', name: '作业申请单.pdf', size: 712883 },
            ],
            临时用电作业许可证: [
              { file_token: 'temp1', name: '临时用电票.jpg', size: 247817 },
            ],
            'AI审核结果-临时用电许可证':
              '结论：需人工复核；有效期至：未识别；问题：票面信息需人工核验',
          },
        },
      ],
    });

    expect(result.summary).toMatchObject({
      total: 1,
      active: 0,
      pendingApproval: 0,
      endingSoon: 0,
      attachmentIssues: 1,
    });
    expect(result.items[0].latestFollowup?.recordId).toBe('recFollowup');
    expect(result.items[0].latestFollowup?.aiIssues).toEqual([
      '过程照片缺少挂牌隔离标识',
      '结论：需人工复核、有效期至：未识别、问题：票面信息需人工核验',
    ]);
    expect(result.items[0].latestFollowup?.followupStaffMembers).toEqual([
      { id: 'ou_follow_1', name: '示例人员008伟' },
    ]);
    expect(result.items[0].approval).toMatchObject({
      supervisor: '通过',
      ehsNotified: '已知会',
      ehs: '通过',
      credential: null,
      depositPaid: '否',
    });
    expect(result.items[0].recordUrl).toContain('record=recOverview');
    expect(result.items[0].constructionIssues).toMatchObject([
      { fileToken: 'issue1', name: '施工问题照片.jpg', size: 12345 },
    ]);
    expect(result.items[0].completionChecklistArchive).toMatchObject([
      { fileToken: 'archive1', name: '施工完工检查表.xlsx', size: 67890 },
    ]);
    expect(result.items[0].crewMembers[0]).toMatchObject({
      recordId: 'recCrew1',
      name: '张鹏',
      phone: '13800004492',
      authorizationStartDate: '2026-05-01T00:00:00.000Z',
      authorizationEndDate: '2026-06-30T00:00:00.000Z',
      authorizationStatus: '授权有效',
      certificateSummary: '低压电工证、高处作业证',
      complianceStatus: '合规',
    });
    expect(result.followups[0].attachments[0]).toMatchObject({
      field: '施工作业申请单',
      count: 1,
    });
    expect(
      result.followups[0].attachments.find(
        (item) => item.label === '临时用电作业票',
      ),
    ).toMatchObject({
      count: 1,
      feedback: '结论：需人工复核、有效期至：未识别、问题：票面信息需人工核验',
    });
    expect(result.followups[0].followupStaff).toBe('示例人员008伟');
    expect(result.followups[0].workTypes).toEqual(['动火作业']);
    expect(result.followups[0]).toMatchObject({
      dailyWorkTypesConfirmed: true,
    });
  });

  it('does not mark legacy follow-up work types as confirmed daily work types', () => {
    const result = buildConstructionManagementView({
      generatedAt: '2026-07-23T10:00:00.000Z',
      referenceDate: new Date('2026-07-23T00:00:00+08:00'),
      overviewRecords: [],
      crewRecords: [],
      followupRecords: [
        {
          record_id: 'recLegacyFollowup',
          fields: {
            跟进记录: 'SG260505-1041-旧跟进',
            作业类型: ['高处作业'],
          },
        },
      ],
    });

    expect(result.followups[0]).toMatchObject({
      workTypes: ['高处作业'],
      dailyWorkTypesConfirmed: false,
    });
  });

  it('maps the manual isolation review field into follow-up compliance status', () => {
    const result = buildConstructionManagementView({
      generatedAt: '2026-06-09T10:00:00.000Z',
      referenceDate: new Date('2026-06-09T00:00:00+08:00'),
      overviewRecords: [],
      crewRecords: [],
      followupRecords: [
        {
          record_id: 'recIsolationReviewPassed',
          fields: {
            跟进记录: 'SG260505-1040-每日准备',
            施工编码: 'SG260505-1040',
            作业内容: 'EA118-A挖潜机房施工',
            '人工审核-挂牌&隔离审核': ['通过'],
          },
        },
      ],
    });

    expect(result.followups[0]?.isolationCompliant).toBe('通过');
  });

  it('maps the isolation AI audit result field into follow-up feedback', () => {
    const result = buildConstructionManagementView({
      generatedAt: '2026-06-09T10:00:00.000Z',
      referenceDate: new Date('2026-06-09T00:00:00+08:00'),
      overviewRecords: [],
      crewRecords: [],
      followupRecords: [
        {
          record_id: 'recIsolationAiFeedback',
          fields: {
            跟进记录: 'SG260505-1040-每日准备',
            施工编码: 'SG260505-1040',
            作业内容: 'EA118-A挖潜机房施工',
            'AI审核结果-挂牌&隔离照片': '挂牌隔离审核通过',
          },
        },
      ],
    });

    expect(result.followups[0]?.isolationFeedback).toBe('挂牌隔离审核通过');
  });

  it('marks passed daily permit feedback as a complete attachment', () => {
    const tempPowerField =
      CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS.temporaryPowerPermitFiles;
    const tempPowerFeedbackField =
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS.temporaryPowerPermitFiles
        .feedbackField;
    const result = buildConstructionManagementView({
      generatedAt: '2026-06-03T10:00:00.000Z',
      referenceDate: new Date('2026-06-03T00:00:00+08:00'),
      overviewRecords: [],
      crewRecords: [],
      followupRecords: [
        {
          record_id: 'recFollowupPassedPermit',
          fields: {
            跟进记录: 'SG260605-1035-测试-A',
            施工编号: 'SG260605-1035',
            作业内容: '测试-A',
            [tempPowerField]: [
              {
                file_token: 'temp1',
                name: '临时用电作业票.jpg',
                size: 247817,
              },
            ],
            [tempPowerFeedbackField]:
              '核验日期：2026-06-03；核验版本：6；结论：通过；有效期至：2026-06-19；说明：临时用电作业许可证有效期未过期（当前核验日期 2026-06-03）；问题：无',
            '人员审核-临时用电作业许可证': true,
          },
        },
      ],
    });

    expect(
      result.followups[0].attachments.find(
        (item) => item.label === tempPowerField,
      ),
    ).toMatchObject({
      count: 1,
      status: 'complete',
      manualReview: {
        reviewed: true,
        field: '人工审核-临时用电许可证',
      },
    });
    expect(result.followups[0].aiIssues).toEqual([]);
  });

  it('keeps the project roster visible while preserving each authorization status', () => {
    const result = buildConstructionManagementView({
      generatedAt: '2026-06-09T10:00:00.000Z',
      referenceDate: new Date('2026-06-09T00:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverview',
          fields: {
            施工编号: 'SG260605-1035',
            作业内容: 'EA118-A楼挖潜机房施工',
            计划开始时间: '2026-06-01',
            计划结束时间: '2026-06-30',
          },
        },
      ],
      followupRecords: [],
      crewRecords: [
        {
          record_id: 'recCrewValid',
          fields: {
            施工编号: 'SG260605-1035',
            姓名: '张鹏',
            施工单位: '浙江省邮电工程建设有限公司',
            授权状态: '授权有效',
            作业证书: ['低压电工证', '高压电工证'],
          },
        },
        {
          record_id: 'recCrewExpired',
          fields: {
            施工编号: 'SG260605-1035',
            姓名: '示例人员013',
            授权状态: '已过期',
            作业证书: ['高处作业证'],
          },
        },
        {
          record_id: 'recCrewFuture',
          fields: {
            施工编号: 'SG260605-1035',
            姓名: '示例人员017',
            授权开始日期: '2026-06-10',
            授权结束日期: '2026-06-30',
            作业证书: ['动火作业证'],
          },
        },
      ],
    });

    expect(result.items[0].crewMembers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          recordId: 'recCrewValid',
          name: '张鹏',
          company: '浙江省邮电工程建设有限公司',
          authorizationStatus: '授权有效',
          certificateSummary: '低压电工证、高压电工证',
        }),
        expect.objectContaining({
          recordId: 'recCrewExpired',
          name: '示例人员013',
          authorizationStatus: '已过期',
          certificateSummary: '高处作业证',
        }),
        expect.objectContaining({
          recordId: 'recCrewFuture',
          name: '示例人员017',
          authorizationStatus: '未开始',
          certificateSummary: '动火作业证',
        }),
      ]),
    );
  });

  it('does not surface empty crew certificate issue summaries as 缺少无', () => {
    const result = buildConstructionManagementView({
      generatedAt: '2026-05-29T10:00:00.000Z',
      referenceDate: new Date('2026-05-29T00:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverview',
          fields: {
            施工编号: 'SG260505-1031',
            作业内容: 'EA118-A楼挖潜机房施工',
            计划开始时间: 1780011600000,
            计划结束时间: 1782836400000,
          },
        },
      ],
      followupRecords: [],
      crewRecords: [
        {
          record_id: 'recCrewNoIssue',
          fields: {
            施工编号: 'SG260505-1031',
            姓名: '贾志松',
            授权状态: '授权有效',
            持证统计: '焊接操作证',
            人员持证是否达标: '合规',
            总结: '贾志松缺少无',
          },
        },
      ],
    });

    expect(result.items[0].crewMembers[0]).toMatchObject({
      name: '贾志松',
      issueSummary: null,
    });
  });

  it('maps deposit confirmation and park sync approval fields from overview records', () => {
    const result = buildConstructionManagementView({
      generatedAt: '2026-05-27T10:00:00.000Z',
      referenceDate: new Date('2026-05-27T00:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverviewApproval',
          fields: {
            施工编号: 'SG260505-1031',
            作业内容: 'EA118-A楼挖潜机房施工',
            计划开始时间: 1780011600000,
            计划结束时间: 1782836400000,
            专业: ['其他'],
            楼栋: ['A楼'],
            作业类型: ['一般作业'],
            '施工方（内部/施工单位）': ['外部'],
            示例人员001审批: ['通过'],
            是否已知会EHS工程师: true,
            EHS确认: ['通过'],
            证件审核结果: '通过',
            是否缴纳保证金: '是',
            '缴纳保证金（元）': 20000,
            保证金审批情况: { text: '✔️', type: 'text' },
            同步机房经理: true,
            园区负责人: [{ id: 'ou_park_1', name: '示例人员014' }],
          },
        },
      ],
      followupRecords: [],
    });

    expect(result.items[0].approval).toMatchObject({
      depositConfirmation: '已确认',
      parkSync: '已同步',
    });
  });

  it('maps deposit confirmation and room manager sync fields from follow-up records', () => {
    const result = buildConstructionManagementView({
      generatedAt: '2026-05-27T10:00:00.000Z',
      referenceDate: new Date('2026-05-27T00:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverviewApproval',
          fields: {
            施工编号: 'SG260505-1031',
            作业内容: 'EA118-A楼挖潜机房施工',
            计划开始时间: 1780011600000,
            计划结束时间: 1782836400000,
            专业: ['其他'],
            楼栋: ['A楼'],
            作业类型: ['一般作业'],
            '施工方（内部/施工单位）': ['外部'],
            示例人员001审批: ['通过'],
            是否已知会EHS工程师: true,
          },
        },
      ],
      followupRecords: [
        {
          record_id: 'recFollowupApproval',
          fields: {
            跟进记录: '质保金确认',
            施工编码: 'SG260505-1031',
            施工总览: ['recOverviewApproval'],
            是否缴纳保证金: '是',
            质保金是否确认: true,
            同步机房经理: true,
          },
        },
      ],
    });

    expect(result.items[0].approval).toMatchObject({
      depositPaid: '是',
      parkSync: '已同步',
    });
  });

  it('does not use material upload completion fields as approval material confirmation', () => {
    const result = buildConstructionManagementView({
      generatedAt: '2026-05-27T10:00:00.000Z',
      referenceDate: new Date('2026-05-27T00:00:00+08:00'),
      overviewRecords: [
        {
          record_id: 'recOverviewMaterialDone',
          fields: {
            施工编号: 'SG260605-1038',
            作业内容: '审批材料提交口径测试',
            楼栋: ['A楼'],
            专业: ['其他'],
            作业类型: ['一般作业'],
            计划开始时间: 1780011600000,
            计划结束时间: 1782836400000,
            示例人员001审批: ['通过'],
            是否已知会EHS工程师: true,
            材料是否上传完成: true,
            材料提交确认: true,
            审批材料确认: true,
            证件审核结果: '通过',
          },
        },
      ],
      followupRecords: [],
      crewRecords: [],
    });

    expect(result.items[0].approval.credential).toBeNull();
  });
});
