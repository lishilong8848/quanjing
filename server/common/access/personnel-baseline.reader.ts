import type { ConfigurationDirectorySnapshot } from './access-configuration.directory';
import type { ConfigurationState } from './access-configuration.store';
import type { PersonnelBaselineEvidence } from '../../../shared/personnel-baseline.interface';

export const PERSONNEL_BASELINE_READER=Symbol('PERSONNEL_BASELINE_READER');
export interface PersonnelBaselineReader {
  read(directory:ConfigurationDirectorySnapshot,state:ConfigurationState):Promise<Record<string,PersonnelBaselineEvidence>>;
}
