import type { ToolSourceKey } from '../../../shared/operations-tools.interface';

// Public resource identifiers from the user-approved Base; these are not access credentials.
export const TOOLS_BASE = 'Ix2Db9hMfaZacms9cxdcBdnJnMc';
export const TOOLS_BASE_URL = `https://example.feishu.cn/base/PUBLIC_EXAMPLE_SOURCE`;
export const TOOL_SOURCES: Record<
  ToolSourceKey,
  { tableId: string; formId?: string }
> = {
  ledger: { tableId: 'tblfdc38e045dfc6' },
  maintenance: { tableId: 'tblcadacc78d0830', formId: 'vew1TfPzkH' },
  inspection: { tableId: 'tbl559ef0b8ef69c', formId: 'vewadx0RVn' },
  quality: { tableId: 'tblb00ab09c8f9a4', formId: 'vewXQc82zT' },
  repair: { tableId: 'tbl8612310f11da8' },
  scrap: { tableId: 'tbld73ba8a15e459', formId: 'vewakUetzX' },
  borrow: { tableId: 'tbla643edeb6e3b4', formId: 'vew1V7wBtH' },
};
export const TOOLS_SYNC_INTERVAL_MS = 60_000;
