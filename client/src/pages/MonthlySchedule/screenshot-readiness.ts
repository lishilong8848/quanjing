export type DutyOverviewScreenshotLoadState = 'loading' | 'ready' | 'error';

export type DutyOverviewScreenshotSection =
  | 'schedules'
  | 'sealings'
  | 'changes'
  | 'personProfiles'
  | 'weatherWidget'
  | 'weatherTrend'
  | 'personnelMovements'
  | 'emergencyDuty';

export type DutyOverviewScreenshotReadiness = Record<
  DutyOverviewScreenshotSection,
  DutyOverviewScreenshotLoadState
>;

const DUTY_OVERVIEW_SCREENSHOT_SECTIONS: DutyOverviewScreenshotSection[] = [
  'schedules',
  'sealings',
  'changes',
  'personProfiles',
  'weatherWidget',
  'weatherTrend',
  'personnelMovements',
  'emergencyDuty',
];

export interface DutyOverviewAbortControllerSlot {
  current: AbortController | null;
}

export function beginLatestDutyOverviewRequest(
  slot: DutyOverviewAbortControllerSlot,
): AbortController {
  slot.current?.abort();
  const controller = new AbortController();
  slot.current = controller;
  return controller;
}

export function createDutyOverviewScreenshotReadiness(): DutyOverviewScreenshotReadiness {
  return {
    schedules: 'loading',
    sealings: 'loading',
    changes: 'loading',
    personProfiles: 'loading',
    weatherWidget: 'loading',
    weatherTrend: 'loading',
    personnelMovements: 'loading',
    emergencyDuty: 'loading',
  };
}

export function resetDutyOverviewScreenshotReadinessForDate(
  previous: DutyOverviewScreenshotReadiness,
  weatherState: DutyOverviewScreenshotLoadState,
): DutyOverviewScreenshotReadiness {
  return {
    ...createDutyOverviewScreenshotReadiness(),
    personProfiles: previous.personProfiles,
    weatherWidget: weatherState,
    weatherTrend: weatherState,
  };
}

export function isDutyOverviewScreenshotReady(
  readiness: DutyOverviewScreenshotReadiness,
): boolean {
  return DUTY_OVERVIEW_SCREENSHOT_SECTIONS.every((section) =>
    section === 'emergencyDuty'
      ? readiness[section] !== 'loading'
      : readiness[section] === 'ready',
  );
}
