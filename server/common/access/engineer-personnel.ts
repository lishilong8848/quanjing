import { extractDisplayText, type BitableRecordItem } from '../feishu/bitable-direct-read';
import { normalizeProfessionalScope, type ProfessionalSpecialty } from '../../../shared/professional-access';
import { normalizedBusinessBuildings } from '../../../shared/business-permissions';
import type { BuildingAdminBuilding } from '../../../shared/access-control.interface';

export interface PersonnelEngineerScope { specialties: ProfessionalSpecialty[]; buildings: BuildingAdminBuilding[]; }
export function readPersonnelEngineerScope(fields: BitableRecordItem['fields']): { engineerScope?: PersonnelEngineerScope | null; engineerScopeInvalid?: true } {
  const position = extractDisplayText(fields?.['岗位'], '、').trim();
  const systemPosition = extractDisplayText(fields?.['体系岗位'], '、').trim();
  const labels = [position, systemPosition].filter(Boolean);
  if (!labels.some(value => value.includes('工程师')) || labels.some(value => /主管|经理|总监|负责人/u.test(value))) return { engineerScope: null };
  const specialtiesByLabel = labels.map(label => normalizeProfessionalScope(label.match(/电气|供配电|暖通|弱电|消防|EHS|安全|土建/giu) || []));
  const nonempty = specialtiesByLabel.filter(values => values.length);
  const scopeLabels = extractDisplayText(fields?.['机楼/专业'] ?? fields?.['机楼专业'], '、').split(/[、,，;；/]/u).map(value => value.trim()).filter(Boolean);
  const fromScope = normalizeProfessionalScope(scopeLabels);
  const specialties = nonempty[0] || fromScope;
  const buildings = [...new Set(scopeLabels.flatMap(value => normalizedBusinessBuildings(value)))];
  if (!specialties.length || !buildings.length || nonempty.some(values => JSON.stringify(values) !== JSON.stringify(specialties)) ||
    (fromScope.length && JSON.stringify(fromScope) !== JSON.stringify(specialties))) return { engineerScopeInvalid: true };
  return { engineerScope: { specialties, buildings } };
}
