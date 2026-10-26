import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { AccessLoginNamesResponse } from '../../../shared/access-login-names.interface';
import { readLatestPersistedBitableRecordSnapshot } from '../feishu/bitable-direct-read';
import { buildActivePersonnelDirectory, DEFAULT_ACTIVE_PERSONNEL_TABLE_ID, DEFAULT_ACTIVE_PERSONNEL_VIEW_ID } from '../../modules/bitable-sync/active-personnel-directory';
import { normalizeAccessDisplayName } from './access-display-name';

@Injectable()
export class AccessLoginNamesService {
  async read(): Promise<AccessLoginNamesResponse> {
    const env = process.env;
    const snapshot = await readLatestPersistedBitableRecordSnapshot({
      appToken: env.FEISHU_ORG_APP_TOKEN?.trim() || env.FEISHU_ORGANIZATION_APP_TOKEN?.trim() || undefined,
      tableId: env.FEISHU_ORG_TABLE_ID?.trim() || env.FEISHU_ORGANIZATION_TABLE_ID?.trim() || DEFAULT_ACTIVE_PERSONNEL_TABLE_ID,
      viewId: env.FEISHU_ORG_VIEW_ID?.trim() || env.FEISHU_ORGANIZATION_VIEW_ID?.trim() || DEFAULT_ACTIVE_PERSONNEL_VIEW_ID,
      tableName: '在职人员',
    });
    if (!snapshot) throw new ServiceUnavailableException('姓名列表暂不可用，请手动输入姓名');
    const directory = buildActivePersonnelDirectory(snapshot);
    const names = (directory.selectablePersonnel ?? directory.personnel).map(person => normalizeAccessDisplayName(person.name)).filter((name): name is string => Boolean(name));
    return { names: [...new Set(names)].sort((a, b) => a.localeCompare(b, 'zh-CN')), snapshotAt: snapshot.fetchedAt };
  }
}
