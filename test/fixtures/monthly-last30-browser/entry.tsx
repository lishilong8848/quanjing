import { createRoot } from 'react-dom/client';
import MonthlyOperationsPage from '../../../client/src/pages/MonthlyOperations';
import './styles.css';

const measurements: object[] = [];
document.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button');
  if (button?.textContent?.trim() !== '过去30天') return;
  const start = performance.now();
  const observer = new MutationObserver(() => {
    if (document.querySelector('.mo-period-modes button[aria-pressed="true"]')?.textContent?.trim() !== '过去30天') return;
    observer.disconnect();
    requestAnimationFrame(() => {
      measurements.push({
        elapsedMs: performance.now() - start,
        range: document.querySelector('.mo-recent-range')?.textContent,
        resourcesReady: document.querySelector('.mo-overview-metrics')?.textContent?.includes('1.250') ?? false,
      });
      document.getElementById('measurements')!.textContent = JSON.stringify(measurements);
    });
  });
  observer.observe(document.getElementById('root')!, { subtree: true, childList: true, attributes: true });
}, true);
createRoot(document.getElementById('root')!).render(<MonthlyOperationsPage />);
