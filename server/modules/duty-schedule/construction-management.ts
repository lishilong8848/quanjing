import type {
  ConstructionApplicationCreateRequest,
  ConstructionAttachmentGroup,
  ConstructionAttachmentFile,
  ConstructionCompletionChecklistAnswer,
  ConstructionCompletionChecklistTemplateItem,
  ConstructionCrewMemberItem,
  ConstructionDailyPersonnelCheckParticipant,
  ConstructionFollowupCreateRequest,
  ConstructionFollowupItem,
  ConstructionFollowupStaffMember,
  ConstructionImageAuditStatus,
  ConstructionManagementResponse,
  ConstructionOverviewItem,
} from '../../../shared/api.interface';
import {
  CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS,
  CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS,
  CONSTRUCTION_FULL_COMPLETION_CHECKLIST_ITEMS,
} from '../../../shared/api.interface';
import type { AccessRole } from '../../../shared/access-control.interface';
import { isConstructionManualReviewAutoApprovalRole } from '../../../shared/construction-manual-review-policy';
import * as crypto from 'crypto';
import * as XLSX from 'xlsx-js-style';

export {
  CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS,
  CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS,
  CONSTRUCTION_FULL_COMPLETION_CHECKLIST_ITEMS,
};

export interface ConstructionBitableRecordItem {
  id?: string;
  record_id?: string;
  fields?: Record<string, unknown>;
  created_time?: number;
  last_modified_time?: number;
}

export interface ConstructionUploadFile {
  fieldname: string;
  originalname: string;
  mimetype?: string;
  size: number;
  buffer: Buffer;
}

export interface ConstructionCrewRosterEntry {
  name: string;
  gender: string | null;
  certificateType: string | null;
  certificateNo: string | null;
  phone: string | null;
  carLicenseNo: string | null;
  company: string | null;
  hasOperateAuthority: string | null;
  authorizationScope: string | null;
  roleType: string | null;
  authorizationStartDate: string | null;
  authorizationEndDate: string | null;
  authorizationStatus: ConstructionCrewAuthorizationStatus | null;
  sourceFileName: string;
  sourceSheetName: string;
  rowNumber: number;
}

const UPLOAD_FILE_NAME_CJK_PATTERN = /[\u3400-\u9fff\uf900-\ufaff]/g;
const UPLOAD_FILE_NAME_LATIN1_MOJIBAKE_PATTERN = /[\u0080-\u00ff]/g;
const UPLOAD_FILE_NAME_REPLACEMENT_PATTERN = /\ufffd/g;

export function normalizeConstructionUploadFileName(
  fileName?: string | null,
): string {
  const original = String(fileName || '').trim();
  if (!original) {
    return '';
  }

  const repaired = repairLatin1ConstructionUploadFileName(original);
  return shouldUseRepairedConstructionUploadFileName(original, repaired)
    ? repaired
    : original;
}

function repairLatin1ConstructionUploadFileName(fileName: string): string {
  try {
    return Buffer.from(fileName, 'latin1').toString('utf8').trim();
  } catch {
    return fileName;
  }
}

function shouldUseRepairedConstructionUploadFileName(
  original: string,
  repaired: string,
): boolean {
  if (!repaired || repaired === original) {
    return false;
  }

  const originalReplacementCount = countUploadFileNameMatches(
    original,
    UPLOAD_FILE_NAME_REPLACEMENT_PATTERN,
  );
  const repairedReplacementCount = countUploadFileNameMatches(
    repaired,
    UPLOAD_FILE_NAME_REPLACEMENT_PATTERN,
  );
  if (repairedReplacementCount > originalReplacementCount) {
    return false;
  }

  const originalCjkCount = countUploadFileNameMatches(
    original,
    UPLOAD_FILE_NAME_CJK_PATTERN,
  );
  const repairedCjkCount = countUploadFileNameMatches(
    repaired,
    UPLOAD_FILE_NAME_CJK_PATTERN,
  );
  const originalMojibakeScore =
    countUploadFileNameMatches(
      original,
      UPLOAD_FILE_NAME_LATIN1_MOJIBAKE_PATTERN,
    ) +
    originalReplacementCount * 2;
  const repairedMojibakeScore =
    countUploadFileNameMatches(
      repaired,
      UPLOAD_FILE_NAME_LATIN1_MOJIBAKE_PATTERN,
    ) +
    repairedReplacementCount * 2;

  return (
    (repairedCjkCount > originalCjkCount &&
      repairedMojibakeScore <= originalMojibakeScore) ||
    (originalMojibakeScore > 0 && repairedMojibakeScore < originalMojibakeScore)
  );
}

function countUploadFileNameMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length || 0;
}

export interface NormalizedConstructionCompletionChecklistAnswer extends ConstructionCompletionChecklistAnswer {
  remark: string;
}

export interface IsolationPhotoVisionAuditResult {
  result: string;
  summary: string;
  watermark: {
    complete: boolean;
    hasVnetLogo: boolean | null;
    missing: string[];
  };
  onsite: {
    isolationTape: boolean;
    warningSign: boolean;
    constructionNameplate: boolean;
  };
  issues: string[];
  suggestions: string[];
}

export interface ConstructionPermitVisionAuditResult {
  result: string;
  summary: string;
  expiryDate: string | null;
  issues: string[];
  suggestions: string[];
}

export interface ConstructionPermitAuditRequirementRecord {
  fields?: Record<string, unknown> | null;
}

export interface ConstructionPermitVisionAuditContext {
  workContent?: string | null;
  workTypes?: readonly string[] | null;
  planStartTime?: string | null;
  crewMembers?: ReadonlyArray<
    Pick<
      ConstructionCrewMemberItem,
      | 'name'
      | 'certificateNo'
      | 'authorizationStatus'
      | 'certificateSummary'
      | 'complianceStatus'
      | 'issueSummary'
    >
  > | null;
}

export interface ConstructionPermitAttachmentAuditConfig {
  label: string;
  feedbackField: string;
  fallbackFeedbackFields?: string[];
  requiresValidity?: boolean;
}

export interface IsolationPhotoVisionAuditContext {
  constructionCode?: string | null;
  workContent?: string | null;
  building?: string | null;
  contractor?: string | null;
  planStartTime?: string | null;
  planEndTime?: string | null;
}

export interface ConstructionImageAuditRuntimeConfig {
  apiKey?: string | null;
  baseUrl?: string | null;
  model?: string | null;
}

export const CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS: Record<string, string> = {
  applicationFiles: '施工作业申请单',
  crewRosterFiles: '施工人员增删名单',
  dailyPersonnelChecklistFiles: '每日人员核查清单',
  trainingPhotoFiles: '入场培训照片',
  entryTrainingSignInFiles: '入场培训签到表',
  entryTrainingAssessmentFiles: '入场培训考核',
  safetyNoticePhotoFiles: '安全告知书照片',
  temporaryPowerRiskDisclosureFiles: '临电作业风险交底单',
  temporaryPowerTrainingSignInFiles: '临电作业培训签到表',
  temporaryPowerTrainingAssessmentFiles: '临电作业培训考核',
  hotWorkRiskDisclosureFiles: '动火作业风险交底单',
  hotWorkTrainingSignInFiles: '动火作业培训签到表',
  hotWorkTrainingAssessmentFiles: '动火作业培训考核',
  heightWorkRiskDisclosureFiles: '高处作业风险交底单',
  heightWorkTrainingSignInFiles: '高处作业培训签到表',
  heightWorkTrainingAssessmentFiles: '高处作业培训考核',
  confinedSpaceRiskDisclosureFiles: '受限空间作业风险交底单',
  confinedSpaceTrainingSignInFiles: '受限空间作业培训签到表',
  confinedSpaceTrainingAssessmentFiles: '受限空间作业培训考核',
  excavationRiskDisclosureFiles: '开挖动土作业风险交底单',
  excavationTrainingSignInFiles: '开挖动土作业培训签到表',
  excavationTrainingAssessmentFiles: '开挖动土作业培训考核',
  liftingRiskDisclosureFiles: '吊装作业风险交底单',
  liftingTrainingSignInFiles: '吊装作业培训签到表',
  liftingTrainingAssessmentFiles: '吊装作业培训考核',
  fireSystemShutdownRiskDisclosureFiles: '消防系统关闭作业风险交底单',
  fireSystemShutdownTrainingSignInFiles: '消防系统关闭作业培训签到表',
  fireSystemShutdownTrainingAssessmentFiles: '消防系统关闭作业培训考核',
  confinedSpacePermitFiles: '受限空间作业许可证',
  temporaryPowerPermitFiles: '临时用电作业票',
  hotWorkPermitFiles: '动火作业票',
  heightWorkPermitFiles: '高处作业票',
  excavationPermitFiles: '开挖动土作业票',
  liftingPermitFiles: '吊装作业票',
  fireSystemShutdownPermitFiles: '消防系统关闭作业票',
  isolationPhotoFiles: '挂牌与隔离照片',
  processPhotoFiles: '施工过程照片',
  closingPhotoFiles: '施工收尾照片',
  inspectionFormFiles: '施工检查表',
};

export const CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS: Record<
  string,
  string
> = {
  applicationFiles: '施工申请单',
  crewRosterFiles: '施工人员信息表--初始',
};

export const CONSTRUCTION_OVERVIEW_ATTACHMENT_FIELDS: Record<string, string> = {
  constructionIssueFiles: '施工问题',
  completionChecklistArchiveFiles: '施工完工检查清单',
  depositAgreementFiles: '质保金协议',
  depositTransferFiles: '质保金到账/返还',
};

const CONSTRUCTION_COMPLETION_CHECKLIST_FIELD_NAMES = [
  '每日收尾检查清单',
  '施工收尾检查清单',
  '收尾检查清单',
] as const;

export const CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS: Record<
  string,
  ConstructionPermitAttachmentAuditConfig
> = {
  applicationFiles: {
    label: '施工申请单',
    feedbackField: 'AI审核结果-施工申请单',
    requiresValidity: true,
  },
  safetyNoticePhotoFiles: {
    label: '安全告知书',
    feedbackField: 'AI审核结果-安全告知书',
    fallbackFeedbackFields: ['AI审核结果-安全告知书照片'],
    requiresValidity: false,
  },
  hotWorkRiskDisclosureFiles: {
    label: '动火作业风险交底单',
    feedbackField: 'AI审核结果-风险交底单',
    requiresValidity: false,
  },
  confinedSpacePermitFiles: {
    label: '受限空间作业许可证',
    feedbackField: 'AI审核结果-受限空间作业许可证',
  },
  temporaryPowerPermitFiles: {
    label: '临时用电作业票',
    feedbackField: 'AI审核结果-临时用电作业许可证',
    fallbackFeedbackFields: ['AI审核结果-临时用电许可证'],
  },
  hotWorkPermitFiles: {
    label: '动火作业票',
    feedbackField: 'AI审核结果-动火许可证',
  },
  heightWorkPermitFiles: {
    label: '高处作业票',
    feedbackField: 'AI审核结果-高处作业许可证',
  },
};

export const CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS: Record<
  string,
  {
    label: string;
    reviewField: string;
    fingerprintField: string;
    reviewAliases: string[];
    fingerprintAliases: string[];
  }
> = {
  confinedSpacePermitFiles: {
    label: '受限空间作业许可证',
    reviewField: '人工审核-受限空间作业票',
    fingerprintField: '人工审核票据标识-受限空间作业票',
    reviewAliases: [
      '人员审核-受限空间作业许可证',
      '人员审核-受限空间作业票',
      '人工审核-受限空间作业许可证',
      '人员审核结果-受限空间作业许可证',
      '人工审核结果-受限空间作业许可证',
      '人员审核-受限空间许可证',
      '人工审核-受限空间许可证',
    ],
    fingerprintAliases: [
      '人员审核票据标识-受限空间作业许可证',
      '人员审核标识-受限空间作业许可证',
      '人工审核票据标识-受限空间作业许可证',
      '人工审核标识-受限空间作业许可证',
      '人员审核票据标识-受限空间许可证',
    ],
  },
  temporaryPowerPermitFiles: {
    label: '临时用电作业票',
    reviewField: '人工审核-临时用电许可证',
    fingerprintField: '人工审核票据标识-临时用电许可证',
    reviewAliases: [
      '人员审核-临时用电作业许可证',
      '人员审核-临时用电许可证',
      '人工审核-临时用电作业许可证',
      '人员审核结果-临时用电作业许可证',
      '人工审核结果-临时用电作业许可证',
    ],
    fingerprintAliases: [
      '人员审核票据标识-临时用电作业许可证',
      '人员审核票据标识-临时用电许可证',
      '人员审核标识-临时用电作业许可证',
      '人工审核票据标识-临时用电作业许可证',
      '人工审核标识-临时用电作业许可证',
    ],
  },
  hotWorkPermitFiles: {
    label: '动火作业票',
    reviewField: '人工审核-动火许可票',
    fingerprintField: '人工审核票据标识-动火许可票',
    reviewAliases: [
      '人员审核-动火许可证',
      '人员审核-动火作业许可证',
      '人工审核-动火许可证',
      '人工审核-动火作业票',
      '人员审核结果-动火许可证',
      '人工审核结果-动火许可证',
      '人工审核-动火作业许可证',
    ],
    fingerprintAliases: [
      '人员审核票据标识-动火许可证',
      '人员审核票据标识-动火作业许可证',
      '人员审核标识-动火许可证',
      '人工审核票据标识-动火许可证',
      '人工审核标识-动火许可证',
      '人工审核票据标识-动火作业票',
    ],
  },
  heightWorkPermitFiles: {
    label: '高处作业票',
    reviewField: '人工审核-高处作业票',
    fingerprintField: '人工审核票据标识-高处作业票',
    reviewAliases: [
      '人员审核-高处作业许可证',
      '人员审核-高处作业票',
      '人工审核-高处作业许可证',
      '人员审核结果-高处作业许可证',
      '人工审核结果-高处作业许可证',
      '人员审核-高处许可证',
      '人工审核-高处许可证',
    ],
    fingerprintAliases: [
      '人员审核票据标识-高处作业许可证',
      '人员审核票据标识-高处作业票',
      '人员审核标识-高处作业许可证',
      '人工审核票据标识-高处作业许可证',
      '人工审核标识-高处作业许可证',
      '人员审核票据标识-高处许可证',
    ],
  },
};

const DAILY_PERMIT_AUDIT_DATE_LABEL = '核验日期';
const DAILY_PERMIT_AUDIT_VERSION = '6';
const DAILY_PERMIT_AUDIT_VERSION_LABEL = '核验版本';

const CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_FIELD_NAMES = {
  workTypes: ['作业类型', 'fldeyY8X0i'],
  uploadFiles: ['需上传文件', 'fldXXE5U9j'],
  credentialTypes: ['所需作业证', 'fld27pXUw8'],
  auditBasis: ['AI判断依据', 'fldl10aUom'],
  formAuditRequirements: ['表单审核要求', 'fldnDObsjF'],
  preparationRequirements: ['施工准备要求', 'fldREg8YTU'],
} as const;

const SOLIDIFIED_CONSTRUCTION_PERMIT_AUDIT_REQUIREMENTS: readonly ConstructionPermitAuditRequirementRecord[] =
  [
    {
      fields: {
        编号: 'SGGL-001',
        作业类型: ['一般作业'],
        需上传文件: ['安全告知书照片', '培训照片'],
        表单审核要求: [
          { name: '特殊作业风险交底单审核要点.docx' },
          { name: '作业申请单审核要点.docx' },
          { name: '特殊作业培训表审核要点.docx' },
        ],
        施工准备要求:
          '检查作业人员证件、保险、工器具和劳保用品；检查《南通集群作业申请单》审批完成；作业前完成安全培训、风险交底，签署工作许可申请表和现场安全行为告知书。',
      },
    },
    {
      fields: {
        编号: 'SGGL-002',
        作业类型: ['临时用电作业'],
        需上传文件: ['安全告知书照片', '培训照片'],
        所需作业证: ['低压电工证'],
        表单审核要求: [
          { name: '临时用电作业审核要点.docx' },
          { name: '特殊作业培训表审核要点.docx' },
          { name: '作业申请单审核要点.docx' },
          { name: '特殊作业风险交底单审核要点.docx' },
        ],
        施工准备要求:
          '检查低压电工证和保险；检查工器具、劳保用品；检查《南通集群作业申请单》《临时用电作业许可证》审批完成；完成安全培训、风险交底和现场安全行为告知。',
      },
    },
    {
      fields: {
        编号: 'SGGL-003',
        作业类型: ['动火作业'],
        需上传文件: ['安全告知书照片', '受限空间作业许可证', '动火许可证'],
        所需作业证: ['焊接与热切割证'],
        表单审核要求: [
          { name: '动火作业单审核要点.docx' },
          { name: '特殊作业风险交底单审核要点.docx' },
          { name: '作业申请单审核要点.docx' },
          { name: '特殊作业培训表审核要点.docx' },
        ],
        施工准备要求:
          '检查焊接与热切割证和保险；检查工器具、劳保用品；检查《南通集群作业申请单》《动火作业许可证》审批完成；完成安全培训、风险交底和现场安全行为告知。',
      },
    },
    {
      fields: {
        编号: 'SGGL-004',
        作业类型: ['受限空间作业'],
        需上传文件: ['安全告知书照片', '培训照片', '受限空间作业许可证'],
        表单审核要求: [
          { name: '有限空间作业审核要点.docx' },
          { name: '特殊作业培训表审核要点.docx' },
          { name: '作业申请单审核要点.docx' },
          { name: '特殊作业风险交底单审核要点.docx' },
        ],
        施工准备要求:
          '检查人员证件和保险；作业前通风换气至少1小时，作业前30分钟内完成气体检测且合格；检查《南通集群作业申请单》《有限空间作业许可证》审批完成；完成安全培训、风险交底和现场安全行为告知。',
      },
    },
    {
      fields: {
        编号: 'SGGL-005',
        作业类型: ['高处作业'],
        需上传文件: ['安全告知书照片', '培训照片', '高处作业许可证'],
        所需作业证: ['高处作业证'],
        表单审核要求: [
          { name: '高处作业单审核要点.docx' },
          { name: '作业申请单审核要点.docx' },
          { name: '特殊作业培训表审核要点.docx' },
          { name: '特殊作业风险交底单审核要点.docx' },
        ],
        施工准备要求:
          '检查高处作业证和保险；检查工器具、劳保用品；检查《南通集群作业申请单》《高处作业许可证》审批完成；完成安全培训、风险交底和现场安全行为告知。',
      },
    },
    {
      fields: {
        编号: 'SGGL-009',
        作业类型: ['开挖动土作业'],
        需上传文件: ['安全告知书照片', '培训照片', '受限空间作业许可证'],
        表单审核要求: [
          { name: '开挖动土作业审核要点.docx' },
          { name: '特殊作业风险交底单审核要点.docx' },
          { name: '作业申请单审核要点.docx' },
          { name: '特殊作业培训表审核要点.docx' },
        ],
        施工准备要求:
          '检查人员证件和保险；作业前核查开挖区域地下设施并设置警示标识；检查《南通集群作业申请单》《开挖动土作业许可》审批完成；完成安全培训、风险交底和现场安全行为告知。',
      },
    },
    {
      fields: {
        编号: 'SGGL-010',
        作业类型: ['吊装作业'],
        需上传文件: ['安全告知书照片', '培训照片', '受限空间作业许可证'],
        表单审核要求: [
          { name: '吊装作业单审核要点.docx' },
          { name: '特殊作业培训表审核要点.docx' },
          { name: '作业申请单审核要点.docx' },
          { name: '特殊作业风险交底单审核要点.docx' },
        ],
        施工准备要求:
          '检查人员证件和保险；作业前全面检查吊车、吊钩、吊索等起重器具；勘察作业现场地基承载力、作业半径和回转空间；检查作业申请和吊装作业许可审批完成。',
      },
    },
    {
      fields: {
        编号: 'SGGL-011',
        作业类型: ['消防系统关闭作业'],
        表单审核要求: [
          { name: '消防系统关闭作业审核要点.docx' },
          { name: '作业申请单审核要点.docx' },
          { name: '特殊作业培训表审核要点.docx' },
          { name: '特殊作业风险交底单审核要点.docx' },
        ],
        施工准备要求:
          '检查人员证件和保险；检查《南通集群作业申请单》《消防系统关闭作业许可证》审批完成；完成安全培训、风险交底和现场安全行为告知。',
      },
    },
  ];

export const CONSTRUCTION_DAILY_PERSONNEL_CHECK_AUDIT_FIELD =
  'AI审核结果-每日人员核查';
export const CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD =
  'AI审核结果-培训考核';

export interface DailyPersonnelCertificateAuditResult {
  passed: boolean;
  feedback: string;
  failureReason: string | null;
  blockingMessage: string | null;
}

const CONSTRUCTION_FORM_AUDIT_REQUIREMENT_DETAILS = [
  {
    keywords: ['临时用电作业审核要点', '临时用电'],
    summary:
      '核对作业证编号、申请单位/人员/联系方式、作业内容、电源接入点+用电设备、电压、功率、风险等级、作业时间起止年月日时分且最长不得超过15天、作业人员低/高压电工证有效且人证匹配、监护人、安全措施/工器具、各级审批签字时间早于作业开始、验票和完工验收。',
  },
  {
    keywords: ['动火作业单审核要点', '动火作业审核要点', '动火'],
    summary:
      '核对作业证编号、申请单位/人员/联系方式、作业内容、动火地点、风险等级、动火方式、动火时间起止完整且最长不得超过3天、焊接与热切割证有效且人证匹配、监护人、动火分析、安全措施/工器具、各级审批签字时间早于作业开始、验票和完工验收。',
  },
  {
    keywords: ['高处作业单审核要点', '高处作业审核要点', '高处'],
    summary:
      '核对作业证编号、申请单位/人员/联系方式、作业内容、高处作业地点+作业高度、风险等级、作业时间起止完整且最长不得超过7天、高处/登高作业证有效且人证匹配、监护人、安全措施/工器具、各级审批签字时间早于作业开始、验票和完工验收。',
  },
  {
    keywords: [
      '有限空间作业审核要点',
      '受限空间作业审核要点',
      '有限空间',
      '受限空间',
    ],
    summary:
      '核对作业证编号、申请单位/人员/联系方式、作业内容、有限/受限空间作业地点、风险等级、作业时间起止完整且最长不得超过12H、作业人员信息、监护人、作业前30分钟气体监测分析、安全措施/工器具、各级审批签字时间早于作业开始、验票和完工验收。',
  },
  {
    keywords: ['开挖动土作业审核要点', '开挖动土'],
    summary:
      '核对作业证编号、申请单位/人员/联系方式、作业内容、开挖动土地点、风险等级、作业时间起止完整且高风险1天/中低风险3天、作业人员、监护人、安全措施/工器具、各级审批签字时间早于作业开始、验票和完工验收。',
  },
  {
    keywords: ['吊装作业单审核要点', '吊装作业审核要点', '吊装'],
    summary:
      '核对作业证编号、申请单位/人员/联系方式、作业内容、吊装地点和吊装工具、吊装重量、风险等级、作业时间起止完整且高风险1天/中低风险3天、作业人员、监护人、安全措施/工器具、各级审批签字时间早于作业开始、验票和完工验收。',
  },
  {
    keywords: ['消防系统关闭作业审核要点', '消防系统关闭'],
    summary:
      '核对作业证编号、申请单位/人员/联系方式、作业内容、关闭消防系统、作业地点、受影响区域、关闭原因、作业时间起止完整、关闭操作人证件、监护人、安全措施、各级审批签字时间早于作业开始、验票和完工验收。',
  },
  {
    keywords: ['作业申请单审核要点', '作业申请单'],
    summary:
      '核对作业项目、作业日期、有效期合规、作业单位、负责人/现场示例人员019电话、作业人员身份信息和人数、作业地点/内容、材料堆放点、特殊作业勾选、能源切断/停用设备、现场负责人/EHS/FM或IM驻场示例人员001签字。',
  },
  {
    keywords: ['特殊作业培训表审核要点', '培训表'],
    summary:
      '核对作业单位一致、作业人数一致、培训人资质、培训时间为作业前当日、作业负责人手写培训声明、受培训人全员本人签字无漏签代签、签字日期与培训作业日期一致。',
  },
  {
    keywords: ['特殊作业风险交底单审核要点', '风险交底'],
    summary:
      '核对作业单位/人数一致、EHS风险交底人签字、交底时间早于作业、许可范围/环境与作业票一致、风险识别、防范措施、应急措施、其他注意事项、负责人承诺和全员本人签字日期一致。',
  },
] as const;

const CONSTRUCTION_APPLICATION_REQUIRED_ATTACHMENT_FIELDS = [
  { key: 'crewRosterFiles', label: '施工人员名单' },
] as const;

