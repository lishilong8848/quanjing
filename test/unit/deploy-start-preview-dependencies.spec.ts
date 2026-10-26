import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('contract preview dependency deployment', () => {
  const startScript = readFileSync(
    resolve(__dirname, '../../deploy/start.ps1'),
    'utf8',
  );
  const installer = readFileSync(
    resolve(__dirname, '../../scripts/install-contract-preview-python-deps.ps1'),
    'utf8',
  );
  const requirements = readFileSync(
    resolve(__dirname, '../../scripts/requirements-contract-preview.txt'),
    'utf8',
  );
  const packager = readFileSync(
    resolve(__dirname, '../../scripts/create-migration-package.ps1'),
    'utf8',
  );

  it('installs only the PDF preview runtime', () => {
    expect(requirements).toContain('PyMuPDF');
    expect(requirements).toContain('Pillow');
    expect(requirements.toLowerCase()).not.toContain('rapidocr');
    expect(requirements.toLowerCase()).not.toContain('onnxruntime');
    expect(requirements.toLowerCase()).not.toContain('numpy');
    expect(installer).toContain('import fitz; from PIL import Image');
  });

  it('gates preview work on a non-blocking background installer', () => {
    const dependencyBlock = startScript.slice(
      startScript.indexOf('function Ensure-ContractPreviewDependencies'),
      startScript.indexOf('function Get-BrowserCommand'),
    );

    expect(dependencyBlock).toContain('System.Diagnostics.ProcessStartInfo');
    expect(dependencyBlock).toContain('CreateNoWindow = $true');
    expect(dependencyBlock).toContain('CONTRACT_PREVIEW_READY_FILE');
    expect(dependencyBlock).toContain('contract-preview-install.running');
    expect(dependencyBlock).toContain('[System.IO.FileMode]::CreateNew');
  });

  it('ships preview scripts and excludes term extraction from migration packages', () => {
    expect(packager).toContain('render-contract-pdf.py');
    expect(packager).toContain('requirements-contract-preview.txt');
    expect(packager).toContain('install-contract-preview-python-deps.ps1');
    expect(packager).not.toContain('extract-contract-terms.py');
  });
});
