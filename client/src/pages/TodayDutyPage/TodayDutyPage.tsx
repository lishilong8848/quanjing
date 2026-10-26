import { useCallback, useEffect, useState } from 'react';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Button } from '@/components/ui/button';
import { getMonthlySchedules, getYearlySealingInfo, getHolidayDutySchedules } from '@/api';
import type { MonthlySchedule, SealingInfo } from '@shared/api.interface';
import { toast } from 'sonner';
import { getHolidayInfo } from '@/utils/holidays';
import { format } from 'date-fns';
import { zhCN } from 'date-fns/locale';

const BUILDING_ORDER = ['building_h', 'building_a', 'building_b', 'building_c', 'building_d', 'building_e', 'station_110'];

const BUILDING_MAP: Record<string, string> = {
  building_a: 'A栋',
  building_b: 'B栋',
  building_c: 'C栋',
  building_d: 'D栋',
  building_e: 'E栋',
  building_h: 'H栋',
  station_110: '110站',
};

interface ShiftInfo {
  shift: 'white' | 'night' | 'long_white';
  person?: string;
}

interface DailySchedule {
  shiftInfo: ShiftInfo[];
  emergencyDutySchedule: string;
}

// 格式化姓名，2个字姓名添加字间距与3个字宽度保持一致
function formatNameWithSpacing(nameStr?: string | null): string {
  if (!nameStr || nameStr === '-') return '-';
  
  // 按逗号或顿号分隔多个姓名
  const names = nameStr.split(/[，,、]/).filter(n => n.trim());
  
  return names.map((name) => {
    const trimmedName = name.trim();
    const isTwoChars = trimmedName.length === 2;
    
    if (isTwoChars) {
      return trimmedName.split('').join('\u2003');
    }
    return trimmedName;
  }).join(' ');
}

function isSealingActiveOnDate(sealing: SealingInfo, date: Date): boolean {
  const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayEnd = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  const start = new Date(sealing.startDate);
  const end = new Date(sealing.endDate);

  return (
    Number.isFinite(start.getTime()) &&
    Number.isFinite(end.getTime()) &&
    start < dayEnd &&
    end > dayStart
  );
}

