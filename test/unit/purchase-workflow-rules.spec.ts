import {
  buildApprovalPatch,
  buildCardApprovalRoutingPatch,
  buildOrderPatch,
  buildReceiptPatch,
  buildStartPatch,
  resolveAllowedActions,
  resolvePurchaseStage,
} from '../../server/modules/purchase-inventory/purchase-workflow.rules';
import {
  PURCHASE_WORKFLOW_STATUSES,
  type PurchaseWorkflowRecord,
  type PurchaseWorkflowUser,
} from '../../shared/purchase-workflow.interface';
import { PURCHASE_ACCESS_BUILDINGS } from '../../shared/access-control.interface';

const manager: PurchaseWorkflowUser = {
  openId: 'ou_manager',
  name: '测试经理',
  positions: ['设施运维经理'],
  buildings: [],
};

const requester: PurchaseWorkflowUser = {
  openId: 'ou_requester',
  name: '测试申请人',
  positions: ['电气工程师'],
  buildings: ['H楼'],
};

const systemAdmin = {
  openId: 'ou_system_admin',
  name: '系统管理员',
  positions: [],
  buildings: [],
  accessRole: 'admin' as const,
};

const purchaseAdmin: PurchaseWorkflowUser = {
  openId: 'ou_purchase_executor',
  name: '采购管理员',
  positions: [],
  buildings: [],
  accessRole: 'purchase_admin',
};

const applicantA: PurchaseWorkflowUser = {
  openId: 'ou_purchase_executor',
  name: 'A楼采购申请账号',
  positions: [],
  buildings: ['A楼'],
  accessRole: 'purchase_applicant',
};

function workflowRecord(
  overrides: Partial<PurchaseWorkflowRecord> = {},
): PurchaseWorkflowRecord {
  return {
    recordId: 'rec_execution_1',
    requestCode: 'CG-2026-001',
    status: '未开始（待审批）',
    itemName: '接线端子排',
    building: 'H楼',
    requesterOpenId: 'ou_requester',
    requesterName: '测试申请人',
    purchaserOpenId: '',
    purchaserName: '',
    purchaseMethod: '',
    requestedQuantity: 10,
    actualQuantity: null,
    actualAmount: null,
    approvalCompleted: false,
    warehouseConfirmed: false,
    purchaseCompleted: false,
    receiptConfirmed: false,
    signer: '',
    receiptTime: null,
    receiptPhotoTokens: [],
    invoiceTokens: [],
    ...overrides,
  };
}

