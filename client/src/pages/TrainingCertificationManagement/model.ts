export const TRAINING_CERTIFICATION_MODULES = [
  'certificate',
  'training',
] as const;

export type TrainingCertificationModule =
  (typeof TRAINING_CERTIFICATION_MODULES)[number];

export function parseTrainingCertificationModule(
  value: string | null | undefined,
): TrainingCertificationModule {
  return value === 'training' ? 'training' : 'certificate';
}

export function buildTrainingCertificationHref(
  module: TrainingCertificationModule,
): string {
  return `/training-certification-management?module=${module}`;
}
