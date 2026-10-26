import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Radio, ShieldCheck, Waves, Zap } from 'lucide-react';
import { SYSTEMS } from './portal-data';
import {
  advanceCarousel,
  CAROUSEL_INTERVAL,
  MANUAL_HOLD,
  type CarouselState,
} from './motion';
import { portalAsset, portalPhotoSources } from './portal-asset';
import { PortalImage } from './PortalImage';
import { useMotionEnvironment } from './use-motion-environment';

const tabs = [
  { key: 'power', label: '供配电系统', english: 'POWER', Icon: Zap },
  { key: 'cooling', label: '暖通水冷', english: 'COOLING', Icon: Waves },
  { key: 'weak', label: '弱电系统', english: 'INTELLIGENCE', Icon: Radio },
  { key: 'fire', label: '消防系统', english: 'PROTECTION', Icon: ShieldCheck },
];
const lengths = tabs.map((tab) => SYSTEMS[tab.key].photos.length);

export function SystemsGallery({
  dialogOpen,
  onExplore,
}: {
  dialogOpen: boolean;
  onExplore: (name: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const { playing } = useMotionEnvironment(ref, 0.22);
  const [nearViewport, setNearViewport] = useState(false);
  const [keyboardFocus, setKeyboardFocus] = useState(false);
  const manualUntil = useRef(0);
  const [state, setState] = useState<CarouselState>({
    system: 0,
    photo: 0,
    phase: 0,
    cursors: [1, 0, 0, 0],
  });
  const active = tabs[state.system];
  const system = SYSTEMS[active.key];
  const photo = system.photos[state.photo];
  const autoPlaying = playing && !dialogOpen && !keyboardFocus;
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setNearViewport(true);
        observer.disconnect();
      }
    }, { rootMargin: '600px' });
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
    if (!nearViewport || document.hidden || connection?.saveData || connection?.effectiveType === '2g' || connection?.effectiveType === 'slow-2g') return;
    const next = advanceCarousel(state, lengths);
    const nextFile = SYSTEMS[tabs[next.system].key].photos[next.photo][1];
    const preload = new Image();
    const sources = portalPhotoSources(nextFile);
    preload.decoding = 'async';
    preload.fetchPriority = 'low';
    preload.sizes = sources.sizes;
    preload.srcset = sources.srcSet || '';
    preload.src = sources.src;
  }, [state, nearViewport]);
  useEffect(() => {
    if (!autoPlaying) return;
    const remainingHold = Math.max(0, manualUntil.current - performance.now());
    const timer = window.setTimeout(
      () => setState((current) => advanceCarousel(current, lengths)),
      remainingHold + CAROUSEL_INTERVAL / 2,
    );
    return () => window.clearTimeout(timer);
  }, [state, autoPlaying]);
  const select = (systemIndex: number, photoIndex = 0) => {
    manualUntil.current = performance.now() + MANUAL_HOLD;
    setState((current) => {
      const cursors = [...current.cursors];
      cursors[systemIndex] = (photoIndex + 1) % lengths[systemIndex];
      return { system: systemIndex, photo: photoIndex, phase: 0, cursors };
    });
  };
  return (
    <section
      ref={ref}
      className="photo-systems"
      id="portal-foundation"
      aria-labelledby="portal-systems-title"
      data-active-system={active.key}
      data-carousel-playing={
        autoPlaying && performance.now() >= manualUntil.current
      }
      data-carousel-interval={CAROUSEL_INTERVAL}
      onFocusCapture={(event) => {
        if (event.target.matches(':focus-visible')) setKeyboardFocus(true);
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setKeyboardFocus(false);
      }}
    >
      <div className="wrap">
        <div className="section-heading">
          <div>
            <div className="eyebrow">THE FOUNDATION OF EVERY CONNECTION</div>
            <h2 id="portal-systems-title">每一次稳定运行，都有坚实支撑</h2>
          </div>
          <p>走近设施，了解算力背后的保障。</p>
        </div>
        <div
          className="photo-system-tabs"
          role="tablist"
          aria-label="基础设施系统"
        >
          {tabs.map((tab, index) => (
            <button
              ref={(node) => {
                tabRefs.current[index] = node;
              }}
              type="button"
              key={tab.key}
              role="tab"
              id={`portal-tab-${tab.key}`}
              aria-selected={state.system === index}
              aria-controls="portal-system-panel"
              tabIndex={state.system === index ? 0 : -1}
              onClick={() => select(index)}
              onKeyDown={(event) => {
                const next =
                  event.key === 'ArrowRight'
                    ? (index + 1) % tabs.length
                    : event.key === 'ArrowLeft'
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? tabs.length - 1
                          : null;
                if (next === null) return;
                event.preventDefault();
                setKeyboardFocus(true);
                select(next);
                tabRefs.current[next]?.focus();
              }}
            >
              <tab.Icon />
              <span>
                {tab.label}
                <small>{tab.english}</small>
              </span>
              <b>{String(index + 1).padStart(2, '0')}</b>
            </button>
          ))}
        </div>
        <div
          id="portal-system-panel"
          role="tabpanel"
          aria-labelledby={`portal-tab-${active.key}`}
          className="system-photo-panel"
          data-device={photo[0]}
        >
          <div className="system-photo-frame">
            <PortalImage
              key={photo[1]}
              className="system-photo"
              {...portalPhotoSources(photo[1])}
              alt={photo[0]}
              loading={nearViewport ? 'eager' : 'lazy'}
              fetchPriority={nearViewport ? 'high' : 'auto'}
            />
            <div className="equipment-shade" />
            <div className="equipment-scan" aria-hidden="true" />
            <span className="photo-corner top-left" aria-hidden="true" />
            <span className="photo-corner bottom-right" aria-hidden="true" />
            <div className="equipment-eyebrow">
              {active.english} INFRASTRUCTURE
            </div>
            <div className="equipment-caption">
              <span>
                {String(state.photo + 1).padStart(2, '0')} /{' '}
                {String(system.photos.length).padStart(2, '0')}
              </span>
              <h3>{photo[0]}</h3>
              <p>{photo[2]}</p>
            </div>
          </div>
          <div className="system-photo-story">
            <div className="eyebrow">{system.english}</div>
            <h3>{system.title}</h3>
            <p>{system.body}</p>
            <div className="system-device-list">
              {system.photos.map((item, index) => (
                <button
                  type="button"
                  key={item[1]}
                  aria-pressed={state.photo === index}
                  onClick={() => select(state.system, index)}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  {item[0]}
                  <ArrowUpRight />
                </button>
              ))}
            </div>
            <button
              type="button"
              className="system-app-link"
              onClick={() => onExplore(system.app)}
            >
              查看{system.app}
              <ArrowUpRight />
            </button>
          </div>
        </div>
        <div className="system-photo-thumbnails" aria-label="设备照片">
          {system.photos.map((item, index) => (
            <button
              type="button"
              key={item[1]}
              aria-label={`查看${item[0]}照片`}
              aria-pressed={state.photo === index}
              onClick={() => select(state.system, index)}
            >
              <img src={portalAsset(item[1], 'thumbnail')} alt="" loading="lazy" decoding="async" />
              <span>{item[0]}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
