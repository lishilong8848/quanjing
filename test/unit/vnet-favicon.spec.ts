import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('VNET browser favicon', () => {
  it('loads a versioned SVG favicon from the document head', () => {
    const html = readFileSync(resolve('client/index.html'), 'utf8');

    expect(html).toMatch(
      /<link rel="icon" type="image\/svg\+xml" href="<%= publicPath %>\/favicon\.svg\?v=20260815">/,
    );
  });

  it('uses a compact VNET blue, white and green square mark', () => {
    const svg = readFileSync(resolve('client/public/favicon.svg'), 'utf8');

    expect(svg).toContain('viewBox="0 0 64 64"');
    expect(svg).toContain('aria-label="VNET"');
    expect(svg).toContain('#1769E0');
    expect(svg).toContain('#FFFFFF');
    expect(svg).toContain('#16B88A');
    expect(svg).not.toContain('<linearGradient');
  });

  it('provides the same versioned favicon in database-backed rendering', () => {
    const controllerSource = readFileSync(
      resolve('server/modules/view/view.controller.ts'),
      'utf8',
    );

    expect(controllerSource).toContain(
      "const APP_FAVICON_PATH = '/favicon.svg?v=20260815';",
    );
    expect(controllerSource).toContain('appAvatar: APP_FAVICON_PATH');
  });
});
