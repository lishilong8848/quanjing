import type { ToolSourceKey } from '../../../shared/operations-tools.interface';

// Public resource identifiers from the user-approved Base; these are not access credentials.
export const TOOLS_BASE = 'Ix2Db9hMfaZacms9cxdcBdnJnMc';
export const TOOLS_BASE_URL = `https://vnet.feishu.cn/base/${TOOLS_BASE}`;
export const TOOL_SOURCES: Record<
  ToolSourceKey,
  { tableId: string; formId?: string }
> = {
  ledger: { tableId: 'tbl8pYoYy88r2OSx' },
  maintenance: { tableId: 'tblutFXoTA0mPkt1', formId: 'vew1TfPzkH' },
  inspection: { tableId: 'tblHtl0cVXn6zci6', formId: 'vewadx0RVn' },
  quality: { tableId: 'tblEwY3AbwiT021v', formId: 'vewXQc82zT' },
  repair: { tableId: 'tblTasmHUxgdtZQd' },
  scrap: { tableId: 'tbl71QoG0R0Q3esn', formId: 'vewakUetzX' },
  borrow: { tableId: 'tblOSUx57CrEocsi', formId: 'vew1V7wBtH' },
};
export const TOOLS_SYNC_INTERVAL_MS = 60_000;
