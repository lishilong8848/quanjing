import { useEffect, useState, type RefObject } from 'react';

export function useMotionEnvironment(
  ref: RefObject<HTMLElement | null>,
  threshold = 0.2,
) {
  const [visible, setVisible] = useState(false);
  const [reduced, setReduced] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  const [documentVisible, setDocumentVisible] = useState(!document.hidden);
  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onPreference = () => setReduced(preference.matches);
    const onVisibility = () => setDocumentVisible(!document.hidden);
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.isIntersecting),
      { threshold },
    );
    if (ref.current) observer.observe(ref.current);
    preference.addEventListener('change', onPreference);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      observer.disconnect();
      preference.removeEventListener('change', onPreference);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [ref, threshold]);
  return { visible, reduced, playing: visible && documentVisible && !reduced };
}
