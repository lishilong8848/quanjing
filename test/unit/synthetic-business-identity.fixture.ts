// Legacy business tests supply an explicit local identity port; production DI remains mandatory.
let originalAppId: string | undefined;
beforeEach(() => { originalAppId = process.env.FEISHU_APP_ID; });
afterEach(() => {
  if (originalAppId === undefined) delete process.env.FEISHU_APP_ID;
  else process.env.FEISHU_APP_ID = originalAppId;
});

export function withSyntheticBusinessIdentity<T extends new (...args: any[]) => any>(Base: T, argumentIndex: number): T {
  return class extends Base {
    constructor(...args: any[]) {
      process.env.FEISHU_APP_ID ||= 'cli_synthetic_business';
      args[argumentIndex] ??= { canUseFeishuBusinessIdentity: () => true };
      super(...args);
    }
  } as T;
}
