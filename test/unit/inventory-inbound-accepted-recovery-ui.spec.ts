import * as fs from 'node:fs';
import * as path from 'node:path';

const page = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'client/src/pages/InventoryManagement/InventoryMovementPage.tsx',
  ),
  'utf8',
);
const manualDialog = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'client/src/pages/InventoryManagement/InventoryMovementCreateDialog.tsx',
  ),
  'utf8',
);
const purchaseDialog = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'client/src/pages/InventoryManagement/PurchaseInboundConfirmationDialog.tsx',
  ),
  'utf8',
);

function sourceSection(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

function acceptedBranch(source: string): string {
  const startIndex = source.indexOf("if ('accepted' in response)");
  const endIndex = source.indexOf('} else {', startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('inventory inbound accepted task recovery UI contract', () => {
  it.each([
    [
      'manual',
      'const submitManualInbound = useCallback',
      'const submitPurchaseInbound = useCallback',
      'waitForManualInventoryInboundTask',
    ],
    [
      'purchase',
      'const submitPurchaseInbound = useCallback',
      'const handlePurchaseCategoryPrepared = useCallback',
      'waitForPurchaseInventoryInboundTask',
    ],
  ])(
    'persists the %s HTTP 202 task before polling and does not clear it on acceptance',
    (_kind, sectionStart, sectionEnd, waitFunction) => {
      const submitSection = sourceSection(page, sectionStart, sectionEnd);
      const branch = acceptedBranch(submitSection);

      expect(branch).toContain('acceptInventoryInboundRecovery');
      expect(branch).toContain('taskId: response.taskId');
      expect(branch.indexOf('acceptInventoryInboundRecovery')).toBeLessThan(
        branch.indexOf(waitFunction),
      );
      expect(branch).not.toContain('clearInventoryInboundRecovery');
    },
  );

  it('resumes an accepted task by its stored kind and task id during page initialization', () => {
    expect(page).toContain("recovery.status === 'accepted'");
    expect(page).toContain('recovery.taskId');
    expect(page).toMatch(
      /recovery\.kind === 'manual'[\s\S]{0,1800}queryManualInventoryInboundTask/,
    );
    expect(page).toMatch(
      /queryPurchaseInventoryInboundTask[\s\S]{0,1800}recovery\.purchaseExecutionRecordId/,
    );
    expect(page).toMatch(
      /useEffect\([\s\S]{0,2400}readInventoryInboundRecovery[\s\S]{0,2400}recovery\.status === 'accepted'/,
    );
  });

  it('keeps reconciling a slow accepted task and checks again when the page becomes active', () => {
    expect(page).toContain(
      'createInventoryInboundTaskReconciliationCoordinator',
    );
    expect(page).toContain('queryManualInventoryInboundTask');
    expect(page).toContain('queryPurchaseInventoryInboundTask');
    expect(page).toContain('requestAcceptedInboundRecoveryCheck');
    expect(page).toContain("window.addEventListener('focus'");
    expect(page).toContain("document.addEventListener('visibilitychange'");
    expect(page).toContain('coordinator.checkNow()');
  });

  it('continues to discard a restored mutation id whenever a business field changes', () => {
    for (const [start, end] of [
      ['function updateForm', 'function updateNewItem'],
      ['function updateNewItem', 'function createInboundDraft'],
      ['function changeInboundMode', 'function changeBuilding'],
      ['function changeBuilding', 'function changeItemQuery'],
      ['function changeItemQuery', 'function selectItem'],
      ['function selectItem', 'function validateBorrow'],
    ]) {
      expect(sourceSection(manualDialog, start, end)).toContain(
        'invalidateInboundRetryClientMutationId()',
      );
    }

    for (const [start, end] of [
      ['function updateDraftField', 'function updateNewItem'],
      ['function updateNewItem', 'function changeNewItemPrimaryCategory'],
      ['function changeNewItemPrimaryCategory', 'function changeMode'],
      ['function changeMode', 'function changeBuilding'],
      ['function changeItemQuery', 'function changeStorageLocation'],
      ['function changeStorageLocation', 'function selectItem'],
      ['function selectItem', 'async function prepareCategory'],
    ]) {
      expect(sourceSection(purchaseDialog, start, end)).toContain(
        'clearRetryMutationId',
      );
    }

    expect(
      sourceSection(
        purchaseDialog,
        'function changeBuilding',
        'function changeItemQuery',
      ),
    ).toContain('changePurchaseInboundDraftBuilding');
    expect(
      sourceSection(
        purchaseDialog,
        'export function changePurchaseInboundDraftBuilding',
        'function cloneDraft',
      ),
    ).toContain('clientMutationId: undefined');
  });
});
