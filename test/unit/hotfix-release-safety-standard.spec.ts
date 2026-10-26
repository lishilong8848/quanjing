import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();

function source(path: string): string {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('hotfix release safety standard', () => {
  const standardPath = 'docs/engineering/hotfix-release-safety-standard.md';

  it('makes the release safety standard mandatory for every hotfix task', () => {
    const projectRules = source('AGENTS.md');

    expect(projectRules).toContain(standardPath);
    expect(projectRules).toContain('跨模块零散覆盖');
    expect(projectRules).toContain('生产等价冷启动');
  });

  it('records the P0 partial-overlay outage as durable project memory', () => {
    const memory = source('MEMORY.md');

    expect(memory).toContain('P0-2026-08-22-hotfix-partial-overlay-outage');
    expect(memory).toContain('新旧编译产物混用');
    expect(memory).toContain('不得给出“可部署”或“高置信度”结论');
  });

  it('keeps the non-negotiable release gates reviewable', () => {
    const standard = source(standardPath);

    for (const requiredRule of [
      '基础版本指纹',
      '跨模块零散覆盖',
      '干净目录',
      '完整依赖闭包',
      'Nest 依赖注入',
      '生产等价冷启动',
      '健康检查',
      '原子切换',
      '自动回滚',
      '禁止交付',
    ]) {
      expect(standard).toContain(requiredRule);
    }
  });

  it('keeps ordinary business hotfixes on the bounded fast path', () => {
    const standard = source(standardPath);

    for (const requiredRule of [
      '5–15 分钟',
      '20 分钟为强制停线点',
      '不重复执行全部 17 项故障矩阵',
      '时序、锁竞争、进程退出和回滚测试禁止与构建并发执行',
      '冻结代码后执行一次生产构建并只生成一个正式候选包',
      '同一事实只证明一次',
      '正式打包不得承担诊断职责',
      '必须作为独立发布框架任务处理',
    ]) {
      expect(standard).toContain(requiredRule);
    }
  });

  it('records the bounded one-candidate workflow as durable project memory', () => {
    const memory = source('MEMORY.md');

    expect(memory).toContain('热包测试与打包效率长期约定');
    expect(memory).toContain('目标 5–15 分钟，20 分钟强制停线');
    expect(memory).toContain('正式打包不是发现问题的诊断工具');
    expect(memory).toContain('同一事实只验证一次');
    expect(memory).toContain('禁止无界“测试—打包—再发现问题”循环');
  });

  it('codifies isolated smoke-test gates after the dependency-link incident', () => {
    const standard = source(standardPath);
    const memory = source('MEMORY.md');

    for (const requiredRule of [
      'node_modules 必须是隔离实体目录',
      '依赖戳不匹配时禁止启动',
      '安装与回滚演练必须串行',
      '父命令超时不等于子进程结束',
      'verify-hotfix-smoke-preflight.mjs',
    ]) {
      expect(standard).toContain(requiredRule);
      expect(memory).toContain(requiredRule);
    }
  });

  it('codifies the one-step takeover lessons from the cross-generation incident', () => {
    const standard = source(standardPath);
    const memory = source('MEMORY.md');

    for (const requiredRule of [
      '先快照服务器当前受管根文件，再创建新事务',
      '终态旧事务清理后必须重建受管根快照',
      '正式 ZIP 内嵌安装器',
      '服务器不得承担候选试错',
      '测试夹具不得硬编码历史候选包名',
    ]) {
      expect(standard).toContain(requiredRule);
      expect(memory).toContain(requiredRule);
    }
  });
});
