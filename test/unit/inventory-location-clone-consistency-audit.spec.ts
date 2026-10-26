import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = resolve(
  process.cwd(),
  '.runtime/inventory-location-clone-consistency-audit.mjs',
);

describe('inventory location clone consistency audit', () => {
  it('is read-only and covers the complete clone verification contract', () => {
    const source = readFileSync(scriptPath, 'utf8');

    expect(source).toContain("'+base-block-list'");
    expect(source).toContain("'+table-list'");
    expect(source).toContain("'+table-get'");
    expect(source).toContain("'+record-list'");
    expect(source).toContain("'+workflow-list'");
    expect(source).toContain('EXPECTED_WORKFLOW_COUNT = 35');
    expect(source).toContain('primarySemanticHash');
    expect(source).toContain('sourceIdReferences');
    expect(source).toContain('cloneEnabledCount');
    expect(source).toContain('redactSecrets');
    expect(source).toContain("error.type === 'network'");
    expect(source).toContain("error.subtype === 'transport'");

    expect(source).not.toMatch(/\bwriteFile(?:Sync)?\b/u);
    expect(source).not.toMatch(/\brename(?:Sync)?\b/u);
    expect(source).not.toMatch(/\bunlink(?:Sync)?\b/u);
    expect(source).not.toMatch(/\+base-copy|\+field-(?:create|update|delete)|\+record-(?:create|update|delete|batch-update)|\+workflow-(?:enable|disable|update)/u);
  });
});
