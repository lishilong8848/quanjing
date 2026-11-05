import {
  FEISHU_CARD_BYTE_LIMIT,
  FEISHU_CARD_ELEMENT_LIMIT,
  PurchaseLifecyclePaginationError,
  paginatePurchaseLifecycleCard,
  resolveRequestedPage,
  selectPurchaseLifecycleCardPage,
} from '../../server/modules/purchase-inventory/purchase-lifecycle-pagination';
import type {
  PurchaseLifecycleCardElement,
  PurchaseLifecycleCardPage,
} from '../../server/modules/purchase-inventory/purchase-lifecycle-pagination';

type Card = Record<string, unknown>;

function shell(): Card {
  return {
    schema: '2.0',
    config: { update_multi: true, enable_forward: false },
    header: { title: { tag: 'plain_text', content: '采购全流程' }, template: 'blue' },
    body: { elements: [] as unknown[] },
  };
}

function textElement(content: string, marker?: string): PurchaseLifecycleCardElement {
  const element: PurchaseLifecycleCardElement = {
    tag: 'div',
    text: { tag: 'plain_text', content },
  };
  if (marker !== undefined) element.element_id = marker;
  return element;
}

/**
 * 生成一个元素，使其单独放进指定外壳后，整张卡片的 UTF-8 字节数恰好等于 cardBytes。
 * 用实测基线校准，不手推 JSON 结构开销。
 */
function elementFittingCardBytes(shellCard: Card, cardBytes: number): PurchaseLifecycleCardElement {
  const base = textElement('', 'e1');
  const baseline = bytesOf({ ...shellCard, body: { elements: [base] } } as Card);
  const fill = cardBytes - baseline;
  if (fill < 0) throw new Error('目标字节数过小');
  return textElement('x'.repeat(fill), 'e1');
}

function bytesOf(card: Card): number {
  return Buffer.byteLength(JSON.stringify(card), 'utf8');
}

function elementsOf(card: Card): PurchaseLifecycleCardElement[] {
  const body = card.body as { elements: PurchaseLifecycleCardElement[] };
  return body.elements;
}

function markers(pages: Array<PurchaseLifecycleCardPage<Card>>): string[] {
  return pages.flatMap(page => elementsOf(page.card).map(element => String(element.element_id)));
}

function expectPaginationError(run: () => unknown, code: string): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(PurchaseLifecyclePaginationError);
    expect((error as PurchaseLifecyclePaginationError).code).toBe(code);
    return;
  }
  throw new Error(`期望抛出 ${code}`);
}

test.each(['__proto__', 'constructor', 'prototype'])(
  'rejects unsafe pagination path segment %s',
  segment => {
    expectPaginationError(() => paginatePurchaseLifecycleCard({ shell: shell(), elements: [], elementsPath: [segment, 'elements'] }), 'INVALID_INPUT');
  },
);

test('reserves byte and component capacity for navigation controls', () => {
  const base = shell();
  const element = elementFittingCardBytes(base, FEISHU_CARD_BYTE_LIMIT - 5);
  expect(paginatePurchaseLifecycleCard({ shell: base, elements: [element] })).toHaveLength(1);
  expectPaginationError(() => paginatePurchaseLifecycleCard({ shell: base, elements: [element], reservedBytes: 5 }), 'ELEMENT_TOO_LARGE');
  expectPaginationError(() => paginatePurchaseLifecycleCard({ shell: base, elements: [], reservedComponents: FEISHU_CARD_ELEMENT_LIMIT }), 'SHELL_TOO_LARGE');
  expectPaginationError(() => paginatePurchaseLifecycleCard({ shell: base, elements: [], reservedBytes: -1 }), 'INVALID_INPUT');
});

function componentCount(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + componentCount(item), 0);
  return 1 + Object.keys(value).reduce<number>((sum, key) => sum + componentCount((value as Card)[key]), 0);
}

