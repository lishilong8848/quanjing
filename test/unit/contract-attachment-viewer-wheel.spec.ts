import {
  MAX_PREVIEW_ZOOM,
  MIN_PREVIEW_ZOOM,
  zoomAfterWheel,
} from '../../client/src/pages/ContractManagement/contract-attachment-viewer.logic';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('contract attachment viewer wheel zoom', () => {
  it('zooms in or out in the wheel direction', () => {
    expect(zoomAfterWheel(1, -120)).toBe(1.1);
    expect(zoomAfterWheel(1, 120)).toBe(0.9);
  });

  it('stays inside the minimum and maximum zoom', () => {
    expect(zoomAfterWheel(MIN_PREVIEW_ZOOM, 120)).toBe(MIN_PREVIEW_ZOOM);
    expect(zoomAfterWheel(MAX_PREVIEW_ZOOM, -120)).toBe(MAX_PREVIEW_ZOOM);
  });

  it('ignores tiny or invalid scroll input', () => {
    expect(zoomAfterWheel(1, 0.5)).toBe(1);
    expect(zoomAfterWheel(1, Number.NaN)).toBe(1);
  });

  it('keeps the reader viewport large and the zoom hint visible', () => {
    const source = readFileSync(
      resolve(
        __dirname,
        '../../client/src/pages/ContractManagement/ContractAttachmentViewer.tsx',
      ),
      'utf8',
    );
    expect(source).toContain('h-[96dvh]');
    expect(source).toContain('max-w-[1600px]');
    expect(source).toContain("addEventListener('wheel'");
    expect(source).toContain('passive: false');
    expect(source).toContain('data-contract-preview-canvas="true"');
    expect(source).toContain('滚轮缩放');
    expect(source).not.toContain('滚轮上下翻页');
  });
});
