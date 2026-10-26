export type TrainingMetricKey =
  | 'annualCompletedCourses'
  | 'monthlyPlannedCourses'
  | 'monthlyParticipants'
  | 'monthlyNewHires'
  | 'historicalSharingSessions'
  | 'monthlyPlannedSharingSessions';

export type TrainingSummary = Record<TrainingMetricKey, number>;

export interface TrainingMetricComparison {
  change: number;
  direction: 'up' | 'down';
  favorable: boolean;
}

export interface BuildingTrainingProgress {
  building: string;
  planned: number;
  completed: number;
  rate: number;
}

export interface TrainingParticipation {
  building: string;
  people: number;
  target: number;
  trainingCompletionRate: number;
  assessmentPassRate: number | null;
}

export interface NewHirePlan {
  id: string;
  name: string;
  building: string;
  joinedAt: string | null;
  assessmentDueAt: string | null;
  requiredCourses: number;
  completedCourses: number;
  progress: number;
  finalScore: number | null;
}

export type SharingTone = 'blue' | 'teal' | 'orange' | 'purple';

export interface SharingCategory {
  key: string;
  label: string;
  sessions: number;
  percentage: number;
  tone: SharingTone;
}

export interface SharingTrendPoint {
  month: string;
  sessions: number;
}

export interface SharingInterest {
  label: string;
  submissions: number;
}

export interface SharingOverview {
  categories: SharingCategory[];
  trend: SharingTrendPoint[];
  participants: number;
  totalHours: number;
  satisfaction: number;
  materials: number;
  interests: SharingInterest[];
}

export interface TrainingCourseDetail {
  id: string;
  rank: number;
  category: string;
  course: string;
  instructor: string;
  completionRate: number;
}

export type TrainingAssessmentStatus =
  | 'passed'
  | 'failed'
  | 'pending'
  | 'absent';

export interface TrainingAssessmentDetail {
  id: string;
  course: string;
  score: number | null;
  signedIn: boolean | null;
  status: TrainingAssessmentStatus;
}

export interface TrainingParticipantDetail {
  id: string;
  name: string;
  building: string;
  totalCourses: number;
  passedCourses: number;
  failedCourses: number;
  pendingCourses: number;
  absentCourses: number;
  averageScore: number | null;
  assessments: TrainingAssessmentDetail[];
}

export interface ActiveTrainingCoursePlanDetail {
  id: string;
  month: string;
  building: string;
  course: string;
  status: string;
  assignedParticipants: number;
  actualParticipants: number;
  completedAt: string | null;
}

export interface TrainingSharingSessionDetail {
  id: string;
  month: string;
  topic: string;
  category: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  presenterNames: string[];
  participantCount: number;
  buildings: string[];
  durationHours: number;
  hasMaterial: boolean;
}

export interface TrainingDashboardDetails {
  assessmentPassScore: number;
  activeCoursePlans: ActiveTrainingCoursePlanDetail[];
  participants: TrainingParticipantDetail[];
  newHires: NewHirePlan[];
  sharingSessions: TrainingSharingSessionDetail[];
  reconciliationNotes: string[];
}

export interface CampusTrainingDashboardResponse {
  month: string;
  availableMonths: string[];
  summary: TrainingSummary;
  metricComparisons: Record<TrainingMetricKey, TrainingMetricComparison>;
  metricTrends: Record<TrainingMetricKey, number[]>;
  progress: BuildingTrainingProgress[];
  participation: TrainingParticipation[];
  newHirePlans: NewHirePlan[];
  sharing: SharingOverview;
  courses: TrainingCourseDetail[];
  details: TrainingDashboardDetails;
  sourceUpdatedAt: string | null;
  syncedAt: string;
  sourceStatus: 'fresh' | 'stale';
  dataStatus: 'ready' | 'empty';
  errorMessage?: string;
}
