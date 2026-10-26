export const GLOBAL_NAVIGATION_HEIGHT_PX = 64;

export function getGlobalNavigationViewportHeight(
  viewportHeight: number,
  ownerDocument: Document | undefined = typeof document === 'undefined'
    ? undefined
    : document,
): number {
  const navigation = ownerDocument?.querySelector<HTMLElement>(
    '[data-global-navigation="true"]',
  );
  const navigationHeight = navigation?.getBoundingClientRect().height ?? 0;

  return Math.max(0, viewportHeight - navigationHeight);
}
