import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('system monthly report identity UI', () => {
  const pageSource = readFileSync(
    join(
      process.cwd(),
      'client',
      'src',
      'pages',
      'SystemMonthlyReport',
      'index.tsx',
    ),
    'utf8',
  );

  it('gates the dashboard behind the module person session', () => {
    expect(pageSource).toContain('getSystemMonthlyReportIdentitySession');
    expect(pageSource).toContain('<PersonIdentityGate');
    expect(pageSource).toMatch(/if \(!identitySession\?\.selected\)/u);
    expect(pageSource).not.toContain(
      "const WRITE_ROLES = new Set(['admin', 'editor', 'duty_editor'])",
    );
  });

  it('uses server-projected capabilities for package, submit, review and download', () => {
    expect(pageSource).toContain('dashboard?.viewer?.canPackage');
    expect(pageSource).toContain('room.access?.canSubmit');
    expect(pageSource).toContain('getSystemMonthlyReportAuthorizedAction');
    expect(pageSource).toContain('room.access?.canDownload');
  });

  it('clears module tasks when switching person identity', () => {
    expect(pageSource).toContain('clearStoredTaskIds()');
    expect(pageSource).toContain('logoutSystemMonthlyReportIdentity');
  });

  const gateSourcePath = join(
    process.cwd(),
    'client',
    'src',
    'pages',
    'SystemMonthlyReport',
    'PersonIdentityGate.tsx',
  );

  it('provides a compact searchable person selector without technical copy', () => {
    expect(() => readFileSync(gateSourcePath, 'utf8')).not.toThrow();
    const gateSource = readFileSync(gateSourcePath, 'utf8');
    expect(gateSource).toContain('选择人员');
    expect(gateSource).toContain('identity.name');
    expect(gateSource).toContain('fixed inset-0 z-[100]');
    expect(gateSource).not.toMatch(/COS|Open ID|多维表|同步链路/u);
  });
});
