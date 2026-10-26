import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PurchasePendingInboundItem } from '../../shared/inventory-management.interface';

jest.mock('lucide-react', () => ({
  Check: () => null,
  ChevronDown: () => null,
  Loader2: () => null,
  MapPinPlus: () => null,
  Plus: () => null,
  Search: () => null,
}));
jest.mock(
  '@/api',
  () => ({
    createWarehouseStorageLocation: jest.fn(),
    getWarehouseStorageLocations: jest.fn(),
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
]) {
  jest.mock(moduleName, () => ({}), { virtual: true });
}

describe('inventory storage location ui', () => {
  const componentPath = join(
    process.cwd(),
    'client/src/pages/InventoryManagement/WarehouseStorageLocationField.tsx',
  );
  const dialogPath = join(
    process.cwd(),
    'client/src/pages/InventoryManagement/PurchaseInboundConfirmationDialog.tsx',
  );
  const apiPath = join(process.cwd(), 'client/src/api/index.ts');

  function loadLocationHelpers(): Record<string, (...args: any[]) => any> {
    return require('../../client/src/pages/InventoryManagement/WarehouseStorageLocationField');
  }

  function loadDialogHelpers(): Record<string, (...args: any[]) => any> {
    return require('../../client/src/pages/InventoryManagement/PurchaseInboundConfirmationDialog');
  }

  function pendingPurchase(
    overrides: Partial<PurchasePendingInboundItem> = {},
  ): PurchasePendingInboundItem {
    return {
      executionRecordId: 'execution-1',
      submissionRecordId: 'submission-1',
      requestCode: 'CG-20260810-001',
      mode: null,
      sku: '',
      itemName: '摄像头',
      specification: 'IPC-01',
      brand: '测试品牌',
      primaryCategory: 'D消耗类',
      secondaryCategory: '办公耗材D2',
      building: 'D楼',
      quantity: 1,
      unit: '个',
      signedAt: '2026-08-10T02:00:00.000Z',
      action: 'needs_selection',
      catalogRecordId: '',
      actionReason: '需要创建物品',
      ...overrides,
    };
  }

  it('wires the searchable selector and add-position panel to bounded APIs', () => {
    const source = readFileSync(componentPath, 'utf8');
    const dialogSource = readFileSync(dialogPath, 'utf8');
    const apiSource = readFileSync(apiPath, 'utf8');

    expect(source).toContain('新增位置');
    expect(source).toContain('getWarehouseStorageLocations');
    expect(source).toContain('createWarehouseStorageLocation');
    expect(source).toContain('searchSequenceRef');
    expect(source).toContain('clientMutationId');
    expect(source).toContain('250');
    expect(source).toContain('同步中');
    expect(dialogSource).toContain('<WarehouseStorageLocationField');
    expect(apiSource).toMatch(
      /getWarehouseStorageLocations[\s\S]*url: '\/api\/inventory-management\/storage-locations'[\s\S]*method: 'GET'[\s\S]*timeout: 30_000/,
    );
    expect(apiSource).toMatch(
      /createWarehouseStorageLocation[\s\S]*url: '\/api\/inventory-management\/storage-locations'[\s\S]*method: 'POST'[\s\S]*timeout: 45_000/,
    );
  });

  it('accepts only the latest storage-location search response', () => {
    const {
      canApplyStorageLocationCreateResponse,
      isLatestStorageLocationSearch,
    } = loadLocationHelpers();

    expect(isLatestStorageLocationSearch(4, 4)).toBe(true);
    expect(isLatestStorageLocationSearch(5, 4)).toBe(false);
    expect(
      canApplyStorageLocationCreateResponse({
        currentCreateSequence: 3,
        responseCreateSequence: 3,
        currentBuilding: 'D楼',
        responseBuilding: 'D楼',
        currentSelectionSequence: 8,
        startedSelectionSequence: 7,
      }),
    ).toBe(false);
    expect(
      canApplyStorageLocationCreateResponse({
        currentCreateSequence: 3,
        responseCreateSequence: 3,
        currentBuilding: 'D楼',
        responseBuilding: 'D楼',
        currentSelectionSequence: 7,
        startedSelectionSequence: 7,
      }),
    ).toBe(true);
  });

  it('freezes conflicting selector and category-generation actions while a location is syncing', () => {
    const source = readFileSync(componentPath, 'utf8');
    const dialogSource = readFileSync(dialogPath, 'utf8');

    expect(source).toContain('onCreatingChange');
    expect(source).toContain('selectionSequenceRef');
    expect(source).toContain('disabled={disabled || creating}');
    expect(dialogSource).toContain('creatingStorageLocation');
    expect(dialogSource).toContain(
      'onCreatingChange={setCreatingStorageLocation}',
    );
    expect(dialogSource).toMatch(
      /disabled=\{\s*categoryTaskActive\s*\|\|\s*creatingStorageLocation\s*\|\|\s*preparedNew\s*\}/,
    );
  });

  it('reuses a mutation id after failure, blocks duplicate submit, and rotates it after edits', () => {
    const {
      changeStorageLocationCreateDraft,
      createStorageLocationCreateDraft,
      failStorageLocationCreate,
      prepareStorageLocationCreate,
      resetStorageLocationCreateDraft,
    } = loadLocationHelpers();
    const initial = changeStorageLocationCreateDraft(
      createStorageLocationCreateDraft(),
      { name: '  D-1F-101  ' },
    );
    const started = prepareStorageLocationCreate({
      building: 'D楼',
      draft: initial,
      creating: false,
      createClientMutationId: () => 'location-mutation-1',
    });

    expect(started.request).toEqual({
      building: 'D楼',
      category: '库内',
      name: 'D-1F-101',
      clientMutationId: 'location-mutation-1',
    });
    expect(
      prepareStorageLocationCreate({
        building: 'D楼',
        draft: started.draft,
        creating: true,
        createClientMutationId: () => 'must-not-run',
      }),
    ).toBeNull();

    const failed = failStorageLocationCreate(started.draft, '网络超时');
    expect(failed).toMatchObject({
      name: '  D-1F-101  ',
      category: '库内',
      clientMutationId: 'location-mutation-1',
      error: '网络超时',
    });
    const retry = prepareStorageLocationCreate({
      building: 'D楼',
      draft: failed,
      creating: false,
      createClientMutationId: () => 'must-not-run',
    });
    expect(retry.request.clientMutationId).toBe('location-mutation-1');

    const edited = changeStorageLocationCreateDraft(failed, {
      name: 'D-1F-102',
    });
    expect(edited.clientMutationId).toBeUndefined();
    expect(edited.error).toBe('');
    expect(resetStorageLocationCreateDraft()).toEqual(
      createStorageLocationCreateDraft(),
    );
  });

  it('clears both selected location fields when the inbound building changes', () => {
    const { changePurchaseInboundDraftBuilding, createPurchaseInboundDraft } =
      loadDialogHelpers();
    const draft = createPurchaseInboundDraft(pendingPurchase());
    draft.clientMutationId = 'retry-id';
    draft.newItem.location = 'D-1F-101';
    draft.newItem.locationRecordId = 'rec-location-1';

    expect(changePurchaseInboundDraftBuilding(draft, 'E楼')).toMatchObject({
      building: 'E楼',
      clientMutationId: undefined,
      itemQuery: '',
      selectedItem: null,
      newItem: {
        location: '',
        locationRecordId: '',
      },
    });
  });

  it('requires a selected record for new preparation but keeps legacy prepared drafts confirmable', () => {
    const {
      buildPurchaseInboundCategoryPrepareRequest,
      buildPurchaseInboundSubmission,
      createPurchaseInboundDraft,
      validatePurchaseInboundCategoryDraft,
      validatePurchaseInboundDraft,
    } = loadDialogHelpers();
    const fresh = createPurchaseInboundDraft(pendingPurchase());
    Object.assign(fresh, {
      mode: 'new',
      quantity: '1',
    });
    Object.assign(fresh.newItem, {
      location: 'D-1F-101',
      locationRecordId: '',
    });

    expect(validatePurchaseInboundCategoryDraft(fresh)).toMatchObject({
      location: '请从库位底表选择存放位置',
    });

    fresh.newItem.locationRecordId = 'rec-location-1';
    expect(
      buildPurchaseInboundCategoryPrepareRequest({
        draft: fresh,
        clientMutationId: 'prepare-1',
      }).newItem,
    ).toMatchObject({
      location: 'D-1F-101',
      locationRecordId: 'rec-location-1',
    });

    const legacyItem = pendingPurchase({
      preparedCategory: {
        catalogRecordId: 'catalog-prepared-1',
        sku: 'D0001',
        preparedAt: '2026-08-10T02:01:00.000Z',
        clientMutationId: 'legacy-prepare-1',
        building: 'D楼',
        quantity: 1,
        occurredAt: '2026-08-10T02:00:00.000Z',
        newItem: {
          primaryCategory: 'D消耗类',
          secondaryCategory: '办公耗材D2',
          name: '摄像头',
          specification: 'IPC-01',
          location: 'D-1F-旧库位',
          brand: '测试品牌',
          unit: '个',
          minimumQuantity: 0,
        },
      },
    });
    const legacyDraft = createPurchaseInboundDraft(legacyItem);

    expect(legacyDraft.newItem.locationRecordId).toBeUndefined();
    expect(validatePurchaseInboundDraft(legacyDraft)).toEqual({});
    expect(
      buildPurchaseInboundSubmission({
        item: legacyItem,
        draft: legacyDraft,
        clientMutationId: 'legacy-prepare-1',
        startedAt: 1,
      }).request.newItem,
    ).not.toHaveProperty('locationRecordId');
  });
});
