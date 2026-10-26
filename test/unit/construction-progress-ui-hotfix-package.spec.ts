import { readFileSync } from 'fs';
import { join } from 'path';

describe('construction progress UI hotfix package', () => {
  const readScript = () =>
    readFileSync(
      join(
        process.cwd(),
        'scripts/create-construction-progress-ui-hotfix-package.ps1',
      ),
      'utf8',
    );

  it('packages the complete compiled client as the only runtime overlay', () => {
    const source = readScript();

    expect(source).toContain("$clientRelativePath = 'dist/client'");
    expect(source).toContain("npm run build:client");
    expect(source).toContain(
      "packageType = 'construction-progress-client-overlay'",
    );
    expect(source).toContain('replaceDirectories = @($clientRelativePath)');
    expect(source).toContain('replaceFiles = @()');
    expect(source).not.toContain('dist/server');
    expect(source).not.toContain('dist/shared');
  });

  it('uses a UTF-8 BOM for Windows PowerShell 5.1 compatibility', () => {
    const source = readScript();

    expect(source.charCodeAt(0)).toBe(0xfeff);
  });

  it('rejects a stale client build without the construction progress fixes', () => {
    const source = readScript();

    expect(source).toContain('Assert-CompiledClientContains');
    expect(source).toContain('每日施工进展');
    expect(source).toContain('当天开工前完成人员核查');
    expect(source).toContain('完成进度');
  });

  it('documents whole-directory replacement and excludes sensitive paths', () => {
    const source = readScript();

    expect(source).toContain('完整替换 `dist/client`');
    expect(source).toContain('Ctrl+F5');
    for (const marker of [
      '.env',
      'node_modules',
      'sourcemaps',
      'data',
      'logs',
      'certs',
      '.map',
      '.ts',
      '.tsx',
      '.spec',
    ]) {
      expect(source).toContain(marker);
    }
  });

  it('creates and verifies the archive with file-level hashes', () => {
    const source = readScript();

    expect(source).toContain('Get-FileHash');
    expect(source).toContain('CreateFromDirectory');
    expect(source).toContain('OpenRead($zipPath)');
    expect(source).toContain("'hotfix-manifest.json'");
    expect(source).toContain(
      "'README_CONSTRUCTION_PROGRESS_UI_HOTFIX.md'",
    );
    expect(source).toContain('$zipPath.sha256.txt');
  });

  it('locks the package to the latest compatible client baseline', () => {
    const source = readScript();

    expect(source).toContain(
      "'purchase-supply-chain-hotfix-20260723-114113.zip'",
    );
    expect(source).toContain(
      "'26284F28600B91105ED3D9BDC027EFD337D63D1CC0F1BBA6A09D2A60DB998BAF'",
    );
    expect(source).toContain(
      'verify-construction-progress-client-baseline.mjs',
    );
    expect(source).toContain('expectedClientFileCount = 88');
    expect(source).toContain('baseline = [ordered]@{');
    expect(source).toContain('semanticDiff');
  });

  it('preserves the compatible baseline entry point after building', () => {
    const source = readScript();

    expect(source).toContain(
      "$clientIndexRelativePath = 'dist/client/index.html'",
    );
    expect(source).toContain('Copy-Item');
    expect(source).toContain(
      "entryPointPolicy = 'baseline-index-preserved'",
    );
    expect(source).toContain('保留兼容基线的 `index.html`');
  });
});
