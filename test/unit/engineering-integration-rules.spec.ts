import * as fs from 'node:fs';
import * as path from 'node:path';

describe('form, Bitable and Feishu integration engineering rules', () => {
  const root = path.resolve(__dirname, '../..');
  const projectRules = fs.readFileSync(
    path.join(root, 'AGENTS.md'),
    'utf8',
  );
  const standardPath = path.join(
    root,
    'docs/engineering/form-bitable-feishu-integration-standard.md',
  );

  it('makes the integration standard mandatory for project development', () => {
    expect(projectRules).toContain(
      'docs/engineering/form-bitable-feishu-integration-standard.md',
    );
  });

  it('keeps the recurring regression gates in one reviewable standard', () => {
    const standard = fs.readFileSync(standardPath, 'utf8');

    for (const requiredRule of [
      '本地优先',
      'clientMutationId',
      'Open ID',
      '语义回读校验',
      'history.replaceState',
      'window.close()',
      'history.back()',
      '永久转圈',
      '真实浏览器',
      '测试数据清理',
    ]) {
      expect(standard).toContain(requiredRule);
    }
  });
});
