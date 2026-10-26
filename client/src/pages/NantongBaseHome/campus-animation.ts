import type { CampusStop } from './portal-data';
import { getTourFrame, TOUR_DURATION, TOUR_FLIGHT } from './motion';

export function createCampusAnimation(
  root: HTMLElement,
  stops: readonly CampusStop[],
) {
  const required = <T extends Element>(selector: string) => {
    const node = root.querySelector<T>(selector);
    if (!node) throw new Error(`园区图缺少动画节点：${selector}`);
    return node;
  };
  const geometry = required<SVGPathElement>('[data-route-geometry]');
  const illumination = required<SVGGElement>('[data-illumination]');
  const beacon = required<SVGGElement>('[data-route-beacon]');
  const trail = required<SVGGElement>('[data-tour-route]');
  const tails = ['glow', 'far', 'mid', 'near'].map((name) =>
    required<SVGPathElement>(`[data-tail="${name}"]`),
  );
  const labels = Array.from(
    root.querySelectorAll<HTMLButtonElement>('[data-building-label]'),
  );
  const images = Array.from(
    root.querySelectorAll<SVGImageElement>('[data-lit-building]'),
  );
  const total = geometry.getTotalLength();
  if (!Number.isFinite(total) || total <= 0)
    throw new Error('园区路线长度无效');
  const samples = Array.from({ length: 801 }, (_, i) => {
    const distance = (total * i) / 800;
    return { point: geometry.getPointAtLength(distance), distance };
  });
  let previous = 0;
  const milestones = stops.map((stop, i) => {
    if (!i) return 0;
    if (i === stops.length - 1) return total;
    const target = stop.route[stop.route.length - 1];
    let best = Infinity;
    for (const sample of samples) {
      if (sample.distance < previous) continue;
      const error = Math.hypot(
        sample.point.x - target[0],
        sample.point.y - target[1],
      );
      if (error < best) {
        best = error;
        previous = sample.distance;
      }
    }
    return previous;
  });
  const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
  let elapsed = 0,
    last = 0,
    active = -1,
    frame = 0,
    inView = false,
    disposed = false;
  function tailPath(from: number, to: number) {
    if (to <= from) return '';
    const count = Math.max(2, Math.ceil((to - from) / 3));
    return Array.from({ length: count + 1 }, (_, i) => {
      const p = geometry.getPointAtLength(from + ((to - from) * i) / count);
      return `${i ? 'L' : 'M'}${p.x.toFixed(2)},${p.y.toFixed(2)}`;
    }).join(' ');
  }
  function render() {
    const state = getTourFrame(elapsed, milestones, preference.matches);
    if (state.active !== active) {
      active = state.active;
      root.dataset.activeBuilding = stops[active].id;
      labels.forEach((label, i) =>
        label.setAttribute('aria-pressed', String(i === active)),
      );
      images.forEach((image) =>
        image.classList.toggle('is-lit', Number(image.dataset.stop) <= active),
      );
    }
    root.dataset.allLit = String(active === stops.length - 1);
    illumination.style.opacity = String(state.lightOpacity);
    trail.style.opacity = String(state.trailOpacity);
    beacon.style.opacity = String(state.trailOpacity);
    const point = geometry.getPointAtLength(state.distance);
    beacon.setAttribute('transform', `translate(${point.x} ${point.y})`);
    [
      [70, 0],
      [70, 42],
      [42, 18],
      [18, 0],
    ].forEach(([start, end], i) => {
      tails[i].setAttribute(
        'd',
        tailPath(
          Math.max(0, state.distance - start),
          Math.max(0, state.distance - end),
        ),
      );
    });
  }
  function tick(now: number) {
    if (disposed) return;
    if (last) elapsed = (elapsed + Math.min(now - last, 100)) % TOUR_DURATION;
    last = now;
    render();
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(frame);
    last = 0;
    if (disposed) return;
    const playing = inView && !document.hidden && !preference.matches;
    root.dataset.playing = String(playing);
    render();
    if (playing) frame = requestAnimationFrame(tick);
  }
  const observer = new IntersectionObserver(
    ([entry]) => {
      inView = entry.isIntersecting;
      sync();
    },
    { threshold: 0.05 },
  );
  observer.observe(root);
  document.addEventListener('visibilitychange', sync);
  preference.addEventListener('change', sync);
  render();
  return {
    seek(index: number) {
      if (
        disposed ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= stops.length
      )
        return;
      elapsed = (milestones[index] / total) * TOUR_FLIGHT;
      last = 0;
      render();
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener('visibilitychange', sync);
      preference.removeEventListener('change', sync);
    },
  };
}
