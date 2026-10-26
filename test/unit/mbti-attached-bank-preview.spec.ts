import { ATTACHED_BANK, getAttachedBankDisplayType, scoreAttachedBank, type FullAnswer, type ShortAnswer } from '../../output/mbti-static-preview/attached-bank-model';

describe('user-supplied 60/93 question bank preview', () => {
  it('has complete question IDs and scoring metadata', () => {
    expect(ATTACHED_BANK.short.map((item) => item.id)).toEqual(Array.from({ length: 60 }, (_, index) => index + 1));
    expect(ATTACHED_BANK.full.map((item) => item.id)).toEqual(Array.from({ length: 93 }, (_, index) => index + 1));
    expect(ATTACHED_BANK.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(ATTACHED_BANK.short.every((item) => item.text && item.axis && item.agree)).toBe(true);
    expect(ATTACHED_BANK.full.every((item) => item.a && item.b && item.scoreA && item.scoreB)).toBe(true);
  });

  it('uses the document reference key for seven-point short answers', () => {
    const result = scoreAttachedBank('short', Array(60).fill(7) as ShortAnswer[]);
    expect(result.code).toBe('ENFJ');
    expect(result.type).toBe('ENFJ');
    expect(result.identity?.code).toBe('T');
    expect(result.scores.EI).toBe(0.5);
    expect(result.scores.SN).toBe(-0.5);
  });

  it('does not force a 16-type label for short-form boundary scores', () => {
    const result = scoreAttachedBank('short', Array(60).fill(4) as ShortAnswer[]);
    expect(result.code).toBe('XXXX');
    expect(result.type).toBeNull();
    expect(result.boundaryAxes).toEqual(['EI', 'SN', 'TF', 'JP']);
    expect(result.identity?.code).toBe('X');
    expect(getAttachedBankDisplayType(result)).toBe('INFP');
  });

  it('shows the closest four-letter type while keeping borderline scores visible', () => {
    expect(getAttachedBankDisplayType({
      type: null,
      code: 'IXXJ',
      preferences: { EI: 29, SN: 50, TF: 44, JP: 67 },
      scores: { EI: -1.3, SN: 0, TF: -0.4, JP: 1 },
      boundaryAxes: ['SN', 'TF'],
    })).toBe('INFJ');
  });

  it('applies the document A/B keys and I/N/F/P tie rules to 93 items', () => {
    expect(scoreAttachedBank('full', Array(93).fill('A') as FullAnswer[])).toMatchObject({
      code: 'INFP', scores: { EI: -3, SN: 0, TF: -2, JP: 0 },
      boundaryAxes: ['SN', 'JP'],
    });
    expect(scoreAttachedBank('full', Array(93).fill('B') as FullAnswer[]).code).toBe('ENTP');
  });

  it('rejects incomplete, out-of-range, and cross-version answers', () => {
    expect(() => scoreAttachedBank('short', Array(59).fill(4) as ShortAnswer[])).toThrow();
    expect(() => scoreAttachedBank('short', [...Array(59).fill(4), 8])).toThrow();
    expect(() => scoreAttachedBank('full', [...Array(92).fill('A'), null])).toThrow();
    expect(() => scoreAttachedBank('full', Array(93).fill(3))).toThrow();
  });
});
