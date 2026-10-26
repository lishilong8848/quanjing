import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const projectRoot = process.cwd();
const dialogFiles = [
  'client/src/pages/SystemMonthlyReport/index.tsx',
  'client/src/pages/SystemMonthlyReport/MonthlyPackageDialog.tsx',
  'client/src/pages/SystemMonthlyReport/OverviewDashboard.tsx',
  'client/src/pages/SystemMonthlyReport/ReviewOpinionsView.tsx',
  'client/src/pages/SystemMonthlyReport/ReviewWorkbench.tsx',
  'client/src/pages/SystemMonthlyReport/SubmissionDialog.tsx',
  'client/src/pages/SystemMonthlyReport/SubmissionLauncherDialog.tsx',
  'client/src/pages/SystemMonthlyReport/FinalReportAttachmentViewer.tsx',
];

describe('system monthly report dialog copy', () => {
  const sources = dialogFiles.map((file) => ({
    file,
    source: readFileSync(join(projectRoot, file), 'utf8'),
  }));

  it('keeps every dialog and sheet description visually hidden', () => {
    const descriptions = sources.flatMap(({ file, source }) =>
      [...source.matchAll(/<(?:Dialog|Sheet)Description\b([^>]*)>/gu)].map(
        (match) => ({ file, attributes: match[1] }),
      ),
    );

    expect(descriptions.length).toBeGreaterThanOrEqual(7);
    expect(
      descriptions.filter(
        ({ attributes }) => !/className=["']sr-only["']/u.test(attributes),
      ),
    ).toEqual([]);
  });

  it('does not expose implementation or obvious-operation explanations in windows', () => {
    const combined = sources.map(({ source }) => source).join('\n');
    expect(combined).not.toContain('图片从 COS 临时签名地址读取');
    expect(combined).not.toContain(
      '展示该月份全部机房，状态、数量和图表使用同一数据口径',
    );
    expect(combined).not.toContain('选择月份后，从 COS 汇总该月各机房终版');
    expect(combined).not.toContain('选择机房后按当前阶段提交对应版本');
    expect(combined).not.toContain('附件由飞书多维表权限控制');
    expect(combined).not.toContain('正在从 COS 汇总终版附件');
    expect(combined).not.toContain('可关闭弹窗，后台任务不会中断');
    expect(combined).not.toContain('飞书 / COS');
    expect(combined).not.toContain('COS 对象存储');
    expect(combined).not.toContain(
      '记录已写入飞书收集表，版本附件已保存至 COS',
    );
    expect(combined).not.toContain('重试后台同步');
    expect(combined).not.toContain('COS 状态');
    expect(combined).not.toContain('终版附件归档（COS）');
    expect(combined).not.toContain('飞书数据源暂时不可用');
    expect(combined).not.toContain('人员字段来自稳定 Open ID 关联');
  });

  it('records the concise-window-copy rule in the project development rules', () => {
    const agents = readFileSync(join(projectRoot, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('弹窗与抽屉文案克制');
    expect(agents).toContain('禁止展示技术实现、存储位置、接口来源');
    expect(agents).toContain('禁止复述标题或解释显而易见的操作');
  });

  it('shows the 150 MB report limit and uses validated business error copy', () => {
    const submission = sources.find(({ file }) =>
      file.endsWith('SubmissionDialog.tsx'),
    )?.source;

    expect(submission).toContain('最大 150 MB');
    expect(submission).toContain('validateSystemMonthlyReportUploadFile');
    expect(submission).toContain('getSystemMonthlyReportSubmissionError');
    expect(submission).not.toContain(
      '<p className="mt-1 leading-6">请重新提交。</p>',
    );
  });
});
