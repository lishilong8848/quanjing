const mockAttachmentIndexSetter = jest.fn();
const mockPageSetter = jest.fn();
const mockZoomSetter = jest.fn();
const mockDraggingSetter = jest.fn();
const mockStateSetter = jest.fn();
const mockPreviewViewport = {
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
};
const viewerSource = require('node:fs').readFileSync(
  require('node:path').resolve(
    'client/src/pages/ContractManagement/ContractAttachmentViewer.tsx',
  ),
  'utf8',
);
let mockUseStateCall = 0;
let mockZoomValue = 1;
let mockManifestValue: unknown = null;

jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react');
  return {
    ...actual,
    useEffect: jest.fn((effect: () => void | (() => void)) => {
      return effect();
    }),
    useCallback: jest.fn((callback: unknown) => callback),
    useMemo: jest.fn((factory: () => unknown) => factory()),
    useRef: jest.fn((initialValue: unknown) => ({ current: initialValue })),
    useState: jest.fn((initialValue: unknown) => {
      const value =
        typeof initialValue === 'function'
          ? (initialValue as () => unknown)()
          : initialValue;
      const call = mockUseStateCall++;
      if (call === 0) return [0, mockAttachmentIndexSetter];
      if (call === 1) return [1, mockPageSetter];
      if (call === 2) return [mockManifestValue, mockStateSetter];
      if (call === 5) return [mockZoomValue, mockZoomSetter];
      if (call === 6) return [value, mockDraggingSetter];
      return [value, mockStateSetter];
    }),
  };
});

jest.mock(
  '@/api',
  () => ({
    getContractAttachmentDownloadUrl: jest.fn(
      (accessId: string) => `/download/${accessId}`,
    ),
    getContractAttachmentManifest: jest.fn(
      () => new Promise<never>(() => undefined),
    ),
    getContractAttachmentPageUrl: jest.fn(
      (accessId: string, page: number) => `/preview/${accessId}/${page}`,
    ),
  }),
  { virtual: true },
);

jest.mock(
  '@/components/ui/dialog',
  () => ({
    Dialog: ({ children }: { children?: unknown }) => children,
    DialogContent: ({ children }: { children?: unknown }) => children,
    DialogDescription: ({ children }: { children?: unknown }) => children,
    DialogTitle: ({ children }: { children?: unknown }) => children,
  }),
  { virtual: true },
);

jest.mock(
  '@/lib/utils',
  () => ({
    cn: (...values: unknown[]) => values.filter(Boolean).join(' '),
  }),
  { virtual: true },
);

jest.mock(
  'lucide-react',
  () =>
    new Proxy(
      {},
      {
        get: () => () => null,
      },
    ),
);

import { ContractAttachmentViewer } from '../../client/src/pages/ContractManagement/ContractAttachmentViewer';
import {
  DEFAULT_PREVIEW_ZOOM,
  getManifestProcessingPollDelay,
  getManifestRetryDelay,
  MAX_PREVIEW_ZOOM,
  MIN_PREVIEW_ZOOM,
  zoomAfterWheel,
} from '../../client/src/pages/ContractManagement/contract-attachment-viewer.logic';

const contract = {
  code: 'HT-001',
  name: '测试合同',
  attachments: [
    {
      accessId: 'attachment-a',
      name: '合同 A.pdf',
      previewStatus: 'ready',
      pageCount: 2,
    },
    {
      accessId: 'attachment-b',
      name: '合同 B.pdf',
      previewStatus: 'ready',
      pageCount: 5,
    },
  ],
} as any;

function renderViewer(overrides: Record<string, unknown> = {}) {
  mockUseStateCall = 0;
  return ContractAttachmentViewer({
    contract,
    initialAccessId: 'attachment-b',
    initialPage: 3,
    open: true,
    onOpenChange: jest.fn(),
    ...overrides,
  }) as any;
}

function findElement(node: any, predicate: (value: any) => boolean): any {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElement(child, predicate);
      if (match) return match;
    }
    return undefined;
  }
  if (!node || typeof node !== 'object') return undefined;
  if (predicate(node)) return node;
  return findElement(node.props?.children, predicate);
}

