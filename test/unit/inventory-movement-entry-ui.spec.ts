import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { InventoryMovementOptionItem } from '../../shared/inventory-management.interface';

jest.mock('@/access/AccessProvider', () => ({ useAccess: jest.fn() }), {
  virtual: true,
});

jest.mock('lucide-react', () => ({
  AlertTriangle: () => null,
  ArrowDownToLine: () => null,
  ArrowUpFromLine: () => null,
  CalendarClock: () => null,
  Check: () => null,
  CheckCircle2: () => null,
  ChevronDown: () => null,
  History: () => null,
  Loader2: () => null,
  MapPin: () => null,
  MapPinPlus: () => null,
  PackageSearch: () => null,
  Search: () => null,
  UserRound: () => null,
}));
jest.mock('sonner', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));
jest.mock(
  '@/api',
  () => ({
    createWarehouseStorageLocation: jest.fn(),
    createInventoryMovement: jest.fn(),
    getInventoryMovementOptions: jest.fn(),
    getWarehouseStorageLocations: jest.fn(),
    searchPurchaseApplicationApplicants: jest.fn(),
  }),
  { virtual: true },
);
for (const moduleName of [
  '@/components/ui/badge',
  '@/components/ui/button',
  '@/components/ui/dialog',
  '@/components/ui/input',
  '@/components/ui/label',
  '@/components/ui/native-select',
  '@/components/ui/popover',
  '@/components/ui/textarea',
]) {
  jest.mock(moduleName, () => ({}), { virtual: true });
}
jest.mock(
  '@/lib/utils',
  () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(' ') }),
  { virtual: true },
);

