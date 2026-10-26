import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readLocalLeaveProjection, resolveLocalLeaveProjection } from '../../server/common/feishu/leave-local-projection';
import { applicant, backup, fixture, primary, replacement } from './fixtures/leave-two-level';

describe('same-ledger two-level projection without a cloud column', () => {
  let directory: string;
  let ledgerPath: string;
  const data = () => fixture();
  const request = (revision = 0): any => ({ recordId: data().application.recordId, leaveStaff: [applicant.name], assignmentRevision: revision, requiresOriginalPostMetadata: true, impactedScheduleRecordIds: data().application.snapshot.shiftGroups[0].scheduleRecordIds, shiftDetails: [{ shiftKey: data().selection.shiftKey, scheduleRecordIds: data().assignments[0].scheduleRecordIds, substituteStaff: [primary.name], substitutePersonRecordId: primary.personRecordId, substituteOpenId: primary.openId, revision }] });
  const application = (): any => ({ ...data().application, key: `leave:${data().application.recordId}`, status: 'approved', resolvedAction: 'approve', snapshot: { ...data().application.snapshot, shiftAssignments: data().assignments } });
  const ledger = (): any => ({ version: 4, applications: [application()], actions: [], substituteUpdates: [], tasks: [] });
  const save = (value: unknown) => fs.writeFile(ledgerPath, JSON.stringify(value), 'utf8');
  beforeEach(async () => { directory = await fs.mkdtemp(join(tmpdir(), 'leave-two-level-local-owned-')); ledgerPath = join(directory, 'ledger.json'); });
  afterEach(async () => { jest.restoreAllMocks(); if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) || !directory.includes('leave-two-level-local-owned-')) throw Error('Unsafe cleanup'); await fs.rm(directory, { recursive: true, force: true }); });
  it('cold-loads complete stable identities and both posts from the existing ledger only', async () => {
    await save(ledger());
    expect(resolveLocalLeaveProjection(await readLocalLeaveProjection({ ledgerPath }), request())).toMatchObject({ kind: 'ready', assignments: data().assignments });
  });
  it('selects the exact historical cloud revision while the latest local change is ahead', async () => {
    const value = ledger();
    const changed = structuredClone(data().assignments);
    Object.assign(changed[0].originalPostBackfills![0], { substitutePersonRecordId: replacement.personRecordId, substituteOpenId: replacement.openId, substituteName: replacement.name });
    changed[0].backfillPersonRecordId = replacement.personRecordId;
    value.applications[0].snapshot = { ...value.applications[0].snapshot, assignmentRevision: 1, shiftAssignments: changed };
    value.substituteUpdates = [{ recordId: request().recordId, expectedRevision: 0, revision: 1, previousShiftAssignments: data().assignments, shiftAssignments: changed }];
    await save(value);
    const state = await readLocalLeaveProjection({ ledgerPath });
    expect(resolveLocalLeaveProjection(state, request(0))).toMatchObject({ kind: 'ready', assignments: data().assignments });
    expect(resolveLocalLeaveProjection(state, request(1))).toMatchObject({ kind: 'ready', assignments: changed });
  });
  it('does not read and parse the full ledger again on a stat cache hit', async () => {
    await save(ledger());
    const reads = jest.spyOn(jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises'), 'readFile');
    const first = await readLocalLeaveProjection({ ledgerPath });
    const second = await readLocalLeaveProjection({ ledgerPath });
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(reads.mock.calls.filter(call => call[0] === ledgerPath)).toHaveLength(1);
  });
  it('invalidates the fingerprint after an atomic ledger replacement', async () => {
    await save(ledger());
    const first = await readLocalLeaveProjection({ ledgerPath });
    const value = ledger(); value.applications[0].snapshot.assignmentRevision = 2;
    await fs.writeFile(join(directory, 'replacement.tmp'), JSON.stringify(value), 'utf8');
    await fs.rename(join(directory, 'replacement.tmp'), ledgerPath);
    expect((await readLocalLeaveProjection({ ledgerPath })).fingerprint).not.toBe(first.fingerprint);
  });
  it('deduplicates concurrent cold reads of the same ledger', async () => {
    await save(ledger());
    const reads = jest.spyOn(jest.requireActual<typeof import('node:fs/promises')>('node:fs/promises'), 'readFile');
    const states = await Promise.all([readLocalLeaveProjection({ ledgerPath }), readLocalLeaveProjection({ ledgerPath }), readLocalLeaveProjection({ ledgerPath })]);
    expect(new Set(states.map(state => state.fingerprint)).size).toBe(1);
    expect(reads.mock.calls.filter(call => call[0] === ledgerPath)).toHaveLength(1);
  });
  it('compares matching revision decisions by business identity rather than JSON property order', async () => {
    const value = ledger();
    const reordered = data().assignments.map(assignment => Object.fromEntries(Object.entries(assignment).reverse()));
    value.substituteUpdates = [{ recordId: request().recordId, revision: 0, expectedRevision: -1, shiftAssignments: reordered, previousShiftAssignments: [] }]; await save(value);
    expect(resolveLocalLeaveProjection(await readLocalLeaveProjection({ ledgerPath }), request()).kind).toBe('ready');
  });
  it('isolates a malformed application instead of losing a healthy application', async () => {
    const value = ledger(); const bad = application(); bad.recordId = 'rec_bad_local'; bad.snapshot = { ...bad.snapshot, applicantOpenId: 'invalid' }; value.applications.push(bad); await save(value);
    const state = await readLocalLeaveProjection({ ledgerPath });
    expect(resolveLocalLeaveProjection(state, request()).kind).toBe('ready');
    expect(resolveLocalLeaveProjection(state, { ...request(), recordId: bad.recordId })).toMatchObject({ kind: 'unavailable', reason: expect.any(String) });
  });
  it.each(['missing', 'corrupt'])('fails closed for known two-level data with a %s ledger but preserves historical one-level reading', async mode => {
    if (mode === 'corrupt') await fs.writeFile(ledgerPath, '{invalid', 'utf8');
    const state = await readLocalLeaveProjection({ ledgerPath });
    expect(resolveLocalLeaveProjection(state, request()).kind).toBe('unavailable');
    expect(resolveLocalLeaveProjection(state, { ...request(), requiresOriginalPostMetadata: false, shiftDetails: [] }).kind).toBe('none');
  });
  it('rejects a cloud primary identity conflict even when the display name is unchanged', async () => {
    await save(ledger()); const input = request(); input.shiftDetails[0].substituteOpenId = 'ou_someone_else';
    expect(resolveLocalLeaveProjection(await readLocalLeaveProjection({ ledgerPath }), input).kind).toBe('unavailable');
  });
  it('rejects mismatched applicant identity or backup signature without guessing by name', async () => {
    const value = ledger(); value.applications[0].snapshot.shiftAssignments[0].originalPostSignature = 'a'.repeat(64); await save(value);
    expect(resolveLocalLeaveProjection(await readLocalLeaveProjection({ ledgerPath }), request()).kind).toBe('unavailable');
    await save(ledger());
    expect(resolveLocalLeaveProjection(await readLocalLeaveProjection({ ledgerPath }), { ...request(), leaveStaff: ['同名之外的人'] }).kind).toBe('unavailable');
  });
  it('rejects two contradictory decisions for the same revision', async () => {
    const value = ledger(); const changed = structuredClone(data().assignments); changed[0].substituteOpenId = replacement.openId; changed[0].substitutePersonRecordId = replacement.personRecordId;
    value.substituteUpdates = [{ recordId: request().recordId, revision: 0, expectedRevision: -1, shiftAssignments: changed, previousShiftAssignments: [] }]; await save(value);
    expect(resolveLocalLeaveProjection(await readLocalLeaveProjection({ ledgerPath }), request()).kind).toBe('unavailable');
  });
  it('does not turn a rejected local decision into an approved two-level schedule', async () => {
    const value = ledger(); value.applications[0].status = 'rejected'; value.applications[0].resolvedAction = 'reject'; await save(value);
    expect(resolveLocalLeaveProjection(await readLocalLeaveProjection({ ledgerPath }), request()).kind).toBe('unavailable');
  });
});
