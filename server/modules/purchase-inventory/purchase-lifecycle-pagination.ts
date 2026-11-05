/**
 * 采购全流程卡片的本地纯分页辅助函数。
 *
 * 只做一件事：把“调用方已授权”的卡片元素按飞书单卡上限切成若干页，
 * 并为每页套上调用方提供的固定卡片外壳与导航元数据。
 *
 * 安全边界：
 * - 不做鉴权判断，也不推断授权；输入是什么元素就只输出这些元素，绝不新增内容。
 * - 不访问网络、文件、环境变量、时钟或随机数，相同输入必须得到相同输出。
 * - 页码由用户提交，属于不可信输入，必须严格校验后才会被使用。
 *
 * 飞书单卡硬性上限（取严格上限，等于上限值即视为超限）：
 * - 序列化后 UTF-8 字节数 < 30 KiB（30 * 1024 字节）
 * - 单卡元素数量、递归展开后的组件数量均 < 200
 */

export const FEISHU_CARD_BYTE_LIMIT = 30 * 1024;
export const FEISHU_CARD_ELEMENT_LIMIT = 200;

type JsonObject = Record<string, unknown>;

/** 与飞书卡片元素同构的 JSON 值。 */
export type PurchaseLifecycleCardElement = JsonObject;

export interface PurchaseLifecycleCardPaginationInput<TShell extends JsonObject> {
  /** 调用方已完成授权的元素，按期望展示顺序传入。 */
  elements: ReadonlyArray<PurchaseLifecycleCardElement>;
  /** 固定卡片外壳，body.elements 会被替换为本页元素。 */
  shell: TShell;
  /** 元素写入外壳的路径，默认 ['body', 'elements']。 */
  elementsPath?: ReadonlyArray<string>;
  /** Space reserved for the navigation controls added after page selection. */
  reservedBytes?: number;
  reservedComponents?: number;
}

export interface PurchaseLifecyclePageInfo {
  /** 当前页码，从 1 开始。 */
  page: number;
  pageSize: number;
  totalPages: number;
  totalElements: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export interface PurchaseLifecycleCardPage<TShell extends JsonObject> {
  card: TShell;
  pageInfo: PurchaseLifecyclePageInfo;
}

export class PurchaseLifecyclePaginationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PurchaseLifecyclePaginationError';
    this.code = code;
  }
}

const DEFAULT_ELEMENTS_PATH: ReadonlyArray<string> = ['body', 'elements'];
const CANONICAL_NUMBER = /^(?:0|[1-9]\d{0,8})$/u;

function fail(code: string, message: string): never {
  throw new PurchaseLifecyclePaginationError(code, message);
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * 判定纯 JSON 对象。
 * 不能用 `proto === Object.prototype` 判断：Jest vm、worker、iframe 等不同 realm 里的
 * 普通对象原型并不是当前 realm 的 Object.prototype，会被误判成非法输入。
 * 这里用构造函数来源判断，只放行当前 realm 或跨 realm 的原生 Object / null 原型，
 * 仍拒绝 Date、Map、类实例等。
 */
function isPlainObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (Object.prototype.toString.call(value) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  if (proto === null) return true;
  const ctor = (proto as { constructor?: unknown }).constructor;
  return typeof ctor === 'function' && ctor.name === 'Object';
}

/** 外壳、路径与元素一律只接受纯 JSON，避免函数、类实例、循环引用或非有限数值混入结果。 */
function assertJsonValue(value: unknown, label: string, seen: Set<object> = new Set()): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_INPUT', `${label} 含非有限数值`);
    return;
  }
  if (typeof value !== 'object') fail('INVALID_INPUT', `${label} 含非 JSON 值`);
  if (seen.has(value)) fail('INVALID_INPUT', `${label} 含循环引用`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, label, seen);
  } else {
    if (!isPlainObject(value)) fail('INVALID_INPUT', `${label} 含非纯对象`);
    for (const key of Object.keys(value)) {
      const entry = (value as JsonObject)[key];
      if (entry === undefined) fail('INVALID_INPUT', `${label} 含 undefined 字段`);
      assertJsonValue(entry, label, seen);
    }
  }
  seen.delete(value);
}

