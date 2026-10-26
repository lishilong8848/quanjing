import type { ReactNode } from 'react';
import { ManagementHeader } from '../PurchaseInventoryManagement/ManagementHeader';

export function ThresholdHeader({
  refreshing,
  updatedAt,
  refreshDisabled,
  onRefresh,
  children,
}: {
  refreshing: boolean;
  updatedAt: string;
  refreshDisabled: boolean;
  onRefresh: () => void;
  children: ReactNode;
}) {
  return (
    <ManagementHeader
      activePage="threshold"
      title="园区 SCP · 阈值管理"
      subtitle=""
      toolbarLabel="阈值管理操作"
      showSearch={false}
      updatedAt={updatedAt}
      refreshing={refreshing}
      onRefresh={refreshDisabled ? undefined : onRefresh}
      actions={children}
    />
  );
}
