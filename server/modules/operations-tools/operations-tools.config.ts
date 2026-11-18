import type { ToolSourceKey } from '../../../shared/operations-tools.interface';

// Public resource identifiers from the user-approved Base; these are not access credentials.
export const TOOLS_BASE = 'Ix2Db9hMfaZacms9cxdcBdnJnMc';
export const TOOLS_BASE_URL = `https://vnet.feishu.cn/base/${TOOLS_BASE}`;
export const TOOL_SOURCES: Record<
  ToolSourceKey,
  { tableId: string; viewId: string; cacheName?: string }
> = {
  ledger: { tableId: 'tbl8pYoYy88r2OSx', viewId: 'vew3FZgTUf' },
  maintenance: { tableId: 'tblutFXoTA0mPkt1', viewId: 'vewFCnUXz8', cacheName: '维护管理' },
};
export const TOOLS_SYNC_INTERVAL_MS = 60_000;
