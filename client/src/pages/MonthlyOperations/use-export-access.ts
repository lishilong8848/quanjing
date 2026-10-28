import { useEffect, useRef } from 'react';
import { axiosForBackend } from '@lark-apaas/client-toolkit/utils/getAxiosForBackend';
import { useAccess } from '@/access/AccessProvider';
import { canUsePageAction } from '../business-action-access';

export function useMonthlyOperationsExport() {
  const access = useAccess();
  const canExport = canUsePageAction(access, 'monthly_operations', 'export', true);
  const current = useRef({ identity: access.principalFingerprint, allowed: canExport });
  current.current = { identity: access.principalFingerprint, allowed: canExport };
  const inFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const authorizeExport = async (download: () => void, feedback: (message: string) => void) => {
    if (!current.current.allowed) { feedback('当前身份无导出权限'); return; }
    if (inFlight.current) return;
    inFlight.current = true;
    const identity = current.current.identity;
    feedback('正在确认导出权限…');
    try {
      await axiosForBackend({ url: '/api/bitable/monthly-operations/export-access', method: 'GET', timeout: 10000 });
      if (!mounted.current) return;
      if (current.current.identity !== identity || !current.current.allowed) { feedback('登录身份或权限已变化，请重新导出'); return; }
      download();
    } catch (error) {
      if (!mounted.current) return;
      const status = (error as { response?: { status?: number } })?.response?.status;
      feedback(status === 401 || status === 403 ? '当前身份无导出权限，请核对登录状态和权限配置' : '导出权限暂时未能确认，请稍后重试');
    } finally {
      inFlight.current = false;
    }
  };
  return { canExport, authorizeExport };
}
