import { BadRequestException } from '@nestjs/common';
import { PersonnelTimeInsightsService } from '../../server/modules/personnel-time-insights/personnel-time-insights.service';

describe('PersonnelTimeInsightsService', () => {
  it('每次查询只读取一次加班、确认和请休假台账', async () => {
    const overtimeStore = {
      listApplications: jest.fn().mockResolvedValue([]),
      listConfirmations: jest.fn().mockResolvedValue([]),
    };
    const leaveStore = {
      listApplications: jest.fn().mockResolvedValue([]),
    };
    const service = new PersonnelTimeInsightsService(
      overtimeStore as never,
      leaveStore as never,
    );

    const result = await service.getInsights('2026-01-01', '2026-12-31');

    expect(result.range).toEqual({ from: '2026-01-01', through: '2026-12-31' });
    expect(overtimeStore.listApplications).toHaveBeenCalledTimes(1);
    expect(overtimeStore.listConfirmations).toHaveBeenCalledTimes(1);
    expect(leaveStore.listApplications).toHaveBeenCalledTimes(1);
  });

  it('把日期范围错误转换为可读的 400 错误', async () => {
    const service = new PersonnelTimeInsightsService(
      {
        listApplications: jest.fn().mockResolvedValue([]),
        listConfirmations: jest.fn().mockResolvedValue([]),
      } as never,
      { listApplications: jest.fn().mockResolvedValue([]) } as never,
    );

    await expect(
      service.getInsights('2026-12-31', '2026-01-01'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
