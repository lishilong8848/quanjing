import { readFileSync } from 'fs';
import { join } from 'path';

describe('construction work-type submit hotfix package', () => {
  const readPackageScript = () =>
    readFileSync(
      join(
        process.cwd(),
        'scripts/create-construction-work-type-submit-hotfix-package.ps1',
      ),
      'utf8',
    );

  it('locks the required daily-verification baseline and compiled runtime', () => {
    const source = readPackageScript();

    for (const marker of [
      'construction-daily-verification-hotfix-20260723-175514.zip',
      '6B4EB59BF9DC0C5B255981A93368D3F0156164B1D4E7455120C8EC026A314C95',
      'F6DBC59C37876145B50F0F04FA6F96CAD6DB3D36183D2AF0AF56F71B50716C7B',
      'C09B2FF48C14565A27BC8BE8F563A8A59952DEB03C37A175265A29BB55555F85',
    ]) {
      expect(source).toContain(marker);
    }
  });

  it('packages only the corrected duty schedule service runtime', () => {
    const source = readPackageScript();

    expect(source).toContain(
      "'dist/server/modules/duty-schedule/duty-schedule.service.js'",
    );
    expect(source).not.toContain(
      'dist/server/modules/duty-schedule/construction-management.js',
    );
    expect(source).not.toContain('dist/client');
    expect(source).not.toContain('dist/server/main.js');
  });

  it('verifies the compiled multiline normalization behavior', () => {
    const source = readPackageScript();

    expect(source).toContain('fingerprintText');
    expect(source).toContain('extractDisplayText');
    expect(source).toContain('fingerprintValue');
  });

  it('adds deployment guidance, a manifest, and archive checksum', () => {
    const source = readPackageScript();

    expect(source).toContain("'hotfix-manifest.json'");
    expect(source).toContain(
      "'README_CONSTRUCTION_WORK_TYPE_SUBMIT_HOTFIX.md'",
    );
    expect(source).toContain('$zipPath.sha256.txt');
    expect(source).toContain('secretsIncluded = $false');
    expect(source).toContain('dependencyInstallRequired = $false');
  });

  it('rejects credentials, source files, source maps, and runtime data', () => {
    const source = readPackageScript();

    for (const marker of [
      '.env',
      'node_modules',
      'data',
      'logs',
      'certs',
      'sourcemaps',
      'package-lock.json',
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).toContain('\\.(map|ts|tsx|d\\.ts|spec|log|pem|key)$');
  });
});
