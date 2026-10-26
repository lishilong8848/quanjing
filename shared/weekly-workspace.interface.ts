import type { MeetingSummary } from './meeting-management.interface';
export type WeeklyMeetingKind = 'ali' | 'local';
export type WeeklyMeetingStatus =
  | 'planned'
  | 'held'
  | 'postponed'
  | 'cancelled';
export interface WeeklyTodo {
  id: string;
  content: string;
  ownerOpenId: string;
  ownerName: string;
  dueDate: string;
  status: 'pending' | 'done';
}
export interface WeeklyMeetingInput {
  targetRecordId: string;
  kind: WeeklyMeetingKind;
  plannedDate: string;
  actualDate: string;
  status: WeeklyMeetingStatus;
  note: string;
  todos: WeeklyTodo[];
  rawText?: string;
}
export interface WeeklyMeetingEntry extends WeeklyMeetingInput {
  id: string;
  version: number;
  updatedAt: string;
  mutationId: string;
}
export type WeeklyJobStage =
  | 'queued'
  | 'row-create'
  | 'prepare'
  | 'create'
  | 'document'
  | 'permissions'
  | 'archive'
  | 'attachments'
  | 'done';
export interface WeeklyJob {
  notification?: {
    status: 'pending' | 'sending' | 'success' | 'error' | 'uncertain';
    chatId: string;
    uuid: string;
    link?: string;
    attempts: number;
    firstAttemptAt?: string;
    messageId?: string;
    mayHaveSent?: boolean;
    error: string | null;
  };
  id: string;
  kind: 'meeting' | 'generate' | 'action-edit' | 'attachments';
  targetRecordId: string;
  status:
    | 'accepted'
    | 'running'
    | 'success'
    | 'error'
    | 'uncertain'
    | 'deleting'
    | 'deleted';
  deletion?: {
    clientMutationId: string;
    status: 'checking' | 'success' | 'error' | 'restored';
    previousStatus: 'error' | 'uncertain';
    requestedAt: string;
    completedAt?: string;
    error: string | null;
  };
  stage: WeeklyJobStage;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  documentUrl?: string;
  meeting?: WeeklyMeetingEntry;
  startDate?: string;
  endDate?: string;
  createOnly?: boolean;
  attachmentNames?: string[];
  record?: MeetingSummary;
  actionResult?: {
    actionId: string;
    content: string;
    assignee?: ActionAssignee;
  };
}
export type ActionAssignee =
  | { kind: 'employee'; openId: string; name: string }
  | { kind: 'custom'; name: string }
  | { kind: 'unassigned' };
export interface EditMeetingAction {
  clientMutationId: string;
  targetRecordId: string;
  actionId: string;
  expectedContent: string;
  content: string;
  assignee?: ActionAssignee;
}
export interface PreparedActionEdit extends EditMeetingAction {
  field: string;
  expectedText: string;
  desiredText: string;
  desiredContent: string;
}
export interface WeeklyAttachmentCommand {
  clientMutationId: string;
  targetRecordId: string;
  kind: WeeklyMeetingKind;
  baseJobId: string;
  files: { sha256: string; name: string; mime: string; size: number }[];
}
export interface WeeklyWorkspace {
  meetings: WeeklyMeetingEntry[];
  jobs: WeeklyJob[];
  people: {
    openId: string;
    name: string;
    buildings?: string[];
    position?: string;
    employeeNo?: string | null;
  }[];
  peopleError: string | null;
  writeAccess?: { enabled: boolean; message: string | null };
  runtime: { ready: boolean; message: string | null; templateVersion: string };
  schedule: {
    enabled: boolean;
    time: string;
    weekday: number;
    timezone: 'Asia/Shanghai';
    message?: string | null;
  };
  creationSchedule?: {
    enabled: boolean;
    time: string;
    timezone: 'Asia/Shanghai';
    message?: string | null;
  };
}
export interface SaveWeeklyMeeting {
  todoOnly?: boolean;
  clientMutationId: string;
  expectedVersion: number;
  expectedText: string;
  meeting: WeeklyMeetingInput;
}
export interface GenerateWeeklyReport {
  clientMutationId: string;
  targetRecordId: string;
  startDate: string;
  endDate: string;
  expectedDocumentUrl: string | null;
  createOnly?: boolean;
  confirmedNoTodos?: boolean;
}
