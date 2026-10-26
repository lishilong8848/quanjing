import { SetMetadata } from '@nestjs/common';

export const PublicAccessMetadataKey = 'unified-access:public';
export const GuestReadableMetadataKey = 'unified-access:guest-readable';
export const GuestSubmittableMetadataKey = 'unified-access:guest-submittable';
export const AdminOnlyMetadataKey = 'unified-access:admin-only';
export const ProfessionalScopedMetadataKey = 'unified-access:professional-scoped';
// Only handlers that verify persisted record scope may opt in.
export const ProfessionalScoped = () => SetMetadata(ProfessionalScopedMetadataKey, true);

export const PublicAccess = () => SetMetadata(PublicAccessMetadataKey, true);
export const GuestReadable = () => SetMetadata(GuestReadableMetadataKey, true);
export const GuestSubmittable = () =>
  SetMetadata(GuestSubmittableMetadataKey, true);
export const AdminOnly = () => SetMetadata(AdminOnlyMetadataKey, true);
