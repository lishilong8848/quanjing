import { formatMonthlyQualityImageTitle } from '../../client/src/pages/RiskInspectionDashboard/monthly-quality-image';

const issue = {
  building: 'A楼',
  item: '值班纪律',
  issue: '睡岗',
  supplemental: '',
  responsiblePersons: [{ recordId: 'person-1', name: '李董' }],
};

describe('monthly quality image title', () => {
  test('describes the actual image content instead of exposing a file name', () => {
    expect(formatMonthlyQualityImageTitle(issue)).toBe('值班纪律--A楼李董睡岗');
  });

  test('does not repeat a building or person already present in the issue text', () => {
    expect(
      formatMonthlyQualityImageTitle({
        ...issue,
        issue: 'A楼李董睡岗',
      }),
    ).toBe('值班纪律--A楼李董睡岗');
  });

  test('falls back to the supplemental description when the issue is empty', () => {
    expect(
      formatMonthlyQualityImageTitle({
        ...issue,
        issue: '',
        supplemental: '夜班值守期间睡岗',
      }),
    ).toBe('值班纪律--A楼李董夜班值守期间睡岗');
  });
});
