import { memo, useMemo, type ReactNode } from 'react';
import {
  BatteryCharging,
  Cable,
  CircuitBoard,
  Fan,
  Fuel,
  Power,
  Zap,
  Snowflake,
  Droplets,
  Gauge,
  Container,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ThresholdRecord } from '@shared/threshold-management.interface';

export function thresholdDeviceIcon(name: string) {
  if (/蓄冷罐/.test(name)) return Container;
  if (/冷水|空调/.test(name)) return Snowflake;
  if (/补水|定压/.test(name)) return Gauge;
  if (/水泵|恒湿|加药/.test(name)) return Droplets;
  if (/UPS|HVDC|直流屏/.test(name)) return BatteryCharging;
  if (/变频器|电加热/.test(name)) return Fan;
  if (/燃油/.test(name)) return Fuel;
  if (/ATS/.test(name)) return Power;
  if (/列头柜/.test(name)) return Cable;
  if (/SVG|逻辑/.test(name)) return CircuitBoard;
  return Zap;
}
export const ThresholdDeviceRail = memo(function ThresholdDeviceRail({
  records,
  selected,
  onSelect,
  professionSwitch,
}: {
  records: ThresholdRecord[];
  selected: string;
  onSelect: (device: string) => void;
  professionSwitch: ReactNode;
}) {
  const devices = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of records)
      counts.set(record.device, (counts.get(record.device) || 0) + 1);
    return [...counts];
  }, [records]);
  return (
    <Card className="threshold-card threshold-device-rail">
      <CardHeader data-slot="card-header">
        {professionSwitch}
        <div className="threshold-device-heading">
          <CardTitle data-slot="card-title">设备</CardTitle>
          <span className="threshold-count">{devices.length}</span>
        </div>
      </CardHeader>
      <CardContent data-slot="card-content">
        <nav aria-label="设备工作表">
          {devices.map(([name, count]) => {
            const Icon = thresholdDeviceIcon(name);
            return (
              <button
                key={name}
                aria-pressed={name === selected}
                className={name === selected ? 'is-selected' : ''}
                onClick={() => onSelect(name)}
              >
                <Icon size={19} />
                <span>{name}</span>
                <small>{count}</small>
              </button>
            );
          })}
          {!devices.length && <p className="threshold-secondary">暂无设备</p>}
        </nav>
      </CardContent>
    </Card>
  );
});
