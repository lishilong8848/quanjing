import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('DingTalk attendance CLI', () => {
  it('ships a standalone help command without requiring credentials', () => {
    const cliPath = join(
      process.cwd(),
      'scripts',
      'dingtalk-attendance-cli.mjs',
    );
    const result = spawnSync(process.execPath, [cliPath, '--help'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('DingTalk attendance CLI');
    expect(result.stdout).toContain('--self-test');
    expect(result.stdout).toContain('consumes no attendance quota');
    expect(result.stdout).toContain('--mode result|detail');
    expect(result.stdout).not.toMatch(/client[_-]?secret\s*=/i);
  });

  it('guards the optional result pagination against empty and repeated pages', () => {
    const source = readFileSync(
      join(process.cwd(), 'scripts', 'dingtalk-attendance-cli.mjs'),
      'utf8',
    );

    expect(source).toContain('MAX_RESULT_PAGES_PER_BATCH');
    expect(source).toContain('returned an empty page with hasMore=true');
    expect(source).toContain('repeated a page; further requests were stopped');
  });
});
