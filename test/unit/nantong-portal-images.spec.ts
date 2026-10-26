import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import * as portalAssets from '../../client/src/pages/NantongBaseHome/portal-asset';
import { SYSTEMS } from '../../client/src/pages/NantongBaseHome/portal-data';
const { portalAsset } = portalAssets;
const { portalPhotoSources } = portalAssets as unknown as { portalPhotoSources: (file: string) => { srcSet?: string } };

describe('portal image delivery', () => {
  it('keeps unknown files on the original path and respects deployment prefixes', () => {
    const old = process.env.CLIENT_BASE_PATH;
    try {
      process.env.CLIENT_BASE_PATH = '/app/';
      expect(portalAsset('unknown.jpg')).toBe('/app/portal/vnet-photo-20260909/unknown.jpg');
      expect(portalAsset('field-network-switch.jpg')).toMatch(/^\/app\/portal\/vnet-photo-20261012\/.+\.[a-f0-9]{12}\.webp$/);
    } finally {
      if (old === undefined) delete process.env.CLIENT_BASE_PATH;
      else process.env.CLIENT_BASE_PATH = old;
    }
  });

  it('publishes verified small images for every device without overwriting originals', () => {
    const root = process.cwd();
    const manifest = JSON.parse(readFileSync(join(root, 'client/public/portal/vnet-photo-20261012/manifest.json'), 'utf8'));
    for (const [, file] of Object.values(SYSTEMS).flatMap(system => system.photos)) {
      const item = manifest[file];
      expect(item).toBeDefined();
      const original = readFileSync(join(root, 'client/public/portal/vnet-photo-20260909', file));
      expect(createHash('sha256').update(original).digest('hex')).toBe(item.originalSha256);
      for (const variant of ['display', 'mobile', 'thumbnail']) {
        const asset = item[variant];
        const bytes = readFileSync(join(root, 'client/public/portal/vnet-photo-20261012', asset.file));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
        expect(asset.file).toContain(asset.sha256.slice(0, 12));
        expect(bytes.length).toBeLessThan(original.length);
      }
      expect(item.thumbnail.bytes).toBeLessThan(25000);
      expect(item.thumbnail.width).toBeLessThanOrEqual(256);
      expect((portalAsset as (file: string, variant: string) => string)(file, 'thumbnail')).not.toBe(portalAsset(file));
      const sources = portalPhotoSources(file);
      expect(sources.srcSet).toContain(`${item.mobile.width}w`);
      expect(sources.srcSet).toContain(`${item.display.width}w`);
    }
  });

  it('uses the new helper name everywhere without sending old branding to AI', () => {
    for (const file of ['client/src/components/NantongAssistant.tsx', 'server/modules/bitable-sync/nantong-assistant.service.ts']) {
      const source = readFileSync(join(process.cwd(), file), 'utf8');
      expect(source).not.toContain('南通小帮手');
      expect(source).toContain('全景小帮手');
    }
  });
});
