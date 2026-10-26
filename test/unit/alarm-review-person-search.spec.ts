import { filterAlarmReviewPeople } from '../../client/src/pages/TodayOperationsPanorama/alarm-review-person-search';

const people = [
  { recordId: 'recA', name: '张 清 溪', buildings: ['E楼'], position: '电气工程师' },
  { recordId: 'recB', name: '张清溪', buildings: ['B楼'], position: '暖通工程师' },
  { recordId: 'recC', name: '李雷', buildings: ['A楼'], position: '值班长' },
];
describe('alarm review local person search', () => {
  it('keeps stable identities for empty queries and duplicate names', () => {
    expect(filterAlarmReviewPeople(people, '')).toEqual(people);
    expect(filterAlarmReviewPeople(people, '张清溪').map(p => p.recordId)).toEqual(['recA', 'recB']);
  });
  it('matches partial names, building and role with multiple tokens', () => {
    expect(filterAlarmReviewPeople(people, '张溪').map(p => p.recordId)).toEqual(['recA', 'recB']);
    expect(filterAlarmReviewPeople(people, 'e楼 电气').map(p => p.recordId)).toEqual(['recA']);
    expect(filterAlarmReviewPeople(people, 'B楼 张').map(p => p.recordId)).toEqual(['recB']);
    expect(filterAlarmReviewPeople(people, '不在名单')).toEqual([]);
  });
  it('matches user-facing building labels against directory building codes', () => {
    const coded = [{ ...people[0], buildings: ['E'] }, { ...people[2], buildings: ['110'] }];
    expect(filterAlarmReviewPeople(coded, 'E楼').map(p => p.recordId)).toEqual(['recA']);
    expect(filterAlarmReviewPeople(coded, '110站').map(p => p.recordId)).toEqual(['recC']);
  });
});
