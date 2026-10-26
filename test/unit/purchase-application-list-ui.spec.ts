import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('purchase application list UI', () => {
  const source = readFileSync(
    resolve(
      __dirname,
      '../../client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    ),
    'utf8',
  );
  const applicationTable = source.slice(
    source.indexOf('<thead'),
    source.indexOf('</tbody>'),
  );

  it('renders purchase method and approval responsibility in the application table', () => {
    expect(applicationTable).toContain('采购方式');
    expect(applicationTable).toContain('item.approvalTarget');
  });

  it('renders purchase methods as semantic badges', () => {
    expect(applicationTable).toContain('<PurchaseMethodBadge');
    expect(source.match(/<PurchaseMethodBadge/g)).toHaveLength(2);
    expect(source).toContain("method.includes('需求自采')");
    expect(source).toContain("method === '综合采购'");
    expect(source).toContain("method === '驳回'");
  });

  it('uses compact vertical spacing for application table rows', () => {
    expect(applicationTable).toContain('py-2.5');
  });

  it('groups line items by purchase order number and merges the order-number cell', () => {
    expect(applicationTable).toContain('采购单号');
    expect(source).toContain('groupPurchaseOrderItems');
    expect(source).toContain('rowSpan={rowSpan}');
  });

  it('shows the item specification in application and execution lists', () => {
    expect(applicationTable).toContain('规格型号');
    expect(applicationTable).toContain("item.specification || '未填写'");
    expect(source.match(/label="规格型号"/g)).toHaveLength(1);
  });

  it('shows compact purchase-link labels without exposing raw URL text', () => {
    expect(source).toContain('采购链接');
    expect(source).toContain('<PurchaseLinks');
    expect(source).toContain('链接${index + 1}');
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noreferrer noopener"');
  });
});
