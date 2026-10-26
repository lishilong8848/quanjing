import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('purchase application direct link', () => {
  const routeHelperPath = join(
    process.cwd(),
    'client/src/navigation/purchase-application-route.ts',
  );

  it('recognizes only the canonical direct route after safe normalization', () => {
    expect(existsSync(routeHelperPath)).toBe(true);

    const {
      PURCHASE_APPLICATION_DIRECT_PATH,
      PURCHASE_INVENTORY_MANAGEMENT_PATH,
      isPurchaseApplicationDirectPath,
    } = jest.requireActual(routeHelperPath) as {
      PURCHASE_APPLICATION_DIRECT_PATH: string;
      PURCHASE_INVENTORY_MANAGEMENT_PATH: string;
      isPurchaseApplicationDirectPath: (pathname: string) => boolean;
    };

    expect(PURCHASE_INVENTORY_MANAGEMENT_PATH).toBe(
      '/purchase-inventory-management',
    );
    expect(PURCHASE_APPLICATION_DIRECT_PATH).toBe(
      '/purchase-inventory-management/apply/new',
    );
    expect(
      isPurchaseApplicationDirectPath(
        '/Purchase-Inventory-Management/apply/new///',
      ),
    ).toBe(true);
    expect(
      isPurchaseApplicationDirectPath('/purchase-inventory-management'),
    ).toBe(false);
    expect(
      isPurchaseApplicationDirectPath(
        '/purchase-inventory-management/apply/new-evil',
      ),
    ).toBe(false);
  });

  it('registers the direct route inside the guarded application route tree', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/app.tsx'),
      'utf8',
    );

    expect(source).toContain('path={PURCHASE_APPLICATION_DIRECT_PATH}');
    expect(source).toMatch(
      /<Route element={<RouteAccessGuard \/>}>[\s\S]*path=\{PURCHASE_APPLICATION_DIRECT_PATH\}/,
    );
  });

  it('prefills the purchase applicant login for the direct route', () => {
    const source = readFileSync(
      join(process.cwd(), 'client/src/access/RouteAccessGuard.tsx'),
      'utf8',
    );

    expect(source).toMatch(
      /isPurchaseApplicationDirectPath\(\s*location\.pathname,?\s*\)[\s\S]*?\? 'purchase_applicant'/,
    );
    expect(source).toContain(
      'requestLogin(reason, location.pathname, preferredAccountType);',
    );
    expect(source).toContain('选择所属楼栋并输入访问密码');
  });
});
