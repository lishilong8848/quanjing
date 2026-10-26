import type { HandoverAdapter } from '../../../shared/personnel-handover.interface';

export type PersonnelPreviewReader = Pick<HandoverAdapter, 'module' | 'listPending'>;
export const PERSONNEL_PREVIEW_READERS = {
  leave: Symbol('personnel-preview.leave'),
  overtime: Symbol('personnel-preview.overtime'),
  inventory: Symbol('personnel-preview.inventory'),
  purchase: Symbol('personnel-preview.purchase'),
  contracts: Symbol('personnel-preview.contracts'),
} as const;
