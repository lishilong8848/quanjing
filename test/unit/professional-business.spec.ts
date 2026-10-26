import { Reflector } from '@nestjs/core';
import { ForbiddenException } from '@nestjs/common';
import { UnifiedAccessGuard } from '../../server/common/access/unified-access.guard';
import { AdminOnly, GuestReadable, ProfessionalScoped } from '../../server/common/access/unified-access.decorators';
import { InventoryStocktakeService } from '../../server/modules/inventory-management/inventory-stocktake.service';
import { InventoryStocktakeStore } from '../../server/modules/inventory-management/inventory-stocktake.store';
import { stocktakeFingerprint, stocktakeMonth } from '../../server/modules/inventory-management/inventory-stocktake.rules';
import { InventoryStocktakeSource } from '../../server/modules/inventory-management/inventory-stocktake.source';
import { InventoryMovementCommandService } from '../../server/modules/inventory-management/inventory-movement-command.service';
import { RiskInspectionService } from '../../server/modules/risk-inspection/risk-inspection.service';
import { DutyScheduleService } from '../../server/modules/duty-schedule/duty-schedule.service';
import { canAccessPage } from '../../client/src/access/access-policy';
import { isConstructionManualReviewAutoApprovalRole } from '../../shared/construction-manual-review-policy';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const actor = { role: 'professional_admin' as const, purchaseBuilding: null, accountId: 'professional-test', specialties: ['暖通'] as const };

