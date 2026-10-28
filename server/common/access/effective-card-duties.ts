import { CARD_ROLE_CODES, type EffectiveCardDuty } from '../../../shared/access-configuration.interface';
import { PURCHASE_ACCESS_BUILDINGS } from '../../../shared/access-control.interface';
import type { ConfigurationState } from './access-configuration.store';
import { CARD_PERSONNEL_DUTIES, resolvePersonnelDutyMembers } from './personnel-duty-routing';
import { resolveCurrentPersonnelDutyMembers } from './personnel-duty-current';
import { resolvePersonnelSourceMembers } from './personnel-source.policy';
import { ruleKey } from './access-configuration.validation';

/** The same resolver used by actual card delivery; never infer people from an obsolete rule. */
export function effectiveCardDuties(state: ConfigurationState, appId: string): EffectiveCardDuty[] {
  return CARD_ROLE_CODES.flatMap(code => {
    const buildings = ['building_executor','warehouse_responsible','warehouse_notify'].includes(code) ? [...PURCHASE_ACCESS_BUILDINGS] : [null];
    return buildings.map(building => {
      let source: EffectiveCardDuty['source'] = 'default';
      try {
        const kind=CARD_PERSONNEL_DUTIES[code], target={building};
        if (state.personnelSource) source='personnel';
        const personnel=resolvePersonnelSourceMembers(state.personnelSource,appId,kind,target);
        if(personnel === null) {
          source='handover';
          const handover=resolvePersonnelDutyMembers(state.personnelDutyAssignments,appId,kind,target);
          if(handover === null) source=state.cardRules[ruleKey(code,building)] ? 'configuration' : 'default';
        }
        const members=resolveCurrentPersonnelDutyMembers(state,appId,kind,target);
        return {code,building,members:members || [],status:members === null ? 'unknown' as const : 'resolved' as const,source,revision:state.revision,
          ...(source === 'personnel' && state.personnelSource ? {sourceStatus:state.personnelSource.status} : {})};
      } catch {
        return {code,building,members:[],status:'blocked' as const,source,revision:state.revision,
          ...(source === 'personnel' && state.personnelSource ? {sourceStatus:state.personnelSource.status} : {})};
      }
    });
  });
}
