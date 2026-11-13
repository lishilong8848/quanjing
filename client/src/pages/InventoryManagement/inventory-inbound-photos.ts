import {
  INVENTORY_INBOUND_PHOTO_MAX_COUNT,
  type InventoryInboundStagedPhoto,
  type WarehouseBuilding,
} from '@shared/inventory-management.interface';

const PHOTO_ID = /^[a-f0-9]{64}$/;
const STAGED_PHOTO_PATH = /^\/api\/inventory-management\/inbound-photos\/[\w%\u3400-\u9fff-]+\/[\w-]+\/[a-f0-9]{64}$/;
const LEDGER_PHOTO_PATH = /^\/api\/inventory-management\/items\/[A-Za-z0-9_-]{1,128}\/images\/\d{1,6}-[a-f0-9]{16}$/;

export function isInventoryLedgerPhotoPath(url: string): boolean {
  return LEDGER_PHOTO_PATH.test(url);
}

export function isInventoryInboundPhotoIds(value: unknown): value is string[] {
  return Array.isArray(value) &&
    value.length > 0 &&
    value.length <= INVENTORY_INBOUND_PHOTO_MAX_COUNT &&
    value.every((id) => typeof id === 'string' && PHOTO_ID.test(id)) &&
    new Set(value).size === value.length;
}

export function isInventoryInboundStagedPhotos(value: unknown): value is InventoryInboundStagedPhoto[] {
  return Array.isArray(value) &&
    isInventoryInboundPhotoIds(value.map((photo) => photo?.id)) &&
    value.every((photo) =>
      photo !== null &&
      typeof photo === 'object' &&
      Object.keys(photo).length === 3 &&
      typeof photo.name === 'string' &&
      photo.name.trim().length > 0 &&
      typeof photo.url === 'string' &&
      STAGED_PHOTO_PATH.test(photo.url) &&
      photo.url.endsWith(`/${photo.id}`),
    );
}

export function inventoryInboundPhotoPath(
  building: WarehouseBuilding,
  clientMutationId: string,
  photoId: string,
): string {
  return `/api/inventory-management/inbound-photos/${encodeURIComponent(building)}/${encodeURIComponent(clientMutationId)}/${photoId}`;
}

export function isInventoryInboundPhotoForRequest(
  photo: InventoryInboundStagedPhoto,
  building: WarehouseBuilding,
  clientMutationId: string,
): boolean {
  const path = inventoryInboundPhotoPath(building, clientMutationId, photo.id);
  return photo.url === path || photo.url === decodeURI(path);
}