describe('professional server boundary', () => {
  class Probe { read() {} write() {} admin() {} }
  GuestReadable()(Probe.prototype, 'read', Object.getOwnPropertyDescriptor(Probe.prototype, 'read'));
  ProfessionalScoped()(Probe.prototype, 'write', Object.getOwnPropertyDescriptor(Probe.prototype, 'write'));
  AdminOnly()(Probe.prototype, 'admin', Object.getOwnPropertyDescriptor(Probe.prototype, 'admin'));
  const allow = (url: string, method: string, handler: Function, principal = actor) => {
    const guard = new UnifiedAccessGuard(new Reflector(), { cookieName: 'test', isAccessControlEnabled: () => true, renew: () => ({ principal, principalFingerprint: 'synthetic' }) } as never);
    const req = { method, originalUrl: url, url, query: {}, headers: {}, protocol: 'http' };
    const res = { cookie: jest.fn() };
    return guard.canActivate({ getClass: () => Probe, getHandler: () => handler, switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as never);
  };
  it('knowledge allowed; configuration and unscoped writes denied', () => {
    expect(allow('/api/meeting-management/settings', 'POST', Probe.prototype.admin)).toBe(true);
    expect(allow('/api/access/configuration/accounts', 'POST', Probe.prototype.write)).toBe(false);
    expect(allow('/api/unknown', 'POST', Probe.prototype.read)).toBe(false);
    expect(allow('/api/equipment-ledger/items', 'GET', Probe.prototype.write)).toBe(true);
    expect(allow('/api/attendance/correction-evidence', 'GET', Probe.prototype.admin)).toBe(false);
    expect(allow('/api/attendance/history', 'GET', Probe.prototype.read)).toBe(true);
  });
  it('personnel construction remains at the guest baseline for professional supervisors', () => {
    expect(canAccessPage('professional_admin', '/construction-management')).toBe(false);
    expect(allow('/api/duty-schedules/construction-management', 'GET', Probe.prototype.write)).toBe(false);
    expect(allow('/api/sync-task/construction-00000000-0000-4000-8000-000000000000', 'GET', Probe.prototype.read)).toBe(false);
    expect(isConstructionManualReviewAutoApprovalRole('professional_admin')).toBe(false);
  });
  it('construction checks authoritative specialty and linked project', async () => {
    const service = Object.create(DutyScheduleService.prototype);
    service.constructionOverviewConfig = { appToken: 'test', tableId: 'overview', tableName: 'overview' };
    service.constructionFollowupConfig = { appToken: 'test', tableId: 'followup', tableName: 'followup' };
    service.httpService = {};
    service.getFeishuTenantAccessToken = jest.fn().mockResolvedValue('synthetic');
    service.fetchBitableRecordById = jest.fn().mockResolvedValue({ record_id: 'recOwn', fields: { 专业: '暖通' } });
    await service.authorizeProfessionalConstruction(actor, 'recOwn');
    service.fetchBitableRecordById.mockResolvedValue({ record_id: 'recOwn', fields: { 专业: '电气' } });
    await expect(service.authorizeProfessionalConstruction(actor, 'recOwn')).rejects.toBeInstanceOf(ForbiddenException);
    service.fetchBitableRecordById.mockResolvedValue({ record_id: 'recChild', fields: {} });
    await expect(service.authorizeProfessionalConstruction(actor, 'recChild', 'followup')).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('new catalog persists typed specialty and rejects missing schema before creating records', async () => {
    const command = Object.create(InventoryMovementCommandService.prototype);
    command.gateway = { getFieldSchemas: jest.fn().mockResolvedValue([{ fieldName: '专业', type: 4, writable: true }]) };
    const config = { appToken: 'test', catalogTableId: 'catalog' };
    expect(await command.professionalCatalogFields(config, { specialty: '暖通' })).toEqual({ 专业: ['暖通'] });
    command.gateway.getFieldSchemas.mockResolvedValue([]);
    await expect(command.professionalCatalogFields(config, { specialty: '暖通' })).rejects.toThrow('专业字段未配置');
  });
  it('quality follow-up refuses changed specialty before persisting acceptance', async () => {
    const service = Object.create(RiskInspectionService.prototype);
    service.qualityTaskStore = { create: jest.fn() };
    service.fetchRecords = jest.fn().mockResolvedValue([{ record_id: 'recIssue', fields: { 问题归属: '电气' } }]);
    service.lastGoodAliMonthlyQualityIssueRecords = [{ record_id: 'recIssue', fields: { 问题归属: '暖通' } }];
    await expect(service.acceptAliMonthlyQualitySupplemental('recIssue', { supplemental: 'Test', expectedSupplemental: '', clientMutationId: 'professional-quality-test' }, actor)).rejects.toBeInstanceOf(ForbiddenException);
    expect(service.qualityTaskStore.create).not.toHaveBeenCalled();
  });
  it('stocktake rechecks changed catalog specialty', async () => {
    const source = Object.create(InventoryStocktakeSource.prototype);
    const previous = { recordId: 'inventory', sku: 'SKU', building: 'A楼', specialty: '暖通' };
    source.snapshot = jest.fn().mockResolvedValue({ items: [{ ...previous, specialty: '电气' }], movements: [] });
    await expect(source.current(previous, actor)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('professional stocktake', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'nt-professional-stocktake-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  const setup = () => {
    const items = ['暖通', '电气', undefined].map((specialty, index) => ({ recordId: `item-${index}`, sku: `SKU${index}`, building: 'A楼', name: `item${index}`, specialty, quantity: 2, unit: '个' }));
    const store = new InventoryStocktakeStore(join(root, 'ledger.json'));
    const month = stocktakeMonth(), now = new Date().toISOString();
    store.update(state => { state.sheets.push({ month, building: 'A楼', status: 'open', version: 1, createdAt: now, completedAt: null, lines: items.map(inventory => ({ inventory, reasons: [], movementIds: [], stockFingerprint: stocktakeFingerprint(inventory as never), version: 1, status: 'draft', updatedAt: now, confirmedAt: null, operatorFingerprint: null, actualQuantity: null, confirmer: null, note: '' })) } as never); return true; });
    const source = { current: jest.fn(async item => item), currentMany: jest.fn(async items => items) };
    const service = new InventoryStocktakeService(store, source as never, { resolveApplicantForBuilding: jest.fn(async p => p) } as never);
    return { service, source, store, month, items };
  };
  it('filtered list and totals preserve raw ledger', () => {
    const { service, store, month } = setup();
    expect(service.get(month, 'A楼', actor)?.lines.map(l => l.inventory.recordId)).toEqual(['item-0']);
    expect(service.overview(month, actor).buildings.find(b => b.building === 'A楼')?.total).toBe(1);
    expect(store.read().sheets[0].lines).toHaveLength(3);
  });
  it('cross specialty draft denied without mutation', async () => {
    const { service, store, month } = setup();
    await expect(service.writeLine({ month, building: 'A楼', clientMutationId: 'professional-draft', recordId: 'item-1', expectedVersion: 1, actualQuantity: 2, confirmer: null, note: '' }, actor, 'session', 'draft')).rejects.toBeInstanceOf(ForbiddenException);
    expect(store.read().sheets[0].version).toBe(1);
  });
  it('own completion leaves other specialties open', async () => {
    const { service, store, month } = setup();
    store.update(state => { state.sheets[0].lines[0].status = 'confirmed'; return true; });
    expect(await service.complete({ month, building: 'A楼', clientMutationId: 'professional-complete', expectedVersion: 1 }, actor, 'session')).toMatchObject({ status: 'completed' });
    expect(store.read().sheets[0].status).toBe('open');
  });
});