const INITIAL_APPLICATION_CONTENT_ATTACHMENT_KEYS = new Set([
  'applicationFiles',
  'crewRosterFiles',
  'trainingPhotoFiles',
  'entryTrainingSignInFiles',
  'entryTrainingAssessmentFiles',
  'safetyNoticePhotoFiles',
  'temporaryPowerRiskDisclosureFiles',
  'temporaryPowerTrainingSignInFiles',
  'temporaryPowerTrainingAssessmentFiles',
  'hotWorkRiskDisclosureFiles',
  'hotWorkTrainingSignInFiles',
  'hotWorkTrainingAssessmentFiles',
  'heightWorkRiskDisclosureFiles',
  'heightWorkTrainingSignInFiles',
  'heightWorkTrainingAssessmentFiles',
  'confinedSpaceRiskDisclosureFiles',
  'confinedSpaceTrainingSignInFiles',
  'confinedSpaceTrainingAssessmentFiles',
  'excavationRiskDisclosureFiles',
  'excavationTrainingSignInFiles',
  'excavationTrainingAssessmentFiles',
  'liftingRiskDisclosureFiles',
  'liftingTrainingSignInFiles',
  'liftingTrainingAssessmentFiles',
  'fireSystemShutdownRiskDisclosureFiles',
  'fireSystemShutdownTrainingSignInFiles',
  'fireSystemShutdownTrainingAssessmentFiles',
  'confinedSpacePermitFiles',
  'temporaryPowerPermitFiles',
  'hotWorkPermitFiles',
  'heightWorkPermitFiles',
  'excavationPermitFiles',
  'liftingPermitFiles',
  'fireSystemShutdownPermitFiles',
  'depositAgreementFiles',
  'depositTransferFiles',
]);
const APPROVAL_MATERIAL_UPLOAD_ATTACHMENT_KEYS = new Set(
  Array.from(INITIAL_APPLICATION_CONTENT_ATTACHMENT_KEYS).filter(
    (key) => key !== 'depositAgreementFiles' && key !== 'depositTransferFiles',
  ),
);

const DAILY_FOLLOWUP_STAGES = ['prepare', 'process', 'close'] as const;
type DailyFollowupStage = (typeof DAILY_FOLLOWUP_STAGES)[number];
const DAILY_CHECKLIST_FOCUS_VALUES = [
  'workType',
  'personnel',
  'permit',
  'isolation',
  'processPhoto',
  'closeChecklist',
  'closePhoto',
] as const;
type DailyChecklistFocus = (typeof DAILY_CHECKLIST_FOCUS_VALUES)[number];

const DAILY_FOLLOWUP_REQUIRED_ATTACHMENT_FIELDS: Record<
  DailyFollowupStage,
  ReadonlyArray<{ key: string; label: string }>
> = {
  prepare: [
    { key: 'dailyPersonnelChecklistFiles', label: '每日人员核查清单' },
    { key: 'isolationPhotoFiles', label: '挂牌与隔离照片' },
  ],
  process: [{ key: 'processPhotoFiles', label: '施工过程照片' }],
  close: [{ key: 'closingPhotoFiles', label: '每日收尾照片' }],
};

const BUILDINGS = ['H楼', 'A楼', 'B楼', 'C楼', 'D楼', 'E楼', '110站'];
const SPECIALTIES = ['电气', '暖通', '弱电', '消防', '其他'];
const WORK_TYPES = [
  '一般作业',
  '临时用电作业',
  '动火作业',
  '受限空间作业',
  '高处作业',
  '开挖动土作业',
  '吊装作业',
  '消防系统关闭作业',
];
const CONTRACTOR_TYPES = ['内部', '外部'];
const RELATED_WORK_TYPES = ['变更', '检修', '维护', '其他'];
const YES_NO = ['是', '否'];
const FOLLOWUP_MODES = ['daily', 'supplemental'];
const CONSTRUCTION_CODE_FIELDS = ['施工编码', '施工编号'];
export const CONSTRUCTION_CREW_LEDGER_CONSTRUCTION_CODE_FIELD_NAMES =
  CONSTRUCTION_CODE_FIELDS;

export function buildConstructionCrewLedgerViewName(
  constructionCode?: string | null,
): string | null {
  const value = String(constructionCode || '').trim();
  return value || null;
}

export function buildConstructionCrewLedgerViewFilterPayload(
  fieldId: string,
  constructionCode: string,
): {
  property: {
    filter_info: {
      conjunction: 'and';
      conditions: Array<{
        field_id: string;
        operator: 'is';
        value: string[];
      }>;
    };
  };
} {
  return {
    property: {
      filter_info: {
        conjunction: 'and',
        conditions: [
          {
            field_id: fieldId,
            operator: 'is',
            value: [constructionCode],
          },
        ],
      },
    },
  };
}
export const CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_START_FIELD_NAMES = [
  '授权开始日期',
  '授权起始日期',
  '授权开始时间',
  '授权起始时间',
  '授权有效期开始',
] as const;

export const CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_END_FIELD_NAMES = [
  '授权结束日期',
  '授权截止日期',
  '授权结束时间',
  '授权截止时间',
  '授权有效期结束',
] as const;

export const CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_STATUS_FIELD_NAMES = [
  '授权状态',
] as const;

const CONSTRUCTION_CREW_LEDGER_CERTIFICATE_SUMMARY_FIELD_NAMES = [
  '持证统计',
  '持证情况',
  '作业证书',
  '持有作业证书',
  '特种作业证书',
  '证书类别',
  '证书类型',
  '证件类别',
  '作业类别',
  '准操项目',
  '操作项目',
  '作业项目',
] as const;

const CONSTRUCTION_CREW_LEDGER_COMPANY_FIELD_NAMES = [
  '施工单位',
  '公司',
  '单位',
  '所属公司',
  '所属单位',
  '施工公司',
  '单位名称',
  '公司名称',
  '乙方公司名称',
  '外包单位',
  '承包单位',
] as const;

export type ConstructionCrewAuthorizationStatus =
  | '已过期'
  | '授权有效'
  | '未开始';

export function getConstructionCrewAuthorizationStatus(
  startDate: string | null | undefined,
  endDate: string | null | undefined,
  referenceDate: Date = new Date(),
): ConstructionCrewAuthorizationStatus | null {
  const referenceDateKey = formatShanghaiDateKey(referenceDate);
  const startDateKey = startDate
    ? formatShanghaiDateKey(new Date(startDate))
    : null;
  const endDateKey = endDate ? formatShanghaiDateKey(new Date(endDate)) : null;

  if (startDateKey && startDateKey > referenceDateKey) {
    return '未开始';
  }
  if (endDateKey && endDateKey < referenceDateKey) {
    return '已过期';
  }
  if (startDateKey || endDateKey) {
    return '授权有效';
  }
  return null;
}

type CrewRosterHeaderKey =
  | 'name'
  | 'gender'
  | 'certificateType'
  | 'certificateNo'
  | 'phone'
  | 'carLicenseNo'
  | 'company'
  | 'hasOperateAuthority'
  | 'authorizationScope'
  | 'roleType'
  | 'authorizationPeriod'
  | 'authorizationStartDate'
  | 'authorizationEndDate';

type CrewRosterHeaderMap = Partial<Record<CrewRosterHeaderKey, number>>;

const CREW_ROSTER_HEADER_MATCHERS: Array<{
  key: CrewRosterHeaderKey;
  test: (header: string) => boolean;
}> = [
  { key: 'name', test: (header) => /姓名|^name\*?$/i.test(header) },
  { key: 'gender', test: (header) => /性别|gender/i.test(header) },
  {
    key: 'certificateType',
    test: (header) => /证件类型|certificatetype/i.test(header),
  },
  {
    key: 'certificateNo',
    test: (header) => /证件号码|身份证|certificateno/i.test(header),
  },
  { key: 'phone', test: (header) => /手机|cellphone|phone/i.test(header) },
  {
    key: 'carLicenseNo',
    test: (header) => /车牌|carlicenseno/i.test(header),
  },
  { key: 'company', test: (header) => /公司|单位|company/i.test(header) },
  {
    key: 'hasOperateAuthority',
    test: (header) => /操作权限|hasoperateauthority/i.test(header),
  },
  {
    key: 'authorizationScope',
    test: (header) => /授权范围|authorizationscope/i.test(header),
  },
  {
    key: 'roleType',
    test: (header) => /人员角色|roletype/i.test(header),
  },
  {
    key: 'authorizationStartDate',
    test: (header) => /授权(开始|起始)|有效期开始/i.test(header),
  },
  {
    key: 'authorizationEndDate',
    test: (header) => /授权(结束|截止)|有效期结束/i.test(header),
  },
  {
    key: 'authorizationPeriod',
    test: (header) => /授权有效期|有效期|authorization/i.test(header),
  },
];

export function parseConstructionCrewRosterFiles(
  files: ConstructionUploadFile[],
  referenceDate: Date = new Date(),
): ConstructionCrewRosterEntry[] {
  return files
    .filter((file) => file.fieldname === 'crewRosterFiles')
    .flatMap((file) =>
      parseConstructionCrewRosterWorkbook(file, referenceDate),
    );
}

function parseConstructionCrewRosterWorkbook(
  file: ConstructionUploadFile,
  referenceDate: Date,
): ConstructionCrewRosterEntry[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(file.buffer, {
      type: 'buffer',
      cellDates: true,
      raw: false,
    });
  } catch (error) {
    throw new Error(
      `施工人员名单解析失败：${file.originalname} 不是有效的 Excel 文件`,
    );
  }

  const entries = workbook.SheetNames.flatMap((sheetName) => {
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) {
      return [];
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(worksheet, {
      header: 1,
      raw: false,
      defval: '',
    });
    return parseConstructionCrewRosterRows(
      rows,
      file.originalname,
      sheetName,
      referenceDate,
    );
  });

  if (entries.length === 0) {
    throw new Error(`施工人员名单未读取到有效人员：${file.originalname}`);
  }
  return entries;
}

function parseConstructionCrewRosterRows(
  rows: unknown[][],
  sourceFileName: string,
  sourceSheetName: string,
  referenceDate: Date,
): ConstructionCrewRosterEntry[] {
  const headerRowIndex = rows.findIndex((row) =>
    row.some((cell) => /姓名|^name\*?$/i.test(normalizeCrewRosterHeader(cell))),
  );
  if (headerRowIndex < 0) {
    return [];
  }

  const headerMap = buildCrewRosterHeaderMap(rows[headerRowIndex]);
  if (headerMap.name === undefined) {
    return [];
  }

  return rows
    .slice(headerRowIndex + 1)
    .map((row, index) =>
      buildConstructionCrewRosterEntry({
        row,
        headerMap,
        sourceFileName,
        sourceSheetName,
        rowNumber: headerRowIndex + index + 2,
        referenceDate,
      }),
    )
    .filter((entry): entry is ConstructionCrewRosterEntry => Boolean(entry));
}

function buildCrewRosterHeaderMap(headerRow: unknown[]): CrewRosterHeaderMap {
  const headerMap: CrewRosterHeaderMap = {};
  headerRow.forEach((cell, index) => {
    const header = normalizeCrewRosterHeader(cell);
    if (!header) {
      return;
    }
    for (const matcher of CREW_ROSTER_HEADER_MATCHERS) {
      if (headerMap[matcher.key] === undefined && matcher.test(header)) {
        headerMap[matcher.key] = index;
        break;
      }
    }
  });
  return headerMap;
}

function buildConstructionCrewRosterEntry(input: {
  row: unknown[];
  headerMap: CrewRosterHeaderMap;
  sourceFileName: string;
  sourceSheetName: string;
  rowNumber: number;
  referenceDate: Date;
}): ConstructionCrewRosterEntry | null {
  const getValue = (key: CrewRosterHeaderKey): string | null =>
    input.headerMap[key] === undefined
      ? null
      : normalizeCrewRosterCellText(input.row[input.headerMap[key]]);
  const name = getValue('name');
  if (!name || /姓名|name/i.test(name)) {
    return null;
  }

  const range = parseCrewRosterAuthorizationRange({
    period: getValue('authorizationPeriod'),
    startDate: getValue('authorizationStartDate'),
    endDate: getValue('authorizationEndDate'),
  });

  return {
    name,
    gender: getValue('gender'),
    certificateType: getValue('certificateType'),
    certificateNo: normalizeCrewRosterIdentifier(getValue('certificateNo')),
    phone: normalizeCrewRosterPhone(getValue('phone')),
    carLicenseNo: getValue('carLicenseNo'),
    company: getValue('company'),
    hasOperateAuthority: getValue('hasOperateAuthority'),
    authorizationScope: getValue('authorizationScope'),
    roleType: getValue('roleType'),
    authorizationStartDate: range.startDate,
    authorizationEndDate: range.endDate,
    authorizationStatus: getConstructionCrewAuthorizationStatus(
      range.startDate,
      range.endDate,
      input.referenceDate,
    ),
    sourceFileName: input.sourceFileName,
    sourceSheetName: input.sourceSheetName,
    rowNumber: input.rowNumber,
  };
}

function parseCrewRosterAuthorizationRange(input: {
  period: string | null;
  startDate: string | null;
  endDate: string | null;
}): {
  startDate: string | null;
  endDate: string | null;
} {
  const explicitStartDate = normalizeCrewRosterDateKey(input.startDate);
  const explicitEndDate = normalizeCrewRosterDateKey(input.endDate);
  if (explicitStartDate || explicitEndDate) {
    return {
      startDate: explicitStartDate,
      endDate: explicitEndDate,
    };
  }

  const period = input.period || '';
  const dateMatches = period.match(/\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?/g) || [];
  return {
    startDate: normalizeCrewRosterDateKey(dateMatches[0]),
    endDate: normalizeCrewRosterDateKey(dateMatches[1]),
  };
}

function normalizeCrewRosterHeader(value: unknown): string {
  return normalizeCrewRosterCellText(value)
    .replace(/\*/g, '')
    .replace(/\s+/g, '')
    .trim();
}

function normalizeCrewRosterCellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (value instanceof Date) {
    return formatShanghaiDateKey(value);
  }
  return String(value).trim();
}

function normalizeCrewRosterIdentifier(value: string | null): string | null {
  const text = String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .toUpperCase();
  return text || null;
}

function normalizeCrewRosterPhone(value: string | null): string | null {
  const text = String(value || '')
    .trim()
    .replace(/[^\d+]/g, '');
  return text || null;
}

function normalizeCrewRosterDateKey(value?: string | null): string | null {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }
  const normalized = text
    .replace(/年|\/|\./g, '-')
    .replace(/月/g, '-')
    .replace(/日/g, '')
    .replace(/\s+/g, '');
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized);
  if (!match) {
    return null;
  }
  const year = match[1];
  const month = match[2].padStart(2, '0');
  const day = match[3].padStart(2, '0');
  return `${year}-${month}-${day}`;
}
const EHS_NOTIFIED_FIELDS = [
  '是否已知会EHS工程师',
  '是否已知会 EHS 工程师',
  '已知会EHS工程师',
];
const EHS_APPROVAL_FIELDS = ['EHS确认', 'EHS审批'];
const DEPOSIT_CONFIRMATION_FIELDS = [
  '质保金确认',
  '质保金审批',
  '质保金确认结果',
  '质保金审批结果',
  '质保金审批状态',
  '质保金确认完成',
  '质保金已确认',
  '保证金确认',
  '保证金审批',
  '保证金确认结果',
  '保证金审批结果',
  '保证金审批状态',
  '保证金审批情况',
  '保证金已确认',
  '施工保证金确认',
  '施工保证金审批',
  '施工保证金确认结果',
  '施工保证金审批结果',
];
const FOLLOWUP_DEPOSIT_CONFIRMATION_FIELDS = [
  '是否缴纳保证金',
  '质保金是否确认',
  '保证金是否确认',
  '施工保证金是否确认',
  '质保金确认',
  '保证金确认',
];
const PARK_SYNC_FIELDS = [
  '同步机房经理',
  '同步机房经理状态',
  '同步机房经理结果',
  '同步园区经理',
  '同步园区经理状态',
  '同步园区经理结果',
  '同步园区负责人',
  '同步园区负责人状态',
  '同步园区负责人结果',
  '园区经理同步',
  '园区负责人同步',
  '园区经理确认',
  '园区负责人确认',
  '是否同步园区经理',
  '是否同步园区负责人',
  '是否同步机房经理',
  '是否同步机房机房经理',
];

interface ConstructionManagementViewInput {
  generatedAt: string;
  overviewRecords: ConstructionBitableRecordItem[];
  followupRecords: ConstructionBitableRecordItem[];
  crewRecords?: ConstructionBitableRecordItem[];
  overviewSourceUrl?: string;
  followupSourceUrl?: string;
  referenceDate?: Date;
}

interface NormalizedConstructionApplication {
  workContent: string;
  building: string;
  specialty: string;
  workTypes: string[];
  contractorType: string;
  relatedWorkType: string | null;
  planStartTime: string;
  planEndTime: string;
  authorizationStartDate: string | null;
  authorizationEndDate: string | null;
  depositPaid: string | null;
  depositAmount: number | null;
  depositDeducted: number | null;
  constructionApplicantId: string;
  changeOrderLinkRecordId: string | null;
}

interface ConstructionApplicationFieldRequest extends ConstructionApplicationCreateRequest {
  changeOrderLinkRecordId?: string | null;
}

interface NormalizedConstructionFollowup {
  constructionRecordId: string;
  followupRecordId: string | null;
  followupMode: 'daily' | 'supplemental';
  dailyFollowupStage: DailyFollowupStage | null;
  dailyChecklistFocus: DailyChecklistFocus | null;
  followupDate: string | null;
  permitOnlyUpload: boolean;
  permitValidFromByFileKey: Record<string, string>;
  permitValidUntilByFileKey: Record<string, string>;
  partialDailySubmit: boolean;
  workTypes: string[];
  followupStaffIds: string[];
  dailyPersonnelCheck: string | null;
  dailyPersonnelCheckParticipants: ConstructionDailyPersonnelCheckParticipant[];
  isolationCompliant: null;
  isolationFeedback: string | null;
  processFeedback: string | null;
  closingFeedback: string | null;
  completed: string | null;
  depositPaid: string | null;
  depositAmount: number | null;
  depositDeducted: number | null;
  completionChecklist: NormalizedConstructionCompletionChecklistAnswer[] | null;
  checklistContext: {
    workContent: string | null;
    constructionCode: string | null;
    building: string | null;
    contractor: string | null;
    planStartTime: string | null;
    planEndTime: string | null;
  };
}

export function buildConstructionApplicationFields(
  request: ConstructionApplicationFieldRequest,
): {
  fields: Record<string, unknown>;
  normalized: NormalizedConstructionApplication;
} {
  const workContent = normalizeRequiredText(
    request?.workContent,
    '作业内容不能为空',
  );
  const building = normalizeAllowedValue(request?.building, BUILDINGS, '楼栋');
  const specialty = normalizeAllowedValue(
    request?.specialty,
    SPECIALTIES,
    '专业',
  );
  const hasWorkTypeInput = Array.isArray(request?.workTypes)
    ? request.workTypes.length > 0
    : typeof request?.workTypes === 'string' &&
      String(request.workTypes).trim().length > 0;
  const workTypes = hasWorkTypeInput
    ? normalizeOptionalAllowedValues(request?.workTypes, WORK_TYPES, '作业类型')
    : [];
  const contractorType = normalizeAllowedValue(
    request?.contractorType,
    CONTRACTOR_TYPES,
    '施工方',
  );
  const relatedWorkType = normalizeOptionalAllowedValue(
    request?.relatedWorkType,
    RELATED_WORK_TYPES,
    '关联作业类型',
  );
  const depositPaid = normalizeOptionalAllowedValue(
    request?.depositPaid,
    YES_NO,
    '是否缴纳保证金',
  );
  const depositAmount = normalizeOptionalNumber(
    request?.depositAmount,
    '缴纳保证金（元）',
  );
  const depositDeducted = normalizeOptionalNumber(
    request?.depositDeducted,
    '被扣款保证金',
  );
  const planStartTime = normalizeRequiredText(
    request?.planStartTime,
    '计划开始时间不能为空',
  );
  const planEndTime = normalizeRequiredText(
    request?.planEndTime,
    '计划结束日期不能为空',
  );
  const authorizationStartDate = normalizeOptionalApplicationAuthorizationDate(
    request?.authorizationStartDate,
    '授权开始日期',
  );
  const authorizationEndDate = normalizeOptionalApplicationAuthorizationDate(
    request?.authorizationEndDate,
    '施工结束日期',
  );
  if (
    authorizationStartDate &&
    authorizationEndDate &&
    authorizationStartDate > authorizationEndDate
  ) {
    throw new Error('授权开始日期不能晚于施工结束日期');
  }
  const constructionApplicantId = normalizeRequiredText(
    request?.constructionApplicantId,
    '施工申请人不能为空',
  );
  const changeOrderLinkRecordId =
    relatedWorkType === '变更'
      ? normalizeRequiredText(
          request?.changeOrderLinkRecordId,
          '关联作业类型为变更时，请选择对应变更单',
        )
      : null;

  const fields: Record<string, unknown> = {
    作业内容: workContent,
    楼栋: building,
    专业: specialty,
    '施工方（内部/施工单位）': contractorType,
    计划开始时间: parseShanghaiDateTimeMs(planStartTime, '计划开始时间'),
    计划结束时间: parseShanghaiDateTimeMs(planEndTime, '计划结束时间'),
    施工申请人: [{ id: constructionApplicantId }],
    流程: '施工申请',
    新建施工单提交: true,
  };

  if (workTypes.length > 0) fields.作业类型 = workTypes;
  if (relatedWorkType) fields.关联作业类型 = relatedWorkType;
  if (relatedWorkType === '变更' && changeOrderLinkRecordId) {
    fields.变更关联 = [changeOrderLinkRecordId];
  }
  if (depositPaid) fields.是否缴纳保证金 = depositPaid;
  if (depositAmount !== null) fields['缴纳保证金（元）'] = depositAmount;
  if (depositDeducted !== null) fields.被扣款保证金 = depositDeducted;

  return {
    fields,
    normalized: {
      workContent,
      building,
      specialty,
      workTypes,
      contractorType,
      relatedWorkType,
      planStartTime,
      planEndTime,
      authorizationStartDate,
      authorizationEndDate,
      depositPaid,
      depositAmount,
      depositDeducted,
      constructionApplicantId,
      changeOrderLinkRecordId,
    },
  };
}

