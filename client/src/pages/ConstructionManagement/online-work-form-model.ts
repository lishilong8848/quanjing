export type OnlineWorkFormKind =
  | 'workApplication'
  | 'riskDisclosure'
  | 'trainingSignIn'
  | 'trainingAssessment'
  | 'permit';

export interface OnlineWorkFormTarget {
  fieldKey: string;
  label: string;
  workType: string;
  kind: OnlineWorkFormKind;
}

export interface OnlineWorkFormPerson {
  id: string;
  name: string;
  company: string;
  role: string;
  idCard: string;
  signature: string;
}

export interface OnlineWorkFormCrewMember {
  recordId: string;
  name: string;
  company?: string | null;
  phone?: string | null;
  certificateNo?: string | null;
  certificateSummary?: string | null;
  complianceStatus?: string | null;
  issueSummary?: string | null;
}

export interface OnlineWorkFormDraft {
  values: Record<string, string>;
  people: OnlineWorkFormPerson[];
  measures: string[];
  signatureDataUrl: string;
  updatedAt?: string;
}

export const ONLINE_WORK_FORM_BASE_VALUES: Record<string, string> = {
  formNo: '',
  projectName: '',
  contractor: '',
  workLocation: '',
  workContent: '',
  startDate: '',
  endDate: '',
  riskWorkEnvironment: '',
  riskDisclosureTime: '',
  riskDisclosureDate: '',
  riskHandwritingDataUrl: '',
  trainingCategory: '线下',
  trainer: '',
  disclosurePersonId: '',
  disclosurePerson: '',
  guardian: '',
  approver: '',
  assessmentTopic: '',
  assessmentResult: '',
  risks: '',
  controls: '',
  emergency: '',
  remarks: '',
  workPartyLeadId: '',
  workPartyLead: '',
  workPartyPhone: '',
  constructionCount: '',
  siteResponsibleId: '',
  siteResponsible: '',
  siteResponsiblePhone: '',
  park: '',
  building: '',
  floor: '',
  roomArea: '',
  materialStackPoint: '',
  specialWorks: '',
  energyCuts: '',
  equipmentDisabled: '',
  disabledEquipment: '',
  siteOwner: '',
  siteOwnerDate: '',
  siteOwnerOpinion: '',
  ehsReviewer: '',
  ehsReviewDate: '',
  ehsOpinion: '',
  levelOneApprover: '',
  levelOneDate: '',
  levelOneOpinion: '',
};

const DEFAULT_RISK_DISCLOSURE_PERSON_NAME = '示例人员010';

export const ONLINE_WORK_FORM_COMMON_MEASURES = [
  '作业范围已确认，现场已完成隔离和警示',
  '作业人员已接受安全交底并明确风险控制措施',
  '监护人员已到位，通讯和应急联系畅通',
  '个人防护用品齐全并按要求佩戴',
  '作业结束后清理现场并恢复安全状态',
] as const;

export const ONLINE_WORK_FORM_WORK_TYPE_MEASURES: Record<
  string,
  readonly string[]
> = {
  受限空间作业: [
    '已完成通风、检测和出入口管控',
    '受限空间外设置专人监护',
    '救援器材和应急撤离通道已确认',
  ],
  临时用电作业: [
    '配电箱、漏保、接地保护已检查',
    '电缆走向固定，避免破损和积水',
    '停送电示例人员019和操作范围已明确',
  ],
  动火作业: [
    '可燃物已清理或隔离',
    '消防器材已配置，现场具备灭火条件',
    '动火点周边气体和环境风险已复核',
  ],
  高处作业: [
    '登高设施稳固，临边洞口防护到位',
    '安全带挂点可靠，工具防坠措施到位',
    '恶劣天气和交叉作业风险已确认',
  ],
  开挖动土作业: [
    '地下管线和隐蔽设施已核查',
    '开挖区域围挡、警示和支护措施到位',
    '弃土、通行和排水措施已确认',
  ],
  吊装作业: [
    '吊具、索具和设备状态已检查',
    '吊装区域已警戒，指挥信号明确',
    '重物捆绑、试吊和回转范围已确认',
  ],
  消防系统关闭作业: [
    '关闭范围、影响区域和替代措施已确认',
    '消防值守和临时应急措施已安排',
    '恢复条件和复位示例人员019已明确',
  ],
};

