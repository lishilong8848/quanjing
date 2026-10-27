import { existsSync } from 'fs';
import { join } from 'path';

type PersonProfileScope = 'leave' | 'travel';

interface PersonProfileReadPlan {
  tableId: string;
  viewId?: string;
  tableName: string;
  fieldNames: readonly string[];
  cacheTtlMs: number;
  strict: true;
  allowStale: false;
}

type ParsePersonProfileScope = (scope: unknown) => PersonProfileScope;
type ResolvePersonProfileReadPlan = (
  scope: PersonProfileScope,
  options?: {
    leaveTableId?: string;
    travelTableId?: string;
    travelViewId?: string;
  },
) => PersonProfileReadPlan;

const modulePath = join(
  process.cwd(),
  'server/modules/bitable-sync/person-profile-source.ts',
);

function requireSourceModule(): {
  parsePersonProfileScope: ParsePersonProfileScope;
  resolvePersonProfileReadPlan: ResolvePersonProfileReadPlan;
} {
  expect(existsSync(modulePath)).toBe(true);
  if (!existsSync(modulePath)) {
    throw new Error('person-profile-source.ts is required');
  }
  const loaded = require(modulePath) as {
    parsePersonProfileScope?: ParsePersonProfileScope;
    resolvePersonProfileReadPlan?: ResolvePersonProfileReadPlan;
  };
  expect(typeof loaded.parsePersonProfileScope).toBe('function');
  expect(typeof loaded.resolvePersonProfileReadPlan).toBe('function');
  return loaded as {
    parsePersonProfileScope: ParsePersonProfileScope;
    resolvePersonProfileReadPlan: ResolvePersonProfileReadPlan;
  };
}

describe('person profile source selection', () => {
  it('defaults to the leave scope and rejects arbitrary client scopes', () => {
    const { parsePersonProfileScope } = requireSourceModule();

    expect(parsePersonProfileScope(undefined)).toBe('leave');
    expect(parsePersonProfileScope(' leave ')).toBe('leave');
    expect(parsePersonProfileScope('travel')).toBe('travel');
    expect(() => parsePersonProfileScope('allRecords')).toThrow(
      '人员资料范围无效',
    );
  });

  it('uses the leave Base linked personnel table with a minimal field projection', () => {
    const { resolvePersonProfileReadPlan } = requireSourceModule();

    expect(resolvePersonProfileReadPlan('leave')).toEqual({
      tableId: 'tblATnYxuleJpyVl',
      viewId: undefined,
      tableName: '请休假人员资料',
      fieldNames: ['姓名', '员工姓名', '机楼/专业', '班组', '岗位', '班次'],
      cacheTtlMs: 4 * 60 * 60 * 1000,
      strict: true,
      allowStale: false,
    });
  });

  it('keeps travel on its configured table and view without a full-table fallback', () => {
    const { resolvePersonProfileReadPlan } = requireSourceModule();

    expect(
      resolvePersonProfileReadPlan('travel', {
        travelTableId: 'tbl-travel',
        travelViewId: 'vew-travel',
      }),
    ).toEqual(
      expect.objectContaining({
        tableId: 'tbl-travel',
        viewId: 'vew-travel',
        tableName: '差旅人员资料',
        strict: true,
        allowStale: false,
      }),
    );
    expect(() =>
      resolvePersonProfileReadPlan('travel', {
        travelTableId: 'tbl-travel',
        travelViewId: ' ',
      }),
    ).toThrow('差旅人员视图未配置');
  });
});
