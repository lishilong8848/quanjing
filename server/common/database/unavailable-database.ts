export const databaseUnavailableMessage =
  '数据库未配置：请在 .env 中配置 SUDA_DATABASE_URL 后再访问排班数据接口';

export class DatabaseUnavailableError extends Error {
  constructor() {
    super(databaseUnavailableMessage);
    this.name = 'DatabaseUnavailableError';
  }
}

export function isDatabaseDisabled() {
  return process.env.FORCE_FRAMEWORK_DISABLE_DATAPASS === 'true';
}

function throwUnavailableDatabase(): never {
  throw new DatabaseUnavailableError();
}

function createEmptyReadQuery(): unknown {
  const query = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown[]) => void, reject?: (error: unknown) => void) =>
            Promise.resolve([]).then(resolve, reject);
        }
        if (prop === 'catch') {
          return (reject: (error: unknown) => void) => Promise.resolve([]).catch(reject);
        }
        if (prop === 'finally') {
          return (onFinally: () => void) => Promise.resolve([]).finally(onFinally);
        }
        return () => query;
      },
    },
  );

  return query;
}

const lifecycleHooks = new Set<PropertyKey>([
  'onModuleInit',
  'onApplicationBootstrap',
  'onModuleDestroy',
  'beforeApplicationShutdown',
  'onApplicationShutdown',
]);

export const unavailableDatabase = new Proxy(
  {},
  {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      if (lifecycleHooks.has(prop)) return undefined;
      if (prop === 'select') return () => createEmptyReadQuery();
      return throwUnavailableDatabase;
    },
  },
);
