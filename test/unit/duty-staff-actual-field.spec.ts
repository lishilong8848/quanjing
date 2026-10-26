import {
  findDutyStaffActualBitableField,
  findWritableDutyProgramModifiedBitableField,
  pickDutyStaffActualField,
} from '../../server/modules/duty-schedule/duty-staff-actual-field';

describe('duty staff actual field resolution', () => {
  it('prefers the program-modified actual-staff field for display when present', () => {
    const value = pickDutyStaffActualField({
      '值班人员（实际）程序修改': '程序修改人员',
      fld2xDxrRH: 'AI人员',
      '值班人员（实际）': '公式人员',
    });

    expect(value).toBe('程序修改人员');
  });

  it('ignores the removed AI field and falls back to the legacy actual-staff field', () => {
    const value = pickDutyStaffActualField({
      '值班人员（实际）': '旧人员',
      fld2xDxrRH: '新人员',
    });

    expect(value).toBe('旧人员');
  });

  it('does not read the removed AI field when it is the only value', () => {
    expect(pickDutyStaffActualField({ fld2xDxrRH: 'AI人员' })).toBeUndefined();
  });

  it('resolves the legacy actual-staff field and ignores the removed AI field', () => {
    const field = findDutyStaffActualBitableField([
      { field_id: 'fldgeSx7S1', field_name: '值班人员（实际）' },
      { field_id: 'fld2xDxrRH', field_name: '值班人员(ai实际)' },
    ]);

    expect(field).toEqual({
      field_id: 'fldgeSx7S1',
      field_name: '值班人员（实际）',
    });
  });

  it('does not use the legacy actual-staff field as a writable target', () => {
    const field = findWritableDutyProgramModifiedBitableField([
      { field_id: 'fldgeSx7S1', field_name: '值班人员（实际）' },
    ]);

    expect(field).toBeUndefined();
  });

  it('uses only the program-modified actual-staff field as a writable target', () => {
    const field = findWritableDutyProgramModifiedBitableField([
      { field_id: 'fldgeSx7S1', field_name: '值班人员（实际）' },
      { field_id: 'fld2xDxrRH', field_name: '值班人员（实际）ai' },
      { field_id: 'fldProgram', field_name: '值班人员（实际）程序修改' },
    ]);

    expect(field).toEqual({
      field_id: 'fldProgram',
      field_name: '值班人员（实际）程序修改',
    });
  });
});
