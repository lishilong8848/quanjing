import {
  OvertimeApprovalRoutingError,
  resolveOvertimeApprovalRoute,
} from './overtime-workflow.rules';
import type {
  OvertimeApprovalRouteInput,
  OvertimeOrganizationRecord,
  OvertimeRoutePerson,
} from './overtime-workflow.types';

const people = {
  applicant: person('张三', 'ou_zhangsan', '运维值班员', ['A楼']),
  aLead: person('施小东', 'ou_shi', '设施运维主管', ['A楼'], ['施小东']),
  bLead: person('陈继猛', 'ou_chen', '设施运维主管', ['B楼'], ['陈继猛']),
  cLead: person('孙婷婷', 'ou_sun', '设施运维主管', ['C楼'], ['孙婷婷']),
  dLead: person('陶必亮', 'ou_tao', '设施运维主管', ['D楼'], ['陶必亮']),
  eLead: person('陈凯', 'ou_kai', '设施运维主管', ['E楼'], ['陈凯']),
  hLead: person('周庆庆', 'ou_zhou', 'H楼值班主管', ['H楼'], ['周庆庆']),
  electricalLead: person(
    '周海祥',
    'ou_zhou_hai',
    '电气主管',
    ['A楼', '110站'],
    ['周海祥'],
  ),
  manager: person(
    '梅冰冰',
    'ou_manager',
    '设施运维经理',
    ['全园区'],
    ['梅冰冰'],
  ),
  deputy: person(
    '马进宇',
    'ou_deputy',
    '设施运维副经理',
    ['全园区'],
    ['马进宇'],
  ),
};

const directory: OvertimeOrganizationRecord[] = [
  people.aLead,
  people.bLead,
  people.cLead,
  people.dLead,
  people.eLead,
  people.hLead,
  people.electricalLead,
  people.manager,
  people.deputy,
  valueAccount('A楼', '施小东'),
  valueAccount('B楼', '陈继猛'),
  valueAccount('C楼', '孙婷婷'),
  valueAccount('D楼', '陶必亮'),
  valueAccount('E楼', '陈凯'),
  valueAccount('H楼', '周庆庆'),
];

