import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpRight, Leaf, Network, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CAMPUS_STOPS } from './portal-data';
import { portalAsset } from './portal-asset';
import { createCampusAnimation } from './campus-animation';
import { roundedRoutePath } from './motion';

const route = roundedRoutePath(CAMPUS_STOPS.flatMap((stop) => stop.route));

export function CampusTour({ onExplore }: { onExplore: () => void }) {
  const root = useRef<HTMLElement>(null);
  const controller = useRef<ReturnType<typeof createCampusAnimation> | null>(
    null,
  );
  const [error, setError] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!root.current) return;
    try {
      controller.current = createCampusAnimation(root.current, CAMPUS_STOPS);
    } catch (cause) {
      console.error('Campus animation initialization failed', cause);
      setError(true);
    }
    return () => {
      controller.current?.dispose();
      controller.current = null;
    };
  }, []);
  return (
    <section
      ref={root}
      className="photo-hero wrap"
      aria-labelledby={`${id}-title`}
      data-tour-duration="20000"
    >
      <div className="photo-canvas">
        <svg viewBox="0 0 960 488" role="img" aria-label="南通园区鸟瞰图">
          <defs>
            <filter id={`${id}-glow`}>
              <feGaussianBlur stdDeviation="2.5" />
            </filter>
            {CAMPUS_STOPS.filter((stop) => stop.polygon).map((stop) => (
              <clipPath key={stop.id} id={`${id}-${stop.id}`}>
                <polygon points={stop.polygon} />
              </clipPath>
            ))}
          </defs>
          <image
            className="campus-base-photo"
            href={portalAsset('campus-original.jpg')}
            width="960"
            height="488"
          />
          <g data-illumination="true">
            {CAMPUS_STOPS.map(
              (stop, i) =>
                stop.polygon && (
                  <image
                    key={stop.id}
                    data-lit-building={stop.id}
                    data-stop={i}
                    className="lit-building-photo"
                    href={portalAsset('campus-original.jpg')}
                    width="960"
                    height="488"
                    clipPath={`url(#${id}-${stop.id})`}
                  />
                ),
            )}
          </g>
          <g
            data-tour-route="true"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path data-route-geometry="true" d={route} stroke="none" />
            <path data-tail="glow" filter={`url(#${id}-glow)`} />
            <path data-tail="far" />
            <path data-tail="mid" />
            <path data-tail="near" />
          </g>
          <g data-route-beacon="true">
            <circle r="5" className="beacon-halo" />
            <circle r="2.2" className="beacon-core" />
          </g>
        </svg>
        <div aria-label="园区楼栋">
          {CAMPUS_STOPS.map((stop, i) => (
            <button
              type="button"
              key={stop.id}
              className="photo-building"
              data-building-label={stop.id}
              style={{
                left: `${(stop.label[0] / 960) * 100}%`,
                top: `${(stop.label[1] / 488) * 100}%`,
              }}
              aria-label={`定位${stop.name}`}
              onClick={() => controller.current?.seek(i)}
            >
              {stop.name}
            </button>
          ))}
        </div>
      </div>
      <div className="photo-shade" aria-hidden="true" />
      <div className="photo-copy wrap">
        <div className="location">世纪互联 · 南通数据中心</div>
        <h1 id={`${id}-title`}>
          江海交汇
          <br />
          <span>绿色互联</span>
        </h1>
        <h2>阿里云华东算力引擎</h2>
        <p>
          连接算力与未来，让每一次运行更可靠。
          <br />
          以专业运维守护数字基础设施。
        </p>
        <div className="photo-actions">
          <Button className="portal-primary" onClick={onExplore}>
            进入运营指挥 <ArrowUpRight />
          </Button>
        </div>
        <div className="photo-values">
          <span>
            <ShieldCheck />
            可靠基础设施
          </span>
          <span>
            <Leaf />
            绿色运营
          </span>
          <span>
            <Network />
            全域协同
          </span>
        </div>
        {error && <p role="status">园区动效暂不可用，其他功能可正常使用。</p>}
      </div>
      <div className="photo-signature">
        VNET · NANTONG
        <br />
        <span>DIGITAL INFRASTRUCTURE</span>
      </div>
    </section>
  );
}
