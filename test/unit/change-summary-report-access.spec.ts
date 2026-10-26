import {
  CHANGE_SUMMARY_REPORT_ALLOWED_ROLES,
  canStageChangeAttachmentForRole,
  canSubmitChangeSummaryReportForRole,
  type AccessRole,
} from '../../shared/access-control.interface';

describe('change summary report access policy', () => {
  it('allows only admin, editor and duty_editor', () => {
    expect(CHANGE_SUMMARY_REPORT_ALLOWED_ROLES).toEqual([
      'admin',
      'editor',
      'duty_editor',
    ]);
    const roles: AccessRole[] = [
      'guest',
      'editor',
      'admin',
      'inventory_admin',
      'purchase_admin',
      'purchase_applicant',
      'duty_editor',
      'supply_chain_admin',
      'construction_admin',
    ];
    expect(roles.filter(canSubmitChangeSummaryReportForRole)).toEqual([
      'editor',
      'admin',
      'duty_editor',
    ]);
  });

  it('restricts summary attachment staging without narrowing legacy guest owners', () => {
    expect(
      roles().filter((role) =>
        canStageChangeAttachmentForRole(
          role,
          'change-summary-report-123e4567-e89b-42d3-a456-426614174000',
        ),
      ),
    ).toEqual(['editor', 'admin', 'duty_editor']);
    expect(
      canStageChangeAttachmentForRole(
        'guest',
        'change-request-123e4567-e89b-42d3-a456-426614174000',
      ),
    ).toBe(true);
  });
});

function roles(): AccessRole[] {
  return [
    'guest',
    'editor',
    'admin',
    'inventory_admin',
    'purchase_admin',
    'purchase_applicant',
    'duty_editor',
    'supply_chain_admin',
    'construction_admin',
  ];
}
