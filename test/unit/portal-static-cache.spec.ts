import { staticAssetCacheControl } from '../../server/common/static-asset-cache';

describe('static asset caching', () => {
  it.each([
    '/dist/client/chunks/home.1234abcd.js',
    'D:\\app\\dist\\client\\portal\\vnet-photo-20261012\\field-network-switch-display.97756e3cfcbc.webp',
    '/dist/client/portal/vnet-photo-20261012/panorama-assistant.51a26c035165.webp',
  ])('keeps verified content-addressed assets immutable: %s', (path) => {
    expect(staticAssetCacheControl(path)).toBe('public, max-age=31536000, immutable');
  });
  it.each([
    '/dist/client/main.js', '/dist/client/index.html',
    '/dist/client/portal/vnet-photo-20260909/field-network-switch.jpg',
    '/dist/client/portal/vnet-photo-20261012/no-hash.webp',
    '/dist/client/portal/vnet-photo-20261012/manifest.json',
    '/dist/client/other/panorama-assistant.51a26c035165.webp',
  ])('revalidates mutable assets: %s', (path) => {
    expect(staticAssetCacheControl(path)).toBe('public, max-age=0, must-revalidate');
  });
});
