import type {
  ActiveTrainingCoursePlanDetail,
  BuildingTrainingProgress,
  CampusTrainingDashboardResponse,
  NewHirePlan,
  SharingCategory,
  SharingInterest,
  SharingOverview,
  SharingTrendPoint,
  TrainingAssessmentDetail,
  TrainingDashboardDetails,
  TrainingCourseDetail,
  TrainingMetricComparison,
  TrainingMetricKey,
  TrainingParticipantDetail,
  TrainingParticipation,
  TrainingSharingSessionDetail,
  TrainingSummary,
} from '@shared/campus-training-dashboard.interface';

export type {
  ActiveTrainingCoursePlanDetail,
  BuildingTrainingProgress,
  CampusTrainingDashboardResponse,
  NewHirePlan,
  SharingCategory,
  SharingInterest,
  SharingOverview,
  SharingTone,
  SharingTrendPoint,
  TrainingAssessmentDetail,
  TrainingAssessmentStatus,
  TrainingDashboardDetails,
  TrainingCourseDetail,
  TrainingMetricComparison,
  TrainingMetricKey,
  TrainingParticipantDetail,
  TrainingParticipation,
  TrainingSharingSessionDetail,
  TrainingSummary,
} from '@shared/campus-training-dashboard.interface';

const TRAINING_MONTH_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const TRAINING_METRIC_KEYS: readonly TrainingMetricKey[] = [
  'annualCompletedCourses',
  'monthlyPlannedCourses',
  'monthlyParticipants',
  'monthlyNewHires',
  'historicalSharingSessions',
  'monthlyPlannedSharingSessions',
];
const SHARING_TONES = new Set(['blue', 'teal', 'orange', 'purple']);
const TRAINING_ASSESSMENT_STATUSES = new Set([
  'passed',
  'failed',
  'pending',
  'absent',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringOrNull(value: unknown): value is string | null {
  return typeof value === 'string' || value === null;
}

function hasFiniteMetricValues(value: unknown): value is TrainingSummary {
  return (
    isRecord(value) &&
    TRAINING_METRIC_KEYS.every((key) => isFiniteNumber(value[key]))
  );
}

function isMetricComparison(value: unknown): value is TrainingMetricComparison {
  return (
    isRecord(value) &&
    isFiniteNumber(value.change) &&
    (value.direction === 'up' || value.direction === 'down') &&
    typeof value.favorable === 'boolean'
  );
}

function hasMetricComparisons(
  value: unknown,
): value is CampusTrainingDashboardResponse['metricComparisons'] {
  return (
    isRecord(value) &&
    TRAINING_METRIC_KEYS.every((key) => isMetricComparison(value[key]))
  );
}

function hasMetricTrends(
  value: unknown,
): value is CampusTrainingDashboardResponse['metricTrends'] {
  return (
    isRecord(value) &&
    TRAINING_METRIC_KEYS.every(
      (key) =>
        Array.isArray(value[key]) &&
        value[key].every((item) => isFiniteNumber(item)),
    )
  );
}

function isBuildingProgress(value: unknown): value is BuildingTrainingProgress {
  return (
    isRecord(value) &&
    typeof value.building === 'string' &&
    isFiniteNumber(value.planned) &&
    isFiniteNumber(value.completed) &&
    isFiniteNumber(value.rate)
  );
}

function isParticipation(value: unknown): value is TrainingParticipation {
  return (
    isRecord(value) &&
    typeof value.building === 'string' &&
    isFiniteNumber(value.people) &&
    isFiniteNumber(value.target) &&
    isFiniteNumber(value.trainingCompletionRate) &&
    (isFiniteNumber(value.assessmentPassRate) ||
      value.assessmentPassRate === null)
  );
}

function isNewHirePlan(value: unknown): value is NewHirePlan {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.building === 'string' &&
    isStringOrNull(value.joinedAt) &&
    isStringOrNull(value.assessmentDueAt) &&
    isFiniteNumber(value.requiredCourses) &&
    isFiniteNumber(value.completedCourses) &&
    isFiniteNumber(value.progress) &&
    (isFiniteNumber(value.finalScore) || value.finalScore === null)
  );
}

function isSharingCategory(value: unknown): value is SharingCategory {
  return (
    isRecord(value) &&
    typeof value.key === 'string' &&
    typeof value.label === 'string' &&
    isFiniteNumber(value.sessions) &&
    isFiniteNumber(value.percentage) &&
    typeof value.tone === 'string' &&
    SHARING_TONES.has(value.tone)
  );
}

function isSharingTrendPoint(value: unknown): value is SharingTrendPoint {
  return (
    isRecord(value) &&
    typeof value.month === 'string' &&
    isFiniteNumber(value.sessions)
  );
}

function isSharingInterest(value: unknown): value is SharingInterest {
  return (
    isRecord(value) &&
    typeof value.label === 'string' &&
    isFiniteNumber(value.submissions)
  );
}

function isSharingOverview(value: unknown): value is SharingOverview {
  return (
    isRecord(value) &&
    Array.isArray(value.categories) &&
    value.categories.every(isSharingCategory) &&
    Array.isArray(value.trend) &&
    value.trend.every(isSharingTrendPoint) &&
    isFiniteNumber(value.participants) &&
    isFiniteNumber(value.totalHours) &&
    isFiniteNumber(value.satisfaction) &&
    isFiniteNumber(value.materials) &&
    Array.isArray(value.interests) &&
    value.interests.every(isSharingInterest)
  );
}

function isCourse(value: unknown): value is TrainingCourseDetail {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isFiniteNumber(value.rank) &&
    typeof value.category === 'string' &&
    typeof value.course === 'string' &&
    typeof value.instructor === 'string' &&
    isFiniteNumber(value.completionRate)
  );
}