export default function TodayDutyPage() {
  const [selectedDate, setSelectedDate] = useState<Date>(new Date());
  const [schedules, setSchedules] = useState<MonthlySchedule[]>([]);
  const [sealings, setSealings] = useState<SealingInfo[]>([]);
  const [holidayDutySchedules, setHolidayDutySchedules] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState(false);

  // 加载排班数据
  const loadSchedules = useCallback(async () => {
    const year = selectedDate.getFullYear();
    const month = selectedDate.getMonth() + 1;

    setLoading(true);
    try {
      // 加载当前月份的数据
      const data = await getMonthlySchedules(year, month);
      let allSchedules = data.schedules || [];

      // 同时加载下一个月的数据（用于支持跨月）
      let nextYear = year;
      let nextMonth = month + 1;
      if (nextMonth > 12) {
        nextMonth = 1;
        nextYear = year + 1;
      }
      try {
        const nextMonthData = await getMonthlySchedules(nextYear, nextMonth);
        if (nextMonthData.schedules && nextMonthData.schedules.length > 0) {
          allSchedules = [...allSchedules, ...nextMonthData.schedules];
        }
      } catch (nextMonthError) {
        logger.warn('加载下一个月值班数据失败', nextMonthError);
      }

      setSchedules(allSchedules);
    } catch (error) {
      logger.error('加载月度值班数据失败', error);
      toast.error('加载值班数据失败');
    } finally {
      setLoading(false);
    }
  }, [selectedDate]);

  // 加载封网信息
  const loadSealingInfo = useCallback(async () => {
    try {
      const year = selectedDate.getFullYear();
      const data = await getYearlySealingInfo(year);
      const validSealings = data.sealings
        .filter((s) => s.sealingName && s.sealingName.trim() !== '')
        .sort((a, b) => new Date(a.startDate).getTime() - new Date(b.startDate).getTime());
      setSealings(validSealings);
    } catch (error) {
      logger.error('加载封网信息失败', error);
    }
  }, [selectedDate]);

  // 加载节假日值班安排
  const loadHolidayDutySchedules = useCallback(async () => {
    try {
      const data = await getHolidayDutySchedules();
      const scheduleMap: Record<string, string[]> = {};
      data.schedules.forEach((s) => {
        if (s.scheduleDate && s.dutyStaff) {
          if (!scheduleMap[s.scheduleDate]) {
            scheduleMap[s.scheduleDate] = [];
          }
          scheduleMap[s.scheduleDate].push(s.dutyStaff);
        }
      });
      setHolidayDutySchedules(scheduleMap);
    } catch (error) {
      logger.error('加载节假日值班安排失败', error);
    }
  }, []);

  useEffect(() => {
    loadSchedules();
    loadSealingInfo();
    loadHolidayDutySchedules();
  }, [loadSchedules, loadSealingInfo, loadHolidayDutySchedules]);

  const dateStr = `${selectedDate.getFullYear()}-${String(selectedDate.getMonth() + 1).padStart(2, '0')}-${String(selectedDate.getDate()).padStart(2, '0')}`;
  const holidayInfo = getHolidayInfo(dateStr);
  const emergencyDuties = holidayDutySchedules[dateStr] || [];
  const sealing = sealings.find((s) => isSealingActiveOnDate(s, selectedDate));

  // 获取指定日期和楼栋的排班信息
  const getScheduleByDateAndBuilding = (date: string, building: string): DailySchedule => {
    const buildingSchedules = schedules.filter(
      (s) => s.scheduleDate === date && s.building === building,
    );

    const shiftMap = new Map<string, string[]>();
    buildingSchedules.forEach((s) => {
      const shift = s.shift as 'white' | 'night' | 'long_white';
      const dutyStaff = s.dutyStaffActual && s.dutyStaffActual.length > 0
        ? s.dutyStaffActual
        : s.personText ? [s.personText] : [];
      
      if (!shiftMap.has(shift)) {
        shiftMap.set(shift, []);
      }
      shiftMap.get(shift)!.push(...dutyStaff);
    });

    const shiftInfo: ShiftInfo[] = Array.from(shiftMap.entries()).map(([shift, persons]) => ({
      shift: shift as 'white' | 'night' | 'long_white',
      person: persons.filter((p, idx, arr) => arr.indexOf(p) === idx).join(', ') || undefined,
    }));

    const emergencyDutySchedule = buildingSchedules[0]?.emergencyDutySchedule || '';

    return { shiftInfo, emergencyDutySchedule };
  };

  const today = new Date();
  const isToday = 
    selectedDate.getFullYear() === today.getFullYear() &&
    selectedDate.getMonth() === today.getMonth() &&
    selectedDate.getDate() === today.getDate();

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <span className="text-gray-500">加载中...</span>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4">
      {/* 页面标题 */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800">今日值班</h1>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="gap-2">
              <span>{format(selectedDate, 'yyyy年MM月dd日', { locale: zhCN })}</span>
              <span className="text-gray-400">
                {selectedDate.toLocaleDateString('zh-CN', { weekday: 'short' })}
              </span>
              {holidayInfo.isHoliday && (
                <span className="text-xs text-red-500">{holidayInfo.name}</span>
              )}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="single"
              selected={selectedDate}
              onSelect={(date) => date && setSelectedDate(date)}
              initialFocus
            />
          </PopoverContent>
        </Popover>
      </div>

      {/* 值班概览卡片 */}
      <Card className={`border-2 ${isToday ? 'border-orange-300' : 'border-gray-200'}`}>
        <CardHeader className={`pb-4 ${isToday ? 'bg-orange-50/50' : ''}`}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-6 w-1 rounded-full bg-gradient-to-b from-orange-400 to-orange-500" />
              <CardTitle className="text-lg text-gray-800">
                {isToday ? '今日值班概览' : `${format(selectedDate, 'MM月dd日')}值班概览`}
              </CardTitle>
              {holidayInfo.isHoliday && (
                <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-600">
                  {holidayInfo.name}
                </span>
              )}
            </div>
            {sealing && (
              <Popover>
                <PopoverTrigger asChild>
                  <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border-2 border-red-500 bg-white shadow-sm hover:bg-red-50">
                    <span 
                      className="text-xs font-black text-red-600"
                      style={{ fontFamily: 'KaiTi, STKaiti, serif' }}
                    >
                      封
                    </span>
                  </div>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-4">
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 border-b border-red-100 pb-2">
                      <div className="flex h-6 w-6 items-center justify-center rounded-full border border-red-300 bg-red-100">
                        <span className="text-xs font-black text-red-600">封</span>
                      </div>
                      <h4 className="text-sm font-bold text-red-700">{sealing.sealingName}</h4>
                    </div>
                    <div className="space-y-1 text-xs">
                      <div className="flex items-center gap-2">
                        <span className="w-10 text-gray-500">开始:</span>
                        <span className="font-medium text-gray-700">
                          {new Date(sealing.startDate).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-10 text-gray-500">结束:</span>
                        <span className="font-medium text-gray-700">
                          {new Date(sealing.endDate).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      {sealing.sealingType && (
                        <div className="flex items-center gap-2">
                          <span className="w-10 text-gray-500">类型:</span>
                          <span className="rounded bg-red-50 px-1.5 py-0.5 font-medium text-red-600">
                            {sealing.sealingType}
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
          {emergencyDuties.length > 0 && (
            <div className="mt-2 text-sm text-green-700">
              <span className="font-semibold">应急值班：</span>
              {emergencyDuties.join('、')}
            </div>
          )}
        </CardHeader>
        <CardContent className="pt-0">
          {/* 楼栋值班信息 */}
          <div className="space-y-3">
            {BUILDING_ORDER.map((building) => {
              const { shiftInfo } = getScheduleByDateAndBuilding(dateStr, building);
              const whiteShift = shiftInfo.find((s) => s.shift === 'white');
              const nightShift = shiftInfo.find((s) => s.shift === 'night');
              const longWhiteShift = shiftInfo.find((s) => s.shift === 'long_white');

              if (!whiteShift && !nightShift && !longWhiteShift) return null;

              return (
                <div key={building} className="flex items-center gap-4 rounded-lg border border-gray-100 bg-gray-50/50 p-3">
                  <span className="w-12 flex-shrink-0 rounded bg-green-500 px-2 py-1 text-center text-sm font-medium text-white">
                    {BUILDING_MAP[building]}
                  </span>
                  
                  {/* 白班/长白班 */}
                  <div className="flex flex-1 items-center gap-2">
                    {longWhiteShift ? (
                      <>
                        <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-1 text-sm text-amber-700">
                          <span>☀️</span>
                          <span className="font-medium">长白</span>
                        </span>
                        <span className="text-amber-800">{formatNameWithSpacing(longWhiteShift.person)}</span>
                      </>
                    ) : whiteShift ? (
                      <>
                        <span className="inline-flex items-center gap-1 rounded bg-orange-100 px-2 py-1 text-sm text-orange-700">
                          <span>☀️</span>
                          <span className="font-medium">白班</span>
                        </span>
                        <span className="text-orange-800">{formatNameWithSpacing(whiteShift.person)}</span>
                      </>
                    ) : (
                      <>
                        <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-sm text-gray-400">
                          <span>☀️</span>
                          <span>-</span>
                        </span>
                        <span className="text-gray-400">-</span>
                      </>
                    )}
                  </div>
                  
                  {/* 夜班 */}
                  <div className="flex flex-1 items-center gap-2">
                    {nightShift ? (
                      <>
                        <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-2 py-1 text-sm text-blue-700">
                          <span>🌙</span>
                          <span className="font-medium">夜班</span>
                        </span>
                        <span className="text-blue-800">{formatNameWithSpacing(nightShift.person)}</span>
                      </>
                    ) : (
                      <>
                        <span className="inline-flex items-center gap-1 rounded bg-gray-100 px-2 py-1 text-sm text-gray-400">
                          <span>🌙</span>
                          <span>-</span>
                        </span>
                        <span className="text-gray-400">-</span>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* 封网信息 */}
          {sealing ? (
            <div className="mt-4 rounded-lg border border-red-200 bg-gradient-to-r from-red-50 to-orange-50 p-4">
              <div className="flex items-start gap-3">
                <div className="flex flex-shrink-0 flex-col items-center justify-center rounded border border-red-300 bg-white px-3 py-2">
                  <span className="text-xs font-bold text-red-600">封网信息</span>
                </div>
                <div className="flex-1">
                  <div className="text-sm font-medium text-red-700">{sealing.sealingName}</div>
                  <div className="mt-1 text-xs text-red-600">
                    {new Date(sealing.startDate).getMonth() + 1}月{new Date(sealing.startDate).getDate()}日 {String(new Date(sealing.startDate).getHours()).padStart(2, '0')}:{String(new Date(sealing.startDate).getMinutes()).padStart(2, '0')}
                    <span className="mx-1 text-red-400">~</span>
                    {new Date(sealing.endDate).getMonth() + 1}月{new Date(sealing.endDate).getDate()}日 {String(new Date(sealing.endDate).getHours()).padStart(2, '0')}:{String(new Date(sealing.endDate).getMinutes()).padStart(2, '0')}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="mt-4 flex items-center justify-center gap-2 rounded-lg border border-green-200 bg-green-50/50 py-4">
              <div className="flex h-6 w-6 items-center justify-center rounded-full border border-green-300 bg-green-100">
                <span className="text-xs font-black text-green-600">无</span>
              </div>
              <span className="text-sm text-green-600">无封网信息</span>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