describe('inventory movement entry UI', () => {
  it('shows the selected existing item current quantity during inbound', () => {
    const source = readFileSync(
      join(
        process.cwd(),
        'client/src/pages/InventoryManagement/InventoryMovementCreateDialog.tsx',
      ),
      'utf8',
    );

    expect(source).toContain("type === 'inbound' ? '当前库存' : '可用库存'");
    expect(source).toContain('selectedItem.availableQuantity');
    expect(source).toContain('selectedItem.unit');
  });

  const root = process.cwd();
  const dialogPath = join(
    root,
    'client/src/pages/InventoryManagement/InventoryMovementCreateDialog.tsx',
  );

  function readDialog(): string {
    return readFileSync(dialogPath, 'utf8');
  }

  function createExistingItem(
    overrides: Partial<InventoryMovementOptionItem> = {},
  ): InventoryMovementOptionItem {
    return {
      catalogRecordId: 'catalog-1',
      inventoryRecordId: 'inventory-1',
      sku: 'NT-001',
      name: '温湿度传感器',
      specification: 'TH-100',
      brand: '测试品牌',
      primaryCategory: '仪器仪表',
      secondaryCategory: '环境监测',
      building: 'A楼',
      location: 'A-01',
      unit: '台',
      availableQuantity: 8,
      ...overrides,
    };
  }

  function loadPureHelpers(): {
    buildInventoryInboundSubmission: (input: {
      draft: Record<string, unknown>;
      clientMutationId: string;
      startedAt: number;
    }) => Record<string, any>;
    validateInventoryInboundDraft: (
      draft: Record<string, unknown>,
    ) => Record<string, string>;
    buildInventoryOutboundSubmission: (input: {
      draft: Record<string, unknown>;
      clientMutationId: string;
      startedAt: number;
    }) => Record<string, any>;
    validateInventoryOutboundDraft: (
      draft: Record<string, unknown>,
    ) => Record<string, string>;
    filterInventoryOutboundOptions: (
      items: InventoryMovementOptionItem[],
      building: string,
    ) => InventoryMovementOptionItem[];
    filterInventoryMovementOptionsForPicker: (
      items: InventoryMovementOptionItem[],
      type: 'inbound' | 'outbound' | 'borrow',
      building: string,
      query: string,
      limit?: number,
    ) => InventoryMovementOptionItem[];
    reconcileInventoryMovementSelection: (
      selectedItem: InventoryMovementOptionItem | null,
      items: InventoryMovementOptionItem[],
    ) => InventoryMovementOptionItem | null;
    handoffSubmissionOnce: <T>(
      guard: { current: boolean },
      createSubmission: () => T,
      handoff: (submission: T) => boolean | void | Promise<boolean | void>,
    ) => Promise<boolean>;
    beginLatestRequest: (sequence: { current: number }) => number;
    invalidateLatestRequest: (sequence: { current: number }) => void;
    isLatestRequest: (
      sequence: { current: number },
      requestSequence: number,
    ) => boolean;
    inventoryOptionErrorAfterLocalSelection: (error: string) => string;
  } {
    return require('../../client/src/pages/InventoryManagement/InventoryMovementCreateDialog');
  }

  it('exposes a primary business action on all three movement pages', () => {
    const page = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );

    expect(page).toContain('办理入库');
    expect(page).toContain('办理出库');
    expect(page).toContain('发起借调');
    expect(page).toContain('<InventoryMovementCreateDialog');
    expect(page).toContain('onCreated');
    expect(page).toContain('loadMovements(true)');
  });

  it('opens the existing inbound dialog from a one-shot header request', () => {
    const managementPage = readFileSync(
      join(root, 'client/src/pages/InventoryManagement/index.tsx'),
      'utf8',
    );
    const movementPage = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );

    expect(managementPage).toContain('新增入库');
    expect(managementPage).toContain("nextSearchParams.set('view', 'inbound')");
    expect(managementPage).toContain(
      "nextSearchParams.set('action', 'create')",
    );
    expect(managementPage).toContain('createRequested=');
    expect(managementPage).toContain('onCreateRequestHandled=');
    expect(movementPage).toContain('createRequested?: boolean;');
    expect(movementPage).toContain('onCreateRequestHandled?: () => void;');
    expect(movementPage).toMatch(/if \(!createRequested \|\| !canCreate\)\s*{\s*return;\s*}/);
    expect(movementPage).not.toContain("type === 'inbound' && inboundSyncing");
    expect(movementPage).toMatch(
      /setCreateOpen\(true\);\s*onCreateRequestHandled\?\.\(\);/,
    );
    expect(movementPage).toContain('<InventoryMovementCreateDialog');
  });

  it('locks a recovered inbound draft to its original mutation id', () => {
    const dialog = readDialog();
    const movementPage = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );

    expect(dialog).toContain('retryLocked?: boolean;');
    expect(dialog).toContain('<fieldset');
    expect(dialog).toContain("disabled={type !== 'borrow' && retryLocked}");
    expect(dialog).toContain('恢复草稿已锁定');
    expect(movementPage).toContain(
      'retryLocked={Boolean(manualRetryDraft?.clientMutationId)}',
    );
    expect(movementPage).toContain('saveInventoryInboundRecovery({');
    expect(movementPage).toContain('if (!recoveryClaimed)');
  });

  it('keeps an invalid movement API response inside the existing error state', () => {
    const movementPage = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );

    expect(movementPage).toMatch(
      /if \(\s*!result\s*\|\|\s*!Array\.isArray\(result\.items\)\s*\|\|\s*!result\.summary\s*\|\|\s*!Array\.isArray\(result\.summary\.statusCounts\)\s*\)/,
    );
    expect(movementPage.indexOf('if (\n          !result')).toBeLessThan(
      movementPage.indexOf('mergeMovementQueryResult(current, result'),
    );
  });

  it('accepts a canonical inbound response when the optional counting unit is empty', () => {
    const movementPage = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );
    const canonicalStart = movementPage.indexOf(
      'function requireCanonicalInboundMovement',
    );
    const canonicalEnd = movementPage.indexOf(
      'function formatNumber',
      canonicalStart,
    );
    const canonicalValidation = movementPage.slice(
      canonicalStart,
      canonicalEnd,
    );

    expect(canonicalStart).toBeGreaterThanOrEqual(0);
    expect(canonicalEnd).toBeGreaterThan(canonicalStart);
    expect(canonicalValidation).toContain('movement.unit');
    expect(canonicalValidation).not.toContain('!String(movement.unit).trim()');
  });

  it('accepts an existing legacy item whose canonical specification is an empty string', () => {
    const movementPage = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );
    const canonicalStart = movementPage.indexOf(
      'function requireCanonicalInboundMovement',
    );
    const canonicalEnd = movementPage.indexOf(
      'function formatNumber',
      canonicalStart,
    );
    const canonicalValidation = movementPage.slice(
      canonicalStart,
      canonicalEnd,
    );

    expect(canonicalValidation).toContain('movement.specification');
    expect(canonicalValidation).not.toContain(
      '!String(movement.specification).trim()',
    );
  });

  it('keeps the draft visible and reports a browser persistence failure before sending', () => {
    const movementPage = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );

    expect(movementPage).toContain('const occupiedRecovery =');
    expect(movementPage).toContain('入库草稿未能安全保存');
    expect(movementPage).toMatch(
      /if \(!recoveryClaimed\)[\s\S]*?return false;[\s\S]*?createInventoryMovement/,
    );
  });

  it('classifies rejected and outcome-unknown inbound failures separately', () => {
    const recoveryModule =
      require('../../client/src/pages/InventoryManagement/inventory-inbound-recovery') as Record<
        string,
        unknown
      >;
    const classify = recoveryModule.classifyInventoryInboundFailure;

    expect(typeof classify).toBe('function');
    if (typeof classify !== 'function') return;
    const classifyFailure = classify as (
      error: unknown,
      responseReceived?: boolean,
    ) => 'rejected' | 'unknown';
    expect(
      classifyFailure({ response: { status: 422 }, code: 'ERR_BAD_REQUEST' }),
    ).toBe('rejected');
    expect(classifyFailure({ code: 'ECONNABORTED' })).toBe('unknown');
    expect(classifyFailure(new Error('canonical mismatch'), true)).toBe(
      'unknown',
    );
    expect(
      classifyFailure(
        {
          response: {
            status: 422,
            data: { definitelyNotWritten: true },
          },
        },
        true,
      ),
    ).toBe('rejected');

    const dialog = readDialog();
    const movementPage = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );
    expect(dialog).toContain('onAbandonRetry?: () => void;');
    expect(dialog).toContain('放弃原编号并编辑');
    expect(movementPage).toContain("retryMode: outcome === 'unknown'");
    expect(movementPage).toContain(
      'onAbandonRetry={abandonManualInboundRetry}',
    );
  });

  it('contains complete business fields, workflow notice, and responsive layout', () => {
    const dialog = readDialog();

    for (const label of [
      '来源楼栋',
      '选择物品',
      '办理数量',
      '物品申请人',
      '经办人',
      '出库原因 / 使用地点',
      '借调原因',
      '预计归还时间',
      '去向楼栋',
      '可用库存',
    ]) {
      expect(dialog).toContain(label);
    }
    expect(dialog).toMatch(
      /type === 'borrow'[\s\S]{0,320}<FieldBlock[\s\S]{0,120}label="去向楼栋"/,
    );
    const outboundSubmit = dialog.slice(
      dialog.indexOf('function submitOutbound'),
      dialog.indexOf('async function submitBorrow'),
    );
    const borrowSubmit = dialog.slice(
      dialog.indexOf('async function submitBorrow'),
      dialog.indexOf(
        '\n\n  return (',
        dialog.indexOf('async function submitBorrow'),
      ),
    );
    expect(outboundSubmit).not.toContain('destinationBuilding');
    expect(borrowSubmit).toContain(
      'destinationBuilding: form.destinationBuilding',
    );
    expect(dialog).toContain("next.destinationBuilding = '请选择去向楼栋'");
    expect(dialog).not.toContain('将触发原“物品确认”工作流');
    expect(dialog).toContain('searchInventoryApplicants');
    expect(dialog).toContain('getInventoryMovementOptions');
    expect(dialog).toContain('createInventoryMovement');
    expect(dialog).toContain('sm:max-w-3xl');
    expect(dialog).toContain('max-sm:h-[100dvh]');
  });

  it('declares the complete inbound draft and renders accessible existing/new fields', () => {
    const dialog = readDialog();

    expect(dialog).toContain('export interface InventoryInboundDraft');
    for (const field of [
      'mode:',
      'building:',
      'quantity:',
      'occurredAt:',
      'itemQuery:',
      'selectedItem:',
      'newItem:',
    ]) {
      expect(dialog).toContain(field);
    }
    for (const label of [
      '已有物品',
      '新增物品',
      '入库楼栋',
      '一级分类',
      '二级分类',
      '物品名称',
      '规格型号',
      '存放位置',
      '物品类别号',
      '系统自动生成',
    ]) {
      expect(dialog).toContain(label);
    }
    expect(dialog).toContain('来源楼栋');
    expect(dialog).not.toContain('value={newItem.sku}');
    expect(dialog).not.toContain('name="sku"');
  });

  it('builds a strict existing inbound request and optimistic movement without mutating the draft', () => {
    const dialog = readDialog();
    expect(dialog).toContain('export function buildInventoryInboundSubmission');
    const { buildInventoryInboundSubmission } = loadPureHelpers();
    const selectedItem = createExistingItem({
      sku: ' NT-001 ',
      name: ' 温湿度传感器 ',
      specification: ' TH-100 ',
      location: ' A-01 ',
      unit: ' 台 ',
    });
    const draft = {
      mode: 'existing',
      building: 'A楼',
      quantity: '2',
      occurredAt: '2026-07-30T09:15',
      itemQuery: ' 传感器 ',
      selectedItem,
      newItem: {
        primaryCategory: ' 保留草稿 ',
        secondaryCategory: '',
        name: '',
        specification: '',
        location: '',
      },
    };
    const snapshot = structuredClone(draft);

    const submission = buildInventoryInboundSubmission({
      draft,
      clientMutationId: 'mutation-existing',
      startedAt: 1234,
    });

    expect(submission.request).toEqual({
      type: 'inbound',
      clientMutationId: 'mutation-existing',
      mode: 'existing',
      catalogRecordId: 'catalog-1',
      sku: 'NT-001',
      building: 'A楼',
      quantity: 2,
      occurredAt: new Date('2026-07-30T09:15').toISOString(),
    });
    expect(submission.optimisticMovement).toEqual({
      recordId: 'pending:mutation-existing',
      clientMutationId: 'mutation-existing',
      pendingSync: true,
      type: 'inbound',
      sku: 'NT-001',
      name: '温湿度传感器',
      specification: 'TH-100',
      quantity: 2,
      unit: '台',
      building: 'A楼',
      destinationBuilding: '',
      location: 'A-01',
      reason: '',
      operator: '',
      applicant: '',
      status: '同步中',
      occurredAt: new Date('2026-07-30T09:15').toISOString(),
      expectedReturnAt: null,
      overdue: false,
    });
    expect(submission.draft).toEqual({
      ...snapshot,
      clientMutationId: 'mutation-existing',
    });
    expect(submission.draft).not.toBe(draft);
    expect(draft).toEqual(snapshot);
    expect(submission.startedAt).toBe(1234);
  });

  it('builds a strict new inbound request without client supplied sku/catalog fields', () => {
    const dialog = readDialog();
    expect(dialog).toContain('export function buildInventoryInboundSubmission');
    const { buildInventoryInboundSubmission } = loadPureHelpers();
    const draft = {
      mode: 'new',
      building: 'B楼',
      quantity: '3',
      occurredAt: '2026-07-30T10:30',
      itemQuery: '保留的已有物品查询',
      selectedItem: createExistingItem(),
      newItem: {
        primaryCategory: ' 劳保用品 ',
        secondaryCategory: ' 防护用品 ',
        name: ' 安全帽 ',
        specification: ' 红色 ',
        location: ' B-02 ',
        locationRecordId: ' rec-location-b-02 ',
      },
    };
    const snapshot = structuredClone(draft);

    const submission = buildInventoryInboundSubmission({
      draft,
      clientMutationId: 'mutation-new',
      startedAt: 5678,
    });

    expect(submission.request).toEqual({
      type: 'inbound',
      clientMutationId: 'mutation-new',
      mode: 'new',
      building: 'B楼',
      quantity: 3,
      occurredAt: new Date('2026-07-30T10:30').toISOString(),
      newItem: {
        primaryCategory: '劳保用品',
        secondaryCategory: '防护用品',
        name: '安全帽',
        specification: '红色',
        location: 'B-02',
        locationRecordId: 'rec-location-b-02',
      },
    });
    expect(submission.request).not.toHaveProperty('sku');
    expect(submission.request).not.toHaveProperty('catalogRecordId');
    expect(submission.optimisticMovement).toMatchObject({
      recordId: 'pending:mutation-new',
      clientMutationId: 'mutation-new',
      pendingSync: true,
      type: 'inbound',
      sku: '系统生成中',
      name: '安全帽',
      specification: '红色',
      quantity: 3,
      unit: '件',
      building: 'B楼',
      location: 'B-02',
      status: '同步中',
    });
    expect(submission.draft).toEqual({
      ...snapshot,
      clientMutationId: 'mutation-new',
    });
    expect(draft).toEqual(snapshot);
  });

  it('builds a strict pending outbound submission without a destination field', () => {
    const { buildInventoryOutboundSubmission } = loadPureHelpers();
    const draft = {
      clientMutationId: 'stale-id',
      building: 'A楼',
      quantity: '2',
      occurredAt: '2026-08-11T09:30',
      itemQuery: ' 传感器 ',
      selectedItem: createExistingItem({
        sku: ' NT-001 ',
        name: ' 温湿度传感器 ',
        specification: ' TH-100 ',
        location: ' A-01 ',
        unit: ' 台 ',
      }),
      applicant: { openId: 'ou_applicant', name: '测试申请人' },
      reason: ' 现场更换 ',
    };
    const snapshot = structuredClone(draft);

    const submission = buildInventoryOutboundSubmission({
      draft,
      clientMutationId: 'outbound-create-1',
      startedAt: 2468,
    });

    expect(submission.request).toEqual({
      type: 'outbound',
      clientMutationId: 'outbound-create-1',
      catalogRecordId: 'catalog-1',
      sku: 'NT-001',
      building: 'A楼',
      quantity: 2,
      occurredAt: new Date('2026-08-11T09:30').toISOString(),
      applicantOpenId: 'ou_applicant',
      reason: '现场更换',
    });
    expect(submission.request).not.toHaveProperty('destinationBuilding');
    expect(submission.optimisticMovement).toMatchObject({
      recordId: 'pending:outbound-create-1',
      clientMutationId: 'outbound-create-1',
      pendingSync: true,
      type: 'outbound',
      sku: 'NT-001',
      quantity: 2,
      building: 'A楼',
      status: '待审批',
      applicant: '测试申请人',
    });
    expect(submission.draft).toEqual({
      ...snapshot,
      clientMutationId: 'outbound-create-1',
    });
    expect(submission.draft).not.toBe(draft);
    expect(draft).toEqual(snapshot);
    expect(submission.startedAt).toBe(2468);
  });

  it('filters outbound options and validates source-building ownership and stock', () => {
    const { filterInventoryOutboundOptions, validateInventoryOutboundDraft } =
      loadPureHelpers();
    const valid = createExistingItem();
    const crossBuilding = createExistingItem({
      catalogRecordId: 'catalog-b',
      building: 'B楼',
    });
    const emptyStock = createExistingItem({
      catalogRecordId: 'catalog-empty',
      availableQuantity: 0,
    });

    expect(
      filterInventoryOutboundOptions([crossBuilding, emptyStock, valid], 'A楼'),
    ).toEqual([emptyStock, valid]);
    const baseDraft = {
      building: 'A楼',
      quantity: '2',
      occurredAt: '2026-08-11T09:30',
      itemQuery: '',
      selectedItem: valid,
      applicant: { openId: 'ou_applicant', name: '测试申请人' },
      reason: '现场更换',
    };
    expect(
      validateInventoryOutboundDraft({
        ...baseDraft,
        selectedItem: crossBuilding,
      }),
    ).toMatchObject({ item: '请选择来源楼栋库存内的物品' });
    expect(
      validateInventoryOutboundDraft({
        ...baseDraft,
        selectedItem: emptyStock,
      }),
    ).toMatchObject({ item: '所选物品当前无可用库存' });
    expect(
      validateInventoryOutboundDraft({
        ...baseDraft,
        selectedItem: {
          ...emptyStock,
          stockConsistencyError:
            '当前楼栋存在重复库存台账，请先合并或清理后再办理库存操作',
        },
      }),
    ).toMatchObject({
      item: '当前楼栋存在重复库存台账，请先合并或清理后再办理库存操作',
    });
    expect(
      validateInventoryOutboundDraft({ ...baseDraft, quantity: '9' }),
    ).toMatchObject({ quantity: '不能超过可用库存 8' });
  });

  it('blocks outbound submission when the selected inventory has no storage location', () => {
    const { validateInventoryOutboundDraft } = loadPureHelpers();
    const draft = {
      building: 'A楼',
      quantity: '2',
      occurredAt: '2026-08-11T09:30',
      itemQuery: '',
      selectedItem: createExistingItem({ location: ' ' }),
      applicant: { openId: 'ou_applicant', name: '测试申请人' },
      reason: '现场更换',
    };

    expect(validateInventoryOutboundDraft(draft)).toMatchObject({
      item: '当前楼栋库存台账缺少存放位置，请先配置库位',
    });
  });

  it('reconciles a selected outbound item with the authoritative stock snapshot', () => {
    const { reconcileInventoryMovementSelection } = loadPureHelpers();
    const staleSelection = createExistingItem({
      catalogRecordId: 'catalog-a2026',
      inventoryRecordId: 'inventory-a2026',
      sku: 'A2026',
      availableQuantity: 36,
    });
    const authoritative = {
      ...staleSelection,
      availableQuantity: 0,
    };

    expect(
      reconcileInventoryMovementSelection(staleSelection, [authoritative]),
    ).toEqual(authoritative);
    expect(reconcileInventoryMovementSelection(staleSelection, [])).toBeNull();
  });

  it('filters a complete local outbound snapshot immediately by sku and building', () => {
    const { filterInventoryMovementOptionsForPicker } = loadPureHelpers();
    const target = createExistingItem({
      catalogRecordId: 'catalog-d1007',
      inventoryRecordId: 'inventory-d1007',
      sku: 'D1007',
      name: '本楼真实物品',
      building: 'C楼',
      availableQuantity: 3,
    });
    const otherBuilding = createExistingItem({
      catalogRecordId: 'catalog-d1007-a',
      inventoryRecordId: 'inventory-d1007-a',
      sku: 'D1007',
      building: 'A楼',
      availableQuantity: 8,
    });

    expect(
      filterInventoryMovementOptionsForPicker(
        [otherBuilding, target],
        'outbound',
        'C楼',
        'd1007',
      ),
    ).toEqual([target]);
  });

  it('uses dependent category selects in both new-item inbound dialogs', () => {
    const manualDialog = readDialog();
    const purchaseDialog = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/PurchaseInboundConfirmationDialog.tsx',
      ),
      'utf8',
    );

    for (const source of [manualDialog, purchaseDialog]) {
      expect(source).toContain('INVENTORY_NEW_ITEM_CATEGORY_OPTIONS');
      expect(source).toContain('getInventorySecondaryCategoryOptions');
      expect(source).toContain('请选择一级分类');
      expect(source).toContain('请选择二级分类');
    }
  });

  it('loads the cached option snapshot without blocking stock on a full Base refresh', () => {
    const dialog = readDialog();

    expect(dialog).toContain('INVENTORY_OPTION_SNAPSHOT_LIMIT = 0');
    expect(dialog).toContain("query: ''");
    expect(dialog).toContain('limit: INVENTORY_OPTION_SNAPSHOT_LIMIT');
    expect(dialog).not.toContain('refresh: true');
    expect(dialog).not.toContain('正在校验最新库存');
    expect(dialog).toContain('filterInventoryMovementOptionsForPicker(');
    expect(dialog).toContain('reconcileInventoryMovementSelection(');
    expect(dialog).toContain('getInventoryOutboundSelectedItemError(');
    expect(dialog).toContain('[form.building, selectedItem, type]');
    expect(dialog).toContain('applySnapshot(');
    const selectItemSource = dialog.slice(
      dialog.indexOf('function selectItem'),
      dialog.indexOf('function validateBorrow'),
    );
    expect(selectItemSource).not.toContain('requestSequence.current += 1');
  });

  it('keeps the stale-inventory warning visible after editing or selecting a cached item', () => {
    const { inventoryOptionErrorAfterLocalSelection } = loadPureHelpers();
    const staleWarning = '库存更新失败，当前展示缓存数据；提交时系统会再次校验';

    expect(inventoryOptionErrorAfterLocalSelection(staleWarning)).toBe(
      staleWarning,
    );
    expect(inventoryOptionErrorAfterLocalSelection('物品数据加载失败')).toBe(
      '',
    );

    const dialog = readDialog();
    for (const [start, end] of [
      ['function changeItemQuery', 'function selectItem'],
      ['function selectItem', 'function validateBorrow'],
    ]) {
      const source = dialog.slice(dialog.indexOf(start), dialog.indexOf(end));
      expect(source).toContain(
        'setItemError(inventoryOptionErrorAfterLocalSelection)',
      );
    }
  });

  it('立即拒绝恢复或粘贴的超长出库原因，不构建提交', () => {
    const { buildInventoryOutboundSubmission, validateInventoryOutboundDraft } =
      loadPureHelpers();
    const overlongReason = '机房'.repeat(1_001);
    const draft = {
      building: 'A楼',
      quantity: '2',
      occurredAt: '2026-08-11T09:30',
      itemQuery: '',
      selectedItem: createExistingItem(),
      applicant: { openId: 'ou_applicant', name: '测试申请人' },
      reason: overlongReason,
    };

    expect(validateInventoryOutboundDraft(draft)).toMatchObject({
      reason: '出库原因或使用地点不能超过 2000 个字符',
    });
    expect(() =>
      buildInventoryOutboundSubmission({
        draft,
        clientMutationId: 'outbound-overlong-reason',
        startedAt: 2468,
      }),
    ).toThrow('出库原因或使用地点不能超过 2000 个字符');
  });

  it('为出库原因声明 2000 字原生上限，并即时校验粘贴与恢复草稿', () => {
    const dialog = readDialog();

    expect(dialog).toMatch(
      /const reasonMaxLength\s*=\s*type === 'outbound'\s*\?\s*INVENTORY_OUTBOUND_REASON_MAX_LENGTH\s*:\s*undefined/,
    );
    expect(dialog).toContain('maxLength={reasonMaxLength}');
    expect(dialog).toContain('onPaste={handleReasonPaste}');
    expect(dialog).toMatch(
      /restoredOutboundDraft[\s\S]*getInventoryOutboundReasonError\(\s*restoredOutboundDraft\.reason,?\s*\)/,
    );
  });

  it('stores the actual mutation id in the restored draft without mutating the caller draft', () => {
    const { buildInventoryInboundSubmission } = loadPureHelpers();
    const draft = {
      clientMutationId: 'stale-mutation',
      mode: 'existing',
      building: 'A楼',
      quantity: '1',
      occurredAt: '2026-07-30T11:30',
      itemQuery: '温湿度传感器',
      selectedItem: createExistingItem(),
      newItem: {
        primaryCategory: '',
        secondaryCategory: '',
        name: '',
        specification: '',
        location: '',
      },
    };
    const snapshot = structuredClone(draft);

    const submission = buildInventoryInboundSubmission({
      draft,
      clientMutationId: 'actual-mutation',
      startedAt: 9012,
    });

    expect(submission.draft.clientMutationId).toBe('actual-mutation');
    expect(draft).toEqual(snapshot);
  });

  it('validates existing inbound inventory ownership and configured location', () => {
    const dialog = readDialog();
    expect(dialog).toContain('export function validateInventoryInboundDraft');
    const { validateInventoryInboundDraft } = loadPureHelpers();
    const baseDraft = {
      mode: 'existing',
      building: 'A楼',
      quantity: '1',
      occurredAt: '2026-07-30T10:30',
      itemQuery: '',
      selectedItem: createExistingItem(),
      newItem: {
        primaryCategory: '',
        secondaryCategory: '',
        name: '',
        specification: '',
        location: '',
      },
    };

    expect(
      validateInventoryInboundDraft({
        ...baseDraft,
        selectedItem: null,
        quantity: '1.5',
        occurredAt: 'not-a-date',
      }),
    ).toMatchObject({
      item: '请选择已有物品',
      quantity: '数量必须为正整数',
      occurredAt: '请选择有效的办理时间',
    });
    expect(
      validateInventoryInboundDraft({
        ...baseDraft,
        selectedItem: createExistingItem({ building: 'B楼' }),
      }),
    ).toMatchObject({ item: '请选择当前入库楼栋的物品' });
    expect(
      validateInventoryInboundDraft({
        ...baseDraft,
        selectedItem: createExistingItem({
          inventoryRecordId: '',
          location: '',
        }),
      }),
    ).toMatchObject({
      item: '所选物品未配置库存库位，请先配置库位',
    });
  });

  it('validates every required new-item field', () => {
    const dialog = readDialog();
    expect(dialog).toContain('export function validateInventoryInboundDraft');
    const { validateInventoryInboundDraft } = loadPureHelpers();

    expect(
      validateInventoryInboundDraft({
        mode: 'new',
        building: 'A楼',
        quantity: '0',
        occurredAt: '',
        itemQuery: '',
        selectedItem: null,
        newItem: {
          primaryCategory: ' ',
          secondaryCategory: '',
          name: '',
          specification: '',
          location: '',
        },
      }),
    ).toEqual({
      quantity: '数量必须为正整数',
      occurredAt: '请选择有效的办理时间',
      primaryCategory: '请填写一级分类',
      secondaryCategory: '请填写二级分类',
      name: '请填写物品名称',
      specification: '请填写规格型号',
      location: '请填写存放位置',
    });

    expect(
      validateInventoryInboundDraft({
        mode: 'new',
        building: 'A楼',
        quantity: '1',
        occurredAt: '2026-08-21T10:00',
        itemQuery: '',
        selectedItem: null,
        newItem: {
          primaryCategory: 'A备品备件类',
          secondaryCategory: '应急件A1',
          name: '新物品',
          specification: 'TEST-1',
          location: 'A-1F-001',
          locationRecordId: '',
        },
      }),
    ).toMatchObject({
      location: '请从库位底表选择存放位置',
    });
  });

  it('reuses the shared storage-location selector for a new inbound item', () => {
    const dialog = readDialog();

    expect(dialog).toContain(
      "import { WarehouseStorageLocationField } from './WarehouseStorageLocationField';",
    );
    expect(dialog).toMatch(
      /<WarehouseStorageLocationField[\s\S]*building=\{form\.building\}[\s\S]*value=\{newItem\.location\}[\s\S]*recordId=\{newItem\.locationRecordId\}[\s\S]*onChange=\{changeStorageLocation\}/,
    );
    expect(dialog).toMatch(
      /function changeBuilding[\s\S]*setNewItem\([\s\S]*location: ''[\s\S]*locationRecordId: ''/,
    );
    expect(dialog).not.toContain('placeholder="请输入存放位置"');
  });

  it('keeps inbound submission synchronous and isolated from the legacy API path', () => {
    const dialog = readDialog();
    const inboundStart = dialog.indexOf('function submitInbound');
    const outboundStart = dialog.indexOf(
      'async function submitOutbound',
      inboundStart,
    );
    const inboundSubmit = dialog.slice(inboundStart, outboundStart);

    expect(inboundStart).toBeGreaterThanOrEqual(0);
    expect(outboundStart).toBeGreaterThan(inboundStart);
    expect(inboundSubmit).toContain('onSubmit');
    expect(inboundSubmit).toContain('onOpenChange(false)');
    expect(inboundSubmit).toContain('inboundSubmitGuard.current');
    expect(inboundSubmit).not.toContain('await ');
    expect(inboundSubmit).not.toContain('createInventoryMovement');
    expect(inboundSubmit).not.toContain('onCreated');
    expect(inboundSubmit).not.toContain('setSubmitting');
  });

  it('awaits outbound durable handoff and guards duplicate clicks for the whole promise', () => {
    const dialog = readDialog();
    const outboundStart = dialog.indexOf('async function submitOutbound');
    const borrowStart = dialog.indexOf(
      'async function submitBorrow',
      outboundStart,
    );
    const outboundSubmit = dialog.slice(outboundStart, borrowStart);

    expect(outboundStart).toBeGreaterThanOrEqual(0);
    expect(borrowStart).toBeGreaterThan(outboundStart);
    expect(outboundSubmit).toContain('outboundSubmitGuard.current');
    expect(outboundSubmit).toContain('onOutboundSubmit');
    expect(outboundSubmit).toContain('onOpenChange(false)');
    expect(outboundSubmit).toContain('await handoffSubmissionOnce');
    expect(outboundSubmit).toContain(
      '出库任务未发送，请根据页面提示处理后重试。',
    );
    expect(outboundSubmit).not.toContain('createInventoryMovement');
    expect(outboundSubmit).not.toContain('setSubmitting');
    expect(outboundSubmit).not.toContain('onCreated');
    expect(outboundSubmit).toMatch(
      /async function submitOutbound\(\)[\s\S]*if \(outboundSubmitGuard\.current\) return;[\s\S]*await handoffSubmissionOnce\([\s\S]*outboundSubmitGuard[\s\S]*onOutboundSubmit/,
    );
  });

  it('hands an accepted async submission off only once when the user double-clicks', async () => {
    const { handoffSubmissionOnce } = loadPureHelpers();
    const guard = { current: false };
    const handedOff: string[] = [];
    let built = 0;
    let finishHandoff!: (accepted: boolean) => void;
    const handoffResult = new Promise<boolean>((resolve) => {
      finishHandoff = resolve;
    });

    const submit = () =>
      handoffSubmissionOnce(
        guard,
        () => `submission-${++built}`,
        (submission) => {
          handedOff.push(submission);
          return handoffResult;
        },
      );

    const first = submit();
    await expect(submit()).resolves.toBe(false);
    expect(built).toBe(1);
    expect(handedOff).toEqual(['submission-1']);
    finishHandoff(true);
    await expect(first).resolves.toBe(true);
  });

  it('does not let an A-building response overwrite a newer B-building request', () => {
    const { beginLatestRequest, isLatestRequest } = loadPureHelpers();
    const sequence = { current: 0 };
    const acceptedItems: string[] = [];

    const aRequest = beginLatestRequest(sequence);
    const bRequest = beginLatestRequest(sequence);
    if (isLatestRequest(sequence, aRequest)) acceptedItems.push('A楼物品');
    if (isLatestRequest(sequence, bRequest)) acceptedItems.push('B楼物品');

    expect(acceptedItems).toEqual(['B楼物品']);
  });

  it('restores and locks an outbound retry while invalidating stale option responses', () => {
    const dialog = readDialog();
    const changeBuildingStart = dialog.indexOf('function changeBuilding');
    const changeQueryStart = dialog.indexOf(
      'function changeItemQuery',
      changeBuildingStart,
    );
    const changeBuilding = dialog.slice(changeBuildingStart, changeQueryStart);

    expect(dialog).toContain('initialOutboundDraft?: InventoryOutboundDraft;');
    expect(dialog).toMatch(
      /onOutboundSubmit\?: \(\s*submission: InventoryOutboundSubmission,?\s*\) => Promise<boolean> \| boolean \| void/,
    );
    expect(dialog).toMatch(
      /const restoredOutboundDraft =\s*type === 'outbound' \? initialOutboundDraft : undefined/,
    );
    expect(dialog).toContain('restoredOutboundDraft.clientMutationId');
    expect(dialog).toContain('restoredOutboundDraft?.selectedItem');
    expect(dialog).toContain('restoredOutboundDraft?.applicant');
    expect(changeBuilding).toContain('requestSequence.current += 1');
    expect(changeBuilding).toContain("setItemQuery('')");
    expect(changeBuilding).toContain('setSelectedItem(null)');
    expect(changeBuilding).toContain('setItems([])');
    expect(dialog).toContain('isLatestRequest(requestSequence, sequence)');
    expect(dialog).toContain('filterInventoryOutboundOptions(result');
  });

  it('restores inbound drafts and invalidates stale/mode-inapplicable searches', () => {
    const dialog = readDialog();
    const changeBuildingStart = dialog.indexOf('function changeBuilding');
    const selectItemStart = dialog.indexOf(
      'function selectItem',
      changeBuildingStart,
    );
    const changeBuilding = dialog.slice(changeBuildingStart, selectItemStart);

    expect(dialog).toContain('initialDraft?: InventoryInboundDraft');
    expect(dialog).toContain(
      'onSubmit?: (submission: InventoryInboundSubmission) => boolean | void',
    );
    expect(dialog).toContain(
      "const restoredDraft = type === 'inbound' ? initialDraft : undefined",
    );
    expect(dialog).toContain('restoredDraft?.mode');
    expect(dialog).toContain('restoredDraft?.itemQuery');
    expect(dialog).toContain('restoredDraft?.selectedItem');
    expect(dialog).toContain('restoredDraft?.newItem');
    expect(changeBuilding).toContain('requestSequence.current');
    expect(changeBuilding).toContain('setItemQuery');
    expect(changeBuilding).toContain('setSelectedItem(null)');
    expect(changeBuilding).toContain('setItems([])');
    expect(changeBuilding).toContain('setItemError');
    expect(dialog).toMatch(
      /inboundMode === 'new'[\s\S]{0,240}requestSequence\.current/,
    );
    expect(dialog).toContain('window.setTimeout');
    expect(dialog).toContain('}, 250)');
    expect(dialog).toContain('inboundSubmitGuard.current = false');
  });

  it('reuses an unchanged restored mutation id and clears it after every inbound business edit', () => {
    const dialog = readDialog();
    const section = (start: string, end: string) => {
      const startIndex = dialog.indexOf(start);
      const endIndex = dialog.indexOf(end, startIndex);
      expect(startIndex).toBeGreaterThanOrEqual(0);
      expect(endIndex).toBeGreaterThan(startIndex);
      return dialog.slice(startIndex, endIndex);
    };

    expect(dialog).toContain('clientMutationId?: string;');
    expect(dialog).toContain(
      'const [retryClientMutationId, setRetryClientMutationId]',
    );
    expect(dialog).toContain(
      'setRetryClientMutationId(restoredDraft?.clientMutationId)',
    );
    expect(dialog).toContain(
      'retryClientMutationId?.trim() || createClientMutationId()',
    );

    for (const [start, end] of [
      ['function updateForm', 'function updateNewItem'],
      ['function updateNewItem', 'function createInboundDraft'],
      ['function changeInboundMode', 'function changeBuilding'],
      ['function changeBuilding', 'function changeItemQuery'],
      ['function changeItemQuery', 'function selectItem'],
      ['function selectItem', 'function validateBorrow'],
    ]) {
      expect(section(start, end)).toContain(
        'invalidateInboundRetryClientMutationId()',
      );
    }
  });

  it('invalidates employee searches immediately and guards async cleanup by token', () => {
    const dialog = readDialog();
    const employeePickerStart = dialog.indexOf('function EmployeePicker');
    const fieldBlockStart = dialog.indexOf(
      'function FieldBlock',
      employeePickerStart,
    );
    const employeePicker = dialog.slice(employeePickerStart, fieldBlockStart);

    expect(employeePickerStart).toBeGreaterThanOrEqual(0);
    expect(fieldBlockStart).toBeGreaterThan(employeePickerStart);
    expect(employeePicker).toMatch(
      /const invalidateEmployeeSearch = useCallback\(\(\) => \{\s*sequence\.current \+= 1;\s*setResults\(\[\]\);\s*setLoading\(false\);\s*\}, \[\]\);/,
    );
    expect(employeePicker).toMatch(
      /useEffect\(\(\) => \{\s*invalidateEmployeeSearch\(\);\s*if \(value\) setQuery\(value\.name\);\s*\}, \[invalidateEmployeeSearch, value\]\);/,
    );
    expect(employeePicker).toMatch(
      /if \(value \|\| !query\.trim\(\)\) \{\s*invalidateEmployeeSearch\(\);\s*return;/,
    );
    expect(employeePicker).toMatch(
      /return \(\) => \{\s*window\.clearTimeout\(timer\);\s*if \(sequence\.current === current\) \{\s*invalidateEmployeeSearch\(\);\s*}\s*};/,
    );
    expect(employeePicker).toMatch(
      /onChange=\{\(event\) => \{\s*invalidateEmployeeSearch\(\);\s*setQuery\(event\.target\.value\);\s*onChange\(null\);/,
    );
    expect(employeePicker).toMatch(
      /onClick=\{\(\) => \{\s*invalidateEmployeeSearch\(\);\s*onChange\(person\);\s*setQuery\(person\.name\);/,
    );
    expect(
      employeePicker.match(/sequence\.current === current/g) ?? [],
    ).toHaveLength(7);
    expect(employeePicker).toContain('}, 250)');
  });

  it('uses optimistic-sync notices for inbound and outbound without changing borrow copy', () => {
    const dialog = readDialog();

    expect(dialog).toContain('立即显示同步中，后台确认后完成；失败恢复草稿');
    expect(dialog).toContain(
      '提交后立即显示待审批并后台同步；结果不确定时保留原编号安全重试。',
    );
    expect(dialog).toContain(
      '提交时系统会重新读取库存并校验数量，成功后写入原多维表并刷新当前列表。',
    );
  });

  it('renders optimistic movement deletion actions and explains every reverse business effect', () => {
    const page = readFileSync(
      join(
        root,
        'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
      ),
      'utf8',
    );

    expect(page).toContain('删除出入库记录');
    expect(page).toContain('删除后库存将减少');
    expect(page).toContain('采购将回到待库房入库');
    expect(page).toContain('删除后库存将恢复');
    expect(page).toContain('只取消本次申请，不影响库存');
    expect(page).toContain('记录已从当前清单隐藏，正在后台同步删除');
    expect(page.match(/onDeleteAction/g)?.length ?? 0).toBeGreaterThanOrEqual(
      4,
    );
    expect(page).toContain('createInventoryMovementDeletionCoordinator');
    expect(page).toContain('selectInventoryMovementsAfterDeletion');
  });
});
