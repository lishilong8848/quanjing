export function isWideAlarmImage(width: number, height: number): boolean {
  return height > 0 && width / height >= 8;
}

export function alarmImageBaseScale(
  width: number,
  height: number,
  viewportWidth: number,
  viewportHeight: number,
): number {
  if (!width || !height || !viewportWidth || !viewportHeight) return 1;
  if (isWideAlarmImage(width, height))
    return Math.min(3, Math.max(1, 36 / height));
  return Math.min(1, viewportWidth / width, viewportHeight / height);
}

export function alarmImageStripCount(
  width: number,
  scale: number,
  viewportWidth: number,
): number {
  if (!width || !viewportWidth) return 0;
  return Math.max(1, Math.ceil((width * scale) / viewportWidth));
}

export function clampAlarmImageZoom(value: number): number {
  return Math.max(0.5, Math.min(4, Math.round(value * 4) / 4));
}

export function alarmImageWheelZoom(value: number, deltaY: number): number {
  const steps = Math.min(4, Math.floor(Math.abs(deltaY) / 60));
  return steps
    ? clampAlarmImageZoom(value - Math.sign(deltaY) * steps * 0.25)
    : value;
}