function resolvePath(path: ReadonlyArray<string>): ReadonlyArray<string> {
  if (!Array.isArray(path) || path.length === 0) fail('INVALID_INPUT', '元素写入路径无效');
  for (const key of path) {
    if (typeof key !== 'string' || key.length === 0 || ['__proto__', 'prototype', 'constructor'].includes(key)) fail('INVALID_INPUT', '元素写入路径无效');
  }
  return path;
}

/**
 * 递归复制外壳并沿 path 定位容器；若中间节点缺失或为 null 则补空对象。
 * 结果与输入完全不共享引用，调用方无法通过改返回值污染原外壳。
 */
function cloneShellWithElements(
  shell: JsonObject,
  path: ReadonlyArray<string>,
  leafCreator: (parent: JsonObject) => unknown,
): JsonObject {
  const clone = structuredClone(shell) as JsonObject;
  let cursor: JsonObject = clone;
  for (const key of path.slice(0, -1)) {
    const next = Object.hasOwn(cursor, key) ? cursor[key] : undefined;
    if (next === null || next === undefined) {
      const created: JsonObject = {};
      cursor[key] = created;
      cursor = created;
      continue;
    }
    if (!isPlainObject(next)) fail('INVALID_PATH', '外壳中的元素写入路径已被非对象值占用');
    cursor = next;
  }
  const leafKey = path[path.length - 1];
  if (Object.hasOwn(cursor, leafKey) && cursor[leafKey] !== null && cursor[leafKey] !== undefined && !Array.isArray(cursor[leafKey])) {
    fail('INVALID_PATH', '外壳中的元素写入路径已被非数组值占用');
  }
  cursor[leafKey] = leafCreator(cursor);
  return clone;
}

function countComponents(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countComponents(item), 0);
  let total = 1;
  for (const key of Object.keys(value)) total += countComponents((value as JsonObject)[key]);
  return total;
}

interface PageCandidate<TShell extends JsonObject> {
  card: TShell;
  bytes: number;
  components: number;
}

function createCandidate<TShell extends JsonObject>(
  shell: TShell,
  path: ReadonlyArray<string>,
  elements: ReadonlyArray<PurchaseLifecycleCardElement>,
): PageCandidate<TShell> {
  const card = cloneShellWithElements(shell, path, () => elements.map(element => structuredClone(element))) as TShell;
  const serialized = JSON.stringify(card);
  if (typeof serialized !== 'string') fail('INVALID_INPUT', '卡片无法序列化');
  return { card, bytes: byteLength(serialized), components: countComponents(card) };
}

function fitsBudget(candidate: PageCandidate<JsonObject>, reservedBytes: number, reservedComponents: number): boolean {
  // 严格小于上限：等于 30 KiB 或等于 200 个组件都视为超限。
  return candidate.bytes + reservedBytes < FEISHU_CARD_BYTE_LIMIT && candidate.components + reservedComponents < FEISHU_CARD_ELEMENT_LIMIT;
}

/**
 * 对已授权元素做稳定分组分页。
 * 返回每页的完整卡片与导航信息，顺序与输入一致且不丢任何元素。
 */
