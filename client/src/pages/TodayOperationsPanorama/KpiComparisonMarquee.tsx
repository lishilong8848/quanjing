import {
  useCallback,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';

export interface KpiComparisonMarqueeMetrics {
  distance: number;
  durationSeconds: number;
}

interface KpiComparisonMarqueeProps {
  focusable?: boolean;
  id: string;
  text: string;
}

type KpiComparisonMarqueeStyle = CSSProperties & {
  '--today-panorama-kpi-comparison-distance': string;
  '--today-panorama-kpi-comparison-duration': string;
};

const EMPTY_METRICS: KpiComparisonMarqueeMetrics = {
  distance: 0,
  durationSeconds: 0,
};

export function getKpiComparisonMarqueeMetrics(
  viewportWidth: number,
  contentWidth: number,
): KpiComparisonMarqueeMetrics {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(contentWidth) ||
    viewportWidth <= 0 ||
    contentWidth <= 0 ||
    contentWidth - viewportWidth <= 1
  ) {
    return EMPTY_METRICS;
  }

  const distance = Math.ceil(contentWidth - viewportWidth);

  return {
    distance,
    durationSeconds: Math.min(14, Math.max(7, 6 + distance / 24)),
  };
}

export function KpiComparisonMarquee({
  focusable = false,
  id,
  text,
}: KpiComparisonMarqueeProps) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [metrics, setMetrics] =
    useState<KpiComparisonMarqueeMetrics>(EMPTY_METRICS);

  const measure = useCallback(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;

    if (!viewport || !track) return;

    const next = getKpiComparisonMarqueeMetrics(
      viewport.clientWidth,
      track.scrollWidth,
    );

    setMetrics((current) =>
      current.distance === next.distance &&
      current.durationSeconds === next.durationSeconds
        ? current
        : next,
    );
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, text]);

  useEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;

    if (!viewport || !track) return;

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(viewport);
      observer.observe(track);

      return () => {
        observer.disconnect();
      };
    }

    window.addEventListener('resize', measure);

    return () => {
      window.removeEventListener('resize', measure);
    };
  }, [measure]);

  const isOverflowing = metrics.distance > 0;
  const style: KpiComparisonMarqueeStyle | undefined = isOverflowing
    ? {
        '--today-panorama-kpi-comparison-distance': `${metrics.distance}px`,
        '--today-panorama-kpi-comparison-duration': `${metrics.durationSeconds}s`,
      }
    : undefined;

  return (
    <span
      id={id}
      ref={viewportRef}
      className="today-panorama-kpi-comparison-marquee"
      data-overflowing={String(isOverflowing)}
      aria-label={focusable && isOverflowing ? text : undefined}
      tabIndex={focusable && isOverflowing ? 0 : undefined}
      title={isOverflowing ? text : undefined}
      style={style}
    >
      <span
        ref={trackRef}
        className="today-panorama-kpi-comparison-marquee-track"
      >
        {text}
      </span>
    </span>
  );
}
