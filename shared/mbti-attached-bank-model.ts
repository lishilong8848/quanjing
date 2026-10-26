import type { MbtiTypeCode } from './organization-person-profile';
import * as source from './mbti-attached-bank.json';

export type BankVersion = 'short' | 'full';
export type ShortAnswer = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type FullAnswer = 'A' | 'B';
export type BankAnswer = ShortAnswer | FullAnswer | null;
export type BankAxis = 'EI' | 'SN' | 'TF' | 'JP';
export type BankPole = 'E' | 'I' | 'S' | 'N' | 'T' | 'F' | 'J' | 'P';

export interface ShortQuestion { id: number; text: string; axis: BankAxis | 'AT'; agree: BankPole | 'A' }
export interface FullQuestion { id: number; section: number; text: string; a: string; b: string; scoreA: BankPole; scoreB: BankPole }
export interface BankResult {
  type: MbtiTypeCode | null;
  code: string;
  preferences: Record<BankAxis, number>;
  scores: Record<BankAxis, number>;
  boundaryAxes: BankAxis[];
  identity?: { code: 'A' | 'T' | 'X'; assertivePercent: number };
}

const AXES: readonly BankAxis[] = ['EI', 'SN', 'TF', 'JP'];
const LEFT: Record<BankAxis, BankPole> = { EI: 'E', SN: 'S', TF: 'T', JP: 'J' };
const RIGHT: Record<BankAxis, BankPole> = { EI: 'I', SN: 'N', TF: 'F', JP: 'P' };

export const ATTACHED_BANK = {
  sourceSha256: source.sourceSha256,
  sourceName: source.sourceName,
  short: source.short as ShortQuestion[],
  full: source.full as FullQuestion[],
};

function checkAnswers(version: BankVersion, answers: readonly BankAnswer[]): void {
  const required = version === 'short' ? 60 : 93;
  if (answers.length !== required || answers.some((answer) => version === 'short'
    ? !Number.isInteger(answer) || Number(answer) < 1 || Number(answer) > 7
    : answer !== 'A' && answer !== 'B')) {
    throw new Error(`需要完整填写 ${required} 题`);
  }
}

export function scoreAttachedBank(version: 'short', answers: readonly (ShortAnswer | null)[]): BankResult;
export function scoreAttachedBank(version: 'full', answers: readonly (FullAnswer | null)[]): BankResult;
export function scoreAttachedBank(version: BankVersion, answers: readonly BankAnswer[]): BankResult;
export function scoreAttachedBank(version: BankVersion, answers: readonly BankAnswer[]): BankResult {
  checkAnswers(version, answers);
  const preferences = {} as Record<BankAxis, number>;
  const scores = {} as Record<BankAxis, number>;
  const boundaryAxes: BankAxis[] = [];
  const letters: string[] = [];
  let identity: BankResult['identity'];

  if (version === 'short') {
    for (const axis of [...AXES, 'AT'] as const) {
      const questions = ATTACHED_BANK.short.filter((item) => item.axis === axis);
      const left = axis === 'AT' ? 'A' : LEFT[axis];
      const average = questions.reduce((sum, item) => {
        const value = Number(answers[item.id - 1]) - 4;
        return sum + value * (item.agree === left ? 1 : -1);
      }, 0) / questions.length;
      const leftPercent = Math.round((average + 3) / 6 * 100);
      const code = Math.abs(average) < 0.5 ? 'X' : average > 0 ? left : axis === 'AT' ? 'T' : RIGHT[axis];
      if (axis === 'AT') {
        identity = { code: code as 'A' | 'T' | 'X', assertivePercent: leftPercent };
      } else {
        scores[axis] = average;
        preferences[axis] = leftPercent;
        if (code === 'X') boundaryAxes.push(axis);
        letters.push(code);
      }
    }
  } else {
    for (const axis of AXES) {
      const questions = ATTACHED_BANK.full.filter((item) => item.scoreA === LEFT[axis] || item.scoreA === RIGHT[axis]);
      const leftCount = questions.filter((item) => {
        const answer = answers[item.id - 1];
        return (answer === 'A' ? item.scoreA : item.scoreB) === LEFT[axis];
      }).length;
      const rightCount = questions.length - leftCount;
      scores[axis] = leftCount - rightCount;
      preferences[axis] = Math.round(leftCount / questions.length * 100);
      // The supplied document's tie rule is I / N / F / P.
      letters.push(leftCount > rightCount ? LEFT[axis] : RIGHT[axis]);
      if (leftCount === rightCount) boundaryAxes.push(axis);
    }
  }

  const code = letters.join('');
  return {
    type: code.includes('X') ? null : code as MbtiTypeCode,
    code,
    preferences,
    scores,
    boundaryAxes,
    identity,
  };
}

export function getAttachedBankDisplayType(result: BankResult): MbtiTypeCode {
  if (result.type) return result.type;
  return AXES.map((axis) => result.scores[axis] > 0 ? LEFT[axis] : RIGHT[axis]).join('') as MbtiTypeCode;
}
