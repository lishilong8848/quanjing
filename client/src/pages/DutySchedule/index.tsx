import React, { useEffect, useState } from 'react';
import { logger } from '@lark-apaas/client-toolkit/logger';
import { UserSelect } from '@lark-apaas/client-toolkit/components/User';
import { extractIdsFromValue } from '@/components/business-ui/user-select/utils';
import { Calendar } from '@/components/ui/calendar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { getBuildings, getDutySchedules, batchUpsertDutySchedules } from '@/api';
import type { Building, DutySchedule } from '@shared/api.interface';
import { toast } from 'sonner';

interface DutyScheduleWithStaff extends DutySchedule {
  buildingName: string;
  staffName?: string;
}

export default function DutySchedulePage() {
  const [buildings, setBuildings] = useState<Building[]>([]);
  const [schedules, setSchedules] = useState<DutyScheduleWithStaff[]>([]);
  const [selectedDate, setSelectedDate] = useState<Date | undefined>(new Date());
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    loadBuildings();
  }, []);

  useEffect(() => {
    if (selectedDate) {
      loadSchedules();
    }
  }, [selectedDate]);

  const loadBuildings = async () => {
    try {
      const data = await getBuildings();
      setBuildings(data);
    } catch (error) {
      logger.error('加载楼栋信息失败', error);
      toast.error('加载楼栋信息失败');
    }
  };

  const loadSchedules = async () => {
    if (!selectedDate) return;
    
    const startDate = new Date(selectedDate);
    startDate.setDate(startDate.getDate() - 7);
    const endDate = new Date(selectedDate);
    endDate.setDate(endDate.getDate() + 7);

    const startDateStr = startDate.toISOString().split('T')[0];
    const endDateStr = endDate.toISOString().split('T')[0];

    try {
      const data = await getDutySchedules(startDateStr, endDateStr);
      const dataWithNames = data.map((schedule) => {
        const building = buildings.find((b) => b.id === schedule.buildingId);
        return {
          ...schedule,
          buildingName: building?.name || schedule.buildingId,
        };
      });
      setSchedules(dataWithNames);
    } catch (error) {
      logger.error('加载排班数据失败', error);
      toast.error('加载排班数据失败');
    }
  };

  const getScheduleStaffId = (buildingId: string, dutyDate: string): string | null => {
    const schedule = schedules.find(
      (s) => s.buildingId === buildingId && s.dutyDate === dutyDate,
    );
    return schedule?.staffId || null;
  };

  const handleSave = async () => {
    const dateStr = selectedDate?.toISOString().split('T')[0];
    if (!dateStr) {
      toast.error('请先选择日期');
      return;
    }

    const data: Array<{ buildingId: string; dutyDate: string; staffId: string }> = [];
    
    buildings.forEach((building) => {
      const staffId = getScheduleStaffId(building.id, dateStr);
      if (staffId) {
        data.push({
          buildingId: building.id,
          dutyDate: dateStr,
          staffId,
        });
      }
    });

    if (data.length === 0) {
      toast.error('请至少选择一个值班人员');
      return;
    }

    setLoading(true);
    try {
      await batchUpsertDutySchedules({ schedules: data });
      toast.success('保存成功');
      await loadSchedules();
    } catch (error) {
      logger.error('保存排班数据失败', error);
      toast.error('保存排班数据失败');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = () => {
    const dateStr = selectedDate?.toISOString().split('T')[0];
    if (!dateStr) return;

    const newSchedules = schedules.filter(
      (s) => !(s.buildingId && s.dutyDate === dateStr),
    );
    setSchedules(newSchedules);
    toast.success('已重置排班');
  };

  return (
    <div className="container mx-auto max-w-7xl space-y-6 p-4">
      <div className="mb-4 rounded-lg bg-red-500 p-4 text-center text-white font-bold text-xl">
        警告：这是旧的排班管理页面，不应显示此页面！
      </div>
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-1 items-center gap-4">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-full justify-start md:w-auto">
                {selectedDate ? (
                  selectedDate.toLocaleDateString('zh-CN')
                ) : (
                  '选择日期'
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <Calendar
                mode="single"
                selected={selectedDate}
                onSelect={setSelectedDate}
                initialFocus
              />
            </PopoverContent>
          </Popover>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleReset}>
            重置
          </Button>
          <Button onClick={handleSave} disabled={loading}>
            {loading ? '保存中...' : '保存'}
          </Button>
        </div>
      </div>

      <div
        data-ai-section-type="card-list"
        className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3"
      >
        {buildings.map((building) => {
          const dateStr = selectedDate?.toISOString().split('T')[0] || '';
          const staffId = getScheduleStaffId(building.id, dateStr);

          return (
            <Card key={building.id} className="shadow-sm">
              <CardHeader>
                <CardTitle className="text-xl font-semibold">
                  {building.name}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">
                    值班日期
                  </label>
                  <div className="rounded-md border border-input bg-background px-3 py-2 text-sm">
                    {selectedDate
                      ? selectedDate.toLocaleDateString('zh-CN')
                      : '请选择日期'}
                  </div>
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">
                    值班人员 <span className="text-destructive">*</span>
                  </label>
                  <UserSelect
                    value={staffId}
                    onChange={(value) => {
                      const userId = value as unknown as string | null;
                      if (!userId) return;

                      const updatedSchedules = schedules.filter(
                        (s) =>
                          !(
                            s.buildingId === building.id &&
                            s.dutyDate === dateStr
                          ),
                      );

                      setSchedules([
                        ...updatedSchedules,
                        {
                          id: `${building.id}-${dateStr}`,
                          buildingId: building.id,
                          dutyDate: dateStr,
                          staffId: userId,
                          buildingName: building.name,
                        },
                      ]);
                    }}
                    placeholder="请选择值班人员"
                  />
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
