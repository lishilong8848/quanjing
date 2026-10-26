import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SYSTEM_MONTHLY_REPORT_IDENTITY_TTL_MS,
  SystemMonthlyReportIdentityStore,
} from './system-monthly-report-identity.store';

describe('system monthly report identity store', () => {
  let directory = '';
  let filePath = '';

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'system-monthly-identity-'));
    filePath = join(directory, 'sessions.json');
  });

  afterEach(() => rmSync(directory, { recursive: true, force: true }));

  it('persists only the token digest and resolves the opaque session', () => {
    const store = new SystemMonthlyReportIdentityStore(filePath);
    const issued = store.issue('person_1234567890abcdef', 1_000);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(issued.expiresAt).toBe(
      1_000 + SYSTEM_MONTHLY_REPORT_IDENTITY_TTL_MS,
    );
    expect(store.resolve(issued.token, 1_001)).toMatchObject({
      personId: 'person_1234567890abcdef',
      principalFingerprint: expect.stringMatching(/^smr-person:[a-f0-9]{32}$/u),
    });
    const persisted = readFileSync(filePath, 'utf8');
    expect(persisted).not.toContain(issued.token);
    expect(persisted).not.toContain('open_id');
  });

  it('expires and revokes a session without accepting malformed tokens', () => {
    const store = new SystemMonthlyReportIdentityStore(filePath);
    const issued = store.issue('person_1234567890abcdef', 2_000);

    expect(store.resolve('not-a-token', 2_001)).toBeNull();
    expect(
      store.resolve(
        issued.token,
        2_000 + SYSTEM_MONTHLY_REPORT_IDENTITY_TTL_MS,
      ),
    ).toBeNull();

    const active = store.issue('person_1234567890abcdef', 3_000);
    expect(store.revoke(active.token)).toBe(true);
    expect(store.resolve(active.token, 3_001)).toBeNull();
  });

  it('loads valid sessions after a process restart', () => {
    const first = new SystemMonthlyReportIdentityStore(filePath);
    const issued = first.issue('person_1234567890abcdef', 4_000);
    const second = new SystemMonthlyReportIdentityStore(filePath);

    expect(second.resolve(issued.token, 4_001)?.personId).toBe(
      'person_1234567890abcdef',
    );
  });

  it('keeps one stable principal across sessions and exposes legacy aliases', () => {
    const store = new SystemMonthlyReportIdentityStore(filePath);
    const first = store.issue('person_1234567890abcdef', 5_000);
    const second = store.issue('person_1234567890abcdef', 5_001);
    const other = store.issue('person_fedcba0987654321', 5_002);

    expect(second.principalFingerprint).toBe(first.principalFingerprint);
    expect(other.principalFingerprint).not.toBe(first.principalFingerprint);
    expect(store.resolve(second.token, 5_003)).toMatchObject({
      principalFingerprint: first.principalFingerprint,
      legacyPrincipalFingerprints: [
        expect.stringMatching(/^smr-person:[a-f0-9]{32}$/u),
        expect.stringMatching(/^smr-person:[a-f0-9]{32}$/u),
      ],
    });
  });
});
