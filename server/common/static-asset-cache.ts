export function staticAssetCacheControl(assetPath: string): string {
  const path = assetPath.replace(/\\/g, '/');
  const immutable = /\/chunks\/[^/]+\.[a-f0-9]{8,}\.(?:css|js)$/i.test(path)
    || /\/portal\/vnet-photo-20261012\/[^/]+\.[a-f0-9]{12}\.webp$/i.test(path);
  return immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate';
}