describe('paginatePurchaseLifecycleCard', () => {
  it('保留调用方顺序并逐页装入外壳', () => {
    const elements = Array.from({ length: 5 }, (_, index) => textElement(`记录${index + 1}`, `r${index + 1}`));
    const pages = paginatePurchaseLifecycleCard({ shell: shell(), elements });

    expect(pages).toHaveLength(1);
    expect(pages[0].card.header).toEqual({ title: { tag: 'plain_text', content: '采购全流程' }, template: 'blue' });
    expect(elementsOf(pages[0].card)).toEqual(elements);
    expect(pages[0].pageInfo).toEqual({
      page: 1,
      pageSize: 5,
      totalPages: 1,
      totalElements: 5,
      hasPrevious: false,
      hasNext: false,
    });
  });

  it('按 200 组件上限切分且跨页顺序稳定、不丢元素', () => {
    // 单元素仅占 1 个组件、字节很小，让 200 组件上限先于 30 KiB 生效。
    const elements = Array.from({ length: 450 }, (_, index) => ({ tag: 'div', index }));
    const pages = paginatePurchaseLifecycleCard({ shell: shell(), elements });

    // 外壳自身 5 个组件，每页还能放 194 个元素（总共 199 个组件）。
    expect(pages).toHaveLength(3);
    expect(pages.map(page => page.pageInfo.pageSize)).toEqual([194, 194, 62]);
    for (const page of pages) {
      expect(elementsOf(page.card).length).toBeLessThanOrEqual(194);
      expect(componentCount(page.card)).toBeLessThan(FEISHU_CARD_ELEMENT_LIMIT);
      expect(bytesOf(page.card)).toBeLessThan(FEISHU_CARD_BYTE_LIMIT);
    }
    expect(pages.flatMap(page => elementsOf(page.card)))
      .toEqual(elements);
    expect(pages.map(page => [page.pageInfo.page, page.pageInfo.totalPages, page.pageInfo.hasPrevious, page.pageInfo.hasNext]))
      .toEqual([[1, 3, false, true], [2, 3, true, true], [3, 3, true, false]]);
    expect(pages.every(page => page.pageInfo.totalElements === 450)).toBe(true);
  });

  it('按 UTF-8 字节切分并严格小于 30 KiB', () => {
    // 每个元素约 1 KiB 中文文本（中文 3 字节），单页必然只能放下部分元素。
    const elements = Array.from({ length: 60 }, (_, index) => textElement('采购'.repeat(170), `r${index}`));
    const pages = paginatePurchaseLifecycleCard({ shell: shell(), elements });

    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) expect(bytesOf(page.card)).toBeLessThan(FEISHU_CARD_BYTE_LIMIT);
    expect(markers(pages)).toEqual(elements.map((_, index) => `r${index}`));
    // 每页本应尽量填满：除最后一页外，再加一个元素就会超限。
    for (const page of pages.slice(0, -1)) {
      expect(elementsOf(page.card).length).toBeGreaterThan(0);
      const oversized = { ...page.card, body: { elements: [...elementsOf(page.card), elements[0]] } };
      expect(bytesOf(oversized as Card)).toBeGreaterThanOrEqual(FEISHU_CARD_BYTE_LIMIT);
    }
  });

  it('恰好等于 30 KiB 视为超限，少 1 字节即可放入', () => {
    const exact = elementFittingCardBytes(shell(), FEISHU_CARD_BYTE_LIMIT);
    expect(bytesOf({ ...shell(), body: { elements: [exact] } } as Card)).toBe(FEISHU_CARD_BYTE_LIMIT);
    expectPaginationError(
      () => paginatePurchaseLifecycleCard({ shell: shell(), elements: [exact] }),
      'ELEMENT_TOO_LARGE',
    );

    const fits = elementFittingCardBytes(shell(), FEISHU_CARD_BYTE_LIMIT - 1);
    const pages = paginatePurchaseLifecycleCard({ shell: shell(), elements: [fits, textElement('后续', 'r2')] });
    expect(pages).toHaveLength(2);
    expect(bytesOf(pages[0].card)).toBe(FEISHU_CARD_BYTE_LIMIT - 1);
    expect(markers(pages)).toEqual(['e1', 'r2']);
  });

  it('组件总数绝不超过 199，外壳占满 200 时拒绝', () => {
    // 外壳基础组件数 = schema + config + header.title + body，再叠加 header.extra 个组件。
    const shellBase = componentCount(shell());
    const shellWith = (extra: number): Card => ({
      ...shell(),
      header: { title: { tag: 'plain_text', content: '采购' }, extra: Array.from({ length: extra }, (_, index) => ({ tag: 'div', index })) },
    });
    // 外壳已占 195 个组件，只剩 4 个名额。
    const shellComponents = FEISHU_CARD_ELEMENT_LIMIT - 5;
    const elements = Array.from({ length: 10 }, (_, index) => ({ tag: 'div', index }));

    const split = paginatePurchaseLifecycleCard({ shell: shellWith(shellComponents - shellBase), elements });
    expect(split.length).toBeGreaterThan(1);
    for (const page of split) {
      expect(componentCount(page.card)).toBeLessThan(FEISHU_CARD_ELEMENT_LIMIT);
      expect(bytesOf(page.card)).toBeLessThan(FEISHU_CARD_BYTE_LIMIT);
      expect(elementsOf(page.card).length).toBeLessThanOrEqual(4);
    }
    // 每页都可再放 1 个元素前，必须已经顶到某个上限；且元素齐全、顺序不变。
    expect(split.flatMap(page => elementsOf(page.card))).toEqual(elements);
    expect(split[0]).toBeDefined();
    expect(componentCount(split[0].card)).toBeGreaterThan(FEISHU_CARD_ELEMENT_LIMIT - 5);

    // 外壳自身就占满 200 个名额时直接拒绝。
    expectPaginationError(
      () => paginatePurchaseLifecycleCard({
        shell: shellWith(FEISHU_CARD_ELEMENT_LIMIT - shellBase),
        elements: [{ tag: 'div' }],
      }),
      'SHELL_TOO_LARGE',
    );
  });

  it('空内容产出单张可发送的空卡片', () => {
    const pages = paginatePurchaseLifecycleCard({ shell: shell(), elements: [] });
    expect(pages).toHaveLength(1);
    expect(elementsOf(pages[0].card)).toEqual([]);
    expect(pages[0].pageInfo).toEqual({ page: 1, pageSize: 0, totalPages: 1, totalElements: 0, hasPrevious: false, hasNext: false });
    expect(bytesOf(pages[0].card)).toBeLessThan(FEISHU_CARD_BYTE_LIMIT);
  });

  it('单个元素自身无法放入时明确报错并指出位置', () => {
    const huge = textElement('超大'.repeat(9000), 'huge');
    let message = '';
    try {
      paginatePurchaseLifecycleCard({ shell: shell(), elements: [textElement('正常', 'r1'), huge] });
      throw new Error('未抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(PurchaseLifecyclePaginationError);
      expect((error as PurchaseLifecyclePaginationError).code).toBe('ELEMENT_TOO_LARGE');
      message = (error as Error).message;
    }
    expect(message).toContain('第 2 个');
  });

  it('外壳自身超限时拒绝分页', () => {
    const bulky = { ...shell(), note: { tag: 'div', text: { tag: 'plain_text', content: 'x'.repeat(31 * 1024) } } };
    expectPaginationError(() => paginatePurchaseLifecycleCard({ shell: bulky, elements: [textElement('r', 'r1')] }), 'SHELL_TOO_LARGE');
  });

  it('不修改调用方入参且返回卡片与原外壳无共享引用', () => {
    const original = shell();
    const snapshot = JSON.stringify(original);
    const elements = [textElement('记录', 'r1')];
    const pages = paginatePurchaseLifecycleCard({ shell: original, elements });

    expect(JSON.stringify(original)).toBe(snapshot);

    elementsOf(pages[0].card).push(textElement('被篡改', 'x1'));
    (pages[0].card.header as Card).template = 'red';
    expect(elementsOf(original)).toEqual([]);
    expect((original.header as Card).template).toBe('blue');

    const again = paginatePurchaseLifecycleCard({ shell: original, elements });
    expect(elementsOf(again[0].card)).toHaveLength(1);
  });

  it('结果只含调用方提供的元素，不注入任何额外内容', () => {
    const elements = [textElement('记录A', 'r1'), textElement('记录B', 'r2')];
    const pages = paginatePurchaseLifecycleCard({ shell: shell(), elements });
    const serialized = JSON.stringify(pages.map(page => page.card));

    expect(elementsOf(pages[0].card)).toEqual(elements);
    expect(serialized).not.toMatch(/https?:\/\/|token|image_key|file_key|open_id/iu);
    // 卡片结构只能来自外壳本身（schema/config/header/body）。
    expect(Object.keys(pages[0].card).sort()).toEqual(['body', 'config', 'header', 'schema']);
  });

  it('相同输入产生相同输出（纯函数、顺序稳定）', () => {
    const elements = Array.from({ length: 300 }, (_, index) => textElement(`记录${index}`, `r${index}`));
    const first = paginatePurchaseLifecycleCard({ shell: shell(), elements });
    const second = paginatePurchaseLifecycleCard({ shell: shell(), elements });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('支持自定义元素写入路径', () => {
    const pages = paginatePurchaseLifecycleCard({
      shell: { schema: '2.0', header: { title: { tag: 'plain_text', content: '采购' } } },
      elements: [textElement('记录', 'r1')],
      elementsPath: ['body', 'elements'],
    });
    expect(elementsOf(pages[0].card)).toHaveLength(1);
  });

  it('大数据量（5000 元素）不丢元素且耗时有界', () => {
    // 每个元素较大，让 30 KiB 字节上限先于 200 组件上限生效：单页约 100 个元素，共约 57 页。
    const elements = Array.from({ length: 5000 }, (_, index) => textElement('记'.repeat(90), `r${index}`));
    const startedAt = Date.now();
    const pages = paginatePurchaseLifecycleCard({ shell: shell(), elements });
    const elapsed = Date.now() - startedAt;

    expect(pages.length).toBeGreaterThan(50);
    expect(markers(pages)).toEqual(elements.map((_, index) => `r${index}`));
    for (const page of pages) expect(bytesOf(page.card)).toBeLessThan(FEISHU_CARD_BYTE_LIMIT);
    // 每页都应是能放下的最大前缀：除最后一页外，再加一个元素必然超限。
    for (const page of pages.slice(0, -1)) {
      const next = elementsOf(page.card).length;
      const oversized = { ...shell(), body: { elements: [...elementsOf(page.card), elements[next]] } } as Card;
      expect(bytesOf(oversized)).toBeGreaterThanOrEqual(FEISHU_CARD_BYTE_LIMIT);
    }
    // 纯本地分组，二分查找不应出现逐个数重序列化的退化。
    expect(elapsed).toBeLessThan(3000);
  });

  it('拒绝非法入参', () => {
    expectPaginationError(() => {
      const bad = { tag: 'div', fn: () => 1 };
      return paginatePurchaseLifecycleCard({ shell: shell(), elements: [bad as unknown as PurchaseLifecycleCardElement] });
    }, 'INVALID_INPUT');
    expectPaginationError(() => {
      const cyclic: Card = { tag: 'div' };
      cyclic.self = cyclic;
      return paginatePurchaseLifecycleCard({ shell: shell(), elements: [cyclic] });
    }, 'INVALID_INPUT');
    expectPaginationError(
      () => paginatePurchaseLifecycleCard({ shell: shell(), elements: [textElement('r')], elementsPath: ['header', 'title', 'content'] }),
      'INVALID_PATH',
    );
  });
});

describe('resolveRequestedPage', () => {
  it('接受合法页码（数字与规范数字串）', () => {
    expect(resolveRequestedPage(1, 3)).toBe(1);
    expect(resolveRequestedPage(3, 3)).toBe(3);
    expect(resolveRequestedPage('2', 3)).toBe(2);
  });

  it.each([
    ['0', 3],
    [-1, 3],
    [4, 3],
    ['4', 3],
    ['0', 3],
    ['-1', 3],
    [1.5, 3],
    ['1.5', 3],
    [' 1', 3],
    ['1 ', 3],
    ['01', 3],
    ['+1', 3],
    ['1e0', 3],
    ['', 3],
    ['abc', 3],
    [Number.NaN, 3],
    [Number.POSITIVE_INFINITY, 3],
    [null, 3],
    [undefined, 3],
    [true, 3],
    [{ page: 1 }, 3],
    [[1], 3],
    ['999999999999999999999', 3],
  ])('拒绝伪造或越界页码 %p', (requested, totalPages) => {
    expectPaginationError(() => resolveRequestedPage(requested, totalPages), 'INVALID_PAGE');
  });

  it('总页数非法时拒绝', () => {
    expectPaginationError(() => resolveRequestedPage(1, 0), 'INVALID_INPUT');
    expectPaginationError(() => resolveRequestedPage(1, 1.5), 'INVALID_INPUT');
  });
});

describe('selectPurchaseLifecycleCardPage', () => {
  it('按合法页码取出对应页', () => {
    const elements = Array.from({ length: 450 }, (_, index) => ({ tag: 'div', index }));
    const pages = paginatePurchaseLifecycleCard({ shell: shell(), elements });
    const second = selectPurchaseLifecycleCardPage(pages, 2);
    expect(second.pageInfo.page).toBe(2);
    expect(elementsOf(second.card)[0]).toEqual(elements[pages[0].pageInfo.pageSize]);
    expect(selectPurchaseLifecycleCardPage(pages, '3').pageInfo.page).toBe(3);
  });

  it('拒绝用户伪造的页码且不静默夹取', () => {
    const pages = paginatePurchaseLifecycleCard({ shell: shell(), elements: [textElement('r', 'r1')] });
    expectPaginationError(() => selectPurchaseLifecycleCardPage(pages, 2), 'INVALID_PAGE');
    expectPaginationError(() => selectPurchaseLifecycleCardPage(pages, '0'), 'INVALID_PAGE');
    expectPaginationError(() => selectPurchaseLifecycleCardPage(pages, 'x'), 'INVALID_PAGE');
    expectPaginationError(() => selectPurchaseLifecycleCardPage([], 1), 'INVALID_INPUT');
  });
});
