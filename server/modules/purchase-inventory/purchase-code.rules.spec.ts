import {
  buildPurchaseOrderCode,
  groupHistoricalPurchaseBatches,
  purchaseBuildingNumber,
} from './purchase-code.rules';

describe('purchase code rules', () => {
  it('maps all supported buildings to their code segment', () => {
    expect(purchaseBuildingNumber('A楼')).toBe('1');
    expect(purchaseBuildingNumber('H楼')).toBe('6');
    expect(purchaseBuildingNumber('110站')).toBe('7');
  });

  it('builds a daily building sequence code', () => {
    expect(buildPurchaseOrderCode('2026-07-21', 'A楼', 1)).toBe(
      'CG260721-101',
    );
  });

  it('groups same applicant and building records inside one ten minute window', () => {
    const batches = groupHistoricalPurchaseBatches([
      {
        id: 'a',
        applicantId: 'ou_1',
        building: 'H楼',
        createdAt: '2026-07-21 08:00:00',
      },
      {
        id: 'b',
        applicantId: 'ou_1',
        building: 'H楼',
        createdAt: '2026-07-21 08:09:59',
      },
      {
        id: 'c',
        applicantId: 'ou_1',
        building: 'H楼',
        createdAt: '2026-07-21 08:10:01',
      },
    ]);

    expect(batches.map((batch) => batch.recordIds)).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });
});
