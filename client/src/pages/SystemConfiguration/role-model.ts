import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthorizationRoleList } from '@shared/authorization-profile';
import { loadAuthorizationRoles } from './api';

export function useAuthorizationRoles(revision: number | undefined) {
  const [data, setData] = useState<AuthorizationRoleList>();
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const sequence = useRef(0), pending = useRef<{ sequence: number; revision: number | undefined; promise: Promise<void> } | undefined>(undefined);
  const refresh = useCallback((): Promise<void> => {
    if (pending.current?.sequence === sequence.current && pending.current.revision === revision) return pending.current.promise;
    const token = ++sequence.current;
    setLoading(true); setError('');
    const promise = (async () => {
      try { const result = await loadAuthorizationRoles(); if (!result || !Array.isArray(result.roles) || !Number.isSafeInteger(result.revision)) throw new Error('角色清单格式异常，请重新读取'); if (token === sequence.current) setData(current => !current || result.revision >= current.revision ? result : current); }
      catch (failure) { if (token === sequence.current) setError((failure as Error).message); }
      finally { if (token === sequence.current) setLoading(false); if (pending.current?.sequence === token) pending.current = undefined; }
    })();
    pending.current = { sequence: token, revision, promise };
    return promise;
  }, [revision]);
  useEffect(() => { if (revision !== undefined) void refresh(); }, [revision, refresh]);
  useEffect(() => () => { sequence.current++; }, []);
  return { data, loading, error, refresh };
}