export function buildConstructionFollowupFields(
  request: ConstructionFollowupCreateRequest,
): {
  fields: Record<string, unknown>;
  normalized: NormalizedConstructionFollowup;
} {
  const constructionRecordId = normalizeRequiredText(
    request?.constructionRecordId,
    '缺少施工总览记录 ID',
  );
  const followupRecordId = normalizeOptionalText(request?.followupRecordId);
  const followupMode = (normalizeOptionalAllowedValue(
    request?.followupMode,
    FOLLOWUP_MODES,
    '跟进类型',
  ) || 'daily') as 'daily' | 'supplemental';
  const dailyFollowupStage =
    followupMode === 'daily'
      ? ((normalizeOptionalAllowedValue(
          request?.dailyFollowupStage,
          DAILY_FOLLOWUP_STAGES,
          '每日跟进阶段',
        ) || 'prepare') as DailyFollowupStage)
      : null;
  const dailyChecklistFocus =
    followupMode === 'daily'
      ? (normalizeOptionalAllowedValue(
          request?.dailyChecklistFocus,
          DAILY_CHECKLIST_FOCUS_VALUES,
          '每日跟进提交范围',
        ) as DailyChecklistFocus | null)
      : null;
  const followupDate = normalizeOptionalFollowupDate(request?.followupDate);
  const permitOnlyUpload =
    followupMode === 'daily' &&
    normalizeOptionalBoolean(request?.permitOnlyUpload) === true;
  const permitValidFromByFileKey =
    normalizeConstructionPermitValidityDateByFileKey(
      request?.permitValidFromByFileKey,
    );
  const permitValidUntilByFileKey =
    normalizeConstructionPermitValidityDateByFileKey(
      request?.permitValidUntilByFileKey,
    );
  validateConstructionPermitValidityDateRanges(
    permitValidFromByFileKey,
    permitValidUntilByFileKey,
  );
  const partialDailySubmit =
    followupMode === 'daily' &&
    !permitOnlyUpload &&
    normalizeOptionalBoolean(request?.partialDailySubmit) === true;
  const shouldRequireDailyPersonnelFields =
    followupMode === 'daily' &&
    dailyFollowupStage === 'prepare' &&
    !permitOnlyUpload &&
    (!partialDailySubmit || dailyChecklistFocus === 'personnel');
  const shouldAcceptDailyIsolationFields =
    followupMode === 'daily' &&
    dailyFollowupStage === 'prepare' &&
    !permitOnlyUpload &&
    (!partialDailySubmit || dailyChecklistFocus === 'isolation');
  const hasWorkTypeInput = Array.isArray(request?.workTypes)
    ? request.workTypes.length > 0
    : typeof request?.workTypes === 'string' &&
      request.workTypes.trim().length > 0;
  const workTypes = hasWorkTypeInput
    ? normalizeOptionalAllowedValues(request?.workTypes, WORK_TYPES, '作业类型')
    : [];
  const followupStaffIds =
    followupMode === 'daily' &&
    !permitOnlyUpload &&
    (!partialDailySubmit || dailyChecklistFocus === 'personnel')
      ? normalizeRequiredUserIds(request?.followupStaffIds, '跟进人员')
      : normalizeOptionalUserIds(request?.followupStaffIds);
  const dailyPersonnelCheck = shouldRequireDailyPersonnelFields
    ? normalizeRequiredText(
        request?.dailyPersonnelCheck,
        '每日人员核查不能为空',
      )
    : null;
  const dailyPersonnelCheckParticipants = shouldRequireDailyPersonnelFields
    ? normalizeDailyPersonnelCheckParticipants(request?.dailyCrewMembers)
    : [];
  const dailyPersonnelCertificateAudit = shouldRequireDailyPersonnelFields
    ? buildDailyPersonnelCertificateAuditResult(
        workTypes,
        dailyPersonnelCheckParticipants,
      )
    : null;
  const isolationCompliant = null;
  const completed =
    followupMode === 'daily' &&
    dailyFollowupStage === 'close' &&
    !permitOnlyUpload
      ? normalizeAllowedValue(
          request?.completed,
          YES_NO,
          '项目是否整体全部完成',
        )
      : null;
  const isolationFeedback = shouldAcceptDailyIsolationFields
    ? normalizeOptionalText(request?.isolationFeedback)
    : null;
  const processFeedback =
    followupMode === 'daily' && dailyFollowupStage === 'process'
      ? normalizeOptionalText(request?.processFeedback)
      : null;
  const closingFeedback = null;
  const depositPaid =
    followupMode === 'supplemental'
      ? normalizeOptionalAllowedValue(
          request?.depositPaid,
          YES_NO,
          '是否缴纳保证金',
        )
      : null;
  const depositAmount =
    followupMode === 'supplemental'
      ? normalizeOptionalNumber(request?.depositAmount, '缴纳保证金（元）')
      : null;
  const depositDeducted =
    followupMode === 'supplemental'
      ? normalizeOptionalNumber(request?.depositDeducted, '被扣款保证金')
      : null;
  const completionChecklist =
    followupMode === 'daily' &&
    dailyFollowupStage === 'close' &&
    hasCompletionChecklistInput(request?.completionChecklist)
      ? normalizeConstructionCompletionChecklist(
          request?.completionChecklist,
          getConstructionCompletionChecklistItems(completed),
        )
      : null;
  const checklistContext = {
    workContent: normalizeOptionalText(request?.checklistWorkContent),
    constructionCode: normalizeOptionalText(request?.checklistConstructionCode),
    building: normalizeOptionalText(request?.checklistBuilding),
    contractor: normalizeOptionalText(request?.checklistContractor),
    planStartTime: normalizeOptionalText(request?.checklistPlanStartTime),
    planEndTime: normalizeOptionalText(request?.checklistPlanEndTime),
  };

  const fields: Record<string, unknown> = {
    施工总览: [constructionRecordId],
  };

  if (followupStaffIds.length > 0) {
    fields.跟进人员 = followupStaffIds.map((id) => ({ id }));
  }
  if (followupMode === 'daily' && !permitOnlyUpload && workTypes.length > 0) {
    fields.当日作业类型 = workTypes;
  }
  if (dailyPersonnelCertificateAudit) {
    fields[CONSTRUCTION_DAILY_PERSONNEL_CHECK_AUDIT_FIELD] =
      dailyPersonnelCertificateAudit.feedback;
  }
  if (followupDate) fields.跟进日期 = getShanghaiDateKeyTime(followupDate);
  if (isolationFeedback) fields['挂牌&隔离合规反馈'] = isolationFeedback;
  if (processFeedback) fields['AI识别反馈（过程）'] = processFeedback;
  if (completed) fields.是否完成 = completed;
  if (
    followupMode === 'daily' &&
    dailyFollowupStage === 'close' &&
    !permitOnlyUpload
  ) {
    fields.EHS施工收尾审批 = true;
  }
  if (depositPaid) fields.是否缴纳保证金 = depositPaid;
  if (depositPaid) fields.质保金是否确认 = true;
  if (depositPaid) fields.同步机房经理 = true;
  if (depositAmount !== null) fields['缴纳保证金（元）'] = depositAmount;
  if (depositDeducted !== null) fields.被扣款保证金 = depositDeducted;
  if (completionChecklist) {
    fields[CONSTRUCTION_COMPLETION_CHECKLIST_FIELD_NAMES[0]] =
      JSON.stringify(completionChecklist);
  }

  return {
    fields,
    normalized: {
      constructionRecordId,
      followupRecordId,
      followupMode,
      dailyFollowupStage,
      dailyChecklistFocus,
      followupDate,
      permitOnlyUpload,
      permitValidFromByFileKey,
      permitValidUntilByFileKey,
      partialDailySubmit,
      workTypes,
      followupStaffIds,
      dailyPersonnelCheck,
      dailyPersonnelCheckParticipants,
      isolationCompliant,
      isolationFeedback,
      processFeedback,
      closingFeedback,
      completed,
      depositPaid,
      depositAmount,
      depositDeducted,
      completionChecklist,
      checklistContext,
    },
  };
}

export function buildConstructionFollowupOverviewFields(
  normalized: Pick<
    NormalizedConstructionFollowup,
    | 'followupMode'
    | 'dailyFollowupStage'
    | 'permitOnlyUpload'
    | 'workTypes'
    | 'completed'
    | 'depositPaid'
    | 'depositAmount'
    | 'depositDeducted'
  >,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const workflow = getConstructionOverviewWorkflowValue(normalized);
  if (workflow) fields.流程 = workflow;
  if (
    normalized.followupMode === 'supplemental' &&
    normalized.workTypes.length > 0
  ) {
    fields.作业类型 = normalized.workTypes;
  }
  if (normalized.depositPaid) fields.是否缴纳保证金 = normalized.depositPaid;
  if (normalized.depositAmount !== null) {
    fields['缴纳保证金（元）'] = normalized.depositAmount;
  }
  if (normalized.depositDeducted !== null) {
    fields.被扣款保证金 = normalized.depositDeducted;
  }
  return fields;
}

export function hasConstructionApprovalMaterialUpload(
  files: readonly Pick<ConstructionUploadFile, 'fieldname'>[] = [],
): boolean {
  return files.some((file) =>
    APPROVAL_MATERIAL_UPLOAD_ATTACHMENT_KEYS.has(file.fieldname),
  );
}

function getConstructionOverviewWorkflowValue(
  normalized: Pick<
    NormalizedConstructionFollowup,
    'followupMode' | 'dailyFollowupStage' | 'permitOnlyUpload' | 'completed'
  >,
): string | null {
  if (normalized.followupMode !== 'daily' || normalized.permitOnlyUpload) {
    return null;
  }
  if (normalized.dailyFollowupStage === 'prepare') return '施工进行';
  if (normalized.dailyFollowupStage === 'process') return '施工进行';
  if (normalized.dailyFollowupStage === 'close') {
    return normalized.completed === '是' ? '闭环归档' : '施工进行';
  }
  return null;
}

export function validateConstructionFollowupSubmission(
  normalized: NormalizedConstructionFollowup,
  files: ConstructionUploadFile[] = [],
  options: {
    existingAttachmentFields?: string[];
    requirePermitValidityDates?: boolean;
  } = {},
) {
  const uploadedFieldNames = new Set(files.map((file) => file.fieldname));
  if (options.requirePermitValidityDates) {
    const requiresValidityStart =
      Object.keys(normalized.permitValidFromByFileKey).length > 0;
    const missingValidityDates = Object.entries(
      CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS,
    )
      .filter(
        ([fileKey]) =>
          uploadedFieldNames.has(fileKey) &&
          (!normalized.permitValidUntilByFileKey[fileKey] ||
            (requiresValidityStart &&
              !normalized.permitValidFromByFileKey[fileKey])),
      )
      .map(([, config]) => config.label);
    if (missingValidityDates.length > 0) {
      throw new Error(`请选择${missingValidityDates.join('、')}有效期`);
    }
  }

  if (normalized.followupMode === 'supplemental') {
    const hasFieldContent = Boolean(
      normalized.dailyPersonnelCheck ||
      normalized.isolationFeedback ||
      normalized.processFeedback ||
      normalized.closingFeedback ||
      normalized.completed ||
      normalized.depositPaid ||
      normalized.depositAmount !== null ||
      normalized.depositDeducted !== null ||
      normalized.workTypes.length > 0,
    );
    const hasFileContent = normalized.followupRecordId
      ? files.length > 0
      : files.some((file) =>
          INITIAL_APPLICATION_CONTENT_ATTACHMENT_KEYS.has(file.fieldname),
        );

    if (!hasFieldContent && !hasFileContent) {
      throw new Error('初始申请至少选择一个作业类型或上传一个附件');
    }
    return;
  }

  if (normalized.permitOnlyUpload) {
    const hasPermitUpload = Object.keys(
      CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS,
    ).some((fieldName) => uploadedFieldNames.has(fieldName));
    if (!hasPermitUpload) {
      throw new Error('请上传新的作业票');
    }
    return;
  }
  if (normalized.partialDailySubmit) {
    const hasPartialFieldContent = Boolean(
      (normalized.dailyChecklistFocus === 'workType' &&
        normalized.workTypes.length > 0) ||
      normalized.dailyPersonnelCheck ||
      normalized.isolationFeedback ||
      normalized.processFeedback ||
      normalized.closingFeedback ||
      normalized.completed ||
      normalized.completionChecklist,
    );
    if (files.length === 0 && !hasPartialFieldContent) {
      throw new Error('请填写或上传当前弹窗的跟进内容');
    }
    return;
  }
  const existingFieldNames = new Set(options.existingAttachmentFields || []);
  const dailyFollowupStage = normalized.dailyFollowupStage || 'prepare';
  const missing = DAILY_FOLLOWUP_REQUIRED_ATTACHMENT_FIELDS[dailyFollowupStage]
    .filter(
      (field) =>
        !uploadedFieldNames.has(field.key) &&
        !existingFieldNames.has(field.key),
    )
    .map((field) => field.label);

  if (missing.length > 0) {
    const stageLabel =
      dailyFollowupStage === 'prepare'
        ? '准备'
        : dailyFollowupStage === 'process'
          ? '实施'
          : '收尾';
    throw new Error(`每日施工${stageLabel}需上传${missing.join('、')}`);
  }
}

export function validateConstructionApplicationSubmission(
  files: ConstructionUploadFile[] = [],
) {
  const uploadedFieldNames = new Set(files.map((file) => file.fieldname));
  const missing = CONSTRUCTION_APPLICATION_REQUIRED_ATTACHMENT_FIELDS.filter(
    (field) => !uploadedFieldNames.has(field.key),
  );
  if (missing.length > 0) {
    throw new Error(
      `新建施工需上传${missing.map((field) => field.label).join('、')}`,
    );
  }
}

export function buildIsolationPhotoAuditFeedback(
  files: ConstructionUploadFile[] = [],
): string | null {
  const isolationFiles = files.filter(
    (file) => file.fieldname === 'isolationPhotoFiles',
  );
  if (isolationFiles.length === 0) {
    return null;
  }

  const imageCount = isolationFiles.filter((file) =>
    /^image\//i.test(file.mimetype || ''),
  ).length;
  const fileNames = isolationFiles.map((file) => file.originalname).join('、');
  const imageSummary =
    imageCount === isolationFiles.length
      ? `已接收 ${isolationFiles.length} 张图片`
      : `已接收 ${isolationFiles.length} 个文件，其中 ${imageCount} 个为图片`;

  return [
    `自动审核：${imageSummary}（${fileNames}）`,
    '水印核验项：只判断是否包含世纪互联/VNET水印模板；中文“世纪互联”或英文“VNET”任一可见即为通过',
    '地点说明：保税A区、阿里巴巴南通保税A区数据中心均属于有效地点，不应作为水印核验缺失项',
    '现场核验项：需能看到隔离带、警示牌、施工铭牌等挂牌隔离信息',
    '当前未配置视觉识别服务，系统已生成审核要点，请在多维表中结合照片复核后确认',
  ].join('；');
}

export function buildIsolationPhotoVisionAuditPayload(
  files: ConstructionUploadFile[],
  model: string,
  options: {
    disableThinking?: boolean;
    context?: IsolationPhotoVisionAuditContext;
  } = {},
) {
  const imageContents = files
    .filter((file) => file.fieldname === 'isolationPhotoFiles')
    .filter((file) => /^image\//i.test(file.mimetype || ''))
    .slice(0, 4)
    .map((file) => ({
      type: 'image_url' as const,
      image_url: {
        url: `data:${file.mimetype || 'image/jpeg'};base64,${file.buffer.toString('base64')}`,
      },
    }));
  const contextLines = buildIsolationPhotoVisionAuditContextLines(
    options.context,
  );

  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    stream: false,
    ...(options.disableThinking ? { thinking: { type: 'disabled' } } : {}),
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: [
              '请审核施工准备阶段“挂牌与隔离照片”。只根据图片可见内容判断，不要猜测。',
              '水印核验只判断图片是否使用世纪互联/VNET水印模板；底部水印里的蓝底白字“世纪互联 VNET”品牌块、中文“世纪互联”或英文“VNET”任一可见，都应视为水印核验通过。',
              '项目/机房标题、区域、工作内容、拍摄时间、地点可作为上下文参考，不作为水印核验不通过原因；不要要求额外的图形 logo，也不要把“今日水印相机”模板误判为缺少世纪互联/VNET标识。',
              '地点包含“保税A区”或“阿里巴巴南通保税A区数据中心”时，应视为南通项目有效地点，不要判为地点错误。',
              ...contextLines,
              '现场挂牌隔离要素应包含：隔离带、警示牌、施工铭牌等信息；如未看到请判定为缺失。',
              '请返回严格 JSON，不要输出 Markdown。结构：',
              '{"result":"通过|不通过|需人工复核","summary":"一句话结论","watermark":{"complete":true,"hasVnetLogo":true,"missing":["缺失项"]},"onsite":{"isolationTape":true,"warningSign":true,"constructionNameplate":true},"issues":["问题"],"suggestions":["整改建议"]}',
            ].join('\n'),
          },
          ...imageContents,
        ],
      },
    ],
  };
}

export function buildConstructionPermitAuditRequirementLines(
  records: readonly ConstructionPermitAuditRequirementRecord[] = [],
  permitLabel: string,
  workTypes: readonly string[] = [],
): string[] {
  const aliases = getConstructionPermitAuditRequirementAliases(permitLabel);
  const requirementRecords =
    mergeConstructionPermitAuditRequirementRecords(records);
  const requestedWorkTypes = workTypes
    .map((item) => normalizeRequirementMatchText(item))
    .filter(Boolean);

  const candidates = requirementRecords
    .map((record, index) => {
      const fields = record.fields || {};
      const recordWorkTypes = extractDisplayValues(
        pickField(
          fields,
          CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_FIELD_NAMES.workTypes,
        ),
      );
      const uploadFiles = extractDisplayValues(
        pickField(
          fields,
          CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_FIELD_NAMES.uploadFiles,
        ),
      );
      const credentialTypes = extractDisplayValues(
        pickField(
          fields,
          CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_FIELD_NAMES.credentialTypes,
        ),
      );
      const auditBasis = extractDisplayValues(
        pickField(
          fields,
          CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_FIELD_NAMES.auditBasis,
        ),
      );
      const formAuditRequirements = extractDisplayValues(
        pickField(
          fields,
          CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_FIELD_NAMES.formAuditRequirements,
        ),
      );
      const relevantFormAuditRequirements = filterRelevantFormAuditRequirements(
        formAuditRequirements,
        aliases,
      );
      const preparationRequirements = extractDisplayValues(
        pickField(
          fields,
          CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_FIELD_NAMES.preparationRequirements,
        ),
      );
      const searchable = [
        ...recordWorkTypes,
        ...uploadFiles,
        ...credentialTypes,
        ...auditBasis,
        ...formAuditRequirements,
        ...preparationRequirements,
      ];
      const permitWorkTypeMatched = recordWorkTypes.some((item) =>
        aliases.some((alias) => requirementTextContains(item, alias)),
      );
      const workTypeMatched =
        requestedWorkTypes.length > 0 &&
        recordWorkTypes.some((item) =>
          requestedWorkTypes.some((workType) =>
            requirementTextContains(item, workType),
          ),
        );
      const permitMatched = searchable.some((item) =>
        aliases.some((alias) => requirementTextContains(item, alias)),
      );

      let score = 0;
      if (permitWorkTypeMatched) score += 8;
      if (workTypeMatched) score += 2;
      if (
        uploadFiles.some((item) =>
          aliases.some((alias) => requirementTextContains(item, alias)),
        )
      ) {
        score += 5;
      }
      if (
        formAuditRequirements.some((item) =>
          aliases.some((alias) => requirementTextContains(item, alias)),
        )
      ) {
        score += 3;
      }
      if (!permitMatched) {
        return null;
      }

      return {
        index,
        score: score || 1,
        recordWorkTypes,
        uploadFiles,
        credentialTypes,
        auditBasis,
        formAuditRequirements:
          relevantFormAuditRequirements.length > 0
            ? relevantFormAuditRequirements
            : formAuditRequirements,
        preparationRequirements,
      };
    })
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3);

  return dedupe(
    candidates.flatMap((candidate) =>
      [
        formatRequirementLine('匹配作业类型', candidate.recordWorkTypes),
        formatRequirementLine('需上传文件', candidate.uploadFiles),
        formatRequirementLine('所需作业证', candidate.credentialTypes),
        formatRequirementLine('表单审核要求', candidate.formAuditRequirements),
        ...formatFormAuditRequirementDetailLines(
          candidate.formAuditRequirements,
        ),
        formatRequirementLine('AI判断依据', candidate.auditBasis),
        formatRequirementLine(
          '施工准备要求',
          candidate.preparationRequirements,
        ),
      ].filter((line): line is string => Boolean(line)),
    ),
  ).slice(0, 18);
}