export function getOnlineWorkFormTarget(
  workType: string,
  fieldKey: string,
  label: string,
): OnlineWorkFormTarget {
  return {
    fieldKey,
    label,
    workType,
    kind: inferOnlineWorkFormKind(fieldKey, label),
  };
}

function inferOnlineWorkFormKind(
  fieldKey: string,
  label: string,
): OnlineWorkFormKind {
  if (fieldKey === 'applicationFiles' || label.includes('施工作业申请')) {
    return 'workApplication';
  }
  if (fieldKey.includes('RiskDisclosure') || label.includes('风险交底')) {
    return 'riskDisclosure';
  }
  if (fieldKey.includes('TrainingSignIn') || label.includes('签到')) {
    return 'trainingSignIn';
  }
  if (fieldKey.includes('TrainingAssessment') || label.includes('考核')) {
    return 'trainingAssessment';
  }
  return 'permit';
}

export function createEmptyOnlineWorkFormDraft(
  target: OnlineWorkFormTarget,
): OnlineWorkFormDraft {
  return {
    values: {
      ...ONLINE_WORK_FORM_BASE_VALUES,
      workContent:
        target.kind === 'workApplication'
          ? '施工申请'
          : target.kind === 'trainingSignIn'
            ? `${target.workType}安全培训`
            : target.kind === 'trainingAssessment'
              ? `${target.workType}培训考核`
              : target.workType,
      assessmentTopic: `${target.workType}安全要求`,
      disclosurePerson:
        target.kind === 'riskDisclosure'
          ? DEFAULT_RISK_DISCLOSURE_PERSON_NAME
          : '',
    },
    people:
      target.kind === 'workApplication' ||
      target.kind === 'riskDisclosure' ||
      target.kind === 'trainingSignIn'
        ? []
        : [createEmptyOnlineWorkFormPerson()],
    measures:
      target.kind === 'permit'
        ? [
            ...ONLINE_WORK_FORM_COMMON_MEASURES,
            ...(ONLINE_WORK_FORM_WORK_TYPE_MEASURES[target.workType] || []),
          ]
        : [],
    signatureDataUrl: '',
  };
}

export function applyOnlineWorkFormTargetDefaults(
  target: OnlineWorkFormTarget,
  draft: OnlineWorkFormDraft,
): OnlineWorkFormDraft {
  if (target.kind !== 'riskDisclosure' || draft.values.disclosurePerson) {
    return draft;
  }

  return {
    ...draft,
    values: {
      ...draft.values,
      disclosurePerson: DEFAULT_RISK_DISCLOSURE_PERSON_NAME,
    },
  };
}

export function createEmptyOnlineWorkFormPerson(): OnlineWorkFormPerson {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: '',
    company: '',
    role: '',
    idCard: '',
    signature: '',
  };
}

export function createOnlineWorkFormPeopleFromCrewMembers(
  crewMembers: readonly OnlineWorkFormCrewMember[],
  existingPeople: readonly OnlineWorkFormPerson[] = [],
): OnlineWorkFormPerson[] {
  const existingById = new Map(
    existingPeople.map((person) => [person.id, person]),
  );
  return crewMembers.map((member) =>
    createOnlineWorkFormPersonFromCrewMember(
      member,
      existingById.get(member.recordId),
    ),
  );
}

export function createOnlineWorkFormPersonFromCrewMember(
  member: OnlineWorkFormCrewMember,
  existingPerson?: OnlineWorkFormPerson,
): OnlineWorkFormPerson {
  return {
    id: member.recordId,
    name: member.name,
    company: member.company || '',
    role:
      member.certificateSummary ||
      member.complianceStatus ||
      member.issueSummary ||
      existingPerson?.role ||
      '',
    idCard: member.certificateNo || existingPerson?.idCard || '',
    signature: existingPerson?.signature || '',
  };
}