describe('resolveOvertimeApprovalRoute', () => {
  it.each([
    ['A楼', '施小东'],
    ['B楼', '陈继猛'],
    ['C楼', '孙婷婷'],
    ['D楼', '陶必亮'],
    ['E楼', '陈凯'],
  ])('%s 普通人员路由至该楼值班账号记录的主管', (building, expected) => {
    const route = resolve({
      ...people.applicant,
      buildings: [building],
    });

    expect(route.kind).toBe('building_supervisor');
    expect(route.approverNames).toEqual([expected]);
  });

  it.each(['运维值班员', '运维值班长'])(
    'H楼%s路由至H楼值班账号记录的主管',
    (position) => {
      const route = resolve({
        ...people.applicant,
        position,
        buildings: ['H楼'],
      });

      expect(route.kind).toBe('h_duty_supervisor');
      expect(route.approverNames).toEqual(['周庆庆']);
    },
  );

  it('110普通人员路由至包含110站的电气主管记录的主管', () => {
    const route = resolve({
      ...people.applicant,
      position: '110值班人员',
      buildings: ['110站'],
    });

    expect(route.kind).toBe('station_110_electrical_supervisor');
    expect(route.approverNames).toEqual(['周海祥']);
  });

  it.each([
    ['A楼设施运维主管', '设施运维主管', ['A楼']],
    ['H楼非值班人员', '暖通工程师', ['H楼']],
    ['专业主管', '电气主管', ['A楼', '110站']],
    ['其他人员', '综合管理', ['全园区']],
  ])('%s路由至机房经理组', (_label, position, buildings) => {
    const route = resolve({
      ...people.applicant,
      position,
      buildings,
    });

    expect(route.kind).toBe('manager_group');
    expect(route.approverNames).toEqual(['梅冰冰', '马进宇']);
  });

  it('按openId去重经理组成员并剔除申请人，禁止自审', () => {
    const duplicateManager = {
      ...people.manager,
      name: '梅冰冰（重复记录）',
    };
    const route = resolveOvertimeApprovalRoute({
      applicant: {
        ...people.deputy,
        buildings: ['全园区'],
      },
      organizationRecords: [...directory, duplicateManager],
    });

    expect(route.approvers).toEqual([
      expect.objectContaining({ name: '梅冰冰', openId: 'ou_manager' }),
    ]);
  });

  it('具体路由只剩申请人本人时返回明确的禁止自审错误', () => {
    expect(() =>
      resolveOvertimeApprovalRoute({
        applicant: {
          ...people.aLead,
          position: '运维值班员',
          buildings: ['A楼'],
        },
        organizationRecords: directory,
      }),
    ).toThrow(
      new OvertimeApprovalRoutingError(
        'NO_ELIGIBLE_APPROVER',
        '申请人不能审批自己的加班申请，且没有其他可用审批人',
      ),
    );
  });

  it('主管姓名在人员目录中不唯一时拒绝猜测', () => {
    expect(() =>
      resolveOvertimeApprovalRoute({
        applicant: people.applicant,
        organizationRecords: [
          ...directory,
          { ...people.aLead, openId: 'ou_another_shi' },
        ],
      }),
    ).toThrow(
      new OvertimeApprovalRoutingError(
        'APPROVER_NAME_NOT_UNIQUE',
        '审批人“施小东”在组织架构中存在多条不同人员记录，无法唯一解析',
      ),
    );
  });

  it('审批人记录缺少飞书账号时返回明确错误', () => {
    expect(() =>
      resolveOvertimeApprovalRoute({
        applicant: people.applicant,
        organizationRecords: directory.map((entry) =>
          entry.name === '施小东' ? { ...entry, openId: '' } : entry,
        ),
      }),
    ).toThrow(
      new OvertimeApprovalRoutingError(
        'APPROVER_NOT_FOUND',
        '审批人“施小东”缺少飞书账号，无法发送加班审批卡',
      ),
    );
  });

  it('找不到规则目标记录时返回可运维的明确错误', () => {
    expect(() =>
      resolveOvertimeApprovalRoute({
        applicant: people.applicant,
        organizationRecords: directory.filter(
          (entry) =>
            !(entry.position === '值班账号' && entry.buildings.includes('A楼')),
        ),
      }),
    ).toThrow(
      new OvertimeApprovalRoutingError(
        'ROUTE_TARGET_NOT_FOUND',
        '未找到A楼“值班账号”组织记录，无法确定加班审批人',
      ),
    );
  });

  it('值班账号与主管不是同一人时严格取主管字段，不向公共值班账号发卡', () => {
    const route = resolve(people.applicant);

    expect(route.approvers).toEqual([
      expect.objectContaining({ name: '施小东', openId: 'ou_shi' }),
    ]);
    expect(route.approvers).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ openId: 'ou_duty_A楼' }),
      ]),
    );
  });

  it('目标值班账号记录缺少主管字段时拒绝猜测', () => {
    expect(() =>
      resolveOvertimeApprovalRoute({
        applicant: people.applicant,
        organizationRecords: directory.map((entry) =>
          entry.position === '值班账号' && entry.buildings.includes('A楼')
            ? { ...entry, supervisorNames: [] }
            : entry,
        ),
      }),
    ).toThrow(
      new OvertimeApprovalRoutingError(
        'APPROVER_NOT_FOUND',
        'A楼“值班账号”组织记录缺少主管字段，无法确定加班审批人',
      ),
    );
  });
});

function resolve(applicant: OvertimeRoutePerson) {
  return resolveOvertimeApprovalRoute({
    applicant,
    organizationRecords: directory,
  });
}

function person(
  name: string,
  openId: string,
  position: string,
  buildings: string[],
  supervisorNames: string[] = [],
): OvertimeOrganizationRecord {
  return { name, openId, position, buildings, supervisorNames };
}

function valueAccount(
  building: string,
  supervisorName: string,
): OvertimeOrganizationRecord {
  return person(
    `南通基地-${building}值班`,
    `ou_duty_${building}`,
    '值班账号',
    [building],
    [supervisorName],
  );
}

void ({} as OvertimeApprovalRouteInput);
