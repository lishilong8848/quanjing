import { readFileSync } from 'fs';
import { join } from 'path';

const styles = readFileSync(
  join(process.cwd(), 'client/src/pages/TodayOperationsPanorama/styles.css'),
  'utf8',
);

describe('今日航图告警摘要布局', () => {
  it('桌面两排展示七张卡，避免七列压缩关键数字', () => {
    expect(styles).toMatch(
      /\.today-panorama-alarm-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\);/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-alarm-kpi-grid\s+\.today-panorama-kpi-card:nth-child\(-n\s*\+\s*3\)\s*\{[^}]*grid-column:\s*span 4;/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-alarm-kpi-grid\s+\.today-panorama-kpi-card:nth-child\(n\s*\+\s*4\)\s*\{[^}]*grid-column:\s*span 3;/s,
    );
  });

  it('告警卡片标题和数值不截断，窄屏恢复自然列宽', () => {
    expect(styles).toMatch(
      /\.today-panorama-alarm-kpi-grid\s+\.today-panorama-kpi-title\s*>\s*span:first-child\s*\{[^}]*white-space:\s*normal;/s,
    );
    expect(styles).toMatch(
      /\.today-panorama-alarm-kpi-grid\s+\.today-panorama-kpi-value\s+strong\s*\{[^}]*overflow:\s*visible;/s,
    );
    expect(styles).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.today-panorama-alarm-kpi-grid\s+\.today-panorama-kpi-card\s*\{[^}]*grid-column:\s*auto;/s,
    );
  });
});
