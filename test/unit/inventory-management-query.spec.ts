import {
  parseInventoryItemsQuery,
  parseInventoryMovementsQuery,
} from '../../server/modules/inventory-management/inventory-management.query';

describe('inventory management query parser', () => {
  it('parses inventory filters, pagination, sorting, and refresh', () => {
    expect(
      parseInventoryItemsQuery({
        page: '2',
        pageSize: '25',
        search: ' 滤芯 ',
        building: 'A楼',
        category: '机房耗材',
        risk: 'low',
        sort: 'quantityAsc',
        refresh: '1',
      }),
    ).toEqual({
      query: {
        page: 2,
        pageSize: 25,
        search: '滤芯',
        building: 'A楼',
        category: '机房耗材',
        risk: 'low',
        sort: 'quantityAsc',
      },
      forceRefresh: true,
    });
  });

  it('normalizes unsupported values to safe defaults', () => {
    expect(
      parseInventoryItemsQuery({
        page: 'not-a-number',
        pageSize: '-10',
        building: 'Z楼',
        risk: 'unknown',
        sort: 'unknown',
        refresh: 'false',
      }),
    ).toEqual({
      query: {
        page: 1,
        pageSize: 20,
        search: '',
        building: 'all',
        category: 'all',
        risk: 'all',
        sort: 'risk',
      },
      forceRefresh: false,
    });
  });

  it('parses movement type, filters, pagination, and refresh', () => {
    expect(
      parseInventoryMovementsQuery({
        type: 'borrow',
        page: '3',
        pageSize: '40',
        search: ' 应急电源 ',
        building: 'D楼',
        status: ' 未归还 ',
        refresh: 'true',
      }),
    ).toEqual({
      query: {
        type: 'borrow',
        page: 3,
        pageSize: 40,
        search: '应急电源',
        building: 'D楼',
        status: '未归还',
      },
      forceRefresh: true,
    });
  });

  it('normalizes unsupported movement parameters to safe defaults', () => {
    expect(
      parseInventoryMovementsQuery({
        type: 'transfer',
        page: '0',
        pageSize: '500',
        building: 'Z楼',
        status: ' ',
      }),
    ).toEqual({
      query: {
        type: 'inbound',
        page: 1,
        pageSize: 100,
        search: '',
        building: 'all',
        status: 'all',
      },
      forceRefresh: false,
    });
  });
});
