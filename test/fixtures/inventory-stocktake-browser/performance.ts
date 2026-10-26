// Test-only event-to-next-paint measurements. No telemetry or production imports.
const results: { action: string; elapsedMs: number; passed: boolean }[] = [];
document.addEventListener(
  'click',
  (event) => {
    const target = (event.target as HTMLElement).closest('button');
    if (!target) return;
    const label = target.textContent?.trim() || '';
    const row = target.closest('article');
    let check: (() => boolean) | undefined;
    if (
      ['全部', '待盘', '已盘', '差异', '盘盈', '盘亏', '一致'].includes(
        label,
      ) &&
      target.closest('.stocktake-filter')
    )
      check = () => target.getAttribute('aria-pressed') === 'true';
    else if (label === '一键确认')
      check = () => !!document.querySelector('[role="dialog"]');
    else if (label === '确认本楼全部条目')
      check = () =>
        target.textContent?.includes('正在确认') === true ||
        !!document.querySelector('[role="dialog"] [role="alert"]');
    else if (label === '返回库存管理')
      check = () =>
        !document.querySelector('button[aria-label="返回库存预警与盘点"]');
    else if (['重点抽盘', '库存核盘'].includes(label))
      check = () =>
        document
          .querySelector('.stocktake-scope-nav button[aria-current="page"]')
          ?.textContent?.trim() === label;
    else if (['暂存', '确认'].includes(label) && row)
      check = () =>
        row.textContent?.includes('保存中') === true ||
        !!row.querySelector('[role="alert"]');
    else if (label === '生成本月清单')
      check = () =>
        target.textContent?.includes('提交中') === true ||
        document.body.textContent?.includes('正在生成 ·') === true ||
        !!document.querySelector('.stocktake-generation[role="alert"]');
    else if (/^[AB]楼/.test(label) && target.closest('[aria-label="盘点楼栋"]'))
      check = () => target.getAttribute('aria-pressed') === 'true';
    else if (target.closest('[role="dialog"]') && /[AB]楼.*项/.test(label))
      check = () => !document.querySelector('[role="dialog"]');
    if (!check) return;
    const started = performance.now();
    const measure = () => {
      const elapsedMs = performance.now() - started;
      if (check!() || elapsedMs > 1000) {
        results.push({
          action: label,
          elapsedMs: Math.round(elapsedMs * 100) / 100,
          passed: check!(),
        });
        const output = document.getElementById('fixture-performance');
        if (output) output.textContent = JSON.stringify(results);
      } else requestAnimationFrame(measure);
    };
    requestAnimationFrame(measure);
  },
  true,
);
