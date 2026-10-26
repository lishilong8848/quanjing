import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('purchase personnel contact entry', () => {
  const source = readFileSync(
    resolve(
      __dirname,
      '../../client/src/pages/PurchaseInventoryManagement/PurchaseOverviewPage.tsx',
    ),
    'utf8',
  );

  it('renders requester and purchaser as a unified, understated Feishu chat link in both list layouts', () => {
    expect(source).toContain('function PersonChatLink');
    expect(source).toContain('item.requesterChatUrl');
    expect(source).toContain('item.purchaserChatUrl');
    expect(source.match(/<PersonChatLink/g)).toHaveLength(2);
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noreferrer noopener"');
    expect(source).toContain('与${name}发起飞书对话');

    const personLinkSource = source.slice(
      source.indexOf('function PersonChatLink'),
      source.indexOf('function PurchaseMethodBadge'),
    );
    expect(personLinkSource).toContain('border-blue-300');
    expect(personLinkSource).not.toContain('bg-orange-50');
    expect(personLinkSource).not.toContain('MessageCircle');
  });
});
