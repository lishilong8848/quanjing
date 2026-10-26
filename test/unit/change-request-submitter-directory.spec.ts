import {
  listEligibleChangeRequestSubmitterNames,
  resolveChangeRequestSubmitterCandidate,
} from '../../server/modules/bitable-sync/change-request-submitter-directory';

type TestRecord = {
  record_id: string;
  fields: Record<string, unknown>;
};

function record(
  id: string,
  name: string,
  users: unknown,
): TestRecord {
  return {
    record_id: id,
    fields: {
      姓名: name,
      员工姓名: users,
    },
  };
}

describe('change request submitter directory', () => {
  const records = [
    record('rec-valid-b', ' Beta ', [{ id: 'ou_beta', name: 'Beta' }]),
    record('rec-valid-a', 'Alpha', [{ id: 'ou_alpha', name: 'Alpha' }]),
    record('rec-no-account', 'NoAccount', []),
    record('rec-many-accounts', 'Many', [
      { id: 'ou_many_1', name: 'Many' },
      { id: 'ou_many_2', name: 'Many' },
    ]),
    record('rec-mismatch', 'TextName', [
      { id: 'ou_mismatch', name: 'AccountName' },
    ]),
    record('rec-no-id', 'NoId', [{ name: 'NoId' }]),
    record('rec-duplicate-1', 'Duplicate', [
      { id: 'ou_duplicate_1', name: 'Duplicate' },
    ]),
    record('rec-duplicate-2', ' Duplicate ', [
      { id: 'ou_duplicate_2', name: 'Duplicate' },
    ]),
  ];

  it('lists only unique submitters with one matching Feishu account', () => {
    expect(
      listEligibleChangeRequestSubmitterNames(records as never),
    ).toEqual(['Alpha', 'Beta']);
  });

  it('returns a safe reason and user id for exact server-side resolution', () => {
    expect(
      resolveChangeRequestSubmitterCandidate(records as never, ' Alpha '),
    ).toEqual({ ok: true, userId: 'ou_alpha' });
    expect(
      resolveChangeRequestSubmitterCandidate(records as never, 'Duplicate'),
    ).toEqual({ ok: false, reason: 'duplicate' });
    expect(
      resolveChangeRequestSubmitterCandidate(records as never, 'Many'),
    ).toEqual({ ok: false, reason: 'account-count' });
    expect(
      resolveChangeRequestSubmitterCandidate(records as never, 'TextName'),
    ).toEqual({ ok: false, reason: 'account-name-mismatch' });
    expect(
      resolveChangeRequestSubmitterCandidate(records as never, 'NoId'),
    ).toEqual({ ok: false, reason: 'user-id-missing' });
    expect(
      resolveChangeRequestSubmitterCandidate(records as never, 'Missing'),
    ).toEqual({ ok: false, reason: 'not-found' });
  });
});
