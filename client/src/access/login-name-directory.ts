import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import type { AccessLoginNamesResponse } from '@shared/access-login-names.interface';

export function matchLoginNames(names: readonly string[], query: string): string[] {
  const search = query.trim().toLocaleLowerCase();
  if (!search) return [];
  return names.filter(name => name.toLocaleLowerCase().includes(search)).slice(0, 8);
}

export function createLoginNameDirectory(read: () => Promise<AccessLoginNamesResponse>, now = Date.now) {
  let cached: AccessLoginNamesResponse | undefined;
  let cachedAt = 0;
  let pending: Promise<AccessLoginNamesResponse> | undefined;
  return {
    load(): Promise<AccessLoginNamesResponse> {
      if (cached && now() - cachedAt < 5 * 60_000) return Promise.resolve(cached);
      if (pending) return pending;
      pending = read().then(data => {
        if (!Array.isArray(data?.names) || data.names.length > 5000 || !Number.isFinite(data.snapshotAt) || data.names.some(name => typeof name !== 'string' || !name.trim() || name.length > 128 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name))) throw new Error('姓名列表暂不可用');
        cached = { names: [...new Set(data.names.map(name => name.trim()))], snapshotAt: data.snapshotAt };
        cachedAt = now();
        return cached;
      }).finally(() => { pending = undefined; });
      return pending;
    },
  };
}

export const loginNameDirectory = createLoginNameDirectory(async () => {
  const response = await axiosForBackend({ url: '/api/access/login-names', method: 'GET', timeout: 8000 });
  return response.data as AccessLoginNamesResponse;
});
