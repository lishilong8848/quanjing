import { useEffect, useRef, useState } from 'react';
import { Database, MapPin } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { countAt, COUNT_DURATION } from './motion';
import { portalPhotoSources } from './portal-asset';
import { useMotionEnvironment } from './use-motion-environment';
import { PortalImage } from './PortalImage';

const metrics = [
  { value: 2994, unit: '+', label: '规划与已建机柜' },
  {
    value: 7,
    unit: '栋',
    label: '园区建筑',
    detail: '5 栋机房 + 办公楼 + 110 站',
  },
  { value: 5, unit: '栋', label: '已建数据机房' },
  { value: 150, unit: '亩', label: '自有工业用地' },
  { value: 5, unit: 'ms', label: '至上海低时延圈' },
];
function Metric({ value, unit, label, detail }: (typeof metrics)[number]) {
  const ref = useRef<HTMLDivElement>(null);
  const { visible, reduced } = useMotionEnvironment(ref, 0.5);
  const [count, setCount] = useState(0);
  const completed = useRef(false);
  const startedAt = useRef<number | null>(null);
  useEffect(() => {
    if (reduced) {
      setCount(value);
      completed.current = true;
      return;
    }
    if (!visible || completed.current) return;
    startedAt.current ??= performance.now();
    const start = startedAt.current;
    let frame = 0;
    function tick(now: number) {
      setCount(countAt(value, now - start));
      if (now - start < COUNT_DURATION) frame = requestAnimationFrame(tick);
      else completed.current = true;
    }
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [visible, reduced, value]);
  return (
    <div ref={ref} className="campus-metric">
      <div className="metric-value">
        <b aria-hidden="true" data-count-to={value}>
          {count.toLocaleString('en-US')}
        </b>
        <span className="sr-only">{value.toLocaleString('en-US')}</span>
        <span>{unit}</span>
      </div>
      <div className="metric-label">{label}</div>
      {detail && <small>{detail}</small>}
    </div>
  );
}
export function CampusMetrics() {
  return (
    <section className="campus-metrics" aria-label="园区概览">
      <div className="wrap">
        <div className="metrics-caption">
          <h2>南通基地 · 园区概览</h2>
        </div>
        <div className="metrics-grid">
          {metrics.map((metric) => (
            <Metric key={metric.label} {...metric} />
          ))}
        </div>
      </div>
    </section>
  );
}
export function CampusLocation() {
  return (
    <section className="photo-location" aria-labelledby="portal-location-title">
      <div className="wrap">
        <div className="section-heading">
          <div>
            <div className="eyebrow">CONNECTED TO THE YANGTZE RIVER DELTA</div>
            <h2 id="portal-location-title">立足南通，连接长三角</h2>
          </div>
          <p>连接区域算力需求，支撑高效业务协同。</p>
        </div>
        <div className="location-grid">
          <div className="location-map">
            <PortalImage
              {...portalPhotoSources('location-reference.png')}
              alt="世纪互联南通基地与全国区域布局"
              loading="lazy"
            />
            <span className="location-map-pulse" aria-hidden="true" />
          </div>
          <div className="location-facts">
            <Card className="location-fact">
              <CardContent>
                <h3>
                  <Database />
                  建设标准
                </h3>
                <p>用地面积约 150 亩，工业用地自有，使用期限 50 年。</p>
                <p>
                  已建 5 栋数据机房、1 栋综合办公楼、1 栋 110kV
                  变电站，数据机房采用国标 A 级标准建设。
                </p>
                <div className="location-tags">
                  <span>自有工业用地</span>
                  <span>国标 A 级</span>
                </div>
              </CardContent>
            </Card>
            <Card className="location-fact">
              <CardContent>
                <h3>
                  <MapPin />
                  区位优势
                </h3>
                <p>
                  位于江苏省南通市开发区中央路 108 号，距上海约 120
                  公里，适合承接华东低时延业务和异地灾备场景。
                </p>
                <div className="location-tags">
                  <span>长三角核心区域</span>
                  <span>华东业务协同</span>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </section>
  );
}
