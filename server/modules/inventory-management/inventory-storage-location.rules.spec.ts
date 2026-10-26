import { BadRequestException } from '@nestjs/common';
import type {
  WarehouseStorageLocation,
  WarehouseStorageLocationCreateRequest,
} from '../../../shared/inventory-management.interface';
import type { BitableRecordItem } from '../../common/feishu/bitable-direct-read';
import {
  filterStorageLocations,
  normalizeStorageLocationName,
  parseStorageLocationRecord,
  storageLocationKey,
  validateStorageLocationCreateRequest,
} from './inventory-storage-location.rules';

const VALID_CREATE_REQUEST: WarehouseStorageLocationCreateRequest = {
  building: 'H楼',
  category: '库内',
  name: 'H-1F-101',
  clientMutationId: 'location-create-1',
};

function bitableRecord(
  recordId: string,
  fields: Record<string, unknown>,
): BitableRecordItem {
  return { record_id: recordId, fields };
}

function storageLocation(
  recordId: string,
  building: WarehouseStorageLocation['building'],
  name: string,
  category: WarehouseStorageLocation['category'] = '库内',
): WarehouseStorageLocation {
  return {
    recordId,
    building,
    company: '南通承宏',
    category,
    name,
  };
}

describe('inventory storage location rules', () => {
  it('trims and folds consecutive whitespace in location names', () => {
    expect(normalizeStorageLocationName('  H-1F   101\t东区\n')).toBe(
      'H-1F 101 东区',
    );
  });

  it('returns an empty name for non-string input', () => {
    expect(
      normalizeStorageLocationName({ malicious: true } as unknown as string),
    ).toBe('');
  });

  it('maps a valid Feishu Bitable record to a normalized location', () => {
    expect(
      parseStorageLocationRecord(
        bitableRecord('rec_1', {
          楼栋: 'H楼',
          所属公司: ' 南通承宏 ',
          存放位置分类: '库内',
          存放位置: '  H-1F   101  ',
        }),
      ),
    ).toEqual({
      recordId: 'rec_1',
      building: 'H楼',
      company: '南通承宏',
      category: '库内',
      name: 'H-1F 101',
    });
  });

  it('maps Feishu single-select objects and text arrays', () => {
    expect(
      parseStorageLocationRecord(
        bitableRecord('rec_wrapped', {
          楼栋: { select: { name: 'H楼' } },
          所属公司: [{ type: 'text', text: '南通承宏' }],
          存放位置分类: { select: [{ name: '库内' }] },
          存放位置: [{ type: 'text', text: 'H-1F-201' }],
        }),
      ),
    ).toEqual({
      recordId: 'rec_wrapped',
      building: 'H楼',
      company: '南通承宏',
      category: '库内',
      name: 'H-1F-201',
    });
  });

  it('returns null instead of throwing for malformed nested fields', () => {
    expect(
      parseStorageLocationRecord(
        bitableRecord('rec_malformed', {
          楼栋: { select: [{ text: { unexpected: true } }] },
          所属公司: [{ nested: { value: null } }],
          存放位置分类: { select: { unknown: '库内' } },
          存放位置: [{ text: { nested: ['H-1F-201'] } }],
        }),
      ),
    ).toBeNull();
  });

  it.each([
    ['unknown fields', bitableRecord('rec_unknown', { 未知字段: 'H-1F-101' })],
    [
      'missing record id',
      {
        fields: {
          楼栋: 'H楼',
          所属公司: '南通承宏',
          存放位置分类: '库内',
          存放位置: 'H-1F-101',
        },
      },
    ],
    [
      'unknown building',
      bitableRecord('rec_building', {
        楼栋: 'Z楼',
        所属公司: '南通承宏',
        存放位置分类: '库内',
        存放位置: 'Z-1F-101',
      }),
    ],
    [
      'unknown category',
      bitableRecord('rec_category', {
        楼栋: 'H楼',
        所属公司: '南通承宏',
        存放位置分类: '室内',
        存放位置: 'H-1F-101',
      }),
    ],
    [
      'empty company',
      bitableRecord('rec_company', {
        楼栋: 'H楼',
        所属公司: ' ',
        存放位置分类: '库内',
        存放位置: 'H-1F-101',
      }),
    ],
    [
      'empty name',
      bitableRecord('rec_name', {
        楼栋: 'H楼',
        所属公司: '南通承宏',
        存放位置分类: '库内',
        存放位置: '  ',
      }),
    ],
  ])('returns null for an invalid record: %s', (_label, record) => {
    expect(parseStorageLocationRecord(record as BitableRecordItem)).toBeNull();
  });

  it('filters by building and query without regard to letter case', () => {
    const result = filterStorageLocations(
      [
        storageLocation('rec_b', 'H楼', 'H-ZONE-B'),
        storageLocation('rec_a', 'H楼', 'h-zone-A'),
        storageLocation('rec_other', 'A楼', 'H-ZONE-C'),
        storageLocation('rec_no_match', 'H楼', 'H-RACK-D'),
      ],
      { building: 'H楼', query: 'h-ZoNe', limit: 50 },
    );

    expect(result.map((item) => item.recordId)).toEqual(['rec_a', 'rec_b']);
  });

  it('deduplicates normalized names within one building and keeps the first record', () => {
    const result = filterStorageLocations(
      [
        storageLocation('rec_first', 'H楼', ' H-1F   101 ', '库内'),
        storageLocation('rec_duplicate', 'H楼', 'H-1F 101', '库外'),
      ],
      { building: 'H楼' },
    );

    expect(result).toEqual([
      storageLocation('rec_first', 'H楼', 'H-1F 101', '库内'),
    ]);
  });

  it('deduplicates same-building ASCII names without regard to letter case', () => {
    const result = filterStorageLocations(
      [
        storageLocation('rec_upper', 'H楼', 'H-ABC'),
        storageLocation('rec_lower', 'H楼', 'h-abc', '库外'),
      ],
      { building: 'H楼' },
    );

    expect(result).toEqual([storageLocation('rec_upper', 'H楼', 'H-ABC')]);
  });

  it('keeps equal normalized names in different buildings', () => {
    const items = [
      storageLocation('rec_h', 'H楼', '共享库位'),
      storageLocation('rec_a', 'A楼', ' 共享库位 '),
    ];

    expect(
      filterStorageLocations(items, { building: 'H楼' }).map(
        (item) => item.recordId,
      ),
    ).toEqual(['rec_h']);
    expect(
      filterStorageLocations(items, { building: 'A楼' }).map(
        (item) => item.recordId,
      ),
    ).toEqual(['rec_a']);
    expect(storageLocationKey('H楼', '共享库位')).not.toBe(
      storageLocationKey('A楼', '共享库位'),
    );
  });

  it('sorts by normalized name while preserving source order for equal sort values', () => {
    const result = filterStorageLocations(
      [
        storageLocation('rec_b', 'H楼', 'B区'),
        storageLocation('rec_lower', 'H楼', 'a区'),
        storageLocation('rec_accented', 'H楼', 'á区'),
      ],
      { building: 'H楼' },
    );

    expect(result.map((item) => item.recordId)).toEqual([
      'rec_lower',
      'rec_accented',
      'rec_b',
    ]);
  });

  it('uses a default limit of 50 and clamps explicit limits to 1 through 100', () => {
    const items = Array.from({ length: 120 }, (_, index) =>
      storageLocation(
        `rec_${index + 1}`,
        'H楼',
        `库位-${String(index + 1).padStart(3, '0')}`,
      ),
    );

    expect(filterStorageLocations(items, { building: 'H楼' })).toHaveLength(50);
    expect(
      filterStorageLocations(items, { building: 'H楼', limit: 1_000 }),
    ).toHaveLength(100);
    expect(
      filterStorageLocations(items, { building: 'H楼', limit: 0 }),
    ).toHaveLength(1);
    expect(
      filterStorageLocations(items, { building: 'H楼', limit: Number.NaN }),
    ).toHaveLength(50);
    expect(
      filterStorageLocations(items, {
        building: 'H楼',
        limit: Number.POSITIVE_INFINITY,
      }),
    ).toHaveLength(50);
    expect(
      filterStorageLocations(items, { building: 'H楼', limit: -10 }),
    ).toHaveLength(1);
    expect(
      filterStorageLocations(items, { building: 'H楼', limit: 1.9 }),
    ).toHaveLength(1);
  });

  it('validates a complete create request', () => {
    expect(validateStorageLocationCreateRequest(VALID_CREATE_REQUEST)).toEqual(
      VALID_CREATE_REQUEST,
    );
    expect(() =>
      validateStorageLocationCreateRequest({
        ...VALID_CREATE_REQUEST,
        name: '位'.repeat(120),
      }),
    ).not.toThrow();
  });

  it('returns a create request with normalized name and mutation id', () => {
    expect(
      validateStorageLocationCreateRequest({
        ...VALID_CREATE_REQUEST,
        name: '  H-1F   101  ',
        clientMutationId: '  location-create-1  ',
      }),
    ).toEqual({
      ...VALID_CREATE_REQUEST,
      name: 'H-1F 101',
    });
  });

  it.each([
    ['building', { building: 'Z楼' }, '请选择有效楼栋'],
    ['category', { category: '室内' }, '请选择有效存放位置分类'],
    ['empty name', { name: ' \t ' }, '请填写存放位置'],
    ['long name', { name: '位'.repeat(121) }, '存放位置不能超过 120 个字符'],
    ['mutation id', { clientMutationId: ' ' }, '请求标识不能为空'],
  ])('rejects an invalid create request: %s', (_label, patch, message) => {
    expect(() =>
      validateStorageLocationCreateRequest({
        ...VALID_CREATE_REQUEST,
        ...patch,
      } as WarehouseStorageLocationCreateRequest),
    ).toThrow(new BadRequestException(message));
  });

  it('builds the same key for whitespace-equivalent names', () => {
    expect(storageLocationKey('H楼', ' H-1F   101 ')).toBe(
      storageLocationKey('H楼', 'H-1F 101'),
    );
  });

  it('builds the same business key for ASCII case-equivalent names', () => {
    expect(storageLocationKey('H楼', 'H-ABC')).toBe(
      storageLocationKey('H楼', 'h-abc'),
    );
  });
});
