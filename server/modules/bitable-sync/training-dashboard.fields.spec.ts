import { TRAINING_TABLE_CONFIGS } from './training-dashboard.fields';

describe('training-dashboard active employee fields', () => {
  const activeScores = TRAINING_TABLE_CONFIGS.find(
    ({ key }) => key === 'activeScores',
  )!;

  it('requests the exact live text field including its ASCII space', () => {
    expect(activeScores.fieldNames).toContain('员工 （文本）');
    expect(activeScores.fieldNames).not.toContain('员工');
    expect(activeScores.fieldNames).not.toContain('员工（文本）');
  });

  it('accepts both current text rows and legacy personnel rows for either month field', () => {
    expect(activeScores.qualityFieldGroups).toEqual(
      expect.arrayContaining([
        ['员工 （文本）', '楼栋', '月份（计划）'],
        ['员工 （文本）', '楼栋', '月份'],
        ['员工', '楼栋', '月份（计划）'],
        ['员工', '楼栋', '月份'],
      ]),
    );
  });
});