function mergeConstructionPermitAuditRequirementRecords(
  records: readonly ConstructionPermitAuditRequirementRecord[],
): ConstructionPermitAuditRequirementRecord[] {
  const merged = [
    ...records,
    ...SOLIDIFIED_CONSTRUCTION_PERMIT_AUDIT_REQUIREMENTS,
  ];
  const seen = new Set<string>();
  return merged.filter((record) => {
    const fields = record.fields || {};
    const key = [
      extractDisplayValues(
        pickField(
          fields,
          CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_FIELD_NAMES.workTypes,
        ),
      ).join('|'),
      extractDisplayValues(
        pickField(
          fields,
          CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_FIELD_NAMES.formAuditRequirements,
        ),
      ).join('|'),
    ].join('::');
    if (!key || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

export function buildDailyPersonnelCertificateAuditResult(
  workTypes: readonly string[] = [],
  participants: readonly ConstructionDailyPersonnelCheckParticipant[] = [],
  records: readonly ConstructionPermitAuditRequirementRecord[] = [],
): DailyPersonnelCertificateAuditResult | null {
  const requirements = buildDailyPersonnelCertificateRequirements(
    workTypes,
    records,
  );
  if (requirements.length === 0) {
    return null;
  }

  const certificateTexts = participants
    .map((participant) =>
      normalizeRequirementMatchText(participant.certificateSummary || ''),
    )
    .filter(Boolean);
  const failed = requirements.find(
    (requirement) =>
      !certificateTexts.some((certificateText) =>
        requirement.aliases.some((alias) =>
          requirementTextContains(certificateText, alias),
        ),
      ),
  );

  if (!failed) {
    return {
      passed: true,
      feedback: '通过',
      failureReason: null,
      blockingMessage: null,
    };
  }

  const failureReason = trimDailyPersonnelAuditFeedback(
    `缺${failed.shortCredentialLabel}`,
  );
  return {
    passed: false,
    feedback: trimDailyPersonnelAuditFeedback(`不通过：${failureReason}`),
    failureReason,
    blockingMessage: `${failed.workType}${failureReason}，无法提交`,
  };
}

function buildDailyPersonnelCertificateRequirements(
  workTypes: readonly string[],
  records: readonly ConstructionPermitAuditRequirementRecord[],
): Array<{
  workType: string;
  shortCredentialLabel: string;
  aliases: string[];
}> {
  const requestedWorkTypes = dedupe(
    workTypes.map((item) => String(item || '').trim()).filter(Boolean),
  );
  if (requestedWorkTypes.length === 0) {
    return [];
  }

  const requirementRecords =
    mergeConstructionPermitAuditRequirementRecords(records);
  return requestedWorkTypes.flatMap((workType) => {
    const credentialTypes = dedupe(
      requirementRecords.flatMap((record) => {
        const fields = record.fields || {};
        const recordWorkTypes = extractDisplayValues(
          pickField(
            fields,
            CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_FIELD_NAMES.workTypes,
          ),
        );
        const matched = recordWorkTypes.some((recordWorkType) =>
          requirementTextContains(recordWorkType, workType),
        );
        if (!matched) {
          return [];
        }
        return extractDisplayValues(
          pickField(
            fields,
            CONSTRUCTION_PERMIT_AUDIT_REQUIREMENT_FIELD_NAMES.credentialTypes,
          ),
        );
      }),
    );
    if (credentialTypes.length === 0) {
      return [];
    }

    const credentialRule = buildDailyPersonnelCredentialRule(
      workType,
      credentialTypes,
    );
    return [
      {
        workType,
        shortCredentialLabel: credentialRule.shortCredentialLabel,
        aliases: credentialRule.aliases,
      },
    ];
  });
}

function buildDailyPersonnelCredentialRule(
  workType: string,
  credentialTypes: readonly string[],
): { shortCredentialLabel: string; aliases: string[] } {
  const searchable = normalizeRequirementMatchText(
    [workType, ...credentialTypes].join(' '),
  );
  if (
    searchable.includes('临时用电') ||
    searchable.includes('临电') ||
    searchable.includes('低压') ||
    searchable.includes('高压')
  ) {
    return {
      shortCredentialLabel: '低压/高压证',
      aliases: ['低压', '高压'],
    };
  }
  if (
    searchable.includes('焊接') ||
    searchable.includes('热切割') ||
    searchable.includes('焊工')
  ) {
    return {
      shortCredentialLabel: '焊接热切割证',
      aliases: ['焊接与热切割', '焊接', '热切割', '焊工'],
    };
  }
  if (searchable.includes('高处') || searchable.includes('登高')) {
    return {
      shortCredentialLabel: '高处证',
      aliases: ['高处', '登高'],
    };
  }

  const label =
    credentialTypes
      .map((item) => String(item || '').replace(/[，,、\s]+/g, ''))
      .filter(Boolean)
      .join('/') || '所需证件';
  return {
    shortCredentialLabel: label.length > 8 ? `${label.slice(0, 8)}证` : label,
    aliases: [...credentialTypes],
  };
}

function trimDailyPersonnelAuditFeedback(value: string): string {
  const text = String(value || '').trim();
  return text.length > 20 ? text.slice(0, 20) : text;
}

function filterRelevantFormAuditRequirements(
  values: readonly string[],
  aliases: readonly string[],
): string[] {
  return values.filter((value) =>
    aliases.some((alias) => requirementTextContains(value, alias)),
  );
}

function formatFormAuditRequirementDetailLines(
  values: readonly string[],
): string[] {
  return values
    .map((value) => {
      const detail = findFormAuditRequirementDetail(value);
      return detail
        ? `对应表单审核要点：${value}：${truncateRequirementLine(detail)}`
        : null;
    })
    .filter((line): line is string => Boolean(line));
}

function findFormAuditRequirementDetail(value: string): string | null {
  const text = normalizeRequirementMatchText(value);
  if (!text) {
    return null;
  }
  const matched = CONSTRUCTION_FORM_AUDIT_REQUIREMENT_DETAILS.find((item) =>
    item.keywords.some((keyword) =>
      requirementTextContains(text, normalizeRequirementMatchText(keyword)),
    ),
  );
  return matched?.summary || null;
}

function formatRequirementLine(
  label: string,
  values: readonly string[],
): string | null {
  const text = values
    .map((item) => item.trim())
    .filter(Boolean)
    .join('、');
  return text ? `${label}：${truncateRequirementLine(text)}` : null;
}

function truncateRequirementLine(value: string): string {
  const text = value.trim();
  return text.length > 700 ? `${text.slice(0, 700)}...` : text;
}

function getConstructionPermitAuditRequirementAliases(
  permitLabel: string,
): string[] {
  const text = normalizeRequirementMatchText(permitLabel);
  if (text.includes('动火')) {
    return [
      '动火',
      '动火作业',
      '动火许可证',
      '动火作业许可证',
      '动火作业票',
      '动火作业单',
    ];
  }
  if (text.includes('高处')) {
    return ['高处', '高处作业', '高处作业许可证', '高处作业票', '高处作业单'];
  }
  if (text.includes('临时用电') || text.includes('临电')) {
    return [
      '临时用电',
      '临电',
      '临时用电作业',
      '临时用电作业许可证',
      '临时用电许可证',
      '临时用电作业票',
      '临时用电票',
    ];
  }
  if (text.includes('受限空间') || text.includes('有限空间')) {
    return [
      '受限空间',
      '有限空间',
      '受限空间作业',
      '有限空间作业',
      '受限空间作业许可证',
      '有限空间作业许可证',
      '受限空间作业票',
    ];
  }
  return [permitLabel].filter(Boolean);
}

function requirementTextContains(value: string, keyword: string): boolean {
  const text = normalizeRequirementMatchText(value);
  const target = normalizeRequirementMatchText(keyword);
  return Boolean(
    text && target && (text.includes(target) || target.includes(text)),
  );
}

function normalizeRequirementMatchText(value: string): string {
  return String(value || '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

const CONSTRUCTION_APPLICATION_DOCUMENT_LABELS = [
  '作业项目',
  '作业日期',
  '作业单位',
  '作业方负责人',
  '联系电话',
  '施工人数',
  '现场示例人员019',
  '作业人员身份证号及资质证书',
  '作业地点',
  '作业内容描述',
  '材料堆放点',
  '特殊作业',
  '能源切断',
  '停用设备',
  '作业现场负责人',
  '审核人',
  '一级审批',
  '日期',
  '意见',
] as const;

const CONSTRUCTION_APPLICATION_REQUIRED_DOCUMENT_FIELDS = [
  { key: '作业项目', label: '作业项目' },
  { key: '作业日期', label: '作业日期' },
  { key: '作业单位', label: '作业单位' },
  { key: '作业方负责人', label: '作业方负责人' },
  { key: '现场示例人员019', label: '现场示例人员019' },
  { key: '施工人数', label: '施工人数' },
  { key: '作业人员身份证号及资质证书', label: '作业人员' },
  { key: '作业地点', label: '作业地点' },
  { key: '作业内容描述', label: '作业内容' },
  { key: '材料堆放点', label: '材料堆放点' },
] as const;

export function buildConstructionPermitAuditFeedback(
  files: ConstructionUploadFile[] = [],
  permitLabel: string,
  _requirementLines: readonly string[] = [],
  referenceDate: Date = new Date(),
  options: { requiresValidity?: boolean } = {},
): string | null {
  if (files.length === 0) {
    return null;
  }

  if (options.requiresValidity === false) {
    if (isConstructionRiskDisclosureLabel(permitLabel)) {
      return formatConstructionRiskDisclosureCompactFeedback({
        result: '需人工复核',
        summary: '',
        expiryDate: null,
        issues: [],
        suggestions: [],
      });
    }
    return formatConstructionDocumentCompactFeedback(
      {
        result: '需人工复核',
        summary: '',
        expiryDate: null,
        issues: ['资料信息需人工核验'],
        suggestions: [],
      },
      permitLabel,
    );
  }

  const expiryDate = inferConstructionPermitExpiryDateFromFiles(
    files,
    referenceDate,
  );
  if (isConstructionApplicationPermitLabel(permitLabel)) {
    const documentFeedback = buildConstructionApplicationDocumentAuditFeedback(
      files,
      referenceDate,
    );
    if (documentFeedback) {
      return documentFeedback;
    }
    return formatConstructionApplicationCompactFeedback({
      result: '需人工复核',
      summary: '',
      expiryDate,
      issues: [expiryDate ? '人员：待核' : '有效期未识别，需人工核验'],
      suggestions: [],
    });
  }
  return formatConstructionPermitCompactFeedback(
    {
      result: '需人工复核',
      summary: '',
      expiryDate,
      issues: [expiryDate ? '票面信息需人工核验' : '有效期未识别，需人工核验'],
      suggestions: [],
    },
    permitLabel,
    referenceDate,
  );
}

function buildConstructionApplicationDocumentAuditFeedback(
  files: readonly ConstructionUploadFile[],
  referenceDate: Date,
): string | null {
  const sourceText = getConstructionPermitSourceTextFromFiles(files);
  if (!isLikelyConstructionApplicationDocumentText(sourceText)) {
    return null;
  }

  const fields = new Map<string, string>();
  CONSTRUCTION_APPLICATION_DOCUMENT_LABELS.forEach((label) => {
    fields.set(
      label,
      extractConstructionApplicationDocumentFieldValue(sourceText, label),
    );
  });

  const expiryDate =
    inferConstructionPermitExpiryDateFromText(sourceText, referenceDate) ||
    null;
  const workerCount = extractConstructionApplicationDocumentWorkerCount(fields);
  const personnelText = fields.get('作业人员身份证号及资质证书') || '';
  const missingFields =
    CONSTRUCTION_APPLICATION_REQUIRED_DOCUMENT_FIELDS.filter((field) =>
      field.key === '施工人数'
        ? !workerCount
        : !isFilledConstructionApplicationDocumentValue(
            fields.get(field.key) || '',
          ),
    ).map((field) => field.label);

  const issues = [
    missingFields.length > 0
      ? `填写：缺少${formatConstructionApplicationMissingFields(missingFields)}`
      : '填写：关键项可见',
    workerCount
      ? `人员：作业人数疑似${workerCount}人，${getConstructionApplicationDocumentIdStatus(
          personnelText,
          workerCount,
        )}`
      : '人员：作业人数待核，身份证待核',
    expiryDate ? `有效期：至${expiryDate}` : '有效期：未识别',
  ];

  return formatConstructionApplicationCompactFeedback({
    result: '需人工复核',
    summary: '',
    expiryDate,
    issues,
    suggestions: [],
  });
}

function isLikelyConstructionApplicationDocumentText(value: string): boolean {
  if (!value) {
    return false;
  }
  const matchedLabels = CONSTRUCTION_APPLICATION_DOCUMENT_LABELS.filter(
    (label) => value.includes(label),
  ).length;
  return (
    matchedLabels >= 5 &&
    /作业人员身份证号及资质证书|施工人数|作业内容描述/.test(value)
  );
}

function extractConstructionApplicationDocumentFieldValue(
  sourceText: string,
  label: string,
): string {
  const currentLabelPattern =
    buildConstructionApplicationDocumentLabelPattern(label);
  const nextLabelPattern = CONSTRUCTION_APPLICATION_DOCUMENT_LABELS.filter(
    (item) => item !== label,
  )
    .sort((left, right) => right.length - left.length)
    .map(buildConstructionApplicationDocumentLabelPattern)
    .join('|');
  const pattern = new RegExp(
    `${currentLabelPattern}\\s*[:：]?\\s*([\\s\\S]*?)(?=\\s*(?:${nextLabelPattern})\\s*[:：]?|$)`,
  );
  const value = pattern.exec(sourceText)?.[1] || '';
  return normalizeConstructionApplicationDocumentFieldValue(value);
}

function buildConstructionApplicationDocumentLabelPattern(
  label: string,
): string {
  return `${escapeRegExp(label)}(?:（[^）]{0,40}）)?`;
}

function normalizeConstructionApplicationDocumentFieldValue(
  value: string,
): string {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .replace(/^[：:；;，,、。]+|[：:；;，,、。]+$/g, '')
    .trim();
}

function isFilledConstructionApplicationDocumentValue(value: string): boolean {
  const text = normalizeConstructionApplicationDocumentFieldValue(value);
  return Boolean(text && !/^(无|暂无|不涉及|\/|-|—)$/.test(text));
}

function extractConstructionApplicationDocumentWorkerCount(
  fields: ReadonlyMap<string, string>,
): string | null {
  const explicitCount =
    /(\d{1,3})/.exec(fields.get('施工人数') || '')?.[1] || null;
  if (explicitCount) {
    return explicitCount;
  }

  const personnelText = fields.get('作业人员身份证号及资质证书') || '';
  const serials = new Set(
    Array.from(
      personnelText.matchAll(
        /(?:^|\s)(\d{1,3})[.．、]\s*[\u4e00-\u9fff]{2,8}/g,
      ),
    ).map((match) => match[1]),
  );
  return serials.size > 0 ? String(serials.size) : null;
}

function getConstructionApplicationDocumentIdStatus(
  personnelText: string,
  workerCount: string,
): string {
  const expectedCount = Number(workerCount);
  const idCount = (
    normalizeConstructionApplicationDocumentFieldValue(personnelText).match(
      /\d{17}[\dXx]|\d{15}/g,
    ) || []
  ).length;
  if (!Number.isFinite(expectedCount) || expectedCount <= 0) {
    return idCount > 0 ? '身份证完整' : '身份证待核';
  }
  if (idCount >= expectedCount) {
    return '身份证完整';
  }
  return idCount > 0 ? '身份证缺失' : '身份证待核';
}

function formatConstructionApplicationMissingFields(
  fields: readonly string[],
): string {
  if (fields.length <= 3) {
    return fields.join('、');
  }
  return `${fields.slice(0, 3).join('、')}等${fields.length}项`;
}

export function buildConstructionPermitVisionAuditPayload(
  files: ConstructionUploadFile[],
  model: string,
  permitLabel: string,
  options: {
    disableThinking?: boolean;
    dailyValidityRefresh?: boolean;
    referenceDate?: Date;
    requirementLines?: readonly string[];
    requiresValidity?: boolean;
    context?: ConstructionPermitVisionAuditContext;
  } = {},
) {
  const requiresValidity = options.requiresValidity !== false;
  const referenceDateKey = formatShanghaiDateKey(
    options.referenceDate || new Date(),
  );
  const fileNameLine = files
    .map((file) => normalizeConstructionUploadFileName(file.originalname))
    .filter(Boolean)
    .map((fileName) => `附件名称：${fileName}`)
    .join('\n');
  const crewMemberLines = (options.context?.crewMembers || [])
    .slice(0, 30)
    .map((member, index) => {
      const parts = [
        member.name,
        member.certificateNo ? `身份证${member.certificateNo}` : '',
        member.authorizationStatus ? `状态${member.authorizationStatus}` : '',
        member.certificateSummary || '',
        member.complianceStatus || '',
        member.issueSummary || '',
      ].filter(Boolean);
      return parts.length ? `${index + 1}. ${parts.join('，')}` : '';
    })
    .filter(Boolean);
  const contextPrompt = [
    options.context?.workContent
      ? `作业内容：${options.context.workContent}`
      : '',
    options.context?.workTypes?.length
      ? `作业类型：${options.context.workTypes.join('、')}`
      : '',
    options.context?.planStartTime
      ? `施工计划开始：${options.context.planStartTime}`
      : '施工计划开始：未提供',
    crewMemberLines.length
      ? ['施工人员台账（仅用于核对申请单人员）：', ...crewMemberLines].join(
          '\n',
        )
      : '施工人员台账：未提供',
  ]
    .filter(Boolean)
    .join('\n');
  const isConstructionApplicationForm =
    isConstructionApplicationPermitLabel(permitLabel);
  const isRiskDisclosureForm = isConstructionRiskDisclosureLabel(permitLabel);
  const constructionApplicationPrompt = isConstructionApplicationForm
    ? [
        '施工作业申请单重点审核：',
        '1. 填充是否完整；施工项目、作业内容、区域、施工单位、作业类型、计划时间、申请/审批/签字等关键项应可见。',
        '2. “停用设备及能源切断”这部分可以不填，不能因该部分空白判为不通过。',
        '3. 人员审核先识别申请单中的作业人数/施工人数/人员名单人数，再核对人员是否在施工人员台账中；按姓名可模糊匹配，并核对身份证号码是否正确。',
        '4. 不要把签字人数、审批人数、负责人/EHS/FM人数当作作业人数；只看到签名数量但看不清作业人员名单时，人数写“作业人数待核”。',
        '5. 有效期需要精确识别到截止日期；遇到“自/从 ... 至/到/截止/止 ...”，expiryDate 必须取结束日期，格式 YYYY-MM-DD。',
        'issues 固定按“填写：完整/缺少xxx/待核”“人员：作业人数疑似N人，身份证完整/模糊/缺失/待核”“有效期：至YYYY-MM-DD/未识别”分条返回。',
        '不要把“作业内容、施工区域、施工单位”等字段名单独当结论；不要用“但/且/其中”等词开头；每条控制 30 字内。',
      ].join('\n')
    : '';
  const riskDisclosurePrompt = isRiskDisclosureForm
    ? [
        '风险交底单重点审核：',
        '1. 填写是否完整；作业单位、人数/人员、许可范围/环境、风险识别、防范措施、应急措施、注意事项、负责人承诺等关键项应可见。',
        '2. 人员按交底单受交底人/签字区统计，人数不确定写“人员：待核”。',
        '3. 日期只判断交底/签字日期是否早于或等于施工计划开始，不需要有效期，expiryDate 固定为 null。',
        'issues 固定按“填写：完整/缺少xxx/待核”“人员：疑似N人/待核”“日期：交底早于作业/交底晚于作业/待核”分条返回。',
        '每条控制 30 字内；不要输出整改长句。',
      ].join('\n')
    : '';
  const requirementPrompt = options.requirementLines?.length
    ? [
        '以下为多维表“作业合规标准/表单审核要求/施工准备要求”匹配结果，必须优先按这些要求审核：',
        '必须逐项核对“表单审核要求”的对应审核要点；只把当前附件能看见且属于本票据的缺失项列为问题。',
        ...options.requirementLines.map((line) => `- ${line}`),
      ].join('\n')
    : requiresValidity
      ? '未匹配到多维表表单审核要求时，按通用作业票要求审核。'
      : '未匹配到多维表表单审核要求时，按通用施工资料要求审核。';
  const dailyValidityRefreshPrompt =
    requiresValidity && options.dailyValidityRefresh
      ? [
          '本次任务是“每日作业票有效期刷新”，核心只判断：作业票类别是否匹配、票面有效期/作业时间截止日期是否可识别、该截止日期相对当前核验日期是否过期。',
          '不要因为安全告知书、培训照片、人员证件、其他附件缺失，或非有效期相关签章/安全措施需要现场核验，就把有效期未过期的作业票判为“不通过”；有效期未过期时，issues 和 suggestions 都返回空数组。',
          '如果 expiryDate 晚于或等于当前核验日期，不能在 summary/issues 中写“已过期”。',
          'summary 必须写出识别到的作业时间或有效期范围；如果票面有“自/从 ... 至/到/截止/止 ...”，expiryDate 必须等于“至/到/截止/止”后的结束日期，不能取开始日期。',
        ].join('\n')
      : '';
  const hotWorkValidityPrompt = /动火/.test(permitLabel)
    ? [
        '动火作业票优先读取票面“动火时间”行作为有效期来源。',
        '如果动火时间写成“自 2026年6月4日11时20分 至 2026年6月8日8时30分止”，expiryDate 必须返回 2026-06-08，不能返回 2026-06-04。',
        '申请日期、签字日期、审批日期、验票日期只用于辅助审核，不能作为 expiryDate；有效期截止日必须取动火时间/作业时间的结束日期。',
      ].join('\n')
    : '';
  const imageContents = files
    .filter(isConstructionImageUploadFile)
    .slice(0, 4)
    .map((file) => ({
      type: 'image_url' as const,
      image_url: {
        url: `data:${getConstructionImageUploadMimeType(file)};base64,${file.buffer.toString('base64')}`,
      },
    }));

  const promptText = requiresValidity
    ? [
        `请审核施工许可材料“${permitLabel}”。只根据附件可见内容判断，不要猜测。`,
        `当前核验日期：${referenceDateKey}（北京时间）。判断“未过期/已过期/即将到期”时必须以这个日期为准，不要使用其他当前日期。`,
        fileNameLine,
        dailyValidityRefreshPrompt,
        hotWorkValidityPrompt,
        constructionApplicationPrompt,
        contextPrompt,
        requirementPrompt,
        '许可证、作业票、作业单按同类材料处理；例如“高处安全作业票”对应高处作业许可证，“动火作业票/动火作业单”对应动火许可证。',
        '不要仅因票面标题没有写“许可证”就判定不匹配、需人工复核或有效期未识别。',
        '重点识别：作业票类别是否匹配、项目/作业内容是否可见、审批或签章是否可见、有效期截止日期是否可见且未过期。',
        '作业票里的“作业时间”“施工时间”“有效时间”“有效期”均可作为有效期来源；遇到“自/从 ... 至/到/截止/止 ...”的时间范围，必须取“至/到/截止/止”后的结束日期作为 expiryDate，不要取开始日期。',
        '手写日期也要尽量识别。例如：作业时间 自 2026年5月22日10时30分 至 2026年7月29日8时00分止，应返回 expiryDate 为 2026-07-29。',
        '只要票面能看清年月日，即使时分不完整或为手写，也要返回可识别的 YYYY-MM-DD；只有结束日期完全看不清或票面确实没有有效期/作业时间时，才允许 expiryDate 为 null。',
        '如果能识别有效期，请把截止日期规范为 YYYY-MM-DD；如果无法识别，expiryDate 返回 null，并在 issues 中说明。',
        '请返回严格 JSON，不要输出 Markdown。结构：',
        '{"result":"通过|不通过|需人工复核","summary":"一句话结论","expiryDate":"YYYY-MM-DD|null","issues":["问题"],"suggestions":["整改建议"]}',
      ].join('\n')
    : [
        `请审核施工资料“${permitLabel}”。只根据附件可见内容判断，不要猜测。`,
        `当前核验日期：${referenceDateKey}（北京时间）。签署日期、记录日期只用于判断资料时间线是否合理；早于或等于当前核验日期的日期不能描述为未来日期。`,
        fileNameLine,
        contextPrompt,
        requirementPrompt,
        riskDisclosurePrompt ||
          [
            '《现场安全行为告知书》《安全行为告知书》均视为安全告知书，不要因名称不同判定不通过。',
            '本资料不需要识别有效期；不要因为没有有效期、没有日期或没有许可票标题判定不通过，expiryDate 固定返回 null。',
            '安全告知书重点只看：1. 据图统计人员/签字人数；2. 应签人员是否都已签；3. 签字日期是否早于施工计划开始。',
            '人员只统计安全告知书/现场安全行为告知书签字区可见签名人数；不要把作业票人数、培训人数、EHS或负责人身份当作应签人数。',
            '人数识别必须写“疑似N人”，不要写成确定人数；若人员项已写疑似N人，签字项不要重复同一人数。',
            '应签人员以告知书签字栏/人员名单可见行数为准；看不到应签名单时只写“签字：已见N人签字”或“签字：待核”，不要写“身份不明/未明确身份”。',
            '日期格式固定：“日期：签字YYYY-MM-DD早于计划YYYY-MM-DD”或“日期：签字YYYY-MM-DD晚于计划YYYY-MM-DD”；必须完整显示两个日期。',
            'issues 字段作为据图结果返回，必须按顺序写成“人员：...”“签字：...”“日期：...”。',
            '每条不超过 30 个字；不要把多个结果写成一个长句；无法判断写“待核”。',
          ].join('\n'),
        '请返回严格 JSON，不要输出 Markdown。结构：',
        '{"result":"通过|不通过|需人工复核","summary":"一句话结论","expiryDate":null,"issues":["问题"],"suggestions":["整改建议"]}',
      ].join('\n');

  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    stream: false,
    ...(options.disableThinking ? { thinking: { type: 'disabled' } } : {}),
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: promptText,
          },
          ...imageContents,
        ],
      },
    ],
  };
}

export function isConstructionImageUploadFile(
  file: ConstructionUploadFile,
): boolean {
  if (/^image\//i.test(file.mimetype || '')) {
    return true;
  }
  return /\.(?:jpe?g|png|webp|gif|bmp)$/i.test(
    normalizeConstructionUploadFileName(file.originalname),
  );
}

function getConstructionImageUploadMimeType(
  file: ConstructionUploadFile,
): string {
  if (/^image\//i.test(file.mimetype || '')) {
    return file.mimetype;
  }
  const name = normalizeConstructionUploadFileName(
    file.originalname,
  ).toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}

export function parseConstructionPermitVisionAuditResponse(
  content: string,
  options: { requiresValidity?: boolean } = {},
): ConstructionPermitVisionAuditResult {
  const normalized = extractJsonObjectText(content);
  const parsed = JSON.parse(normalized) as Record<string, unknown>;
  const issues = normalizeStringArray(parsed.issues);
  const suggestions = normalizeStringArray(parsed.suggestions);
  const expiryDate =
    options.requiresValidity === false
      ? null
      : normalizeConstructionPermitExpiryDate(parsed.expiryDate, [
          parsed.summary,
          ...issues,
          ...suggestions,
        ]);

  return {
    result: normalizeOptionalText(parsed.result) || '需人工复核',
    summary: normalizeOptionalText(parsed.summary) || '作业票审核未返回摘要',
    expiryDate,
    issues,
    suggestions,
  };
}

export function formatConstructionPermitVisionAuditFeedback(
  result: ConstructionPermitVisionAuditResult,
  permitLabel = '作业票',
  options: { requiresValidity?: boolean } = {},
): string {
  if (options.requiresValidity === false) {
    if (isConstructionRiskDisclosureLabel(permitLabel)) {
      return formatConstructionRiskDisclosureCompactFeedback(result);
    }
    return formatConstructionDocumentCompactFeedback(result, permitLabel);
  }
  if (isConstructionApplicationPermitLabel(permitLabel)) {
    return formatConstructionApplicationCompactFeedback(result);
  }
  return formatConstructionPermitCompactFeedback(result, permitLabel);
}

export function formatConstructionPermitDailyValidityFeedback(
  result: ConstructionPermitVisionAuditResult,
  referenceDate: Date = new Date(),
  permitLabel = '作业票',
): string {
  if (isConstructionApplicationPermitLabel(permitLabel)) {
    return formatConstructionApplicationCompactFeedback(result);
  }
  const referenceDateKey = formatShanghaiDateKey(referenceDate);
  const expiryDate = result.expiryDate;
  if (!expiryDate) {
    return formatConstructionPermitCompactFeedback(
      {
        ...result,
        result: '需人工复核',
        issues: result.issues.length
          ? result.issues
          : ['有效期未识别，需人工核验'],
      },
      permitLabel,
      referenceDate,
    );
  }

  const expired =
    getShanghaiDateKeyTime(expiryDate) <
    getShanghaiDateKeyTime(referenceDateKey);
  return formatConstructionPermitCompactFeedback(
    {
      ...result,
      result: expired ? '需人工复核' : '通过',
      issues: expired ? ['有效期已过期'] : [],
    },
    permitLabel,
    referenceDate,
  );
}

function formatConstructionPermitCompactFeedback(
  result: ConstructionPermitVisionAuditResult,
  permitLabel: string,
  referenceDate?: Date,
): string {
  const expiryDate = result.expiryDate || null;
  const expired = Boolean(
    expiryDate &&
    referenceDate &&
    getShanghaiDateKeyTime(expiryDate) <
      getShanghaiDateKeyTime(formatShanghaiDateKey(referenceDate)),
  );
  const conclusion = expired
    ? '需人工复核'
    : normalizeVisionAuditResultLabel(result.result);
  const issues = result.issues
    .map((item) => normalizeOptionalText(item))
    .filter((item): item is string => Boolean(item && !/^无$/.test(item)));
  const issueText = buildConstructionPermitCompactIssueText(
    issues,
    expiryDate,
    expired,
  );

  return `结论：${conclusion}；分组：${permitLabel}；问题：${issueText}`;
}

function buildConstructionPermitCompactIssueText(
  issues: readonly string[],
  expiryDate: string | null,
  expired: boolean,
): string {
  if (expired && expiryDate) {
    return `有效期至 ${expiryDate}，已过期，需今日人工审核`;
  }
  const issueText = issues.length ? issues.join('、') : '无';
  if (!expiryDate) {
    return issueText;
  }
  return `${issueText}（有效期至 ${expiryDate}）`;
}

function isConstructionApplicationPermitLabel(permitLabel: string): boolean {
  return /施工(?:作业)?申请|施工作业申请|施工申请作业/.test(permitLabel);
}

function isConstructionRiskDisclosureLabel(permitLabel: string): boolean {
  return /风险交底/.test(permitLabel);
}

function formatConstructionApplicationCompactFeedback(
  result: ConstructionPermitVisionAuditResult,
): string {
  const conclusion = normalizeVisionAuditResultLabel(result.result);
  const rawItems = result.issues.length
    ? result.issues
    : result.suggestions.length
      ? result.suggestions
      : [result.summary];
  const items = buildConstructionApplicationCompactItems(
    rawItems,
    result.expiryDate,
  );
  return [
    `结论：${conclusion}`,
    ...items.map((item, index) => `${index + 1}. ${item}`),
  ].join('；');
}

function buildConstructionApplicationCompactItems(
  values: readonly string[],
  expiryDate: string | null,
): string[] {
  const byKey = new Map<string, string>();

  for (const value of values) {
    const normalized = normalizeOptionalText(value)
      ?.replace(/^问题[:：]\s*/, '')
      .replace(/^建议[:：]\s*/, '')
      .replace(/^结论[:：][^；;\n\r]*[；;\n\r]*/, '')
      .trim();
    if (!normalized || /^无$|^无明显问题$/.test(normalized)) {
      continue;
    }

    const focusedMatches = normalized.match(
      /(?:完整性|填充|填写|人员|施工人员|有效期|期限|日期)[:：][^；;。]+/g,
    );
    const fragments =
      focusedMatches && focusedMatches.length > 0
        ? focusedMatches
        : normalized
            .split(/[；;。]|[，,](?!\d)|、/)
            .map((item) => item.trim())
            .filter(Boolean);
    for (const fragment of fragments.length ? fragments : [normalized]) {
      const compact = compactConstructionApplicationItem(fragment, expiryDate);
      const key = compact.split('：')[0];
      if (!key || byKey.has(key)) {
        continue;
      }
      byKey.set(key, compact);
    }
  }

  const items = [
    byKey.get('填写') || '填写：待核',
    byKey.get('人员') || '人员：作业人数待核，身份证待核',
    byKey.get('有效期') ||
      (expiryDate ? `有效期：至${expiryDate}` : '有效期：未识别'),
  ];
  return items.map((item) =>
    item.length <= 30 ? item : `${item.slice(0, 29)}…`,
  );
}

function compactConstructionApplicationItem(
  value: string,
  expiryDate: string | null,
): string {
  const normalized = normalizeOptionalText(value)
    ?.replace(/\s+/g, '')
    .replace(/^当前/, '')
    .replace(/[；;，,、。]+$/g, '')
    .trim();
  if (!normalized) {
    return '';
  }

  if (/^(完整性|填充|填写)[:：]/.test(normalized)) {
    const content = normalized.replace(/^(完整性|填充|填写)[:：]/, '');
    return compactConstructionApplicationFillingItem(content);
  }
  if (/^(人员|施工人员)[:：]/.test(normalized)) {
    const content = normalized.replace(/^(人员|施工人员)[:：]/, '');
    return compactConstructionApplicationPersonnelItem(content);
  }
  if (
    /^(有效期|期限|日期)[:：]/.test(normalized) ||
    /有效期|截止|至/.test(normalized)
  ) {
    const date =
      parseConstructionPermitDate(
        /\d{4}[-./年]\d{1,2}[-./月]\d{1,2}/.exec(normalized)?.[0] || null,
      ) || expiryDate;
    return date ? `有效期：至${date}` : '有效期：未识别';
  }
  if (/完整|缺少|未填|空白/.test(normalized)) {
    return compactConstructionApplicationFillingItem(normalized);
  }
  if (/台账|身份证|证件|名单|姓名/.test(normalized)) {
    return compactConstructionApplicationPersonnelItem(
      normalized.replace(/^人员/, ''),
    );
  }
  return compactConstructionApplicationFillingItem(normalized);
}

function compactConstructionApplicationFillingItem(value: string): string {
  const content = normalizeConstructionApplicationFindingText(value);
  if (!content) {
    return '填写：待核';
  }
  if (
    /^(完整|完整填写|填写完整|关键项完整|关键项可见|可见|齐全|已填|已填写)$/.test(
      content,
    )
  ) {
    return '填写：关键项可见';
  }
  if (
    /施工项目|作业内容|区域|施工单位|作业类型|计划时间|申请|审批|签字/.test(
      content,
    ) &&
    /可见|完整|齐全|已填|已填写/.test(content)
  ) {
    return '填写：关键项可见';
  }
  if (/^作业内容$/.test(content)) {
    return '填写：作业内容待核';
  }
  if (
    /^施工项目$|^作业项目$|^区域$|^作业地点$|^施工单位$|^作业单位$|^作业类型$|^计划时间$|^作业日期$|^审批$|^签字$|^材料堆放点$/.test(
      content,
    )
  ) {
    return `填写：${content}待核`;
  }
  const explicitMissingFields = /^缺少(.+)/.exec(content)?.[1] || '';
  if (explicitMissingFields) {
    return `填写：缺少${explicitMissingFields}`;
  }
  if (/缺少|未填|未填写|空白|不完整/.test(content)) {
    const field =
      /(作业内容|作业项目|施工项目|区域|施工区域|作业地点|施工单位|作业单位|作业类型|计划时间|作业日期|材料堆放点|审批|签字)/.exec(
        content,
      )?.[1] || '';
    return field ? `填写：缺少${field}` : '填写：不完整';
  }
  if (/需人工核验|人工核验|待核|无法确认|看不清/.test(content)) {
    return '填写：待核';
  }
  return `填写：${content}`;
}

function compactConstructionApplicationPersonnelItem(value: string): string {
  const content = normalizeConstructionApplicationFindingText(value)
    .replace(/^施工人员/, '')
    .replace(/^签字处/, '')
    .trim();
  if (!content) {
    return '人员：作业人数待核，身份证待核';
  }
  if (/需核对台账|核对台账|台账/.test(content)) {
    return '人员：需核对台账';
  }

  const count = extractConstructionApplicationWorkerCount(content);
  const countText = count ? `作业人数疑似${count}人` : '作业人数待核';
  const idText = getConstructionApplicationIdStatus(content);
  return `人员：${countText}，${idText}`;
}

function extractConstructionApplicationWorkerCount(
  value: string,
): string | null {
  const content = normalizeConstructionApplicationFindingText(value).replace(
    /\s+/g,
    '',
  );
  if (!content) {
    return null;
  }

  const explicitCountPatterns = [
    /(?:作业|施工|申请|计划|预计|入场)(?:人员)?人数(?:疑似|约|为|是|[:：])?(\d+)人/,
    /(?:作业|施工|申请|计划|预计|入场)人员(?:共|疑似|约|为|是|[:：])?(\d+)人/,
    /人员名单(?:共|疑似|约|为|是|[:：])?(\d+)人/,
    /名单(?:共|疑似|约|为|是|[:：])?(\d+)人/,
  ];
  for (const pattern of explicitCountPatterns) {
    const match = pattern.exec(content);
    if (match?.[1]) {
      return match[1];
    }
  }

  if (/签名|签字|签署|审批|负责人|EHS|FM|监护人/.test(content)) {
    return null;
  }

  return (
    /疑似(\d+)人/.exec(content)?.[1] ||
    /共?(\d+)人/.exec(content)?.[1] ||
    /(\d+)人/.exec(content)?.[1] ||
    null
  );
}

function getConstructionApplicationIdStatus(value: string): string {
  if (!/身份证|证件|证号|号码/.test(value)) {
    return '身份证待核';
  }
  if (/模糊|看不清|不清|无法识别|辨认不清/.test(value)) {
    return '身份证模糊';
  }
  if (/缺失|未填|未填写|空白|不完整/.test(value)) {
    return '身份证缺失';
  }
  if (/不一致|错误|不符|不正确/.test(value)) {
    return '身份证不符';
  }
  if (/完整|正确|一致|已填|填写完整/.test(value)) {
    return '身份证完整';
  }
  return '身份证待核';
}

function normalizeConstructionApplicationFindingText(value: string): string {
  return (
    normalizeOptionalText(value)
      ?.replace(/^(但|且|并且|其中|显示|可见)[:：]?/, '')
      .replace(/^施工人员/, '人员')
      .replace(/[；;，,、。]+$/g, '')
      .trim() || ''
  );
}

export function buildConstructionTrainingAssessmentAuditFeedback(input: {
  signInPersonCount?: number | null;
  assessmentFileCount: number;
}): string | null {
  const assessmentFileCount = Math.max(
    0,
    Math.floor(Number(input.assessmentFileCount) || 0),
  );
  if (assessmentFileCount <= 0) {
    return null;
  }

  const signInPersonCount = normalizeTrainingAssessmentCount(
    input.signInPersonCount,
  );
  const conclusion =
    signInPersonCount === null
      ? '需人工复核'
      : signInPersonCount === assessmentFileCount
        ? '通过'
        : '不通过';
  const personItem =
    signInPersonCount === null
      ? '人数：签到人数待核'
      : `人数：签到疑似${signInPersonCount}人`;
  const fileItem = `文件：考核${assessmentFileCount}份`;
  const matchItem =
    signInPersonCount === null
      ? '匹配：待核'
      : signInPersonCount === assessmentFileCount
        ? '匹配：一致'
        : signInPersonCount > assessmentFileCount
          ? `匹配：缺${signInPersonCount - assessmentFileCount}份`
          : `匹配：多${assessmentFileCount - signInPersonCount}份`;

  return [`结论：${conclusion}`, personItem, fileItem, matchItem]
    .map((item, index) => (index === 0 ? item : `${index}. ${item}`))
    .join('；');
}

function normalizeTrainingAssessmentCount(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const count = Math.floor(Number(value));
  return Number.isFinite(count) && count >= 0 ? count : null;
}

export function inferConstructionTrainingSignInPersonCountFromFiles(
  files: readonly ConstructionUploadFile[] = [],
): number | null {
  const counts = files
    .map((file) => inferConstructionTrainingSignInPersonCountFromFile(file))
    .filter((count): count is number => count !== null);
  if (counts.length === 0) {
    return null;
  }
  return Math.max(...counts);
}

function inferConstructionTrainingSignInPersonCountFromFile(
  file: ConstructionUploadFile,
): number | null {
  const fileName = normalizeConstructionUploadFileName(file.originalname);
  const mimeType = String(file.mimetype || '').toLowerCase();
  const isWorkbook =
    /\.(?:xlsx|xls|csv)$/i.test(fileName) ||
    /spreadsheet|excel|csv/.test(mimeType);
  if (!isWorkbook || !file.buffer?.length) {
    return null;
  }

  try {
    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const sheet = sheetName ? workbook.Sheets[sheetName] : null;
    if (!sheet) {
      return null;
    }
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      blankrows: false,
      raw: false,
    });
    return countTrainingSignInRows(rows);
  } catch {
    return null;
  }
}

