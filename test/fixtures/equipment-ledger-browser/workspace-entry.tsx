import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import EquipmentLedgerManagement from '../../../client/src/pages/EquipmentLedgerManagement';
import { GlobalNavigation } from '../../../client/src/components/GlobalNavigation';
import { FixtureAccessProvider } from './permission-access';
import './styles.css';

const started = performance.now();
const observer = new MutationObserver(() => {
  const metric = document.querySelector('.equipment-ledger-metrics strong');
  if (!metric || !metric.textContent?.trim()) return;
  document.getElementById('fixture-timing')!.textContent = JSON.stringify({
    firstDataMs: performance.now() - started,
    metric: metric.textContent,
  });
  observer.disconnect();
});
observer.observe(document.getElementById('root')!, {
  subtree: true,
  childList: true,
  characterData: true,
});
const interactions: { action: string; domElapsedMs: number }[] = [];
function measure(event: Event) {
  const element = (event.target as HTMLElement).closest('button,input,select');
  if (!element) return;
  const isRepairList = Boolean(element.closest('.equipment-repair-dialog'));
  const isEntry = Boolean(element.closest('.equipment-repair-card'));
  const isModule = Boolean(element.closest('.equipment-module-nav'));
  if (!isRepairList && !isEntry && !isModule) return;
  const before = document.querySelector(
    '.equipment-repair-device-list',
  )?.textContent;
  const action =
    element.getAttribute('aria-label') ||
    element.textContent?.trim() ||
    'input';
  const start = performance.now();
  const changes = new MutationObserver(() => {
    const changed = isEntry
      ? Boolean(document.querySelector('.equipment-repair-dialog'))
      : isModule
        ? element.getAttribute('aria-current') === 'page'
        : element.tagName === 'BUTTON'
          ? Boolean(document.querySelector('.equipment-history-card'))
          : document.querySelector('.equipment-repair-device-list')
              ?.textContent !== before;
    if (!changed) return;
    changes.disconnect();
    interactions.push({ action, domElapsedMs: performance.now() - start });
    document.getElementById('fixture-interactions')!.textContent =
      JSON.stringify(interactions);
  });
  changes.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  setTimeout(() => changes.disconnect(), 1500);
}
document.addEventListener('click', measure, true);
document.addEventListener('input', measure, true);
document.addEventListener('change', measure, true);
createRoot(document.getElementById('root')!).render(
  <BrowserRouter>
    <label style={{ padding: '.4rem 1rem', display: 'block' }}>
      开发验收场景
      <select
        aria-label="验收场景"
        defaultValue={sessionStorage.getItem('ledger-fixture-mode') || 'normal'}
        onChange={(e) =>
          sessionStorage.setItem('ledger-fixture-mode', e.target.value)
        }
      >
        {['normal', 'error', 'timeout', 'stale'].map((mode) => (
          <option key={mode} value={mode}>
            {mode}
          </option>
        ))}
      </select>
    </label>
    <FixtureAccessProvider>
      <GlobalNavigation />
      <div style={{ paddingTop: '4rem' }}>
        <EquipmentLedgerManagement />
      </div>
    </FixtureAccessProvider>
    <output
      id="fixture-timing"
      style={{ display: 'block', fontSize: '.7rem' }}
    />
    <output
      id="fixture-interactions"
      style={{ display: 'block', fontSize: '.7rem' }}
    />
  </BrowserRouter>,
);
