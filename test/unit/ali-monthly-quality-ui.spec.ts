import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

describe('Ali monthly quality rating UI', () => {
  test('uses a small orchestrator with separate rating and evidence components', () => {
    const source = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityView.tsx',
    );

    expect(source).toContain('buildAliMonthlyQualityView');
    expect(source).toContain('selectMonthlyQualityIssues');
    expect(source).toContain('AliMonthlyQualityRatingOverview');
    expect(source).toContain('AliMonthlyQualityEvidencePanel');
    expect(source).toContain('<AliMonthlyQualityRatingOverview');
    expect(source).toContain('<AliMonthlyQualityEvidencePanel');
  });

  test('renders ratings before issues and never derives benchmarks from issue counts', () => {
    const source = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityRatingOverview.tsx',
    );

    expect(source).toContain('月度评级结论');
    expect(source).toContain('A+标杆');
    expect(source).toContain('评级覆盖');
    expect(source).toContain('待关注');
    expect(source).toContain('环比改善');
    expect(source).toContain('楼栋月度评级');
    expect(source).toContain('月度标杆榜');
    expect(source).toContain('本月标杆梯队');
    expect(source).toContain('楼栋排名');
    expect(source).toContain('quality-leadership-tier');
    expect(source).toContain('quality-ranking-list');
    expect(source).toContain('评级优先 · 问题数次之');
    expect(source).toContain('月度评级矩阵');
    expect(source).toContain('楼栋评级走势');
    expect(source).toContain('标杆');
    expect(source).toContain('累计 A+');
    expect(source).not.toContain('问题最少');
    expect(source).not.toContain('未覆盖不参与标杆');
  });

  test('provides accessible rating card and matrix drill-down controls', () => {
    const source = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityRatingOverview.tsx',
    );

    expect(source).toContain(
      'aria-label={`查看${building.building}${building.grade ||',
    );
    expect(source).toContain(
      'aria-label={`查看${row.year}${row.month}${cell.building}',
    );
    expect(source).toContain('type="button"');
    expect(source).toContain('onOpenBuilding');
    expect(source).toContain('onSelectRating');
  });

  test('opens a cached building detail dialog from cards and rankings', () => {
    const viewSource = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityView.tsx',
    );
    const overviewSource = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityRatingOverview.tsx',
    );
    const dialogSource = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityBuildingDialog.tsx',
    );

    expect(viewSource).toContain('AliMonthlyQualityBuildingDialog');
    expect(viewSource).toContain('detailBuilding');
    expect(viewSource).toContain('onOpenBuilding={openBuildingDetail}');
    expect(viewSource).toContain('setSelectedBuilding(building)');
    expect(overviewSource).toContain(
      'onClick={() => onOpenBuilding(building.building)}',
    );
    expect(dialogSource).toContain('楼栋质量详情');
    expect(dialogSource).toContain('近月评级');
    expect(dialogSource).toContain('当月问题记录');
    expect(dialogSource).toContain('onOpenIssue');
    expect(dialogSource).toContain('当前楼栋当月暂无问题记录');
  });

  test('switches all building trends locally and explains the chart', () => {
    const source = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityRatingOverview.tsx',
    );
    const css = read(
      'client/src/pages/RiskInspectionDashboard/ali-monthly-quality.css',
    );

    expect(source).toContain('buildMonthlyQualityTrendSummary');
    expect(source).toContain('quality-trend-building-switcher');
    expect(source).toContain('quality-trend-summary');
    expect(source).toContain('aria-live="polite"');
    expect(source).toContain('选择楼栋评级走势');
    expect(source).toContain(
      'onClick={() => onSelectBuilding(building.building)}',
    );
    expect(css).toContain('.quality-trend-building-switcher');
    expect(css).toContain('.quality-trend-summary');
  });

  test('presents issues as evidence and shows zero records without denying rating coverage', () => {
    const source = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityEvidencePanel.tsx',
    );
    const previewSource = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityImagePreviewDialog.tsx',
    );

    expect(source).toContain('问题依据');
    expect(source).toContain('检查项目构成');
    expect(source).toContain('楼栋问题记录');
    expect(source).toContain('现场影像');
    expect(source).toContain('<img');
    expect(source).toContain('formatMonthlyQualityImageTitle');
    expect(source).toContain('AliMonthlyQualityImagePreviewDialog');
    expect(previewSource).toContain('quality-image-preview-dialog');
    expect(source).toContain('setPreviewIndex');
    expect(source).not.toContain('<small>{evidence.name}</small>');
    expect(source).toContain('涉及人员');
    expect(source).toContain('完整问题清单');
    expect(source).toMatch(/issueCount === 0\s*\? '0条记录'/u);
    expect(source).not.toContain("issueCount === 0 ? '未覆盖'");
    expect(source).toContain('当前筛选结果暂无问题');
  });

  test('shows every issue source field in list and detail dialogs', () => {
    const listSource = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityListDialog.tsx',
    );
    const detailSource = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityIssueDialog.tsx',
    );

    expect(listSource).toContain('当前筛选结果暂无问题');
    expect(listSource).toContain('问题补充描述');
    expect(listSource).toContain('涉及人员');
    expect(listSource).toContain('附件/图片');
    expect(detailSource).toContain('月份');
    expect(detailSource).toContain('检查项目');
    expect(detailSource).toContain('楼栋');
    expect(detailSource).toContain('问题补充描述');
    expect(detailSource).toContain('涉及人员');
    expect(detailSource).toContain('附件');
    expect(detailSource).toContain('问题图片');
    expect(detailSource).toContain('quality-evidence-preview');
    expect(detailSource).toContain('<img');
    expect(detailSource).toContain('AliMonthlyQualityImagePreviewDialog');
  });

  test('uses semantic grade tokens, responsive grids and reduced motion', () => {
    const source = read(
      'client/src/pages/RiskInspectionDashboard/AliMonthlyQualityView.tsx',
    );
    const css = read(
      'client/src/pages/RiskInspectionDashboard/ali-monthly-quality.css',
    );

    expect(source).toContain("import './ali-monthly-quality.css'");
    expect(css).toContain('--grade-aplus');
    expect(css).toContain('--grade-a');
    expect(css).toContain('--grade-bplus');
    expect(css).toContain('--grade-bminus');
    expect(css).toContain('.quality-rating-rail');
    expect(css).toContain('.quality-leadership-tier');
    expect(css).toContain('.quality-ranking-list');
    expect(css).toContain('.quality-image-preview-dialog');
    expect(css).toContain('repeat(7, minmax(0, 1fr))');
    expect(css).toContain('@media (max-width: 1200px)');
    expect(css).toContain('@media (max-width: 720px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
  });
});
