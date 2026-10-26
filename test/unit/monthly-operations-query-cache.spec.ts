import {
  createMonthlyQuery,
  type QueryRange,
} from '../../client/src/pages/MonthlyOperations/query-cache';
const range = { start: '2026-09-01', end: '2026-09-30' };
type Data = { range: QueryRange; records: number[]; status: string };
const data = (r = range, status = 'ready'): Data => ({
  range: r,
  records: [1, 2],
  status,
});
const validate = (d: Data, r: QueryRange) =>
  !!d &&
  d.range.start === r.start &&
  d.range.end === r.end &&
  d.status !== 'error';
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function memoryStorage(): Storage {
  const rows = new Map<string, string>();
  return {
    get length() {
      return rows.size;
    },
    key: (i) => [...rows.keys()][i] ?? null,
    getItem: (k) => rows.get(k) ?? null,
    setItem: (k, v) => {
      rows.set(k, v);
    },
    removeItem: (k) => {
      rows.delete(k);
    },
    clear: () => rows.clear(),
  };
}
describe('月览缓存先呈现与请求协调', () => {
  beforeEach(() =>
    jest.useFakeTimers().setSystemTime(new Date('2026-09-14T00:00:00Z')),
  );
  afterEach(() => jest.useRealTimers());
  it('预取和点击共用请求；缓存同步可读，重复切换无额外请求', async () => {
    const first = deferred<Data>(),
      fetch = jest.fn(() => first.promise),
      notify = jest.fn();
    const query = createMonthlyQuery({
      name: 'events',
      fetch,
      validate,
      storage: () => undefined,
    });
    const off = query.subscribe(range, notify);
    const a = query.load(range),
      b = query.load(range);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
    first.resolve(data());
    await a;
    expect(query.read(range)).toMatchObject({
      data: data(),
      loading: false,
      error: '',
    });
    await query.load(range);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(query.read(range)).toBe(query.read(range));
    expect(notify).toHaveBeenCalledTimes(2);
    off();
  });
  it('周期键隔离，旧响应晚到不会覆盖当前周期', async () => {
    const other = { start: '2026-08-01', end: '2026-08-31' },
      slow = deferred<Data>();
    const fetch = jest.fn((r: QueryRange) =>
      r === range ? slow.promise : Promise.resolve(data(r)),
    );
    const query = createMonthlyQuery({ name: 'changes', fetch, validate });
    const old = query.load(range);
    await query.load(other);
    slow.resolve(data());
    await old;
    expect(query.read(other).data?.range).toEqual(other);
    expect(query.read(range).data?.range).toEqual(range);
  });
  it('自动后台刷新失败保留成功数据且不误报，显式重试失败仍提示', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(data())
      .mockRejectedValueOnce(Error('timeout'))
      .mockResolvedValueOnce({ ...data(), status: 'error' })
      .mockResolvedValueOnce({ ...data(), records: [3] });
    const query = createMonthlyQuery<Data>({ name: 'events', fetch, validate });
    await query.load(range);
    await jest.advanceTimersByTimeAsync(300001);
    await query.load(range);
    expect(query.read(range)).toMatchObject({
      loading: false,
      data: data(),
      error: '',
    });
    await query.load(range, true);
    expect(query.read(range)).toMatchObject({
      loading: false,
      data: data(),
      error: '读取失败或超时，请重试',
    });
    await query.load(range, true);
    expect(query.read(range)).toMatchObject({
      error: '',
      data: { records: [3] },
    });
  });
  it('游客刷新绕过本地缓存，但不发送服务端强制刷新请求', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce(data(range, 'updating'))
      .mockResolvedValueOnce({ ...data(), records: [3] });
    const query = createMonthlyQuery<Data>({
      name: 'resources',
      fetch,
      validate,
      updating: (d) => d.status === 'updating',
    });
    await query.load(range, false, false);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenLastCalledWith(range, false);
    await query.load(range, true, false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenLastCalledWith(range, false);
    expect(query.read(range)).toMatchObject({
      data: { records: [3] },
      loading: false,
      error: '',
    });
  });
  it('过期服务端快照先发布，后台只追一次刷新，不产生无限循环', async () => {
    const latest = deferred<Data>(),
      fetch = jest
        .fn()
        .mockResolvedValueOnce(data(range, 'updating'))
        .mockReturnValueOnce(latest.promise);
    const query = createMonthlyQuery<Data>({
      name: 'events',
      fetch,
      validate,
      updating: (d) => d.status === 'updating',
    });
    const task = query.load(range);
    await Promise.resolve();
    await Promise.resolve();
    expect(query.read(range)).toMatchObject({
      data: data(range, 'updating'),
      loading: false,
    });
    expect(fetch).toHaveBeenLastCalledWith(range, true);
    latest.resolve(data(range, 'stale'));
    await task;
    expect(query.read(range)).toMatchObject({
      data: data(range, 'stale'),
      loading: false,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('服务端快照可用时，后台追更失败不覆盖为整页读取失败', async () => {
    const query = createMonthlyQuery<Data>({
      name: 'maintenance',
      fetch: jest
        .fn()
        .mockResolvedValueOnce(data(range, 'updating'))
        .mockRejectedValueOnce(Error('temporary refresh failure')),
      validate,
      updating: (d) => d.status === 'updating',
    });
    await query.load(range);
    expect(query.read(range)).toMatchObject({
      data: data(range, 'updating'),
      loading: false,
      error: '',
    });
  });
  it('标签页刷新立即恢复缓存，五分钟后后台更新；损坏、过期或存储禁用可降级', async () => {
    const storage = memoryStorage(),
      fetch = jest.fn().mockResolvedValue(data());
    const options = { name: 'events', fetch, validate, storage: () => storage };
    const original = createMonthlyQuery<Data>(options);
    await original.load(range);
    await jest.advanceTimersByTimeAsync(1);
    const reload = createMonthlyQuery<Data>(options);
    expect(reload.read(range).data).toEqual(data());
    await reload.load(range);
    expect(fetch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(300001);
    const stale = createMonthlyQuery<Data>(options);
    expect(stale.read(range)).toMatchObject({ data: data(), loading: true });
    await stale.load(range);
    expect(fetch).toHaveBeenCalledTimes(2);
    storage.setItem('monthly-read:v1:events:2026-09-01:2026-09-30', 'broken');
    expect(createMonthlyQuery<Data>(options).read(range).data).toBeNull();
    storage.setItem(
      'monthly-read:v1:events:2026-09-01:2026-09-30',
      JSON.stringify({ at: Date.now() - 7 * 3600000, data: data() }),
    );
    expect(createMonthlyQuery<Data>(options).read(range).data).toBeNull();
    const unavailable = createMonthlyQuery<Data>({
      ...options,
      storage: () => {
        throw Error('disabled');
      },
    });
    await unavailable.load(range);
    await jest.advanceTimersByTimeAsync(1);
    expect(unavailable.read(range).data).toEqual(data());
  });
  it('持久缓存按源限制两个周期，不触碰其他系统数据', async () => {
    const storage = memoryStorage();
    storage.setItem('other-app', 'keep');
    const query = createMonthlyQuery<Data>({
      name: 'events',
      fetch: async (r) => data(r),
      validate,
      storage: () => storage,
    });
    for (const month of ['06', '07', '08', '09']) {
      await query.load({ start: `2026-${month}-01`, end: `2026-${month}-28` });
      await jest.advanceTimersByTimeAsync(1);
    }
    expect(storage.length).toBe(3);
    expect(storage.getItem('other-app')).toBe('keep');
  });
});