describe('ContractAttachmentViewer', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'Image', {
      configurable: true,
      value: class PreviewImage {
        src = '';
      },
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseStateCall = 0;
    mockZoomValue = 1;
    mockManifestValue = null;
  });

  it('stops showing generation and hides unavailable downloads when storage is not configured', () => {
    mockManifestValue = {
      accessId: 'attachment-a',
      name: '合同 A.pdf',
      previewStatus: 'failed',
      pageCount: 0,
      originalAvailable: false,
      unavailableReason: 'storage_not_configured',
    };
    const viewer = renderViewer();
    const message = findElement(
      viewer,
      (node) =>
        node.props?.label === '合同附件暂不可用，请联系管理员恢复存储配置',
    );
    expect(message).toBeDefined();
    expect(message.props.spinning).not.toBe(true);
    expect(
      findElement(
        viewer,
        (node) =>
          node.type === 'a' && node.props?.href === '/download/attachment-a',
      ),
    ).toBeUndefined();
  });

  it('uses the unified administrator session without another password gate', () => {
    expect(viewerSource).not.toContain('getContractAdminStatus');
    expect(viewerSource).not.toContain('loginContractAdmin');
    expect(viewerSource).not.toContain('logoutContractAdmin');
    expect(viewerSource).not.toContain('type="password"');
    expect(viewerSource).toContain('getContractAttachmentDownloadUrl');
    expect(viewerSource).toContain('下载合同原件');
  });

  it('updates the selected attachment label when its manifest becomes ready', () => {
    mockManifestValue = {
      accessId: 'attachment-a',
      name: '合同 A.pdf',
      previewStatus: 'ready',
      pageCount: 2,
    };
    const viewer = renderViewer({
      contract: {
        ...contract,
        attachments: [
          {
            ...contract.attachments[0],
            previewStatus: 'processing',
            pageCount: 0,
          },
        ],
      },
    });
    const selected = findElement(viewer, (node) => node.key === 'attachment-a');
    expect(
      findElement(selected, (node) => node.props?.children === '2 页'),
    ).toBeDefined();
  });

  it('does not accept an old attachment response after switching attachments', async () => {
    const api = jest.requireMock('@/api');
    const react = jest.requireMock('react');
    let finishOld!: (value: unknown) => void;
    const oldRequest = new Promise((resolve) => {
      finishOld = resolve;
    });
    const next = {
      accessId: 'attachment-b',
      name: '合同 B.pdf',
      previewStatus: 'ready',
      pageCount: 5,
    };
    api.getContractAttachmentManifest.mockImplementationOnce(() => oldRequest);
    renderViewer();
    const cleanup = react.useEffect.mock.results.find(
      (result: any) => typeof result.value === 'function',
    ).value;
    cleanup();
    api.getContractAttachmentManifest.mockResolvedValueOnce(next);
    renderViewer({
      contract: { ...contract, attachments: [contract.attachments[1]] },
    });
    await Promise.resolve();
    expect(mockStateSetter).toHaveBeenCalledWith(next);
    const acceptedCalls = mockStateSetter.mock.calls.length;
    finishOld({
      accessId: 'attachment-a',
      previewStatus: 'failed',
      pageCount: 0,
    });
    await Promise.resolve();
    expect(mockStateSetter.mock.calls).toHaveLength(acceptedCalls);
  });

  it('accepts a ready manifest after a transient error and its bounded retry', async () => {
    const api = jest.requireMock('@/api');
    const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const setTimeout = jest.fn();
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { setTimeout },
    });
    try {
      const next = {
        accessId: 'attachment-a',
        name: '合同 A.pdf',
        previewStatus: 'ready',
        pageCount: 2,
      };
      api.getContractAttachmentManifest
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce(next);
      renderViewer();
      await Promise.resolve();
      expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 2_000);
      await setTimeout.mock.calls[0][0]();
      expect(mockStateSetter).toHaveBeenCalledWith(next);
    } finally {
      if (savedWindow) Object.defineProperty(globalThis, 'window', savedWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('falls back to the authenticated COS original and exposes explicit retry actions', () => {
    expect(viewerSource).toContain('getContractAttachmentInlineUrl');
    expect(viewerSource).toContain('originalAvailable');
    expect(viewerSource).toContain('在线显示合同原件');
    expect(viewerSource).toContain('重新读取预览状态');
    expect(viewerSource).toContain('重新加载当前页');
  });

  it('keeps the requested attachment page on first open and clamps it to its page count', () => {
    renderViewer();
    expect(mockAttachmentIndexSetter).toHaveBeenLastCalledWith(1);
    expect(mockPageSetter).toHaveBeenLastCalledWith(3);

    mockPageSetter.mockClear();
    renderViewer({ initialPage: 99 });
    expect(mockPageSetter).toHaveBeenLastCalledWith(5);
  });

  it('honours a changed initial page and the requested page after closing and reopening', () => {
    renderViewer({ initialPage: 2 });
    mockPageSetter.mockClear();
    renderViewer({ initialPage: 4 });
    expect(mockPageSetter).toHaveBeenLastCalledWith(4);

    mockPageSetter.mockClear();
    renderViewer({ open: false, initialPage: 4 });
    mockPageSetter.mockClear();
    renderViewer({ open: true, initialPage: 4 });
    expect(mockPageSetter).toHaveBeenLastCalledWith(4);
  });

  it('resets to page one only when the user manually switches attachments', () => {
    const viewer = renderViewer({
      initialAccessId: 'attachment-a',
      initialPage: 2,
    });
    mockAttachmentIndexSetter.mockClear();
    mockPageSetter.mockClear();
    mockZoomSetter.mockClear();

    const secondAttachment = findElement(
      viewer,
      (element) => element.key === 'attachment-b',
    );
    expect(secondAttachment).toBeDefined();
    secondAttachment.props.onClick();

    expect(mockAttachmentIndexSetter).toHaveBeenCalledWith(1);
    expect(mockPageSetter).toHaveBeenCalledWith(1);
    expect(mockZoomSetter).toHaveBeenCalledWith(DEFAULT_PREVIEW_ZOOM);
  });

  it('fits the complete page inside the viewport at the default zoom', () => {
    const viewer = renderViewer({
      initialAccessId: 'attachment-a',
      initialPage: 1,
    });
    const previewCanvas = findElement(
      viewer,
      (element) => element.props?.['data-contract-preview-canvas'] === 'true',
    );
    const previewImage = findElement(
      viewer,
      (element) => element.type === 'img' && element.props?.draggable === false,
    );

    expect(previewCanvas.props.style).toMatchObject({
      width: '100%',
      height: '100%',
    });
    expect(previewImage.props.className).toContain('object-contain');
  });

  it('zooms with the wheel and prevents background scrolling without changing pages', () => {
    const viewer = renderViewer({
      initialAccessId: 'attachment-a',
      initialPage: 1,
    });
    mockPageSetter.mockClear();
    mockZoomSetter.mockClear();
    const previewViewport = findElement(
      viewer,
      (element) => element.props?.['data-contract-preview-viewport'] === 'true',
    );
    previewViewport.props.ref(mockPreviewViewport);
    const wheelListener = mockPreviewViewport.addEventListener.mock.calls.find(
      ([eventName]) => eventName === 'wheel',
    );
    expect(wheelListener?.[2]).toEqual({ passive: false });
    const preventDefault = jest.fn();

    wheelListener?.[1]({ deltaY: 120, preventDefault });

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(mockPageSetter).not.toHaveBeenCalled();
    expect(mockZoomSetter).toHaveBeenCalledTimes(1);
    expect(mockZoomSetter.mock.calls[0]?.[0](1)).toBe(0.9);
  });

  it('pans an enlarged contract by dragging and stops after pointer release', () => {
    mockZoomValue = 1.5;
    const viewer = renderViewer({
      initialAccessId: 'attachment-a',
      initialPage: 1,
    });
    mockDraggingSetter.mockClear();
    const previewViewport = findElement(
      viewer,
      (element) => element.props?.['data-contract-preview-viewport'] === 'true',
    );
    expect(previewViewport.props.onPointerDown).toEqual(expect.any(Function));
    if (typeof previewViewport.props.onPointerDown !== 'function') return;

    const dragViewport = {
      scrollLeft: 120,
      scrollTop: 80,
      setPointerCapture: jest.fn(),
      releasePointerCapture: jest.fn(),
      hasPointerCapture: jest.fn(() => true),
    };
    const preventDefault = jest.fn();
    previewViewport.props.onPointerDown({
      button: 0,
      pointerId: 7,
      clientX: 400,
      clientY: 300,
      currentTarget: dragViewport,
      preventDefault,
    });
    previewViewport.props.onPointerMove({
      pointerId: 7,
      clientX: 340,
      clientY: 230,
      currentTarget: dragViewport,
      preventDefault,
    });

    expect(dragViewport.setPointerCapture).toHaveBeenCalledWith(7);
    expect(dragViewport.scrollLeft).toBe(180);
    expect(dragViewport.scrollTop).toBe(150);
    expect(mockDraggingSetter).toHaveBeenCalledWith(true);

    previewViewport.props.onPointerUp({
      pointerId: 7,
      currentTarget: dragViewport,
    });
    expect(dragViewport.releasePointerCapture).toHaveBeenCalledWith(7);
    expect(mockDraggingSetter).toHaveBeenLastCalledWith(false);

    previewViewport.props.onPointerMove({
      pointerId: 7,
      clientX: 300,
      clientY: 200,
      currentTarget: dragViewport,
      preventDefault,
    });
    expect(dragViewport.scrollLeft).toBe(180);
    expect(dragViewport.scrollTop).toBe(150);
  });

  it('does not start dragging while the contract is fitted to the viewport', () => {
    const viewer = renderViewer({
      initialAccessId: 'attachment-a',
      initialPage: 1,
    });
    const previewViewport = findElement(
      viewer,
      (element) => element.props?.['data-contract-preview-viewport'] === 'true',
    );
    expect(previewViewport.props.onPointerDown).toEqual(expect.any(Function));
    if (typeof previewViewport.props.onPointerDown !== 'function') return;

    const fittedViewport = {
      scrollLeft: 0,
      scrollTop: 0,
      setPointerCapture: jest.fn(),
    };
    const preventDefault = jest.fn();
    previewViewport.props.onPointerDown({
      button: 0,
      pointerId: 8,
      clientX: 200,
      clientY: 150,
      currentTarget: fittedViewport,
      preventDefault,
    });

    expect(fittedViewport.setPointerCapture).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});

describe('zoomAfterWheel', () => {
  it('zooms in and out in stable ten-percent steps', () => {
    expect(zoomAfterWheel(1, -120)).toBe(1.1);
    expect(zoomAfterWheel(1, 120)).toBe(0.9);
  });

  it('clamps zoom and ignores invalid or negligible wheel input', () => {
    expect(zoomAfterWheel(MAX_PREVIEW_ZOOM, -120)).toBe(MAX_PREVIEW_ZOOM);
    expect(zoomAfterWheel(MIN_PREVIEW_ZOOM, 120)).toBe(MIN_PREVIEW_ZOOM);
    expect(zoomAfterWheel(1, 0.5)).toBe(1);
    expect(zoomAfterWheel(1, Number.NaN)).toBe(1);
  });
});

describe('getManifestRetryDelay', () => {
  it('uses finite automatic retries instead of polling forever after errors', () => {
    expect(getManifestRetryDelay(1)).toBe(2_000);
    expect(getManifestRetryDelay(2)).toBe(5_000);
    expect(getManifestRetryDelay(3)).toBeNull();
  });

  it('stops processing polls after one minute instead of spinning forever', () => {
    expect(getManifestProcessingPollDelay(1)).toBe(5_000);
    expect(getManifestProcessingPollDelay(12)).toBe(5_000);
    expect(getManifestProcessingPollDelay(13)).toBeNull();
  });
});
