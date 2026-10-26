export const DEFAULT_PREVIEW_ZOOM = 1;
export const MIN_PREVIEW_ZOOM = 0.5;
export const MAX_PREVIEW_ZOOM = 2.5;
const PREVIEW_ZOOM_STEP = 0.1;
const MANIFEST_RETRY_DELAYS_MS = [2_000, 5_000] as const;
const MANIFEST_PROCESSING_POLL_MS = 5_000;
const MANIFEST_MAX_PROCESSING_POLLS = 12;

export function getManifestRetryDelay(failedAttempt: number): number | null {
  if (!Number.isInteger(failedAttempt) || failedAttempt < 1) return null;
  return MANIFEST_RETRY_DELAYS_MS[failedAttempt - 1] ?? null;
}

export function getManifestProcessingPollDelay(
  processingPoll: number,
): number | null {
  if (
    !Number.isInteger(processingPoll) ||
    processingPoll < 1 ||
    processingPoll > MANIFEST_MAX_PROCESSING_POLLS
  ) {
    return null;
  }
  return MANIFEST_PROCESSING_POLL_MS;
}

export function zoomAfterWheel(zoom: number, deltaY: number): number {
  const currentZoom = Number.isFinite(zoom) ? zoom : DEFAULT_PREVIEW_ZOOM;
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 1) {
    return currentZoom;
  }
  const nextZoom =
    currentZoom + (deltaY < 0 ? PREVIEW_ZOOM_STEP : -PREVIEW_ZOOM_STEP);
  return (
    Math.round(
      Math.min(MAX_PREVIEW_ZOOM, Math.max(MIN_PREVIEW_ZOOM, nextZoom)) * 10,
    ) / 10
  );
}
