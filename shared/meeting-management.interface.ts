export const MEETING_SCOPES = [
  '客户',
  '机房',
  '区域',
  '总部',
  '运维部',
] as const;
export const MEETING_NATURES = [
  '管理类',
  '专业类',
  '培训类',
  '未分类',
] as const;
export type MeetingScope = (typeof MEETING_SCOPES)[number] | '未分类';
export type MeetingNature = (typeof MEETING_NATURES)[number];
export type MeetingSource = 'nantong-weekly' | 'training' | 'ali-meeting';
export interface MeetingResource {
  kind: 'minutes' | 'slides' | 'replay' | 'materials' | 'meeting';
  label: string;
  url: string;
}
export interface MeetingPerson {
  id: string;
  name: string;
}
export interface MeetingSourceState {
  source: MeetingSource;
  count: number | null;
  state: 'ready' | 'refreshing' | 'error';
  updatedAt: string | null;
  message: string | null;
}

export interface MeetingSection {
  key: string;
  title: string;
  content: string;
  isAction: boolean;
  origin?: 'document';
}

export interface MeetingSummary {
  id: string;
  title: string;
  date: string | null;
  weekLabel: string | null;
  scope: MeetingScope;
  nature: MeetingNature;
  source: MeetingSource;
  subtype?: string;
  startAt?: string | null;
  endAt?: string | null;
  presenters?: MeetingPerson[];
  owners?: MeetingPerson[];
  specialties?: string[];
  status?: string;
  participantCount?: number | null;
  resources?: MeetingResource[];
  attachmentNames?: string[];
  sourceUrl?: string;
  warnings?: string[];
  documentUrl: string | null;
  updatedAt: string | null;
  hasActions: boolean;
  sectionTitles: string[];
  searchText: string;
  excerpt?: string;
}

export interface MeetingDetail extends Omit<MeetingSummary, 'searchText'> {
  sections: MeetingSection[];
}

export interface MeetingSnapshot {
  snapshotId: string;
  updatedAt: string;
  syncState: 'ready' | 'refreshing' | 'error';
  message: string | null;
  records: MeetingSummary[];
  latestActions?: MeetingLatestActions | null;
  sources?: MeetingSourceState[];
}

export interface MeetingAction {
  assignee?: import('./weekly-workspace.interface').ActionAssignee;
  id: string;
  content: string;
  responsible: string | null;
  mentionedPeople: string[];
  buildings: string[];
  dueText: string | null;
  sourceRecordId: string;
  sourceTitle: string;
  sourceDate: string | null;
  sectionTitle: string;
}

export interface MeetingLatestActions {
  date: string | null;
  newestReportDate: string | null;
  items: MeetingAction[];
}

export interface MeetingDetailResponse {
  snapshotId: string;
  meeting: MeetingDetail;
  latestActions?: MeetingLatestActions | null;
  documentState?: 'loading' | 'ready' | 'error';
  documentMessage?: string;
}
