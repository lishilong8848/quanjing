import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(__dirname, '../..');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('contract OCR removal', () => {
  it('removes OCR, payment-term extraction and difference confirmation from active code', () => {
    const activeSource = [
      'client/src/pages/ContractManagement/index.tsx',
      'client/src/api/index.ts',
      'shared/contract-management.interface.ts',
      'server/modules/contract-management/contract-management.controller.ts',
      'server/modules/contract-management/contract-management.module.ts',
      'server/modules/contract-management/contract-attachment-storage.service.ts',
      'deploy/start.ps1',
      'scripts/create-migration-package.ps1',
      '.env.example',
    ]
      .map(read)
      .join('\n');

    for (const removed of [
      'payment-differences',
      'confirmContractPaymentDifference',
      'PaymentDifferenceReviewDialog',
      'PaymentDifferenceDetailsDialog',
      'extract-contract-terms.py',
      'rapidocr',
      'onnxruntime',
      'ocrQueue',
      'processOcr',
      'CONTRACT_OCR_',
    ]) {
      expect(activeSource.toLowerCase()).not.toContain(removed.toLowerCase());
    }
  });

  it('preserves encrypted COS storage and watermarked online preview', () => {
    const storageSource = read(
      'server/modules/contract-management/contract-attachment-storage.service.ts',
    );
    const pageSource = read('client/src/pages/ContractManagement/index.tsx');

    expect(storageSource).toContain('cos.putObject');
    expect(storageSource).toContain('encryptContractBuffer');
    expect(storageSource).toContain('render-contract-pdf.py');
    expect(storageSource).toContain('getPreviewPage');
    expect(storageSource).toContain('getOriginal');
    expect(pageSource).toContain('ContractAttachmentViewer');
  });
});
