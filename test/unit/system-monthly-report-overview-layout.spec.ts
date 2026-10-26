import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('system monthly report overview layout', () => {
  const source = readFileSync(
    join(
      process.cwd(),
      'client',
      'src',
      'pages',
      'SystemMonthlyReport',
      'OverviewDashboard.tsx',
    ),
    'utf8',
  );

  it('switches to the compact three-column dashboard before the 2xl breakpoint', () => {
    expect(source).toContain('data-testid="monthly-overview-primary-grid"');
    expect(source).toContain(
      'min-[1100px]:grid-cols-[240px_minmax(0,1fr)_290px]',
    );
    expect(source).not.toContain(
      'gap-4 2xl:grid-cols-[320px_minmax(0,1fr)_390px]',
    );
  });

  it('keeps the detail table and history cards side by side on common desktop widths', () => {
    expect(source).toContain('data-testid="monthly-overview-detail-grid"');
    expect(source).toContain('min-[1100px]:grid-cols-[minmax(0,1fr)_360px]');
    expect(source).toContain('md:grid-cols-2 xl:grid-cols-1');
  });

  it('uses compact chart heights instead of full-width presentation panels', () => {
    expect(source).toContain('relative mx-auto block h-44 w-full');
    expect(source).toContain(
      '<CardContent className="h-52 px-2 pb-2 pt-0 md:px-4">',
    );
    expect(source).toContain('<CardContent className="h-28 px-2 pb-2 pt-0">');
  });

  it('renders every room leader instead of only the first person', () => {
    expect(source).toContain(
      "room.leaders.map((item) => item.name).join('、')",
    );
  });

  it('shows a completed room as archived instead of waiting for progress', () => {
    expect(source).toMatch(/room\.status\s*===\s*'completed'\s*\?\s*'已归档'/);
  });

  it('renders actionable personal todos instead of a global stage-only drilldown', () => {
    expect(source).toContain(
      'data-testid="system-monthly-report-personal-todos"',
    );
    expect(source).toContain('个人待办');
    expect(source).toContain('<TableHead>待办项目</TableHead>');
    expect(source).toContain('<TableHead>处理状态</TableHead>');
    expect(source).toContain('handleTodoAction(item.room)');
    expect(source).toContain("['accepted', 'syncing'].includes(task.status)");
    expect(source).toContain('当前没有需要你处理的月报任务');
  });

  it('offers one-click packaging and attachment preview from the overview', () => {
    const pageSource = readFileSync(
      join(
        process.cwd(),
        'client',
        'src',
        'pages',
        'SystemMonthlyReport',
        'index.tsx',
      ),
      'utf8',
    );
    const viewerSource = readFileSync(
      join(
        process.cwd(),
        'client',
        'src',
        'pages',
        'SystemMonthlyReport',
        'FinalReportAttachmentViewer.tsx',
      ),
      'utf8',
    );

    expect(source).toContain('一键打包并发送');
    expect(pageSource).toContain('startOneClickPackage');
    expect(pageSource).not.toContain('<AlertTitle>审核口径提醒</AlertTitle>');
    expect(viewerSource).toContain('在线预览');
    expect(viewerSource).toContain('下载附件');
    expect(viewerSource).toContain("preview?.kind === 'pdf'");
    expect(viewerSource).toContain("preview?.kind === 'spreadsheet'");
  });
});