function countTrainingSignInRows(rows: readonly unknown[][]): number | null {
  const normalizedRows = rows
    .map((row) =>
      row
        .map((cell) => String(cell ?? '').trim())
        .filter((cell) => cell.length > 0),
    )
    .filter((row) => row.length > 0);
  if (normalizedRows.length === 0) {
    return null;
  }

  const headerIndex = normalizedRows.findIndex((row, index) => {
    if (index > 10) {
      return false;
    }
    const text = row.join('');
    return /姓名|人员|签字|签名|序号/.test(text);
  });
  const candidateRows =
    headerIndex >= 0
      ? normalizedRows.slice(headerIndex + 1)
      : normalizedRows.slice(1);
  const count = candidateRows.filter((row) => {
    const text = row.join('');
    if (!text || /合计|备注|说明|培训人|讲师|负责人|日期|时间/.test(text)) {
      return false;
    }
    return /[\u3400-\u9fffA-Za-z]/.test(text);
  }).length;

  return count > 0 ? count : null;
}

export function buildConstructionTrainingSignInCountVisionPayload(
  files: ConstructionUploadFile[],
  model: string,
  options: { disableThinking?: boolean } = {},
) {
  const fileNameLine = files
    .map((file) => normalizeConstructionUploadFileName(file.originalname))
    .filter(Boolean)
    .map((fileName) => `附件名称：${fileName}`)
    .join('\n');
  const imageContents = files
    .filter(isConstructionImageUploadFile)
    .slice(0, 4)
    .map((file) => ({
      type: 'image_url' as const,
      image_url: {
        url: `data:${getConstructionImageUploadMimeType(file)};base64,${file.buffer.toString('base64')}`,
      },
    }));

  return {
    model,
    temperature: 0,
    response_format: { type: 'json_object' },
    stream: false,
    ...(options.disableThinking ? { thinking: { type: 'disabled' } } : {}),
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text' as const,
            text: [
              '请只统计“入场培训签到表”中实际签到/签名人员数量。',
              '只数人员行，不要把标题、培训人、讲师、负责人、日期、备注、合计行算入人数。',
              '人数不确定时 signInPersonCount 返回 null；不要猜测。',
              fileNameLine,
              '请返回严格 JSON，不要输出 Markdown。结构：',
              '{"signInPersonCount":5,"summary":"一句话依据"}',
            ]
              .filter(Boolean)
              .join('\n'),
          },
          ...imageContents,
        ],
      },
    ],
  };
}

export function parseConstructionTrainingSignInCountVisionResponse(
  content: string,
): number | null {
  const normalized = extractJsonObjectText(content);
  const parsed = JSON.parse(normalized) as Record<string, unknown>;
  return normalizeTrainingAssessmentCount(parsed.signInPersonCount);
}

function formatConstructionRiskDisclosureCompactFeedback(
  result: ConstructionPermitVisionAuditResult,
): string {
  const conclusion = normalizeVisionAuditResultLabel(result.result);
  const rawItems = result.issues.length
    ? result.issues
    : result.suggestions.length
      ? result.suggestions
      : [result.summary];
  const items = buildConstructionRiskDisclosureCompactItems(rawItems);

  return [
    `结论：${conclusion}`,
    ...items.map((item, index) => `${index + 1}. ${item}`),
  ].join('；');
}

function buildConstructionRiskDisclosureCompactItems(
  values: readonly string[],
): string[] {
  const byKey = new Map<string, string>();

  for (const value of values) {
    const normalized = normalizeOptionalText(value)
      ?.replace(/^问题[:：]\s*/, '')
      .replace(/^建议[:：]\s*/, '')
      .replace(/^结论[:：][^；;\n\r]*[；;\n\r]*/, '')
      .trim();
    if (!normalized || /^无$|^无明显问题$/.test(normalized)) {
      continue;
    }

    const focusedMatches = normalized.match(
      /(?:填写|完整性|人员|签字|日期|时间)[:：][^；;。]+/g,
    );
    const fragments =
      focusedMatches && focusedMatches.length > 0
        ? focusedMatches
        : normalized
            .split(/[；;。]|[，,](?!\d)|、/)
            .map((item) => item.trim())
            .filter(Boolean);
    for (const fragment of fragments.length ? fragments : [normalized]) {
      const compact = compactConstructionRiskDisclosureItem(fragment);
      const key = compact.split('：')[0];
      if (!key || byKey.has(key)) {
        continue;
      }
      byKey.set(key, compact);
    }
  }

  return [
    byKey.get('填写') || '填写：待核',
    byKey.get('人员') || '人员：待核',
    byKey.get('日期') || '日期：待核',
  ].map((item) => (item.length <= 30 ? item : `${item.slice(0, 29)}…`));
}

function compactConstructionRiskDisclosureItem(value: string): string {
  const normalized = normalizeOptionalText(value)
    ?.replace(/\s+/g, '')
    .replace(/^当前/, '')
    .replace(/[；;，,、。]+$/g, '')
    .trim();
  if (!normalized) {
    return '';
  }

  if (/^(填写|完整性)[:：]/.test(normalized)) {
    const content = normalized.replace(/^(填写|完整性)[:：]/, '');
    if (/缺少|未填|未填写|空白|不完整/.test(content)) {
      const field =
        /(风险识别|防范措施|应急措施|注意事项|负责人承诺|作业单位|许可范围|环境|签字|日期)/.exec(
          content,
        )?.[1] || '';
      return field ? `填写：缺少${field}` : '填写：不完整';
    }
    if (/可见|完整|齐全|已填|已填写/.test(content)) {
      return '填写：关键项可见';
    }
    if (/待核|无法确认|看不清/.test(content)) {
      return '填写：待核';
    }
    return `填写：${content}`;
  }

  if (/^(人员|签字)[:：]/.test(normalized)) {
    const content = normalized.replace(/^(人员|签字)[:：]/, '');
    const count =
      /疑似(\d+)人/.exec(content)?.[1] ||
      /(\d+)人/.exec(content)?.[1] ||
      /(\d+)个?签名/.exec(content)?.[1];
    if (count) {
      return `人员：疑似${count}人`;
    }
    if (/全员|均已|已签|签字完整/.test(content)) {
      return '人员：全员签字';
    }
    return '人员：待核';
  }

  if (
    /^(日期|时间)[:：]/.test(normalized) ||
    /交底|签字日期|作业/.test(normalized)
  ) {
    if (/晚于/.test(normalized)) {
      return '日期：交底晚于作业';
    }
    if (/早于|等于|不晚于|早于或等于/.test(normalized)) {
      return '日期：交底早于作业';
    }
    if (/一致|相同/.test(normalized)) {
      return '日期：签字日期一致';
    }
    return '日期：待核';
  }

  if (/风险识别|防范措施|应急措施|注意事项|负责人承诺/.test(normalized)) {
    return compactConstructionRiskDisclosureItem(`填写：${normalized}`);
  }
  return compactConstructionRiskDisclosureItem(`填写：${normalized}`);
}

function formatConstructionDocumentCompactFeedback(
  result: ConstructionPermitVisionAuditResult,
  _permitLabel: string,
): string {
  const conclusion = normalizeVisionAuditResultLabel(result.result);
  const rawItems = result.issues.length
    ? result.issues
    : result.suggestions.length
      ? result.suggestions
      : [result.summary];
  const items = buildConstructionDocumentCompactItems(rawItems);
  const displayItems = items.length ? items : ['无明显问题'];

  return [
    `结论：${conclusion}`,
    ...displayItems.map((item, index) => `${index + 1}. ${item}`),
  ].join('；');
}

function buildConstructionDocumentCompactItems(
  values: readonly string[],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const normalized = normalizeOptionalText(value)
      ?.replace(/^问题[:：]\s*/, '')
      .replace(/^建议[:：]\s*/, '')
      .replace(/^结论[:：][^；;\n\r]*[；;\n\r]*/, '')
      .trim();
    if (!normalized || /^无$|^无明显问题$/.test(normalized)) {
      continue;
    }

    const focusedMatches = normalized.match(
      /(?:人员|签字|日期)[:：][^；;。]+/g,
    );
    const fragments =
      focusedMatches && focusedMatches.length > 0
        ? focusedMatches
        : normalized
            .split(/[；;。]|[，,](?!\d)|、/)
            .map((item) => item.trim())
            .filter(Boolean);
    for (const fragment of fragments.length ? fragments : [normalized]) {
      const compact = compactConstructionAuditItem(fragment);
      if (!compact || seen.has(compact)) {
        continue;
      }
      if (isDuplicateSafetyNoticeSignatureCount(compact, result)) {
        continue;
      }
      seen.add(compact);
      result.push(compact);
      if (result.length >= 3) {
        return result;
      }
    }
  }

  return result;
}

function isDuplicateSafetyNoticeSignatureCount(
  value: string,
  previousItems: readonly string[],
): boolean {
  if (!/^签字[:：]/.test(value)) {
    return false;
  }
  const signatureCount = extractSafetyNoticeSuspectedCount(value);
  if (!signatureCount) {
    return false;
  }
  return previousItems.some(
    (item) => extractSafetyNoticeSuspectedCount(item) === signatureCount,
  );
}

function extractSafetyNoticeSuspectedCount(value: string): string | null {
  return /疑似(\d+)人/.exec(value)?.[1] || null;
}

function compactConstructionAuditItem(value: string): string {
  const normalized = normalizeOptionalText(value)
    ?.replace(/^附件(文件)?/, '')
    .replace(/^当前/, '')
    .replace(/\s+/g, '')
    .trim();
  const compact = compactSafetyNoticeFocusedItem(normalized || '');
  if (!compact) {
    return '';
  }
  if (/^日期[:：]/.test(compact)) {
    return compact;
  }
  if (compact.length <= 30) {
    return compact;
  }
  return `${compact.slice(0, 29)}…`;
}

function compactSafetyNoticeFocusedItem(value: string): string {
  if (!value) {
    return '';
  }

  const visibleSignatureCount =
    /仅见(\d+)个?签名/.exec(value)?.[1] ||
    /见(\d+)个?签名/.exec(value)?.[1] ||
    /签字(\d+)人/.exec(value)?.[1] ||
    /仅?(\d+)人签字/.exec(value)?.[1] ||
    /(\d+)人手写签名/.exec(value)?.[1] ||
    /(\d+)人签名/.exec(value)?.[1];

  if (/^人员[:：]/.test(value)) {
    const suspectedPersonCount =
      visibleSignatureCount ||
      /至少(\d+)人/.exec(value)?.[1] ||
      /(\d+)人/.exec(value)?.[1];
    if (suspectedPersonCount) {
      return `人员：疑似${suspectedPersonCount}人`;
    }
    if (/无法确认|待核/.test(value)) {
      return '人员：待核';
    }
  }

  if (/^签字[:：]/.test(value)) {
    if (/无安全告知书签字页|未见签字/.test(value)) {
      return '签字：未见签字页';
    }
    if (visibleSignatureCount) {
      return `签字：疑似${visibleSignatureCount}人签字`;
    }
    if (/无法确认|待核/.test(value)) {
      return '签字：待核';
    }
    return value
      .replace(/但?未明确[^；;，,、。]*/g, '')
      .replace(/身份[^；;，,、。]*/g, '')
      .replace(/[；;，,、。]+$/g, '');
  }

  if (/^日期[:：]/.test(value)) {
    return compactSafetyNoticeDateItem(value);
  }

  return value;
}

function compactSafetyNoticeDateItem(value: string): string {
  const normalized = value
    .replace(/签字日期(为|是)?/g, '签字')
    .replace(/施工计划开始时间/g, '计划')
    .replace(/施工计划开始/g, '计划')
    .replace(/早于计划时间/g, '早于计划')
    .replace(/晚于计划时间/g, '晚于计划')
    .replace(/日期[:：]签字/g, '日期：签字')
    .replace(/[；;，,、。]+$/g, '');
  const firstDate =
    /签字(\d{4}[-./年]\d{1,2}[-./月]\d{1,2})/.exec(normalized)?.[1] ||
    /(\d{4}[-./年]\d{1,2}[-./月]\d{1,2})/.exec(normalized)?.[1];
  const comparison = /晚于/.test(normalized)
    ? '晚于'
    : /早于/.test(normalized)
      ? '早于'
      : '';
  const planDateMatches = [
    ...normalized.matchAll(/\d{4}[-./年]\d{1,2}[-./月]\d{1,2}/g),
  ].map((match) => match[0]);
  const planDate = planDateMatches.find((item) => item !== firstDate);
  const normalizedFirstDate = parseConstructionPermitDate(firstDate || null);
  const normalizedPlanDate = parseConstructionPermitDate(planDate || null);
  const actualComparison =
    normalizedFirstDate && normalizedPlanDate
      ? getShanghaiDateKeyTime(normalizedFirstDate) >
        getShanghaiDateKeyTime(normalizedPlanDate)
        ? '晚于'
        : getShanghaiDateKeyTime(normalizedFirstDate) <
            getShanghaiDateKeyTime(normalizedPlanDate)
          ? '早于'
          : '等于'
      : comparison;

  if (normalizedFirstDate && actualComparison && normalizedPlanDate) {
    return `日期：签字${normalizedFirstDate}${actualComparison}计划${normalizedPlanDate}`;
  }
  if (firstDate && actualComparison) {
    return `日期：签字${firstDate}${actualComparison}计划`;
  }
  return normalized;
}

function inferConstructionPermitExpiryDateFromFiles(
  files: readonly ConstructionUploadFile[],
  referenceDate: Date,
): string | null {
  return inferConstructionPermitExpiryDateFromText(
    getConstructionPermitSourceTextFromFiles(files),
    referenceDate,
  );
}

function getConstructionPermitSourceTextFromFiles(
  files: readonly ConstructionUploadFile[],
): string {
  return files
    .flatMap((file) => [
      normalizeConstructionUploadFileName(file.originalname),
      extractConstructionPermitTextFromUploadFile(file),
    ])
    .filter(Boolean)
    .join('；');
}

function inferConstructionPermitExpiryDateFromText(
  sourceText: string,
  referenceDate: Date,
): string | null {
  if (!sourceText) {
    return null;
  }
  const referenceYear = formatShanghaiDateKey(referenceDate).slice(0, 4);
  return normalizeConstructionPermitExpiryDate(null, [
    `默认年份${referenceYear}`,
    sourceText,
  ]);
}

function extractConstructionPermitTextFromUploadFile(
  file: ConstructionUploadFile,
): string {
  const fileName = normalizeConstructionUploadFileName(file.originalname);
  const mimeType = String(file.mimetype || '').toLowerCase();
  const textLike =
    /(?:text|html|xml|msword)/i.test(mimeType) ||
    /\.(?:doc|html?|txt)$/i.test(fileName);
  if (!textLike || !file.buffer?.length) {
    return '';
  }

  const rawText = file.buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (!/[<\u4e00-\u9fff]/.test(rawText)) {
    return '';
  }
  return normalizeConstructionPermitDocumentText(rawText);
}

function normalizeConstructionPermitDocumentText(value: string): string {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000);
}

function escapeRegExp(value: string): string {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractConstructionPermitFeedbackExpiryDate(
  feedback: string | null | undefined,
): string | null {
  const text = normalizeOptionalText(feedback);
  if (!text || /有效期至[:：]\s*未识别/.test(text)) {
    return null;
  }

  const directMatch = /有效期至[:：]?\s*([^；;、,\n\r)）]+)/.exec(text);
  return normalizeConstructionPermitExpiryDate(directMatch?.[1], [text]);
}

export function buildConstructionPermitManualReviewFingerprint(
  files: ReadonlyArray<
    | Pick<ConstructionAttachmentFile, 'fileToken'>
    | { file_token?: unknown; fileToken?: unknown }
  >,
  expiryDate?: string | null,
  source: 'ai' | 'manual' = 'ai',
  validFrom?: string | null,
): string | null {
  const tokens = files
    .map((file) =>
      String(
        (file as { fileToken?: unknown }).fileToken ||
          (file as { file_token?: unknown }).file_token ||
          '',
      ).trim(),
    )
    .filter(Boolean)
    .sort();
  const normalizedExpiry = String(expiryDate || '').trim();
  const normalizedValidFrom = String(validFrom || '').trim();
  if (tokens.length === 0 && !normalizedExpiry) {
    return null;
  }
  if (source === 'manual' && normalizedExpiry && normalizedValidFrom) {
    const fingerprint = hashConstructionPermitManualReviewBasis(
      JSON.stringify({
        tokens,
        validFrom: normalizedValidFrom,
        expiry: normalizedExpiry,
      }),
    );
    return `v3:${normalizedValidFrom}:${normalizedExpiry}:${fingerprint}`;
  }
  const fingerprint = hashConstructionPermitManualReviewBasis(
    JSON.stringify({ tokens, expiry: normalizedExpiry }),
  );
  return source === 'manual' && normalizedExpiry
    ? `v2:${normalizedExpiry}:${fingerprint}`
    : `v1:${fingerprint}`;
}

