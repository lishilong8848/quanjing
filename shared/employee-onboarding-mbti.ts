import type { EmployeeOnboardingMbtiAssessment } from './employee-onboarding';
import {
  ATTACHED_BANK,
  getAttachedBankDisplayType,
  scoreAttachedBank,
  type BankAnswer,
} from './mbti-attached-bank-model';
import type { MbtiTypeCode } from './organization-person-profile';

export function validateOnboardingMbtiAssessment(
  value: unknown,
  name: string,
): { assessment: EmployeeOnboardingMbtiAssessment; type: MbtiTypeCode } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const assessment = value as Partial<EmployeeOnboardingMbtiAssessment>;
  if (
    assessment.participantName !== name.trim() ||
    (assessment.version !== 'short' && assessment.version !== 'full') ||
    assessment.sourceSha256 !== ATTACHED_BANK.sourceSha256 ||
    !Array.isArray(assessment.answers)
  ) return null;

  try {
    const answers = assessment.answers as BankAnswer[];
    const type = getAttachedBankDisplayType(scoreAttachedBank(assessment.version, answers));
    return {
      assessment: {
        participantName: name.trim(),
        version: assessment.version,
        answers: [...answers] as EmployeeOnboardingMbtiAssessment['answers'],
        sourceSha256: ATTACHED_BANK.sourceSha256,
      },
      type,
    };
  } catch {
    return null;
  }
}
