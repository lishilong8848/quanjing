import type { AccessPrincipal } from '../../shared/access-control.interface';
import type {
  ThresholdAdjustmentContext,
  ThresholdAdjustmentInput,
} from '../../shared/threshold-adjustment.interface';
import type { ThresholdRecord } from '../../shared/threshold-management.interface';
import { thresholdContentFingerprint } from '../../shared/threshold-bitable';
import * as config from '../../server/common/config/external-services.config';
import { feishuIdentityFingerprint } from '../../server/common/access/feishu-access-approved-grants';
import { ThresholdAdjustmentService } from '../../server/modules/threshold-management/threshold-adjustment.service';

const original: ThresholdRecord = {
  id: 'synthetic-threshold',
  profession: '电气',
  building: 'A楼',
  device: 'UPS',
  section: '输出',
  parameter: '电压',
  location: '合成位置',
  value: '220',
  unit: 'V',
  kind: '设定',
  enabled: '',
  note: '',
  version: 1,
  updatedAt: '',
  source: { sheet: '合成', cell: 'A1', originalValue: '220' },
};
const applicant = {
  openId: 'ou_synthetic_applicant',
  name: '合成申请人',
  position: '电气工程师',
  professions: ['电气'],
  buildings: ['A楼'],
};
const colleague = {
  ...applicant,
  openId: 'ou_synthetic_colleague',
  name: '合成另一工程师',
};
const context: ThresholdAdjustmentContext = {
  engineers: [
    { ...applicant, profession: '电气' },
    { ...colleague, profession: '电气' },
  ],
  roles: [
    applicant,
    colleague,
    {
      openId: 'ou_synthetic_building',
      name: '合成楼长',
      position: '设施运维主管',
      professions: [],
      buildings: ['A楼'],
    },
    {
      openId: 'ou_synthetic_professional',
      name: '合成主管',
      position: '电气主管',
      professions: ['电气'],
      buildings: ['A楼'],
    },
    {
      openId: 'ou_synthetic_manager',
      name: '合成经理',
      position: '设施运维经理',
      professions: [],
      buildings: ['A楼'],
    },
  ],
};
function actor(
  role: AccessPrincipal['role'] = 'guest',
  allow = true,
): AccessPrincipal {
  return {
    role,
    purchaseBuilding: null,
    accountId: `feishu-${feishuIdentityFingerprint('synthetic-duty-app', applicant.openId)}`,
    ...(role === 'professional_engineer'
      ? {
          purchaseBuilding: 'A楼' as const,
          buildings: ['A楼' as const],
          specialties: ['电气' as const],
        }
      : {}),
    effectiveAuthorization: {
      mode: 'independent',
      baseline: {
        nativeRole: null,
        pages: [],
        rules: [
          {
            id: 'synthetic-create',
            module: 'thresholds',
            actions: ['create'],
            effect: allow ? 'allow' : 'deny',
            buildings: null,
            specialties: null,
          },
        ],
      },
      overrides: { allowPages: [], denyPages: [], rules: [] },
    },
  };
}
function fixture() {
  const ledger = {
    list: jest.fn(() => []),
    reserve: jest.fn((entry) => structuredClone(entry)),
  };
  const service = Object.assign(
    Object.create(ThresholdAdjustmentService.prototype),
    {
      ledger,
      records: {
        list: jest.fn(() => ({ records: [structuredClone(original)] })),
      },
      gateway: { peekContext: jest.fn(() => structuredClone(context)) },
      recovered: true,
      kick: jest.fn(),
    },
  ) as ThresholdAdjustmentService;
  const input: ThresholdAdjustmentInput = {
    clientMutationId: 'threshold-synthetic-duty-0001',
    thresholdId: original.id,
    expectedVersion: 1,
    expectedContent: thresholdContentFingerprint(original),
    value: '219',
    reason: '合成校验',
    plannedAt: new Date(Date.now() + 600000).toISOString(),
  };
  return { service, input, ledger };
}

describe('threshold submission permission does not delegate the real engineer duty', () => {
  beforeEach(() => {
    jest.spyOn(config, 'getFeishuAuthPayload').mockReturnValue({
      app_id: 'synthetic-duty-app',
      app_secret: 'synthetic-only',
    });
  });
  afterEach(() => jest.restoreAllMocks());

  it.each(['guest', 'professional_engineer'] as const)(
    '%s with create authorization cannot submit for another engineer',
    (role) => {
      const { service, input, ledger } = fixture();
      expect(() =>
        service.submit(
          { ...input, engineerOpenId: colleague.openId },
          actor(role),
        ),
      ).toThrow('代提交仅限管理员');
      expect(ledger.reserve).not.toHaveBeenCalled();
    },
  );
  it.each([undefined, applicant.openId])(
    'permits self-submission with engineerOpenId=%s and preserves independent approvers',
    (engineerOpenId) => {
      const { service, input, ledger } = fixture();
      const result = service.submit({ ...input, engineerOpenId }, actor());
      expect(result.engineer.openId).toBe(applicant.openId);
      expect(result.applicant.openId).toBe(applicant.openId);
      expect(result.stages.map((stage) => stage.approver.openId)).toEqual([
        'ou_synthetic_building',
        'ou_synthetic_professional',
      ]);
      expect(ledger.reserve).toHaveBeenCalledTimes(1);
    },
  );
  it('retains fixed administrator delegation to a real engineer in the record scope', () => {
    const { service, input } = fixture();
    const administrator = actor('admin');
    delete administrator.effectiveAuthorization;
    const result = service.submit(
      { ...input, engineerOpenId: colleague.openId },
      administrator,
    );
    expect(result.engineer.openId).toBe(colleague.openId);
    expect(result.applicant.openId).toBe(applicant.openId);
  });
  it('rejects a logged-in non-engineer even when the profile allows create', () => {
    const { service, input, ledger } = fixture(),
      principal = actor();
    principal.accountId = `feishu-${feishuIdentityFingerprint('synthetic-duty-app', 'ou_synthetic_manager')}`;
    expect(() => service.submit(input, principal)).toThrow('代提交仅限管理员');
    expect(ledger.reserve).not.toHaveBeenCalled();
  });
  it('keeps the action permission gate in front of the engineer duty and performs no reservation on denial', () => {
    const { service, input, ledger } = fixture();
    expect(() => service.submit(input, actor('guest', false))).toThrow(
      '当前操作超出授权',
    );
    expect(ledger.reserve).not.toHaveBeenCalled();
  });

  it('rejects an unbound identity instead of adopting the submitted engineer', () => {
    const { service, input, ledger } = fixture(),
      principal = actor();
    principal.accountId = 'synthetic-unbound-account';
    expect(() =>
      service.submit({ ...input, engineerOpenId: applicant.openId }, principal),
    ).toThrow('申请人身份未确认');
    expect(ledger.reserve).not.toHaveBeenCalled();
  });
});
