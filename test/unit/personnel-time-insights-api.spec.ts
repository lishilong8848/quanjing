jest.mock('@nestjs/common', () => {
  const actual = jest.requireActual('@nestjs/common');
  const decorator = () => () => undefined;
  const setMetadata =
    (key: string, value: unknown) =>
    (...decoratorArguments: unknown[]) => {
      const [target, context, descriptor] = decoratorArguments as [
        object,
        { kind?: string } | string | undefined,
        { value?: object } | undefined,
      ];
      const metadataTarget =
        typeof context === 'object' && context?.kind === 'method'
          ? target
          : descriptor?.value || target;
      Reflect.defineMetadata(key, value, metadataTarget);
    };
  return {
    ...actual,
    Controller: decorator,
    Get: decorator,
    Header: decorator,
    Query: decorator,
    SetMetadata: setMetadata,
  };
});

import { AdminOnlyMetadataKey } from '../../server/common/access/unified-access.decorators';
import { PersonnelTimeInsightsController } from '../../server/modules/personnel-time-insights/personnel-time-insights.controller';

describe('PersonnelTimeInsightsController', () => {
  it('查询接口仅允许管理员访问，并原样传递日期范围', async () => {
    const service = {
      getInsights: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new PersonnelTimeInsightsController(service as never);

    await expect(
      controller.getInsights('2026-01-01', '2026-12-31'),
    ).resolves.toEqual({ ok: true });
    expect(service.getInsights).toHaveBeenCalledWith(
      '2026-01-01',
      '2026-12-31',
    );
    expect(
      Reflect.getMetadata(
        AdminOnlyMetadataKey,
        PersonnelTimeInsightsController.prototype.getInsights,
      ),
    ).toBe(true);
  });
});
