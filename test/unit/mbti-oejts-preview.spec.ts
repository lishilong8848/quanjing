import { OEJTS_ITEMS, scoreOejts, type OejtsAnswer } from '../../output/mbti-static-preview/oejts-model';
import { getMbtiAxisInsight } from '../../shared/mbti-report';

describe('OEJTS 1.2 local preview scoring', () => {
  it('contains the 32 published item pairs', () => {
    expect(OEJTS_ITEMS).toHaveLength(32);
    expect(OEJTS_ITEMS.every(([left, right]) => left && right && left !== right)).toBe(true);
  });

  it('applies the published formulas to all-left answers', () => {
    expect(scoreOejts(Array(32).fill(1) as OejtsAnswer[])).toEqual({
      type: 'ESTJ',
      scores: { IE: 28, SN: 16, FT: 28, JP: 20 },
      preferences: { EI: 63, SN: 75, TF: 63, JP: 63 },
    });
  });

  it('applies the published formulas to all-right answers', () => {
    expect(scoreOejts(Array(32).fill(5) as OejtsAnswer[])).toEqual({
      type: 'INFP',
      scores: { IE: 20, SN: 32, FT: 20, JP: 28 },
      preferences: { EI: 38, SN: 25, TF: 38, JP: 38 },
    });
  });

  it('uses the published <=24 tie rule and rejects incomplete answers', () => {
    expect(scoreOejts(Array(32).fill(3) as OejtsAnswer[]).type).toBe('ISFJ');
    expect(getMbtiAxisInsight('EI', 50).summary).toContain('无法区分偏好');
    expect(() => scoreOejts(Array(31).fill(3) as OejtsAnswer[])).toThrow();
    expect(() => scoreOejts([...Array(31).fill(3), null])).toThrow();
    expect(() => scoreOejts([...Array(31).fill(3), 6])).toThrow();
  });
});
