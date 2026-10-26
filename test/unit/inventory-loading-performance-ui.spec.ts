import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const managementSource = readFileSync(
  join(root, 'client/src/pages/InventoryManagement/index.tsx'),
  'utf8',
);
const movementSource = readFileSync(
  join(root, 'client/src/pages/InventoryManagement/InventoryMovementPage.tsx'),
  'utf8',
);
const apiSource = readFileSync(join(root, 'client/src/api/index.ts'), 'utf8');

interface CallSlice {
  text: string;
  start: number;
  end: number;
}

function sliceSource(
  source: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = source.indexOf(startMarker);
  if (start < 0) {
    throw new Error(`Missing source marker: ${startMarker}`);
  }

  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    throw new Error(`Missing source marker: ${endMarker}`);
  }

  return source.slice(start, end);
}

function findClosingParenthesis(source: string, openingIndex: number): number {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && nextCharacter === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '/' && nextCharacter === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function findClosingBrace(source: string, openingIndex: number): number {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    const nextCharacter = source[index + 1];

    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && nextCharacter === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === quote) {
        quote = '';
      }
      continue;
    }
    if (character === '/' && nextCharacter === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === '/' && nextCharacter === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth += 1;
    if (character === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function extractCalls(source: string, callee: string): CallSlice[] {
  const calls: CallSlice[] = [];
  const matcher = new RegExp(`\\b${callee}\\s*\\(`, 'g');
  let match = matcher.exec(source);

  while (match) {
    const openingIndex = source.indexOf('(', match.index);
    const closingIndex = findClosingParenthesis(source, openingIndex);
    if (closingIndex < 0) break;
    calls.push({
      text: source.slice(match.index, closingIndex + 1),
      start: match.index,
      end: closingIndex + 1,
    });
    matcher.lastIndex = closingIndex + 1;
    match = matcher.exec(source);
  }

  return calls;
}

function extractSmallestArrowFunctionContaining(
  source: string,
  needle: string,
): string {
  const candidates: string[] = [];
  const matcher =
    /\bconst\s+[A-Za-z_$][\w$]*\s*=\s*(?:(?:useCallback|useMemo)\s*\(\s*)?(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)(?:\s*:\s*boolean)?\s*=>\s*\{/g;
  let match = matcher.exec(source);

  while (match) {
    const openingIndex = source.indexOf('{', match.index);
    const closingIndex = findClosingBrace(source, openingIndex);
    if (closingIndex < 0) break;
    const candidate = source.slice(match.index, closingIndex + 1);
    if (candidate.includes(needle)) candidates.push(candidate);
    matcher.lastIndex = closingIndex + 1;
    match = matcher.exec(source);
  }

  return candidates.sort((left, right) => left.length - right.length)[0] ?? '';
}

function extractExportedFunction(source: string, functionName: string): string {
  const start = source.indexOf(`export async function ${functionName}(`);
  if (start < 0) return '';
  const nextExport = source.indexOf('\nexport ', start + 1);
  return source.slice(start, nextExport < 0 ? source.length : nextExport);
}

function extractTimeoutMs(functionSource: string): number {
  const rawTimeout = functionSource.match(/\btimeout:\s*([\d_]+)/)?.[1] ?? '';
  return Number(rawTimeout.replaceAll('_', ''));
}

function extractAssignedCall(
  source: string,
  variableName: string,
  callee: string,
): string {
  const assignment = new RegExp(
    `\\bconst\\s+${variableName}\\s*=\\s*${callee}\\s*\\(`,
  ).exec(source);
  if (!assignment) return '';

  const call = extractCalls(source.slice(assignment.index), callee)[0];
  if (!call) return '';
  return source.slice(assignment.index, assignment.index + call.end);
}

function extractDependencies(callSource: string): string {
  return callSource.match(/,\s*\[([^\]]*)\]\s*\)\s*$/)?.[1] ?? '';
}

function countInvocations(source: string, callee: string): number {
  return source.match(new RegExp(`\\b${callee}\\s*\\(`, 'g'))?.length ?? 0;
}

function findSelfClosingElementByAttribute(
  source: string,
  component: string,
  attribute: string,
): string {
  const candidates =
    source.match(new RegExp(`<${component}\\b[\\s\\S]*?\\/>`, 'g')) ?? [];
  return candidates.find((candidate) => candidate.includes(attribute)) ?? '';
}

describe('inventory loading performance UI', () => {
  it('keeps search out of the shared header and wires one ledger search control', () => {
    const page = sliceSource(
      managementSource,
      'export default function InventoryManagementPage()',
      '\nfunction InventoryMetrics(',
    );
    const header = sliceSource(page, '<ManagementHeader', '<main className=');
    const ledger = sliceSource(
      managementSource,
      'function InventoryLedger(',
      '\nfunction InventoryTable(',
    );
    const ledgerCall = page.match(/<InventoryLedger\b[\s\S]*?\/>/)?.[0] ?? '';
    const ledgerSearchControl = findSelfClosingElementByAttribute(
      ledger,
      'Input',
      'aria-label="搜索库存台账"',
    );

    expect(header).toContain('showSearch={false}');
    expect(header).not.toContain('onFilter={handleLocateFilters}');
    expect(page).toMatch(
      /const showHeaderRefresh\s*=\s*needsDashboard\s*\|\|\s*activeSection\s*===\s*['"]ledger['"]\s*;/,
    );
    expect(header).toMatch(
      /updatedAt=\{\s*needsDashboard\s*\?\s*dashboard\s*\?\s*formatUpdatedAt\(dashboard\.generatedAt\)\s*:\s*['"]同步中['"]\s*:\s*['"]按需加载['"]\s*\}/,
    );
    expect(header).toMatch(
      /onRefresh=\{\s*showHeaderRefresh\s*\?\s*\(\)\s*=>\s*void\s+refreshAll\(\)\s*:\s*undefined\s*\}/,
    );
    expect(ledgerCall).toContain('searchValue={searchQuery}');
    expect(ledgerCall).toMatch(
      /onSearchChange=\{\s*\(\s*value\s*\)\s*=>\s*\{\s*setSearchQuery\(\s*value\s*\)\s*;\s*setPage\(\s*1\s*\)\s*;\s*\}\s*\}/,
    );
    expect(ledgerSearchControl).toContain('aria-label="搜索库存台账"');
    expect(ledgerSearchControl).toContain(
      'placeholder="搜索物品、SKU、楼栋、库位或负责人"',
    );
    expect(ledgerSearchControl).toContain('value={props.searchValue}');
    expect(ledgerSearchControl).toMatch(
      /onChange=\{\s*\(event\)\s*=>\s*(?:\{\s*)?props\.onSearchChange\(event\.target\.value\);?\s*(?:\}\s*)?\}/,
    );
  });

  it('guards every dashboard loading path outside overview and stocktake', () => {
    const page = sliceSource(
      managementSource,
      'export default function InventoryManagementPage()',
      '\nfunction InventoryMetrics(',
    );
    const effects = extractCalls(page, 'useEffect').map((call) => call.text);
    const initialDashboardEffects = effects.filter(
      (effect) =>
        countInvocations(effect, 'loadDashboard') > 0 &&
        !effect.includes('setInterval'),
    );
    const dashboardTimerEffects = effects.filter(
      (effect) =>
        effect.includes('setInterval') &&
        countInvocations(effect, 'loadDashboard') > 0,
    );
    const initialDashboardEffect = initialDashboardEffects[0] ?? '';
    const dashboardTimerEffect = dashboardTimerEffects[0] ?? '';
    const refreshAll = extractAssignedCall(page, 'refreshAll', 'useCallback');

    expect(page).toMatch(
      /const needsDashboard\s*=\s*\(?\s*activeSection\s*===\s*['"]overview['"]\s*\|\|\s*activeSection\s*===\s*['"]stocktake['"]\s*\)?\s*;/,
    );

    expect(initialDashboardEffects).toHaveLength(1);
    expect(countInvocations(initialDashboardEffect, 'loadDashboard')).toBe(1);
    expect(initialDashboardEffect).toMatch(
      /if\s*\(\s*needsDashboard\s*\)\s*(?:\{\s*)?void\s+loadDashboard\(\s*\)/,
    );
    expect(page).not.toMatch(
      /useEffect\s*\(\s*\(\s*\)\s*=>\s*\{\s*void\s+loadDashboard\(\)/,
    );

    expect(dashboardTimerEffects).toHaveLength(1);
    expect(countInvocations(dashboardTimerEffect, 'loadDashboard')).toBe(1);
    expect(dashboardTimerEffect).toMatch(
      /setInterval\s*\(\s*\(\s*\)\s*=>\s*\{[\s\S]*?if\s*\(\s*needsDashboard\s*\)\s*(?:\{\s*)?void\s+loadDashboard\(\s*\)/,
    );

    expect(countInvocations(refreshAll, 'loadDashboard')).toBe(1);
    expect(refreshAll).toMatch(
      /if\s*\(\s*needsDashboard\s*\)\s*(?:\{\s*)?await\s+loadDashboard\(\s*true\s*\)/,
    );
  });

  it('keeps automatic movement and pending requests independent', () => {
    const movement = sliceSource(
      movementSource,
      'export function InventoryMovementPage(',
      '\nfunction PendingPurchaseRecords(',
    );
    const loadMovements = extractAssignedCall(
      movement,
      'loadMovements',
      'useCallback',
    );
    const loadPendingPurchases = extractAssignedCall(
      movement,
      'loadPendingPurchases',
      'useCallback',
    );
    const refreshAll = extractAssignedCall(
      movement,
      'refreshAll',
      'useCallback',
    );
    const effects = extractCalls(movement, 'useEffect').map(
      (call) => call.text,
    );
    const movementEffects = effects.filter((effect) =>
      /\bloadMovements\s*\(\s*\)/.test(effect),
    );
    const pendingEffects = effects.filter((effect) =>
      /\bloadPendingPurchases\s*\(\s*\)/.test(effect),
    );
    const movementEffect = movementEffects[0] ?? '';
    const pendingEffect = pendingEffects[0] ?? '';
    const movementFilterDependency =
      /\b(?:page|building|status|searchQuery|deferred[A-Za-z0-9_]*)\b/;

    expect(movement).not.toContain('const load = useCallback');
    expect(movement).not.toMatch(
      /Promise\.all\s*\(\s*\[(?=[^\]]*getInventoryManagementMovements\s*\()(?=[^\]]*getPendingPurchaseInbounds\s*\()[^\]]*\]\s*\)/,
    );

    expect(loadMovements).toContain('getInventoryManagementMovements(');
    expect(loadMovements).toContain('setMovementLoading(');
    expect(loadMovements).not.toContain('getPendingPurchaseInbounds(');
    expect(loadMovements).not.toContain('setPendingLoading(');
    expect(loadPendingPurchases).toContain('getPendingPurchaseInbounds(');
    expect(loadPendingPurchases).toContain('setPendingLoading(');
    expect(loadPendingPurchases).not.toContain(
      'getInventoryManagementMovements(',
    );
    expect(loadPendingPurchases).not.toContain('setMovementLoading(');

    expect(movementEffects).toHaveLength(1);
    expect(countInvocations(movementEffect, 'loadMovements')).toBe(1);
    expect(movementEffect).not.toContain('loadPendingPurchases(');
    expect(pendingEffects).toHaveLength(1);
    expect(countInvocations(pendingEffect, 'loadPendingPurchases')).toBe(1);
    expect(pendingEffect).not.toContain('loadMovements(');
    expect(pendingEffect).toMatch(
      /if\s*\(\s*type\s*===\s*['"]inbound['"]\s*&&\s*!normalizedPurchaseExecutionRecordId\s*\)\s*(?:\{\s*)?void\s+loadPendingPurchases\(\s*\)/,
    );
    expect(extractDependencies(pendingEffect)).toContain(
      'normalizedPurchaseExecutionRecordId',
    );

    expect(extractDependencies(loadPendingPurchases)).not.toMatch(
      movementFilterDependency,
    );
    expect(extractDependencies(pendingEffect)).not.toMatch(
      movementFilterDependency,
    );

    expect(refreshAll).toMatch(/Promise\.allSettled\s*\(/);
    expect(refreshAll).toMatch(/\bloadMovements\s*\(\s*true\s*\)/);
    expect(refreshAll).toMatch(/\bloadPendingPurchases\s*\(\s*true\s*\)/);
    expect(movement).toMatch(
      /\{movementError\s*&&\s*response\.items\.length\s*>\s*0\s*&&/,
    );
    expect(movement).toMatch(
      /movementError\s*&&\s*!response\.items\.length\s*\?/,
    );
    expect(movement).toMatch(
      /movementLoading\s*&&\s*!response\.items\.length\s*\?/,
    );
    expect(movement).toMatch(
      /movementLoading\s*&&\s*response\.items\.length\s*>\s*0\s*&&/,
    );
    expect(movement).toContain('正在更新流转记录');
  });

  it('merges movement and purchase queries without overwriting optimistic inbound state', () => {
    const movement = sliceSource(
      movementSource,
      'export function InventoryMovementPage(',
      '\nfunction PendingPurchaseRecords(',
    );
    const loadMovements = extractAssignedCall(
      movement,
      'loadMovements',
      'useCallback',
    );
    const loadPendingPurchases = extractAssignedCall(
      movement,
      'loadPendingPurchases',
      'useCallback',
    );

    expect(movementSource).toContain("from './inventory-inbound-optimistic'");
    expect(movement).toContain('createInitialInventoryInboundState');
    expect(movement).toContain('selectVisibleMovementResponse(');
    expect(movement).toMatch(/\bbasePendingPurchases\b/);

    expect(loadMovements).toContain('mergeMovementQueryResult(');
    expect(loadMovements).toMatch(
      /mergeMovementQueryResult\s*\([\s\S]*?\brequestId\b/,
    );
    expect(loadMovements).not.toContain('setResponse(');

    expect(loadPendingPurchases).toContain('mergePurchaseQueryResult(');
    expect(loadPendingPurchases).toMatch(
      /mergePurchaseQueryResult\s*\([\s\S]*?\brequestId\b/,
    );
    expect(loadPendingPurchases).not.toContain('setPendingPurchases(');
  });

  it('runs manual and purchase inbound writes through one immediate optimistic lifecycle', () => {
    const movement = sliceSource(
      movementSource,
      'export function InventoryMovementPage(',
      '\nfunction PendingPurchaseRecords(',
    );
    const manualDialog =
      movement.match(/<InventoryMovementCreateDialog\b[\s\S]*?\/>/)?.[0] ?? '';
    const purchaseDialog =
      movement.match(/<PurchaseInboundConfirmationDialog\b[\s\S]*?\/>/)?.[0] ??
      '';
    const manualWriteHandler = extractSmallestArrowFunctionContaining(
      movement,
      'createInventoryMovement(',
    );
    const purchaseWriteHandler = extractSmallestArrowFunctionContaining(
      movement,
      'confirmPurchaseInbound(',
    );

    expect(manualDialog).toContain('onSubmit=');
    expect(manualDialog).toContain('initialDraft=');
    expect(purchaseDialog).toContain('onSubmit=');
    expect(purchaseDialog).toContain('initialDraft=');

    for (const [, handler, writeCall] of [
      ['manual', manualWriteHandler, 'createInventoryMovement('],
      ['purchase', purchaseWriteHandler, 'confirmPurchaseInbound('],
    ] as const) {
      expect(handler).not.toBe('');
      expect(handler.indexOf('beginMutation(')).toBeGreaterThanOrEqual(0);
      expect(handler.indexOf('beginMutation(')).toBeLessThan(
        handler.indexOf(writeCall),
      );
      expect(handler.indexOf('confirmMutation(')).toBeGreaterThan(
        handler.indexOf(writeCall),
      );
      expect(handler.indexOf('failMutation(')).toBeGreaterThan(
        handler.indexOf(writeCall),
      );
      expect(handler).not.toContain('refreshAll(');
    }

    for (const [handler, retrySetter] of [
      [manualWriteHandler, 'setManualRetryDraft(retryDraft)'],
      [purchaseWriteHandler, 'setPurchaseRetryDraft(retryDraft)'],
    ] as const) {
      expect(handler).toContain('...submission.draft');
      expect(handler.indexOf(retrySetter)).toBeGreaterThan(
        handler.indexOf('failMutation('),
      );
    }

    expect(manualWriteHandler.indexOf('setCreateOpen(true)')).toBeGreaterThan(
      manualWriteHandler.indexOf('failMutation('),
    );
    expect(
      purchaseWriteHandler.indexOf('setSelectedPending(retryItem)'),
    ).toBeGreaterThan(purchaseWriteHandler.indexOf('failMutation('));
  });

  it('renders accepted inbound rows as a non-blocking background state', () => {
    const movementStatus = sliceSource(
      movementSource,
      'function MovementStatus(',
      '\nfunction formatNumber(',
    );

    expect(movementStatus).toContain('item.pendingSync');
    expect(movementStatus).toContain('后台同步中，可安全离开');
    expect(movementStatus).not.toContain('animate-spin');
  });

  it('bounds inventory write timeouts so failed optimistic drafts can be retried', () => {
    const manualWrite = extractExportedFunction(
      apiSource,
      'createInventoryMovement',
    );
    const purchaseWrite = extractExportedFunction(
      apiSource,
      'confirmPurchaseInbound',
    );

    for (const [, functionSource] of [
      ['manual', manualWrite],
      ['purchase', purchaseWrite],
    ] as const) {
      const timeoutMs = extractTimeoutMs(functionSource);
      expect(functionSource).not.toBe('');
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(45_000);
    }
  });
});