describe('purchase workflow rules', () => {
  it('resolves all supported stages and rejects unknown statuses', () => {
    expect(resolvePurchaseStage('未开始（待审批）')).toBe('application');
    expect(resolvePurchaseStage('审批通过（待库房确认）')).toBe('approval');
    expect(resolvePurchaseStage('库房确认（待下单）')).toBe('ordering');
    expect(resolvePurchaseStage('下单完成（待签收）')).toBe('receipt');
    expect(resolvePurchaseStage('到货已签收（待入库）')).toBe('inbound');
    expect(resolvePurchaseStage('物品签收已入库')).toBe('completed');
    expect(resolvePurchaseStage('已终止')).toBe('terminated');
    expect(resolvePurchaseStage('未知状态')).toBe('unknown');
    expect(PURCHASE_WORKFLOW_STATUSES as readonly string[]).toContain(
      '到货已签收（待入库）',
    );
  });

  it('does not offer receipt again while a signed purchase awaits inbound', () => {
    const awaitingInbound = workflowRecord({
      status: '到货已签收（待入库）',
      purchaseMethod: '需求自采',
      purchaserOpenId: requester.openId,
      purchaserName: requester.name,
      purchaseCompleted: true,
      receiptConfirmed: true,
    });

    expect(resolveAllowedActions(awaitingInbound, requester)).toEqual([]);
  });

  it('lets the system administrator execute every action allowed by the current stage', () => {
    expect(resolveAllowedActions(workflowRecord(), systemAdmin)).toEqual([
      'approve',
    ]);
    expect(
      resolveAllowedActions(
        workflowRecord({
          status: '审批通过（待库房确认）',
          purchaseMethod: '综合采购',
        }),
        systemAdmin,
      ),
    ).toEqual(['start']);
    expect(
      resolveAllowedActions(
        workflowRecord({
          status: '审批通过（待下单）',
          purchaseMethod: '综合采购',
        }),
        systemAdmin,
      ),
    ).toEqual(['order']);
    expect(
      resolveAllowedActions(
        workflowRecord({
          status: '下单完成（待签收）',
          purchaseMethod: '综合采购',
        }),
        systemAdmin,
      ),
    ).toEqual(['receive']);
  });

  it('lets purchase administrators order and limits applicants to same-building self-purchase', () => {
    const selfPurchaseA = workflowRecord({
      status: '审批通过（待下单）',
      building: 'A楼',
      purchaseMethod: '需求自采（楼内）',
      purchaserOpenId: 'ou_purchase_executor',
    });
    const selfPurchaseB = workflowRecord({
      ...selfPurchaseA,
      building: 'B楼',
    });
    const comprehensiveA = workflowRecord({
      ...selfPurchaseA,
      purchaseMethod: '综合采购',
    });

    expect(resolveAllowedActions(comprehensiveA, purchaseAdmin)).toContain(
      'order',
    );
    expect(resolveAllowedActions(selfPurchaseA, applicantA)).toContain('order');
    expect(resolveAllowedActions(selfPurchaseB, applicantA)).not.toContain(
      'order',
    );
    expect(resolveAllowedActions(comprehensiveA, applicantA)).not.toContain(
      'order',
    );
  });

  it('lets every building applicant receive same-building purchases regardless of purchase method', () => {
    for (const building of PURCHASE_ACCESS_BUILDINGS) {
      const applicant: PurchaseWorkflowUser = {
        openId: 'ou_purchase_executor',
        name: `${building}采购申请账号`,
        positions: [],
        buildings: [building],
        accessRole: 'purchase_applicant',
      };
      const comprehensive = workflowRecord({
        status: '下单完成（待签收）',
        building,
        purchaseMethod: '综合采购',
        requesterOpenId: 'ou_business_requester',
        purchaserOpenId: 'ou_other_buyer',
      });
      const selfPurchase = workflowRecord({
        ...comprehensive,
        purchaseMethod: '需求自采（楼内）',
      });
      const otherBuilding = PURCHASE_ACCESS_BUILDINGS.find(
        (candidate) => candidate !== building,
      )!;

      expect(resolveAllowedActions(comprehensive, applicant)).toContain(
        'receive',
      );
      expect(resolveAllowedActions(selfPurchase, applicant)).toContain(
        'receive',
      );
      expect(
        resolveAllowedActions(
          {
            ...comprehensive,
            building: otherBuilding,
            purchaserOpenId: applicant.openId,
          },
          applicant,
        ),
      ).not.toContain('receive');
    }
  });

  it('allows only managers to approve and returns the exact approval patch', () => {
    const record = workflowRecord();
    expect(resolveAllowedActions(record, requester)).not.toContain('approve');
    expect(resolveAllowedActions(record, manager)).toContain('approve');

    expect(
      buildApprovalPatch(record, manager, {
        decision: 'approved',
        purchaseMethod: '综合采购',
        comment: '同意采购',
      }),
    ).toEqual({
      '1️⃣物品采购方式': '综合采购',
      采购流程: '审批通过（待下单）',
    });

    expect(() =>
      buildApprovalPatch(record, requester, {
        decision: 'approved',
        purchaseMethod: '综合采购',
        comment: '',
      }),
    ).toThrow('无权审批采购申请');
  });

  it('routes an approved card action directly to the configured purchaser', () => {
    const comprehensive = workflowRecord({
      purchaseMethod: '综合采购',
    });
    const purchaseAdmin: PurchaseWorkflowUser = {
      openId: 'ou_purchase_admin',
      name: '采购管理员',
      positions: [],
      buildings: [],
    };
    expect(
      buildCardApprovalRoutingPatch(comprehensive, 'approved', purchaseAdmin),
    ).toEqual({
      '1️⃣物品采购方式': '综合采购',
      采购人: [{ id: 'ou_purchase_admin' }],
      库房确认: true,
      采购流程: '审批通过（待下单）',
    });

    const selfPurchase = workflowRecord({
      purchaseMethod: '需求自采',
    });
    const buildingSupervisor: PurchaseWorkflowUser = {
      openId: 'ou_building_supervisor',
      name: 'A楼主管',
      positions: ['楼栋主管'],
      buildings: ['A楼'],
    };
    expect(
      buildCardApprovalRoutingPatch(
        selfPurchase,
        'approved',
        buildingSupervisor,
      ),
    ).toMatchObject({
      采购人: [{ id: 'ou_building_supervisor' }],
      采购流程: '审批通过（待下单）',
    });
    expect(buildCardApprovalRoutingPatch(selfPurchase, 'rejected')).toEqual({
      '1️⃣物品采购方式': '驳回',
      采购流程: '驳回申请',
    });
  });

  it('does not allow state skipping and assigns the expected purchaser on start', () => {
    const approved = workflowRecord({
      status: '审批通过（待库房确认）',
      purchaseMethod: '综合采购',
      approvalCompleted: true,
    });
    const comprehensivePurchaser: PurchaseWorkflowUser = {
      openId: 'ou_buyer',
      name: '综合采购员',
      positions: ['综合管理'],
      buildings: [],
    };

    expect(buildStartPatch(approved, manager, comprehensivePurchaser)).toEqual({
      采购人: [{ id: 'ou_buyer' }],
      库房确认: true,
      采购流程: '审批通过（待下单）',
    });
    expect(
      buildStartPatch(approved, manager, comprehensivePurchaser, '需求自采'),
    ).toEqual({
      采购人: [{ id: 'ou_requester' }],
      库房确认: true,
      采购流程: '审批通过（待下单）',
    });

    expect(() =>
      buildOrderPatch(approved, comprehensivePurchaser, {
        actualQuantity: 1,
        actualAmount: 100,
        paymentAttachmentTokens: [],
        note: '',
      }),
    ).toThrow('当前状态不能提交下单结果');
  });

  it('allows building supervisors to start only same-building self purchases across building formats', () => {
    const supervisor: PurchaseWorkflowUser = {
      openId: 'ou_supervisor',
      name: 'A楼主管',
      positions: ['楼栋主管'],
      buildings: ['A'],
    };
    const comprehensivePurchaser: PurchaseWorkflowUser = {
      openId: 'ou_buyer',
      name: '综合采购员',
      positions: ['综合管理'],
      buildings: [],
    };

    for (const building of ['A楼', 'A栋', 'A']) {
      const approved = workflowRecord({
        status: '审批通过（待库房确认）',
        building,
        purchaseMethod: '需求自采',
        approvalCompleted: true,
      });

      expect(resolveAllowedActions(approved, supervisor)).toContain('start');
      expect(
        buildStartPatch(approved, supervisor, comprehensivePurchaser),
      ).toMatchObject({ 采购人: [{ id: 'ou_requester' }] });
    }

    const crossBuilding = workflowRecord({
      status: '审批通过（待库房确认）',
      building: 'B楼',
      purchaseMethod: '需求自采',
      approvalCompleted: true,
    });
    expect(resolveAllowedActions(crossBuilding, supervisor)).not.toContain(
      'start',
    );
    expect(() =>
      buildStartPatch(crossBuilding, supervisor, comprehensivePurchaser),
    ).toThrow('无权确认库房并启动采购');
  });

  it('does not let a building supervisor start comprehensive purchasing or bypass it with an override', () => {
    const supervisor: PurchaseWorkflowUser = {
      openId: 'ou_supervisor',
      name: 'A楼主管',
      positions: ['楼栋主管'],
      buildings: ['A楼'],
    };
    const comprehensivePurchaser: PurchaseWorkflowUser = {
      openId: 'ou_buyer',
      name: '综合采购员',
      positions: ['综合管理'],
      buildings: [],
    };
    const comprehensive = workflowRecord({
      status: '审批通过（待库房确认）',
      building: 'A栋',
      purchaseMethod: '综合采购',
      approvalCompleted: true,
    });
    const selfPurchase = {
      ...comprehensive,
      purchaseMethod: '需求自采' as const,
    };

    expect(resolveAllowedActions(comprehensive, supervisor)).not.toContain(
      'start',
    );
    expect(() =>
      buildStartPatch(comprehensive, supervisor, comprehensivePurchaser),
    ).toThrow('无权确认库房并启动采购');
    expect(() =>
      buildStartPatch(
        comprehensive,
        supervisor,
        comprehensivePurchaser,
        '需求自采',
      ),
    ).toThrow('无权确认库房并启动采购');
    expect(() =>
      buildStartPatch(
        selfPurchase,
        supervisor,
        comprehensivePurchaser,
        '综合采购',
      ),
    ).toThrow('无权确认库房并启动采购');
    expect(resolveAllowedActions(comprehensive, manager)).toContain('start');
  });

  it('keeps manager and comprehensive-management start permissions when combined with building supervisor', () => {
    const comprehensive = workflowRecord({
      status: '审批通过（待库房确认）',
      building: 'B楼',
      purchaseMethod: '综合采购',
      approvalCompleted: true,
    });
    const managerSupervisor: PurchaseWorkflowUser = {
      openId: 'ou_manager_supervisor',
      name: '经理兼楼栋主管',
      positions: ['楼栋主管', '设施运维经理'],
      buildings: ['A楼'],
    };
    const comprehensiveSupervisor: PurchaseWorkflowUser = {
      openId: 'ou_comprehensive_supervisor',
      name: '综合管理兼楼栋主管',
      positions: ['楼栋主管', '综合管理'],
      buildings: ['A楼'],
    };

    expect(resolveAllowedActions(comprehensive, managerSupervisor)).toContain(
      'start',
    );
    expect(
      resolveAllowedActions(comprehensive, comprehensiveSupervisor),
    ).toContain('start');
  });

  it('rejects zero-quantity orders and records positive orders', () => {
    const buyer: PurchaseWorkflowUser = {
      openId: 'ou_buyer',
      name: '综合采购员',
      positions: ['综合管理'],
      buildings: [],
    };
    const ordering = workflowRecord({
      status: '库房确认（待下单）',
      purchaseMethod: '综合采购',
      purchaserOpenId: buyer.openId,
      purchaserName: buyer.name,
      approvalCompleted: true,
      warehouseConfirmed: true,
    });

    expect(() =>
      buildOrderPatch(ordering, buyer, {
        actualQuantity: 0,
        actualAmount: 0,
        paymentAttachmentTokens: [],
        note: '供应商无货',
      }),
    ).toThrow('实际采购数量必须大于 0');

    const patch = buildOrderPatch(ordering, buyer, {
      actualQuantity: 8,
      actualAmount: 1600,
      paymentAttachmentTokens: ['file_payment'],
      note: '已下单',
    });
    expect(patch).toMatchObject({
      实际采购数量: 8,
      实际付款金额: 1600,
      采购完成: true,
      采购流程: '下单完成（待签收）',
    });
    expect(patch).not.toHaveProperty('下单时间');
  });

  it('requires self-purchase photo and invoice and writes one receipt attachment field', () => {
    const awaitingReceipt = workflowRecord({
      status: '下单完成（待签收）',
      purchaseMethod: '需求自采',
      purchaserOpenId: requester.openId,
      purchaserName: requester.name,
      purchaseCompleted: true,
    });
    const baseInput = {
      signer: '测试签收人',
      signerOpenId: 'ou_signer',
      receiptTime: 1783699200000,
      receiptPhotoTokens: ['file_receipt'],
      invoiceTokens: ['file_invoice'],
      note: '数量无误',
    };

    const patch = buildReceiptPatch(awaitingReceipt, requester, baseInput);
    expect(patch).toMatchObject({
      签收人: [{ id: 'ou_signer' }],
      签收时间: 1783699200000,
      签收附件: [
        { file_token: 'file_receipt' },
        { file_token: 'file_invoice' },
      ],
      '到货签收确认（签收内容填写完成后点击）': true,
      采购完成: true,
      采购流程: '到货已签收（待入库）',
    });
    expect(patch).not.toHaveProperty('签收照片');
    expect(patch).not.toHaveProperty('发票附件（自采必填项，非自采无需填写）');
    expect(() =>
      buildReceiptPatch(awaitingReceipt, requester, {
        ...baseInput,
        receiptPhotoTokens: [],
      }),
    ).toThrow('请上传签收照片');
    expect(() =>
      buildReceiptPatch(awaitingReceipt, requester, {
        ...baseInput,
        signerOpenId: '',
      }),
    ).toThrow('请选择签收人');
    expect(() =>
      buildReceiptPatch(awaitingReceipt, requester, {
        ...baseInput,
        invoiceTokens: [],
      }),
    ).toThrow('自采签收必须上传发票');

    expect(
      buildReceiptPatch(
        { ...awaitingReceipt, purchaseMethod: '综合采购' },
        requester,
        { ...baseInput, invoiceTokens: [] },
      ),
    ).toMatchObject({
      签收附件: [{ file_token: 'file_receipt' }],
    });
  });
});