export function extractConstructionPermitManualReviewValidityRange(
  fingerprint: string | null | undefined,
): {
  validFrom: string | null;
  validUntil: string | null;
} {
  const normalized = String(fingerprint || '').trim();
  const rangeMatch =
    /^v3:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2}):[a-z0-9]+$/i.exec(
      normalized,
    );
  if (rangeMatch) {
    const validFrom = normalizeConstructionPermitExpiryDate(rangeMatch[1]);
    const validUntil = normalizeConstructionPermitExpiryDate(rangeMatch[2]);
    if (validFrom && validUntil && validFrom <= validUntil) {
      return { validFrom, validUntil };
    }
    return { validFrom: null, validUntil: null };
  }

  const legacyMatch = /^v2:(\d{4}-\d{2}-\d{2}):[a-z0-9]+$/i.exec(normalized);
  return {
    validFrom: null,
    validUntil: legacyMatch
      ? normalizeConstructionPermitExpiryDate(legacyMatch[1])
      : null,
  };
}

export function buildConstructionPermitManualReviewAutoApprovalFields(
  fields: Record<string, unknown>,
  accessRole: AccessRole,
  permitValidUntilByFileKey: Readonly<Record<string, string>> = {},
  changedPermitFileKeys: readonly string[] = Object.keys(
    permitValidUntilByFileKey,
  ),
  permitValidFromByFileKey: Readonly<Record<string, string>> = {},
): Record<string, unknown> {
  if (!isConstructionManualReviewAutoApprovalRole(accessRole)) {
    return {};
  }

  const changedKeys = new Set(changedPermitFileKeys);
  const approvedFields: Record<string, unknown> = {};
  Object.entries(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS).forEach(
    ([fileKey, config]) => {
      if (!changedKeys.has(fileKey)) {
        return;
      }
      const validUntil = String(
        permitValidUntilByFileKey[fileKey] || '',
      ).trim();
      const validFrom = String(
        permitValidFromByFileKey[fileKey] || '',
      ).trim();
      if (!isValidConstructionPermitValidityDate(validUntil)) {
        return;
      }
      if (
        validFrom &&
        (!isValidConstructionPermitValidityDate(validFrom) ||
          validFrom > validUntil)
      ) {
        return;
      }
      const attachmentField = CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[fileKey];
      const files = normalizeConstructionAttachmentFieldValue(
        fields[attachmentField],
      );
      if (files.length === 0) {
        return;
      }

      const fingerprint = buildConstructionPermitManualReviewFingerprint(
        files,
        validUntil,
        'manual',
        validFrom,
      );
      approvedFields[config.reviewField] = '通过';
      if (fingerprint) {
        approvedFields[config.fingerprintField] = fingerprint;
      }
    },
  );
  return approvedFields;
}

export function extractConstructionPermitManualReviewValidityDate(
  fingerprint: string | null | undefined,
): string | null {
  return extractConstructionPermitManualReviewValidityRange(fingerprint)
    .validUntil;
}

export function buildConstructionPermitManualReviewResetFields(
  uploadedFields: Record<string, Array<{ file_token: string }>>,
  permitAuditFields: Record<string, string>,
  changedPermitFileKeys: readonly string[],
): Record<string, unknown> {
  const changedKeys = new Set(changedPermitFileKeys);
  const resetFields: Record<string, unknown> = {};

  Object.entries(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS).forEach(
    ([fileKey, config]) => {
      if (!changedKeys.has(fileKey)) {
        return;
      }
      const attachmentField = CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[fileKey];
      const auditField =
        CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS[fileKey]?.feedbackField;
      const uploadedFiles = uploadedFields[attachmentField] || [];
      const feedback = auditField ? permitAuditFields[auditField] : null;
      const fingerprint = buildConstructionPermitManualReviewFingerprint(
        uploadedFiles,
        extractConstructionPermitFeedbackExpiryDate(feedback),
      );

      resetFields[config.reviewField] = null;
      if (fingerprint) {
        resetFields[config.fingerprintField] = fingerprint;
      }
    },
  );

  return resetFields;
}

export const CONSTRUCTION_PERMIT_MANUAL_REVIEW_WORKFLOW_FILE_KEYS = [
  'temporaryPowerPermitFiles',
  'hotWorkPermitFiles',
] as const;

export function isConstructionPermitManualReviewWorkflowFileKey(
  fileKey: string,
): fileKey is (typeof CONSTRUCTION_PERMIT_MANUAL_REVIEW_WORKFLOW_FILE_KEYS)[number] {
  return CONSTRUCTION_PERMIT_MANUAL_REVIEW_WORKFLOW_FILE_KEYS.includes(
    fileKey as (typeof CONSTRUCTION_PERMIT_MANUAL_REVIEW_WORKFLOW_FILE_KEYS)[number],
  );
}

export function normalizeConstructionAttachmentFieldValue(
  value: unknown,
): Array<{ file_token: string }> {
  return extractConstructionAttachmentTokens(value).map((fileToken) => ({
    file_token: fileToken,
  }));
}

export function buildConstructionPermitManualReviewWorkflowFields(
  existingFields: Record<string, unknown>,
  fileKey: string,
): {
  attachmentField: string;
  reviewField: string;
  fingerprintField: string;
  fields: Record<string, unknown>;
} | null {
  if (!isConstructionPermitManualReviewWorkflowFileKey(fileKey)) {
    return null;
  }
  const attachmentField = CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS[fileKey];
  const config = CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS[fileKey];
  const feedbackField =
    CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS[fileKey]?.feedbackField;
  const feedbackValue = feedbackField ? existingFields[feedbackField] : null;
  const files = normalizeConstructionAttachmentFieldValue(
    existingFields[attachmentField],
  );
  const fingerprint = buildConstructionPermitManualReviewFingerprint(
    files,
    extractConstructionPermitFeedbackExpiryDate(
      typeof feedbackValue === 'string' ? feedbackValue : null,
    ),
  );
  const fields: Record<string, unknown> = {
    [attachmentField]: files,
    [config.reviewField]: false,
  };
  if (fingerprint) {
    fields[config.fingerprintField] = fingerprint;
  }
  return {
    attachmentField,
    reviewField: config.reviewField,
    fingerprintField: config.fingerprintField,
    fields,
  };
}

function hashConstructionPermitManualReviewBasis(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function buildDailyPermitAuditFeedbackWithDate(
  feedback: string,
  _referenceDate: Date = new Date(),
): string {
  const normalized = String(feedback || '').trim();
  if (!normalized) {
    return '';
  }

  const stripped = normalized
    .replace(
      new RegExp(
        `^${DAILY_PERMIT_AUDIT_DATE_LABEL}[:：]\\s*\\d{4}-\\d{2}-\\d{2}[；;，,、\\s]*`,
      ),
      '',
    )
    .replace(
      new RegExp(
        `^${DAILY_PERMIT_AUDIT_VERSION_LABEL}[:：]\\s*\\d+[；;，,、\\s]*`,
      ),
      '',
    )
    .trim();
  return stripped;
}

export function shouldRefreshDailyPermitAuditFeedback(
  feedback: string | null | undefined,
  referenceDate: Date = new Date(),
): boolean {
  const text = String(feedback || '').trim();
  if (!text) {
    return true;
  }

  const match = new RegExp(
    `${DAILY_PERMIT_AUDIT_DATE_LABEL}[:：]\\s*(\\d{4}-\\d{2}-\\d{2})`,
  ).exec(text);
  const versionMatch = new RegExp(
    `${DAILY_PERMIT_AUDIT_VERSION_LABEL}[:：]\\s*(\\d+)`,
  ).exec(text);
  if (match || versionMatch) {
    if (match?.[1] !== formatShanghaiDateKey(referenceDate)) {
      return true;
    }
    return versionMatch?.[1] !== DAILY_PERMIT_AUDIT_VERSION;
  }

  const expiryDate = extractConstructionPermitFeedbackExpiryDate(text);
  if (!expiryDate) {
    return true;
  }

  const expired =
    getShanghaiDateKeyTime(expiryDate) <
    getShanghaiDateKeyTime(formatShanghaiDateKey(referenceDate));
  if (!expired && /已过期|有效期已过期/.test(text)) {
    return true;
  }
  if (expired) {
    return !(
      /结论[:：]\s*(需人工复核|不通过)/.test(text) && /已过期/.test(text)
    );
  }

  return false;
}

export function mergeConstructionAttachmentFieldValues(
  existingFields: Record<string, unknown>,
  uploadedFields: Record<string, Array<{ file_token: string }>>,
): Record<string, Array<{ file_token: string }>> {
  return Object.fromEntries(
    Object.entries(uploadedFields).map(([fieldName, uploaded]) => {
      const existingTokens = extractConstructionAttachmentTokens(
        existingFields[fieldName],
      );
      const tokens = [...existingTokens];
      uploaded.forEach((file) => {
        if (file.file_token && !tokens.includes(file.file_token)) {
          tokens.push(file.file_token);
        }
      });
      return [
        fieldName,
        tokens.map((fileToken) => ({ file_token: fileToken })),
      ];
    }),
  );
}

export function filterChangedConstructionUploadFiles(
  files: readonly ConstructionUploadFile[] = [],
  existingFields: Record<string, unknown> = {},
  fieldMap: Record<string, string>,
): ConstructionUploadFile[] {
  void existingFields;
  void fieldMap;
  return [...files];
}

export async function filterChangedConstructionUploadFilesByContent(
  files: readonly ConstructionUploadFile[] = [],
  existingFields: Record<string, unknown> = {},
  fieldMap: Record<string, string>,
  downloadExistingAttachment: (
    fileToken: string,
    tmpUrl?: string | null,
  ) => Promise<Buffer | null>,
): Promise<ConstructionUploadFile[]> {
  const changedFiles: ConstructionUploadFile[] = [];
  for (const file of files) {
    const fieldName = fieldMap[file.fieldname];
    if (!fieldName) {
      changedFiles.push(file);
      continue;
    }

    const candidates = getComparableConstructionAttachments(
      existingFields[fieldName],
      file,
    );
    if (candidates.length === 0) {
      changedFiles.push(file);
      continue;
    }

    const currentHash = getConstructionUploadFileHash(file);
    let unchanged = false;
    for (const candidate of candidates) {
      try {
        const existingBuffer = await downloadExistingAttachment(
          candidate.fileToken,
          candidate.tmpUrl,
        );
        if (existingBuffer && getBufferHash(existingBuffer) === currentHash) {
          unchanged = true;
          break;
        }
      } catch {
        // Download failures are handled conservatively by treating the upload as changed.
      }
    }

    if (!unchanged) {
      changedFiles.push(file);
    }
  }
  return changedFiles;
}

export function omitUnchangedConstructionFieldValues(
  fields: Record<string, unknown>,
  existingFields: Record<string, unknown> = {},
  fieldNames: readonly string[] = CONSTRUCTION_FEEDBACK_FIELD_NAMES,
): Record<string, unknown> {
  const comparableFields = new Set(fieldNames);
  return Object.fromEntries(
    Object.entries(fields).filter(([fieldName, value]) => {
      if (!comparableFields.has(fieldName)) {
        return true;
      }
      return (
        normalizeConstructionComparableText(value) !==
        normalizeConstructionComparableText(existingFields[fieldName])
      );
    }),
  );
}

function extractConstructionAttachmentTokens(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return '';
      }
      const record = item as Record<string, unknown>;
      return String(record.file_token || record.fileToken || '').trim();
    })
    .filter(Boolean);
}

const CONSTRUCTION_FEEDBACK_FIELD_NAMES = [
  'AI审核结果-挂牌&隔离照片',
  'AI审核结果-挂牌与隔离照片',
  'AI审核结果-挂牌&隔离合规反馈',
  '挂牌&隔离合规反馈',
  'AI识别反馈（过程）',
  ...Object.values(CONSTRUCTION_PERMIT_ATTACHMENT_AUDIT_FIELDS).map(
    (config) => config.feedbackField,
  ),
];

function hasComparableConstructionAttachment(
  value: unknown,
  file: ConstructionUploadFile,
): boolean {
  return getComparableConstructionAttachments(value, file).some(Boolean);
}

function getComparableConstructionAttachments(
  value: unknown,
  file: ConstructionUploadFile,
): Array<{ fileToken: string; tmpUrl: string | null }> {
  if (!Array.isArray(value)) {
    return [];
  }
  const uploadedName = normalizeConstructionUploadFileName(file.originalname);
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const attachment = item as Record<string, unknown>;
      const fileToken = String(
        attachment.file_token || attachment.fileToken || '',
      ).trim();
      if (!fileToken) {
        return null;
      }
      const existingName = normalizeConstructionUploadFileName(
        typeof attachment.name === 'string'
          ? attachment.name
          : typeof attachment.file_name === 'string'
            ? attachment.file_name
            : '',
      );
      const existingSize =
        typeof attachment.size === 'number'
          ? attachment.size
          : typeof attachment.size === 'string'
            ? Number(attachment.size)
            : NaN;
      const sameName =
        Boolean(uploadedName && existingName) && uploadedName === existingName;
      const comparableSize = Number.isFinite(existingSize);
      const sameSize = comparableSize ? existingSize === file.size : true;
      if (!sameName || !sameSize) {
        return null;
      }
      return {
        fileToken,
        tmpUrl:
          typeof attachment.tmp_url === 'string' && attachment.tmp_url
            ? attachment.tmp_url
            : typeof attachment.tmpUrl === 'string' && attachment.tmpUrl
              ? attachment.tmpUrl
              : null,
      };
    })
    .filter((item): item is { fileToken: string; tmpUrl: string | null } =>
      Boolean(item),
    );
}

function normalizeConstructionComparableText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return extractDisplayText(value).trim();
}

function getConstructionUploadFileHash(file: ConstructionUploadFile): string {
  return getBufferHash(file.buffer);
}

function getBufferHash(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildIsolationPhotoVisionAuditContextLines(
  context?: IsolationPhotoVisionAuditContext,
): string[] {
  if (!context) {
    return [];
  }

  const entries = [
    ['施工编码', context.constructionCode],
    ['作业内容', context.workContent],
    ['楼栋/区域', context.building],
    ['施工方', context.contractor],
    ['计划开始', context.planStartTime],
    ['计划结束', context.planEndTime],
  ]
    .map(([label, value]) => [label, normalizeOptionalText(value)] as const)
    .filter(([, value]) => Boolean(value));

  if (entries.length === 0) {
    return [];
  }

  return [
    '已知施工上下文（用于核对图片水印文字，不代表图片一定合格）：',
    ...entries.map(([label, value]) => `- ${label}：${value}`),
    '上下文只用于辅助识别，不要求字段名称完全一致，也不作为水印核验不通过原因；地点包含“保税A区”或“阿里巴巴南通保税A区数据中心”时视为有效地点。',
  ];
}

export function buildConstructionImageAuditStatus(
  config: ConstructionImageAuditRuntimeConfig | null,
): ConstructionImageAuditStatus {
  const baseUrl = normalizeOptionalText(config?.baseUrl) || null;
  const model = normalizeOptionalText(config?.model) || null;
  const configured = Boolean(normalizeOptionalText(config?.apiKey));
  const provider = inferConstructionImageAuditProvider(baseUrl, model);
  const supportsImageInput = provider !== 'DeepSeek';

  return {
    configured,
    provider,
    model,
    baseUrl,
    supportsImageInput,
    message: !configured
      ? '视觉审核未配置 Key，挂牌照片将生成规则审核要点'
      : supportsImageInput
        ? `${provider} ${model || '视觉模型'} 已配置`
        : `${provider} ${model || '模型'} 已配置；当前官方接口不支持图片输入，挂牌照片将生成规则审核要点`,
  };
}

function inferConstructionImageAuditProvider(
  baseUrl: string | null,
  model: string | null,
): string {
  const text = `${baseUrl || ''} ${model || ''}`.toLowerCase();
  if (text.includes('deepseek')) return 'DeepSeek';
  if (text.includes('dashscope') || text.includes('qwen')) return 'Qwen';
  return 'OpenAI兼容模型';
}

export function parseIsolationPhotoVisionAuditResponse(
  content: string,
): IsolationPhotoVisionAuditResult {
  const normalized = extractJsonObjectText(content);
  const parsed = JSON.parse(normalized) as Record<string, unknown>;
  const watermark = (parsed.watermark || {}) as Record<string, unknown>;
  const onsite = (parsed.onsite || {}) as Record<string, unknown>;

  return {
    result: normalizeOptionalText(parsed.result) || '需人工复核',
    summary: normalizeOptionalText(parsed.summary) || '视觉审核未返回摘要',
    watermark: {
      complete: Boolean(watermark.complete),
      hasVnetLogo: normalizeOptionalBoolean(
        watermark.hasVnetLogo ??
          watermark.vnetLogo ??
          watermark.brandLogo ??
          watermark.logo,
      ),
      missing: normalizeStringArray(watermark.missing),
    },
    onsite: {
      isolationTape: Boolean(onsite.isolationTape),
      warningSign: Boolean(onsite.warningSign),
      constructionNameplate: Boolean(onsite.constructionNameplate),
    },
    issues: normalizeStringArray(parsed.issues),
    suggestions: normalizeStringArray(parsed.suggestions),
  };
}

export function formatIsolationPhotoVisionAuditFeedback(
  result: IsolationPhotoVisionAuditResult,
): string {
  const normalizedResult = normalizeVisionAuditResultLabel(result.result);
  const watermark = normalizeIsolationWatermarkAudit(result.watermark);
  const missingOnsiteItems = [
    result.onsite.isolationTape ? '' : '隔离带',
    result.onsite.warningSign ? '' : '警示牌',
    result.onsite.constructionNameplate ? '' : '施工铭牌',
  ].filter(Boolean);
  const hasBlockingIssue =
    !watermark.complete ||
    watermark.missing.length > 0 ||
    missingOnsiteItems.length > 0;
  const effectiveResult =
    normalizedResult === '通过' && hasBlockingIssue
      ? '不通过'
      : normalizedResult;
  const watermarkStatus = watermark.missing.length
    ? `不通过（缺失：${watermark.missing.join('、')}）`
    : watermark.complete
      ? '通过'
      : '需人工复核';
  const onsiteStatus = missingOnsiteItems.length
    ? `不通过（未识别：${missingOnsiteItems.join('、')}）`
    : '通过';

  return [
    `结论：${effectiveResult}`,
    `水印核验：${watermarkStatus}`,
    `现场核验：${onsiteStatus}`,
  ].join('｜');
}

function normalizeIsolationWatermarkAudit(
  watermark: IsolationPhotoVisionAuditResult['watermark'],
): Pick<IsolationPhotoVisionAuditResult['watermark'], 'complete' | 'missing'> {
  if (watermark.hasVnetLogo) {
    return {
      complete: true,
      missing: [],
    };
  }

  const missing = watermark.missing.filter(
    (item) => !(watermark.hasVnetLogo && isVnetLogoMissingItem(item)),
  );
  return {
    complete:
      watermark.complete ||
      (watermark.missing.length > 0 && missing.length === 0),
    missing,
  };
}

function isVnetLogoMissingItem(item: string): boolean {
  return /世纪互联|VNET|logo|标识/i.test(item);
}

function normalizeConstructionPermitExpiryDate(
  value: unknown,
  fallbackSources: readonly unknown[] = [],
): string | null {
  const text = [value, ...fallbackSources]
    .flatMap((item) =>
      Array.isArray(item)
        ? item.map((part) => normalizeOptionalText(part))
        : [normalizeOptionalText(item)],
    )
    .filter((item): item is string => Boolean(item))
    .join('；');
  if (!text || /^null$/i.test(text)) {
    return null;
  }

  const rangeEndDates = collectConstructionPermitRangeEndDates(text);
  if (rangeEndDates.length > 0) {
    return rangeEndDates[rangeEndDates.length - 1];
  }

  const compactRangeEndDates =
    collectConstructionPermitCompactRangeEndDates(text);
  if (compactRangeEndDates.length > 0) {
    return compactRangeEndDates[compactRangeEndDates.length - 1];
  }

  const direct = parseConstructionPermitDate(normalizeOptionalText(value));
  if (direct) {
    return direct;
  }

  const dates = collectConstructionPermitDates(text);
  return dates.length > 0 ? dates[dates.length - 1] : null;
}

function collectConstructionPermitRangeEndDates(value: string): string[] {
  const text = normalizeConstructionPermitDateText(value);
  const rangeSegments = Array.from(
    text.matchAll(
      /(?:作业时间|施工时间|有效时间|有效期|有效日期|许可期限|作业期限|动火时间|用电时间|临时用电时间|高处作业时间|受限空间作业时间)[^；;。.\n\r]{0,180}/g,
    ),
  ).map((match) => match[0]);
  const dates = rangeSegments
    .map((segment) => extractConstructionPermitRangeEndDate(segment))
    .filter((item): item is string => Boolean(item));
  return dedupe(dates);
}

function collectConstructionPermitCompactRangeEndDates(
  value: string,
): string[] {
  const text = normalizeConstructionPermitDateText(value);
  const defaultYear = getConstructionPermitDefaultYear(text);
  const matches = Array.from(
    text.matchAll(
      /(?:(20\d{2})\s*(?:年|[-/.])\s*)?(\d{1,2})\s*(?:月|[.])\s*(\d{1,2})\s*(?:日|号)?\s*(?:[-~～—–至到])\s*(?:(20\d{2})\s*(?:年|[-/.])\s*)?(\d{1,2})\s*(?:月|[.])\s*(\d{1,2})\s*(?:日|号)?/g,
    ),
  )
    .map((match) => {
      const year = Number(match[4] || match[1] || defaultYear);
      return parseConstructionPermitDate(
        `${year}-${match[5]}-${match[6]}`,
        year,
      );
    })
    .filter((item): item is string => Boolean(item));
  return dedupe(matches);
}

function getConstructionPermitDefaultYear(value: string): number | undefined {
  const match = /20\d{2}/.exec(value);
  return match ? Number(match[0]) : undefined;
}

function extractConstructionPermitRangeEndDate(segment: string): string | null {
  const dateMatches = Array.from(
    segment.matchAll(
      /((?:(20\d{2})\s*(?:年|[-/.])\s*)?\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*(?:日|号)?)/g,
    ),
  );
  if (dateMatches.length < 2) {
    return null;
  }
  const defaultYear = dateMatches
    .map((match) => (match[2] ? Number(match[2]) : NaN))
    .find((year) => Number.isFinite(year));
  const separators = Array.from(segment.matchAll(/至|到|截止|止/g)).map(
    (match) => match.index ?? -1,
  );
  const endCandidate =
    dateMatches.find((match) =>
      separators.some((separatorIndex) => (match.index ?? 0) > separatorIndex),
    ) || dateMatches[dateMatches.length - 1];
  return parseConstructionPermitDate(endCandidate[1], defaultYear);
}

function collectConstructionPermitDates(value: string): string[] {
  const text = normalizeConstructionPermitDateText(value);
  const matches = Array.from(
    text.matchAll(
      /((?:20\d{2})\s*(?:年|[-/.])\s*\d{1,2}\s*(?:月|[-/.])\s*\d{1,2}\s*(?:日|号)?)/g,
    ),
  )
    .map((match) => parseConstructionPermitDate(match[1]))
    .filter((item): item is string => Boolean(item));
  return dedupe(matches);
}

function parseConstructionPermitDate(
  value: string | null,
  defaultYear?: number,
): string | null {
  if (!value || /^null$/i.test(value)) {
    return null;
  }
  const normalized = normalizeConstructionPermitDateText(value);
  const match = normalized.match(
    /(?:(20\d{2})\s*(?:年|[-/.])\s*)?(\d{1,2})\s*(?:月|[-/.])\s*(\d{1,2})/,
  );
  if (!match) {
    return null;
  }
  const year = match[1] ? Number(match[1]) : defaultYear;
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isFinite(year) ||
    !year ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeConstructionPermitDateText(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 48),
  );
}

function normalizeVisionAuditResultLabel(result: string): string {
  const text = normalizeOptionalText(result);
  if (!text) return '需人工复核';
  if (/不通过|fail/i.test(text)) return '不通过';
  if (/需人工|复核|manual/i.test(text)) return '需人工复核';
  if (/通过|pass/i.test(text)) return '通过';
  return text;
}

