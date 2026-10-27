import manifest from '../../../public/portal/vnet-photo-20261012/manifest.json';

type Variant = 'display' | 'mobile' | 'thumbnail';
const assets: Record<string, { display: { file: string; width: number }; mobile: { file: string; width: number }; thumbnail: { file: string; width: number } }> = manifest;
export const PORTAL_PHOTO_SIZES = '(max-width: 760px) 100vw, (max-width: 1120px) 90vw, 65vw';

export function portalAsset(file: string, variant: Variant = 'display'): string {
  const base = (process.env.CLIENT_BASE_PATH || '').replace(/\/+$/, '');
  const optimized = assets[file]?.[variant];
  return optimized
    ? `${base}/portal/vnet-photo-20261012/${optimized.file}`
    : `${base}/portal/vnet-photo-20260909/${file}`;
}

export function portalPhotoSources(file: string) {
  const photo = assets[file];
  return {
    src: portalAsset(file),
    srcSet: photo ? `${portalAsset(file, 'mobile')} ${photo.mobile.width}w, ${portalAsset(file)} ${photo.display.width}w` : undefined,
    sizes: PORTAL_PHOTO_SIZES,
  };
}
