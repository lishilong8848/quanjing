export const COUNT_DURATION = 1800;
export const TOUR_DURATION = 20000;
export const TOUR_FLIGHT = 17000;
export const CAROUSEL_INTERVAL = 6500;
export const MANUAL_HOLD = 15000;
export type Point = readonly [number, number];

export function countAt(target: number, elapsed: number): number {
  const progress = Math.max(0, Math.min(elapsed / COUNT_DURATION, 1));
  return Math.floor(target * (1 - (1 - progress) ** 2));
}

export function roundedRoutePath(input: readonly Point[]): string {
  const points = input.filter(
    (p, i) => !i || p[0] !== input[i - 1][0] || p[1] !== input[i - 1][1],
  );
  if (!points.length) return '';
  let path = `M${points[0].join(',')}`;
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1],
      p = points[i],
      b = points[i + 1];
    const before = Math.hypot(a[0] - p[0], a[1] - p[1]);
    const after = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const radius = Math.min(11, before * 0.28, after * 0.28);
    const enter = p.map((v, k) => v + ((a[k] - v) * radius) / before);
    const leave = p.map((v, k) => v + ((b[k] - v) * radius) / after);
    path += ` L${enter.join(',')} Q${p.join(',')} ${leave.join(',')}`;
  }
  return `${path} L${points[points.length - 1].join(',')}`;
}

export function getTourFrame(
  time: number,
  milestones: readonly number[],
  reduced = false,
) {
  const elapsed = ((time % TOUR_DURATION) + TOUR_DURATION) % TOUR_DURATION;
  const last = milestones.length - 1;
  const distance = Math.min(elapsed / TOUR_FLIGHT, 1) * milestones[last];
  let active = 0;
  while (
    active < last &&
    distance > (milestones[active] + milestones[active + 1]) / 2
  )
    active++;
  return {
    distance,
    active: reduced ? last : active,
    lightOpacity: reduced ? 1 : Math.min(1, (TOUR_DURATION - elapsed) / 400),
    trailOpacity: reduced
      ? 0
      : Math.max(
          0,
          Math.min(1, elapsed / 350, (TOUR_DURATION - elapsed) / 700),
        ),
  };
}

export interface CarouselState {
  system: number;
  photo: number;
  phase: number;
  cursors: number[];
}

export function advanceCarousel(
  state: CarouselState,
  lengths: readonly number[],
): CarouselState {
  const system =
    state.phase === 0 ? state.system : (state.system + 1) % lengths.length;
  const photo =
    state.phase === 0
      ? (state.photo + 1) % lengths[system]
      : state.cursors[system] % lengths[system];
  const cursors = [...state.cursors];
  cursors[system] = (photo + 1) % lengths[system];
  return { system, photo, cursors, phase: state.phase === 0 ? 1 : 0 };
}