export function normalizeConstructionCompletionChecklist(
  input: unknown,
  templateItems: readonly ConstructionCompletionChecklistTemplateItem[] = CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS,
): NormalizedConstructionCompletionChecklistAnswer[] {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('每日收尾检查清单格式不正确');
    }
  }
  if (!Array.isArray(raw)) {
    throw new Error('每日收尾检查清单格式不正确');
  }

  const byKey = new Map<string, unknown>();
  raw.forEach((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error('每日收尾检查清单格式不正确');
    }
    const record = item as Record<string, unknown>;
    const key = normalizeOptionalText(record.key);
    if (!key) {
      throw new Error('每日收尾检查清单格式不正确');
    }
    byKey.set(key, record);
  });

  const normalized = templateItems.map((template) => {
    const source = byKey.get(template.key) as
      | Record<string, unknown>
      | undefined;
    if (!source) {
      throw new Error('每日收尾检查清单需完成全部检查项');
    }

    const result = normalizeOptionalText(source.result);
    if (result !== '√' && result !== '×' && result !== 'N/A') {
      throw new Error('每日收尾检查清单结果只能为 √、× 或 N/A');
    }
    const normalizedResult =
      result as ConstructionCompletionChecklistAnswer['result'];

    const remark = normalizeOptionalText(source.remark) || '';
    if (normalizedResult === '×' && !remark) {
      throw new Error('不合格检查项需填写整改说明');
    }

    return {
      key: template.key,
      result: normalizedResult,
      remark,
    };
  });

  if (byKey.size !== templateItems.length) {
    throw new Error('每日收尾检查清单需完成全部检查项');
  }

  return normalized;
}

export function getConstructionCompletionChecklistItems(
  completed?: string | null,
): readonly ConstructionCompletionChecklistTemplateItem[] {
  return completed === '否'
    ? CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS
    : CONSTRUCTION_FULL_COMPLETION_CHECKLIST_ITEMS;
}

function extractConstructionCompletionChecklistFromField(
  value: unknown,
  templateItems: readonly ConstructionCompletionChecklistTemplateItem[],
): NormalizedConstructionCompletionChecklistAnswer[] {
  const text = extractRawTextFieldValue(value);
  if (!text) {
    return [];
  }
  const candidateTemplates = [
    templateItems,
    CONSTRUCTION_DAILY_COMPLETION_CHECKLIST_ITEMS,
    CONSTRUCTION_FULL_COMPLETION_CHECKLIST_ITEMS,
  ];
  for (const candidate of candidateTemplates) {
    try {
      return normalizeConstructionCompletionChecklist(text, candidate);
    } catch {
      // Try the next template; old records may not have an explicit completed status.
    }
  }
  return [];
}

function extractRawTextFieldValue(value: unknown): string {
  if (!isPresent(value)) {
    return '';
  }
  if (typeof value === 'string') {
    return value.trim();
  }
  if (Array.isArray(value)) {
    return value.map(extractRawTextFieldValue).filter(Boolean).join('');
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of ['text', 'value', 'title', 'label', 'name']) {
      const text = extractRawTextFieldValue(record[key]);
      if (text) {
        return text;
      }
    }
  }
  return extractDisplayText(value);
}

const DAILY_PERSONNEL_CHECKLIST_SHEET = '每日人员核查清单';
const DAILY_PERSONNEL_CHECKLIST_HEADERS = [
  '日期',
  '施工编码',
  '项目名称',
  '楼栋',
  '人员姓名',
  '证件摘要',
  '合规状态',
  '问题说明',
  '核查人',
  '人员记录ID',
] as const;

type DailyPersonnelChecklistRow = Record<
  (typeof DAILY_PERSONNEL_CHECKLIST_HEADERS)[number],
  string
>;

export function buildDailyPersonnelChecklistFile(input: {
  existingWorkbookBuffer?: Buffer | null;
  participants: readonly ConstructionDailyPersonnelCheckParticipant[];
  constructionCode?: string | null;
  workContent?: string | null;
  building?: string | null;
  checker?: string | null;
  checkDate?: Date;
}): ConstructionUploadFile {
  const checkDate = input.checkDate || new Date();
  const dateText = formatDateForChecklist(checkDate);
  const existingRows = readDailyPersonnelChecklistRows(
    input.existingWorkbookBuffer,
  );
  const rows = existingRows.filter(
    (row) => !isSameDailyPersonnelChecklistScope(row, input, dateText),
  );

  input.participants.forEach((participant) => {
    const row: DailyPersonnelChecklistRow = {
      日期: dateText,
      施工编码: input.constructionCode || '',
      项目名称: input.workContent || '',
      楼栋: input.building || '',
      人员姓名: participant.name,
      证件摘要: participant.certificateSummary || '',
      合规状态: participant.complianceStatus || '',
      问题说明: participant.issueSummary || '',
      核查人: input.checker || '',
      人员记录ID: participant.recordId || participant.name,
    };
    const duplicate = rows.some(
      (item) =>
        item.日期 === row.日期 &&
        ((row.人员记录ID && item.人员记录ID === row.人员记录ID) ||
          item.人员姓名 === row.人员姓名),
    );
    if (!duplicate) {
      rows.push(row);
    }
  });

  const worksheet = XLSX.utils.json_to_sheet(rows, {
    header: [...DAILY_PERSONNEL_CHECKLIST_HEADERS],
  });
  worksheet['!cols'] = [
    { wch: 14 },
    { wch: 18 },
    { wch: 28 },
    { wch: 10 },
    { wch: 14 },
    { wch: 36 },
    { wch: 12 },
    { wch: 28 },
    { wch: 14 },
    { wch: 22 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    worksheet,
    DAILY_PERSONNEL_CHECKLIST_SHEET,
  );
  const buffer = XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'buffer',
  }) as Buffer;
  const safeProjectName = sanitizeChecklistFileName(
    input.constructionCode || input.workContent || '施工',
  );

  return {
    fieldname: 'dailyPersonnelChecklistFiles',
    originalname: `${safeProjectName}-${DAILY_PERSONNEL_CHECKLIST_SHEET}.xlsx`,
    mimetype:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: buffer.length,
    buffer,
  };
}

function isSameDailyPersonnelChecklistScope(
  row: DailyPersonnelChecklistRow,
  input: {
    constructionCode?: string | null;
    workContent?: string | null;
  },
  dateText: string,
): boolean {
  if (row.日期 !== dateText) {
    return false;
  }
  const constructionCode = String(input.constructionCode || '').trim();
  if (constructionCode) {
    return row.施工编码 === constructionCode;
  }
  const workContent = String(input.workContent || '').trim();
  return Boolean(workContent && row.项目名称 === workContent);
}

function readDailyPersonnelChecklistRows(
  buffer?: Buffer | null,
): DailyPersonnelChecklistRow[] {
  if (!buffer || buffer.length === 0) {
    return [];
  }

  try {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const worksheet =
      workbook.Sheets[DAILY_PERSONNEL_CHECKLIST_SHEET] ||
      workbook.Sheets[workbook.SheetNames[0]];
    if (!worksheet) {
      return [];
    }
    return XLSX.utils
      .sheet_to_json<Record<string, unknown>>(worksheet, { defval: '' })
      .map(
        (row) =>
          Object.fromEntries(
            DAILY_PERSONNEL_CHECKLIST_HEADERS.map((header) => [
              header,
              String(row[header] || '').trim(),
            ]),
          ) as DailyPersonnelChecklistRow,
      )
      .filter((row) => row.日期 || row.人员姓名 || row.人员记录ID);
  } catch {
    return [];
  }
}

export function buildConstructionCompletionChecklistFile(input: {
  checklist: NormalizedConstructionCompletionChecklistAnswer[];
  templateItems?: readonly ConstructionCompletionChecklistTemplateItem[];
  title?: string;
  constructionCode?: string | null;
  workContent?: string | null;
  building?: string | null;
  contractor?: string | null;
  planStartTime?: string | null;
  planEndTime?: string | null;
  completedAt?: Date;
}): ConstructionUploadFile {
  const completedAt = input.completedAt || new Date();
  const completedDate = formatDateForChecklist(completedAt);
  const templateItems =
    input.templateItems || CONSTRUCTION_COMPLETION_CHECKLIST_ITEMS;
  const title = input.title || '施工完工检查表';
  const checklistByKey = new Map(
    input.checklist.map((item) => [item.key, item]),
  );
  const projectText = [
    input.workContent,
    input.constructionCode ? `(${input.constructionCode})` : null,
  ]
    .filter(Boolean)
    .join(' ');
  const planPeriod = [input.planStartTime, input.planEndTime]
    .filter(Boolean)
    .join(' 至 ');

  const rows: unknown[][] = [
    [title, '', '', '', ''],
    ['一、基本信息', '', '', '', ''],
    [
      '项目信息',
      projectText || input.constructionCode || '',
      '',
      '检查类型（首次/整改）',
      '首次',
    ],
    [
      '乙方公司名称',
      input.contractor || '',
      '',
      '施工区域',
      input.building || '',
    ],
    ['计划工期', planPeriod, '', '完工日期', completedDate],
    ['二、检查明细', '', '', '', ''],
    [
      '序号',
      '检查类别',
      '检查内容',
      '检查结果（√ / × / N/A）',
      '备注（不合格/整改说明）',
    ],
  ];

  templateItems.forEach((template, index) => {
    const answer = checklistByKey.get(template.key);
    rows.push([
      index + 1,
      template.category,
      `${template.no}${template.content}`,
      answer?.result || '',
      answer?.remark || '',
    ]);
  });

  const failedItems = input.checklist.filter((item) => item.result === '×');
  const summaryRow = rows.length + 1;
  rows.push(['三、检查总结', '', '', '', '']);
  rows.push([
    failedItems.length === 0
      ? '□ 全部检查项目合格；'
      : `□ 部分检查项目不合格，需整改 ${failedItems.length} 项；整改负责人：`,
    '',
    '',
    '',
    '',
  ]);
  rows.push(['四、检查确认', '', '', '', '']);
  rows.push(['检查人', '', '', '检查日期', completedDate]);
  rows.push(['审核人', '', '', '审核日期', '']);

  const worksheet = XLSX.utils.aoa_to_sheet(rows);
  worksheet['!cols'] = [
    { wch: 8 },
    { wch: 16 },
    { wch: 72 },
    { wch: 18 },
    { wch: 32 },
  ];
  worksheet['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 4 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: 4 } },
    { s: { r: 5, c: 0 }, e: { r: 5, c: 4 } },
    { s: { r: summaryRow - 1, c: 0 }, e: { r: summaryRow - 1, c: 4 } },
    { s: { r: summaryRow, c: 0 }, e: { r: summaryRow, c: 4 } },
    { s: { r: summaryRow + 1, c: 0 }, e: { r: summaryRow + 1, c: 4 } },
  ];
  applyChecklistWorksheetStyle(worksheet, rows.length);

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, title);
  const buffer = XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'buffer',
  }) as Buffer;
  const safeProjectName = sanitizeChecklistFileName(
    input.constructionCode || input.workContent || '施工',
  );

  return {
    fieldname: 'inspectionFormFiles',
    originalname: `${completedDate}-${safeProjectName}-${title}.xlsx`,
    mimetype:
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: buffer.length,
    buffer,
  };
}

export function buildConstructionManagementView(
  input: ConstructionManagementViewInput,
): ConstructionManagementResponse {
  const referenceDate = input.referenceDate || new Date();
  const crewMembers = (input.crewRecords || [])
    .map((record) => mapConstructionCrewMemberRecord(record, referenceDate))
    .filter((item): item is ConstructionCrewMemberItem => Boolean(item));
  const crewMembersByOverviewId = new Map<
    string,
    ConstructionCrewMemberItem[]
  >();
  const crewMembersByCode = new Map<string, ConstructionCrewMemberItem[]>();
  const followups = input.followupRecords
    .map((record) =>
      mapConstructionFollowupRecord(record, input.followupSourceUrl),
    )
    .filter((item): item is ConstructionFollowupItem => Boolean(item))
    .sort(
      (a, b) =>
        getSortTime(b.updatedAt || b.createdAt) -
        getSortTime(a.updatedAt || a.createdAt),
    );
  const followupsByOverviewId = new Map<string, ConstructionFollowupItem[]>();
  const followupsByCode = new Map<string, ConstructionFollowupItem[]>();

  crewMembers.forEach((member) => {
    member.overviewRecordIds.forEach((id) => {
      const group = crewMembersByOverviewId.get(id) || [];
      group.push(member);
      crewMembersByOverviewId.set(id, group);
    });
    if (member.constructionCode) {
      const group = crewMembersByCode.get(member.constructionCode) || [];
      group.push(member);
      crewMembersByCode.set(member.constructionCode, group);
    }
  });

  followups.forEach((followup) => {
    followup.overviewRecordIds.forEach((id) => {
      const group = followupsByOverviewId.get(id) || [];
      group.push(followup);
      followupsByOverviewId.set(id, group);
    });
    if (followup.constructionCode) {
      const group = followupsByCode.get(followup.constructionCode) || [];
      group.push(followup);
      followupsByCode.set(followup.constructionCode, group);
    }
  });

  const items = input.overviewRecords
    .map((record) => {
      const constructionCode = extractConstructionCode(record.fields || {});

      return mapConstructionOverviewRecord(
        record,
        [
          ...(followupsByOverviewId.get(getRecordId(record)) || []),
          ...(followupsByCode.get(constructionCode || '') || []),
        ],
        [
          ...(crewMembersByOverviewId.get(getRecordId(record)) || []),
          ...(crewMembersByCode.get(constructionCode || '') || []),
        ],
        input.overviewSourceUrl,
      );
    })
    .filter((item): item is ConstructionOverviewItem => Boolean(item))
    .sort(
      (a, b) =>
        getSortTime(b.latestFollowup?.updatedAt || b.updatedAt) -
        getSortTime(a.latestFollowup?.updatedAt || a.updatedAt),
    );

  const latestUpdatedAt =
    [
      ...items.map((item) => item.updatedAt),
      ...followups.map((item) => item.updatedAt),
    ]
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => getSortTime(b) - getSortTime(a))[0] || null;

  return {
    generatedAt: input.generatedAt,
    summary: {
      total: items.length,
      active: items.filter((item) => isConstructionActive(item, referenceDate))
        .length,
      pendingApproval: items.filter(hasPendingApproval).length,
      endingSoon: items.filter((item) => isEndingSoon(item, referenceDate))
        .length,
      attachmentIssues: followups.filter((item) => item.aiIssues.length > 0)
        .length,
      completedFollowups: followups.filter((item) => item.completed === '是')
        .length,
      latestUpdatedAt,
    },
    items,
    followups,
    imageAuditStatus: buildConstructionImageAuditStatus(null),
    sectionStatus: {
      overview: { configured: true },
      followups: { configured: true },
    },
  };
}

function mapConstructionOverviewRecord(
  record: ConstructionBitableRecordItem,
  followups: ConstructionFollowupItem[],
  crewMembers: ConstructionCrewMemberItem[],
  sourceUrl?: string,
): ConstructionOverviewItem | null {
  const fields = record.fields || {};
  const recordId = getRecordId(record);
  const workContent = extractDisplayText(
    pickField(fields, ['作业内容', '施工内容', '内容']),
  );

  if (!recordId || !workContent) {
    return null;
  }

  const uniqueFollowups = dedupeFollowups(followups);
  const uniqueCrewMembers = dedupeCrewMembers(crewMembers);
  const latestFollowup =
    uniqueFollowups.find((item) => item.isLatest) || uniqueFollowups[0] || null;
  const latestDepositPaid =
    uniqueFollowups.find((item) => item.depositPaid)?.depositPaid || null;
  const latestRoomManagerSync =
    uniqueFollowups.find((item) => item.roomManagerSync)?.roomManagerSync ||
    null;
  return {
    recordId,
    constructionCode: extractConstructionCode(fields),
    workContent,
    building: extractDisplayText(fields.楼栋) || null,
    specialty: extractDisplayText(fields.专业) || null,
    contractorType:
      extractDisplayText(fields['施工方（内部/施工单位）']) || null,
    workTypes: extractDisplayValues(fields.作业类型),
    relatedWorkType: extractDisplayText(fields.关联作业类型) || null,
    workflow: extractDisplayText(fields.流程) || null,
    planStartTime: extractDateTimeIso(fields.计划开始时间),
    planEndTime: extractDateTimeIso(
      pickField(fields, ['计划结束时间', '计划结束日期']),
    ),
    remainingDays: extractNumberValue(fields.施工剩余天数),
    approval: {
      supervisor: extractDisplayText(fields.示例人员001审批) || null,
      ehsNotified: extractCheckboxApprovalStatus(
        pickField(fields, EHS_NOTIFIED_FIELDS),
        '已知会',
        '待知会',
      ),
      ehs: extractDisplayText(pickField(fields, EHS_APPROVAL_FIELDS)) || null,
      credential: null,
      depositConfirmation: extractApprovalStatusField(
        fields,
        DEPOSIT_CONFIRMATION_FIELDS,
        '已确认',
        '待质保金确认',
      ),
      parkSync:
        latestRoomManagerSync ||
        extractApprovalStatusField(
          fields,
          PARK_SYNC_FIELDS,
          '已同步',
          '待同步',
        ),
      depositPaid:
        latestDepositPaid || extractDisplayText(fields.是否缴纳保证金) || null,
    },
    deposit: {
      amount: extractNumberValue(fields['缴纳保证金（元）']),
      deducted: extractNumberValue(fields.被扣款保证金),
      balance: extractNumberValue(fields.结余),
    },
    managers: {
      supervisor: extractDisplayText(fields['施工审批人（楼栋示例人员001）']) || null,
      safety: extractDisplayText(fields.安全负责人) || null,
      park: extractDisplayText(fields.园区负责人) || null,
      applicant: extractDisplayText(fields.施工申请人) || null,
      engineer:
        extractDisplayText(fields['施工随工人员（专业工程师）']) || null,
    },
    createdBy: extractDisplayText(fields.创建人) || null,
    updatedAt:
      extractDateTimeIso(fields.最后更新时间) ||
      extractDateTimeIso(record.last_modified_time),
    createdAt:
      extractDateTimeIso(pickField(fields, ['创建时间', '创建日期'])) ||
      extractDateTimeIso(record.created_time),
    recordUrl: buildBitableRecordUrl(sourceUrl, recordId),
    applicationAttachments: buildOverviewAttachmentGroups(
      fields,
      CONSTRUCTION_APPLICATION_ATTACHMENT_FIELDS,
    ),
    constructionIssues: extractAttachmentFiles(fields.施工问题),
    completionChecklistArchive: extractAttachmentFiles(fields.施工完工检查清单),
    depositAgreementFiles: extractAttachmentFiles(fields.质保金协议),
    depositTransferFiles: extractAttachmentFiles(fields['质保金到账/返还']),
    crewMembers: uniqueCrewMembers,
    followups: uniqueFollowups,
    latestFollowup,
  };
}

function buildOverviewAttachmentGroups(
  fields: Record<string, unknown>,
  fieldMap: Record<string, string>,
): ConstructionAttachmentGroup[] {
  return Object.values(fieldMap).map((field) => {
    const files = extractAttachmentFiles(fields[field]);
    return {
      field,
      label: field,
      count: files.length,
      files,
      status: files.length > 0 ? ('complete' as const) : ('empty' as const),
      feedback: null,
    };
  });
}

function mapConstructionCrewMemberRecord(
  record: ConstructionBitableRecordItem,
  referenceDate: Date = new Date(),
): ConstructionCrewMemberItem | null {
  const fields = record.fields || {};
  const recordId = getRecordId(record);
  const name = extractDisplayText(fields.姓名);

  if (!recordId || !name) {
    return null;
  }
  const authorizationStartDate = extractDateTimeIso(
    pickField(fields, [
      ...CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_START_FIELD_NAMES,
    ]),
  );
  const authorizationEndDate = extractDateTimeIso(
    pickField(fields, [
      ...CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_END_FIELD_NAMES,
    ]),
  );
  const calculatedAuthorizationStatus = getConstructionCrewAuthorizationStatus(
    authorizationStartDate,
    authorizationEndDate,
    referenceDate,
  );
  const authorizationStatus =
    calculatedAuthorizationStatus ||
    extractDisplayText(
      pickField(fields, [
        ...CONSTRUCTION_CREW_LEDGER_AUTHORIZATION_STATUS_FIELD_NAMES,
      ]),
    ) ||
    null;

  return {
    recordId,
    name,
    company:
      extractDisplayText(
        pickField(fields, [...CONSTRUCTION_CREW_LEDGER_COMPANY_FIELD_NAMES]),
      ) || null,
    constructionCode: extractConstructionCode(fields),
    overviewRecordIds: extractLinkRecordIds(fields.关联施工单),
    phone: extractDisplayText(fields.手机号) || null,
    certificateNo:
      extractDisplayText(
        pickField(fields, ['证件号码', '身份证号', '身份证号码', '证件号']),
      ) || null,
    authorizationStartDate,
    authorizationEndDate,
    authorizationStatus,
    certificateSummary: normalizeCertificateSummary(
      extractDisplayText(
        pickField(fields, [
          ...CONSTRUCTION_CREW_LEDGER_CERTIFICATE_SUMMARY_FIELD_NAMES,
        ]),
      ),
    ),
    complianceStatus: extractDisplayText(fields.人员持证是否达标) || null,
    issueSummary: normalizeCrewIssueSummary(extractDisplayText(fields.总结)),
  };
}

function normalizeCrewIssueSummary(value?: string | null): string | null {
  const text = String(value || '').trim();
  if (!text) {
    return null;
  }

  if (
    /缺少\s*[:：]?\s*(无|暂无|没有|空|none|nil)$/i.test(text) ||
    /缺少\s*(无|暂无|没有|空|none|nil)$/i.test(text) ||
    /^(无|暂无|没有|无问题|无异常|正常|合规)$/i.test(text)
  ) {
    return null;
  }

  return text;
}

function mapConstructionFollowupRecord(
  record: ConstructionBitableRecordItem,
  sourceUrl?: string,
): ConstructionFollowupItem | null {
  const fields = record.fields || {};
  const recordId = getRecordId(record);
  const constructionCode = extractConstructionCode(fields);
  const followupStaffMembers = extractFollowupStaffMembers(fields.跟进人员);
  const title =
    extractDisplayText(fields.跟进记录) ||
    [constructionCode, extractDisplayText(fields.作业内容)]
      .filter(Boolean)
      .join('-');

  if (!recordId || !title) {
    return null;
  }

  const isolationFeedback =
    extractDisplayText(
      pickField(fields, [
        'AI审核结果-挂牌&隔离照片',
        'AI审核结果-挂牌与隔离照片',
        'AI审核结果-挂牌&隔离合规反馈',
        '挂牌&隔离合规反馈',
      ]),
    ) || null;
  const processFeedback =
    extractDisplayText(fields['AI识别反馈（过程）']) || null;
  const closingFeedback =
    extractDisplayText(fields['AI识别反馈（收尾）']) || null;
  const completed = extractDisplayText(fields.是否完成) || null;
  const completionChecklist = extractConstructionCompletionChecklistFromField(
    pickField(fields, [...CONSTRUCTION_COMPLETION_CHECKLIST_FIELD_NAMES]),
    getConstructionCompletionChecklistItems(completed),
  );
  const attachments = buildFollowupAttachmentGroups(fields);
  const aiIssues = [
    isolationFeedback,
    processFeedback,
    closingFeedback,
    ...attachments.map((item) => item.feedback),
  ].filter((value): value is string =>
    Boolean(value && isIssueFeedback(value)),
  );
  const dailyWorkTypes = extractDisplayValues(fields.当日作业类型);

  return {
    recordId,
    title,
    constructionCode,
    workContent: extractDisplayText(fields.作业内容) || null,
    workTypes: dailyWorkTypes.length
      ? dailyWorkTypes
      : extractDisplayValues(fields.作业类型),
    dailyWorkTypesConfirmed: dailyWorkTypes.length > 0,
    overviewRecordIds: extractLinkRecordIds(fields.施工总览),
    constructionDay: extractNumberValue(fields.施工天数),
    isLatest: /最新|是|true/i.test(
      extractDisplayText(pickField(fields, ['是否最新', '判断是否为最新'])),
    ),
    followupStaff:
      followupStaffMembers.map((item) => item.name).join('、') ||
      extractDisplayText(fields.跟进人员) ||
      null,
    followupStaffMembers,
    completed,
    dailyPersonnelCheck: extractDisplayText(fields.每日人员核查) || null,
    isolationCompliant:
      extractDisplayText(
        pickField(fields, [
          '人工审核-挂牌&隔离审核',
          '人工审核--挂牌&隔离审批',
          '挂牌与隔离是否合规',
          '挂牌&隔离是否合规',
        ]),
      ) || null,
    isolationFeedback,
    processFeedback,
    closingFeedback,
    closingApproval:
      extractDisplayText(fields.收尾审批) ||
      extractCheckboxApprovalStatus(
        pickField(fields, ['EHS施工收尾审批']),
        '通过',
        '待审批',
      ) ||
      null,
    depositPaid: extractFollowupDepositConfirmationStatus(fields),
    roomManagerSync: extractApprovalStatusField(
      fields,
      PARK_SYNC_FIELDS,
      '已同步',
      '待同步',
    ),
    completionChecklist,
    followupDate: normalizeOptionalFollowupDate(
      pickField(fields, ['跟进日期', '跟进时间', '日期']),
    ),
    createdAt:
      extractDateTimeIso(pickField(fields, ['创建时间', '创建日期'])) ||
      extractDateTimeIso(record.created_time),
    updatedAt:
      extractDateTimeIso(fields.最后更新时间) ||
      extractDateTimeIso(record.last_modified_time),
    recordUrl: buildBitableRecordUrl(sourceUrl, recordId),
    attachments,
    aiIssues: Array.from(new Set(aiIssues)),
  };
}