export function paginatePurchaseLifecycleCard<TShell extends JsonObject>(
  input: PurchaseLifecycleCardPaginationInput<TShell>,
): Array<PurchaseLifecycleCardPage<TShell>> {
  if (!isPlainObject(input)) fail('INVALID_INPUT', '分页入参无效');
  const { elements, shell } = input;
  const reservedBytes = input.reservedBytes ?? 0;
  const reservedComponents = input.reservedComponents ?? 0;
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0 || !Number.isSafeInteger(reservedComponents) || reservedComponents < 0) fail('INVALID_INPUT', '分页预留空间无效');
  if (!isPlainObject(shell)) fail('INVALID_INPUT', '卡片外壳必须是纯对象');
  if (!Array.isArray(elements)) fail('INVALID_INPUT', '卡片元素必须是数组');
  const path = resolvePath(input.elementsPath ?? DEFAULT_ELEMENTS_PATH);
  assertJsonValue(shell, '卡片外壳');
  for (const element of elements) {
    assertJsonValue(element, '卡片元素');
    if (!isPlainObject(element)) fail('INVALID_INPUT', '卡片元素必须是纯对象');
  }

  // 外壳自带元素同样占用元素总额度，必须先算清楚。
  const emptyCandidate = createCandidate(shell, path, []);
  const shellComponentCount = countComponents(emptyCandidate.card);
  if (shellComponentCount + reservedComponents >= FEISHU_CARD_ELEMENT_LIMIT) {
    fail('SHELL_TOO_LARGE', '卡片外壳自身已占用 200 个组件名额，无法分页');
  }
  if (emptyCandidate.bytes + reservedBytes >= FEISHU_CARD_BYTE_LIMIT) {
    fail('SHELL_TOO_LARGE', '卡片外壳自身已超过 30 KiB，无法分页');
  }

  const pages: Array<PurchaseLifecycleCardPage<TShell>> = [];
  let start = 0;

  if (elements.length === 0) {
    // 空内容仍产出一页，保证调用方总能拿到可发送的卡片。
    const pageInfo = buildPageInfo(1, 0, 1, 0);
    return [{ card: emptyCandidate.card, pageInfo }];
  }

  while (start < elements.length) {
    const remaining = elements.length - start;
    const maxTake = Math.min(remaining, FEISHU_CARD_ELEMENT_LIMIT - shellComponentCount - reservedComponents);
    if (maxTake < 1) fail('SHELL_TOO_LARGE', '卡片外壳自身已占用 200 个组件名额，无法分页');

    // 字节数随元素数量单调不减，用二分找能放下的最大前缀；避免逐个数重序列化导致的大数据量卡顿。
    let low = 1;
    let high = maxTake;
    let chosen: PageCandidate<TShell> | undefined;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      const probe = createCandidate(shell, path, elements.slice(start, start + mid));
      if (fitsBudget(probe, reservedBytes, reservedComponents)) {
        chosen = probe;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    if (!chosen) {
      fail(
        'ELEMENT_TOO_LARGE',
        `第 ${start + 1} 个卡片元素自身无法放入 30 KiB / 200 组件限制`,
      );
    }
    const take = high;
    pages.push({ card: chosen.card, pageInfo: buildPageInfo(pages.length + 1, take, 0, elements.length) });
    start += take;
  }

  const totalPages = pages.length;
  return pages.map((page, index) =>
    ({
      card: page.card,
      pageInfo: buildPageInfo(index + 1, page.pageInfo.pageSize, totalPages, elements.length),
    }),
  );
}

function buildPageInfo(page: number, pageSize: number, totalPages: number, totalElements: number): PurchaseLifecyclePageInfo {
  return {
    page,
    pageSize,
    totalPages,
    totalElements,
    hasPrevious: page > 1,
    hasNext: page < totalPages,
  };
}

/**
 * 解析调用方/用户提交的页码。只接受 1..totalPages 的纯数字，其余一律拒绝。
 * 伪造、越界、小数、负数、前后空格、空串、指数写法都不会被“纠正”后接受。
 */
export function resolveRequestedPage(requested: unknown, totalPages: number): number {
  if (!Number.isInteger(totalPages) || totalPages < 1) fail('INVALID_INPUT', '总页数无效');
  let candidate: number;
  if (typeof requested === 'number') {
    candidate = requested;
  } else if (typeof requested === 'string' && CANONICAL_NUMBER.test(requested)) {
    candidate = Number(requested);
  } else {
    fail('INVALID_PAGE', '页码无效');
  }
  if (!Number.isInteger(candidate) || candidate < 1 || candidate > totalPages) {
    fail('INVALID_PAGE', '页码超出范围');
  }
  return candidate;
}

/** 取得指定页；页码非法时抛出错误，不做静默夹取。 */
export function selectPurchaseLifecycleCardPage<TShell extends JsonObject>(
  pages: ReadonlyArray<PurchaseLifecycleCardPage<TShell>>,
  requested: unknown,
): PurchaseLifecycleCardPage<TShell> {
  if (!Array.isArray(pages) || pages.length === 0) fail('INVALID_INPUT', '分页结果为空');
  const page = resolveRequestedPage(requested, pages.length);
  const selected = pages[page - 1];
  if (!selected) fail('INVALID_PAGE', '页码超出范围');
  return selected;
}
