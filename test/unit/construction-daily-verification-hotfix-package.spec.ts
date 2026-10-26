import { readFileSync } from 'fs';
import { join } from 'path';

describe('construction daily verification hotfix package', () => {
  const readPackageScript = () =>
    readFileSync(
      join(
        process.cwd(),
        'scripts/create-construction-daily-verification-hotfix-package.ps1',
      ),
      'utf8',
    );

  it('rebuilds the client from the verified construction UI baseline', () => {
    const source = readPackageScript();

    expect(source).toContain(
      'construction-progress-ui-hotfix-20260723-131315.zip',
    );
    expect(source).toContain(
      '691F1A5382252209D68EDED95849348D80683AE088BDB8EA814634C7094EF059',
    );
    expect(source).toContain(
      "$clientBaselineChunkPath = 'dist/client/chunks/3668.c2fff727.js'",
    );
    expect(source).toContain(
      "$currentClientChunkPath = 'dist/client/chunks/3668.c99500bd.js'",
    );
    expect(source).toContain(
      '$mainSource.Replace($oldMapping, $newMapping)',
    );
    expect(source).toContain(
      'Unexpected client change outside construction chunk',
    );
  });

  it('packages only the two required server runtime files', () => {
    const source = readPackageScript();

    expect(source).toContain(
      'dist/server/modules/duty-schedule/construction-management.js',
    );
    expect(source).toContain(
      'dist/server/modules/duty-schedule/duty-schedule.service.js',
    );
    expect(source).not.toContain('dist/shared/api.interface.js');
    expect(source).not.toContain('dist/server/main.js');
    expect(source).not.toContain("replaceDirectories = @('dist/server')");
  });

  it('locks both baseline and current server hashes', () => {
    const source = readPackageScript();

    for (const hash of [
      '9FC0198D75ABC6CA74C39B4BBB2C8D87C6BE9CBAA0F262DD777FA9179C206DA7',
      'CA66DCD4F54541A3FF3070D6D789BF6E06597CA294E115B16A23A0387943FF59',
      'E61957E374B28341CCD7AC2930A5B09C5E7F513FD8EFD0A534FF738D98153550',
      'F6DBC59C37876145B50F0F04FA6F96CAD6DB3D36183D2AF0AF56F71B50716C7B',
    ]) {
      expect(source).toContain(hash);
    }
  });

  it('adds a manifest, safe installer, readme, and archive checksum', () => {
    const source = readPackageScript();

    expect(source).toContain("'hotfix-manifest.json'");
    expect(source).toContain(
      "'README_CONSTRUCTION_DAILY_VERIFICATION_HOTFIX.md'",
    );
    expect(source).toContain(
      "'apply-construction-daily-verification-hotfix.ps1'",
    );
    expect(source).toContain('$zipPath.sha256.txt');
    expect(source).toContain('Get-ZipEntryHash');
    expect(source).toContain('secretsIncluded = $false');
    expect(source).toContain('dependencyInstallRequired = $false');
  });

  it('excludes source, credentials, data, dependencies, and source maps', () => {
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
