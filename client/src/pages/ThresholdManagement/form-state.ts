import type { ThresholdInput } from '@shared/threshold-management.interface';

export const EMPTY_THRESHOLD: ThresholdInput = {
  profession: '电气',
  device: '',
  section: '',
  parameter: '',
  building: '',
  location: '',
  value: '',
  range: '',
  unit: '',
  kind: '告警',
  enabled: '',
  note: '',
};
