export type GeneratedFilesScrollTarget = {
  scrollIntoView: (options: {
    behavior: 'auto' | 'smooth';
    block: 'start';
  }) => void;
};

export type FrameScheduler = (callback: () => void) => number;

export function scrollGeneratedFilesIntoView(
  target: GeneratedFilesScrollTarget | null,
  prefersReducedMotion: boolean,
  scheduleFrame: FrameScheduler,
): number | null {
  if (!target) return null;

  return scheduleFrame(() => {
    target.scrollIntoView({
      behavior: prefersReducedMotion ? 'auto' : 'smooth',
      block: 'start',
    });
  });
}
