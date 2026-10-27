import { readEnv } from '../../common/config/external-services.config';

export type TrainingSourceKey =
  | 'activeStats'
  | 'activeScores'
  | 'activePlans'
  | 'newHireScores'
  | 'newHireCourses'
  | 'newHirePlans'
  | 'sharingSessions'
  | 'sharingScores'
  | 'sharingInterests';

export interface TrainingTableConfig {
  key: TrainingSourceKey;
  envKey: string;
  defaultTableId: string;
  tableName: string;
  fieldNames: readonly string[];
  qualityFieldGroups: readonly (readonly string[])[];
  allowEmpty: boolean;
}

const ACTIVE_STATS_FIELDS = [
  '年份',
  '月份',
  '楼栋',
  '本月需考核课程数量',
  '本月培训课程数量',
  '已完成考核的课程数量',
  '考试人数（2026）',
  '已完成培训课程数量',
  '培训人数',
  '培训人数（2026）',
  '🧑在岗员工培训人数',
  '培训完成率',
  '考核达标率',
  '累计-已完成培训数量',
] as const;

export const TRAINING_ACTIVE_EMPLOYEE_TEXT_FIELD = '员工 （文本）';

const ACTIVE_SCORE_FIELDS = [
  TRAINING_ACTIVE_EMPLOYEE_TEXT_FIELD,
  '课程',
  '考试分数',
  '签到',
  '楼栋',
  '月份',
  '月份（计划）',
] as const;

const ACTIVE_PLAN_FIELDS = [
  '培训课程名称',
  '培训年份',
  '培训月份',
  '楼栋/专业',
  '在岗员工培训对应人员',
  '在岗员工培训对应人员（公式）',
  '实际参与培训人',
  '培训状态（此格为系统修改）',
  '培训考核完成时间',
] as const;

const NEW_HIRE_SCORE_FIELDS = [
  '新员工',
  '人员',
  '人员（文本）',
  '楼栋',
  '入职日期',
  '计划考核截止日期',
  '需培训课程数量',
  '已培训课程数量',
  '培训进度（2026）',
  '最终考核成绩（旧）',
  '备注',
] as const;

const NEW_HIRE_COURSE_FIELDS = [
  '培训课程名称',
  '课程大类',
  '讲师',
  '讲师岗位',
  '计划培训开始时间',
  '计划培训结束时间',
  '考核方式（理论考试需对应考题题库）',
] as const;

const NEW_HIRE_PLAN_FIELDS = [
  '学员',
  '学员名字（文本）',
  '楼栋名称',
  '培训课程名称（考核类型为理论考核的需与题库中的名称一致）',
  '培训课程',
  '新员工第（）周培训',
  '课程大类',
  '流程状态',
  '培训进度（南通）',
  '培训考核完成时间',
  '📆周培训计划开始日期',
  '📆周培训计划截止日期',
] as const;

const SHARING_SESSION_FIELDS = [
  '分享主题',
  '分享类型',
  '会议进度（勿动）',
  '开始时间',
  '结束时间',
  '月度',
  '分享人',
  '参会人 (人员 )',
  '楼栋&专业（多选）',
  '演示文档/PPT（链接）',
  '会议回放&妙记链接',
] as const;

const SHARING_SCORE_FIELDS = ['评分员', '评分', '分享人', '主题名'] as const;

const SHARING_INTEREST_FIELDS = ['兴趣板块', '提交人'] as const;

export const DEFAULT_TRAINING_WIKI_TOKEN = 'P8R2w5FXRiNpBjkJ3WVcegJ0nzh';