function isTrainingAssessmentDetail(
  value: unknown,
): value is TrainingAssessmentDetail {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.course === 'string' &&
    (isFiniteNumber(value.score) || value.score === null) &&
    (typeof value.signedIn === 'boolean' || value.signedIn === null) &&
    typeof value.status === 'string' &&
    TRAINING_ASSESSMENT_STATUSES.has(value.status)
  );
}

function isTrainingParticipantDetail(
  value: unknown,
): value is TrainingParticipantDetail {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.building === 'string' &&
    isFiniteNumber(value.totalCourses) &&
    isFiniteNumber(value.passedCourses) &&
    isFiniteNumber(value.failedCourses) &&
    isFiniteNumber(value.pendingCourses) &&
    isFiniteNumber(value.absentCourses) &&
    (isFiniteNumber(value.averageScore) || value.averageScore === null) &&
    Array.isArray(value.assessments) &&
    value.assessments.every(isTrainingAssessmentDetail)
  );
}

function isActiveTrainingCoursePlanDetail(
  value: unknown,
): value is ActiveTrainingCoursePlanDetail {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isTrainingMonth(value.month) &&
    typeof value.building === 'string' &&
    typeof value.course === 'string' &&
    typeof value.status === 'string' &&
    isFiniteNumber(value.assignedParticipants) &&
    isFiniteNumber(value.actualParticipants) &&
    isStringOrNull(value.completedAt)
  );
}

function isTrainingSharingSessionDetail(
  value: unknown,
): value is TrainingSharingSessionDetail {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    isTrainingMonth(value.month) &&
    typeof value.topic === 'string' &&
    typeof value.category === 'string' &&
    typeof value.status === 'string' &&
    isStringOrNull(value.startedAt) &&
    isStringOrNull(value.endedAt) &&
    Array.isArray(value.presenterNames) &&
    value.presenterNames.every((item) => typeof item === 'string') &&
    isFiniteNumber(value.participantCount) &&
    Array.isArray(value.buildings) &&
    value.buildings.every((item) => typeof item === 'string') &&
    isFiniteNumber(value.durationHours) &&
    typeof value.hasMaterial === 'boolean'
  );
}

function isTrainingDashboardDetails(
  value: unknown,
): value is TrainingDashboardDetails {
  return (
    isRecord(value) &&
    isFiniteNumber(value.assessmentPassScore) &&
    Array.isArray(value.activeCoursePlans) &&
    value.activeCoursePlans.every(isActiveTrainingCoursePlanDetail) &&
    Array.isArray(value.participants) &&
    value.participants.every(isTrainingParticipantDetail) &&
    Array.isArray(value.newHires) &&
    value.newHires.every(isNewHirePlan) &&
    Array.isArray(value.sharingSessions) &&
    value.sharingSessions.every(isTrainingSharingSessionDetail) &&
    Array.isArray(value.reconciliationNotes) &&
    value.reconciliationNotes.every((item) => typeof item === 'string')
  );
}

export function isTrainingMonth(value: unknown): value is string {
  return typeof value === 'string' && TRAINING_MONTH_PATTERN.test(value);
}

export function currentTrainingMonth(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}`;
}

export function isCampusTrainingDashboardResponse(
  value: unknown,
): value is CampusTrainingDashboardResponse {
  return (
    isRecord(value) &&
    isTrainingMonth(value.month) &&
    Array.isArray(value.availableMonths) &&
    value.availableMonths.every(isTrainingMonth) &&
    hasFiniteMetricValues(value.summary) &&
    hasMetricComparisons(value.metricComparisons) &&
    hasMetricTrends(value.metricTrends) &&
    Array.isArray(value.progress) &&
    value.progress.every(isBuildingProgress) &&
    Array.isArray(value.participation) &&
    value.participation.every(isParticipation) &&
    Array.isArray(value.newHirePlans) &&
    value.newHirePlans.every(isNewHirePlan) &&
    isSharingOverview(value.sharing) &&
    Array.isArray(value.courses) &&
    value.courses.every(isCourse) &&
    isTrainingDashboardDetails(value.details) &&
    isStringOrNull(value.sourceUpdatedAt) &&
    typeof value.syncedAt === 'string' &&
    (value.sourceStatus === 'fresh' || value.sourceStatus === 'stale') &&
    (value.dataStatus === 'ready' || value.dataStatus === 'empty') &&
    (value.errorMessage === undefined || typeof value.errorMessage === 'string')
  );
}

export function formatTrainingMonth(value: unknown): string {
  return isTrainingMonth(value) ? value : '未知月份';
}

export function safeRate(value: number, total: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(total) || total <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

export function chartMax(values: readonly number[]): number {
  const finiteValues = values.filter(
    (value) => Number.isFinite(value) && value >= 0,
  );
  return finiteValues.length > 0 ? Math.max(1, ...finiteValues) : 1;
}