function extractFollowupDepositConfirmationStatus(
  fields: Record<string, unknown>,
): string | null {
  const direct = extractDisplayText(fields.是否缴纳保证金);
  if (direct) {
    return direct;
  }
  return extractApprovalStatusField(
    fields,
    FOLLOWUP_DEPOSIT_CONFIRMATION_FIELDS,
    '是',
    '',
  );
}

function buildFollowupAttachmentGroups(fields: Record<string, unknown>) {
  const feedbackByField: Record<string, string[]> = {
    施工申请单: ['AI审核结果-施工申请单'],
    施工申请作业单: ['AI审核结果-施工申请单'],
    施工作业申请单: ['AI审核结果-施工申请单'],
    入场培训照片: ['AI审核结果-培训照片', 'AI审核结果-培训表'],
    培训照片: ['AI审核结果-培训照片', 'AI审核结果-培训表'],
    入场培训考核: [CONSTRUCTION_TRAINING_ASSESSMENT_AUDIT_FEEDBACK_FIELD],
    动火作业风险交底单: ['AI审核结果-风险交底单'],
    动火风险交底单: ['AI审核结果-风险交底单'],
    安全告知书: ['AI审核结果-安全告知书照片', 'AI审核结果-安全告知书'],
    安全告知书照片: ['AI审核结果-安全告知书照片', 'AI审核结果-安全告知书'],
    受限空间作业许可证: ['AI审核结果-受限空间作业许可证'],
    临时用电作业票: [
      'AI审核结果-临时用电作业许可证',
      'AI审核结果-临时用电许可证',
    ],
    临时用电作业许可证: [
      'AI审核结果-临时用电作业许可证',
      'AI审核结果-临时用电许可证',
    ],
    动火作业票: ['AI审核结果-动火许可证'],
    动火许可证: ['AI审核结果-动火许可证'],
    高处作业票: ['AI审核结果-高处作业许可证'],
    高处作业许可证: ['AI审核结果-高处作业许可证'],
    挂牌与隔离照片: [
      'AI审核结果-挂牌&隔离照片',
      'AI审核结果-挂牌与隔离照片',
      'AI审核结果-挂牌&隔离合规反馈',
      '挂牌&隔离合规反馈',
    ],
    施工过程照片: ['AI识别反馈（过程）', 'AI审核结果-施工过程照片'],
    施工收尾照片: ['AI识别反馈（收尾）', 'AI审核结果-施工收尾照片'],
    施工检查表: ['AI审核结果-施工检查表'],
  };
  const attachmentAliasesByField: Record<string, string[]> = {
    施工作业申请单: ['施工申请作业单', '施工申请单'],
    临时用电作业票: ['临时用电作业许可证'],
    动火作业票: ['动火许可证', '动火作业许可证'],
    高处作业票: ['高处作业许可证'],
  };

  return Object.values(CONSTRUCTION_FOLLOWUP_ATTACHMENT_FIELDS).map((field) => {
    const files = [field, ...(attachmentAliasesByField[field] || [])].flatMap(
      (candidate) => extractAttachmentFiles(fields[candidate]),
    );
    const feedback =
      extractDisplayText(pickField(fields, feedbackByField[field] || [])) ||
      null;
    const manualReview = buildFollowupPermitManualReview(
      fields,
      field,
      files,
      feedback,
    );
    return {
      field,
      label: field,
      count: files.length,
      files,
      status:
        feedback && isIssueFeedback(feedback)
          ? ('issue' as const)
          : files.length > 0
            ? ('complete' as const)
            : ('empty' as const),
      feedback,
      manualReview,
    };
  });
}

function buildFollowupPermitManualReview(
  fields: Record<string, unknown>,
  attachmentField: string,
  files: ConstructionAttachmentFile[],
  feedback: string | null,
): ConstructionAttachmentGroup['manualReview'] {
  const config = Object.values(CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS).find(
    (item) => item.label === attachmentField,
  );
  if (!config) {
    return null;
  }

  const reviewValue = pickField(fields, [
    config.reviewField,
    ...config.reviewAliases,
  ]);
  const fingerprintValue = pickField(fields, [
    config.fingerprintField,
    ...config.fingerprintAliases,
  ]);
  const fingerprint = extractDisplayText(fingerprintValue, '') || null;
  const { validFrom, validUntil } =
    extractConstructionPermitManualReviewValidityRange(fingerprint);

  return {
    field: config.reviewField,
    fingerprintField: config.fingerprintField,
    reviewed: isConstructionPermitManualReviewChecked(reviewValue),
    value: extractDisplayText(reviewValue) || null,
    fingerprint,
    expectedFingerprint: buildConstructionPermitManualReviewFingerprint(
      files,
      validUntil || extractConstructionPermitFeedbackExpiryDate(feedback),
      validUntil ? 'manual' : 'ai',
      validFrom,
    ),
    validFrom,
    validUntil,
  };
}

function isConstructionPermitManualReviewChecked(value: unknown): boolean {
  if (!isPresent(value)) {
    return false;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.some(isConstructionPermitManualReviewChecked);
  }
  const text = extractDisplayText(value);
  return /^(true|1|yes|y|是|已审核|已人工审核|人员已审|人工已审|通过|已通过|✔️?|✓|☑|√)$/i.test(
    text,
  );
}

function extractAttachmentFiles(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const file = item as Record<string, unknown>;
      const fileToken =
        typeof file.file_token === 'string' ? file.file_token : '';
      if (!fileToken) {
        return null;
      }
      return {
        fileToken,
        name:
          typeof file.name === 'string' && file.name ? file.name : '未命名附件',
        size:
          typeof file.size === 'number' && Number.isFinite(file.size)
            ? file.size
            : null,
        tmpUrl:
          typeof file.tmp_url === 'string' && file.tmp_url
            ? file.tmp_url
            : typeof file.tmpUrl === 'string' && file.tmpUrl
              ? file.tmpUrl
              : null,
        downloadUrl:
          typeof file.url === 'string' && file.url
            ? file.url
            : typeof file.downloadUrl === 'string' && file.downloadUrl
              ? file.downloadUrl
              : null,
        mimeType:
          typeof file.type === 'string' && file.type
            ? file.type
            : typeof file.mimeType === 'string' && file.mimeType
              ? file.mimeType
              : null,
      };
    })
    .filter(
      (
        item,
      ): item is {
        fileToken: string;
        name: string;
        size: number | null;
        tmpUrl: string | null;
        downloadUrl: string | null;
        mimeType: string | null;
      } => Boolean(item),
    );
}

export function extractLinkRecordIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (item && typeof item === 'object') {
        const id = (item as Record<string, unknown>).id;
        return typeof id === 'string' ? id : '';
      }
      return '';
    })
    .filter(Boolean);
}

function buildBitableRecordUrl(
  sourceUrl: string | undefined,
  recordId: string,
): string | null {
  if (!sourceUrl || !recordId) {
    return null;
  }

  try {
    const url = new URL(sourceUrl);
    url.searchParams.set('record', recordId);
    return url.toString();
  } catch {
    return null;
  }
}

function isConstructionActive(
  item: ConstructionOverviewItem,
  referenceDate: Date,
): boolean {
  const start = item.planStartTime ? new Date(item.planStartTime) : null;
  const end = item.planEndTime ? new Date(item.planEndTime) : null;
  return Boolean(
    start && end && start <= referenceDate && end >= referenceDate,
  );
}

function isEndingSoon(
  item: ConstructionOverviewItem,
  referenceDate: Date,
): boolean {
  if (item.remainingDays !== null) {
    return item.remainingDays >= 0 && item.remainingDays <= 7;
  }
  const end = item.planEndTime ? new Date(item.planEndTime) : null;
  if (!end) return false;
  const diffDays = Math.ceil(
    (end.getTime() - referenceDate.getTime()) / 86_400_000,
  );
  return diffDays >= 0 && diffDays <= 7;
}

function hasPendingApproval(item: ConstructionOverviewItem): boolean {
  return [
    item.approval.supervisor,
    item.approval.ehsNotified,
    getDepositConfirmationForPendingCheck(item),
  ].some((value) => !isPassedStatus(value));
}

function isPassedStatus(value: string | null): boolean {
  return Boolean(
    value &&
    /通过|合格|完成|已通过|已确认|已知会|已同步|无需|不需要|是/i.test(value),
  );
}

function getDepositConfirmationForPendingCheck(
  item: ConstructionOverviewItem,
): string | null {
  const depositPaid = String(item.approval.depositPaid || '').trim();
  if (/无需|不需要|否/.test(depositPaid)) {
    return '无需缴纳';
  }
  return item.approval.depositConfirmation;
}

function extractCheckboxApprovalStatus(
  field: unknown,
  checkedLabel: string,
  uncheckedLabel: string,
): string | null {
  if (!isPresent(field)) {
    return null;
  }
  if (typeof field === 'boolean') {
    return field ? checkedLabel : uncheckedLabel;
  }
  if (Array.isArray(field)) {
    if (field.length === 0) return null;
    return field.some((item) =>
      isPassedStatus(
        extractCheckboxApprovalStatus(item, checkedLabel, uncheckedLabel),
      ),
    )
      ? checkedLabel
      : uncheckedLabel;
  }
  const text = extractDisplayText(field);
  if (!text) {
    return null;
  }
  if (/^(true|1|yes|y|是|已知会|已通知|通过|✔️?|✓|☑|√)$/i.test(text)) {
    return checkedLabel;
  }
  if (/^(false|0|no|n|否|未知会|未通知)$/i.test(text)) {
    return uncheckedLabel;
  }
  return text;
}

function extractApprovalStatusField(
  fields: Record<string, unknown>,
  names: string[],
  checkedLabel: string,
  uncheckedLabel: string,
): string | null {
  const field = pickField(fields, names);
  if (!isPresent(field)) {
    return null;
  }
  return (
    extractCheckboxApprovalStatus(field, checkedLabel, uncheckedLabel) ||
    extractDisplayText(field) ||
    null
  );
}

function normalizeCertificateSummary(value: string): string | null {
  const text = value.trim().replace(/,+$/g, '').replace(/,/g, '、');
  return text || null;
}

function isIssueFeedback(value: string): boolean {
  const text = value.trim();
  if (/审核结果[:：]\s*通过/.test(text) && /问题清单[:：]\s*无/.test(text)) {
    return false;
  }
  if (/结论[:：]\s*通过/.test(text) && /问题[:：]\s*无/.test(text)) {
    return false;
  }
  if (
    /状态[:：]\s*不通过|审核结果[:：]\s*不通过|驳回|异常|失败|缺少|未填写|无效/.test(
      text,
    )
  ) {
    return true;
  }
  return Boolean(text && !/^(通过|合格|正常|无异常|ok|yes|是)$/i.test(text));
}

function dedupeFollowups(
  followups: ConstructionFollowupItem[],
): ConstructionFollowupItem[] {
  const seen = new Set<string>();
  return followups.filter((item) => {
    if (seen.has(item.recordId)) return false;
    seen.add(item.recordId);
    return true;
  });
}

function dedupeCrewMembers(
  members: ConstructionCrewMemberItem[],
): ConstructionCrewMemberItem[] {
  const seen = new Set<string>();
  return members.filter((item) => {
    if (seen.has(item.recordId)) return false;
    seen.add(item.recordId);
    return true;
  });
}

function getSortTime(value?: string | null): number {
  if (!value) return 0;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function hasCompletionChecklistInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return typeof value === 'string' && value.trim().length > 0;
}

function formatDateForChecklist(date: Date): string {
  return formatShanghaiDateKey(date);
}

function formatShanghaiDateKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getShanghaiDateKeyTime(value: string): number {
  const date = new Date(`${value}T00:00:00+08:00`);
  return Number.isFinite(date.getTime()) ? date.getTime() : Number.NaN;
}

function sanitizeChecklistFileName(value: string): string {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '')
      .slice(0, 60) || '施工'
  );
}

function applyChecklistWorksheetStyle(
  worksheet: XLSX.WorkSheet,
  rowCount: number,
) {
  const range = XLSX.utils.decode_range(worksheet['!ref'] || 'A1:E1');
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let col = range.s.c; col <= range.e.c; col += 1) {
      const address = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = worksheet[address];
      if (!cell) continue;

      cell.s = {
        alignment: {
          horizontal: row === 0 ? 'center' : 'left',
          vertical: 'center',
          wrapText: true,
        },
        border: {
          top: { style: 'thin', color: { rgb: 'D9E2F3' } },
          bottom: { style: 'thin', color: { rgb: 'D9E2F3' } },
          left: { style: 'thin', color: { rgb: 'D9E2F3' } },
          right: { style: 'thin', color: { rgb: 'D9E2F3' } },
        },
        font: {
          name: 'Microsoft YaHei',
          sz: row === 0 ? 16 : 10,
          bold: row === 0 || row === 1 || row === 5 || row === rowCount - 4,
        },
        fill:
          row === 0 || row === 1 || row === 5 || row === rowCount - 4
            ? { fgColor: { rgb: 'EAF2FF' }, patternType: 'solid' }
            : undefined,
      };
    }
  }
}

function normalizeRequiredText(value: unknown, message: string): string {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(message);
  }
  return text;
}

function normalizeOptionalText(value: unknown): string | null {
  const text = String(value || '').trim();
  return text || null;
}

function normalizeConstructionPermitValidityDateByFileKey(
  value:
    | ConstructionFollowupCreateRequest['permitValidFromByFileKey']
    | ConstructionFollowupCreateRequest['permitValidUntilByFileKey'],
): Record<string, string> {
  if (value === null || value === undefined || value === '') {
    return {};
  }

  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('作业票有效期格式不正确');
    }
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.prototype.toString.call(parsed) !== '[object Object]'
  ) {
    throw new Error('作业票有效期格式不正确');
  }

  const result: Record<string, string> = {};
  Object.entries(parsed as Record<string, unknown>).forEach(
    ([fileKey, rawDate]) => {
      const config = CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS[fileKey];
      if (!config) {
        throw new Error(`未知作业票有效期字段：${fileKey}`);
      }
      const dateKey = typeof rawDate === 'string' ? rawDate.trim() : '';
      if (
        typeof rawDate !== 'string' ||
        !isValidConstructionPermitValidityDate(dateKey)
      ) {
        throw new Error(`${config.label}有效期必须是有效的 YYYY-MM-DD 日期`);
      }
      result[fileKey] = dateKey;
    },
  );
  return result;
}

function validateConstructionPermitValidityDateRanges(
  validFromByFileKey: Readonly<Record<string, string>>,
  validUntilByFileKey: Readonly<Record<string, string>>,
): void {
  Object.entries(validFromByFileKey).forEach(([fileKey, validFrom]) => {
    const validUntil = validUntilByFileKey[fileKey];
    if (!validUntil || validFrom <= validUntil) {
      return;
    }
    const config = CONSTRUCTION_PERMIT_MANUAL_REVIEW_FIELDS[fileKey];
    throw new Error(`${config.label}有效期开始日期不能晚于结束日期`);
  });
}

function isValidConstructionPermitValidityDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(`${value}T00:00:00Z`);
  return (
    year >= 1000 &&
    Number.isFinite(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function normalizeOptionalApplicationAuthorizationDate(
  value: unknown,
  fieldName: string,
): string | null {
  const text = normalizeOptionalText(value);
  if (!text) {
    return null;
  }
  const dateKey = normalizeCrewRosterDateKey(text);
  if (!dateKey) {
    throw new Error(`${fieldName}格式不正确`);
  }
  const parsed = new Date(`${dateKey}T00:00:00+08:00`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    formatShanghaiDateKey(parsed) !== dateKey
  ) {
    throw new Error(`${fieldName}不是有效日期`);
  }
  return dateKey;
}

function normalizeOptionalFollowupDate(value: unknown): string | null {
  if (
    typeof value === 'number' ||
    (typeof value === 'object' && value !== null)
  ) {
    const iso = extractDateTimeIso(value);
    if (!iso) {
      return null;
    }
    return formatShanghaiDateKey(new Date(iso));
  }
  const text = normalizeOptionalText(value);
  if (!text) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return text;
  }
  const iso = extractDateTimeIso(text);
  if (!iso) {
    throw new Error(`跟进日期格式不正确：${text}`);
  }
  return formatShanghaiDateKey(new Date(iso));
}

function normalizeAllowedValue(
  value: unknown,
  allowed: readonly string[],
  fieldName: string,
): string {
  const text = normalizeRequiredText(value, `${fieldName}不能为空`);
  if (!allowed.includes(text)) {
    throw new Error(`${fieldName}不支持：${text}`);
  }
  return text;
}

function normalizeOptionalAllowedValue(
  value: unknown,
  allowed: readonly string[],
  fieldName: string,
): string | null {
  const text = normalizeOptionalText(value);
  if (!text) {
    return null;
  }
  if (!allowed.includes(text)) {
    throw new Error(`${fieldName}不支持：${text}`);
  }
  return text;
}

function normalizeAllowedValues(
  value: unknown,
  allowed: readonly string[],
  fieldName: string,
): string[] {
  const normalized = parseAllowedValueTokens(value);
  if (normalized.length === 0) {
    throw new Error(`${fieldName}不能为空`);
  }
  const invalid = normalized.find((item) => !allowed.includes(item));
  if (invalid) {
    throw new Error(`${fieldName}不支持：${invalid}`);
  }
  return Array.from(new Set(normalized));
}

function normalizeOptionalAllowedValues(
  value: unknown,
  allowed: readonly string[],
  fieldName: string,
): string[] {
  const normalized = parseAllowedValueTokens(value);
  const invalid = normalized.find(
    (item) => !allowed.includes(item) && !isLikelyBitableOptionId(item),
  );
  if (invalid) {
    throw new Error(`${fieldName}不支持：${invalid}`);
  }
  return Array.from(
    new Set(normalized.filter((item) => allowed.includes(item))),
  );
}

function parseAllowedValueTokens(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? parseJsonArrayOrSingle(value)
      : [];
  return values.map((item) => String(item || '').trim()).filter(Boolean);
}

function isLikelyBitableOptionId(value: string): boolean {
  return /^opt[A-Za-z0-9_-]+$/.test(value.trim());
}

function normalizeRequiredUserIds(value: unknown, fieldName: string): string[] {
  const ids = normalizeOptionalUserIds(value);
  if (ids.length === 0) {
    throw new Error(`${fieldName}不能为空`);
  }
  return ids;
}

function normalizeOptionalUserIds(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? parseJsonArrayOrSingle(value)
      : [];

  return Array.from(
    new Set(values.map((item) => String(item || '').trim()).filter(Boolean)),
  );
}

function normalizeDailyPersonnelCheckParticipants(
  value: unknown,
): ConstructionDailyPersonnelCheckParticipant[] {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? parseJsonArrayOrSingle(value)
      : [];
  const participants = rawItems
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null;
      }
      const record = item as Record<string, unknown>;
      const name = normalizeOptionalText(record.name);
      if (!name) {
        return null;
      }
      return {
        recordId: normalizeOptionalText(record.recordId) || name,
        name,
        certificateSummary: normalizeOptionalText(record.certificateSummary),
        complianceStatus: normalizeOptionalText(record.complianceStatus),
        issueSummary: normalizeOptionalText(record.issueSummary),
      };
    })
    .filter((item): item is ConstructionDailyPersonnelCheckParticipant =>
      Boolean(item),
    );
  const seen = new Set<string>();
  return participants.filter((item) => {
    const key = `${item.recordId}|${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parseJsonArrayOrSingle(value: string): unknown[] {
  const text = value.trim();
  if (!text) {
    return [];
  }
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [text];
    }
  }
  return text.split(/[,，、;；]/);
}

function normalizeOptionalNumber(
  value: unknown,
  fieldName: string,
): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed =
    typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) {
    throw new Error(`${fieldName}必须是数字`);
  }
  return parsed;
}

function parseShanghaiDateTimeMs(value: string, fieldName: string): number {
  const text = value.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(text)
    ? `${text}:00+08:00`
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(text)
      ? `${text.replace(' ', 'T')}:00+08:00`
      : /^\d{4}-\d{2}-\d{2}$/.test(text)
        ? `${text}T00:00:00+08:00`
        : text;
  const date = new Date(normalized);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`${fieldName}格式不正确`);
  }
  return date.getTime();
}

function getRecordId(record: ConstructionBitableRecordItem): string {
  return record.record_id || record.id || '';
}

function pickField(
  fields: Record<string, unknown>,
  names: readonly string[],
): unknown {
  for (const name of names) {
    const value = fields[name];
    if (isPresent(value)) {
      return value;
    }
  }
  return undefined;
}

function extractConstructionCode(
  fields: Record<string, unknown>,
): string | null {
  return (
    extractDisplayText(pickField(fields, CONSTRUCTION_CODE_FIELDS)) || null
  );
}

function extractJsonObjectText(content: string): string {
  const text = String(content || '').trim();
  if (!text) {
    throw new Error('视觉审核结果为空');
  }
  if (text.startsWith('{') && text.endsWith('}')) {
    return text;
  }
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return extractJsonObjectText(fenced[1]);
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return text.slice(start, end + 1);
  }
  throw new Error('视觉审核结果不是 JSON');
}

function normalizeStringArray(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input
      .map((item) => normalizeOptionalText(item))
      .filter((item): item is string => Boolean(item));
  }
  const text = normalizeOptionalText(input);
  return text ? extractDisplayValues(text) : [];
}

function normalizeOptionalBoolean(input: unknown): boolean | null {
  if (typeof input === 'boolean') {
    return input;
  }
  const text = normalizeOptionalText(input);
  if (!text) {
    return null;
  }
  if (/^(true|yes|pass|通过|是|有|已识别|识别到|可见)$/i.test(text)) {
    return true;
  }
  if (/^(false|no|fail|不通过|否|无|未识别|不可见|缺失)$/i.test(text)) {
    return false;
  }
  return null;
}

function extractFollowupStaffMembers(
  field: unknown,
): ConstructionFollowupStaffMember[] {
  const rawItems = flattenUserFieldItems(field);
  const members = rawItems
    .map((item) => {
      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>;
        const id = extractDisplayText(
          pickField(record, ['id', 'open_id', 'user_id', 'union_id']),
        );
        const name = extractDisplayText(item);
        return id && name ? { id, name } : null;
      }

      return null;
    })
    .filter((item): item is ConstructionFollowupStaffMember => Boolean(item));

  const seen = new Set<string>();
  return members.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function flattenUserFieldItems(field: unknown): unknown[] {
  if (!isPresent(field)) {
    return [];
  }
  if (Array.isArray(field)) {
    return field.flatMap(flattenUserFieldItems);
  }
  if (typeof field === 'object' && field !== null) {
    const obj = field as Record<string, unknown>;
    if (Array.isArray(obj.users)) {
      return obj.users.flatMap(flattenUserFieldItems);
    }
  }
  return [field];
}

function extractDisplayText(field: unknown, separator = '、'): string {
  return extractDisplayValues(field).join(separator);
}

function extractDisplayValues(field: unknown): string[] {
  return dedupe(extractDisplayValuesInner(field));
}

function extractNumberValue(field: unknown): number | null {
  if (typeof field === 'number' && Number.isFinite(field)) {
    return field;
  }
  const text = extractDisplayText(field, '');
  if (!text) {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractDateTimeIso(field: unknown): string | null {
  if (!isPresent(field)) {
    return null;
  }
  if (typeof field === 'number') {
    return new Date(field).toISOString();
  }
  if (typeof field === 'string') {
    const text = field.trim();
    if (!text) {
      return null;
    }
    if (/^\d{13}$/.test(text)) {
      return new Date(Number(text)).toISOString();
    }
    if (/^\d{10}$/.test(text)) {
      return new Date(Number(text) * 1000).toISOString();
    }
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(text)
      ? text.replace(' ', 'T') + '+08:00'
      : text;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof field === 'object' && field !== null) {
    const obj = field as Record<string, unknown>;
    for (const key of ['timestamp', 'date', 'text', 'value']) {
      const parsed = extractDateTimeIso(obj[key]);
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

function extractDisplayValuesInner(field: unknown): string[] {
  if (!isPresent(field)) {
    return [];
  }
  if (Array.isArray(field)) {
    return field.flatMap(extractDisplayValuesInner);
  }
  if (typeof field === 'string') {
    return field
      .split(/[,，、;；\n\r]+/)
      .map((value) => value.trim())
      .filter(Boolean);
  }
  if (typeof field === 'number' || typeof field === 'boolean') {
    return [String(field)];
  }
  if (typeof field === 'object' && field !== null) {
    const obj = field as Record<string, unknown>;
    if (isPresent(obj.select)) {
      return extractDisplayValuesInner(obj.select);
    }
    if (Array.isArray(obj.users)) {
      return obj.users.flatMap(extractDisplayValuesInner);
    }
    for (const key of [
      'name',
      'file_name',
      'en_name',
      'text',
      'label',
      'user_name',
      'avatar_name',
      'value',
      'title',
    ]) {
      if (isPresent(obj[key])) {
        return extractDisplayValuesInner(obj[key]);
      }
    }
  }
  return [];
}

function isPresent(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (!value || seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}
