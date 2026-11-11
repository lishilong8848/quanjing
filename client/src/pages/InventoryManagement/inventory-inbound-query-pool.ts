/** Limit concurrent recovery reads without letting a slow business task starve later tasks. */
export function createInventoryInboundQueryPool(limit = 2) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(query: () => Promise<T>): Promise<T> {
    await new Promise<void>((resolve) => {
      const acquire = () => { active++; resolve(); };
      if (active < limit) acquire(); else waiting.push(acquire);
    });
    try { return await query(); }
    finally { active--; waiting.shift()?.(); }
  };
}