export const TRAINING_TABLE_CONFIGS: readonly TrainingTableConfig[] = [
  {
    key: 'activeStats',
    envKey: 'FEISHU_TRAINING_ACTIVE_STATS_TABLE_ID',
    defaultTableId: 'tblACdnEXt1FVcPV',
    tableName: '在岗员工-培训情况统计表',
    fieldNames: ACTIVE_STATS_FIELDS,
    qualityFieldGroups: [['年份', '月份', '楼栋']],
    allowEmpty: false,
  },
  {
    key: 'activeScores',
    envKey: 'FEISHU_TRAINING_ACTIVE_SCORES_TABLE_ID',
    defaultTableId: 'tblvFrkTTUvyRaYT',
    tableName: '在岗员工成绩表',
    fieldNames: ACTIVE_SCORE_FIELDS,
    qualityFieldGroups: [
      [TRAINING_ACTIVE_EMPLOYEE_TEXT_FIELD, '楼栋', '月份（计划）'],
      [TRAINING_ACTIVE_EMPLOYEE_TEXT_FIELD, '楼栋', '月份'],
      ['员工', '楼栋', '月份（计划）'],
      ['员工', '楼栋', '月份'],
    ],
    allowEmpty: false,
  },
  {
    key: 'activePlans',
    envKey: 'FEISHU_TRAINING_ACTIVE_PLANS_TABLE_ID',
    defaultTableId: 'tbla7aC5nOPj883v',
    tableName: '在岗员工-培训考核计划',
    fieldNames: ACTIVE_PLAN_FIELDS,
    qualityFieldGroups: [['培训课程名称', '培训年份', '培训月份']],
    allowEmpty: false,
  },
  {
    key: 'newHireScores',
    envKey: 'FEISHU_TRAINING_NEW_HIRE_SCORES_TABLE_ID',
    defaultTableId: 'tblRY4ltGUfJCvk2',
    tableName: '新员工培训情况成绩表',
    fieldNames: NEW_HIRE_SCORE_FIELDS,
    qualityFieldGroups: [
      ['人员', '入职日期'],
      ['新员工', '入职日期'],
      ['人员（文本）', '入职日期'],
    ],
    allowEmpty: false,
  },
  {
    key: 'newHireCourses',
    envKey: 'FEISHU_TRAINING_NEW_HIRE_COURSES_TABLE_ID',
    defaultTableId: 'tbluLOjtntNXxNvI',
    tableName: '新员工课程配置表',
    fieldNames: NEW_HIRE_COURSE_FIELDS,
    qualityFieldGroups: [['培训课程名称']],
    allowEmpty: false,
  },
  {
    key: 'newHirePlans',
    envKey: 'FEISHU_TRAINING_NEW_HIRE_PLANS_TABLE_ID',
    defaultTableId: 'tbl4gx4y0Z29qj2H',
    tableName: '新员工-培训考核计划表',
    fieldNames: NEW_HIRE_PLAN_FIELDS,
    qualityFieldGroups: [
      ['学员', '培训课程名称（考核类型为理论考核的需与题库中的名称一致）'],
      ['学员', '培训课程'],
      [
        '学员名字（文本）',
        '培训课程名称（考核类型为理论考核的需与题库中的名称一致）',
      ],
      ['学员名字（文本）', '培训课程'],
    ],
    allowEmpty: false,
  },
  {
    key: 'sharingSessions',
    envKey: 'FEISHU_TRAINING_SHARING_SESSIONS_TABLE_ID',
    defaultTableId: 'tblXZ7YNmy1AxvTA',
    tableName: '分享表详情',
    fieldNames: SHARING_SESSION_FIELDS,
    qualityFieldGroups: [
      ['分享主题', '开始时间'],
      ['分享主题', '月度'],
    ],
    allowEmpty: false,
  },
  {
    key: 'sharingScores',
    envKey: 'FEISHU_TRAINING_SHARING_SCORES_TABLE_ID',
    defaultTableId: 'tblrqnf99IJCBUEa',
    tableName: '分享会评分详情',
    fieldNames: SHARING_SCORE_FIELDS,
    qualityFieldGroups: [['主题名', '评分']],
    allowEmpty: false,
  },
  {
    key: 'sharingInterests',
    envKey: 'FEISHU_TRAINING_SHARING_INTERESTS_TABLE_ID',
    defaultTableId: 'tblr2WJWFccRdZIm',
    tableName: '分享会兴趣盘',
    fieldNames: SHARING_INTEREST_FIELDS,
    qualityFieldGroups: [['兴趣板块']],
    allowEmpty: true,
  },
];

const DASHBOARD_SOURCE_KEYS = new Set<TrainingSourceKey>([
  'activeStats',
  'activeScores',
  'activePlans',
  'newHireScores',
  'sharingSessions',
  'sharingScores',
  'sharingInterests',
]);

export const TRAINING_DASHBOARD_TABLE_CONFIGS: readonly TrainingTableConfig[] =
  TRAINING_TABLE_CONFIGS.filter((config) =>
    DASHBOARD_SOURCE_KEYS.has(config.key),
  );

export function getTrainingTableId(config: TrainingTableConfig): string {
  return readEnv(config.envKey) || config.defaultTableId;
}
