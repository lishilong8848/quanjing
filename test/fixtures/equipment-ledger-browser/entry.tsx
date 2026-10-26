import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { LedgerPage } from '../../../client/src/pages/EquipmentLedgerManagement';
import './styles.css';

const measurements: {
  action: string;
  elapsedMs: number;
  domElapsedMs?: number;
  passed: boolean;
}[] = [];
document.addEventListener(
  'click',
  (event) => {
    const target = (event.target as HTMLElement).closest('button');
    if (!target) return;
    const label = target.textContent?.trim() || '';
    let check: (() => boolean) | undefined;
    if (label === '总览' || /^[A-E]楼$/u.test(label))
      check = () => target.getAttribute('aria-current') === 'page';
    else if (target.getAttribute('aria-haspopup') === 'dialog')
      check = () => Boolean(document.querySelector('[role="dialog"]'));
    if (!check) return;
    const started = performance.now();
    let domElapsedMs: number | undefined;
    const observer = new MutationObserver(() => {
      if (!check!()) return;
      domElapsedMs = Math.round((performance.now() - started) * 100) / 100;
      observer.disconnect();
    });
    observer.observe(document.getElementById('root')!, {
      subtree: true,
      childList: true,
      attributes: true,
    });
    const measure = () => {
      if (check!() || performance.now() - started > 1000) {
        observer.disconnect();
        measurements.push({
          action: label,
          elapsedMs: Math.round((performance.now() - started) * 100) / 100,
          domElapsedMs,
          passed: check!(),
        });
        document.getElementById('fixture-measurements')!.textContent =
          JSON.stringify(measurements);
      } else requestAnimationFrame(measure);
    };
    requestAnimationFrame(measure);
  },
  true,
);
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <div
      style={{
        padding: '.4rem 1rem',
        background: '#e5ebf7',
        fontSize: '.75rem',
        display: 'flex',
        gap: '1rem',
        alignItems: 'center',
      }}
    >
      <strong>
        开发验收 ·{' '}
        {document.documentElement.dataset.ledgerSource === 'snapshot'
          ? '2026-10-01真实台账快照'
          : '代表性设备数据'}
      </strong>
      <select
        aria-label="验收场景"
        defaultValue={sessionStorage.getItem('ledger-fixture-mode') || 'normal'}
        onChange={(event) =>
          sessionStorage.setItem('ledger-fixture-mode', event.target.value)
        }
      >
        {[
          'normal',
          'error',
          'timeout',
          'late',
          'stale',
          'cold',
          'cold-error',
          'hang',
        ].map((mode) => (
          <option key={mode} value={mode}>
            {mode}
          </option>
        ))}
      </select>
    </div>
    <LedgerPage canForceRefresh readTiming={{ pollMs: 200, maxWaitMs: 5000 }} />
    <output
      id="fixture-measurements"
      style={{ display: 'block', fontSize: '.65rem', overflowWrap: 'anywhere' }}
    />
  </BrowserRouter>,
);
