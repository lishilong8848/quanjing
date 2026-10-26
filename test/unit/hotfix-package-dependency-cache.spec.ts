import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('hotfix package dependency proof reuse', () => {
  const packager = readFileSync(
    resolve(
      __dirname,
      '../../scripts/create-safe-full-runtime-hotfix-package.ps1',
    ),
    'utf8',
  );
  const transitionGate = packager.match(
    /\$dependencyGateReport = Invoke-NodeJsonGate[\s\S]*?-Label 'Reusable dependency transition gate'/u,
  )?.[0];

  it('passes the per-user app-root proof cache to the prebuild dependency gate', () => {
    expect(packager).toContain(
      "Join-Path $env:LOCALAPPDATA 'NantongSchedule\\dependency-proof-cache'",
    );
    expect(packager).toContain(
      'Assert-PathHasNoReparsePointAncestorsForPackager -Path $dependencyProofCacheDirectory',
    );
    expect(packager).toContain(
      '$applicationRootCacheKey = Get-TextSha256 -Text ([System.IO.Path]::GetFullPath($projectRoot).TrimEnd(\'\\\').ToLowerInvariant())',
    );
    expect(transitionGate).toContain(
      "'--proof-cache', $dependencyProofCachePath",
    );
  });
});
